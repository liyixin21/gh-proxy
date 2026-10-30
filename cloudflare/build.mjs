/**
 * Cloudflare Workers 构建
 *
 *   node build.mjs
 *
 * 把 index.html 内联进 worker.js，输出可直接部署的单文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(DIR, 'dist')

const BEGIN = '/* ==== BEGIN GENERATED: index.html（由 build.mjs 生成，勿手改） ==== */'
const END = '/* ==== END GENERATED ==== */'

const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
const workerPath = path.join(DIR, 'worker.js')
let worker = fs.readFileSync(workerPath, 'utf8')

const beginIdx = worker.indexOf(BEGIN)
const endIdx = worker.indexOf(END)

if (beginIdx === -1 || endIdx === -1) {
  console.error('✗ worker.js 里找不到生成标记')
  process.exit(1)
}

/** 转义成模板字面量安全的内容 */
const esc = (t) => t
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')

const block = `${BEGIN}\nconst LANDING_HTML = \`${esc(html)}\`\n${END}`
worker = worker.slice(0, beginIdx) + block + worker.slice(endIdx + END.length)

fs.writeFileSync(workerPath, worker, 'utf8')

// 语法校验
try {
  const asScript = worker
    .replace(/^export\s+default\s+/gm, 'var __d = ')
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
  new vm.Script(asScript, { filename: 'worker.js' })
} catch (e) {
  console.error(`✗ 语法错误：${e.message}`)
  process.exit(1)
}

fs.mkdirSync(DIST, { recursive: true })
fs.writeFileSync(path.join(DIST, 'worker.js'), worker, 'utf8')

console.log(`✓ 已内联 index.html（${(html.length / 1024).toFixed(1)} KB）`)
console.log(`✓ 产物  cloudflare/dist/worker.js   ${(worker.length / 1024).toFixed(1)} KB`)
console.log('')
console.log('部署：cd cloudflare && wrangler deploy')
