'use strict'

/**
 * gh-proxy —— GitHub 文件加速（纯下载版 / 多平台通用）
 *
 * 唯一能力：加速下载 GitHub 上的文件。
 *
 *   https://<你的域名>/https://github.com/owner/repo/releases/download/v1.0/file.zip
 *   https://<你的域名>/https://github.com/owner/repo/archive/refs/heads/main.zip
 *   https://<你的域名>/https://github.com/owner/repo/blob/main/README.md
 *   https://<你的域名>/https://raw.githubusercontent.com/owner/repo/main/file.txt
 *   https://<你的域名>/https://gist.githubusercontent.com/user/id/raw/file.txt
 *
 * 已适配三个平台，见文件末尾「平台入口」段落：
 *   - Cloudflare Workers          addEventListener / ESM export default 都支持
 *   - 腾讯云 EdgeOne Edge Functions export default onRequest(context)
 *   - 阿里云 ESA 边缘函数           export default { async fetch(request) }
 *
 * 思路来自 hunshcn/gh-proxy（MIT，Copyright (c) 2020 hunshcn），逻辑重写。
 */

/* ================================ 配置 ================================ */

const CONFIG = {
  /** 路由前缀。Worker 挂在 example.com/gh/* 下时改成 '/gh/' */
  PREFIX: '/',

  /** 下载时是否剥离 Cookie / Authorization，避免把用户凭证带给上游 */
  STRIP_CREDENTIALS: true,

  /** 内部跟随重定向的最大跳数。
   *  阿里云 ESA 单次执行只有 4 次 fetch，留余量 → 建议设为 2 */
  MAX_HOPS: 3,

  /** 上游请求失败时的重试次数（不含首次）。
   *  Cloudflare / EdgeOne 可设 1~2；阿里云 ESA 必须设 0，否则会和跳转抢子请求额度 */
  RETRIES: 1,

  /** blob / raw 是否改走 jsDelivr（0 = 关闭，直连 GitHub） */
  JSDELIVR: 0,

  /** 首页静态资源主机；留空使用内置页面 */
  ASSET_ROOT: '',

  /** 是否在错误页展示诊断信息（生产建议 false） */
  SHOW_DIAGNOSTICS: false,
}

/* 可识别的 GitHub 下载链接形态。
 * 统一用 [^/]+ 而非 .+?，避免跨路径段回溯。 */
const RELEASE_PATTERNS = [
  { kind: 'release', re: /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/(?:releases|archive)\/.*$/i },
  { kind: 'git', re: /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/(?:info|git-).*$/i },
  { kind: 'tags', re: /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/tags.*$/i },
  { kind: 'suites', re: /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/suites\/.*$/i },
  { kind: 'blob', re: /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/(?:blob|raw)\/.*$/i },
  { kind: 'gist', re: /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/[^/]+\/[^/]+\/.*$/i },
  { kind: 'rawhost', re: /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/[^/]+\/[^/]+\/[^/]+\/.*$/i },
]

/** 允许回源的上游主机（防止变成开放代理） */
const UPSTREAM_HOSTS = [
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'gist.github.com',
  'media.githubusercontent.com',
  'git-lfs.github.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'github.githubassets.com',
  'cdn.jsdelivr.net',
]

const ALLOWED_HOSTS = new Set(UPSTREAM_HOSTS)

/** 逐跳头 + 边缘注入头，不能透传给上游 */
const DROP_HEADERS = [
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker',
  'cf-ew-via', 'cdn-loop', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
  'accept-encoding', // 让上游返回明文，避免压缩流与响应头不一致
]

/** @type {ResponseInit} */
const PREFLIGHT_INIT = {
  status: 204,
  headers: new Headers({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-max-age': '1728000',
  }),
}

/* ================================ 入口 ================================ */

/**
 * 平台无关的核心处理函数。三个平台的适配层都只调用它。
 * @param {Request} req
 * @returns {Promise<Response>}
 */
