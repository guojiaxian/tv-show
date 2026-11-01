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
 *   3) 托管三个页面（单端口 18080，不额外起服务）：
 *        GET /          电脑浏览器客户端（站点首页，别名 /app、/client）
 *        GET /setting   管理（设置）页面
 *        GET /preview   电视端 1:1 预览页
 *
 * 数据：单个 JSON 文件 server/data/config.json，原子写盘 + 自动备份。
 *
 * 启动：
 *   node server/server.js                  # 默认端口 18080
 *   node server/server.js --port 9000      # 指定端口
 *   PORT=9000 node server/server.js        # 或用环境变量
 *   node server/server.js --host 127.0.0.1 # 只监听本机（配合反向代理时更安全）
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { createProxy } = require('./proxy');
const camera = require('./camera');
const transpile = require('./transpile');
const { createShot } = require('./shot');
const { createCtl } = require('./ctl');

/* ============================ 配置与常量 ============================ */

const ROOT = __dirname;
// 数据目录可用 TVSHOW_DATA_DIR 覆盖：自动化测试据此跑在隔离实例上，
// 避免验证脚本（会增删页面、改标题、bump epoch）污染正在使用的数据。
const DATA_DIR = process.env.TVSHOW_DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'config.json');
const BACKUP_FILE = path.join(DATA_DIR, 'config.json.bak');
const ADMIN_FILE = path.join(ROOT, 'admin', 'index.html');
// 电脑浏览器客户端页面（构建产物：node tools/build-client.mjs）
const CLIENT_FILE = path.join(ROOT, 'client', 'index.html');
// 电视端 1:1 预览页（构建产物：node tools/build-preview.mjs，位于工程根的 dist/）
const PREVIEW_FILE = path.join(ROOT, '..', 'dist', 'preview.html');
// 多设备互控 · 独立控制台（纯控制端，自身不注册为受控设备）
const CONSOLE_FILE = path.join(ROOT, 'console.html');

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_ICONS = ['storage', 'env', 'security', 'default'];
/** 入口类型：普通网页 / 内置摄像头画面墙 */
const ALLOWED_TYPES = ['url', 'camera'];
/**
 * 摄像头画面墙默认配置。管理后台不暴露该配置（保证「点开即看」的傻瓜式体验），
 * 如需调整可直接编辑 server/data/config.json 的 cameras 字段。
 */
const DEFAULT_CAMERAS = {
  enabled: true,
  host: '10.8.12.131',
  port: 554,
  username: 'show',
  password: 'wtzx@2026',
  count: 8,
  titles: {},
  // 画面墙品牌格：3×3 中第 5 格（第二行第二列）放这张图（黑底居中），
  // 其余摄像头依次往后挪一格，8 路仍全部上墙。文件路径相对项目根目录。
  logo: 'wutan-logo.png',
  logoCell: 5
};
const MAX_BODY_BYTES = 256 * 1024;
/** 保留的删除痕迹条数上限，超出后抬高 prunedBeforeRev 并裁剪 */
const MAX_TOMBSTONES = 200;

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

/* ============================ 数据层 ============================ */

