/**
 * 管理后台端到端验证（Playwright 驱动真实浏览器）
 * 覆盖：系统标题修改、新增页面、编辑、上移下移排序、删除、表单校验错误提示、
 *       以及每一步之后 /api/admin/config 与客户端接口是否一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadChromium, launchOptions } from './test-pw.mjs';

const loaded = loadChromium();
if (!loaded) {
  console.log('SKIP 未安装 playwright-core / Chromium，跳过管理后台浏览器验证');
  process.exit(0);
}

const BASE = process.env.BASE;
if (!BASE) {
  console.error('本脚本会改写服务端数据，必须跑在隔离实例上：node server/test-run.mjs');
  process.exit(1);
}
const OUT = '/tmp/admin-test';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log('      ' + JSON.stringify(detail));
};

const apiGet = async (p) => (await fetch(BASE + p)).json();

(async () => {
  const browser = await loaded.chromium.launch(launchOptions(loaded));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).split('\n')[0]));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // 校验用例会故意触发 400，浏览器会为任何非 2xx 响应打一条控制台记录，
    // 这类 HTTP 状态噪音不算 JS 报错，予以过滤。
    if (/Failed to load resource/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  // 自动确认 confirm 弹窗
  page.on('dialog', (d) => d.accept());

  // 管理页面的专用路径是 /setting（首页 / 已改为电脑端客户端）
  await page.goto(BASE + '/setting', { waitUntil: 'load' });
  await page.waitForTimeout(700);

  /* ---------- 1. 页面加载与初始渲染 ---------- */
  const init = await page.evaluate(() => ({
    title: document.querySelector('header h1').textContent,
    version: document.getElementById('stVersion').textContent,
    rows: document.querySelectorAll('#tbody tr').length,
    appTitle: document.getElementById('appTitle').value,
    hasEmptyTip: getComputedStyle(document.getElementById('emptyTip')).display
  }));
  const cfg0 = await apiGet('/api/admin/config');
  check('后台加载成功并渲染出全部页面行',
    init.title.indexOf('管理后台') >= 0 && init.rows === cfg0.entries.length && init.rows === 3,
    init);
  check('顶部状态栏与系统设置回显服务端数据',
    init.version === 'v' + cfg0.version && init.appTitle === cfg0.appTitle, init);
  await page.screenshot({ path: OUT + '/1-admin.png', fullPage: true });

  /* ---------- 2. 修改系统标题 ---------- */
  const newTitle = '数智中心大屏聚合平台 · 联调';
  await page.fill('#appTitle', newTitle);
  await page.click('#btnSaveMeta');
  await page.waitForTimeout(800);
  const afterMeta = await apiGet('/api/admin/config');
  const metaUi = await page.evaluate(() => ({
    version: document.getElementById('stVersion').textContent,
    saved: document.getElementById('metaDirty').textContent,
    titleVal: document.getElementById('appTitle').value
  }));
  check('修改系统标题后服务端已更新且版本递增',
    afterMeta.appTitle === newTitle && afterMeta.version === cfg0.version + 1 &&
    metaUi.version === 'v' + afterMeta.version && metaUi.saved === '',
    { appTitle: afterMeta.appTitle, version: afterMeta.version, metaUi });

  const clientAfterMeta = await apiGet('/api/config?full=1');
  check('客户端接口同步反映新标题（电视端可获取到）',
    clientAfterMeta.full.appTitle === newTitle, clientAfterMeta.full.appTitle);

  /* ---------- 3. 新增页面 ---------- */
  await page.click('#btnNew');
  await page.waitForTimeout(300);
  const modalShown = await page.evaluate(() => document.getElementById('mask').classList.contains('show'));
  check('点击新增弹出表单', modalShown, modalShown);

  await page.fill('#fTitle', '联调测试大屏');
  await page.fill('#fSubtitle', '由管理后台创建');
  await page.fill('#fUrl', 'http://10.8.11.77:9090/');
  await page.selectOption('#fIcon', 'security');
  await page.fill('#fAccent', '#8B7CFF');
  await page.fill('#fScale', '110');
  await page.check('#fLoginEnabled');
  await page.fill('#fUsername', 'ops');
  await page.fill('#fPassword', 'ops@2026');
  await page.fill('#fUserSel', '#user');
  await page.fill('#fPwdSel', '#pass');
  await page.fill('#fSubmitSel', '#login');
  await page.click('#btnSave');
  await page.waitForTimeout(900);

  const afterCreate = await apiGet('/api/admin/config');
  const created = afterCreate.entries.find((e) => e.title === '联调测试大屏');
  check('新增页面成功且字段完整落库',
    !!created && created.url === 'http://10.8.11.77:9090/' && created.icon === 'security' &&
    created.accent === '#8B7CFF' && created.scale === 110 &&
    created.autoLogin && created.autoLogin.username === 'ops' &&
    created.autoLogin.submitSelector === '#login',
    created);

  const rowsAfterCreate = await page.evaluate(() => document.querySelectorAll('#tbody tr').length);
  check('后台列表同步出现新行', rowsAfterCreate === 4, rowsAfterCreate);
  await page.screenshot({ path: OUT + '/2-after-create.png', fullPage: true });

  /* ---------- 4. 编辑页面 ---------- */
  const targetRow = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#tbody tr'));
    const idx = rows.findIndex((r) => r.querySelector('.title').textContent.indexOf('联调测试大屏') >= 0);
    return idx;
  });
  await page.evaluate((i) => {
    const rows = document.querySelectorAll('#tbody tr');
    Array.from(rows[i].querySelectorAll('button')).find((b) => b.textContent === '编辑').click();
  }, targetRow);
  await page.waitForTimeout(400);

  const editPrefill = await page.evaluate(() => ({
    title: document.getElementById('fTitle').value,
    idDisabled: document.getElementById('fId').disabled,
    url: document.getElementById('fUrl').value
  }));
  check('编辑弹层正确回填且 ID 不可改',
    editPrefill.title === '联调测试大屏' && editPrefill.idDisabled === true &&
    editPrefill.url === 'http://10.8.11.77:9090/', editPrefill);

  await page.fill('#fTitle', '联调测试大屏（已改名）');
  await page.uncheck('#fLoginEnabled');
  await page.click('#btnSave');
  await page.waitForTimeout(900);
  const afterEdit = await apiGet('/api/admin/config');
  const edited = afterEdit.entries.find((e) => e.id === (created && created.id));
  check('编辑保存生效，且取消自动登录后该字段被移除',
    !!edited && edited.title === '联调测试大屏（已改名）' && !edited.autoLogin,
    edited);

  /* ---------- 5. 排序（上移） ---------- */
  const beforeOrder = (await apiGet('/api/admin/config')).entries.map((e) => e.id);
  const lastIdx = beforeOrder.length - 1;
  await page.evaluate((i) => {
    const rows = document.querySelectorAll('#tbody tr');
    Array.from(rows[i].querySelectorAll('button')).find((b) => b.textContent === '上移').click();
  }, lastIdx);
  await page.waitForTimeout(900);
  const afterOrder = (await apiGet('/api/admin/config')).entries.map((e) => e.id);
  const expectOrder = beforeOrder.slice();
  const tmp = expectOrder[lastIdx]; expectOrder[lastIdx] = expectOrder[lastIdx - 1]; expectOrder[lastIdx - 1] = tmp;
  check('上移按钮改变了服务端顺序', afterOrder.join(',') === expectOrder.join(','),
    { beforeOrder, afterOrder, expectOrder });

  const uiOrder = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#tbody tr')).map((r) => r.querySelector('.idx').textContent));
  check('后台列表序号重新编号', uiOrder.join(',') === ['1', '2', '3', '4'].join(','), uiOrder);

  /* ---------- 6. 表单校验错误提示 ---------- */
  await page.click('#btnNew');
  await page.waitForTimeout(300);
  await page.fill('#fTitle', '缺地址的页面');
  await page.fill('#fUrl', 'ftp://bad');
  await page.click('#btnSave');
  await page.waitForTimeout(800);
  const errToast = await page.evaluate(() => {
    const t = document.querySelector('.toast.err');
    return t ? t.textContent : '';
  });
  const stillOpen = await page.evaluate(() => document.getElementById('mask').classList.contains('show'));
  check('非法 URL 被拦截并给出明确错误提示，弹层保持打开',
    /http/.test(errToast) && stillOpen === true, { errToast, stillOpen });
  await page.screenshot({ path: OUT + '/3-validation.png' });

  await page.fill('#fUrl', '');
  await page.click('#btnSave');
  await page.waitForTimeout(800);
  const urlErr = await page.evaluate(() => {
    const t = document.querySelector('.toast.err');
    return t ? t.textContent : '';
  });
  check('缺 URL 时给出「URL 不能为空」提示', /URL/.test(urlErr), urlErr);

  await page.click('#btnCancel');
  await page.waitForTimeout(300);

  /* ---------- 7. 删除 ---------- */
  const beforeDel = (await apiGet('/api/admin/config')).entries.length;
  const delIdx = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#tbody tr'));
    return rows.findIndex((r) => r.querySelector('.title').textContent.indexOf('联调测试大屏') >= 0);
  });
  await page.evaluate((i) => {
    const rows = document.querySelectorAll('#tbody tr');
    Array.from(rows[i].querySelectorAll('button')).find((b) => b.textContent === '删除').click();
  }, delIdx);
  // 删除改为页面自定义二次确认弹层（不再是原生 confirm）
  await page.waitForSelector('#confirmMask.show', { timeout: 3000 });
  await page.click('#confirmOk');
  await page.waitForTimeout(1000);
  const afterDel = await apiGet('/api/admin/config');
  const rowsAfterDel = await page.evaluate(() => document.querySelectorAll('#tbody tr').length);
  check('删除后服务端与后台列表都已移除',
    afterDel.entries.length === beforeDel - 1 && rowsAfterDel === beforeDel - 1 &&
    !afterDel.entries.some((e) => e.title.indexOf('联调测试大屏') >= 0),
    { before: beforeDel, after: afterDel.entries.length, rows: rowsAfterDel });

  /* ---------- 8. 删除会下发给客户端（tombstone） ---------- */
  const delta = await apiGet('/api/config?since=1&epoch=' + afterDel.epoch);
  check('删除痕迹可通过客户端增量接口下发',
    !delta.full && Array.isArray(delta.deletedIds) && delta.deletedIds.length >= 1,
    { hasFull: !!delta.full, deletedIds: delta.deletedIds });

  /* ---------- 9. 强制全量刷新 ---------- */
  const epochBefore = (await apiGet('/api/admin/health')).epoch;
  await page.click('#btnBump');
  await page.waitForSelector('#confirmMask.show', { timeout: 3000 });
  await page.click('#confirmOk');
  await page.waitForTimeout(900);
  const epochAfter = (await apiGet('/api/admin/health')).epoch;
  const uiEpoch = await page.evaluate(() => document.getElementById('stEpoch').textContent);
  check('强制全量刷新使 epoch 递增并同步到界面',
    epochAfter === epochBefore + 1 && uiEpoch === String(epochAfter),
    { epochBefore, epochAfter, uiEpoch });

  /* ---------- 10. 恢复初始标题，避免留下测试数据 ---------- */
  await page.fill('#appTitle', '数智中心大屏聚合平台');
  await page.click('#btnSaveMeta');
  await page.waitForTimeout(800);
  const final = await apiGet('/api/admin/config');
  check('测试数据已清理（标题恢复、测试页面已删除）',
    final.appTitle === '数智中心大屏聚合平台' &&
    final.entries.length === 3 && final.tombstones.length >= 1,
    { appTitle: final.appTitle, entries: final.entries.length, tombstones: final.tombstones.length });

  /* ---------- 12. 数据文件权限：配置含明文口令，必须 0600 ---------- */
  const dataDir = process.env.TVSHOW_DATA_DIR;
  const modeOf = (name) => {
    try {
      return (fs.statSync(path.join(dataDir, name)).mode & 0o777).toString(8).padStart(4, '0');
    } catch (e) {
      return 'missing';
    }
  };
  check('config.json 与备份权限为 0600',
    modeOf('config.json') === '0600' && modeOf('config.json.bak') === '0600',
    { config: modeOf('config.json'), backup: modeOf('config.json.bak') });

  /* ---------- 13. 无 JS 报错 ---------- */
  check('后台运行期无 JS 报错', errors.length === 0, errors);

  await browser.close();

  console.log('\n====================================');
  const failed = results.filter((r) => !r.pass).length;
  console.log(`合计：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