async function handle(req) {
  try {
    const url = new URL(req.url)
    const pathname = url.pathname

    // 表单 ?q= → 301 到路径式，兼容老链接。
    // 必须放在静态资源判断之前：`/?q=...` 的 pathname 仍是 '/'，否则会被首页吃掉。
    const q = url.searchParams.get('q')
    if (q) {
      return Response.redirect(new URL('/' + stripScheme(q.trim()), url.origin).href, 301)
    }

    // 首页与静态资源
    if (pathname === '/' || pathname === '/index.html' ||
        pathname === '/favicon.png' || pathname === '/favicon.ico' ||
        pathname === '/robots.txt') {
      return serveAsset(req, pathname === '/' ? '/index.html' : pathname)
    }

    // CORS 预检
    if (req.method === 'OPTIONS' && req.headers.has('access-control-request-headers')) {
      return new Response(null, PREFLIGHT_INIT)
    }

    // 取出前缀后面的原始地址
    let raw = pathname + url.search
    if (CONFIG.PREFIX !== '/') {
      if (!raw.startsWith(CONFIG.PREFIX)) return notFound()
      raw = raw.slice(CONFIG.PREFIX.length)
    } else {
      raw = raw.slice(1)
    }
    // 边缘节点会把路径里的 // 合并成 /，这里补回来
    raw = raw.replace(/^https?:\/{1,2}/i, 'https://')

    const kind = matchKind(raw)
    if (!kind) return notFound(explainUnsupported(raw))

    let target = raw
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target

    if (kind === 'blob') {
      if (CONFIG.JSDELIVR) return Response.redirect(jsdelivrBlobUrl(target), 302)
      target = target.replace('/blob/', '/raw/')
    }
    if (kind === 'rawhost' && CONFIG.JSDELIVR) {
      return Response.redirect(jsdelivrRawUrl(target), 302)
    }

    const targetUrl = safeUrl(target)
    if (!targetUrl) return makeRes('Bad Request: 无法解析目标地址', 400)

    return proxy(req, targetUrl, 0)
  } catch (err) {
    // 只记日志，不把堆栈回显给客户端
    console.error('gh-proxy error:', (err && err.stack) || err)
    return makeRes('Bad Gateway', 502)
  }
}

/**
 * 判定路径属于哪种 GitHub 资源
 * @param {string} raw
 * @returns {string|null}
 */
function matchKind(raw) {
  for (const item of RELEASE_PATTERNS) {
    if (item.re.test(raw)) return item.kind
  }
  return null
}

/**
 * 对「是 GitHub 链接但不支持」的情况给出更具体的原因，
 * 与前端 index.html 的校验文案保持一致。
 * @param {string} raw
 * @returns {string}
 */
function explainUnsupported(raw) {
  const v = stripScheme(raw).replace(/^\/+/, '')

  // 非 GitHub 域名
  if (!/^(?:github\.com|gist\.(?:githubusercontent|github)\.com|raw\.(?:githubusercontent|github)\.com)\//i.test(v)) {
    return '只支持 github.com、raw.githubusercontent.com、gist.githubusercontent.com 的链接。'
  }
  if (/^github\.com\/[^/]+\/[^/]+\/?$/.test(v)) {
    return '这是仓库首页，不是文件。请打开具体文件，或改用 archive 链接下载整个项目。'
  }
  if (/^github\.com\/[^/]+\/?$/.test(v)) {
    return '这是用户主页，请提供具体的文件链接。'
  }
  if (/\/tree\//i.test(v)) {
    return '不支持文件夹浏览。请用 archive 链接下载整个项目，或点击具体文件。'
  }
  if (/(?:issues|pull|discussions)\//i.test(v)) {
    return 'issues / PR / discussions 不是文件，无法下载。'
  }
  return '无法识别的 GitHub 链接，需要包含 releases、archive、blob、raw 或 gist。'
}

/* ============================== 代理核心 ============================== */

/**
 * @param {Request} req
 * @param {URL} targetUrl
 * @param {number} hops
 * @returns {Promise<Response>}
 */
async function proxy(req, targetUrl, hops) {
  if (hops > CONFIG.MAX_HOPS) return makeRes('Too Many Redirects', 508)
  if (!isAllowed(targetUrl)) return notFound('目标域名不在允许列表内')

  const headers = new Headers(req.headers)
  for (const name of DROP_HEADERS) headers.delete(name)

  if (CONFIG.STRIP_CREDENTIALS) {
    headers.delete('cookie')
    headers.delete('authorization')
  }
  headers.set('referer', targetUrl.href)

  /** @type {RequestInit} */
  const init = {
    method: req.method,
    headers,
    redirect: 'manual',
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  if (hasBody && req.body) init.body = req.body

  let res
  try {
    res = await fetchWithRetry(targetUrl.href, init, hasBody)
  } catch (err) {
    // 记下真实错误，便于诊断（以前这里 catch{} 吞掉了，完全查不出原因）
    const reason = describeFetchError(err)

    console.error('[gh-proxy] upstream failed:', targetUrl.href, '-', reason)
    return errorPage({
      title: '无法连接到 GitHub',
      message: `请求上游时网络出错：${reason}`,
      hint: '该域名在当前网络环境可能不可达。raw.githubusercontent.com 在部分网络下会被阻断，可换用 release 或 archive 链接。',
      detail: CONFIG.SHOW_DIAGNOSTICS ? `${targetUrl.hostname} · ${reason}` : '',
      status: 502,
    })
  }

  /* ---- 重定向：内部跟随，浏览器只看到最终字节 ---- */
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    const next = location ? safeUrl(location, targetUrl) : null

    if (next && !hasBody && isAllowed(next) && hops < CONFIG.MAX_HOPS) {
      return proxy(req, next, hops + 1)
    }

    // 无法跟随（跳出白名单 / 带 body / 超跳数）→ 把 3xx 原样交还
    const redirectHeaders = new Headers(res.headers)
    redirectHeaders.set('access-control-allow-origin', '*')
    return new Response(null, { status: res.status, headers: redirectHeaders })
  }

  /* ---- 正常响应 ---- */
  return toClientResponse(req, res)
}