/** 内置种子数据：首次启动时（数据文件不存在）生成，来源于改造前的 assets/config.json */
function seedData() {
  return {
    version: 1,
    epoch: 1,
    metaRev: 1,
    orderRev: 1,
    prunedBeforeRev: 0,
    updatedAt: new Date().toISOString(),
    appTitle: '数智中心大屏聚合平台',
    appSubtitle: 'DIGITAL CENTER · DISPLAY HUB',
    exitConfirm: true,
    exitTip: '按【返回】键将退出应用',
    cameras: normalizeCameras(null),
    entries: [
      {
        id: 'storage-monitor',
        title: '数智资源中心存储集群资源监控',
        subtitle: '存储集群容量总览 / 分区视图 / 容量趋势',
        url: 'http://10.8.11.4:1111/',
        accent: '#2FD2F5',
        icon: 'storage',
        scale: 0,
        autoFit: true,
        allowInsecureSsl: false,
        rev: 1
      },
      {
        id: 'env-monitor',
        title: '数智资源中心机房动环监控',
        subtitle: '机房动力环境运行状态实时监控',
        url: 'http://10.8.12.130/#/index',
        accent: '#3FE0A6',
        icon: 'env',
        scale: 0,
        autoFit: true,
        allowInsecureSsl: false,
        autoLogin: {
          enabled: true,
          username: 'show',
          password: 'wtzx@2026',
          usernameSelector: '',
          passwordSelector: '',
          submitSelector: '',
          successSelector: ''
        },
        rev: 1
      },
      {
        id: 'security-cockpit',
        title: '物探中心网络安全监控与自动化运维平台',
        subtitle: '网络安全态势监测与自动化运维驾驶舱',
        url: 'http://10.8.11.3/cockpit',
        accent: '#FFB020',
        icon: 'security',
        scale: 0,
        autoFit: true,
        allowInsecureSsl: false,
        autoLogin: {
          enabled: true,
          username: 'admin',
          password: 'admin',
          usernameSelector: '#username',
          passwordSelector: '#password',
          submitSelector: '#loginBtn',
          successSelector: ''
        },
        rev: 1
      }
    ],
    tombstones: []
  };
}

let data = null;
/** 反向代理实例，在 start() 里创建（需要 PORT 与 data.entries） */
let proxy = null;
/** 极速模式采集模块（惰性拉起 Chromium，首次有观看者才启动） */
let shot = null;
/** 多设备互控 · 控制通道（设备档案 / 心跳 / 指令 / 场景） */
let ctl = null;
/** 串行化写操作，避免并发请求基于同一份旧数据互相覆盖 */
let writeChain = Promise.resolve();

function loadData() {
  for (const file of [DATA_FILE, BACKUP_FILE]) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const normalized = normalizeData(parsed);
      if (normalized) {
        console.log(`[data] 已加载 ${file}（version=${normalized.version}, 条目=${normalized.entries.length}）`);
        return normalized;
      }
      console.warn(`[data] ${file} 结构不合法，尝试下一个来源`);
    } catch (e) {
      console.warn(`[data] ${file} 解析失败：${e.message}`);
    }
  }
  console.log('[data] 未找到可用数据文件，使用内置种子数据初始化');
  // 种子数据也走一遍归一化，保证 turbo 等新字段齐备
  return normalizeData(seedData()) || seedData();
}

/** 摄像头配置归一化：补齐默认值并裁剪脏数据 */
function normalizeCameras(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const merged = Object.assign({}, DEFAULT_CAMERAS, src);
  const titles = {};
  if (merged.titles && typeof merged.titles === 'object') {
    Object.keys(merged.titles).forEach((k) => {
      if (/^\d+$/.test(k)) titles[k] = String(merged.titles[k] || '').slice(0, 60);
    });
  }
  return {
    enabled: merged.enabled !== false,
    host: String(merged.host || '').trim(),
    port: Number(merged.port) || 554,
    username: String(merged.username || ''),
    password: String(merged.password || ''),
    count: Math.max(1, Math.min(16, Number(merged.count) || 8)),
    titles,
    logo: String(merged.logo || '').trim(),
    logoCell: Math.max(1, Number(merged.logoCell) || 5)
  };
}

/** 极速模式刷新率归一化：0.2~60 秒，一位小数粒度，非法回退默认 2 */
function normTurboInterval(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 2;
  const r = Math.round(n * 10) / 10;
  return Math.min(60, Math.max(0.2, r));
}

/** 极速模式 JPEG 质量归一化：50~95 整数，非法回退默认 75 */
function normTurboQuality(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 50 && n <= 95 ? n : 75;
}

