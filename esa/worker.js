/**
 * GitHub 文件加速 —— 阿里云 ESA 边缘函数原生实现
 *
 * 与 Cloudflare 版的差异，全部由 ESA 运行时的硬约束驱动：
 *
 *   1. Headers 黑名单：host / connection / keep-alive / te / trailer / upgrade
 *      / proxy-connection / dnt / expect —— **读写都会抛异常**，
 *      所以不能像通用版那样 `headers.delete('host')`，必须完全回避。
 *   2. Header 对象上限 8 KB，超了直接 JS exception。
 *   3. 子请求只有 4 次（每次 redirect 也算一次），跳转必须严控。
 *   4. URL 总长不超过 4 KB。
 *   5. 网关等待首字节 10 秒，超时返回 504。
 *   6. 函数总响应时间 120 秒。
 *   7. ReadableStream 构造器未实现，不能用 `new ReadableStream()` 自建流；
 *      但可以直接复用 feed 返回的 res.body（这是运行时提供的流）。
 *   8. fetch 默认会自动解压 gzip，且 content-length 仍是解压前的大小
 *      —— 官方明确警告不能随意透传 content-length。
 *
 * 入口：export default { async fetch(request) }
 */

/* ============================== 配置 ============================== */

const CONFIG = {
  /** 路由前缀，挂在 example.com/gh/* 下时改成 '/gh/' */
  PREFIX: '/',
  /** 剥离 Cookie / Authorization */
  STRIP_CREDENTIALS: true,
  /**
   * 内部跟随跳转的最大次数。
   * ESA 单次执行只有 4 次 fetch：
   *   1 次原始请求 + N 次跳转 ≤ 4  →  N ≤ 3
   * 取 2 留 1 次余量做兜底。
   */
  MAX_HOPS: 2,
  /** blob / raw 是否改走 jsDelivr */
  JSDELIVR: false,
  /** URL 长度上限（ESA 限制 4 KB，这里留一点余量） */
  MAX_URL_LENGTH: 4000,
}

/* ============================== 常量 ============================== */

/**
 * ESA 的黑名单头：读写都会抛异常。
 * 任何 headers.get / set / delete 都必须先跳过这些名字。
 */
const ESA_BLACKLIST = [
  'expect', 'te', 'trailer', 'upgrade', 'proxy-connection',
  'connection', 'keep-alive', 'dnt', 'host',
]

/** 除黑名单外，我们额外希望丢弃的头（这些在 ESA 上可以安全操作） */
const EXTRA_DROP = [
  'proxy-authenticate', 'proxy-authorization', 'transfer-encoding',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'cdn-loop',
  'accept-encoding',
]

/** 判断某个头名是否在 ESA 黑名单里 */
function isBlacklisted(name) {
  const lower = String(name).toLowerCase()
  for (let i = 0; i < ESA_BLACKLIST.length; i++) {
    if (ESA_BLACKLIST[i] === lower) return true
  }
  return false
}

/** 判断是否应该主动丢弃（黑名单 ∪ 额外列表） */
function shouldDrop(name) {
  if (isBlacklisted(name)) return true
  const lower = String(name).toLowerCase()
  for (let i = 0; i < EXTRA_DROP.length; i++) {
    if (EXTRA_DROP[i] === lower) return true
  }
  return false
}

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

/** 首页 HTML（由 build 内联） */
const LANDING_HTML = '__LANDING_HTML__'

/* ============================== 入口 ============================== */

/**
 * ESA 的入口签名：export default { async fetch(request) }
 * 官方示例即此形态，参数就是标准 Request。
 */
export default {
  /**
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async fetch(request) {
    try {
      return await handle(request)
    } catch (err) {
      // 只写日志，不把堆栈回显给客户端
      console.error('[gh-proxy-esa]', (err && err.stack) || err)
      return text('502 Bad Gateway', 502)
    }
  },
}

/** 同时提供具名导出，便于本地测试与复用 */
export { handle }

/**
 * @param {Request} req
 * @returns {Promise<Response>}
 */
async function handle(req) {
  const url = new URL(req.url)
  const pathname = url.pathname

  // URL 长度保护（ESA 限制 4 KB）
  if (url.href.length > CONFIG.MAX_URL_LENGTH) {
    return text('414 URI Too Long', 414)
  }

  // ?q= 兼容老表单，必须在静态资源之前
  let q = null
  try {
    q = url.searchParams.get('q')
  } catch {
    q = null
  }
  if (q) {
    // ESA 的 Response.redirect 需要绝对地址
    return redirect(new URL('/' + stripScheme(q.trim()), url.origin).href, 301)
  }

  // 首页
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
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: preflightHeaders() })
  }

  // 取出前缀后的原始地址
  let raw = pathname
  const search = url.search || ''
  if (CONFIG.PREFIX !== '/') {
    const full = raw + search
    if (!full.startsWith(CONFIG.PREFIX)) return notFound()
    raw = full.slice(CONFIG.PREFIX.length)
  } else {
    raw = raw.slice(1) + search
  }
  // 边缘会把 // 合并成 /，这里补回来
  raw = raw.replace(/^https?:\/{1,2}/i, 'https://')

  const kind = matchKind(raw)
  if (!kind) return notFound(explainUnsupported(raw))

  let target = raw
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target

  if (kind === 'blob') {
    if (CONFIG.JSDELIVR) return redirect(jsdelivrBlob(target), 302)
    target = target.replace('/blob/', '/raw/')
  }
  if (kind === 'rawhost' && CONFIG.JSDELIVR) {
    return redirect(jsdelivrRaw(target), 302)
  }

  const targetUrl = safeUrl(target)
  if (!targetUrl) return text('400 Bad Request: 无法解析目标地址', 400)

  return proxy(req, targetUrl, 0)
}

