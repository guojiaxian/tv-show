#!/usr/bin/env node
/**
 * 服务端 API 端到端验证（零依赖，直接打真实 HTTP 接口）
 * 覆盖：健康检查、全量、304、增量(meta/upserted/deletedIds)、排序、
 *       epoch 强制全量、参数校验、404、持久化。
 */
const BASE = process.env.BASE;
if (!BASE) {
  console.error('本脚本会改写服务端数据，必须跑在隔离实例上：node server/test-run.mjs');
  process.exit(1);
}
import { readFileSync } from 'node:fs';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log('      ' + JSON.stringify(detail));
};

async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 响应 */ }
  return { status: res.status, headers: res.headers, json, text };
}

const get = (p, h) => api('GET', p, null, h);

(async () => {
  /* ---------- 0. 页面路由（单端口 18000，无 404 / 无错页） ---------- */
  const fetchPage = async (p) => {
    const res = await fetch(BASE + p, { redirect: 'manual' });
    const text = res.status === 200 ? await res.text() : '';
    return { status: res.status, ct: res.headers.get('content-type') || '', text };
  };
  const isHtml = (r) => r.status === 200 && /text\/html/.test(r.ct);

  // 三个页面各取一个只属于自己的特征串，避免「路由指错页」也能蒙混过关
  const MARK_CLIENT = 'tvshow.localSettings';
  const MARK_ADMIN = '大屏聚合平台 · 管理后台';
  const MARK_PREVIEW = '虚拟遥控器';

  const rootPage = await fetchPage('/');
  check('根路径 / 是电脑端客户端首页（不再是管理后台）',
    isHtml(rootPage) && rootPage.text.includes(MARK_CLIENT) &&
    !rootPage.text.includes(MARK_ADMIN),
    { status: rootPage.status, ct: rootPage.ct });

  const settingPage = await fetchPage('/setting');
  check('/setting 是管理页面',
    isHtml(settingPage) && settingPage.text.includes(MARK_ADMIN) &&
    !settingPage.text.includes(MARK_CLIENT),
    { status: settingPage.status, ct: settingPage.ct });

  const previewPage = await fetchPage('/preview');
  check('/preview 是电视端预览页面',
    // 预览页也有「本机设置」（同一套 localStorage 键），故只与「虚拟遥控器」和后台标题做区分
    isHtml(previewPage) && previewPage.text.includes(MARK_PREVIEW) &&
    !previewPage.text.includes(MARK_ADMIN),
    { status: previewPage.status, ct: previewPage.ct, len: previewPage.text.length });

  const aliasPages = await Promise.all(['/app', '/client', '/index.html'].map(fetchPage));
  check('/app、/client、/index.html 均可访问客户端首页',
    aliasPages.every((r) => isHtml(r) && r.text.includes(MARK_CLIENT)),
    aliasPages.map((r) => r.status));

  const adminAliases = await Promise.all(['/admin', '/setting/index.html'].map(fetchPage));
  check('/admin、/setting/index.html 均可访问管理页面',
    adminAliases.every((r) => isHtml(r) && r.text.includes(MARK_ADMIN)),
    adminAliases.map((r) => r.status));

  const trailing = await fetchPage('/setting/');
  check('尾斜杠 /setting/ 归一化后仍指向管理页面',
    isHtml(trailing) && trailing.text.includes(MARK_ADMIN), { status: trailing.status });

  const previewAlias = await fetchPage('/preview.html');
  check('/preview.html 为预览页别名',
    isHtml(previewAlias) && previewAlias.text.includes(MARK_PREVIEW), { status: previewAlias.status });

  const unknown = await fetchPage('/no-such-page');
  check('未知页面路径返回 404（路由不吞错）', unknown.status === 404, { status: unknown.status });

  /* ---------- 1. 健康检查与初始状态 ---------- */
  const health = await get('/api/admin/health');
  check('健康检查返回 ok 且含版本信息',
    health.status === 200 && health.json.ok === true &&
    typeof health.json.version === 'number' && typeof health.json.epoch === 'number',
    health.json);
  const v0 = health.json.version;
  const e0 = health.json.epoch;

  /* ---------- 2. 首次拉取（无 since）返回全量 ---------- */
  const first = await get('/api/config');
  check('无 since 的首次拉取返回全量配置',
    first.status === 200 && !!first.json.full && first.json.version === v0 &&
    Array.isArray(first.json.full.entries) && first.json.full.entries.length === 3,
    { status: first.status, keys: Object.keys(first.json || {}), n: first.json?.full?.entries?.length });
  const etag0 = first.headers.get('etag');
  check('响应带 ETag', !!etag0, etag0);

  /* ---------- 3. 无变更 → 304 ---------- */
  const notModified1 = await get(`/api/config?since=${v0}`);
  check('since 等于当前版本时返回 304（空 body）',
    notModified1.status === 304 && notModified1.text === '', { status: notModified1.status, text: notModified1.text });

  const notModified2 = await get('/api/config', { 'If-None-Match': etag0 });
  check('If-None-Match 命中时返回 304',
    notModified2.status === 304, { status: notModified2.status });

  /* ---------- 4. 修改系统标题 → 增量含 meta ---------- */
  const newTitle = '数智中心大屏聚合平台（改造验证）';
  const putMeta = await api('PUT', '/api/admin/meta', { appTitle: newTitle });
  check('修改系统标题成功且版本递增',
    putMeta.status === 200 && putMeta.json.version === v0 + 1 && putMeta.json.meta.appTitle === newTitle,
    putMeta.json);

  const deltaMeta = await get(`/api/config?since=${v0}&epoch=${e0}`);
  check('增量下发包含 meta（标题），且不下发未变更条目',
    deltaMeta.status === 200 && deltaMeta.json.meta &&
    deltaMeta.json.meta.appTitle === newTitle &&
    !deltaMeta.json.upserted && !deltaMeta.json.deletedIds,
    deltaMeta.json);

  /* ---------- 5. 新增页面 → 增量含 upserted ---------- */
  const v1 = putMeta.json.version;
  const created = await api('POST', '/api/admin/entries', {
    id: 'new-dashboard',
    title: '新增测试大屏',
    subtitle: '用于验证增量下发',
    url: 'http://10.8.11.99:8080/',
    accent: '#8B7CFF',
    icon: 'env',
    scale: 90,
    autoFit: true,
    autoLogin: { enabled: true, username: 'u1', password: 'p1', usernameSelector: '#u', passwordSelector: '#p', submitSelector: '#b' }
  });
  check('新增页面成功（id/字段回显正确）',
    created.status === 201 && created.json.entry.id === 'new-dashboard' &&
    created.json.entry.scale === 90 && created.json.entry.autoLogin.username === 'u1',
    created.json);

  const deltaAdd = await get(`/api/config?since=${v1}&epoch=${e0}`);
  check('增量下发只包含新增的那 1 个条目',
    deltaAdd.status === 200 && deltaAdd.json.upserted && deltaAdd.json.upserted.length === 1 &&
    deltaAdd.json.upserted[0].id === 'new-dashboard' && !deltaAdd.json.meta,
    { upsertedN: deltaAdd.json?.upserted?.length, ids: deltaAdd.json?.upserted?.map((e) => e.id) });

  /* ---------- 6. 更新页面 ---------- */
  const v2 = created.json.version;
  const updated = await api('PUT', '/api/admin/entries/new-dashboard', {
    title: '新增测试大屏（已改名）',
    subtitle: 's',
    url: 'http://10.8.11.98:8080/',
    accent: '#3FE0A6',
    icon: 'security',
    scale: 0,
    autoFit: false,
    allowInsecureSsl: true
  });
  check('更新页面成功（autoLogin 被移除、allowInsecureSsl 生效）',
    updated.status === 200 && updated.json.entry.title === '新增测试大屏（已改名）' &&
    updated.json.entry.allowInsecureSsl === true && !updated.json.entry.autoLogin,
    updated.json.entry);

  const deltaUpdate = await get(`/api/config?since=${v2}&epoch=${e0}`);
  check('增量下发包含被更新的条目',
    deltaUpdate.json.upserted && deltaUpdate.json.upserted.length === 1 &&
    deltaUpdate.json.upserted[0].url === 'http://10.8.11.98:8080/',
    deltaUpdate.json.upserted);

  /* ---------- 7. 排序 ---------- */
  const v3 = updated.json.version;
  const order = await get('/api/admin/config');
  const ids = order.json.entries.map((e) => e.id);
  const reversed = ids.slice().reverse();
  const reorder = await api('POST', '/api/admin/entries/reorder', { ids: reversed });
  check('排序成功，服务端顺序与请求一致',
    reorder.status === 200 &&
    (await get('/api/admin/config')).json.entries.map((e) => e.id).join(',') === reversed.join(','),
    { reversed });

  const deltaOrder = await get(`/api/config?since=${v3}&epoch=${e0}`);
  check('排序后增量下发完整顺序（order），且不重复下发未变更条目',
    !!deltaOrder.json && Array.isArray(deltaOrder.json.order) &&
    deltaOrder.json.order.join(',') === reversed.join(',') &&
    !deltaOrder.json.upserted,
    { status: deltaOrder.status, body: deltaOrder.json });

  /* ---------- 8. 删除 → 增量含 deletedIds ---------- */
  const v4 = reorder.json.version;
  const del = await api('DELETE', '/api/admin/entries/new-dashboard');
  check('删除页面成功',
    del.status === 200 && del.json.deleted === 'new-dashboard', del.json);

  const deltaDel = await get(`/api/config?since=${v4}&epoch=${e0}`);
  check('增量下发包含 deletedIds 且条目已从 upserted 中消失',
    deltaDel.json.deletedIds && deltaDel.json.deletedIds.indexOf('new-dashboard') >= 0 &&
    !(deltaDel.json.upserted || []).some((e) => e.id === 'new-dashboard'),
    deltaDel.json);

  const afterDel = await get(`/api/config?full=1`);
  check('删除后全量中不再包含该条目',
    !afterDel.json.full.entries.some((e) => e.id === 'new-dashboard'),
    afterDel.json.full.entries.map((e) => e.id));

  /* ---------- 9. epoch bump → 强制全量 ---------- */
  const v5 = del.json.version;
  const bump = await api('POST', '/api/admin/epoch/bump');
  check('epoch bump 成功且 epoch 递增',
    bump.status === 200 && bump.json.epoch === e0 + 1, bump.json);

  const afterBump = await get(`/api/config?since=${v5}&epoch=${e0}`);
  check('旧 epoch 的增量请求被降级为全量（保证一致性）',
    afterBump.status === 200 && !!afterBump.json.full, { keys: Object.keys(afterBump.json || {}) });

  const afterBumpNewEpoch = await get(`/api/config?since=${bump.json.version}&epoch=${bump.json.epoch}`);
  check('新 epoch 且版本一致时返回 304',
    afterBumpNewEpoch.status === 304, { status: afterBumpNewEpoch.status });

  /* ---------- 10. 参数校验 ---------- */
  const noUrl = await api('POST', '/api/admin/entries', { title: 'x', url: '' });
  check('缺 URL 返回 400 且带明确错误', noUrl.status === 400 && /URL/.test(noUrl.json.error), noUrl.json);

  const badUrl = await api('POST', '/api/admin/entries', { title: 'x', url: 'ftp://a' });
  check('非 http(s) 的 URL 返回 400', badUrl.status === 400 && /http/.test(badUrl.json.error), badUrl.json);

  const badColor = await api('POST', '/api/admin/entries', { title: 'x', url: 'http://a.com', accent: 'red' });
  check('非法主题色返回 400', badColor.status === 400 && /主题色/.test(badColor.json.error), badColor.json);

  const badScale = await api('POST', '/api/admin/entries', { title: 'x', url: 'http://a.com', scale: 10 });
  check('越界缩放返回 400', badScale.status === 400 && /缩放/.test(badScale.json.error), badScale.json);

  const dupId = await api('POST', '/api/admin/entries', { id: 'storage-monitor', title: 'x', url: 'http://a.com' });
  check('重复 id 返回 400', dupId.status === 400 && /已存在/.test(dupId.json.error), dupId.json);

  const noPwd = await api('POST', '/api/admin/entries', {
    title: 'x', url: 'http://a.com', autoLogin: { enabled: true, username: 'u' }
  });
  check('启用自动登录但无密码返回 400', noPwd.status === 400 && /密码/.test(noPwd.json.error), noPwd.json);

  const badTitle = await api('PUT', '/api/admin/meta', { appTitle: '' });
  check('空标题返回 400', badTitle.status === 400, badTitle.json);

  /* ---------- 11. 404 ---------- */
  const missing = await api('PUT', '/api/admin/entries/not-exist', { title: 'x', url: 'http://a.com' });
  check('更新不存在的入口返回 404', missing.status === 404, missing.json);

  const badPath = await get('/api/nope');
  check('未知接口返回 404', badPath.status === 404, badPath.json);

  /* ---------- 11.5 请求体保护（413 / 非法 JSON） ---------- */
  const hugeRes = await fetch(BASE + '/api/admin/entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x'.repeat(300 * 1024), url: 'http://a.com' })
  });
  const hugeText = await hugeRes.text().catch(() => '');
  let hugeJson = null;
  try { hugeJson = hugeText ? JSON.parse(hugeText) : null; } catch (e) { /* 非 JSON */ }
  check('请求体超限返回 413 且错误可读',
    hugeRes.status === 413 && hugeJson && /过大/.test(hugeJson.error || ''),
    { status: hugeRes.status, body: hugeText.slice(0, 120) });

  const badJsonRes = await fetch(BASE + '/api/admin/meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json'
  });
  const badJsonText = await badJsonRes.text().catch(() => '');
  let badJsonBody = null;
  try { badJsonBody = badJsonText ? JSON.parse(badJsonText) : null; } catch (e) { /* 非 JSON */ }
  check('非法 JSON 返回 400 且错误可读',
    badJsonRes.status === 400 && badJsonBody && /JSON/.test(badJsonBody.error || ''),
    { status: badJsonRes.status, body: badJsonText.slice(0, 120) });

  /* ---------- 12. 非法更新不应破坏数据 ---------- */
  const before = (await get('/api/admin/health')).json;
  await api('POST', '/api/admin/entries', { title: '', url: 'http://a.com' });
  const after = (await get('/api/admin/health')).json;
  check('校验失败不改变版本与条目数（数据未被破坏）',
    before.version === after.version && before.entries === after.entries,
    { before: { v: before.version, n: before.entries }, after: { v: after.version, n: after.entries } });

  /* ---------- 13. 数据落盘可读 ---------- */
  // 读隔离实例自己的数据目录（test-run.mjs 通过 TVSHOW_DATA_DIR 指定），不碰线上数据
  const dataDir = process.env.TVSHOW_DATA_DIR || '/root/applications/tv-show/server/data';
  const onDisk = JSON.parse(readFileSync(`${dataDir}/config.json`, 'utf8'));
  check('数据已持久化到 data/config.json 且版本一致',
    onDisk.version === after.version && Array.isArray(onDisk.entries),
    { diskVersion: onDisk.version, serverVersion: after.version });

  /* ---------- 14. 恢复初始标题 ---------- */
  const restore = await api('PUT', '/api/admin/meta', { appTitle: '数智中心大屏聚合平台' });
  check('标题可恢复', restore.status === 200 && restore.json.meta.appTitle === '数智中心大屏聚合平台', restore.json.meta);

  /* ---------- 15. 职责边界：轮询与分区属于客户端本机设置，服务端不提供 ---------- */
  const full = (await get('/api/config')).json.full;
  check('客户端配置只含内容（标题 + 页面列表），不含轮询与分区',
    !('rotation' in full) && !('zones' in full) &&
    ['appTitle', 'appSubtitle', 'exitConfirm', 'exitTip', 'entries'].every((k) => k in full),
    Object.keys(full));

  const removedRoutes = [
    ['GET', '/api/rotation/status'],
    ['GET', '/api/admin/rotation'],
    ['PUT', '/api/admin/rotation'],
    ['POST', '/api/admin/rotation/reset'],
    ['GET', '/api/zones/status'],
    ['GET', '/api/admin/zones'],
    ['POST', '/api/admin/zones']
  ];
  const removedResults = await Promise.all(
    removedRoutes.map(([m, p]) => api(m, p, m === 'GET' ? null : {}))
  );
  const stillThere = removedRoutes.filter((_, i) => removedResults[i].status !== 404).map(([, p]) => p);
  check('已移除的轮询/分区接口全部返回 404',
    stillThere.length === 0, stillThere);

  const adminConfig = (await get('/api/admin/config')).json;
  check('管理端配置也不再含轮询与分区字段',
    !('rotation' in adminConfig) && !('zones' in adminConfig),
    { keys: Object.keys(adminConfig).filter((k) => /rot|zone/i.test(k)) });

  console.log('\n==============================');
  const failed = results.filter((r) => !r.pass).length;
  console.log(`合计：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
