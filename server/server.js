#!/usr/bin/env node
/**
 * 大屏聚合平台 · 服务端管理系统
 * ---------------------------------------------------------------------------
 * 零依赖：仅使用 Node 内置模块（http / fs / path / crypto / url），
 * 拷贝到任何装了 Node 的机器即可 `node server.js` 运行，无需 npm install。
 *
 * 职责：
 *   1) 对外提供配置数据（客户端拉取）：GET /api/config
 *   2) 管理后台的增删改查接口：/api/admin/*
 *   3) 托管页面（单端口 18000，不额外起服务）：
 *        GET /          电脑浏览器客户端（站点首页，别名 /app、/client）
 *        GET /setting   管理（设置）页面
 *        GET /preview   电视端 1:1 预览页
 *
 * 模块划分（本文件只做装配与启动）：
 *        http-util.js  错误类型 / 响应写出 / 请求体读取 / CORS
 *        store.js      config.json 数据层（种子 / 归一化 / 原子写盘 / 串行 mutate）
 *        routes.js     路由、管理接口、增量协议与入口校验
 *
 * 数据：单个 JSON 文件 server/data/config.json，原子写盘 + 自动备份。
 *
 * 启动：
 *   node server/server.js                  # 默认端口 18000
 *   node server/server.js --port 9000      # 指定端口
 *   PORT=9000 node server/server.js        # 或用环境变量
 *   node server/server.js --host 127.0.0.1 # 只监听本机（配合反向代理时更安全）
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { createProxy } = require('./proxy');
const camera = require('./camera');
const { createShot } = require('./shot');
const { createMedia } = require('./media');
const { createCtl } = require('./ctl');
const { createPageWatch } = require('./page-watch');
const { HttpError, sendJson, CORS } = require('./http-util');
const { createStore } = require('./store');
const { createRouter } = require('./routes');

/* ============================ 配置与常量 ============================ */

const ROOT = __dirname;
// 数据目录可用 TVSHOW_DATA_DIR 覆盖：自动化测试据此跑在隔离实例上，
// 避免验证脚本（会增删页面、改标题、bump epoch）污染正在使用的数据。
const DATA_DIR = process.env.TVSHOW_DATA_DIR || path.join(ROOT, 'data');
const ADMIN_FILE = path.join(ROOT, 'admin', 'index.html');
// 电脑浏览器客户端页面（构建产物：node tools/build-client.mjs）
const CLIENT_FILE = path.join(ROOT, 'client', 'index.html');
// 电视端 1:1 预览页（构建产物：node tools/build-preview.mjs，位于工程根的 dist/）
const PREVIEW_FILE = path.join(ROOT, '..', 'dist', 'preview.html');
// 多设备互控 · 独立控制台（纯控制端，自身不注册为受控设备）
const CONSOLE_FILE = path.join(ROOT, 'console.html');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法: node server.js [--port 18000] [--host 0.0.0.0]');
  process.exit(0);
}
const PORT = Number(args.port || process.env.PORT || 18000);
const HOST = args.host || process.env.HOST || '0.0.0.0';

/* ============================ 数据与运行期模块 ============================ */

/** 配置数据仓库（config.json）：种子、归一化、原子写盘、串行 mutate */
const store = createStore({ dataDir: DATA_DIR });

/** 反向代理实例，在 start() 里创建（需要 PORT 与 store.data.entries） */
let proxy = null;
/** 极速模式采集模块（惰性拉起 Chromium，首次有观看者才启动） */
let shot = null;
/** 多设备互控 · 控制通道（设备档案 / 心跳 / 指令 / 场景） */
let ctl = null;
/** 素材上墙：上传 / 转换（PDF/PPT→图片）/ 播放页与原始文件服务 */
let media = null;
/** 页面改版探测：页面重新发布（ETag/Last-Modified 变化）后通知客户端自动重载 */
let pageWatch = null;

/** 路由层：页面托管 + 客户端/管理接口（运行期模块在 start() 内创建，按需取值） */
const router = createRouter({
  store,
  camera,
  files: {
    adminFile: ADMIN_FILE,
    clientFile: CLIENT_FILE,
    previewFile: PREVIEW_FILE,
    consoleFile: CONSOLE_FILE
  },
  getProxy: () => proxy,
  getShot: () => shot,
  getCtl: () => ctl,
  getMedia: () => media
});

/* ============================ 启动 ============================ */