/** 宽松归一化：补齐缺省字段并修正类型，避免脏数据导致服务不可用 */
function normalizeData(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return null;
  const entries = [];
  raw.entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    const type = e.type === 'camera' ? 'camera' : 'url';
    const url = String(e.url || '').trim();
    // 画面墙由客户端内置渲染，不需要网址；普通页面仍必须有网址
    if (!url && type !== 'camera') return;
    entries.push({
      id: ID_PATTERN.test(String(e.id || '')) ? String(e.id) : `entry-${i + 1}`,
      type,
      title: String(e.title || '未命名大屏'),
      subtitle: String(e.subtitle || ''),
      url,
      accent: COLOR_PATTERN.test(String(e.accent || '')) ? String(e.accent) : '#2FD2F5',
      icon: ALLOWED_ICONS.includes(e.icon) ? e.icon : 'default',
      scale: Number.isFinite(Number(e.scale)) ? Number(e.scale) : 0,
      autoFit: e.autoFit !== false,
      allowInsecureSsl: e.allowInsecureSsl === true,
      openOriginal: e.openOriginal === true,
      spaHistory: e.spaHistory === true,
      // 旧内核兼容（代理转发时才生效）：语法转译 + 运行时垫片
      compatTranspile: e.compatTranspile === true,
      compatTarget: transpile.isTarget(e.compatTarget) ? String(e.compatTarget).trim() : '',
      // 极速模式（截图展示）
      turboEnabled: e.turboEnabled !== false,
      turboIntervalSec: normTurboInterval(e.turboIntervalSec),
      turboQuality: normTurboQuality(e.turboQuality),
      ...(e.autoLogin && typeof e.autoLogin === 'object'
        ? {
            autoLogin: {
              enabled: e.autoLogin.enabled !== false,
              username: String(e.autoLogin.username || ''),
              password: String(e.autoLogin.password || ''),
              usernameSelector: String(e.autoLogin.usernameSelector || ''),
              passwordSelector: String(e.autoLogin.passwordSelector || ''),
              submitSelector: String(e.autoLogin.submitSelector || ''),
              successSelector: String(e.autoLogin.successSelector || '')
            }
          }
        : {}),
      rev: Number(e.rev) || 1
    });
  });
  const version = Math.max(1, Number(raw.version) || 1);
  return {
    version,
    epoch: Math.max(1, Number(raw.epoch) || 1),
    metaRev: Number(raw.metaRev) || version,
    orderRev: Number(raw.orderRev) || version,
    prunedBeforeRev: Number(raw.prunedBeforeRev) || 0,
    updatedAt: raw.updatedAt || new Date().toISOString(),
    appTitle: String(raw.appTitle || '数智中心大屏聚合平台'),
    appSubtitle: String(raw.appSubtitle || ''),
    exitConfirm: raw.exitConfirm !== false,
    exitTip: String(raw.exitTip || '按【返回】键将退出应用'),
    entries,
    cameras: normalizeCameras(raw.cameras),
    tombstones: Array.isArray(raw.tombstones)
      ? raw.tombstones
          .filter((t) => t && typeof t.id === 'string' && Number.isFinite(Number(t.rev)))
          .map((t) => ({ id: t.id, rev: Number(t.rev) }))
      : []
  };
}

/** 原子写盘：先写临时文件再 rename，并保留上一次的备份 */
function persist() {
  const tmp = `${DATA_FILE}.tmp-${process.pid}`;
  const text = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, text, 'utf8');
  if (fs.existsSync(DATA_FILE)) {
    try {
      fs.copyFileSync(DATA_FILE, BACKUP_FILE);
    } catch (e) {
      console.warn(`[data] 备份失败：${e.message}`);
    }
  }
  fs.renameSync(tmp, DATA_FILE);
}

/**
 * 串行执行一次「读-改-写」，回调里直接修改 data。
 * 每次写操作都会抬高全局 version 与 updatedAt。
 */
