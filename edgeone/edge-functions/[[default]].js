/**
 * GitHub 文件加速 —— EdgeOne 原生实现
 *
 * 与 Cloudflare 版的差异（全部是 EdgeOne 运行时约束驱动的）：
 *   1. 不用 new Headers()，全部用普通对象 —— EdgeOne V8 运行时的官方要求
 *   2. 不用 Response.json() —— 该运行时未实现
 *   3. 配置走 context.env（本文件内置默认值，可在控制台用环境变量覆盖）
 *   4. 入口签名 export default function onRequest(context)
 *   5. 不走 addEventListener，不依赖 Service Worker 形态
 *
 * 入口：edge-functions/[[default]].js（兜住 /https://github.com/... 这类带冒号的路径）
 */

/* ============================== 默认配置 ============================== */

const DEFAULTS = {
  /** 路由前缀；挂在 example.com/gh/* 下时改成 '/gh/' */
  PREFIX: '/',
  /** 是否剥离 Cookie / Authorization */
  STRIP_CREDENTIALS: '1',
  /** 内部跟随重定向的最大跳数（EdgeOne 有 64 次子请求预算，可以放宽） */
  MAX_HOPS: '5',
  /** 上游失败重试次数 */
  RETRIES: '1',
  /** blob / raw 是否改走 jsDelivr */
  JSDELIVR: '0',
}

/**
 * 从 context.env 读配置，缺失则用默认值。
 * EdgeOne 的环境变量在 context.env 上，不是 process.env。
 * @param {Record<string,string>|undefined} env
 */
function readConfig(env) {
  const e = env || {}
  const pick = (key) => (e[key] !== undefined && e[key] !== null && e[key] !== '')
    ? String(e[key])
    : DEFAULTS[key]

  return {
    PREFIX: pick('PREFIX'),
    STRIP_CREDENTIALS: pick('STRIP_CREDENTIALS') === '1',
    MAX_HOPS: Math.max(0, parseInt(pick('MAX_HOPS'), 10) || 0),
    RETRIES: Math.max(0, parseInt(pick('RETRIES'), 10) || 0),
    JSDELIVR: pick('JSDELIVR') === '1',
  }
}

/* ============================== 常量表 ============================== */

