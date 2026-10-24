/* ==========================================================================
 * tv_nav.js —— 电视遥控器网页焦点导航引擎
 * --------------------------------------------------------------------------
 * 作用：Android WebView 自身的方向键空间导航在复杂大屏页面上命中率低，
 *      这里注入一套完整的“空间焦点导航”实现，把遥控器的
 *      上/下/左/右/确定 映射为网页元素的焦点移动与点击。
 *
 * 设计要点：
 *  1. 元素分级：
 *     - 强交互元素（buttons/links/inputs/role=button 等语义控件）优先；
 *     - 兜底层包含“常见可点击 class”与“自己声明了 cursor:pointer 的元素”
 *       （大量可点元素只是普通 div/h3/span，只靠 cursor:pointer 表示可点）。
 *       两层按层级惩罚分统一打分，语义控件优先但不跳过明显更近的可点元素。
 *  2. 因 cursor 是继承属性，兜底层只取“声明起点”（自身 pointer 且父级非 pointer），
 *     避免把 h1/span/i 等仅继承的装饰节点算作可点目标。
 *  3. 焦点高亮带过渡动画，并自动滚动到屏幕中部；SVG 元素改用 drop-shadow 发光。
 *
 * 由 WebDisplayActivity 注入，重复注入安全（幂等）。
 * ========================================================================== */