function mutate(fn) {
  const run = () => {
    const result = fn(data);
    data.version += 1;
    data.updatedAt = new Date().toISOString();
    if (data.tombstones.length > MAX_TOMBSTONES) {
      const sorted = data.tombstones.slice().sort((a, b) => a.rev - b.rev);
      const cut = sorted.length - MAX_TOMBSTONES;
      data.prunedBeforeRev = Math.max(data.prunedBeforeRev, sorted[cut - 1].rev);
      data.tombstones = sorted.slice(cut);
    }
    persist();
    return result;
  };
  const p = writeChain.then(run, run);
  // 保持链条不因单次异常中断
  writeChain = p.catch(() => {});
  return p;
}

/* ============================ 校验 ============================ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function requireString(v, name, { max = 500, allowEmpty = false } = {}) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s && !allowEmpty) throw bad(`${name} 不能为空`);
  if (s.length > max) throw bad(`${name} 长度不能超过 ${max}`);
  return s;
}

/** 校验并规范化一个入口；existingId 用于更新场景（允许沿用自身 id） */
function validateEntry(body, { existingId = null, existingType = null, takenIds = new Set() } = {}) {
  if (!body || typeof body !== 'object') throw bad('请求体必须是 JSON 对象');

  // 管理后台表单不含 type：更新已有入口时沿用原类型，避免把画面墙入口改回普通网页
  const fallbackType = ALLOWED_TYPES.includes(existingType) ? existingType : 'url';
  const type = ALLOWED_TYPES.includes(body.type) ? body.type : fallbackType;

  // 画面墙是客户端内置页面，不依赖外部网址；普通网页仍强制校验 URL
  let url = String(body.url || '').trim();
  if (type === 'camera') {
    url = '';
  } else {
    url = requireString(body.url, 'URL', { max: 2000 });
    if (!/^https?:\/\/.+/i.test(url)) throw bad('URL 必须以 http:// 或 https:// 开头');
  }

  let accent = String(body.accent || '#2FD2F5').trim();
  if (!COLOR_PATTERN.test(accent)) throw bad('主题色格式应为 #RRGGBB');

  const icon = ALLOWED_ICONS.includes(body.icon) ? body.icon : 'default';

  let scale = Number(body.scale);
  if (!Number.isFinite(scale)) scale = 0;
  scale = Math.round(scale);
  if (scale !== 0 && (scale < 50 || scale > 200)) throw bad('缩放需为 0（自动）或 50–200 之间');

  let id = existingId;
  if (!id) {
    const raw = String(body.id || '').trim().toLowerCase();
    id = raw || `entry-${crypto.randomBytes(3).toString('hex')}`;
    if (!ID_PATTERN.test(id)) throw bad('ID 只能包含小写字母、数字与短横线，且不超过 64 字符');
    if (takenIds.has(id)) throw bad(`ID「${id}」已存在`);
  }

  // 旧内核兼容：目标内核留空表示用默认值（chrome66）
  const compatTarget = String(body.compatTarget || '').trim();
  if (compatTarget && !transpile.isTarget(compatTarget)) {
    throw bad('转译目标内核格式应为 chrome66 / es2019 / safari13 这类标识');
  }

  // 极速模式（截图展示）参数：非法直接 400，不落库
  let turboIntervalSec = body.turboIntervalSec === undefined || body.turboIntervalSec === ''
    ? 2 : Number(body.turboIntervalSec);
  if (!Number.isFinite(turboIntervalSec)) throw bad('极速刷新率必须是数字（单位：秒）');
  if (Math.abs(Math.round(turboIntervalSec * 10) / 10 - turboIntervalSec) > 1e-9) {
    throw bad('极速刷新率最多支持一位小数（如 0.5、2、3.5）');
  }
  if (turboIntervalSec < 0.2 || turboIntervalSec > 60) throw bad('极速刷新率需在 0.2 ~ 60 秒之间');
  turboIntervalSec = Math.round(turboIntervalSec * 10) / 10;
  const turboQuality = body.turboQuality === undefined || body.turboQuality === ''
    ? 75 : Number(body.turboQuality);
  if (!Number.isInteger(turboQuality) || turboQuality < 50 || turboQuality > 95) {
    throw bad('极速 JPEG 质量需为 50 ~ 95 之间的整数');
  }

  const entry = {
    id,
    type,
    title: requireString(body.title, '标题', { max: 120 }),
    subtitle: String(body.subtitle || '').trim().slice(0, 200),
    url,
    accent,
    icon,
    scale,
    autoFit: body.autoFit !== false,
    allowInsecureSsl: body.allowInsecureSsl === true,
    openOriginal: body.openOriginal === true,
    spaHistory: body.spaHistory === true,
    compatTranspile: body.compatTranspile === true,
    compatTarget,
    // 极速模式（截图展示）：默认全部参与；camera 类型不参与（/shot 兜底 404）
    turboEnabled: body.turboEnabled !== false,
    turboIntervalSec,
    turboQuality
  };

  const al = body.autoLogin;
  if (al && typeof al === 'object' && (al.enabled === true || al.username || al.password)) {
    entry.autoLogin = {
      enabled: al.enabled !== false,
      username: String(al.username || '').trim().slice(0, 200),
      password: String(al.password || ''),
      usernameSelector: String(al.usernameSelector || '').trim().slice(0, 300),
      passwordSelector: String(al.passwordSelector || '').trim().slice(0, 300),
      submitSelector: String(al.submitSelector || '').trim().slice(0, 300),
      successSelector: String(al.successSelector || '').trim().slice(0, 300)
    };
    if (entry.autoLogin.enabled && !entry.autoLogin.password) {
      throw bad('启用自动登录时必须填写密码');
    }
  }
  return entry;
}