/**
 * 把上游响应转成回给客户端的响应。
 *
 * @param {Request} req
 * @param {Response} res
 * @returns {Response}
 */
function toClientResponse(req, res) {
  const outHeaders = new Headers(res.headers)
  outHeaders.delete('content-security-policy')
  outHeaders.delete('content-security-policy-report-only')
  outHeaders.delete('clear-site-data')
  outHeaders.delete('x-frame-options')
  // fetch() 拿到的 body 已被运行时解压，但上游头仍带 gzip 声明与压缩后长度。
  // 原样透传会让浏览器按压缩流解析明文 → 乱码 / Parse Error，必须剥掉。
  outHeaders.delete('content-encoding')
  outHeaders.delete('content-length')
  outHeaders.set('access-control-allow-origin', '*')
  outHeaders.set('access-control-expose-headers', '*')

  // Set-Cookie 剥掉 Domain，否则浏览器会拒绝写入
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  if (cookies.length) {
    outHeaders.delete('set-cookie')
    for (const c of cookies) {
      outHeaders.append('set-cookie', c.replace(/;\s*domain=[^;]*/gi, ''))
    }
  }

  // 流式透传：不 await 整个 body，避免大文件撑爆内存 / 触发网关首字节超时
  const body = (res.status === 204 || res.status === 304 || req.method === 'HEAD') ? null : res.body

  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
  })
}

/**
 * 带重试的上游请求。
 * 只对「无 body 的幂等请求」重试，且重试次数可配为 0（阿里云 ESA 只有 4 次
 * 子请求预算，应将其设为 0 以免吃掉跳转额度）。
 *
 * @param {string} href
 * @param {RequestInit} init
 * @param {boolean} hasBody
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(href, init, hasBody) {
  const retries = hasBody ? 0 : Math.max(0, CONFIG.RETRIES | 0)
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(href, init)
    } catch (err) {
      lastErr = err
      // 最后一次不再等待
      if (attempt < retries) await sleep(150 * (attempt + 1))
    }
  }
  throw lastErr
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/* ============================== 错误诊断 ============================== */

/**
 * 把 fetch 拋出的错误翻译成人能看懂的一句话。
 * @param {any} err
 * @returns {string}
 */
function describeFetchError(err) {
  if (!err) return '未知错误'
  const cause = err.cause || err
  const code = cause && (cause.code || cause.errno)
  const msg = (cause && cause.message) || err.message || String(err)

  const map = {
    ECONNRESET: '连接被重置（该域名在当前网络被阻断）',
    ENOTFOUND: '域名解析失败',
    ETIMEDOUT: '连接超时',
    ECONNREFUSED: '连接被拒绝',
    EHOSTUNREACH: '主机不可达',
    ENETUNREACH: '网络不可达',
    CERT_HAS_EXPIRED: '上游证书过期',
    UND_ERR_CONNECT_TIMEOUT: '连接超时',
    UND_ERR_SOCKET: '连接被上游关闭',
  }

  if (code && map[code]) return map[code]
  if (/timeout/i.test(msg)) return '连接超时'
  if (/certificate/i.test(msg)) return '上游证书校验失败'
  if (/fetch failed/i.test(msg)) return '网络连接失败'

  // 未知错误：只回显「像网络错误码」的内容（全大写短 token），
  // 其余一律归为泛化描述，避免把内部细节透给客户端。
  if (/^[A-Z][A-Z0-9_]{2,40}$/.test(msg)) return msg
  return '网络请求异常'
}

/* ================================ 工具 ================================ */

