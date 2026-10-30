# gh-proxy

GitHub 文件加速器。三个平台各自独立，各有一个文件夹、一个构建脚本。

```
https://<你的域名>/https://github.com/owner/repo/releases/download/v1.0/file.zip
https://<你的域名>/https://github.com/owner/repo/archive/refs/heads/main.zip
https://<你的域名>/https://raw.githubusercontent.com/owner/repo/main/file.txt
```

服务端内部跟随 GitHub 的签名跳转，浏览器只看最终字节。全程流式透传，大文件不占内存。

---

## ⚠️ 腾讯云 EdgeOne 无法下载 raw 文件

**实测确认的平台限制，不是代码 bug。**

EdgeOne 机房到 `raw.githubusercontent.com` 不通，请求返回 EdgeOne 平台自己的 502 页面
（`<title>Tencent Edgeone</title>`），函数无法完成。

| 链接类型 | EdgeOne | ESA | Cloudflare |
|---|---|---|---|
| `releases/download/` | ✅ | ✅ | ✅ |
| `archive/` | ✅ | ✅ | ✅ |
| `blob/`（内部会转 raw） | ❌ | ✅ | ✅ |
| **`raw.githubusercontent.com`** | **❌** | **✅** | ✅ |
| `gist.githubusercontent.com` | ❌ | ✅ | ✅ |

**只有 EdgeOne 这一个平台受限**，阿里云 ESA 和 Cloudflare 的 raw 都能正常下载。

- 需要 raw / blob / gist，且必须用 EdgeOne → 把 `JSDELIVR` 开关设为开，
  blob / raw 会 302 到 `cdn.jsdelivr.net`
- 不用 EdgeOne → 直接用即可，无需任何额外配置

---

## 目录结构

```
gh-proxy/
├── cloudflare/               Cloudflare Workers
│   ├── worker.js             主代码
│   ├── index.html            首页
│   ├── favicon.png
│   ├── wrangler.toml
│   └── build.mjs
│
├── esa/                      阿里云 ESA 边缘函数
│   ├── worker.js
│   ├── index.html
│   ├── favicon.png
│   └── build.mjs
│
├── edgeone/                  腾讯云 EdgeOne
│   ├── edge-functions/
│   │   ├── index.js          根路由
│   │   └── [[default]].js    兜底路由（关键）
│   ├── index.html
│   ├── favicon.png
│   └── build.mjs
│
├── README.md
├── LICENSE
└── package.json
```

每个平台文件夹都是**完全自包含**的：源码、首页、构建脚本都在里面，互不依赖。

---

## 构建

```bash
npm run build            # 一次构建全部三个平台
```

也可以单独构建：

```bash
npm run build:cf         # Cloudflare
npm run build:esa        # 阿里云 ESA
npm run build:edgeone    # 腾讯云 EdgeOne
```

构建脚本是**幂等**的：源码里保存 `__LANDING_HTML__` 占位符，每次构建时内联首页到产物，
源码本身保持不变，可以反复构建。

| 平台 | 产物 | 部署方式 |
|---|---|---|
| Cloudflare | `cloudflare/dist/worker.js` | `wrangler deploy` |
| ESA | `esa/dist/worker.js` | 全文粘贴进控制台代码页签 |
| EdgeOne | `edgeone/dist-upload.zip` | 拖进网页上传区 |

---

## 部署

### Cloudflare

```bash
cd cloudflare
wrangler login
wrangler deploy
```

### 阿里云 ESA

1. <https://esa.console.aliyun.com/edge/function/list> → **函数和 Pages** → 创建函数
2. 名称 `gh-proxy`，语言 **JavaScript**
3. **代码** 页签粘贴 `esa/dist/worker.js` 全文 → 保存
4. **域名** 页签 → 添加域名（不支持泛域名，逐个绑）→ 按提示加 CNAME
5. 测试环境验证 → **发布**到生产环境

> ESA 有测试/生产两级，改代码后必须重新发布版本才生效。