/* ============================ 增量协议 ============================ */

function etagOf(d) {
  return `"${d.epoch}-${d.version}"`;
}

/** 解析客户端持有的 epoch：优先取 epoch 查询参数，其次从 If-None-Match 的 ETag 中解析 */
function clientEpochOf(searchParams, ifNoneMatch) {
  const q = searchParams.get('epoch');
  if (q !== null && Number.isFinite(Number(q))) return Number(q);
  if (ifNoneMatch) {
    const head = String(ifNoneMatch).replace(/"/g, '').split('-')[0];
    if (Number.isFinite(Number(head))) return Number(head);
  }
  return null; // 客户端未提供，无法判断代次
}

/** 客户端拉取：全量 / 增量 / 304 */
function buildClientPayload(d, { since, ifNoneMatch, searchParams }) {
  const etag = etagOf(d);
  if (ifNoneMatch && ifNoneMatch === etag) {
    return { status: 304, etag };
  }

  const sinceNum = Number.isFinite(Number(since)) && Number(since) > 0 ? Number(since) : 0;
  const clientEpoch = clientEpochOf(searchParams, ifNoneMatch);
  const epochMismatch = clientEpoch !== null && clientEpoch !== d.epoch;

  // 首次拉取 / 删除痕迹已被裁剪 / 代次变化 / 版本超前（服务端被回滚过）→ 全量
  if (!sinceNum || sinceNum < d.prunedBeforeRev || epochMismatch || sinceNum > d.version) {
    return { status: 200, etag, body: { full: fullSnapshot(d), version: d.version, epoch: d.epoch } };
  }

  if (sinceNum === d.version) {
    return { status: 304, etag };
  }

  const body = { version: d.version, epoch: d.epoch, since: sinceNum };
  if (d.metaRev > sinceNum) {
    body.meta = fullMeta(d);
  }
  // 顺序变化必须显式下发：增量里新增/修改条目的位置无法表达“整体重排”，
  // 客户端仅凭 upserted 无法区分“改了一个字段”和“顺序变了”。
  if (d.orderRev > sinceNum) {
    body.order = d.entries.map((e) => e.id);
  }
  const upserted = d.entries.filter((e) => e.rev > sinceNum);
  const deletedIds = d.tombstones.filter((t) => t.rev > sinceNum).map((t) => t.id);
  if (upserted.length) body.upserted = upserted;
  if (deletedIds.length) body.deletedIds = deletedIds;
  return { status: 200, etag, body };
}

/** 全量快照：不含内部 bookkeeping 字段（rev/prunedBeforeRev） */
function fullSnapshot(d) {
  return {
    appTitle: d.appTitle,
    appSubtitle: d.appSubtitle,
    exitConfirm: d.exitConfirm,
    exitTip: d.exitTip,
    entries: d.entries.map((e) => {
      const copy = { ...e };
      delete copy.rev;
      return copy;
    }),
    cameras: { enabled: d.cameras.enabled, count: d.cameras.count, titles: d.cameras.titles }
  };
}

/* ============================ HTTP 工具 ============================ */

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(text);
}

