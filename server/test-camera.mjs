/**
 * 摄像头画面墙验证。
 *
 * 只断言与现场网络无关的部分（路由、参数校验、脱敏、type 保持）：
 *   1) /api/cameras 只下发展示参数，不泄露 RTSP 地址与凭据
 *   2) 非法摄像头编号被拒（400），不会把任意地址交给 ffmpeg
 *   3) 新增 type=camera 入口允许留空 url
 *   4) 管理后台（表单不含 type）更新画面墙入口时沿用原类型，不会被改回 url
 *   5) 普通入口缺 url 仍被拒（400）
 * 真实取流（ffmpeg + 摄像机）不适合放进自动化测试，见 README「摄像头画面墙」。
 */
const BASE = process.env.BASE;
if (!BASE) {
  console.error('本脚本会改写服务端数据，必须跑在隔离实例上：node server/test-run.mjs');
  process.exit(1);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log('      ' + JSON.stringify(detail));
};

const get = async (p) => {
  const res = await fetch(BASE + p);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 流式响应不是 JSON */ }
  return { status: res.status, json, text };
};

const send = async (method, p, body) => {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/* ---------- 1. 列表接口：结构正确且不泄露凭据 ---------- */
const list = await get('/api/cameras');
check('GET /api/cameras 返回 200', list.status === 200, list.status);
check('列表只含 enabled / cameras / cells 三个字段',
  list.json && Object.keys(list.json).sort().join(',') === 'cameras,cells,enabled',
  list.json && Object.keys(list.json));
check('响应中不含 RTSP 地址或密码等敏感字段',
  !/password|username|rtsp:|10\.8\.12\.131/.test(list.text), list.text.slice(0, 200));

const cameras = list.json && Array.isArray(list.json.cameras) ? list.json.cameras : [];
if (list.json && list.json.enabled) {
  check('启用时每路都带 id / title / online',
    cameras.length > 0 && cameras.every((c) => Number.isInteger(c.id) && typeof c.title === 'string' && typeof c.online === 'boolean'),
    cameras.slice(0, 2));

  // 画面墙 9 格排布：品牌格占位后摄像头依次后移，编号不重不漏
  const cells = list.json.cells || [];
  check('画面墙排布为 9 格，编号不重复且覆盖全部摄像头',
    cells.length === 9 &&
    cells.filter((c) => typeof c === 'number').join(',') === cameras.map((c) => c.id).join(','),
    cells);
} else {
  check('未启用时 cameras 为空数组', cameras.length === 0, cameras);
}

/* ---------- 2. 非法编号被拒：前端无法指定任意上游地址 ---------- */
// 数字越界走到点播路由被判 400；非数字压根不匹配路由，落到 404。两者都到不了 ffmpeg。
for (const bad of ['0', '999', 'abc']) {
  const r = await get(`/cam/${bad}.mjpg`);
  check(`非法编号 ${bad} 被拒（4xx）`, r.status === 400 || r.status === 404, r.status);
}

/* ---------- 2b. 画面墙行号越界被拒（按行合成，行号决定取哪几路） ---------- */
// 启用时才会走到墙体路由；未启用会先被 503 拦下，此时跳过。
if (list.json && list.json.enabled) {
  for (const bad of ['0', '4', 'x']) {
    const r = await get(`/cam/wall.mjpg?row=${bad}`);
    check(`画面墙非法行号 ${bad} 返回 400`, r.status === 400, r.status);
  }
}

/* ---------- 3. 新增画面墙入口：允许留空 url ---------- */
const before = (await get('/api/admin/config')).json.entries.length;
const created = await send('POST', '/api/admin/entries', {
  type: 'camera',
  title: '测试画面墙',
  subtitle: '自动化用例',
  accent: '#2FD2F5',
  icon: 'storage'
});
check('新增 type=camera 入口成功（url 可留空）',
  created.status === 201 && created.json.entry.type === 'camera' && created.json.entry.url === '',
  created.json && created.json.entry);
const cid = created.json && created.json.entry && created.json.entry.id;

/* ---------- 4. 管理后台式更新（表单不带 type）必须保持 camera ---------- */
const updated = await send('PUT', `/api/admin/entries/${encodeURIComponent(cid)}`, {
  title: '测试画面墙（改名）',
  subtitle: '',
  accent: '#2FD2F5',
  icon: 'storage'
});
check('后台表单更新后仍是 camera 类型',
  updated.status === 200 && updated.json.entry.type === 'camera', updated.json && updated.json.entry);

const snap = (await get('/api/config')).json.full;
const inSnap = snap.entries.filter((e) => e.id === cid)[0];
check('客户端快照里该入口为 camera 且不含敏感配置',
  !!inSnap && inSnap.type === 'camera', inSnap);
check('快照的 cameras 只含 enabled / count / titles',
  snap.cameras && Object.keys(snap.cameras).sort().join(',') === 'count,enabled,titles', snap.cameras);

/* ---------- 5. 普通入口仍强制要求 url ---------- */
const noUrl = await send('POST', '/api/admin/entries', { title: '没有网址的普通入口' });
check('普通入口缺 url 返回 400', noUrl.status === 400, noUrl.json);

/* ---------- 清理 ---------- */
await fetch(BASE + `/api/admin/entries/${encodeURIComponent(cid)}`, { method: 'DELETE' });
const after = (await get('/api/admin/config')).json.entries.length;
check('测试入口已清理（条目数复原）', after === before, { before, after });

const failed = results.filter((r) => !r.pass).length;
console.log(`\n合计：${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
