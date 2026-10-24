#!/usr/bin/env node
/**
 * 旧内核兼容转译（服务端，依赖 esbuild）
 * ---------------------------------------------------------------------------
 * 现场小米电视 WebView 内核为 Chrome 66，而部分内网大屏的前端构建产物含 ES2019+
 * 语法（公有类字段 `class A { x = 1 }`、`??` / `?.`）。旧内核解析这种脚本会直接抛
 * 语法错误 → 整页白屏。本模块在**代理转发 JS 时**把它转译成 Chrome 66 可执行的形式。
 *
 * 三条硬性约束（见 README「旧内核兼容转译」）：
 *   1) 任何失败一律回退原文，绝不返回 502/503 —— 转译只是「尽力而为」的增强，
 *      宁可个别语法不支持，也不能让页面连内容都拿不到。
 *   2) esbuild 是可选依赖：require 失败时 isAvailable() 为 false，代理退回原行为。
 *   3) 结果按「目标内核 + 原文内容」内容寻址缓存（内存 + 磁盘），同一份文件只转译一次。
 *      转译只与「内容 + 目标」有关、与 URL 无关，故缓存键不含入口/路径。
 *
 * 为什么按内容寻址而不是按「URL + ETag」：URL 可变、ETag 未必有，
 * 而内容是唯一的正确输入 —— 缓存永不失效、永不脏读。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 默认目标：现场电视 WebView 内核 */
const DEFAULT_TARGET = 'chrome66';

/** 磁盘缓存目录（可被环境变量覆盖，便于测试隔离） */
const CACHE_DIR = process.env.TVSHOW_TRANSPILE_CACHE || path.join(__dirname, '.cache', 'transpile');
/** 磁盘缓存上限，超出后按访问时间从旧到新淘汰 */
const MAX_DISK_BYTES = 256 * 1024 * 1024;
/** 进程内缓存上限：省掉同一份 3MB 文件的重复磁盘读与重复转译 */
const MAX_MEM_BYTES = 48 * 1024 * 1024;
/** 缓存文件头版本号 —— 格式变更时旧缓存自动失效 */
const CACHE_HEADER_VERSION = 'tv1';

let esbuild = null;
let loadError = '';
try {
  esbuild = require('esbuild');
} catch (e) {
  loadError = (e && e.message) ? e.message : String(e);
}

/** esbuild 认识的内核标识，如 chrome66 / es2019 / safari13 */
const TARGET_PATTERN = /^(chrome|edge|firefox|safari|ios|es)\d{2,4}(\.\d{1,3})*$/i;

function isTarget(value) {
  return typeof value === 'string' && TARGET_PATTERN.test(value.trim());
}

const stats = { hits: 0, misses: 0, failures: 0, outBytes: 0 };
let warnedFailure = false;
let pruneScheduled = false;
let log = () => {};

function setLogger(fn) {
  if (typeof fn === 'function') log = fn;
}

/** 进程内 LRU：Map 的插入顺序即访问顺序，命中时重新插入以挪到队尾 */
const mem = new Map();
let memBytes = 0;

function memGet(key) {
  const value = mem.get(key);
  if (value === undefined) return null;
  mem.delete(key);
  mem.set(key, value);
  return value;
}

function memPut(key, value) {
  if (value.length > MAX_MEM_BYTES) return;
  mem.set(key, value);
  memBytes += value.length;
  while (memBytes > MAX_MEM_BYTES && mem.size > 1) {
    const oldest = mem.keys().next().value;
    memBytes -= mem.get(oldest).length;
    mem.delete(oldest);
  }
}

const cacheFile = (key) => path.join(CACHE_DIR, key + '.js');

/**
 * 缓存文件 = 头行 + 产物。头行记录版本/目标/原文长度，用于识别截断与脏文件；
 * 校验不过就当作未命中并重算（自愈，不需要人工清缓存）。
 */
function diskGet(key, header) {
  let raw;
  try {
    raw = fs.readFileSync(cacheFile(key), 'utf8');
  } catch (e) {
    return null;
  }
  if (raw.indexOf(header) !== 0) {
    try { fs.unlinkSync(cacheFile(key)); } catch (e) { /* 忽略 */ }
    return null;
  }
  return raw.slice(header.length);
}

function diskPut(key, header, value) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file = cacheFile(key);
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, header + value, 'utf8');
    fs.renameSync(tmp, file);
    schedulePrune();
  } catch (e) {
    // 缓存写失败不影响功能，只是下次还要重算
    log('[transpile] 缓存写入失败：' + e.message);
  }
}

/** 缓存上限保护：超出后按 mtime 从旧到新删（后台执行，不阻塞请求） */
function schedulePrune() {
  if (pruneScheduled) return;
  pruneScheduled = true;
  setImmediate(() => {
    pruneScheduled = false;
    try {
      const items = fs.readdirSync(CACHE_DIR).filter((n) => n.endsWith('.js')).map((n) => {
        const st = fs.statSync(path.join(CACHE_DIR, n));
        return { n, size: st.size, mtime: st.mtimeMs };
      });
      let total = items.reduce((sum, it) => sum + it.size, 0);
      if (total <= MAX_DISK_BYTES) return;
      items.sort((a, b) => a.mtime - b.mtime);
      for (const it of items) {
        if (total <= MAX_DISK_BYTES * 0.75) break;
        try {
          fs.unlinkSync(path.join(CACHE_DIR, it.n));
          total -= it.size;
        } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 目录不存在等情况一律忽略 */ }
  });
}

/**
 * 把 JS 源码转译为目标内核可执行的形式。
 * @param {string} code 上游原文（已按 UTF-8 解出）
 * @param {string} [target] 形如 chrome66，非法/为空时用 DEFAULT_TARGET
 * @returns {string|null} null 表示「不可用或转译失败」，调用方必须回退原文
 */
function transform(code, target) {
  if (!esbuild) return null;
  if (typeof code !== 'string' || !code) return null;
  const tgt = isTarget(target) ? String(target).trim() : DEFAULT_TARGET;
  const key = crypto.createHash('sha256')
    .update(tgt).update('\u0000').update(code)
    .digest('hex').slice(0, 32);
  const header = '/*' + CACHE_HEADER_VERSION + '|' + tgt + '|' + code.length + '*/\n';

  const cached = memGet(key) || diskGet(key, header);
  if (cached) {
    stats.hits++;
    memPut(key, cached);
    return cached;
  }
  stats.misses++;

  let out;
  try {
    out = esbuild.transformSync(code, {
      target: tgt,
      // 上游产物多为已压缩的 bundle；minify 让「降级重排」后的体积基本持平
      minify: true,
      legalComments: 'none',
      charset: 'utf8',
      loader: 'js'
    }).code;
  } catch (e) {
    stats.failures++;
    if (!warnedFailure) {
      warnedFailure = true;
      log('[transpile] 转译失败，已回退原文（后续同类失败不再重复提示）：' + e.message);
    }
    return null;
  }
  if (typeof out !== 'string' || !out) {
    stats.failures++;
    return null;
  }

  stats.outBytes += out.length;
  memPut(key, out);
  diskPut(key, header, out);
  return out;
}

/** 供健康检查查看：转译能力是否可用、命中情况如何 */
function status() {
  return {
    available: !!esbuild,
    version: esbuild ? esbuild.version : '',
    reason: loadError,
    defaultTarget: DEFAULT_TARGET,
    cacheDir: CACHE_DIR,
    stats: Object.assign({}, stats)
  };
}

module.exports = {
  DEFAULT_TARGET,
  isAvailable: () => !!esbuild,
  isTarget,
  transform,
  status,
  setLogger
};