function sendEmpty(res, status, extraHeaders = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...extraHeaders });
  res.end();
}

/**
 * 托管一个静态 HTML 页面（客户端 / 管理页 / 预览页）。
 * 三个页面都是构建或源码产物，文件缺失时给出可执行的补救命令，避免只看到 404。
 */
function serveHtmlFile(res, file, missingHint) {
  if (!fs.existsSync(file)) return sendJson(res, 500, { error: missingHint });
  const html = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': html.length,
    'Cache-Control': 'no-store'
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(bad('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,If-None-Match'
};

/* ============================ 路由 ============================ */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 反向代理必须用**未归一化**的原始 pathname（/cockpit/ 与 /cockpit 语义不同），
  // 所以要放在下面的尾斜杠归一化之前。
  if (proxy && proxy.isProxyPath(url.pathname)) return proxy.handle(req, res, url);

  // 极速模式（截图展示）：/shot/<id>/view|frame.jpg|meta.json|beat
  if (shot && shot.isShotPath(url.pathname)) return shot.handle(req, res, url);

  // 多设备互控 · 控制通道：/api/ctl/*
  if (ctl && ctl.isCtlPath(url.pathname)) return ctl.handle(req, res, url);

  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') return sendEmpty(res, 204, CORS);

  /* ---------- 电脑浏览器客户端页面（站点首页） ---------- */
  // 站点根路径即电脑端客户端（纯显示端）；/app、/client 为历史别名，保持可用
  if (p === '/' || p === '/index.html' || p === '/app' || p === '/client' ||
      p === '/app/index.html' || p === '/client/index.html') {
    return serveHtmlFile(res, CLIENT_FILE, '电脑端客户端页面缺失，请先执行 node tools/build-client.mjs');
  }

  /* ---------- 多设备互控 · 独立控制台（纯控制端，不注册受控） ---------- */
  if (p === '/console') {
    return serveHtmlFile(res, CONSOLE_FILE, '控制台页面缺失');
  }

  /* ---------- 管理（设置）页面 ---------- */
  // 专用路径 /setting；/admin 为历史别名
  if (p === '/setting' || p === '/setting/index.html' || p === '/admin' || p === '/admin/index.html') {
    return serveHtmlFile(res, ADMIN_FILE, '管理页面文件缺失');
  }

  /* ---------- 电视端预览页面 ---------- */
  if (p === '/preview' || p === '/preview.html') {
    return serveHtmlFile(res, PREVIEW_FILE, '预览页缺失，请先执行 node tools/build-preview.mjs');
  }

  /* ---------- 客户端接口 ---------- */
  if (p === '/api/version' && method === 'GET') {
    return sendJson(res, 200, { version: data.version, epoch: data.epoch }, { ...CORS, ETag: etagOf(data) });
  }

  if (p === '/api/config' && method === 'GET') {
    const full = url.searchParams.get('full');
    const since = url.searchParams.get('since');
    const inm = req.headers['if-none-match'];
    const result = full
      ? { status: 200, etag: etagOf(data), body: { full: fullSnapshot(data), version: data.version, epoch: data.epoch } }
      : buildClientPayload(data, { since, ifNoneMatch: inm, searchParams: url.searchParams });
    if (result.status === 304) return sendEmpty(res, 304, { ...CORS, ETag: result.etag });
    return sendJson(res, 200, result.body, { ...CORS, ETag: result.etag });
  }

  /* ---------- 摄像头画面墙（客户端按编号点播，服务端转码为 MJPEG） ---------- */
  if (p === '/api/cameras' && method === 'GET') {
    if (!data.cameras.enabled) return sendJson(res, 200, { enabled: false, cameras: [], cells: [] }, CORS);
    const list = await camera.listCameras();
    // cells 是画面墙 9 格的排布（编号 / 'logo' / null），客户端据此渲染浮层，
    // 与服务端按行合成的画面保持同一套顺序，避免两边各写一份规则
    return sendJson(res, 200, { enabled: true, cameras: list, cells: camera.wallCells() }, CORS);
  }

  if (p.startsWith('/cam/') && method === 'GET') {
    if (camera.handleStream(req, res, url)) return;
    return sendJson(res, 404, { error: '无效的摄像头地址' }, CORS);
  }

  /* ---------- 管理接口 ---------- */
  if (p === '/api/admin/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      version: data.version,
      epoch: data.epoch,
      entries: data.entries.length,
      tombstones: data.tombstones.length,
      updatedAt: data.updatedAt,
      uptimeSec: Math.round(process.uptime()),
      // 旧内核兼容转译能力（esbuild 是否装上、命中情况），便于现场诊断白屏
      transpile: transpile.status(),
      // 极速模式（截图采集）能力与活跃数
      shot: shot
        ? shot.status()
        : { available: false, reason: '未初始化', activeEntries: 0 },
      // 多设备互控：设备档案规模与在线数
      ctl: ctl ? ctl.status() : null
    }, { ...CORS, ETag: etagOf(data) });
  }

  if (p === '/api/admin/config' && method === 'GET') {
    return sendJson(res, 200, data, { ...CORS, ETag: etagOf(data) });
  }

  if (p === '/api/admin/meta' && method === 'PUT') {
    const body = await readBody(req);
    await mutate((d) => {
      if (body.appTitle !== undefined) d.appTitle = requireString(body.appTitle, '系统标题', { max: 60 });
      if (body.appSubtitle !== undefined) d.appSubtitle = String(body.appSubtitle || '').trim().slice(0, 80);
      if (body.exitConfirm !== undefined) d.exitConfirm = body.exitConfirm !== false;
      if (body.exitTip !== undefined) d.exitTip = String(body.exitTip || '').trim().slice(0, 80);
      d.metaRev = d.version + 1; // mutate 之后 version 会 +1，使 metaRev 恰好等于新版本
    });
    return sendJson(res, 200, { ok: true, version: data.version, meta: fullMeta(data) }, { ...CORS, ETag: etagOf(data) });
  }

  if (p === '/api/admin/entries' && method === 'POST') {
    const body = await readBody(req);
    const taken = new Set(data.entries.map((e) => e.id));
    const entry = validateEntry(body, { takenIds: taken });
    await mutate((d) => {
      entry.rev = d.version + 1;
      d.entries.push(entry);
    });
    return sendJson(res, 201, { ok: true, version: data.version, entry }, { ...CORS });
  }

  // 注意：reorder 必须放在 entries/:id 之前，否则会被通配路由当成 id="reorder"
  if (p === '/api/admin/entries/reorder' && method === 'POST') {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
    if (!ids || ids.length !== data.entries.length) throw bad('ids 必须包含全部入口 id');
    const current = new Set(data.entries.map((e) => e.id));
    if (ids.some((id) => !current.has(id)) || new Set(ids).size !== ids.length) {
      throw bad('ids 与现有入口不一致');
    }
    await mutate((d) => {
      d.entries.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      // 顺序本身也是数据：记 orderRev，客户端据此整体重排（无需重发全部条目）
      d.orderRev = d.version + 1;
    });
    return sendJson(res, 200, { ok: true, version: data.version, ids }, { ...CORS });
  }

  const entryMatch = p.match(/^\/api\/admin\/entries\/([^/]+)$/);
  if (entryMatch) {
    const id = decodeURIComponent(entryMatch[1]);
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx < 0) throw new HttpError(404, `入口「${id}」不存在`);

    if (method === 'PUT') {
      const body = await readBody(req);
      const entry = validateEntry(body, { existingId: id, existingType: data.entries[idx].type });
      await mutate((d) => {
        const i = d.entries.findIndex((e) => e.id === id);
        entry.rev = d.version + 1;
        d.entries[i] = entry;
      });
      return sendJson(res, 200, { ok: true, version: data.version, entry }, { ...CORS });
    }

    if (method === 'DELETE') {
      await mutate((d) => {
        const i = d.entries.findIndex((e) => e.id === id);
        d.entries.splice(i, 1);
        d.tombstones = d.tombstones.filter((t) => t.id !== id);
        d.tombstones.push({ id, rev: d.version + 1 });
      });
      return sendJson(res, 200, { ok: true, version: data.version, deleted: id }, { ...CORS });
    }
  }

  if (p === '/api/admin/epoch/bump' && method === 'POST') {
    await mutate((d) => { d.epoch += 1; });
    return sendJson(res, 200, { ok: true, version: data.version, epoch: data.epoch }, { ...CORS });
  }

  // 被代理页面用 location.href='/x' 跳转时前缀会丢失，这里按 Referer 兜底回带前缀的地址
  if (proxy && proxy.handleEscaped(req, res, url)) return undefined;

  throw new HttpError(404, `未找到接口 ${method} ${p}`);
}