/** 可识别的 GitHub 下载链接形态 */
const PATTERNS = [
  { kind: 'release', re: /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/(?:releases|archive)\/.*$/i },
  { kind: 'git', re: /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/(?:info|git-).*$/i },
  { kind: 'tags', re: /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/tags.*$/i },
  { kind: 'suites', re: /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/suites\/.*$/i },
  { kind: 'blob', re: /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/(?:blob|raw)\/.*$/i },
  { kind: 'gist', re: /^(?:https?:\/\/)?gist\.(?:githubusercontent|github)\.com\/[^/]+\/[^/]+\/.*$/i },
  { kind: 'rawhost', re: /^(?:https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/[^/]+\/[^/]+\/[^/]+\/.*$/i },
]

/** 允许回源的上游主机 */
const ALLOWED_HOSTS = [
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

/** 逐跳头 + 边缘注入头 */
const DROP_HEADERS = [
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'x-forwarded-for',
  'x-forwarded-proto', 'x-real-ip', 'cdn-loop',
  'accept-encoding',
]

/** 首页 HTML（已内联，无需外部静态资源） */
const LANDING_HTML = '__LANDING_HTML__'

/* ============================== 入口 ============================== */

/**
 * EdgeOne 的 Function Handler。
 * @param {{request: Request, env?: Record<string,string>, params?: object}} context
 * @returns {Promise<Response>}
 */
export default async function onRequest(context) {
  const request = (context && context.request instanceof Request)
    ? context.request
    : context
  const config = readConfig(context && context.env)

  try {
    return await handle(request, config)
  } catch (err) {
    // 只写日志，不把堆栈回显给客户端
    console.error('[gh-proxy]', (err && err.stack) || err)
    return text('502 Bad Gateway', 502)
  }
}

/** 同时导出命名版本，方便 EdgeOne 的 onRequestGet 等细分签名复用 */
export { onRequest }

/**
 * @param {Request} req
 * @param {ReturnType<typeof readConfig>} config
 * @returns {Promise<Response>}
 */
async function handle(req, config) {
  const url = new URL(req.url)
  const pathname = url.pathname

  // ?q= 兼容老表单提交，必须在静态资源判断之前
  const q = url.searchParams.get('q')
  if (q) {
    const to = new URL('/' + stripScheme(q.trim()), url.origin)
    return redirect(to.href, 301)
  }

  // 首页与图标
  if (pathname === '/' || pathname === '/index.html') {
    return new Response(LANDING_HTML, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    })
  }
  if (pathname === '/robots.txt') {
    return text('User-agent: *\nAllow: /\n', 200)
  }

  // CORS 预检
  if (req.method === 'OPTIONS' && req.headers.has('access-control-request-headers')) {
    return new Response(null, { status: 204, headers: preflightHeaders() })
  }

  // 取出前缀后的原始地址
  let raw = pathname + url.search
  if (config.PREFIX !== '/') {
    if (!raw.startsWith(config.PREFIX)) return notFound()
    raw = raw.slice(config.PREFIX.length)
  } else {
    raw = raw.slice(1)
  }
  // 边缘会把 // 合并成 /，这里补回来
  raw = raw.replace(/^https?:\/{1,2}/i, 'https://')

  const kind = matchKind(raw)
  if (!kind) return notFound(explainUnsupported(raw))

  let target = raw
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target

  if (kind === 'blob') {
    if (config.JSDELIVR) return redirect(jsdelivrBlob(target), 302)
    target = target.replace('/blob/', '/raw/')
  }
  if (kind === 'rawhost' && config.JSDELIVR) {
    return redirect(jsdelivrRaw(target), 302)
  }

  const targetUrl = safeUrl(target)
  if (!targetUrl) return text('400 Bad Request: 无法解析目标地址', 400)

  return proxy(req, targetUrl, config, 0)
}

/* ============================== 代理 ============================== */

/**
 * @param {Request} req
 * @param {URL} targetUrl
 * @param {ReturnType<typeof readConfig>} config
 * @param {number} hops
 * @returns {Promise<Response>}
 */
async function proxy(req, targetUrl, config, hops) {
  if (hops > config.MAX_HOPS) return text('508 Loop Detected: 重定向次数过多', 508)
  if (!isAllowed(targetUrl)) return notFound('目标域名不在允许列表内')

  // 用普通对象构造请求头 —— EdgeOne 运行时要求
  const sendHeaders = buildRequestHeaders(req.headers, targetUrl.href, config)

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  /** @type {RequestInit} */
  const init = {
    method: req.method,
    headers: sendHeaders,
    redirect: 'manual',
  }
  if (hasBody && req.body) init.body = req.body

  let res
  try {
    res = await fetchWithRetry(targetUrl.href, init, hasBody, config.RETRIES)
  } catch (err) {
    const reason = describeFetchError(err)
    console.error('[gh-proxy-edgeone] upstream failed:', targetUrl.href, '-', reason)
    return errorPage({
      title: '无法连接到 GitHub',
      message: '请求上游时网络出错：' + reason,
      hint: '该域名在当前网络环境可能不可达。EdgeOne 机房无法访问 raw.githubusercontent.com，请改用 release 或 archive 链接。',
      status: 502,
    })
  }

  /* ---- 重定向：内部跟随，客户端只看到最终字节 ---- */
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    const next = location ? safeUrl(location, targetUrl) : null

    if (next && !hasBody && isAllowed(next) && hops < config.MAX_HOPS) {
      return proxy(req, next, config, hops + 1)
    }

    // 无法跟随 → 把 3xx 原样交还
    return new Response(null, {
      status: res.status,
      headers: {
        'location': location || '',
        'access-control-allow-origin': '*',
      },
    })
  }

  /* ---- 正常响应 ---- */
  const outHeaders = buildResponseHeaders(res.headers, config)

  // 流式透传，不 await 整个 body，大文件不占内存
  const body = (res.status === 204 || res.status === 304 || req.method === 'HEAD')
    ? null
    : res.body

  return new Response(body, {
    status: res.status,
    headers: outHeaders,
  })
}

/**
 * 构造转发给上游的请求头（普通对象）
 * @param {Headers} incoming
 * @param {string} referer
 * @param {ReturnType<typeof readConfig>} config
 */
function buildRequestHeaders(incoming, referer, config) {
  /** @type {Record<string,string>} */
  const out = {}

  // Headers 对象可迭代，但 EdgeOne 上稳妥起见用 forEach
  incoming.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (DROP_HEADERS.indexOf(lower) !== -1) return
    if (config.STRIP_CREDENTIALS && (lower === 'cookie' || lower === 'authorization')) return
    out[lower] = value
  })

  out['referer'] = referer
  return out
}