/** @param {string} s */
function stripScheme(s) {
  return s.replace(/^https?:\/\//i, '')
}

/**
 * @param {string} str
 * @param {URL|string} [base]
 * @returns {URL|null}
 */
function safeUrl(str, base) {
  try {
    return base ? new URL(str, base) : new URL(str)
  } catch {
    return null
  }
}

/** @param {URL} u */
function isAllowed(u) {
  return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname.toLowerCase())
}

/** @param {string} url */
function jsdelivrBlobUrl(url) {
  return url
    .replace('/blob/', '@')
    .replace(/^(?:https?:\/\/)?github\.com/i, 'https://cdn.jsdelivr.net/gh')
}

/** @param {string} url */
function jsdelivrRawUrl(url) {
  // 用捕获组替代后行断言，兼容只认 ES6 的运行时
  return url.replace(
    /^(https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/i,
    'https://cdn.jsdelivr.net/gh/$2/$3@$4/$5'
  )
}

/**
 * @param {any} body
 * @param {number} [status]
 * @param {Record<string,string>} [headers]
 */
function makeRes(body, status = 200, headers = {}) {
  headers['access-control-allow-origin'] = '*'
  return new Response(body, { status, headers })
}

/** @param {string} [reason] */
function notFound(reason) {
  return errorPage({
    title: '不支持的链接',
    message: reason || '这个地址不是可识别的 GitHub 文件链接。',
    hint: '请粘贴完整的 GitHub 文件地址，例如 release 附件、源码包、或 raw 文件。',
    status: 404,
    showExamples: true,
  })
}

/**
 * 首页 / 静态资源
 * @param {Request} req
 * @param {string} path
 */
async function serveAsset(req, path) {
  if (CONFIG.ASSET_ROOT) {
    try {
      const res = await fetch(CONFIG.ASSET_ROOT.replace(/\/+$/, '') + path, {
        headers: { 'user-agent': req.headers.get('user-agent') || '' },
      })
      if (res.ok) {
        const headers = new Headers(res.headers)
        headers.set('cache-control', 'public, max-age=300')
        headers.set('access-control-allow-origin', '*')
        return new Response(res.body, { status: 200, headers })
      }
    } catch {
      // 落到内置页面
    }
  }
  if (path === '/index.html') {
    return new Response(LANDING_HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    })
  }
  return notFound()
}

/* ============================ 错误提示页 ============================ */

/**
 * 统一的错误提示页（HTML，风格与首页一致）
 * @param {{title:string, message:string, hint?:string, detail?:string, status:number, showExamples?:boolean}} o
 * @returns {Response}
 */
