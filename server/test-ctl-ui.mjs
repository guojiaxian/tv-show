#!/usr/bin/env node
/**
 * 多设备互控 · 端到端验证（Playwright 驱动真实浏览器，双页面架构）
 *
 *   page1 = 显示端（/）   ：注册心跳 + 指令切换画面；**被控不锁鼠标**（核心修订断言）
 *   page2 = 控制台（/console）：纯控制端，自身不注册为受控设备
 *   DEV2  = 模拟电视（API 直接 beat）
 */
import { loadChromium, launchOptions } from './test-pw.mjs';

const loaded = loadChromium();
if (!loaded) {
  console.log('SKIP 未安装 playwright-core / Chromium，跳过互控端到端验证');
  process.exit(0);
}

const BASE = process.env.BASE;
if (!BASE) {
  console.error('本脚本会改写服务端数据，必须跑在隔离实例上：node server/test-run.mjs');
  process.exit(1);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log('      ' + JSON.stringify(detail));
};

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const send = (targets, cmd, args) => api('POST', '/api/ctl/send', { targets, cmd, args });
const deviceOf = async (id) =>
  (await api('GET', '/api/ctl/devices')).json.devices.find((d) => d.id === id);

async function waitUntil(fn, { timeout = 9000, interval = 300, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

function attachPageLog(page, errors, tag) {
  page.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + String(e).split('\n')[0]));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    const loc = (m.location() && m.location().url) || '';
    if (loc.startsWith(BASE + '/proxy/') || loc.startsWith(BASE + '/cam/') || loc.startsWith(BASE + '/shot/')) return;
    if (/^WebSocket connection/.test(m.text())) return;
    errors.push(tag + ' console: ' + m.text());
  });
}