/**
 * 构造回给客户端的响应头（普通对象）
 * @param {Headers} upstream
 * @param {ReturnType<typeof readConfig>} config
 */
function buildResponseHeaders(upstream, config) {
  /** @type {Record<string,string>} */
  const out = {}

  upstream.forEach((value, key) => {
    const lower = key.toLowerCase()
    // CSP 会挡住我们的页面；content-encoding / content-length 见下方注释
    if (lower === 'content-security-policy') return
    if (lower === 'content-security-policy-report-only') return
    if (lower === 'clear-site-data') return
    if (lower === 'x-frame-options') return
    if (lower === 'content-encoding') return
    if (lower === 'content-length') return
    if (lower === 'set-cookie') return  // 单独处理
    out[lower] = value
  })

  // fetch() 返回的 body 已被 EdgeOne 运行时解压，
  // 若保留上游的 content-encoding 声明，客户端会按压缩流解析明文 → 乱码。
  // 因此上面已统一剥掉 content-encoding / content-length。

  out['access-control-allow-origin'] = '*'
  out['access-control-expose-headers'] = '*'

  // Set-Cookie 逐个处理并剥掉 Domain，否则浏览器拒绝写入
  const setCookies = collectSetCookies(upstream)
  if (setCookies.length > 0) {
    out['set-cookie'] = setCookies
      .map(c => c.replace(/;\s*domain=[^;]*/gi, ''))
      .join(', ')
  }

  return out
}

/**
 * 兼容不同运行时读取 Set-Cookie 的方式
 * @param {Headers} headers
 * @returns {string[]}
 */
function collectSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    try {
      const list = headers.getSetCookie()
      if (Array.isArray(list) && list.length) return list
    } catch {
      // 落到下面的兜底
    }
  }
  const single = headers.get('set-cookie')
  return single ? [single] : []
}

/** @returns {Record<string,string>} */
function preflightHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-max-age': '1728000',
  }
}

/* ============================== 重试 ============================== */

/**
 * 带重试的上游请求。只重试无 body 的幂等请求。
 * @param {string} href
 * @param {RequestInit} init
 * @param {boolean} hasBody
 * @param {number} retries
 */
async function fetchWithRetry(href, init, hasBody, retries) {
  const max = hasBody ? 0 : retries
  let lastErr
  for (let i = 0; i <= max; i++) {
    try {
      return await fetch(href, init)
    } catch (err) {
      lastErr = err
      if (i < max) await sleep(150 * (i + 1))
    }
  }
  throw lastErr
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

/* ============================== 工具 ============================== */

/**
 * 普通对象 headers 的 Response
 * @param {string} body
 * @param {number} status
 */
function text(body, status) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  })
}

/**
 * @param {string} location
 * @param {number} status
 */
function redirect(location, status) {
  return new Response(null, {
    status,
    headers: {
      'location': location,
      'access-control-allow-origin': '*',
    },
  })
}

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
  return u.protocol === 'https:' &&
    ALLOWED_HOSTS.indexOf(u.hostname.toLowerCase()) !== -1
}

/** @param {string} raw */
function matchKind(raw) {
  for (let i = 0; i < PATTERNS.length; i++) {
    if (PATTERNS[i].re.test(raw)) return PATTERNS[i].kind
  }
  return null
}

/**
 * 对「是 GitHub 链接但不支持」的情况给出更具体的原因。
 * @param {string} raw
 * @returns {string}
 */
function explainUnsupported(raw) {
  const v = stripScheme(raw).replace(/^\/+/, '')

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

/**
 * 把 fetch 抛出的错误翻译成人能看懂的一句话。
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
    UND_ERR_SOCKET: '连接被上游关闭'
  }

  if (code && map[code]) return map[code]
  if (/timeout/i.test(msg)) return '连接超时'
  if (/certificate/i.test(msg)) return '上游证书校验失败'
  if (/fetch failed/i.test(msg)) return '网络连接失败'

  if (/^[A-Z][A-Z0-9_]{2,40}$/.test(msg)) return msg
  return '网络请求异常'
}

/** @param {string} url */
function jsdelivrBlob(url) {
  return url
    .replace('/blob/', '@')
    .replace(/^(?:https?:\/\/)?github\.com/i, 'https://cdn.jsdelivr.net/gh')
}

/** @param {string} url */
function jsdelivrRaw(url) {
  return url.replace(
    /^(https?:\/\/)?raw\.(?:githubusercontent|github)\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)$/i,
    'https://cdn.jsdelivr.net/gh/$2/$3@$4/$5'
  )
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
