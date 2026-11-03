/**
 * 数据层：seedData / 归一化 / 加载 / 原子写盘 / 串行 mutate。
 * ---------------------------------------------------------------------------
 * 从 server.js 抽出；只负责 config.json 的读写与形态约束，不感知 HTTP。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const transpile = require('./transpile');

/* ---------- 与管理接口校验共用的字段约束 ---------- */

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_ICONS = ['storage', 'env', 'security', 'default'];

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
/** 保留的删除痕迹条数上限，超出后抬高 prunedBeforeRev 并裁剪 */
const MAX_TOMBSTONES = 200;

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

/**
 * 创建数据仓库：持有 data 与写链，提供 load / persist / mutate。
 * mutate 回调里直接修改 data；每次写操作抬高 version 与 updatedAt。
 */
function createStore({ dataDir }) {
  const dataFile = path.join(dataDir, 'config.json');
  const backupFile = `${dataFile}.bak`;

  let data = null;
  /** 串行化写操作，避免并发请求基于同一份旧数据互相覆盖 */
  let writeChain = Promise.resolve();

  function load() {
    for (const file of [dataFile, backupFile]) {
      if (!fs.existsSync(file)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const normalized = normalizeData(parsed);
        if (normalized) {
          console.log(`[data] 已加载 ${file}（version=${normalized.version}, 条目=${normalized.entries.length}）`);
          data = normalized;
          return data;
        }
        console.warn(`[data] ${file} 结构不合法，尝试下一个来源`);
      } catch (e) {
        console.warn(`[data] ${file} 解析失败：${e.message}`);
      }
    }
    console.log('[data] 未找到可用数据文件，使用内置种子数据初始化');
    // 种子数据也走一遍归一化，保证 turbo 等新字段齐备
    data = normalizeData(seedData()) || seedData();
    return data;
  }

  /** 原子写盘：先写临时文件再 rename，并保留上一次的备份（数据含明文口令，一律 0600） */
  function persist() {
    const tmp = `${dataFile}.tmp-${process.pid}`;
    const text = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    if (fs.existsSync(dataFile)) {
      try {
        fs.copyFileSync(dataFile, backupFile);
        fs.chmodSync(backupFile, 0o600);
      } catch (e) {
        console.warn(`[data] 备份失败：${e.message}`);
      }
    }
    fs.renameSync(tmp, dataFile);
    try {
      fs.chmodSync(dataFile, 0o600);
    } catch (e) {
      // 个别文件系统不支持 chmod；不影响读写
    }
  }

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

  return {
    dataDir,
    dataFile,
    backupFile,
    load,
    persist,
    mutate,
    get data() {
      return data;
    }
  };
}

module.exports = {
  createStore,
  seedData,
  normalizeData,
  ID_PATTERN,
  COLOR_PATTERN,
  ALLOWED_ICONS
};