/* ============================== 代理 ============================== */

/**
 * @param {Request} req
 * @param {URL} targetUrl
 * @param {number} hops 已跟随的跳转次数
 * @returns {Promise<Response>}
 */
async function proxy(req, targetUrl, hops) {
  if (hops > CONFIG.MAX_HOPS) {
    return text('508 Loop Detected: 跳转次数超出 ESA 子请求预算', 508)
  }
  if (!isAllowed(targetUrl)) return notFound('目标域名不在允许列表内')

  const method = req.method
  const hasBody = method !== 'GET' && method !== 'HEAD'

  /** @type {RequestInit} */
  const init = {
    method,
    headers: buildRequestHeaders(req.headers),
    // 关键：必须 manual，否则 ESA 会自动跟随且无法改写 Location
    redirect: 'manual',
  }

  if (hasBody && req.body) {
    init.body = req.body
  }

  // 用 { redirect: 'manual' } 拿到 3xx，自己做有限次跟随
  let res
  try {
    res = await fetch(targetUrl.href, init)
  } catch (err) {
    const reason = describeFetchError(err)
    console.error('[gh-proxy-esa] upstream failed:', targetUrl.href, '-', reason)
    return errorPage({
      title: '无法连接到 GitHub',
      message: '请求上游时网络出错：' + reason,
      hint: '该域名在当前网络环境可能不可达。raw.githubusercontent.com 在部分网络下会被阻断，可换用 release 或 archive 链接。',
      status: 502,
    })
  }

  /* ---- 3xx：内部跟随，客户端只看最终字节 ---- */
  if (res.status >= 300 && res.status < 400) {
    let location = null
    try {
      location = res.headers.get('location')
    } catch {
      location = null
    }

    const next = location ? safeUrl(location, targetUrl) : null

    if (next && !hasBody && isAllowed(next) && hops < CONFIG.MAX_HOPS) {
      // 释放当前响应，让连接能回收进 ESA 的长连接池
      try {
        if (res.body && typeof res.body.cancel === 'function') await res.body.cancel()
      } catch {
        // 忽略
      }
      return proxy(req, next, hops + 1)
    }

    // 无法继续跟随：把 3xx 原样交还，让浏览器自己处理
    const passThrough = {}
    if (location) passThrough['location'] = location
    passThrough['access-control-allow-origin'] = '*'
    return new Response(null, { status: res.status, headers: passThrough })
  }

  /* ---- 正常响应 ---- */
  return buildStreamResponse(res, method)
}

/**
 * 把上游响应转成对客户端的响应。
 *
 * ESA 注意事项：
 *   - fetch 已自动解压 gzip，content-length 是解压前大小 → 必须丢弃
 *   - content-encoding 也要丢弃，否则客户端按压缩流解析明文
 *   - res.body 是运行时提供的 ReadableStream，可直接复用做流式转发
 *     （不要用 new ReadableStream()，ESA 未实现该构造器）
 *
 * @param {Response} res
 * @param {string} method
 * @returns {Response}
 */
function buildStreamResponse(res, method) {
  const out = {}

  // 复制上游响应头，跳过黑名单与会产生歧义的头
  try {
    res.headers.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (isBlacklisted(lower)) return
      if (lower === 'content-encoding') return   // 已解压
      if (lower === 'content-length') return     // 解压前后大小不一致
      if (lower === 'content-security-policy') return
      if (lower === 'content-security-policy-report-only') return
      if (lower === 'clear-site-data') return
      if (lower === 'x-frame-options') return
      if (lower === 'set-cookie') return         // 单独处理
      if (lower === 'transfer-encoding') return
      out[lower] = value
    })
  } catch {
    // 某些头的迭代在 ESA 上可能异常，退化为最小头集合
  }

  out['access-control-allow-origin'] = '*'
  out['access-control-expose-headers'] = '*'

  // Set-Cookie：ESA 上不一定有 getSetCookie，从原始头里尽量取
  const cookie = safeGetCookie(res.headers)
  if (cookie) out['set-cookie'] = cookie.replace(/;\s*domain=[^;]*/gi, '')

  // 无 body 的场景
  if (res.status === 204 || res.status === 304 || method === 'HEAD') {
    return new Response(null, { status: res.status, headers: out })
  }

  // 直接复用上游流，ESA 全程流式，不占 JS 堆
  return new Response(res.body, { status: res.status, headers: out })
}

/**
 * 尽力读取 Set-Cookie
 * @param {Headers} headers
 */
function safeGetCookie(headers) {
  try {
    if (typeof headers.getSetCookie === 'function') {
      const list = headers.getSetCookie()
      if (Array.isArray(list) && list.length) return list.join(', ')
    }
  } catch {
    // 落到下面
  }
  try {
    return headers.get('set-cookie')
  } catch {
    return null
  }
}

/**
 * 构造发往上游的请求头。
 * 黑名单头既不读也不写，避免 ESA 抛异常。
 * @param {Headers} incoming
 * @returns {Record<string,string>}
 */
function buildRequestHeaders(incoming) {
  const out = {}

  try {
    incoming.forEach((value, key) => {
      const lower = key.toLowerCase()
      if (shouldDrop(lower)) return
      if (CONFIG.STRIP_CREDENTIALS && (lower === 'cookie' || lower === 'authorization')) return
      out[lower] = value
    })
  } catch {
    // 迭代失败时退化为空头，让上游用默认值
  }

  return out
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
 * ESA 的 Response.redirect 要求绝对 URL，此处统一封装
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

  // 未知错误：只回显像网络错误码的内容，其余泛化，避免泄露内部细节
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
