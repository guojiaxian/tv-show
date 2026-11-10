/**
 * 页面改版探测（零依赖）
 * ---------------------------------------------------------------------------
 * 大屏页面在自己的系统里重新制作 / 发布后，URL 往往不变，客户端无法自行感知。
 * 这里由服务端周期性取一次入口页面，指纹变化即视为「页面已更新」，
 * 通过心跳 content.pages 下发给客户端（电视端据此自动重载当前页）。
 *
 * 指纹来源（按优先级）：
 *  1. 缓存校验头 ETag / Last-Modified —— 文件重新发布才会变，最可靠；
 *  2. 无校验头时取正文前 64KB 的哈希（SPA 的 index.html 通常静态、可用），
 *     并要求「连续两轮取到同一个新哈希」才确认改版：避免服务端渲染的
 *     实时数据每轮都变，被误判成改版而让大屏不停重载；
 *  3. 连续多轮持续变化（动态页面）→ 判定为不可靠，停止探测该页并记日志。
 *
 * 实现说明：用 node:http/https 而非 fetch —— 电视入口常配自签名证书
 * （allowInsecureSsl），fetch 无法按入口关闭证书校验。
 *
 * 探测开销：每页每周期只读响应头或前 64KB；单页超时 5 秒，串行执行，
 * 失败保留上一次指纹。周期默认 30 秒，可用 TVSHOW_PAGE_WATCH_SEC 覆盖（0 = 关闭）。
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const DEFAULT_INTERVAL_SEC = 30;
const MIN_INTERVAL_SEC = 5;
const PROBE_TIMEOUT_MS = 5000;
/** 无校验头时的正文取样上限 */
const MAX_BODY_BYTES = 64 * 1024;
/** 正文持续变化多少轮后判定为动态页面并停止探测 */
const MAX_UNSTABLE = 3;
const MAX_REDIRECTS = 3;

function sha1Short(input) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
}

/**
 * 请求一次页面：拿缓存校验头，或用前 64KB 正文算指纹。
 * 有校验头时立即断开，不下载正文。
 */
function probeOnce(entry, url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const isHttps = /^https:/i.test(url);
    const mod = isHttps ? https : http;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const req = mod.request(url, {
      method: 'GET',
      headers: {
        Range: `bytes=0-${MAX_BODY_BYTES - 1}`,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
      },
      // 入口勾选「忽略证书错误」时同样放宽（电视端直连用的就是该开关）
      rejectUnauthorized: entry.allowInsecureSsl !== true,
      timeout: PROBE_TIMEOUT_MS
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return done(reject, new Error('重定向次数过多'));
        let next;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch (e) {
          return done(reject, new Error('重定向地址无效'));
        }
        return probeOnce(entry, next, redirectsLeft - 1).then(
          (v) => done(resolve, v),
          (e) => done(reject, e)
        );
      }

      const etag = res.headers.etag || '';
      const lastModified = res.headers['last-modified'] || '';
      if (etag || lastModified) {
        res.destroy();
        return done(resolve, { mode: 'validator', stamp: sha1Short(`${entry.url}|${etag}|${lastModified}`) });
      }

      const chunks = [];
      let size = 0;
      const finish = () => {
        const buf = Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES);
        res.destroy();
        done(resolve, buf.length ? { mode: 'body', stamp: sha1Short(buf) } : null);
      };
      res.on('data', (c) => {
        if (size < MAX_BODY_BYTES) {
          chunks.push(c);
          size += c.length;
        }
        if (size >= MAX_BODY_BYTES) finish();
      });
      res.on('end', finish);
      res.on('error', (e) => done(reject, e));
    });

    req.on('timeout', () => req.destroy(new Error('探测超时')));
    req.on('error', (e) => done(reject, e));
    req.end();
  });
}

