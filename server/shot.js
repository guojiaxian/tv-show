#!/usr/bin/env node
/**
 * 极速模式采集模块（截图展示）
 * ---------------------------------------------------------------------------
 * 把"渲染"从电视搬到服务器：无头 Chromium 打开真实页面并周期性截图，
 * 播放端（电视 WebView / 电脑浏览器）只显示一张不断刷新的 JPEG。
 *
 *   GET  /shot/<id>/view       包装页 HTML（ES5，双缓冲淡入 + sendBeacon 心跳）
 *   GET  /shot/<id>/frame.jpg  最新帧（无帧 503）
 *   GET  /shot/<id>/meta.json  {status, ts, interval, quality, title}
 *   POST /shot/<id>/beat       心跳（204，body 仅含观看者会话 id）
 *
 * 设计要点（与《极速模式功能开发手册》一一对应）：
 *   - 一次采集、多方观看：每入口一个采集循环，周期/质量实时读后台配置，
 *     后台改了下一帧立即生效（无需重启）。
 *   - 状态机：STOPPED → STARTING → ACTIVE ⇄ COOLING(30s) → PAUSED(热保活30min)。
 *   - 可选依赖：playwright-core / Chromium 缺失时全部降级（包装页给出跳转真实
 *     页面的逃生通道），服务端本体照常启动 —— 沿用 esbuild 先例。
 *   - 登录：复用 entry.autoLogin，storageState 落盘会话缓存，冷启动免登录；
 *     敏感字段绝不出现在任何 /shot 响应中。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/* ============================ 常量 ============================ */

const VIEWER_TIMEOUT_MS = 12000;   // 近 12s 有心跳 = 有观看者
const COOLING_MS = 30000;          // 无人观看后保活 30s（防切页抖动）
const HOT_KEEP_MS = 30 * 60 * 1000;// PAUSED 热保活 30min（热启动 ≤3s）
const SHOT_TIMEOUT_MS = 5000;      // 单帧超时：跳帧，保留旧帧
const LOGIN_FAIL_RETRY_MS = 5 * 60 * 1000;   // 登录连续失败后每 5 分钟重试
const ERROR_RETRY_MS = 15000;                // 上游异常每 15s 重试
const REAP_INTERVAL_MS = 5000;     // 观看者回收扫描周期
const BEAT_INTERVAL_MS = 5000;     // 包装页心跳周期
const NAV_TIMEOUT_MS = 30000;      // 冷启动打开页面超时
const LOGIN_TIMEOUT_MS = 12000;    // 登录流程超时

/** 登录框自动识别兜底选择器（entry.autoLogin 未填 selector 时使用） */
const FALLBACK_USER_SEL = 'input[type=text], input[name*=user i], input[name*=account i], input[name*=name i], input[placeholder*=账号 i]';
const FALLBACK_PWD_SEL = 'input[type=password]';
const FALLBACK_SUBMIT_SEL = 'button[type=submit], input[type=submit], button:has-text("登录"), button:has-text("登 录")';

/* ============================ 可选依赖 ============================ */

let pw = null;
let pwLoadError = '';
try {
  pw = require('playwright-core');
} catch (e) {
  pwLoadError = '未安装 playwright-core（server 目录执行 npm install）';
}

/* ============================ 工具 ============================ */

function normIntervalSec(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 2;
  return Math.min(60, Math.max(0.2, Math.round(n * 10) / 10));
}