(function () {
  'use strict';

  if (window.__TV_NAV_INSTALLED__) {
    if (typeof window.__tvFocusFirst === 'function') window.__tvFocusFirst();
    return;
  }
  window.__TV_NAV_INSTALLED__ = true;

  var FOCUS_CLASS = '__tv-focus-ring';
  var STYLE_ID = '__tv-nav-style';
  var MOVE_EPSILON = 8;

  /* ---------------- 样式：焦点高亮 + 平滑滚动 ---------------- */

  function ensureStyle(doc) {
    try {
      if (doc.getElementById(STYLE_ID)) return;
      var st = doc.createElement('style');
      st.id = STYLE_ID;
      st.type = 'text/css';
      st.textContent = [
        '.' + FOCUS_CLASS + '{',
        'outline:3px solid #2FD2F5 !important;',
        'outline-offset:2px !important;',
        'box-shadow:0 0 0 5px rgba(47,210,245,.30), 0 0 26px rgba(47,210,245,.70) !important;',
        'filter:brightness(1.10);',
        'transition:box-shadow .16s ease-out, outline-color .16s ease-out, filter .16s ease-out !important;',
        'border-radius:4px;',
        '}',
        // SVG 图形不支持 outline/box-shadow，改用 drop-shadow 提供可见的焦点反馈
        'path.' + FOCUS_CLASS + ', rect.' + FOCUS_CLASS + ', circle.' + FOCUS_CLASS + ',',
        'ellipse.' + FOCUS_CLASS + ', polygon.' + FOCUS_CLASS + ', polyline.' + FOCUS_CLASS + ',',
        'line.' + FOCUS_CLASS + ', g.' + FOCUS_CLASS + ', svg.' + FOCUS_CLASS + '{',
        'outline:none !important;',
        'box-shadow:none !important;',
        'filter:drop-shadow(0 0 12px #2FD2F5) brightness(1.35) saturate(1.15) !important;',
        '}'
      ].join('');
      (doc.head || doc.documentElement).appendChild(st);
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 选择器 ---------------- */

  // 强交互元素：语义上就是可点击/可输入的
  var STRONG_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="tab"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[role="option"]',
    '[role="menuitem"]',
    '[contenteditable="true"]',
    '[onclick]',
    'summary',
    'area[href]'
  ].join(',');

  // 弱交互元素（兜底层）：常见可点击 class 命名
  var WEAK_SELECTOR = [
    '[tabindex]',
    '[class*="btn"]',
    '[class*="button"]',
    '[class*="tab"]',
    '[class*="card"]',
    '[class*="item"]',
    '[class*="cell"]',
    '[class*="node"]',
    '[class*="switch"]',
    '[class*="link"]'
  ].join(',');

  /* ---------------- “声明了 cursor:pointer” 的元素 ----------------
   * 大屏页面上大量可点击元素是普通 div/h3/span，既无语义标签也无 tabindex，
   * 只靠 cursor:pointer 表示可点（如编辑模式下的存储池名、服务器区）。
   * 但 cursor 是「继承属性」：父级设了 pointer，其所有子节点都会继承，
   * 直接用 cursor==='pointer' 会把 h1/span/i 等纯装饰节点全部算进来。
   * 因此只取「声明起点」：自身 pointer 且父级（跳过 SVG 内部）不是 pointer。
   */

  var pointerCache = { list: null, at: 0 };
  // 全量扫描 querySelectorAll('*') + 逐元素 getComputedStyle/getBoundingClientRect，
  // 在实时刷新的大屏页（动环监控等）上是遥控器操作卡顿的主因，缓存放宽到 2.5 秒
  var POINTER_CACHE_MS = 2500;

  function hasPointer(el) {
    var cs = window.getComputedStyle(el);
    return !!cs && cs.cursor === 'pointer';
  }

  /** 父级是否已声明 pointer（即自己只是继承） */
  function inheritsPointer(el) {
    var p = el.parentElement;
    while (p && p.ownerSVGElement) p = p.parentElement;
    return !!(p && hasPointer(p));
  }

  function collectPointerTargets() {
    var now = Date.now();
    if (pointerCache.list && (now - pointerCache.at) < POINTER_CACHE_MS) return pointerCache.list;

    var out = [];
    var all;
    try { all = document.querySelectorAll('*'); } catch (e) { all = []; }

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      // computed style 无副作用、不触发重排，放最前面过滤
      if (!hasPointer(el)) continue;
      if (inheritsPointer(el)) continue;
      if (isHugeContainer(el)) continue;
      if (!isVisible(el)) continue;
      out.push(el);
    }
    pointerCache = { list: out, at: now };
    return out;
  }

  /** 页面结构可能因交互（进入编辑模式、打开弹窗）整体变化，变更后丢弃缓存 */
  function invalidatePointerCache() {
    pointerCache = { list: null, at: 0 };
    tiersCache = { v: null, at: 0 };
  }

  /* ---------------- 可见性与可交互性判断 ---------------- */

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.disabled === true) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    var cs = window.getComputedStyle(el);
    if (!cs) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (cs.pointerEvents === 'none') return false;
    if (parseFloat(cs.opacity || '1') < 0.06) return false;
    if (r.bottom < -240 || r.top > (window.innerHeight + 240)) return false;
    return true;
  }

  /** SVG / Canvas 内部节点（图表图形）默认不参与遥控器导航 */
  function isChartNode(el) {
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'svg' || tag === 'canvas') return true;
    if (el.ownerSVGElement) {
      // SVG 中的链接或显式按钮仍可用于导航
      return !(tag === 'a' || el.getAttribute('role') === 'button');
    }
    return false;
  }

  /** 整屏容器通常只是布局元素，纳入导航会让方向键“失灵” */
  function isHugeContainer(el) {
    var r = el.getBoundingClientRect();
    var viewport = window.innerWidth * window.innerHeight;
    if (viewport <= 0) return false;
    return (r.width * r.height) > viewport * 0.75;
  }

  function toArray(nodeList) {
    var out = [];
    for (var i = 0; i < nodeList.length; i++) out.push(nodeList[i]);
    return out;
  }

  function collect(selector, weakTier) {
    var list = [];
    try {
      list = toArray(document.querySelectorAll(selector));
    } catch (e) {
      return [];
    }
    // 一并收集同源 iframe 内的元素
    try {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        try {
          var idoc = iframes[i].contentDocument;
          if (idoc) list = list.concat(toArray(idoc.querySelectorAll(selector)));
        } catch (e2) { /* 跨域 iframe 忽略 */ }
      }
    } catch (e3) { /* 忽略 */ }

    var result = [];
    for (var j = 0; j < list.length; j++) {
      var el = list[j];
      if (isChartNode(el)) continue;
      if (!isVisible(el)) continue;
      if (weakTier) {
        if (!hasPointer(el)) continue;
        // 只是从父级继承 pointer 的装饰子节点不算独立目标（父级已作为候选）
        if (inheritsPointer(el)) continue;
        if (isHugeContainer(el)) continue;
      }
      result.push(el);
    }
    return result;
  }

  /* ---------------- 几何与方向计算 ---------------- */

  function centerOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function normalizeActive() {
    var active = document.activeElement;
    if (!active || active === document.body || active === document.documentElement) return null;
    if (!isVisible(active)) return null;
    // 图表内部节点：只有自身声明了 cursor:pointer（即可点击的图表扇区）才参与导航
    if (isChartNode(active) && !hasPointer(active)) return null;
    return active;
  }

  function focusNearestToCenter(candidates) {
    var cx = window.innerWidth / 2;
    var cy = window.innerHeight / 2;
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var p = centerOf(candidates[i]);
      var d = Math.abs(p.x - cx) + Math.abs(p.y - cy) * 1.4;
      if (p.y < 0) d += 4000; // 优先屏幕内可见区域
      if (d < bestD) { bestD = d; best = candidates[i]; }
    }
    if (best) focusElement(best);
  }

  /** 在候选集中挑选指定方向上“视觉就近”的元素，penalty 为该层级的偏好惩罚 */
  function pickBestScored(candidates, active, dir, penalty) {
    var c = centerOf(active);
    var best = null;
    var bestScore = Infinity;

    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el === active) continue;
      var p = centerOf(el);
      var dx = p.x - c.x;
      var dy = p.y - c.y;
      var primary;
      var secondary;

      if (dir === 'up') {
        if (dy > -MOVE_EPSILON) continue;
        primary = -dy; secondary = Math.abs(dx);
      } else if (dir === 'down') {
        if (dy < MOVE_EPSILON) continue;
        primary = dy; secondary = Math.abs(dx);
      } else if (dir === 'left') {
        if (dx > -MOVE_EPSILON) continue;
        primary = -dx; secondary = Math.abs(dy);
      } else if (dir === 'right') {
        if (dx < MOVE_EPSILON) continue;
        primary = dx; secondary = Math.abs(dy);
      } else {
        continue;
      }

      // 主方向距离为主，垂直偏移加权惩罚，保证视觉上的“就近”
      var score = primary + secondary * 2.4 + penalty;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best ? { el: best, score: bestScore } : null;
  }

  /* ---------------- 焦点设置与视觉反馈 ---------------- */

  var lastFocused = null;

  function clearMark() {
    if (lastFocused && lastFocused.classList) {
      try { lastFocused.classList.remove(FOCUS_CLASS); } catch (e) { /* 忽略 */ }
    }
    lastFocused = null;
  }

  function focusElement(el) {
    if (!el) return;
    // div / h3 / span / SVG <path> 默认不可聚焦，focus() 会静默失败，
    // 必须先补一个 tabindex=-1 才能成为可编程焦点目标
    if (el.tabIndex === undefined || el.tabIndex < 0) {
      try {
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      } catch (e0) { /* 忽略 */ }
    }
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      try { el.focus(); } catch (e2) { /* 忽略 */ }
    }
    clearMark();
    try {
      if (el.classList) el.classList.add(FOCUS_CLASS);
      lastFocused = el;
    } catch (e3) { /* 忽略 */ }

    // 滚动到可视区域中部，便于大屏观看
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    } catch (e4) {
      try { el.scrollIntoView(); } catch (e5) { /* 忽略 */ }
    }
  }

  function activate(el) {
    if (!el) return;
    // 点击可能改变页面结构（进入编辑模式、打开弹窗），先失效候选缓存
    invalidatePointerCache();
    var tag = (el.tagName || '').toLowerCase();
    var type = (el.type || '').toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      el.click();
      return;
    }
    try {
      el.click();
    } catch (e) {
      // 兜底：手动派发鼠标事件
      try {
        var r = el.getBoundingClientRect();
        var opt = {
          bubbles: true, cancelable: true, view: window,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
        };
        el.dispatchEvent(new MouseEvent('mousedown', opt));
        el.dispatchEvent(new MouseEvent('mouseup', opt));
        el.dispatchEvent(new MouseEvent('click', opt));
      } catch (e2) { /* 忽略 */ }
    }
  }

  /* ---------------- 方向移动（强交互优先，弱交互兜底） ---------------- */

  /**
   * 两级候选集：
   *  tier0 强交互（语义明确：button / a / input / role=button …）
   *  tier1 弱交互（常见可点击 class + 声明了 cursor:pointer 的元素，如可编辑的
   *        div/h3 与可点击的图表扇区），仅在 tier0 该方向无候选时兜底
   */
  /**
   * 候选集缓存：每次按方向键都要做 3 次全量 DOM 扫描 + 逐元素可见性判断，
   * 在大屏页面上单次可达上百毫秒，连按方向键就会明显卡顿。
   * 导航只改变「哪个元素被聚焦」，不会改变候选元素本身，因此短时缓存是安全的
   * （结构变化由 activate() → invalidatePointerCache() 主动失效）。
   */
  var tiersCache = { v: null, at: 0 };
  var TIERS_CACHE_MS = 1200;

  function candidateTiers() {
    var now = Date.now();
    if (tiersCache.v && (now - tiersCache.at) < TIERS_CACHE_MS) return tiersCache.v;

    var weak = collect(WEAK_SELECTOR, true);
    var ptr = collectPointerTargets();
    for (var i = 0; i < ptr.length; i++) {
      if (weak.indexOf(ptr[i]) < 0) weak.push(ptr[i]);
    }
    var result = [collect(STRONG_SELECTOR, false), weak];
    tiersCache = { v: result, at: now };
    return result;
  }

  /**
   * 弱交互层级惩罚分：语义控件优先，但不能因此跳过“明显更近”的可点元素。
   * 取值需小于一个屏幕内的常见移动距离，使近处的可点 div/h3 能胜出，
   * 而同距离时仍然优先语义控件。
   */
  var WEAK_PENALTY = 700;

  function move(dir) {
    var active = normalizeActive();
    var tiers = candidateTiers();

    // 当前无焦点：优先落在强交互元素上
    if (!active) {
      for (var t = 0; t < tiers.length; t++) {
        if (tiers[t].length) {
          focusNearestToCenter(tiers[t]);
          return true;
        }
      }
      return false;
    }

    // 两层合并打分：语义层无惩罚，兜底层加固定惩罚，最终取整体最优
    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < tiers.length; i++) {
      var list = tiers[i];
      if (!list.length) continue;
      var cand = pickBestScored(list, active, dir, i === 0 ? 0 : WEAK_PENALTY);
      if (cand && cand.score < bestScore) {
        bestScore = cand.score;
        best = cand.el;
      }
    }

    if (!best) return false;
    focusElement(best);
    return true;
  }

  /** 自动落焦：优先落在强交互元素上 */
  function focusFirst() {
    var tiers = candidateTiers();
    for (var t = 0; t < tiers.length; t++) {
      if (!tiers[t].length) continue;
      var active = normalizeActive();
      if (active) {
        focusElement(active);
        return true;
      }
      focusNearestToCenter(tiers[t]);
      return true;
    }
    return false;
  }

  /* ---------------- 按键映射 ---------------- */

  function resolveDir(ev) {
    var k = ev.key;
    var code = ev.keyCode;
    if (k === 'ArrowUp' || code === 38) return 'up';
    if (k === 'ArrowDown' || code === 40) return 'down';
    if (k === 'ArrowLeft' || code === 37) return 'left';
    if (k === 'ArrowRight' || code === 39) return 'right';
    return null;
  }

  function isOk(ev) {
    var k = ev.key;
    var code = ev.keyCode;
    return k === 'Enter' || code === 13 || code === 23 || k === 'Accept' || k === 'GamepadA';
  }

  function onKeyDown(ev) {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;

    if (isOk(ev)) {
      var active = normalizeActive();
      if (active) {
        ev.preventDefault();
        ev.stopPropagation();
        activate(active);
      }
      return;
    }

    var dir = resolveDir(ev);
    if (!dir) return;

    if (move(dir)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  /* ---------------- 安装 ---------------- */

  function install() {
    ensureStyle(document);
    document.addEventListener('keydown', onKeyDown, true);

    // 页面/用户自行改变焦点时同步高亮样式
    document.addEventListener('focusin', function (ev) {
      var target = ev.target;
      if (!target || target === document.body) return;
      if (target !== lastFocused) {
        clearMark();
        try { if (target.classList) target.classList.add(FOCUS_CLASS); } catch (e) { /* 忽略 */ }
        lastFocused = target;
      }
    }, true);

    window.__tvFocusFirst = focusFirst;
  }

  install();

  // 页面渲染完成后自动落焦，保证遥控器“按下去就有反应”。
  // 探测间隔不宜过密：每次尝试都是一轮全量扫描，页面加载期连扫会加重首屏卡顿。
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var active = normalizeActive();
    if (active || (window.__tvFocusFirst && window.__tvFocusFirst())) {
      clearInterval(timer);
      return;
    }
    if (tries > 10) clearInterval(timer);
  }, 800);

  // SPA 通过 AJAX 重绘后可能丢失焦点，空闲时重新落焦
  var lastActivity = Date.now();
  document.addEventListener('keydown', function () { lastActivity = Date.now(); }, true);
  setInterval(function () {
    if (Date.now() - lastActivity < 6000) return;
    if (!normalizeActive() && window.__tvFocusFirst) window.__tvFocusFirst();
  }, 8000);
})();
