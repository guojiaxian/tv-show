#!/usr/bin/env node
/**
 * 多设备互控 · Web 客户端端到端验证（Playwright 驱动真实浏览器）
 * P2 受控半边：注册心跳 / 指令应用（show·rotate·zone·home）/ 锁定与角标 /
 *             模式开关（含退出二次确认）/ boot 恢复 / 断线意图暂存与补送。
 * P3/P4 用例（设备控制 screen 与场景）后续追加。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('/root/.pwtest/node_modules/playwright-core');

// 动态探测已安装的 Chromium（版本号随升级变化）
const PW_DIR = '/root/.cache/ms-playwright';
const EXEC = fs.readdirSync(PW_DIR)
  .filter((d) => /^chromium-\d+$/.test(d))
  .sort()
  .map((d) => `${PW_DIR}/${d}/chrome-linux64/chrome`)
  .find((p) => fs.existsSync(p));
const BASE = process.env.BASE;
if (!BASE) {
  console.error('本脚本会改写服务端数据，必须跑在隔离实例上：node server/test-run.mjs');
  process.exit(1);
}
const OUT = '/tmp/ctl-ui-test';
fs.mkdirSync(OUT, { recursive: true });

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

/** 轮询页面直到谓词为真（设备 3s 一拍心跳，给足余量） */
async function waitUntil(fn, { timeout = 9000, interval = 300, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).split('\n')[0]));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return; // 非目标是页的 HTTP 噪音
    // 只记录客户端自身页面（主 frame）的脚本错误；走代理的目标大屏页面与客户端
    // 同源（这正是代理的意义），其报错须按路径前缀排除；客户端自身不用 WebSocket
    const loc = (m.location() && m.location().url) || '';
    if (loc.startsWith(BASE + '/proxy/') || loc.startsWith(BASE + '/cam/') || loc.startsWith(BASE + '/shot/')) return;
    if (/^WebSocket connection/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });

  await page.goto(BASE + '/', { waitUntil: 'load' });

  /* ---------- 1. 打开即注册 ---------- */
  const ok1 = await waitUntil(async () => !!(await page.evaluate(() => localStorage.getItem('tvshow.deviceId'))),
    { timeout: 6000, label: 'deviceId 生成' });
  const deviceId = await page.evaluate(() => localStorage.getItem('tvshow.deviceId'));
  const ok1b = await waitUntil(async () => {
    const d = await deviceOf(deviceId);
    return !!(d && d.reported && d.reported.mode === 'home');
  }, { label: '注册并上报 home' });
  const dev1 = await deviceOf(deviceId);
  check('打开页面即注册为受控设备并上报状态',
    ok1 && ok1b && /^dev-[0-9a-f]{8}$/.test(deviceId), { deviceId, dev1 });
  check('桌面浏览器自报 kind=pc，初始本地控制（managed=false）',
    dev1 && dev1.kind === 'pc' && dev1.managed === false, dev1);

  /* ---------- 2. 下发 show → 切展示页并自动接管 ---------- */
  await send([deviceId], 'show', { entryId: 'storage-monitor' });
  const ok2 = await waitUntil(() => page.evaluate(() =>
    !document.getElementById('displayScreen').hidden &&
    !!document.querySelector('#frameViewport iframe[data-for="storage-monitor"]')), { label: 'show 切换' });
  const ui2 = await page.evaluate(() => ({
    locked: document.body.classList.contains('ctl-locked'),
    badge: !document.getElementById('ctlBadge').hidden,
    remote: document.getElementById('csRemote').classList.contains('on-remote')
  }));
  const dev2ok = await waitUntil(async () => {
    const d = await deviceOf(deviceId);
    return d.managed === true && d.reported.mode === 'page' && d.reported.entryId === 'storage-monitor';
  }, { label: 'reported=page' });
  check('show 指令：切换到指定页面（iframe data-for）', ok2);
  check('show 指令自动进入远程被控（锁定 + 角标 + 开关高亮）',
    ui2.locked && ui2.badge && ui2.remote, ui2);
  check('服务端视角 managed=true 且 reported.mode=page', dev2ok);

  /* ---------- 3. 受控锁定：展示操作不可用 ---------- */
  const lock3 = await page.evaluate(() => ({
    grid: getComputedStyle(document.getElementById('grid')).pointerEvents,
    frame: getComputedStyle(document.getElementById('frameViewport')).pointerEvents,
    btnRotation: getComputedStyle(document.getElementById('btnRotation')).pointerEvents,
    ctlSwitch: getComputedStyle(document.getElementById('ctlSwitch')).pointerEvents
  }));
  check('锁定生效：卡片/iframe/顶栏按钮不可点，模式开关例外可用',
    lock3.grid === 'none' && lock3.frame === 'none' && lock3.btnRotation === 'none' && lock3.ctlSwitch !== 'none', lock3);
  // 快捷键被拦截（M 键不弹菜单）
  await page.keyboard.press('m');
  await page.waitForTimeout(300);
  const menuOpen = await page.evaluate(() => {
    const d = document.getElementById('dialogLayer');
    return d && !d.hidden;
  });
  check('锁定生效：快捷键 M 被拦截（不弹控制菜单）', menuOpen === false);

  /* ---------- 4. 开关退出（二次确认 → 确认） ---------- */
  await page.click('#ctlSwitch');
  await page.waitForTimeout(200);
  const dlgVisible = await page.evaluate(() => !document.getElementById('dialogLayer').hidden);
  check('退出远程被控弹出二次确认', dlgVisible);
  await page.click('.dialog .item:has-text("退出，恢复本地操作")');
  const ui4 = await page.evaluate(() => ({
    locked: document.body.classList.contains('ctl-locked'),
    badge: document.getElementById('ctlBadge').hidden,
    local: document.getElementById('csLocal').classList.contains('on-local')
  }));
  check('确认后本机立即解锁（不等网络）', !ui4.locked && ui4.badge && ui4.local, ui4);
  const dev4ok = await waitUntil(async () => (await deviceOf(deviceId)).managed === false, { label: 'managed=false' });
  check('意图随心跳送达：服务端 managed=false、desired 清空', dev4ok);

  /* ---------- 5. 再下发 → 自动切回受控 ---------- */
  await send([deviceId], 'show', { entryId: 'env-monitor' });
  const ok5 = await waitUntil(() => page.evaluate(() =>
    document.body.classList.contains('ctl-locked') &&
    !!document.querySelector('#frameViewport iframe[data-for="env-monitor"]')), { label: '再接管' });
  check('本地态再收展示指令 → 自动切回远程被控并切页', ok5);

  /* ---------- 6. 二次确认的取消路径 ---------- */
  await page.click('#ctlSwitch');
  await page.waitForTimeout(200);
  await page.click('.dialog .item:has-text("继续远程被控")');
  await page.waitForTimeout(200);
  const stillLocked = await page.evaluate(() => document.body.classList.contains('ctl-locked'));
  check('确认弹层选「继续远程被控」→ 保持被控不退出', stillLocked);

  /* ---------- 7. rotate 指令 ---------- */
  await api('POST', '/api/ctl/release', { targets: [deviceId] });
  await waitUntil(async () => (await deviceOf(deviceId)).managed === false, { label: 'release' });
  await waitUntil(() => page.evaluate(() => !document.body.classList.contains('ctl-locked')), { label: '解锁' });
  await send([deviceId], 'rotate', { intervalSec: 5, items: ['storage-monitor', 'env-monitor'] });
  const ok7 = await waitUntil(() => page.evaluate(() =>
    document.getElementById('rotationChip').classList.contains('show')), { label: '轮询启动' });
  const ls7 = await page.evaluate(() => JSON.parse(localStorage.getItem('tvshow.localSettings') || '{}').rotation);
  const dev7ok = await waitUntil(async () => {
    const d = await deviceOf(deviceId);
    return d.reported.mode === 'rotate' && d.reported.rotate &&
      JSON.stringify(d.reported.rotate.items) === JSON.stringify(['storage-monitor', 'env-monitor']);
  }, { label: 'reported=rotate' });
  const dev7 = await deviceOf(deviceId);
  check('rotate 指令：写入本机轮询设置并进入轮询播放',
    ok7 && ls7 && ls7.intervalSec === 5 &&
    JSON.stringify(ls7.items) === JSON.stringify(['storage-monitor', 'env-monitor']), ls7);
  check('服务端视角 reported.mode=rotate（含 items 序列）', dev7ok, dev7.reported);

  /* ---------- 8. zone 指令 ---------- */
  await send([deviceId], 'zone', { slots: ['storage-monitor', null, 'env-monitor', 'security-cockpit'] });
  const ok8 = await waitUntil(() => page.evaluate(() =>
    !document.getElementById('zoneScreen').hidden &&
    document.querySelectorAll('#zoneGrid .zone-cell').length === 4), { label: '分屏切换' });
  const zone8 = await page.evaluate(() => Array.from(document.querySelectorAll('#zoneGrid .zone-cell')).map(function (c) {
    const f = c.querySelector('iframe');
    return f ? f.getAttribute('data-for') : null;
  }));
  const dev8ok = await waitUntil(async () => {
    const d = await deviceOf(deviceId);
    return d.reported.mode === 'zone' && d.reported.zone &&
      JSON.stringify(d.reported.zone.slots) === JSON.stringify(['storage-monitor', null, 'env-monitor', 'security-cockpit']);
  }, { label: 'reported=zone' });
  check('zone 指令：进入 2×2 分屏且四格内容正确',
    ok8 && JSON.stringify(zone8) === JSON.stringify(['storage-monitor', null, 'env-monitor', 'security-cockpit']), zone8);
  check('服务端视角 reported.mode=zone（含 slots）', dev8ok);

  /* ---------- 9. home 指令与维护类不改模式 ---------- */
  await send([deviceId], 'home');
  await waitUntil(() => page.evaluate(() => !document.getElementById('homeScreen').hidden), { label: '回首页' });
  const ui9 = await page.evaluate(() => ({
    locked: document.body.classList.contains('ctl-locked')
  }));
  check('home 指令：回首页并保持受控（受控停在首页）', ui9.locked, ui9);
  await send([deviceId], 'refresh');
  await waitUntil(async () => (await deviceOf(deviceId)).desired === null, { label: 'refresh ack' });
  const dev9 = await deviceOf(deviceId);
  check('维护类指令（refresh）不改变受控模式', dev9.managed === true, dev9);

  /* ---------- 10. 交还后维护类在本地态也可用 ---------- */
  await api('POST', '/api/ctl/release', { targets: [deviceId] });
  await waitUntil(async () => (await deviceOf(deviceId)).managed === false, { label: 'release2' });
  await send([deviceId], 'sync');
  const dev10 = await deviceOf(deviceId);
  check('本地态收到维护类指令：可送达且不改变模式', dev10.managed === false && dev10.desired && dev10.desired.cmd === 'sync', dev10);

  /* ---------- 11. boot 恢复 ---------- */
  await send([deviceId], 'show', { entryId: 'env-monitor' });
  await waitUntil(() => page.evaluate(() =>
    !!document.querySelector('#frameViewport iframe[data-for="env-monitor"]')), { label: 'show env' });
  await waitUntil(async () => {
    const d = await deviceOf(deviceId);
    return !d.pending;
  }, { label: 'ack' });
  await page.reload({ waitUntil: 'load' });
  const ok11 = await waitUntil(() => page.evaluate(() =>
    document.body.classList.contains('ctl-locked') &&
    !!document.querySelector('#frameViewport iframe[data-for="env-monitor"]')), { timeout: 12000, label: 'boot 恢复' });
  check('页面重开（boot）自动恢复受控画面（managed + bootRestore）', ok11);

  /* ---------- 12. 断线意图暂存与补送 ---------- */
  await page.route('**/api/ctl/beat', (route) => route.abort());
  await page.waitForTimeout(3600); // 覆盖一拍失败（failStreak=1 → 退避 6s）
  await page.click('#ctlSwitch');
  await page.waitForTimeout(200);
  await page.click('.dialog .item:has-text("退出，恢复本地操作")');
  const ui12 = await page.evaluate(() => ({
    locked: document.body.classList.contains('ctl-locked')
  }));
  const dev12 = await deviceOf(deviceId);
  check('断线时拨开关：本机立即解锁（影子即时生效）', !ui12.locked, ui12);
  check('断线时意图暂存：服务端仍认为受控', dev12.managed === true, dev12);
  await page.unroute('**/api/ctl/beat');
  const ok12 = await waitUntil(async () => (await deviceOf(deviceId)).managed === false,
    { timeout: 25000, label: '意图补送' });
  check('恢复网络后意图自动送达：服务端 managed=false', ok12);

  /* ---------- 13. 页面无 JS 异常 ---------- */
  check('运行期无 JS 异常与 console 错误', errors.length === 0, errors);

  await browser.close();
  const pass = results.filter((x) => x.pass).length;
  console.log('\n==============================');
  console.log(`合计：${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
