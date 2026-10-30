/**
 * GitHub 文件加速 —— 根路由入口
 *
 * EdgeOne 按 /edge-functions 目录结构生成路由：
 *   edge-functions/index.js        →  https://域名/
 *   edge-functions/[[default]].js  →  https://域名/任意/路径
 *
 * 由于下载链接的路径形如 /https://github.com/...（含 ://），
 * 必须由 [[default]].js 兜底，否则会被按目录层级拆开导致 404。
 *
 * 本文件只处理根路径与首页，其余交给 [[default]].js。
 */

export { default } from './[[default]].js'
export { onRequest } from './[[default]].js'
