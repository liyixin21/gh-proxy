/**
 * 阿里云 ESA 边缘函数构建
 *
 *   node build.mjs
 *
 * 幂等：无论 worker.js 里当前是占位符还是已内联的 HTML，都能重新生成。
 * 输出单文件（ESA 要求单文件部署）。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(DIR, 'dist')
const SRC_PATH = path.join(DIR, 'worker.js')
const PLACEHOLDER = '__LANDING_HTML__'

const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
let src = fs.readFileSync(SRC_PATH, 'utf8')

/** 转义成单引号字符串安全的内容 */
const esc = (t) => t
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "\\'")
  .replace(/\r?\n/g, '\\n')

// 幂等替换：匹配 "const LANDING_HTML = '...'" 整段
const re = /const LANDING_HTML = '[\s\S]*?'\n/
if (!re.test(src)) {
  console.error('✗ worker.js 里找不到 const LANDING_HTML = \'...\' 声明')
  process.exit(1)
}
src = src.replace(re, `const LANDING_HTML = '${esc(html)}'\n`)

/* ---------- ESA 运行时约束自检 ---------- */

// 剥离注释后再检查，避免把「说明为何不能用 X」的注释误判成违规
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const checks = [
  (!/new\s+ReadableStream\s*\(/.test(code), '未使用 new ReadableStream()（ESA 构造器未实现）'),
  (!/new\s+Headers\s*\(/.test(code), '未使用 new Headers()（该运行时要求普通对象）'),
  (!/Response\.json\s*\(/.test(code), '未使用 Response.json()'),
  (!/process\.env/.test(code), '未使用 process.env'),
  (!/require\s*\(/.test(code), '未使用 require()'),
  (!/(?:^|[^.\w])Buffer\b/.test(code), '未引用 Node Buffer'),
  (!/\.(?:delete|set|get|append)\s*\(\s*['"`](?:expect|te|trailer|upgrade|proxy-connection|connection|keep-alive|dnt|host)['"`]/i.test(code),
    '未操作 Header 黑名单（9 个头读写即抛异常）'),
  (/export\s+default\s*\{/.test(code), '入口为 export default { fetch }'),
  (/MAX_HOPS:\s*2/.test(code), 'MAX_HOPS = 2（适配 4 次子请求预算）'),
  (/MAX_URL_LENGTH:\s*4000/.test(code), 'URL 长度保护 4000 字符（ESA 上限 4KB）'),
]

let failed = 0
for (const [pass, msg] of checks) {
  if (!pass) { console.error(`✗ ${msg}`); failed++ }
}
if (failed) process.exit(1)

// 语法校验
try {
  const asScript = code
    .replace(/^export\s+default\s+/gm, 'var __d = ')
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
  new vm.Script(asScript, { filename: 'worker.js' })
} catch (e) {
  console.error(`✗ 语法错误：${e.message}`)
  process.exit(1)
}

// 回写源码（保持占位符，便于下次再构建）
const restore = src.replace(re, `const LANDING_HTML = '${PLACEHOLDER}'\n`)
fs.writeFileSync(SRC_PATH, restore, 'utf8')

// 输出产物
fs.mkdirSync(DIST, { recursive: true })
fs.writeFileSync(path.join(DIST, 'worker.js'), src, 'utf8')

const limit = 4 * 1024 * 1024
console.log(`✓ 已内联 index.html（${(html.length / 1024).toFixed(1)} KB）`)
console.log(`✓ ESA 运行时约束自检 ${checks.length} 项通过`)
console.log(`✓ 产物  esa/dist/worker.js   ${(src.length / 1024).toFixed(1)} KB（限额 4 MB，占 ${((src.length / limit) * 100).toFixed(2)}%）`)
console.log('')
console.log('部署：全文粘贴 esa/dist/worker.js 到 ESA 控制台「代码」页签')
