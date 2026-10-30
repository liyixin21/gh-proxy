/**
 * 腾讯云 EdgeOne Edge Functions 构建
 *
 *   node build.mjs
 *
 * 输出 dist/ 目录（可直接上传）+ dist-upload.zip（网页端拖拽上传）
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(DIR, 'dist')
const FN_DIR = path.join(DIST, 'edge-functions')

const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
const entryPath = path.join(DIR, 'edge-functions', '[[default]].js')
let src = fs.readFileSync(entryPath, 'utf8')

const PLACEHOLDER = '__LANDING_HTML__'

/** 转义成单引号字符串安全的内容 */
const esc = (t) => t
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "\\'")
  .replace(/\r?\n/g, '\\n')

// 幂等替换：匹配 "const LANDING_HTML = '...'" 整段
const re = /const LANDING_HTML = '[\s\S]*?'\n/
if (!re.test(src)) {
  console.error('✗ 找不到 const LANDING_HTML = \'...\' 声明')
  process.exit(1)
}
src = src.replace(re, `const LANDING_HTML = '${esc(html)}'\n`)

/* ---------- EdgeOne 运行时约束自检 ---------- */

const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

const checks = [
  (!/new\s+Headers\s*\(/.test(code), '未使用 new Headers()（官方要求普通对象）'),
  (!/Response\.json\s*\(/.test(code), '未使用 Response.json()（该运行时未实现）'),
  (!/process\.env/.test(code), '未使用 process.env（应走 context.env）'),
  (!/require\s*\(/.test(code), '未使用 require()'),
  (!/(?:^|[^.\w])Buffer\b/.test(code), '未引用 Node Buffer'),
  (/export\s+default\s+async\s+function\s+onRequest/.test(code), '入口为 onRequest(context)'),
  (/context\.env/.test(code), '从 context.env 读配置'),
  (/redirect:\s*'manual'/.test(code), '上游请求用 redirect: manual'),
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
  new vm.Script(asScript, { filename: 'default.js' })
} catch (e) {
  console.error(`✗ 语法错误：${e.message}`)
  process.exit(1)
}

/* ---------- 输出目录 ---------- */

fs.rmSync(DIST, { recursive: true, force: true })
fs.mkdirSync(FN_DIR, { recursive: true })

// 回写源码（保持占位符，便于下次再构建）
fs.writeFileSync(entryPath, src.replace(re, `const LANDING_HTML = '${PLACEHOLDER}'\n`), 'utf8')

fs.writeFileSync(path.join(FN_DIR, '[[default]].js'), src, 'utf8')
fs.copyFileSync(
  path.join(DIR, 'edge-functions', 'index.js'),
  path.join(FN_DIR, 'index.js')
)
fs.copyFileSync(path.join(DIR, 'index.html'), path.join(DIST, 'index.html'))
for (const ico of ['favicon.png', 'favicon-32.png']) {
  const from = path.join(DIR, ico)
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DIST, ico))
}
fs.writeFileSync(
  path.join(DIST, 'edgeone.json'),
  JSON.stringify({
    headers: [{
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
      ],
    }],
  }, null, 2),
  'utf8'
)

/* ---------- 打包 zip（网页端上传用） ---------- */

const files = []
const walk = (dir, base) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (fs.statSync(full).isDirectory()) walk(full, rel)
    else files.push({ rel, data: fs.readFileSync(full) })
  }
}
walk(DIST, '')

// 网页端上传要求根目录必须有 index.html
if (!files.some(f => f.rel === 'index.html')) {
  console.error('✗ zip 根目录缺少 index.html（网页端上传会 404）')
  process.exit(1)
}

const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

const locals = [], centrals = []
let offset = 0

for (const f of files) {
  const name = Buffer.from(f.rel, 'utf8')
  const crc = crc32(f.data)
  const size = f.data.length

  const lh = Buffer.alloc(30)
  lh.writeUInt32LE(0x04034b50, 0)
  lh.writeUInt16LE(20, 4)
  lh.writeUInt16LE(0x0800, 6)          // UTF-8 文件名
  lh.writeUInt32LE(crc, 14)
  lh.writeUInt32LE(size, 18)
  lh.writeUInt32LE(size, 22)
  lh.writeUInt16LE(name.length, 26)
  locals.push(lh, name, f.data)

  const ch = Buffer.alloc(46)
  ch.writeUInt32LE(0x02014b50, 0)
  ch.writeUInt16LE(20, 4)
  ch.writeUInt16LE(20, 6)
  ch.writeUInt16LE(0x0800, 8)
  ch.writeUInt32LE(crc, 16)
  ch.writeUInt32LE(size, 20)
  ch.writeUInt32LE(size, 24)
  ch.writeUInt16LE(name.length, 28)
  ch.writeUInt32LE(offset, 42)
  centrals.push(ch, name)

  offset += 30 + name.length + size
}

const central = Buffer.concat(centrals)
const eocd = Buffer.alloc(22)
eocd.writeUInt32LE(0x06054b50, 0)
eocd.writeUInt16LE(files.length, 8)
eocd.writeUInt16LE(files.length, 10)
eocd.writeUInt32LE(central.length, 12)
eocd.writeUInt32LE(offset, 16)

fs.writeFileSync(path.join(DIR, 'dist-upload.zip'), Buffer.concat([...locals, central, eocd]))

console.log(`✓ 已内联 index.html（${(html.length / 1024).toFixed(1)} KB）`)
console.log(`✓ EdgeOne 运行时约束自检 ${checks.length} 项通过`)
console.log(`✓ 产物  edgeone/dist/（${files.length} 个文件）`)
console.log(`✓ 上传包 edgeone/dist-upload.zip`)
console.log('')
console.log('部署：把 dist-upload.zip 拖进 EdgeOne Makers 的 Upload directly')