function start() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = store.load();
  // 首次启动即落盘，便于运维直接看到并备份数据文件
  if (!fs.existsSync(store.dataFile)) store.persist();

  // 反向代理：目标只能由 data.entries 的 id 推导，禁止用 URL 参数指定目标（防 SSRF）
  proxy = createProxy({
    getEntries: () => data.entries,
    listenPort: PORT,
    log: (msg) => console.log(msg)
  });

  // 摄像头画面墙：RTSP 凭据只留在服务端，客户端仅按编号点播
  camera.configure(data.cameras);

  // 素材上墙：可选系统工具（pdftoppm / soffice），缺失时对应类型降级提示，不阻塞启动
  media = createMedia({
    dataDir: DATA_DIR,
    log: (msg) => console.log(msg)
  });

  // 极速模式：可选依赖（playwright-core/Chromium），缺失时自动降级，不阻塞启动
  shot = createShot({
    getEntries: () => data.entries,
    dataDir: DATA_DIR,
    log: (msg) => console.log(msg)
  });
  shot.start();

  // 页面改版探测：目标页重新发布（URL 不变）后，正在显示它的电视自动重载；
  // 极速模式的常驻截图页同步重载（shot 可用时）
  pageWatch = createPageWatch({
    getEntries: () => data.entries,
    onChange: (id) => (shot ? shot.reloadIfActive(id) : Promise.resolve()),
    log: (msg) => console.log(msg)
  });
  pageWatch.start();

  // 多设备互控 · 控制通道（零依赖，devices.json 独立于 config.json）
  ctl = createCtl({
    dataDir: DATA_DIR,
    getEntries: () => data.entries,
    // media 指令（素材上墙）下发时校验素材存在性
    getMedia: () => (media ? media.exists : () => false),
    // 心跳响应携带内容版本与页面指纹：客户端发现落后即立即强制同步 / 重载当前页
    getContentVersion: () => ({
      version: data.version,
      epoch: data.epoch,
      pages: pageWatch ? pageWatch.snapshot() : {}
    }),
    log: (msg) => console.log(msg)
  });

  const server = http.createServer((req, res) => {
    router.handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(`[error] ${req.method} ${req.url}`, err);
      if (res.headersSent) return res.end();
      // 413 用 Connection: close 明确结束本次请求；响应写完再断开，保证客户端能读到 JSON
      if (status === 413) {
        sendJson(res, status, { error: err.message || '请求体过大' }, { ...CORS, Connection: 'close' });
        res.once('finish', () => { try { req.destroy(); } catch (e) { /* 忽略 */ } });
        return;
      }
      sendJson(res, status, { error: err.message || '服务端内部错误' }, CORS);
    });
  });

  // WebSocket（监控大屏常用）经由同一前缀转发
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    } catch (e) {
      return socket.destroy();
    }
    if (proxy.isProxyPath(pathname)) return proxy.handleUpgrade(req, socket, head);
    return socket.destroy();
  });

  server.listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' ? '<本机IP>' : HOST;
    console.log('');
    console.log('  大屏聚合平台 · 服务端已启动');
    console.log(`  电脑客户端 http://${shown}:${PORT}/            （站点首页）`);
    console.log(`  管理设置   http://${shown}:${PORT}/setting`);
    console.log(`  预览页面   http://${shown}:${PORT}/preview`);
    console.log(`  客户端接口 http://${shown}:${PORT}/api/config`);
    console.log(`  反向代理   http://${shown}:${PORT}/proxy/<入口id>/…（供电脑端自动登录使用）`);
    console.log(`  极速模式   http://${shown}:${PORT}/shot/<入口id>/view（截图展示）`);
    console.log(`  设备控制   http://${shown}:${PORT}/console（多设备互控 · 平板书签直达）`);
    console.log(`  数据文件   ${store.dataFile}`);
    console.log(`  当前版本   version=${data.version} epoch=${data.epoch} 条目=${data.entries.length}`);
    console.log('');
    console.log('  按 Ctrl+C 停止');
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用，请用 --port 指定其它端口`);
      process.exit(1);
    }
    throw e;
  });

  /* ---------- 优雅退出 ----------
   * systemd 重启时先收到 SIGTERM：立即停止采集/转码并关闭 HTTP 监听，
   * 避免 Chromium / ffmpeg 子进程残留导致 stop 任务一直等到 TimeoutStopSec。 */
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[sys] 收到 ${signal}，开始优雅退出…`);

    // 停止接受新连接；keep-alive 连接最多再等 800ms 后强制断开
    const closed = new Promise((resolve) => {
      try { server.close(() => resolve()); } catch (e) { resolve(); }
    });
    const forceClose = setTimeout(() => {
      try { if (server.closeAllConnections) server.closeAllConnections(); } catch (e) { /* 忽略 */ }
    }, 800);
    forceClose.unref();

    try { if (pageWatch) pageWatch.stop(); } catch (e) { /* 忽略 */ }
    // 先杀 ffmpeg 转码进程（同步），再关 Chromium 上下文/浏览器（异步，限时 2.5s）
    try { camera.stopAll(); } catch (e) { console.warn(`[sys] 停止摄像头转码失败：${e.message}`); }
    try {
      if (shot && typeof shot.stop === 'function') {
        await Promise.race([
          shot.stop().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 2500))
        ]);
      }
    } catch (e) {
      console.warn(`[sys] 停止极速模式采集失败：${e.message}`);
    }

    // 给在途 HTTP 响应最多 1s 收尾（无连接时立即返回），避免重启瞬间切断请求
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
    clearTimeout(forceClose);

    console.log('[sys] 已停止采集与转码，退出');
    process.exit(0);
  }

  process.once('SIGTERM', () => { shutdown('SIGTERM'); });
  process.once('SIGINT', () => { shutdown('SIGINT'); });
}

start();