function fullMeta(d) {
  return {
    appTitle: d.appTitle,
    appSubtitle: d.appSubtitle,
    exitConfirm: d.exitConfirm,
    exitTip: d.exitTip
  };
}

/* ============================ 启动 ============================ */

function start() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  data = loadData();
  // 首次启动即落盘，便于运维直接看到并备份数据文件
  if (!fs.existsSync(DATA_FILE)) persist();

  // 反向代理：目标只能由 data.entries 的 id 推导，禁止用 URL 参数指定目标（防 SSRF）
  proxy = createProxy({
    getEntries: () => data.entries,
    listenPort: PORT,
    log: (msg) => console.log(msg)
  });

  // 摄像头画面墙：RTSP 凭据只留在服务端，客户端仅按编号点播
  camera.configure(data.cameras);

  // 极速模式：可选依赖（playwright-core/Chromium），缺失时自动降级，不阻塞启动
  shot = createShot({
    getEntries: () => data.entries,
    dataDir: DATA_DIR,
    log: (msg) => console.log(msg)
  });
  shot.start();

  // 多设备互控 · 控制通道（零依赖，devices.json 独立于 config.json）
  ctl = createCtl({
    dataDir: DATA_DIR,
    getEntries: () => data.entries,
    // 心跳响应携带内容版本：客户端发现落后即立即强制同步（Web 保存后 ≤3 秒全场生效）
    getContentVersion: () => ({ version: data.version, epoch: data.epoch }),
    log: (msg) => console.log(msg)
  });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(`[error] ${req.method} ${req.url}`, err);
      if (res.headersSent) return res.end();
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
    console.log(`  数据文件   ${DATA_FILE}`);
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
}

start();