(async () => {
  const browser = await loaded.chromium.launch(launchOptions(loaded));
  const errors = [];

  /* ---------- 清理前置套件档案（test-run 顺序执行，控制通道档案跨套件共享） ---------- */
  {
    const pre = (await api('GET', '/api/ctl/devices')).json;
    for (const d of pre.devices || []) await api('DELETE', '/api/ctl/device/' + encodeURIComponent(d.id));
    for (const s of pre.scenes || []) await api('DELETE', '/api/ctl/scenes/' + encodeURIComponent(s.id));
  }

  /* ============================ 显示端（/）受控侧 ============================ */
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page1 = await ctx1.newPage();
  attachPageLog(page1, errors, '[显示端]');

  await page1.goto(BASE + '/', { waitUntil: 'load' });

  /* ---------- 浏览器端关闭行为与平板顶栏 ---------- */
  // 不应注册 beforeunload 拦截，否则关闭标签页会弹浏览器原生「离开此网站？」
  const unloadPrevented = await page1.evaluate(() => {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('浏览器端不拦截关闭标签页（无「离开此网站」确认）', !unloadPrevented);

  // 平板触屏：地址栏收起时 outerHeight≈innerHeight，不能被误判为全屏而隐藏顶栏
  const tabletCtx = await browser.newContext({
    viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true
  });
  const tablet = await tabletCtx.newPage();
  // 只验证布局，不让平板页注册成受控设备（否则会改变后续用例的设备数断言）
  await tablet.route('**/api/ctl/beat', (route) => route.abort());
  await tablet.goto(BASE + '/', { waitUntil: 'load' });
  await tablet.setViewportSize({ width: 1024, height: 700 });
  await tablet.waitForTimeout(300);
  const tabletTopbar = await tablet.evaluate(() => {
    const el = document.getElementById('topbar');
    return !!el && getComputedStyle(el).display !== 'none';
  });
  check('平板触屏视口下顶栏保持可见（设置 / 远程控制可进入）', tabletTopbar);
  await tabletCtx.close();

  // 顶栏「远程控制」按钮位于「分区展示」与「全屏」之间，点击新标签打开 /console
  const consoleEntry = await page1.evaluate(() => {
    const btn = document.getElementById('btnConsole');
    if (!btn) return null;
    return {
      text: btn.textContent.trim(),
      order: Array.from(document.querySelectorAll('#homeTools > .btn')).map((b) => b.textContent.trim())
    };
  });
  check('顶栏「远程控制」按钮位于「分区展示」与「全屏」之间',
    !!consoleEntry && consoleEntry.text === '远程控制' &&
    consoleEntry.order.join('|').includes('分区展示|远程控制|全屏'), consoleEntry);
  const [popup] = await Promise.all([
    page1.waitForEvent('popup'),
    page1.click('#btnConsole')
  ]);
  const popupUrl = popup.url();
  await popup.close();
  check('点击按钮真实打开 /console 独立控制台', /\/console$/.test(popupUrl), popupUrl);
  const ok1 = await waitUntil(async () => !!(await page1.evaluate(() => localStorage.getItem('tvshow.deviceId'))),
    { timeout: 6000, label: 'deviceId 生成' });
  const deviceId = await page1.evaluate(() => localStorage.getItem('tvshow.deviceId'));
  const ok1b = await waitUntil(async () => {
    const d = await deviceOf(deviceId);
    return !!(d && d.reported && d.reported.mode === 'home');
  }, { label: '注册并上报 home' });
  check('显示端打开即注册为受控设备并上报状态', ok1 && ok1b && /^dev-[0-9a-f]{8}$/.test(deviceId), deviceId);

  /* ---------- 即时同步：管理后台保存 → 显示端 ≤3s 心跳发现内容落后 → 立即拉取 ---------- */
  const titleBefore = await page1.evaluate(() => document.getElementById('appTitle').textContent);
  const newTitle = '即时同步测试标题' + Date.now() % 10000;
  await api('PUT', '/api/admin/meta', { appTitle: newTitle });
  const syncOk = await waitUntil(() => page1.evaluate((t) =>
    document.getElementById('appTitle').textContent === t, newTitle),
    { timeout: 8000, label: '显示端标题更新' });
  check('Web 端保存后显示端立即同步（≤8s 内标题更新，无需重启/手动）', syncOk, { before: titleBefore, after: newTitle });

  /* ---------- 模拟电视 DEV2 ---------- */
  const DEV2 = 'dev-test0002';
  const beat2 = (extra = {}) => api('POST', '/api/ctl/beat', {
    deviceId: DEV2, kind: 'tv', appVersion: 'test', ackedSeq: 0, ...extra
  });

  /* ============================ 控制台（/console）控制侧 ============================ */
  const ctx2 = await browser.newContext({ viewport: { width: 1180, height: 860 } });
  const page2 = await ctx2.newPage();
  attachPageLog(page2, errors, '[控制台]');
  await page2.goto(BASE + '/console', { waitUntil: 'load' });
  await page2.click('#btnReload');

  /* ---------- 设备卡：首页选项 + 极速模式开关 ---------- */
  const cardReady = await waitUntil(() => page2.evaluate((id) =>
    !!document.querySelector(`[data-device-id="${id}"] .turbo-btn`), deviceId),
    { timeout: 6000, label: '设备卡片渲染' });
  const cardUi = await page2.evaluate((id) => {
    const card = document.querySelector(`[data-device-id="${id}"]`);
    return {
      turbo: card && card.querySelector('.turbo-btn') ? card.querySelector('.turbo-btn').textContent : null,
      home: !!(card && card.querySelector('.entry-sel option[value="__home__"]')),
      footerHome: !!(document.getElementById('selEntry') &&
        document.getElementById('selEntry').querySelector('option[value="__home__"]'))
    };
  }, deviceId);
  check('设备卡提供极速开关，单台/勾选下拉均含「首页」',
    cardReady && cardUi.turbo === '极速：关' && cardUi.home === true && cardUi.footerHome === true, cardUi);

  await page2.click(`[data-device-id="${deviceId}"] .turbo-btn`);
  const turboOn = await waitUntil(() => page1.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('tvshow.localSettings') || '{}').turboEnabled === true; }
    catch (e) { return false; }
  }), { timeout: 7000, label: '极速开启' });
  check('控制台极速开关下发到显示端（本机开关变开）', turboOn);

  const turboLabel = await waitUntil(() => page2.evaluate((id) => {
    const b = document.querySelector(`[data-device-id="${id}"] .turbo-btn`);
    return !!b && b.textContent === '极速：开';
  }, deviceId), { timeout: 6000, label: '极速状态回流' });
  check('显示端心跳上报极速状态，控制台按钮回流为开', turboLabel);

  // 再点一次关掉，避免影响后续用例（此时卡片已按上报状态重建，点击即下发关闭）
  await page2.click(`[data-device-id="${deviceId}"] .turbo-btn`);
  const turboOff = await waitUntil(() => page1.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('tvshow.localSettings') || '{}').turboEnabled === false; }
    catch (e) { return true; }
  }), { timeout: 7000, label: '极速关闭' });
  check('控制台可再次下发关闭极速模式', turboOff);
  const consoleBackOff = await waitUntil(() => page2.evaluate((id) => {
    const b = document.querySelector(`[data-device-id="${id}"] .turbo-btn`);
    return !!b && b.textContent === '极速：关';
  }, deviceId), { timeout: 8000, label: '控制台回到关' });
  check('控制台按钮随心跳回落为关', consoleBackOff);

  /* ---------- 客户端本机切换极速：状态必须回流到控制台 ---------- */
  // 回归：deviceSignature 曾漏掉 reported.turbo，本机切换后卡片不重建，控制台永远显示旧状态
  await page1.bringToFront();
  await page1.click('#btnMore');
  await page1.waitForFunction(() => !document.getElementById('moreMenu').hidden, null, { timeout: 2000 });
  await page1.click('#btnTurbo');
  await page2.bringToFront();
  const localOn = await waitUntil(() => page2.evaluate((id) => {
    const b = document.querySelector(`[data-device-id="${id}"] .turbo-btn`);
    return !!b && b.textContent === '极速：开';
  }, deviceId), { timeout: 9000, label: '本机切换上报·开' });
  check('客户端本机开启极速后，控制台卡片状态回流为开', localOn);

  await page1.bringToFront();
  await page1.click('#btnMore');
  await page1.waitForFunction(() => !document.getElementById('moreMenu').hidden, null, { timeout: 2000 });
  await page1.click('#btnTurbo');
  await page2.bringToFront();
  const localOff = await waitUntil(() => page2.evaluate((id) => {
    const b = document.querySelector(`[data-device-id="${id}"] .turbo-btn`);
    return !!b && b.textContent === '极速：关';
  }, deviceId), { timeout: 9000, label: '本机切换上报·关' });
  check('客户端本机关闭极速后，控制台卡片状态回流为关', localOff);


  // 控制台不注册为受控设备
  const beforeCount = (await api('GET', '/api/ctl/devices')).json.devices.length;
  await page2.waitForTimeout(3500); // 覆盖一拍心跳周期
  const afterCount = (await api('GET', '/api/ctl/devices')).json.devices.length;
  check('控制台是纯控制端：自身不注册为受控设备（列表数不变）',
    beforeCount === 1 && afterCount === 1, { beforeCount, afterCount });

  /* ---------- 单台下发 show（只发显示端），断言：切画面 + 不锁鼠标 ---------- */
  await send([deviceId], 'show', { entryId: 'storage-monitor' });
  const okShow = await waitUntil(() => page1.evaluate(() =>
    !document.getElementById('displayScreen').hidden &&
    !!document.querySelector('#frameViewport iframe[data-for="storage-monitor"]')), { label: 'show 切换' });
  check('show 指令：显示端切换到指定页面', okShow);

  const uiLock = await page1.evaluate(() => ({
    lockedClass: document.body.classList.contains('ctl-locked'),
    btnBackClickable: getComputedStyle(document.getElementById('btnBack')).pointerEvents !== 'none'
  }));
  check('核心修订：被控后不锁定（无 ctl-locked 类，顶栏按钮可点）',
    uiLock.lockedClass === false && uiLock.btnBackClickable === true, uiLock);

  // 被控状态下鼠标真实可点：点「← 返回首页」成功回到首页
  await page1.click('#btnBack');
  const homeClickable = await waitUntil(() => page1.evaluate(() =>
    !document.getElementById('homeScreen').hidden), { label: '本地点击返回首页' });
  check('核心修订：被控状态下鼠标点击真实生效（点「返回首页」成功）', homeClickable);

  // 首页卡片存在（鼠标可用性已由上一条「点返回首页」验证）
  const cardClick = await page1.evaluate(() => document.getElementById('grid').children.length > 0);
  check('首页卡片结构存在（点击由上一条已验证鼠标可用）', cardClick);
  const devAfterClick = await deviceOf(deviceId);
  check('本地点击后服务端如实收到新状态（reported 跟随实际画面）',
    await waitUntil(async () => ['page', 'home'].includes((await deviceOf(deviceId)).reported.mode), { label: 'reported 更新' }), devAfterClick.reported);

  /* ---------- 控制台列表渲染与操作 ---------- */
  await beat2({ state: { mode: 'home' } });
  await page2.click('#btnReload');
  const twoCards = await waitUntil(async () => {
    const n = await page2.evaluate(() => document.querySelectorAll('#deviceList .card').length);
    return n === 2 ? n : false;
  }, { label: '两台设备' });
  const cards = await page2.evaluate(() => Array.from(document.querySelectorAll('#deviceList .card')).map((c) => ({
    kind: c.querySelector('.kind').textContent,
    chip: Array.from(c.querySelectorAll('.chip')).map((x) => x.textContent).join('|')
  })));
  check('控制台设备列表：显示端（PC）+ 二号电视（TV，本地控制，含 IP）',
    !!twoCards && cards.length === 2 && cards.some((c) => c.kind === 'PC') &&
    cards.some((c) => c.kind === 'TV' && /本地控制/.test(c.chip) && /IP 127\.0\.0\.1/.test(c.chip)), cards);

  const chipOrder = await page2.evaluate(() => {
    const card = Array.from(document.querySelectorAll('#deviceList .card'))
      .find((c) => c.querySelector('.kind').textContent === 'TV');
    return Array.from(card.querySelectorAll('.st .chip')).map((x) => x.textContent);
  });
  check('卡片状态顺序：在线/离线 → 本地/远程控制 → 版本 → IP，且无「暂无上报」',
    chipOrder.length >= 4 && ['在线', '离线'].includes(chipOrder[0]) &&
    ['本地控制', '远程控制'].includes(chipOrder[1]) &&
    /^v/.test(chipOrder[2]) && /^IP /.test(chipOrder[3]) &&
    !chipOrder.some((t) => t.includes('暂无上报')), chipOrder);
  const h1 = await page2.evaluate(() => document.querySelector('header h1').textContent);
  const ipShown = await page2.evaluate(() =>
    Array.from(document.querySelectorAll('#deviceList .card .st .chip')).some((c) => /^IP /.test(c.textContent)));
  check('控制台标题为「远程控制」且设备卡片显示来源 IP', h1 === '远程控制' && ipShown, { h1, ipShown });

  // 单台下发：只勾 DEV2
  await page2.evaluate(() => {
    const target = Array.from(document.querySelectorAll('#deviceList .card')).find((c) => c.querySelector('.kind').textContent === 'TV');
    target.querySelector('.ck').click();
  });
  await page2.selectOption('#selEntry', 'env-monitor');
  await page2.waitForTimeout(600);
  const dev2a = await deviceOf(DEV2);
  const dev1a = await deviceOf(deviceId);
  check('单台下发：仅二号电视收到 show（显示端不受影响）',
    dev2a.desired && dev2a.desired.cmd === 'show' && dev2a.managed === true &&
    (!dev1a.desired || dev1a.desired.seq < dev2a.desired.seq), { dev2: dev2a.desired, dev1: dev1a.desired });
  const pendingShown = await page2.evaluate(() => !!document.querySelector('#deviceList .chip.pending'));
  check('下发后列表立即出现「待送达」角标', pendingShown);
  // 回归：卡片下拉/底部下拉获得焦点时，列表曾整体停止重渲染，必须手动点「刷新」
  // 才能看到「远程控制」；这里要求下发后不刷新页面也能在 0.6s 内自动切换。
  const remoteNow = await waitUntil(() => page2.evaluate(() => {
    const card = Array.from(document.querySelectorAll('#deviceList .card'))
      .find((c) => c.querySelector('.kind').textContent === 'TV');
    return !!card && Array.from(card.querySelectorAll('.st .chip')).some((x) => x.textContent === '远程控制');
  }), { timeout: 600, interval: 100, label: '即时变远程控制' });
  check('下发后卡片即时由「本地控制」变为「远程控制」（无需手动刷新）', remoteNow);
  const b2 = await beat2({ state: { mode: 'page', entryId: 'env-monitor' } });
  check('二号电视心跳领到指令（模拟电视端 beat）', b2.json.desired && b2.json.desired.cmd === 'show', b2.json);

  /* ---------- 轮询弹层 ---------- */
  await page2.click('#btnRotate');
  const modalRot = await page2.evaluate(() => {
    const m = document.querySelector('.modal');
    if (!m) return null;
    const rows = Array.from(m.querySelectorAll('.row'));
    const sync = rows.map((r) => r.querySelector('input[type="checkbox"]')).find(Boolean);
    return { syncChecked: sync ? sync.checked : null, hasInterval: !!m.querySelector('select') };
  });
  check('轮询弹层：多屏同步切换默认不勾 + 间隔预设可用',
    modalRot && modalRot.syncChecked === false && modalRot.hasInterval, modalRot);
  await page2.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.modal .row'));
    const row = rows.find((r) => r.querySelector('.grow') && r.querySelector('input[type="checkbox"]'));
    row.querySelector('input[type="checkbox"]').click();
  });
  const draft = await page2.evaluate(() => {
    const checked = Array.from(document.querySelectorAll('.modal .row')).filter((r) => {
      const c = r.querySelector('input[type="checkbox"]'); return c && c.checked;
    });
    return { count: checked.length, hasOrder: /1\.\s/.test(checked[0] ? checked[0].textContent : '') };
  });
  check('轮询弹层：勾选页面进入序列（顺序号）', draft.count === 1 && draft.hasOrder, draft);
  await page2.keyboard.press('Escape');
  const modalClosed = await page2.evaluate(() => document.getElementById('mask').hidden);
  check('Esc 关闭配置弹层', modalClosed === true);

  /* ---------- 分屏弹层 ---------- */
  await page2.click('#btnZone');
  const modalZone = await page2.evaluate(() => {
    const sels = Array.from(document.querySelectorAll('.modal .zonegrid select'));
    return { count: sels.length, allHaveNone: sels.every((s) => s.options[0] && s.options[0].textContent === '不使用') };
  });
  check('分屏弹层：四格下拉且每格都有「不使用」', modalZone.count === 4 && modalZone.allHaveNone, modalZone);
  await page2.keyboard.press('Escape');

  /* ---------- 单台快捷操作（卡片右侧按钮，无需勾选） ---------- */
  // 先把 DEV2 拉回在线（离线拦截会跳过对它的下发）
  await beat2({ state: { mode: 'home' } });
  await page2.click('#btnReload');
  await waitUntil(() => page2.evaluate(() => {
    const tvCard = Array.from(document.querySelectorAll('#deviceList .card'))
      .find((c) => c.querySelector('.kind').textContent === 'TV');
    return tvCard && !!tvCard.querySelector('.chip.onl-online');
  }), { label: 'TV 在线' });
  // 卡片操作区结构：显示页面下拉（选中项=当前画面）+ 轮询… + 分屏… + 取消控制 + 重命名
  const tvCardOps = await page2.evaluate(() => {
    const card = Array.from(document.querySelectorAll('#deviceList .card')).find((c) => c.querySelector('.kind').textContent === 'TV');
    if (!card) return null;
    const sel = card.querySelector('.ops select');
    return {
      selOptions: sel ? sel.options.length : 0,
      selSelected: sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : null,
      buttons: Array.from(card.querySelectorAll('.ops .btn')).map((b) => b.textContent)
    };
  });
  check('卡片右侧单台快捷操作齐全（当前画面下拉 + 轮询/分屏/取消控制 + 重命名，无开机恢复按钮）',
    !!tvCardOps && tvCardOps.selOptions > 1 && tvCardOps.selSelected === '首页' &&
    ['轮询', '分屏', '取消控制', '重命名'].every((t) => tvCardOps.buttons.includes(t)) &&
    !tvCardOps.buttons.some((t) => t.includes('开机恢复')), tvCardOps);

  // 不勾选任何设备，直接用 TV 卡片的下拉对它单台下发 show
  await page2.evaluate(() => {
    document.querySelectorAll('#deviceList .card .ck').forEach((ck) => { if (ck.checked) ck.click(); });
  });
  await page2.selectOption('.card:has(.kind:text-is("TV")) .ops select', 'security-cockpit');
  await page2.waitForTimeout(600);
  const tvSolo = await deviceOf(DEV2);
  const webSolo = await deviceOf(deviceId);
  check('卡片下拉单台下发：仅 TV 收到 show（未勾选、显示端不受影响）',
    tvSolo.desired && tvSolo.desired.cmd === 'show' && tvSolo.desired.args.entryId === 'security-cockpit' &&
    (!webSolo.desired || webSolo.desired.seq < tvSolo.desired.seq), { tv: tvSolo.desired, web: webSolo.desired });
  await beat2({ state: { mode: 'page', entryId: 'security-cockpit' } });
  // 刷新后 TV 卡片下拉应选中「安全驾驶舱」（当前画面）
  await page2.click('#btnReload');
  const selNow = await waitUntil(() => page2.evaluate(() => {
    const card = Array.from(document.querySelectorAll('#deviceList .card')).find((c) => c.querySelector('.kind').textContent === 'TV');
    const sel = card && card.querySelector('.ops select');
    return sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '';
  }).then((t) => t.includes('物探') || t.includes('安全') || t.includes('驾驶舱') ? t : false), { label: '下拉显示当前页' });
  check('显示页面下拉显示设备当前画面（选中正在显示的页）', !!selNow, selNow);

  // 卡片「轮询…」弹层单台路径：标题带目标设备名，下发仅作用于该台
  await page2.click('.card:has(.kind:text-is("TV")) .ops .btn:text-is("轮询")');
  const soloTitle = await page2.evaluate(() => {
    const h = document.querySelector('.modal header p');
    return h ? h.textContent : '';
  });
  check('卡片轮询弹层标注单台目标', /目标：/.test(soloTitle), soloTitle);
  await page2.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.modal .row'));
    const row = rows.find((r) => r.querySelector('.grow') && r.querySelector('input[type="checkbox"]'));
    row.querySelector('input[type="checkbox"]').click();
  });
  await page2.click('.modal footer .btn.primary');
  await page2.waitForTimeout(600);
  const tvRot = await deviceOf(DEV2);
  check('卡片轮询单台下发：仅 TV 收到 rotate 指令',
    tvRot.desired && tvRot.desired.cmd === 'rotate' && tvRot.managed === true, tvRot.desired);

  // 卡片「取消控制」单台二次确认
  await page2.click('.card:has(.kind:text-is("TV")) .ops .btn:text-is("取消控制")');
  await page2.waitForTimeout(200);
  await page2.click('.confirm-btn:has-text("取消控制，交还本地")');
  const tvRel = await waitUntil(async () => (await deviceOf(DEV2)).managed === false, { label: 'TV 交还' });
  check('卡片「取消控制」单台二次确认后交还', tvRel);

  /* ---------- 对显示端下发 rotate / zone / home（API 直发 + page1 断言） ---------- */
  await send([deviceId], 'rotate', { intervalSec: 5, items: ['storage-monitor', 'env-monitor'] });
  const okRotate = await waitUntil(() => page1.evaluate(() =>
    document.getElementById('rotationChip').classList.contains('show')), { label: '轮询启动' });
  const lsRotate = await page1.evaluate(() => JSON.parse(localStorage.getItem('tvshow.localSettings') || '{}').rotation);
  check('rotate 指令：写入本机轮询设置并进入轮询播放',
    okRotate && lsRotate && lsRotate.intervalSec === 5 &&
    JSON.stringify(lsRotate.items) === JSON.stringify(['storage-monitor', 'env-monitor']), lsRotate);
  const repRotate = await waitUntil(async () => {
    const d = await deviceOf(deviceId);
    return d.reported.mode === 'rotate' && d.reported.rotate &&
      JSON.stringify(d.reported.rotate.items) === JSON.stringify(['storage-monitor', 'env-monitor']);
  }, { label: 'reported=rotate' });
  check('服务端视角 reported.mode=rotate（含 items 序列）', repRotate);

  /* ---------- 展示页全屏：顶栏全屏按钮 + 全屏时隐藏顶栏 ---------- */
  // 轮询态即展示态：displayTools 里应有「全屏」按钮（在「重置」与「直连模式」之间）
  const fsBtn = await page1.evaluate(() => {
    const tools = Array.from(document.querySelectorAll('#displayTools > .btn')).map((b) => b.textContent.trim());
    const btn = document.getElementById('btnDisplayFullscreen');
    return { tools: tools.join('|'), present: !!btn };
  });
  check('展示页顶栏有「全屏」按钮（位于「重置」与「直连模式」之间）',
    fsBtn.present && /重置\|全屏\|直连模式/.test(fsBtn.tools), fsBtn.tools);
  // 点击进入全屏：顶栏隐藏（真全屏），画面容器变高
  await page1.click('#btnDisplayFullscreen');
  await page1.waitForTimeout(600);
  const fsState = await page1.evaluate(() => ({
    fullscreen: !!document.fullscreenElement,
    topbarHidden: getComputedStyle(document.getElementById('topbar')).display === 'none'
  }));
  check('点击全屏：进入全屏且顶栏隐藏（真全屏）', fsState.fullscreen && fsState.topbarHidden, fsState);
  // 退出全屏：顶栏恢复（用户路径为 Esc / F11 / F；顶栏此时已隐藏，测试用 API 退出）
  await page1.evaluate(() => document.exitFullscreen());
  await page1.waitForTimeout(600);
  const fsExit = await page1.evaluate(() => ({
    fullscreen: !!document.fullscreenElement,
    topbarHidden: getComputedStyle(document.getElementById('topbar')).display === 'none'
  }));
  check('退出全屏：顶栏恢复显示', !fsExit.fullscreen && !fsExit.topbarHidden, fsExit);

  await send([deviceId], 'zone', { slots: ['storage-monitor', null, 'env-monitor', 'security-cockpit'] });
  const okZone = await waitUntil(() => page1.evaluate(() =>
    !document.getElementById('zoneScreen').hidden &&
    document.querySelectorAll('#zoneGrid .zone-cell').length === 4), { label: '分屏切换' });
  const zoneSlots = await page1.evaluate(() => Array.from(document.querySelectorAll('#zoneGrid .zone-cell')).map(function (c) {
    const f = c.querySelector('iframe');
    return f ? f.getAttribute('data-for') : null;
  }));
  check('zone 指令：进入 2×2 分屏且四格内容正确',
    okZone && JSON.stringify(zoneSlots) === JSON.stringify(['storage-monitor', null, 'env-monitor', 'security-cockpit']), zoneSlots);

  await send([deviceId], 'home');
  const okHome = await waitUntil(() => page1.evaluate(() =>
    !document.getElementById('homeScreen').hidden), { label: '回首页' });
  check('home 指令：回到首页（画面切换，本地操作依旧可用）', okHome);

  /* ---------- 维护类不改模式 + 本地态也可送达 ---------- */
  await send([deviceId], 'refresh');
  await waitUntil(async () => (await deviceOf(deviceId)).desired === null, { label: 'refresh ack' });
  check('维护类指令（refresh）可送达且不改变受控标记', (await deviceOf(deviceId)).managed === true);
  await api('POST', '/api/ctl/release', { targets: [deviceId] });
  await waitUntil(async () => (await deviceOf(deviceId)).managed === false, { label: 'release' });
  await send([deviceId], 'sync');
  const devSync = await deviceOf(deviceId);
  check('本地态收到维护类指令：可送达且不改变模式', devSync.managed === false && devSync.desired && devSync.desired.cmd === 'sync', devSync.desired);

  /* ---------- 页面重开（boot）：回归即本地控制（v6：移除断电重启自动恢复） ---------- */
  await send([deviceId], 'show', { entryId: 'env-monitor' });
  await waitUntil(() => page1.evaluate(() =>
    !!document.querySelector('#frameViewport iframe[data-for="env-monitor"]')), { label: 'show env' });
  await waitUntil(async () => !(await deviceOf(deviceId)).pending, { label: 'ack' });
  await page1.reload({ waitUntil: 'load' });
  const bootLocal = await waitUntil(async () => {
    const d = await deviceOf(deviceId);
    return d.managed === false && d.desired === null ? true : false;
  }, { timeout: 10000, label: '回归即本地' });
  const onHome = await waitUntil(() => page1.evaluate(() =>
    !document.getElementById('homeScreen').hidden), { label: '重开后在首页' });
  check('页面重开（boot）：回归即本地控制（managed=false、停留在首页，不再自动恢复）',
    bootLocal && onHome);

  /* ---------- 控制台：群组下发（全选 home） ---------- */
  // 先把 DEV2 拉回在线（久未心跳会被离线拦截正确跳过）
  await beat2({ state: { mode: 'home' } });
  await page2.click('#btnReload');
  await waitUntil(() => page2.evaluate(() =>
    Array.from(document.querySelectorAll('#deviceList .card'))
      .every((c) => !!c.querySelector('.chip.onl-online'))), { label: '全部在线' });
  await page2.click('#btnAll');
  await page2.click('#btnHome');
  await page2.waitForTimeout(700);
  const both = await Promise.all([deviceOf(deviceId), deviceOf(DEV2)]);
  check('控制台群组下发：两台设备均收到 home 并被接管',
    both.every((d) => d.managed === true && d.desired && d.desired.cmd === 'home'),
    both.map((d) => ({ m: d.managed, c: d.desired && d.desired.cmd })));
  const homeReal = await waitUntil(() => page1.evaluate(() =>
    !document.getElementById('homeScreen').hidden), { label: '显示端真实回首页' });
  check('显示端在群组集合中：真实收到指令回首页', homeReal);

  /* ---------- 取消控制（二次确认） ---------- */
  await page2.click('#btnRelease');
  await page2.waitForTimeout(200);
  const dlgVisible = await page2.evaluate(() => !document.getElementById('mask').hidden);
  check('「取消控制」弹出二次确认', dlgVisible);
  await page2.click('.confirm-btn:has-text("取消控制，交还本地")');
  const released = await waitUntil(async () =>
    (await deviceOf(DEV2)).managed === false && (await deviceOf(deviceId)).managed === false, { label: '两台交还' });
  check('确认后两台设备交还本地控制', released);

  /* ---------- 21.5 现场本地操作脱离指令画面 → 自动回到本地控制，控制台如实显示 ---------- */
  // 控制台对显示端下发 show
  await send([deviceId], 'show', { entryId: 'env-monitor' });
  await waitUntil(() => page1.evaluate(() =>
    !!document.querySelector('#frameViewport iframe[data-for="env-monitor"]')), { label: '接管显示' });
  await waitUntil(async () => !(await deviceOf(deviceId)).pending, { label: 'ack' });
  // 现场本地操作：点「← 返回首页」（Web 被控不锁鼠标）
  await page1.click('#btnBack');
  await waitUntil(() => page1.evaluate(() => !document.getElementById('homeScreen').hidden),
    { label: '本地点击回首页' });
  // 下一拍心跳自动交还 → 服务端 managed=false；控制台 3s 轮询后卡片变「本地控制」
  const relAuto = await waitUntil(async () => (await deviceOf(deviceId)).managed === false,
    { timeout: 10000, label: '自动交还' });
  check('Web 现场本地操作脱离指令画面：设备自动回到本地控制', relAuto);
  await page2.click('#btnReload');
  const localChip = await waitUntil(() => page2.evaluate(() => {
    const pcCard = Array.from(document.querySelectorAll('#deviceList .card'))
      .find((c) => c.querySelector('.kind').textContent === 'PC');
    return pcCard && Array.from(pcCard.querySelectorAll('.chip'))
      .some((x) => x.textContent === '本地控制');
  }), { timeout: 8000, label: '控制台显示本地控制' });
  check('控制台卡片随之显示「本地控制」（无任何脱离角标）', localChip);

  /* ---------- 场景 ---------- */  /* ---------- 场景 ---------- */
  await api('POST', '/api/ctl/release', { targets: [DEV2] }); // 回到本地，快照走 reported
  await beat2({ state: { mode: 'page', entryId: 'storage-monitor' } });
  // 等显示端把「回首页」上报上来（心跳 3s 一拍，快照取的是最近一拍状态）
  await waitUntil(async () => (await deviceOf(deviceId)).reported.mode === 'home', { label: '显示端上报 home' });
  await page2.click('#btnSceneSave');
  await page2.waitForTimeout(200);
  await page2.fill('.modal input[type="text"]', '晨会');
  await page2.click('.modal footer .btn.primary');
  let scene = null;
  const sceneOk = await waitUntil(async () => {
    const list = (await api('GET', '/api/ctl/devices')).json.scenes;
    scene = list.find((s) => s.name === '晨会') || null;
    return !!scene;
  }, { label: '场景落盘' });
  check('存为场景：保存成功且场景条立即出现按钮', sceneOk, scene && scene.name);
  const btnShown = await waitUntil(() => page2.evaluate(() =>
    !!document.querySelector('#sceneList .btn.apply')), { label: '场景按钮' });
  check('场景条渲染「▶晨会」按钮', btnShown);
  const stepTv = scene && scene.steps ? scene.steps.find((s) => s.deviceId === DEV2) : null;
  const stepWeb = scene && scene.steps ? scene.steps.find((s) => s.deviceId === deviceId) : null;
  check('快照内容：本地电视 reported(page) 转 show、显示端 home 转 home',
    !!stepTv && stepTv.cmd === 'show' && stepTv.args.entryId === 'storage-monitor' &&
    !!stepWeb && stepWeb.cmd === 'home', scene && scene.steps);

  // 应用场景：两台自动接管
  await page2.click('#sceneList .btn.apply');
  const applied = await waitUntil(async () => {
    const d2 = await deviceOf(DEV2);
    const d1 = await deviceOf(deviceId);
    return d2.managed === true && d2.desired && d2.desired.cmd === 'show' &&
           d1.managed === true && d1.desired && d1.desired.cmd === 'home';
  }, { label: '场景应用' });
  check('一键应用场景：两台设备自动接管并收到各自指令', applied);

  // 场景重命名 / 删除
  await page2.click('#btnSceneManage');
  await page2.waitForTimeout(200);
  await page2.click('.modal .row .btn:has-text("重命名")');
  await page2.waitForTimeout(200);
  await page2.fill('.modal input[type="text"]', '晨会V2');
  await page2.click('.modal footer .btn.primary');
  const renamed = await waitUntil(async () => {
    const list = (await api('GET', '/api/ctl/devices')).json.scenes;
    return list.length === 1 && list[0].name === '晨会V2';
  }, { label: '重命名' });
  check('场景重命名生效', renamed);
  await page2.click('#btnSceneManage');
  await page2.waitForTimeout(200);
  await page2.click('.modal .row .btn:has-text("删除")');
  await page2.waitForTimeout(200);
  await page2.click('.confirm-btn:has-text("删除")');
  const deleted = await waitUntil(async () =>
    (await api('GET', '/api/ctl/devices')).json.scenes.length === 0, { label: '删除' });
  check('场景删除生效（列表清空）', deleted);

  /* ---------- 重命名（控制台卡片操作） ---------- */
  await page2.click('#btnReload');
  await page2.waitForTimeout(400);
  await page2.evaluate(() => {
    const target = Array.from(document.querySelectorAll('#deviceList .card')).find((c) => c.querySelector('.kind').textContent === 'TV');
    Array.from(target.querySelectorAll('.ops .btn')).find((b) => b.textContent === '重命名').click();
  });
  await page2.waitForTimeout(200);
  // 控制台所有弹窗共用同一遮罩：点击遮罩空白处不应关闭，只能按「保存 / 取消 / 关闭」
  await page2.mouse.click(5, 5);
  const modalAfterOutside = await page2.evaluate(() => !document.getElementById('mask').hidden);
  check('控制台弹窗点击遮罩不关闭', modalAfterOutside);
  await page2.fill('.modal input[type="text"]', '二号电视');
  await page2.click('.modal footer .btn.primary');
  const renamedDev = await waitUntil(async () => (await deviceOf(DEV2)).name === '二号电视', { label: '设备重命名' });
  check('设备重命名生效（服务端与列表同步）', renamedDev);

  /* ---------- 删除设备（暂时移除，下次心跳回归） ---------- */
  await beat2(); // 保证 DEV2 在档案中
  const cardBeforeDel = await waitUntil(() => page2.evaluate(() =>
    !!document.querySelector('[data-device-id="dev-test0002"] .del-btn')), { label: 'DEV2 卡片' });
  await page2.click('[data-device-id="dev-test0002"] .del-btn');
  await page2.click('#modalBox .confirm-btn:has-text("删除")');
  const cardGone = await waitUntil(() => page2.evaluate(() =>
    !document.querySelector('[data-device-id="dev-test0002"]')), { timeout: 6000, label: '删除后卡片消失' });
  const listGone = await waitUntil(async () => !(await deviceOf(DEV2)), { label: '服务端档案移除' });
  check('控制台删除设备：卡片暂时消失且服务端档案移除', cardBeforeDel && cardGone && listGone);

  await beat2();
  const cardBack = await waitUntil(() => page2.evaluate(() =>
    !!document.querySelector('[data-device-id="dev-test0002"]')), { timeout: 8000, label: '心跳后回归' });
  check('设备下次心跳后自动重新出现（临时移除）', cardBack);

  /* ---------- 设备类型点击切换（PC → PAD → TV） ---------- */
  const kindBefore = (await deviceOf(deviceId)).kind;
  await page2.click(`[data-device-id="${deviceId}"] .kind`);
  const toPad = await waitUntil(async () => {
    const k = (await deviceOf(deviceId)).kind;
    const txt = await page2.evaluate((id) =>
      document.querySelector(`[data-device-id="${id}"] .kind`).textContent, deviceId);
    return k === 'tablet' && txt === 'PAD';
  }, { timeout: 6000, label: '类型改 PAD' });
  const padText = await page2.evaluate((id) =>
    document.querySelector(`[data-device-id="${id}"] .kind`).textContent, deviceId);
  check('点击设备类型 PC → PAD 并落盘', kindBefore === 'pc' && !!toPad && padText === 'PAD');

  await page2.click(`[data-device-id="${deviceId}"] .kind`);
  const toTv = await waitUntil(async () => {
    const k = (await deviceOf(deviceId)).kind;
    const txt = await page2.evaluate((id) =>
      document.querySelector(`[data-device-id="${id}"] .kind`).textContent, deviceId);
    return k === 'tv' && txt === 'TV';
  }, { timeout: 6000, label: '类型改 TV' });
  check('再次点击 PAD → TV', !!toTv);
  // 客户端心跳仍上报 pc：手动类型不能被覆盖
  await api('POST', '/api/ctl/beat', {
    deviceId, kind: 'pc', appVersion: '2.0-web', ackedSeq: 0, state: { mode: 'home', turbo: false }
  });
  check('手动设备类型不被心跳上报覆盖', (await deviceOf(deviceId)).kind === 'tv');
  await api('PUT', '/api/ctl/device/' + deviceId, { kind: 'pc' }); // 还原

  /* ---------- 收尾 ---------- */
  check('两页运行期均无 JS 异常与 console 错误', errors.length === 0, errors);

  await browser.close();
  const pass = results.filter((x) => x.pass).length;
  console.log('\n==============================');
  console.log(`合计：${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