function normQuality(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 50 && n <= 95 ? n : 75;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function clockOf(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/* ============================ 包装页（ES5） ============================ */

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 降级包装页：Chromium 不可用 / 页面未参与时给出说明与逃生通道 */
function fallbackHtml(entry, reason) {
  const title = escHtml(entry ? entry.title : '未知页面');
  const url = escHtml(entry ? entry.url : '');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=1920"><title>极速模式不可用</title>' +
    '<style>html,body{margin:0;height:100%;background:#0a1220;color:#e8f1ff;' +
    'font-family:"Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center}' +
    '.box{text-align:center}.box h1{font-size:34px;margin:0 0 14px}.box p{font-size:18px;color:#8fa6c4;margin:6px 0}' +
    '.box a{display:inline-block;margin-top:22px;font-size:20px;color:#2fd2f5;text-decoration:none;' +
    'border:1px solid #2fd2f5;border-radius:8px;padding:10px 26px}</style></head><body>' +
    '<div class="box"><h1>极速模式暂不可用</h1>' +
    '<p>' + escHtml(reason || '服务器暂未启用截图采集') + '</p>' +
    '<p>页面：' + title + '</p>' +
    (url ? '<a href="' + url + '">打开真实页面</a>' : '') +
    '</div></body></html>';
}

/** 正式包装页：双缓冲淡入 + 心跳 + 左下角信息浮层。刷新率由服务端内联注入。 */
function viewHtml(entry, intervalSec) {
  const id = escHtml(entry.id);
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=1920,initial-scale=1">' +
    '<title>' + escHtml(entry.title) + '</title>' +
    '<style>' +
    'html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}' +
    'img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:fill;opacity:0}' +
    '#ov{position:absolute;left:14px;bottom:12px;z-index:9;color:#fff;font:15px/1.5 ' +
    '"Microsoft YaHei",sans-serif;background:rgba(8,16,32,.55);border-radius:8px;' +
    'padding:6px 12px;pointer-events:none;opacity:1;transition:opacity .4s linear}' +
    '#ov.hide{opacity:0}' +
    '#ov .warn{color:#ffb020}' +
    '</style></head><body>' +
    '<img id="fa" alt=""><img id="fb" alt="">' +
    '<div id="ov"><span id="clock">--:--:--</span> &nbsp;<span id="mark">极速模式</span></div>' +
    '<script>' +
    '(function(){' +
    'var ENTRY="' + id + '";' +
    'var INTERVAL=' + intervalSec + ';' +
    'var BASE="/shot/"+ENTRY;' +
    /* ---- 会话 id：sessionStorage 保证同一标签页一个身份 ---- */
    'var sid="";' +
    'try{sid=sessionStorage.getItem("shot-sid")||""}catch(e){}' +
    'if(!sid){var c="0123456789abcdef";for(var i=0;i<16;i++)sid+=c.charAt(Math.floor(Math.random()*16));' +
    'try{sessionStorage.setItem("shot-sid",sid)}catch(e){}}' +
    'function beat(){try{navigator.sendBeacon(BASE+"/beat",sid)}catch(e){}}' +
    'beat();setInterval(beat,' + BEAT_INTERVAL_MS + ');' +
    'window.addEventListener("pagehide",beat);window.addEventListener("beforeunload",beat);' +
    /* ---- 信息浮层：正常播放 3s 后自动隐藏；异常状态（准备中/同步中/异常/登录失效）常驻 ---- */
    'var ov=document.getElementById("ov"),ovTimer=0;' +
    'var clock=document.getElementById("clock"),mark=document.getElementById("mark");' +
    'var STATUS_TXT={starting:"准备中",paused:"画面同步中",error:"采集异常",login_failed:"登录失效"};' +
    'function setMark(s,interval){' +
    'var txt="极速模式 · "+(interval||INTERVAL)+"s";' +
    'if(STATUS_TXT[s]){mark.innerHTML=txt;mark.className="warn";ov.className="";' +
    'if(s==="error"||s==="login_failed")mark.innerHTML=txt+" &nbsp;菜单 返回真实页面";' +
    'clearTimeout(ovTimer);ovTimer=0}' +
    'else{mark.innerHTML=txt;mark.className="";' +
    /* 恢复正常后浮层停留 3s 再淡出；已隐藏时不再重置计时（meta 5s 轮询会反复走到这里） */
    'if(ov.className!=="hide"&&!ovTimer)' +
    'ovTimer=setTimeout(function(){ov.className="hide";ovTimer=0},3000)}' +
    '}' +
    'setMark("starting",INTERVAL);' +
    'function onMeta(ok,txt){' +
    'if(!ok)return;' +
    'try{var m=JSON.parse(txt);' +
    'if(m.ts)clock.innerHTML=clockOf(m.ts);' +
    'if(m.interval)INTERVAL=m.interval;' +
    'setMark(m.status,m.interval);' +
    '}catch(e){}}' +
    'function clockOf(ts){var d=new Date(ts);' +
    'function p(n){return n<10?"0"+n:""+n}' +
    'return p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds())}' +
    'function pollMeta(){' +
    'var x=new XMLHttpRequest();' +
    'x.open("GET",BASE+"/meta.json?t="+(new Date()).getTime(),true);' +
    'x.onreadystatechange=function(){if(x.readyState===4)onMeta(x.status===200,x.responseText)};' +
    'x.send();}' +
    'setInterval(pollMeta,' + BEAT_INTERVAL_MS + ');pollMeta();' +
    /* ---- 双缓冲拉帧：解码完成后瞬时硬切（无任何透明度过渡）。
           动画内容下任何淡入/淡出都会产生新旧帧叠影，看起来像往回跳帧；
           旧帧始终不透明垫底，硬切瞬间无底色外露 ---- */
    'var imgs=[document.getElementById("fa"),document.getElementById("fb")];' +
    'var cur=0,fails=0,slow=false;' +
    'function schedule(){var ms=slow?INTERVAL*3000:INTERVAL*1000;setTimeout(nextFrame,ms)}' +
    'function nextFrame(){' +
    'var el=imgs[1-cur];' +
    /* 复用前先归零透明度并抬到顶层：旧帧（不透明）垫底，归零瞬间视觉无变化 */
    'el.style.opacity="0";el.style.zIndex="3";imgs[cur].style.zIndex="2";' +
    'var url=BASE+"/frame.jpg?t="+(new Date()).getTime()+"."+Math.random();' +
    'el.onload=function(){' +
    'fails=0;' +
    'if(slow){slow=false;setMark("active",INTERVAL)}' +
    'el.style.opacity="1";' +
    'cur=1-cur;' +
    'schedule();};' +
    'el.onerror=function(){' +
    'fails++;' +
    'if(fails>=3&&!slow){slow=true;setMark("paused",INTERVAL)}' +
    'schedule();};' +
    'el.src=url;}' +
    'nextFrame();' +
    '})();' +
    '</script></body></html>';
}

/* ============================ 模块 ============================ */

/**
 * @param {object} opts
 *   getEntries: () => entry[]（server.js 的 data.entries，实时读取）
 *   dataDir:    数据目录（会话缓存写在其下的 shot-cache/）
 *   log:        日志函数
 */
function createShot({ getEntries, dataDir, log }) {
  const CACHE_DIR = path.join(dataDir, 'shot-cache');
  const logOf = log || ((m) => console.log(m));

  const states = new Map();   // id -> 采集状态
  let browser = null;
  let browserBroken = '';
  let launchPromise = null;
  let reapTimer = null;
  /** 服务端退出中：停止一切新一轮采集/重连调度 */
  let stopping = false;

  /* ---------- 入口查找 ---------- */

  function entryById(id) {
    const list = getEntries ? getEntries() : [];
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function stateOf(id) {
    let st = states.get(id);
    if (!st) {
      st = {
        id,
        status: 'stopped',      // stopped|starting|active|cooling|paused|login_failed|error
        viewers: new Map(),     // sessionId -> lastBeatTs
        ctx: null,
        page: null,
        frame: null,
        frameTs: 0,
        timer: null,
        coolingSince: 0,
        pausedSince: 0,
        loginFails: 0,
        retryAfter: 0           // 异常重试延时（ms），正常时 0
      };
      states.set(id, st);
    }
    return st;
  }

  /* ---------- 浏览器管理 ---------- */

  async function ensureBrowser() {
    if (browser && browser.isConnected()) return browser;
    if (!pw) throw new Error(pwLoadError || 'playwright-core 不可用');
    if (launchPromise) return launchPromise;
    launchPromise = pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }).then((b) => {
      browser = b;
      browserBroken = '';
      b.on('disconnected', () => {
        browser = null;
        launchPromise = null;
      });
      logOf('[shot] Chromium 已启动');
      return b;
    }).catch((e) => {
      launchPromise = null;
      browserBroken = 'Chromium 启动失败：' + e.message;
      throw e;
    });
    return launchPromise;
  }

  /* ---------- 登录 ---------- */

  function stateFileOf(id) { return path.join(CACHE_DIR, id, 'state.json'); }

  /** 轻量登录态检测：URL 含 login 或可见密码框即视为掉线 */
  async function isLoggedOut(st, entry) {
    const page = st.page;
    if (!page) return true;
    const url = (() => { try { return page.url() || ''; } catch (e) { return ''; } })();
    if (/login/i.test(url)) return true;
    if (!entry.autoLogin || !entry.autoLogin.enabled) return false;
    try {
      return await page.isVisible(FALLBACK_PWD_SEL);
    } catch (e) {
      return false;
    }
  }

  /** 在无头页里执行「填账号 → 填密码 → 提交」；成功后保存会话 */
  async function doLogin(st, entry) {
    const al = entry.autoLogin;
    const page = st.page;
    const t0 = Date.now();
    logOf(`[shot] ${entry.id} 开始自动登录`);
    await page.bringToFront().catch(() => {});
    const userSel = al.usernameSelector || FALLBACK_USER_SEL;
    const pwdSel = al.passwordSelector || FALLBACK_PWD_SEL;
    await page.fill(userSel, al.username, { timeout: LOGIN_TIMEOUT_MS });
    await page.fill(pwdSel, al.password, { timeout: LOGIN_TIMEOUT_MS });
    if (al.submitSelector) {
      await page.click(al.submitSelector, { timeout: LOGIN_TIMEOUT_MS });
    } else {
      const btn = await page.$(FALLBACK_SUBMIT_SEL).catch(() => null);
      if (btn) await btn.click({ timeout: LOGIN_TIMEOUT_MS }).catch(() => {});
      else await page.press(pwdSel, 'Enter').catch(() => {});
    }
    // 成功判定：显式 successSelector，否则等密码框消失（登录页被跳走）
    if (al.successSelector) {
      await page.waitForSelector(al.successSelector, { timeout: LOGIN_TIMEOUT_MS });
    } else {
      await page.waitForFunction(function () {
        var p = document.querySelector('input[type=password]');
        return !p || p.offsetParent === null;
      }, { timeout: LOGIN_TIMEOUT_MS, polling: 500 });
    }
    st.loginFails = 0;
    logOf(`[shot] ${entry.id} 登录成功（${Date.now() - t0}ms），保存会话`);
    try {
      const stateDir = path.dirname(stateFileOf(entry.id));
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      // 会话目录/文件含站点 Cookie / Bearer Token，仅属主可访问
      try { fs.chmodSync(stateDir, 0o700); } catch (e) { /* 忽略 */ }
      await st.ctx.storageState({ path: stateFileOf(entry.id) });
      try { fs.chmodSync(stateFileOf(entry.id), 0o600); } catch (e) { /* 忽略 */ }
    } catch (e) {
      logOf(`[shot] ${entry.id} 会话保存失败：${e.message}`);
    }
  }

  /* ---------- 采集生命周期 ---------- */

  async function stopEntry(st, closeCtx) {
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    if (closeCtx !== false && st.ctx) {
      try { await st.ctx.close(); } catch (e) { /* 忽略 */ }
      st.ctx = null;
      st.page = null;
    }
    st.status = 'stopped';
    st.retryAfter = 0;
    st.loginFails = 0;
  }

  /** 单帧：轻量登录检测 → 截图 → 落内存。异常分类抛出。 */
  async function takeShot(st, entry) {
    const buf = await Promise.race([
      st.page.screenshot({ type: 'jpeg', quality: normQuality(entry.turboQuality), animations: 'disabled' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('截图超时')), SHOT_TIMEOUT_MS))
    ]);
    st.frame = buf;
    st.frameTs = Date.now();
  }

  /** 采集主循环：完成一帧后按「上帧完成时刻 + 间隔」调度下一帧，天然跳帧不积压 */
  async function cycle(st) {
    if (stopping) return;
    if (st.status !== 'active' && st.status !== 'cooling' && st.status !== 'error' && st.status !== 'login_failed') return;
    const entry = entryById(st.id);
    // 入口被删 / 改成画面墙 / 后台关掉极速 → 停止采集
    if (!entry || entry.type === 'camera' || entry.turboEnabled === false) {
      await stopEntry(st);
      return;
    }
    const t0 = Date.now();
    let failed = false;
    try {
      if (await isLoggedOut(st, entry)) {
        if (!entry.autoLogin || !entry.autoLogin.enabled) throw Object.assign(new Error('页面需要登录但未配置自动登录'), { login: true });
        st.loginFails += 1;
        if (st.loginFails > 3) {
          st.status = 'login_failed';
          st.retryAfter = LOGIN_FAIL_RETRY_MS;
          return scheduleNext(st, entry);
        }
        await doLogin(st, entry);
      }
      await takeShot(st, entry);
      if (st.status !== 'active' && st.status !== 'cooling') return; // 期间被切走
      st.status = st.status === 'cooling' ? 'cooling' : 'active';
      st.retryAfter = 0;
      st.loginFails = 0;
    } catch (e) {
      failed = true;
      // 进入异常态时记录起点：reap() 依赖 coolingSince 判断「无人观看已持续多久」。
      // 缺这一步时，从未进入过 cooling 的入口会以 15s 周期无限重试，无人观看也不休眠。
      st.coolingSince = Date.now();
      if (e && e.login) {
        st.status = 'login_failed';
        st.retryAfter = LOGIN_FAIL_RETRY_MS;
      } else {
        st.status = 'error';
        st.retryAfter = ERROR_RETRY_MS;
        logOf(`[shot] ${st.id} 采集异常：${e.message}`);
      }
    }
    void failed;
    return scheduleNext(st, entry, t0);
  }

  function scheduleNext(st, entry, t0) {
    if (stopping || st.status === 'stopped' || st.status === 'starting' || st.status === 'paused') return;
    const elapsed = t0 ? Date.now() - t0 : 0;
    const wait = st.retryAfter || normIntervalSec(entry.turboIntervalSec) * 1000;
    st.timer = setTimeout(() => { st.timer = null; cycle(st).catch(() => {}); }, Math.max(wait - elapsed, 100));
  }

  /** 冷/热启动一个入口的采集 */
  async function startEntry(st, entry) {
    if (stopping) return;
    st.status = 'starting';
    try {
      const b = await ensureBrowser();
      if (!st.ctx || !st.page) {
        const useStorage = fs.existsSync(stateFileOf(entry.id)) ? stateFileOf(entry.id) : undefined;
        st.ctx = await b.newContext({
          viewport: { width: 1920, height: 1080 },
          deviceScaleFactor: 1,
          ignoreHTTPSErrors: entry.allowInsecureSsl === true,
          storageState: useStorage
        });
        st.page = await st.ctx.newPage();
      }
      const cur = (() => { try { return st.page.url() || 'about:blank'; } catch (e) { return 'about:blank'; } })();
      if (cur === 'about:blank' || /login/i.test(cur)) {
        await st.page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      }
      if (entry.autoLogin && entry.autoLogin.enabled && await isLoggedOut(st, entry)) {
        st.loginFails += 1;
        await doLogin(st, entry);
      }
      // 首帧前给图表一点渲染时间（登录跳转/首屏数据）
      await st.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await takeShot(st, entry);
      st.status = 'active';
      st.retryAfter = 0;
      st.loginFails = 0;
      logOf(`[shot] ${entry.id} 采集已启动（间隔 ${normIntervalSec(entry.turboIntervalSec)}s / 质量 ${normQuality(entry.turboQuality)}）`);
      scheduleNext(st, entry, Date.now());
    } catch (e) {
      // 同 cycle()：异常态需要 coolingSince 作为无人观看的计时起点
      st.coolingSince = Date.now();
      if (e && (e.login || /登录/.test(String(e.message)))) {
        st.status = 'login_failed';
        st.retryAfter = LOGIN_FAIL_RETRY_MS;
      } else {
        st.status = 'error';
        st.retryAfter = ERROR_RETRY_MS;
        logOf(`[shot] ${entry.id} 启动失败：${e.message}`);
        // 页面坏了（比如 browser 崩溃重建后句柄失效）→ 下次重建
        if (st.ctx) { try { await st.ctx.close(); } catch (e2) { /* 忽略 */ } st.ctx = null; st.page = null; }
      }
      scheduleNext(st, entry, Date.now());
    }
  }

  /** 有观看者出现：按当前状态决定冷启动 / 热恢复 */
  function touchEntry(id) {
    if (!pw || stopping) return;
    const entry = entryById(id);
    if (!entry || entry.type === 'camera' || entry.turboEnabled === false) return;
    const st = stateOf(id);
    if (st.status === 'stopped') {
      startEntry(st, entry).catch(() => {});
    } else if (st.status === 'paused') {
      st.status = 'starting';
      st.pausedSince = 0;
      startEntry(st, entry).catch(() => {}); // 页面仍在，热启动：直接补一帧
    }
    // starting / active / cooling / error / login_failed：循环自会继续
  }

  /** 心跳登记 */
  function beat(id, sid) {
    const st = states.get(id);
    if (!st) return;
    if (sid && String(sid).length <= 128) st.viewers.set(String(sid), Date.now());
    if (st.status === 'paused' || st.status === 'stopped') touchEntry(id);
  }

  /* ---------- 回收扫描 ---------- */

  function reap() {
    const now = Date.now();
    states.forEach(async (st, id) => {
      st.viewers.forEach((ts, sid) => { if (now - ts > VIEWER_TIMEOUT_MS) st.viewers.delete(sid); });
      const hasViewer = st.viewers.size > 0;
      if (!hasViewer) {
        if (st.status === 'active') {
          st.status = 'cooling';
          st.coolingSince = now;
        } else if (st.status === 'cooling' && now - st.coolingSince > COOLING_MS) {
          // 停止截图，但保留标签与会话（热保活）
          if (st.timer) { clearTimeout(st.timer); st.timer = null; }
          st.status = 'paused';
          st.pausedSince = now;
          st.retryAfter = 0;
          logOf(`[shot] ${id} 无人观看，转入热保活（${HOT_KEEP_MS / 60000}min）`);
        } else if (st.status === 'paused' && now - st.pausedSince > HOT_KEEP_MS) {
          logOf(`[shot] ${id} 热保活期满，关闭标签`);
          stopEntry(st);
        } else if ((st.status === 'error' || st.status === 'login_failed') && now - st.coolingSince > COOLING_MS && st.coolingSince) {
          if (st.timer) { clearTimeout(st.timer); st.timer = null; }
          if (now - (st.pausedSince || now) > HOT_KEEP_MS) stopEntry(st);
          else { st.status = 'paused'; st.pausedSince = st.pausedSince || now; }
        }
      } else if (st.status === 'cooling') {
        st.status = 'active';
        st.coolingSince = 0;
      }
    });
  }

  /* ---------- HTTP ---------- */

  const PATH_RE = /^\/shot\/([a-z0-9][a-z0-9-]{0,63})(\/view|\/frame\.jpg|\/meta\.json|\/beat)$/;

  function isShotPath(pathname) {
    return PATH_RE.test(String(pathname || ''));
  }

  function metaOf(st, entry) {
    const statusMap = { active: 'active', cooling: 'active', starting: 'starting', paused: 'paused', login_failed: 'login_failed' };
    return {
      status: st ? (statusMap[st.status] || 'error') : 'stopped',
      ts: st ? st.frameTs : 0,
      interval: entry ? normIntervalSec(entry.turboIntervalSec) : 2,
      quality: entry ? normQuality(entry.turboQuality) : 75,
      title: entry ? entry.title : ''
    };
  }

  function sendText(res, status, text, type) {
    const body = Buffer.from(text, 'utf8');
    res.writeHead(status, {
      'Content-Type': type || 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }

  async function handle(req, res, url) {
    const m = String(url.pathname || '').match(PATH_RE);
    const noStore = { 'Cache-Control': 'no-store' };
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', ...noStore });
      return res.end(JSON.stringify({ error: '无效的极速模式地址' }));
    }
    const id = m[1];
    const action = m[2];
    const entry = entryById(id);
    // 未知入口 / 画面墙 / 后台明确退出的页面：一律 404（服务端兜底）
    if (!entry || entry.type === 'camera' || entry.turboEnabled === false) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', ...noStore });
      return res.end(JSON.stringify({ error: '该页面不参与极速模式' }));
    }

    if (action === '/view' && req.method === 'GET') {
      if (!pw) return sendText(res, 200, fallbackHtml(entry, pwLoadError || '服务器未安装 Chromium，极速模式降级'));
      touchEntry(id);
      return sendText(res, 200, viewHtml(entry, normIntervalSec(entry.turboIntervalSec)));
    }

    if (action === '/beat' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 512) req.destroy(); });
      req.on('end', () => { beat(id, body.trim()); });
      res.writeHead(204, noStore);
      return res.end();
    }

    const st = states.get(id);
    if (action === '/meta.json' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...noStore });
      return res.end(JSON.stringify(metaOf(st, entry)));
    }

    if (action === '/frame.jpg' && req.method === 'GET') {
      if (!st || !st.frame) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', ...noStore });
        return res.end('preparing');
      }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': st.frame.length, ...noStore });
      return res.end(st.frame);
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', ...noStore });
    res.end(JSON.stringify({ error: '无效的极速模式地址' }));
  }

  /* ---------- health ---------- */

  function status() {
    let active = 0;
    states.forEach((st) => {
      if (['starting', 'active', 'cooling', 'error', 'login_failed'].includes(st.status)) active++;
    });
    if (!pw) return { available: false, reason: pwLoadError, activeEntries: 0 };
    return { available: !browserBroken, reason: browserBroken, activeEntries: active };
  }

  function start() {
    if (reapTimer) return;
    stopping = false;
    reapTimer = setInterval(reap, REAP_INTERVAL_MS);
    if (reapTimer.unref) reapTimer.unref();
  }

  /**
   * 停止全部采集并关闭浏览器（服务端优雅退出用）。
   * 与 start() 互斥：置 stopping 后不再接受新的采集/重连调度。
   */
  async function stop() {
    stopping = true;
    if (reapTimer) { clearInterval(reapTimer); reapTimer = null; }
    const closers = [];
    for (const st of states.values()) {
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      st.status = 'stopped';
      st.viewers.clear();
      if (st.ctx) {
        const ctx = st.ctx;
        st.ctx = null;
        st.page = null;
        closers.push(ctx.close().catch(() => {}));
      }
    }
    states.clear();
    if (browser) {
      const b = browser;
      browser = null;
      launchPromise = null;
      closers.push(b.close().catch(() => {}));
    }
    await Promise.allSettled(closers);
  }

  return { isShotPath, handle, status, start, stop };
}

module.exports = { createShot };