function createPageWatch({ getEntries, onChange, log = () => {}, intervalSec }) {
  const envSec = Number(process.env.TVSHOW_PAGE_WATCH_SEC);
  const configured = Number.isFinite(intervalSec) ? intervalSec : envSec;
  const interval = Number.isFinite(configured) && configured >= 0
    ? Math.max(configured === 0 ? 0 : MIN_INTERVAL_SEC, configured)
    : DEFAULT_INTERVAL_SEC;

  /** entryId -> { mode, stamp, pending, unstable, disabled }（内存态） */
  const states = new Map();
  let timer = null;
  let probing = false;
  let stopping = false;
  let lastProbeAt = 0;

  function watchable(entry) {
    return !!entry && entry.type !== 'camera' && /^https?:\/\//i.test(String(entry.url || ''));
  }

  function fire(entry, prev, next) {
    log(`[watch] ${entry.id} 页面已更新（${prev} → ${next}），通知客户端重载`);
    if (!onChange) return;
    // 回调可能触发极速采集页重载（数秒），不阻塞其余页面的探测
    try {
      const r = onChange(entry.id, entry);
      if (r && typeof r.catch === 'function') {
        r.catch((e) => log(`[watch] ${entry.id} 更新回调失败：${e.message}`));
      }
    } catch (e) {
      log(`[watch] ${entry.id} 更新回调失败：${e.message}`);
    }
  }

  /** 把一次探测结果计入状态机，指纹确认为变化时触发回调 */
  function applyProbe(entry, result) {
    let st = states.get(entry.id);
    if (!st) {
      st = { mode: null, stamp: null, pending: null, unstable: 0, disabled: false };
      states.set(entry.id, st);
    }
    if (st.disabled) return;

    if (result.mode === 'validator') {
      st.pending = null;
      st.unstable = 0;
      if (st.mode === 'validator' && st.stamp && st.stamp !== result.stamp) {
        fire(entry, st.stamp, result.stamp);
      }
      st.mode = 'validator';
      st.stamp = result.stamp;
      return;
    }

    // 正文取样：首轮只记基线；连续两轮同一新哈希才确认改版
    if (st.mode !== 'body' || !st.stamp) {
      st.mode = 'body';
      st.stamp = result.stamp;
      st.pending = null;
      st.unstable = 0;
      return;
    }
    if (st.stamp === result.stamp) {
      st.pending = null; // 回到原内容：上一次变化视为抖动
      return;
    }
    if (st.pending === result.stamp) {
      fire(entry, st.stamp, result.stamp);
      st.stamp = result.stamp;
      st.pending = null;
      st.unstable = 0;
      return;
    }
    if (st.pending) st.unstable += 1;
    st.pending = result.stamp;
    if (st.unstable >= MAX_UNSTABLE) {
      st.disabled = true;
      st.pending = null;
      log(`[watch] ${entry.id} 正文持续变化（疑似实时数据页面），停止探测以免大屏反复重载`);
    }
  }

  /** 探测一轮（串行，避免同时压目标站） */
  async function probeAll() {
    if (probing || stopping) return;
    probing = true;
    try {
      for (const entry of getEntries() || []) {
        if (stopping) break;
        if (!watchable(entry)) {
          states.delete(entry.id);
          continue;
        }
        try {
          const result = await probeOnce(entry, entry.url, MAX_REDIRECTS);
          if (result) applyProbe(entry, result);
        } catch (e) {
          // 目标站暂时不可达：保留上一次指纹，下一周期重试
          log(`[watch] ${entry.id} 探测失败：${e.message}`);
        }
      }
      // 入口被删除：丢弃状态，避免同名入口重新创建时误触发一次重载
      const alive = new Set((getEntries() || []).map((e) => e.id));
      for (const id of Array.from(states.keys())) if (!alive.has(id)) states.delete(id);
      lastProbeAt = Date.now();
    } finally {
      probing = false;
    }
  }

  /** 心跳下发用：{ entryId: 指纹 }（只含可用的页面） */
  function snapshot() {
    const out = {};
    for (const [id, st] of states) {
      if (!st.disabled && st.stamp) out[id] = st.stamp;
    }
    return out;
  }

  function status() {
    return { intervalSec: interval, watched: Object.keys(snapshot()).length, lastProbeAt: lastProbeAt || null };
  }

  function start() {
    if (timer || interval === 0) {
      if (interval === 0) log('[watch] 页面改版探测已关闭（TVSHOW_PAGE_WATCH_SEC=0）');
      return;
    }
    stopping = false;
    probeAll().catch(() => {});
    timer = setInterval(() => { probeAll().catch(() => {}); }, interval * 1000);
    if (timer.unref) timer.unref();
    log(`[watch] 页面改版探测已启动：每 ${interval} 秒一轮`);
  }

  function stop() {
    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, probeAll, snapshot, status };
}

module.exports = { createPageWatch };