function errorPage(o) {
  const esc = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  const examples = [
    ['release 附件', 'https://github.com/owner/repo/releases/download/v1.0/file.zip'],
    ['源码包', 'https://github.com/owner/repo/archive/refs/heads/main.zip'],
    ['单文件', 'https://github.com/owner/repo/blob/main/README.md'],
    ['raw 文件', 'https://raw.githubusercontent.com/owner/repo/main/file.txt'],
  ]

  const exampleHtml = o.showExamples
    ? `<div class="examples">${examples.map(([label, url]) =>
        `<div class="ex"><span class="ex-label">${esc(label)}</span><code>${esc(url)}</code></div>`
      ).join('')}</div>`
    : ''

  const detailHtml = o.detail
    ? `<p class="detail">${esc(o.detail)}</p>`
    : ''

  const html = `<!DOCTYPE html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(o.title)} · GitHub 文件加速</title>
<style>
  :root{--bg:#fff;--fg:#27272a;--muted:#71717a;--accent:#00bfb3;--card:#fff;--line:#e4e4e7;--code:#f4f4f5;--danger:#e5484d}
  [data-theme=dark]{--bg:#18181b;--fg:#f4f4f5;--muted:#a1a1aa;--accent:#00d9cc;--card:#27272a;--line:#3f3f46;--code:#3f3f46;--danger:#ff6369}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;
       background:var(--bg);color:var(--fg);line-height:1.6}
  .box{width:100%;max-width:620px}
  .badge{display:inline-flex;align-items:center;gap:.4rem;font-size:.8rem;font-weight:600;
         color:var(--danger);background:color-mix(in srgb,var(--danger) 12%,transparent);
         padding:.3rem .7rem;border-radius:999px;margin-bottom:1rem}
  h1{font-size:clamp(1.3rem,4.5vw,1.7rem);margin:0 0 .6rem;letter-spacing:-.01em}
  .msg{margin:0 0 .8rem;color:var(--fg);font-size:clamp(.95rem,3.5vw,1.05rem)}
  .hint{margin:0 0 1.4rem;color:var(--muted);font-size:.9rem}
  .detail{margin:0 0 1.4rem;padding:.6rem .8rem;background:var(--code);border-radius:8px;
          font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;color:var(--muted);word-break:break-all}
  .examples{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--card)}
  .ex{display:flex;gap:.8rem;padding:.7rem .9rem;border-bottom:1px solid var(--line);align-items:baseline}
  .ex:last-child{border-bottom:0}
  .ex-label{flex:0 0 5.5em;font-size:.8rem;color:var(--muted)}
  .ex code{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.78rem;
           color:var(--fg);word-break:break-all}
  .actions{margin-top:1.5rem;display:flex;gap:.8rem;flex-wrap:wrap}
  .btn{display:inline-block;padding:.65rem 1.3rem;border-radius:9px;text-decoration:none;font-size:.9rem;
       font-weight:500;transition:filter .15s}
  .btn:hover{filter:brightness(.92)}
  .btn-primary{background:var(--accent);color:#fff}
  .btn-ghost{border:1px solid var(--line);color:var(--fg)}
  footer{margin-top:2rem;font-size:.78rem;color:var(--muted)}
  footer a{color:var(--accent);text-decoration:none}
</style>
</head>
<body>
<div class="box">
  <div class="badge">HTTP ${esc(o.status)}</div>
  <h1>${esc(o.title)}</h1>
  <p class="msg">${esc(o.message)}</p>
  ${o.hint ? `<p class="hint">${esc(o.hint)}</p>` : ''}
  ${detailHtml}
  ${exampleHtml}
  <div class="actions">
    <a class="btn btn-primary" href="/">返回首页</a>
    <a class="btn btn-ghost" href="https://github.com" rel="noopener noreferrer" target="_blank">去 GitHub</a>
  </div>
  <footer>GitHub 文件加速 · 支持 release / archive / blob / raw / gist</footer>
</div>
<script>
  try{var t=localStorage.getItem('theme');
    if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))
      document.documentElement.setAttribute('data-theme','dark');
  }catch(e){}
</script>
</body>
</html>`

  return new Response(html, {
    status: o.status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/* ==== BEGIN GENERATED: index.html（由 build.mjs 生成，勿手改） ==== */
const LANDING_HTML = `<!DOCTYPE html>
<html lang="zh-Hans">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <meta name="description" content="GitHub 文件加速：加速下载 release 附件、源码包与 raw 单文件。">
    <link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,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">
    <title>GitHub 文件加速</title>
    <script>
        (function () {
            function apply(theme) {
                document.documentElement.setAttribute('data-theme', theme);
                var icon = document.getElementById('theme-icon');
                if (icon) {
                    var moon = icon.querySelector('.icon-moon');
                    var sun = icon.querySelector('.icon-sun');
                    if (moon) moon.style.display = theme === 'dark' ? 'none' : '';
                    if (sun) sun.style.display = theme === 'dark' ? '' : 'none';
                }
            }
            window.detectColorScheme = function () {
                var saved = null;
                try { saved = localStorage.getItem('theme'); } catch (e) {}
                var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                apply(saved === 'dark' || (!saved && dark) ? 'dark' : 'light');
            };
            window.toggleTheme = function () {
                var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                apply(next);
                try { localStorage.setItem('theme', next); } catch (e) {}
            };
            document.addEventListener('DOMContentLoaded', window.detectColorScheme);
        })();
    </script>
    <style>
        :root {
            --bg: #ffffff; --bg-soft: #fafafa; --fg: #27272a; --fg-mute: #71717a;
            --accent: #00bfb3; --accent-hover: #00a89c; --card: #ffffff;
            --line: #e4e4e7; --code-bg: #f4f4f5; --danger: #e5484d; --ok: #30a46c;
            --shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px -8px rgba(0,0,0,.08);
        }
        [data-theme="dark"] {
            --bg: #18181b; --bg-soft: #1f1f23; --fg: #f4f4f5; --fg-mute: #a1a1aa;
            --accent: #00d9cc; --accent-hover: #22e6da; --card: #27272a;
            --line: #3f3f46; --code-bg: #3f3f46; --danger: #ff6369; --ok: #3dd68c;
            --shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px -8px rgba(0,0,0,.5);
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; min-height: 100%; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                         "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
            background: var(--bg); color: var(--fg); line-height: 1.6;
            display: flex; flex-direction: column; align-items: center;
            padding: clamp(1rem, 4vw, 3rem) 1rem;
            transition: background-color .25s ease, color .25s ease;
            -webkit-font-smoothing: antialiased;
        }
        .container { width: 100%; max-width: 720px; }
        header { position: relative; text-align: center; margin-bottom: clamp(1.5rem, 5vw, 2.5rem); }
        .logo {
            display: inline-flex; align-items: center; justify-content: center;
            width: 52px; height: 52px; border-radius: 14px;
            background: #181717;
            margin-bottom: 1rem;
            box-shadow: 0 6px 18px -8px rgba(0, 0, 0, .35);
        }
        .logo svg { width: 28px; height: 28px; fill: #fff; }
        h1 { font-size: clamp(1.4rem, 5vw, 1.9rem); font-weight: 650; letter-spacing: -.02em; margin: 0 0 .4rem; }
        .subtitle { margin: 0; color: var(--fg-mute); font-size: clamp(.88rem, 3.4vw, .98rem); }
        .theme-toggle {
            position: absolute; top: 0; right: 0; width: 38px; height: 38px;
            display: grid; place-items: center;
            background: var(--card); border: 1px solid var(--line); border-radius: 10px;
            color: var(--fg-mute); cursor: pointer;
            transition: border-color .15s, color .15s, transform .15s;
        }
        .theme-toggle:hover { border-color: var(--accent); color: var(--accent); }
        .theme-toggle:active { transform: scale(.94); }
        .card {
            background: var(--card); border: 1px solid var(--line); border-radius: 16px;
            padding: clamp(1.1rem, 4vw, 1.6rem); box-shadow: var(--shadow); margin-bottom: 1rem;
        }
        .field-label { display: block; font-size: .82rem; font-weight: 600; color: var(--fg-mute); margin-bottom: .55rem; }
        .input-row { display: flex; gap: .6rem; }
        @media (max-width: 560px) { .input-row { flex-direction: column; } }
        .url-input {
            flex: 1; min-width: 0; padding: .85rem 1rem; font-size: .95rem;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            color: var(--fg); background: var(--bg-soft);
            border: 1.5px solid var(--line); border-radius: 10px;
            transition: border-color .15s, box-shadow .15s;
        }
        .url-input::placeholder { color: var(--fg-mute); opacity: .7; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .url-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0,191,179,.18); }
        .url-input.is-invalid { border-color: var(--danger); box-shadow: 0 0 0 3px rgba(229,72,77,.15); }
        .submit-btn {
            padding: .85rem 1.5rem; font-size: .95rem; font-weight: 600; color: #fff;
            background: var(--accent); border: none; border-radius: 10px;
            cursor: pointer; white-space: nowrap;
            transition: background-color .15s, transform .1s;
        }
        .submit-btn:hover { background: var(--accent-hover); }
        .submit-btn:active { transform: scale(.98); }
        .feedback { display: none; align-items: flex-start; gap: .5rem; margin-top: .7rem; font-size: .84rem; line-height: 1.5; }
        .feedback.show { display: flex; }
        .feedback .icon { flex: 0 0 auto; }
        .feedback.error { color: var(--danger); }
        .feedback.ok { color: var(--ok); }
        .presets { display: flex; flex-wrap: wrap; gap: .45rem; margin-top: .9rem; }
        .preset {
            font-size: .78rem; padding: .32rem .7rem; color: var(--fg-mute);
            background: var(--bg-soft); border: 1px solid var(--line); border-radius: 999px;
            cursor: pointer; font-family: inherit;
            transition: color .15s, border-color .15s, background-color .15s;
        }
        .preset:hover { color: var(--accent); border-color: var(--accent); background: rgba(0,191,179,.08); }
        .info-grid { display: grid; gap: 1rem; margin-top: 1.6rem; }
        @media (min-width: 640px) { .info-grid { grid-template-columns: 1fr 1fr; } }
        .info-box { background: var(--bg-soft); border: 1px solid var(--line); border-radius: 12px; padding: 1rem 1.1rem; }
        .info-box h3 { margin: 0 0 .6rem; font-size: .9rem; font-weight: 650; display: flex; align-items: center; gap: .4rem; }
        .info-box h3::before { content: ''; width: 3px; height: 14px; background: var(--accent); border-radius: 2px; }
        .info-box ul { margin: 0; padding: 0; list-style: none; }
        .info-box li { font-size: .82rem; color: var(--fg-mute); padding: .28rem 0; display: flex; gap: .5rem; align-items: baseline; }
        .info-box li::before { content: '·'; color: var(--accent); font-weight: 700; }
        code {
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: .92em; padding: .1rem .35rem; background: var(--code-bg);
            border-radius: 4px; color: var(--fg); word-break: break-all;
        }
        footer { margin-top: auto; padding-top: 2.5rem; text-align: center; font-size: .78rem; color: var(--fg-mute); }
        footer a { color: var(--fg-mute); text-decoration: none; }
        footer a:hover { color: var(--accent); }
        @media (prefers-reduced-motion: no-preference) {
            .container > * { animation: rise .5s cubic-bezier(.16,1,.3,1) backwards; }
            .container > :nth-child(2) { animation-delay: .06s; }
            .container > :nth-child(3) { animation-delay: .12s; }
            @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <button class="theme-toggle" onclick="toggleTheme()" aria-label="切换深色 / 浅色主题">
                <svg id="theme-icon" width="17" height="17" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path class="icon-moon" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                    <g class="icon-sun" style="display:none">
                        <circle cx="12" cy="12" r="4"/>
                        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
                    </g>
                </svg>
            </button>
            <div class="logo" aria-hidden="true">
                <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
                </svg>
            </div>
            <h1>GitHub 文件加速</h1>
            <p class="subtitle">粘贴链接，秒开下载 · release / 源码包 / 单文件</p>
        </header>

        <main>
            <section class="card">
                <label class="field-label" for="dl-input">GitHub 文件地址</label>
                <form onsubmit="return submitDownload(event)">
                    <div class="input-row">
                        <input id="dl-input" class="url-input" type="text"
                               placeholder="https://github.com/owner/repo/releases/download/v1.0/file.zip"
                               autocomplete="off" spellcheck="false" autocapitalize="off">
                        <button type="submit" class="submit-btn">加速下载</button>
                    </div>
                    <div id="feedback" class="feedback"></div>
                </form>
                <div class="presets">
                    <button type="button" class="preset" data-url="https://github.com/cli/cli/releases/download/v2.40.0/gh_2.40.0_linux_amd64.tar.gz">release 示例</button>
                    <button type="button" class="preset" data-url="https://github.com/octocat/Hello-World/archive/refs/heads/master.zip">源码包示例</button>
                    <button type="button" class="preset" data-url="https://github.com/octocat/Hello-World/blob/master/README">单文件示例</button>
                    <button type="button" class="preset" data-url="https://raw.githubusercontent.com/octocat/Hello-World/master/README">raw 示例</button>
                </div>
            </section>

            <div class="info-grid">
                <div class="info-box">
                    <h3>支持的地址</h3>
                    <ul>
                        <li><code>releases/download</code> release 附件</li>
                        <li><code>archive</code> 源码包（zip / tar.gz）</li>
                        <li><code>blob</code> / <code>raw</code> 单文件</li>
                        <li><code>gist</code> 代码片段</li>
                        <li><code>git clone</code> 加速</li>
                    </ul>
                </div>
                <div class="info-box">
                    <h3>使用提示</h3>
                    <ul>
                        <li>链接带不带 <code>https://</code> 都行</li>
                        <li>右键「复制链接地址」最准确</li>
                        <li>不支持整个文件夹，请用 archive</li>
                        <li>大文件走流式转发，不占内存</li>
                    </ul>
                </div>
            </div>
        </main>

        <footer>
            基于 Cloudflare / EdgeOne / ESA ·
            <a href="https://github.com/liyixin21/gh-proxy" rel="noopener noreferrer" target="_blank">liyixin21/gh-proxy</a>
        </footer>
    </div>

    <script>
        var PATTERNS = [
            { re: /^(?:https?:\\/\\/)?github\\.com\\/[^/]+\\/[^/]+\\/(?:releases|archive)\\/.*$/i, label: 'release / 源码包' },
            { re: /^(?:https?:\\/\\/)?github\\.com\\/[^/]+\\/[^/]+\\/(?:info|git-)/i,             label: 'git 协议' },
            { re: /^(?:https?:\\/\\/)?github\\.com\\/[^/]+\\/[^/]+\\/tags/i,                      label: 'tags' },
            { re: /^(?:https?:\\/\\/)?github\\.com\\/[^/]+\\/[^/]+\\/suites\\//i,                   label: 'artifacts' },
            { re: /^(?:https?:\\/\\/)?github\\.com\\/[^/]+\\/[^/]+\\/(?:blob|raw)\\//i,             label: '单文件' },
            { re: /^(?:https?:\\/\\/)?gist\\.(?:githubusercontent|github)\\.com\\/[^/]+\\/[^/]+\\//i, label: 'gist' },
            { re: /^(?:https?:\\/\\/)?raw\\.(?:githubusercontent|github)\\.com\\/[^/]+\\/[^/]+\\/[^/]+\\//i, label: 'raw 文件' }
        ];

        var input = document.getElementById('dl-input');
        var feedback = document.getElementById('feedback');

        function stripScheme(s) {
            return s.trim().replace(/^https?:\\/\\//i, '').replace(/^\\/+/, '');
        }

        function validate(value) {
            var v = value.trim();
            if (!v) return { ok: false, message: '请输入 GitHub 文件链接' };

            var normalized = stripScheme(v);

            if (!/^(?:github\\.com|gist\\.(?:githubusercontent|github)\\.com|raw\\.(?:githubusercontent|github)\\.com)\\//i.test(normalized)) {
                return { ok: false, message: '只支持 github.com、raw.githubusercontent.com、gist.githubusercontent.com 的链接' };
            }

            for (var i = 0; i < PATTERNS.length; i++) {
                if (PATTERNS[i].re.test(normalized)) {
                    return { ok: true, message: '已识别为「' + PATTERNS[i].label + '」' };
                }
            }

            if (/^github\\.com\\/[^/]+\\/[^/]+\\/?$/i.test(normalized)) {
                return { ok: false, message: '这是仓库首页，不是文件。请打开具体文件，或改用 archive 链接下载整个项目' };
            }
            if (/^github\\.com\\/[^/]+\\/?$/i.test(normalized)) {
                return { ok: false, message: '这是用户主页，请提供具体的文件链接' };
            }
            if (/\\/tree\\//i.test(normalized)) {
                return { ok: false, message: '不支持文件夹浏览，请用 archive 链接下载整个项目，或点击具体文件' };
            }
            if (/(?:issues|pull|discussions)\\//i.test(normalized)) {
                return { ok: false, message: 'issues / PR / discussions 不是文件，无法下载' };
            }

            return { ok: false, message: '无法识别的 GitHub 链接，需要包含 releases、archive、blob、raw 或 gist' };
        }

        function renderFeedback(result) {
            if (!result) {
                feedback.className = 'feedback';
                feedback.innerHTML = '';
                input.classList.remove('is-invalid');
                return;
            }
            feedback.className = 'feedback show ' + (result.ok ? 'ok' : 'error');
            feedback.innerHTML = '<span class="icon">' + (result.ok ? '✓' : '✕') +
                                 '</span><span>' + escapeHtml(result.message) + '</span>';
            input.classList.toggle('is-invalid', !result.ok);
        }

        function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        }

        var timer = null;
        input.addEventListener('input', function () {
            clearTimeout(timer);
            var v = input.value;
            timer = setTimeout(function () {
                if (!v.trim()) { renderFeedback(null); return; }
                renderFeedback(validate(v));
            }, 220);
        });

        Array.prototype.forEach.call(document.querySelectorAll('.preset'), function (btn) {
            btn.addEventListener('click', function () {
                input.value = btn.getAttribute('data-url');
                renderFeedback(validate(input.value));
                input.focus();
            });
        });

        function submitDownload(e) {
            e.preventDefault();
            var raw = input.value;
            var result = validate(raw);
            if (!result.ok) {
                renderFeedback(result);
                input.focus();
                return false;
            }
            renderFeedback(result);
            window.location.href = location.origin + '/' + stripScheme(raw);
            return false;
        }

        window.addEventListener('DOMContentLoaded', function () {
            if (window.innerWidth > 640) input.focus();
        });
    </script>
</body>
</html>
`
/* ==== END GENERATED ==== */

/* ============================ 平台入口 ============================ */

/**
 * 统一派发：兼容三种调用形态
 *   - Cloudflare 传统：dispatch(event.request)
 *   - EdgeOne：       dispatch(context)      context.request 是 Request
 *   - ESA：           dispatch(request)
 * @param {any} input
 */
function dispatch(input) {
  const req = (input && typeof input === 'object' && input.request instanceof Request)
    ? input.request
    : input
  return handle(req)
}

export { handle, dispatch }

/** ESM 默认导出：Cloudflare 现代形态 / ESA / EdgeOne 都能接 */
export default {
  /** @param {Request} request */
  async fetch(request) {
    return dispatch(request)
  },
}

/**
 * Cloudflare 传统 Service Worker 形态。
 * ESA 没有 addEventListener，这里做能力探测；EdgeOne 同理。
 */
if (typeof addEventListener === 'function') {
  try {
    addEventListener('fetch', event => {
      event.respondWith(dispatch(event.request))
    })
  } catch {
    // 运行时不支持该形态，忽略即可
  }
}