### 腾讯云 EdgeOne

1. <https://console.tencentcloud.com/edgeone/makers> → **Create Project** → **Upload directly**
2. 项目名 `gh-proxy`，区域选 **Global**（选中国大陆需 ICP 备案）
3. 拖入 `edgeone/dist-upload.zip`
4. 点 **Deploy**

> 选了「直接上传」后不能切换成 Git 集成。zip 根目录必须有 `index.html`。

---

## 平台对比

| 项目 | Cloudflare | EdgeOne | ESA |
|---|---|---|---|
| raw 文件 | ✅ | ❌ | ✅ |
| 子请求上限 | 50 / 10000 | 64 | **4** |
| 代码包上限 | 10 MB | 5 MB | **4 MB** |
| Header 黑名单 | 无 | 无 | **9 个** |
| 首字节超时 | 无 | — | **10 秒** |
| 泛域名 | ✅ | 需企业版 | ❌ 逐个绑 |
| 产物大小 | 37.1 KB | 37.6 KB | 37.0 KB |

**下载大小**：代码不限制，全程流式。Cloudflare / EdgeOne 基本无上限；
ESA 受 120 秒响应时限约 **310 MB**（实测 2.6 MB/s，TTFB 约 1 秒）。

**raw 可用性**：Cloudflare 和 ESA 都能正常下载 raw / blob / gist，
只有 EdgeOne 受机房网络限制无法访问 `raw.githubusercontent.com`。

---

## 三份代码为什么不能合并

入口签名和运行时约束都不同，硬套会直接崩溃。

### Cloudflare

```js
export default { async fetch(request) { return dispatch(request) } }
```

### ESA

```js
export default { async fetch(request) { ... } }
```

| 约束 | 应对 |
|---|---|
| 9 个 header **读写即抛异常**<br>（`host` `connection` `keep-alive` `te` `trailer` `upgrade` `dnt` `expect` `proxy-connection`） | 全程字符串过滤，绝不 `get`/`set`/`delete` |
| `ReadableStream` 构造器未实现 | 只复用 `res.body` |
| `content-length` 是解压前大小 | 丢弃 `content-length` + `content-encoding` |
| 子请求仅 4 次 | `MAX_HOPS = 2` |
| URL 上限 4 KB | 超长返回 414 |

### EdgeOne

```js
export default async function onRequest(context) {
  const { request, env } = context
}
```

| 约束 | 应对 |
|---|---|
| 不支持 `new Headers()` | 全用普通对象 |
| 不支持 `Response.json()` | 手写 `JSON.stringify` |
| 无 `process.env` | 用 `context.env` |
| 路由按目录生成，`://` 会被拆 | 必须用 `[[default]].js` 兜底 |

---

## 构建自检

每个平台构建时会做静态检查，不通过就中止：

| 平台 | 检查项 |
|---|---|
| ESA | 10 项（黑名单头、ReadableStream、MAX_HOPS、URL 长度…） |
| EdgeOne | 8 项（`new Headers`、`Response.json`、`context.env`…） |

---

## 常见问题

**首页 404** — `index.html` 被包在了一层目录里。检查 zip 解压后第一层是不是直接就是它。

**下载链接 404** — `edge-functions/[[default]].js` 没上传成功，或文件名被改动。

**大文件 504** — ESA 有 10 秒首字节等待限制，上游慢就会断。

**raw 502** — 仅在 EdgeOne 上出现，见开头限制说明。Cloudflare / ESA 不受影响。

---

## 与上游的关系

改写自 [hunshcn/gh-proxy](https://github.com/hunshcn/gh-proxy)（MIT）。

主要改动：拆成三个平台原生实现、HTML 错误提示页、前端重做（实时校验 / 深色模式）、
修复 `content-encoding` 透传乱码、修复相对 `Location` 崩溃、重定向环保护、
白名单限制、错误不回显堆栈。

## License

MIT，见 [LICENSE](LICENSE)。原始版权 `Copyright (c) 2020 hunshcn`。
