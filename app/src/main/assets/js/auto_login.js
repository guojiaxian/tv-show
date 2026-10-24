/* ==========================================================================
 * auto_login.js —— 大屏页面账号密码自动填充登录
 * --------------------------------------------------------------------------
 * 由 WebDisplayActivity 在页面加载完成后注入。
 * 配置来源：window.__TV_AUTOLOGIN__
 *   {
 *     enabled:          true,
 *     username:         'show',
 *     password:         'wtzx@2026',
 *     usernameSelector: '',    // 可选，精确选择器，留空则自动识别
 *     passwordSelector: '',    // 可选，留空则匹配 input[type=password]
 *     submitSelector:   '',    // 可选，留空则自动识别登录按钮
 *     successSelector:  '',    // 可选，命中则认为已登录，无需填充
 *     maxAttempts:      3,     // 可选，单次页面加载内最多提交几次
 *     maxTotalAttempts: 3      // 可选，跨页面重载累计最多提交几次（防无限重复登录）
 *   }
 * 兼容：原生 form 提交、Vue/React 受控组件（使用原生 value setter + input 事件）
 * ========================================================================== */
(function () {
  'use strict';

  var cfg = window.__TV_AUTOLOGIN__;
  if (!cfg || cfg.enabled === false) return;
  if (!cfg.password) return;
  if (window.__TV_AUTOLOGIN_DONE__) return;
  window.__TV_AUTOLOGIN_DONE__ = true;

  var INTERVAL = cfg.interval || 700;
  var MAX_WAIT_TICKS = Math.ceil((cfg.maxWaitMs || 45000) / INTERVAL);
  var MAX_FILL_ATTEMPTS = cfg.maxAttempts || 3;
  var RETRY_DELAY_TICKS = Math.ceil(5000 / INTERVAL);
  /**
   * 跨「页面重载」累计的提交上限。
   * 站点登录成功后通常整页跳转，页面重载会把本脚本的完成标记清零；
   * 若凭据无效或被拒，就会变成「重载 → 再提交 → 再重载」的无限重复登录。
   * 次数记在 sessionStorage（同源页面重载后仍在），命中上限即彻底停手。
   */
  var MAX_TOTAL_ATTEMPTS = cfg.maxTotalAttempts || 3;
  /** 提交后允许的最长挂起时间：期间页面一直显示「登录中…」则判定卡死并放弃 */
  var MAX_PENDING_TICKS = Math.ceil((cfg.maxPendingMs || 25000) / INTERVAL);
  /** 页面一直不出现密码框时，多长时间后判定「当前不是登录页」 */
  var SETTLE_TICKS = Math.ceil(20000 / INTERVAL);
  /** 「登录请求在途」的文案特征：命中期间绝不重复点击，否则会打断在途请求 */
  var PENDING_RE = /(登\s*录\s*中|登\s*陆\s*中|登\s*入\s*中|提\s*交\s*中|验\s*证\s*中|加\s*载\s*中|请\s*稍\s*候|signing|logging|loading|please\s*wait)/i;
  var STORE_KEY = '__tv_autologin_attempts__:' + location.host + location.pathname + ':' + cfg.username;

  var ticks = 0;
  var fillAttempts = 0;
  var lastFillTick = -999;
  var submitted = false;
  var finished = false;
  var seenPassword = false;
  var pendingSince = 0;
  var timer = null;

  /* ---------------- 基础工具 ---------------- */

  function log() {
    try {
      if (window.console && console.log) {
        console.log.apply(console, ['[TVAutoLogin]'].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) { /* 忽略 */ }
  }

  function query(selector, root) {
    if (!selector) return null;
    try {
      return (root || document).querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    var cs = window.getComputedStyle(el);
    if (!cs) return false;
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05;
  }

  /* ---------------- 表单填充（兼容受控组件） ---------------- */

  function setValue(el, value) {
    try {
      var proto = Object.getPrototypeOf(el);
      var desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
                 Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (desc && desc.set) {
        desc.set.call(el, value);
      } else {
        el.value = value;
      }
    } catch (e) {
      el.value = value;
    }
    // 触发框架（Vue/React）的双向绑定
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a', keyCode: 65 }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    } catch (e2) { /* 忽略 */ }
  }

  function textOf(el) {
    return ((el.textContent || '') + ' ' + (el.value || '') + ' ' + (el.getAttribute && (el.getAttribute('aria-label') || '') || '')).trim();
  }

  /* ---------------- 跨重载的提交次数（sessionStorage） ---------------- */

  function usedAttempts() {
    try { return parseInt(sessionStorage.getItem(STORE_KEY), 10) || 0; } catch (e) { return 0; }
  }

  function noteAttempt() {
    try { sessionStorage.setItem(STORE_KEY, String(usedAttempts() + 1)); } catch (e) { /* 忽略 */ }
  }

  function resetAttempts() {
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 字段识别 ---------------- */

  function findPassword(root) {
    var el = query(cfg.passwordSelector, root);
    if (el && visible(el)) return el;
    var list = root.querySelectorAll('input[type=password]');
    for (var i = 0; i < list.length; i++) {
      if (visible(list[i])) return list[i];
    }
    return null;
  }

  function findUsername(root, pwd) {
    var el = query(cfg.usernameSelector, root);
    if (el && visible(el)) return el;

    var scope = (pwd && pwd.form) || root;
    var inputs = scope.querySelectorAll('input');
    var fallback = null;
    var KEY_RE = /(user|account|login|email|mobile|phone|账|用|户|名|邮箱|手机)/i;

    for (var i = 0; i < inputs.length; i++) {
      var it = inputs[i];
      var type = (it.type || 'text').toLowerCase();
      if (type === 'password' || type === 'hidden' || type === 'checkbox' || type === 'radio' ||
          type === 'submit' || type === 'button' || type === 'file') {
        continue;
      }
      if (!visible(it)) continue;

      var hint = it.name + ' ' + it.id + ' ' + (it.placeholder || '') + ' ' + (it.getAttribute('aria-label') || '');
      if (KEY_RE.test(hint)) return it;
      if (!fallback) fallback = it;
    }
    // 找不到明确字段时，取密码框之前最近的可见输入框
    if (fallback) return fallback;

    // 再退一步：全局第一个可见文本输入框
    var all = root.querySelectorAll('input');
    for (var j = 0; j < all.length; j++) {
      var t = (all[j].type || 'text').toLowerCase();
      if (t === 'text' || t === 'email' || t === 'tel' || t === '') {
        if (visible(all[j])) return all[j];
      }
    }
    return null;
  }

  function findSubmit(root, pwd) {
    var el = query(cfg.submitSelector, root);
    if (el && visible(el)) return el;

    // 优先同表单内的提交按钮
    if (pwd && pwd.form) {
      var inForm = pwd.form.querySelector('button[type=submit],input[type=submit],button');
      if (inForm && visible(inForm)) return inForm;
    }

    var RE = /(登\s*录|登\s*陆|登入|签\s*入|确\s*定|login|log\s*in|sign\s*in|submit|进入)/i;
    var list = root.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit],[class*="btn"],[class*="button"]');
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!visible(it)) continue;
      if (RE.test(textOf(it))) return it;
    }
    // 文本关键词匹配不到时的兜底：
    //   a) class/id 自带 login/signin 字样 —— 图标按钮无文本的典型场景（如海康 .login-btn）
    for (var j = 0; j < list.length; j++) {
      var it2 = list[j];
      if (!visible(it2)) continue;
      if (/(login|log[-_]?in|sign[-_]?in|submit)/i.test(it2.className + ' ' + it2.id)) return it2;
    }
    //   b) 密码框向上最多 4 层容器内的第一个可见按钮（同属登录面板的提交键）
    var box = pwd;
    for (var k = 0; k < 4 && box; k++) {
      box = box.parentElement;
      if (!box) break;
      var near = box.querySelectorAll('button,[role=button],input[type=button],input[type=submit]');
      for (var m = 0; m < near.length; m++) {
        if (visible(near[m])) return near[m];
      }
    }
    return null;
  }

  /* ---------------- 主循环 ---------------- */

  function alreadyLoggedIn(root) {
    return !!(cfg.successSelector && query(cfg.successSelector, root));
  }

  /**
   * 页面是否处于「登录请求在途」状态（提交按钮变成“登录中…”、按钮被禁用等）。
   * 只在已经提交过一次之后才判定，避免登录页自身常驻的“加载中”造成误判。
   */
  function isSubmitting(root, pwd) {
    var btn = findSubmit(root, pwd);
    if (btn) {
      if (btn.disabled === true) return true;
      if (btn.getAttribute && btn.getAttribute('aria-busy') === 'true') return true;
      if (PENDING_RE.test(textOf(btn))) return true;
    }
    // 部分站点把「登录中」放在遮罩/加载层上，按钮本身文案不变
    var marks = root.querySelectorAll('[class*="loading"],[class*="spinner"],[class*="mask"]');
    for (var i = 0; i < marks.length && i < 30; i++) {
      if (!visible(marks[i])) continue;
      if (PENDING_RE.test((marks[i].textContent || '').trim().slice(0, 20))) return true;
    }
    return false;
  }

  function doFill(root) {
    var pwd = findPassword(root);
    if (!pwd) return false;

    var user = findUsername(root, pwd);
    if (!user) {
      log('未识别到用户名输入框，跳过');
      return false;
    }

    var needUser = user.value !== cfg.username;
    var needPwd = pwd.value !== cfg.password;

    if (needUser) setValue(user, cfg.username);
    if (needPwd) setValue(pwd, cfg.password);

    fillAttempts++;
    lastFillTick = ticks;
    noteAttempt();
    log('已填充账号密码（本次第 ' + fillAttempts + ' 次 / 累计第 ' + usedAttempts() + ' 次）');

    var btn = findSubmit(root, pwd);
    if (btn) {
      log('提交登录：' + (textOf(btn) || btn.tagName));
      btn.click();
    } else if (pwd.form) {
      log('提交登录：form.requestSubmit');
      try {
        if (typeof pwd.form.requestSubmit === 'function') {
          pwd.form.requestSubmit();
        } else {
          pwd.form.submit();
        }
      } catch (e) {
        log('form 提交失败：' + e);
      }
    } else {
      // 无表单无按钮：模拟回车
      log('提交登录：模拟 Enter');
      try {
        ['keydown', 'keypress', 'keyup'].forEach(function (t) {
          pwd.dispatchEvent(new KeyboardEvent(t, {
            bubbles: true, cancelable: true, key: 'Enter', keyCode: 13, which: 13
          }));
        });
      } catch (e2) { /* 忽略 */ }
    }

    submitted = true;
    return true;
  }

  timer = setInterval(function () {
    if (finished) return;
    ticks++;
    if (ticks > MAX_WAIT_TICKS) {
      clearInterval(timer);
      log('等待超时，停止自动登录');
      return;
    }

    var root = document;

    if (alreadyLoggedIn(root)) {
      finished = true;
      clearInterval(timer);
      resetAttempts();
      log('检测到已登录状态，结束');
      return;
    }

    var pwd = findPassword(root);
    if (!pwd) {
      // 页面没有密码框：可能已登录，或登录页尚未渲染
      if (submitted && ticks - lastFillTick > RETRY_DELAY_TICKS * 2) {
        finished = true;
        clearInterval(timer);
        resetAttempts();
        log('登录框已消失，判定登录成功');
        return;
      }
      // 等了足够久仍不见密码框且从未提交过 → 当前页不是登录页（已登录/非登录页），
      // 把跨重载计数清零，避免以后会话过期再回到登录页时被历史计数挡住
      if (!seenPassword && ticks > SETTLE_TICKS) {
        finished = true;
        clearInterval(timer);
        resetAttempts();
        log('当前页面无登录表单，结束');
      }
      return;
    }
    seenPassword = true;

    if (fillAttempts === 0) {
      if (usedAttempts() >= MAX_TOTAL_ATTEMPTS) {
        finished = true;
        clearInterval(timer);
        log('累计提交已达 ' + MAX_TOTAL_ATTEMPTS + ' 次仍未通过，停止自动登录（重新进入该入口可再次尝试）');
        return;
      }
      doFill(root);
      return;
    }

    // 已提交：先看是否处于「登录中…」的挂起态。挂起期间绝不重复点击，
    // 否则每 5 秒重启一次在途的登录请求，页面会永远停在“登录中”。
    if (isSubmitting(root, pwd)) {
      if (!pendingSince) pendingSince = ticks;
      if (ticks - pendingSince > MAX_PENDING_TICKS) {
        finished = true;
        clearInterval(timer);
        log('登录请求长时间无响应，停止自动登录');
      }
      return;
    }
    pendingSince = 0;

    // 已提交但登录框仍在、也不在挂起态：
    //  1) 字段被页面清空 → 说明真的提交过一次且被判失败，不再重试
    //  2) 字段还在原值 → 大概率是点击被页面初始化吞掉（Angular/加密握手未就绪），重试
    if (ticks - lastFillTick >= RETRY_DELAY_TICKS) {
      var user = findUsername(root, pwd);
      var cleared = !user || user.value !== cfg.username || pwd.value !== cfg.password;
      if (cleared) {
        finished = true;
        clearInterval(timer);
        log('账号密码已被页面清空（提交未生效或被拒绝），停止自动登录');
        return;
      }
      if (fillAttempts >= MAX_FILL_ATTEMPTS || usedAttempts() >= MAX_TOTAL_ATTEMPTS) {
        finished = true;
        clearInterval(timer);
        log('已达最大重试次数，停止自动登录');
        return;
      }
      doFill(root);
    }
  }, INTERVAL);
})();
