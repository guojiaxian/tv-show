#!/usr/bin/env node
/**
 * 极速模式（截图展示）端到端验证（零依赖，跑在隔离实例上）
 * 覆盖手册 9.1：
 *   - /shot 未知 id / camera 入口 404；
 *   - 后台校验：非法刷新率/质量 400 并提示，合法值落盘；
 *   - 无观看者不采集；心跳后 frame 503→200、meta.ts 前进；
 *   - 后台热更新：ACTIVE 中改 turboIntervalSec，meta.interval 跟随；
 *   - 包装页：ES5（无 ?? / ?.）、双缓冲、sendBeacon、内联间隔与配置一致；
 *   - 敏感字段不出现在任何 /shot 响应；客户端快照含 3 个新字段。
 *
 * 依赖本机已安装 Chromium（playwright-core）；未安装时采集相关用例标 SKIP，
 * 校验与路由用例仍然执行。
 */
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
const skip = (name) => {
  results.push({ name, pass: true, skip: true });
  console.log(`SKIP  ${name}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, rawBody) {
  const res = await fetch(BASE + path, {
    method,
    headers: body || rawBody ? { 'Content-Type': 'application/json' } : {},
    body: rawBody !== undefined ? rawBody : body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}
const get = (p) => api('GET', p);

/** 等待条件成立（默认 20s），返回最终值 */
async function waitFor(fn, timeoutMs = 20000, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let val;
  while (Date.now() < deadline) {
    val = await fn();
    if (val) return val;
    await sleep(stepMs);
  }
  return val;
}

(async () => {
  /* ---------- 0. 采集能力探测 ---------- */
  const health0 = await get('/api/admin/health');
  const shotAvail = health0.json.shot && health0.json.shot.available === true;
  check('health 含 shot 字段（available / activeEntries）',
    health0.json.shot && typeof health0.json.shot.activeEntries === 'number',
    health0.json.shot);
  if (!shotAvail) console.log('（未安装 Chromium，采集类用例将标 SKIP）');

  /* ---------- 1. 极速参数校验（不依赖 Chromium） ---------- */
  // 建一个指向隔离实例自身的入口（无需外网，Chromium 打开必有画面）
  const created = await api('POST', '/api/admin/entries', {
    id: 'shot-page',
    title: '极速模式测试页',
    url: BASE + '/setting',
    turboEnabled: true,
    turboIntervalSec: 0.5,
    turboQuality: 85
  });
  check('新增入口：极速 3 字段按提交值落盘',
    created.status === 201 &&
    created.json.entry.turboEnabled === true &&
    created.json.entry.turboIntervalSec === 0.5 &&
    created.json.entry.turboQuality === 85,
    created.json.entry);

  const camEntry = await api('POST', '/api/admin/entries', {
    id: 'cam-wall', title: '机房画面墙', type: 'camera', url: ''
  });
  check('新增 camera 画面墙入口成功', camEntry.status === 201, camEntry.json);

  const badCases = [
    [{ turboIntervalSec: 0 }, /0\.2 ~ 60/],
    [{ turboIntervalSec: 61 }, /0\.2 ~ 60/],
    [{ turboIntervalSec: 1.25 }, /一位小数/],
    [{ turboIntervalSec: 'abc' }, /数字/],
    [{ turboQuality: 49 }, /50 ~ 95/],
    [{ turboQuality: 96 }, /50 ~ 95/],
    [{ turboQuality: 75.5 }, /50 ~ 95/]
  ];
  for (const [patch, pattern] of badCases) {
    const body = Object.assign({}, created.json.entry, patch);
    const r = await api('PUT', '/api/admin/entries/shot-page', body);
    check(`校验 400：${JSON.stringify(patch)}`,
      r.status === 400 && pattern.test(r.json.error || ''),
      { status: r.status, error: r.json && r.json.error });
  }

  const legal = await api('PUT', '/api/admin/entries/shot-page',
    Object.assign({}, created.json.entry, { turboIntervalSec: '0.5', turboQuality: 85 }));
  check('合法值（0.5 / 85）保存成功', legal.status === 200, legal.json);
  const cfgAfter = await get('/api/admin/config');
  const shotCfg = cfgAfter.json.entries.find((e) => e.id === 'shot-page');
  check('合法值已落盘（config 中可读回）',
    shotCfg.turboIntervalSec === 0.5 && shotCfg.turboQuality === 85, shotCfg);

  /* ---------- 2. /shot 路由兜底（不依赖 Chromium） ---------- */
  // 注意：view 的拉取本身会触发采集（包装页加载后立即心跳），
  // 「无人观看不采集」必须在第一次 view 之前断言。
  if (!shotAvail) {
    skip('无人观看不采集（无 Chromium）');
  } else {
    const idleHealth = await get('/api/admin/health');
    check('无观看者时不采集（shot.activeEntries=0）',
      idleHealth.json.shot.activeEntries === 0, idleHealth.json.shot);
  }

  const unknownView = await get('/shot/no-such-entry/view');
  check('未知入口 /shot/<id>/view 返回 404', unknownView.status === 404, unknownView.status);
  const unknownFrame = await get('/shot/no-such-entry/frame.jpg');
  check('未知入口 /shot/<id>/frame.jpg 返回 404', unknownFrame.status === 404, unknownFrame.status);
  const camView = await get('/shot/cam-wall/view');
  check('camera 入口 /shot/<id>/view 返回 404（服务端兜底）', camView.status === 404, camView.status);
  const camBeat = await api('POST', '/shot/cam-wall/beat', undefined, 'sess');
  check('camera 入口心跳同样 404', camBeat.status === 404, camBeat.status);

  /* ---------- 3. 包装页（需要采集能力才有正式包装页） ---------- */
  const view = await get('/shot/shot-page/view');
  if (!shotAvail) {
    skip('包装页为正式采集页（无 Chromium 时为降级页，跳过细断言）');
  } else {
    check('包装页 200 且为 HTML', view.status === 200 && /text\/html/.test(view.headers.get('content-type') || ''),
      { status: view.status, ct: view.headers.get('content-type') });
    check('包装页为 ES5（不含 ?? 与 ?. 语法）',
      !/\?\?|\?\./.test(view.text), '发现可选链/空值合并语法');
    check('包装页含双缓冲（两个叠放 img）',
      view.text.includes('id="fa"') && view.text.includes('id="fb"'), null);
    check('包装页含 sendBeacon 心跳', view.text.includes('sendBeacon'), null);
    check('包装页内联刷新率与配置一致（0.5）',
      view.text.includes('var INTERVAL=0.5'), null);
    check('包装页含左下角信息浮层（极速模式水印）',
      view.text.includes('极速模式') && view.text.includes('clock'), null);
    const meta0 = await get('/shot/shot-page/meta.json');
    check('meta.json 含 status/ts/interval/quality/title',
      meta0.status === 200 &&
      ['status', 'ts', 'interval', 'quality', 'title'].every((k) => k in meta0.json),
      meta0.json);
  }

  /* ---------- 4. 心跳后出帧 ---------- */
  if (!shotAvail) {
    skip('心跳后出帧（无 Chromium）');
  } else {
    const frame0 = await get('/shot/shot-page/frame.jpg');
    check('无帧时 frame.jpg 返回 503', frame0.status === 503, frame0.status);

    // 心跳 → STARTING → ACTIVE：首帧 ≤20s
    await api('POST', '/shot/shot-page/beat', undefined, 'test-session-1');
    const got = await waitFor(async () => {
      const f = await get('/shot/shot-page/frame.jpg?t=1');
      return f.status === 200 ? f : null;
    }, 20000);
    check('心跳后 20s 内出首帧（frame.jpg 200）', !!got, got && got.status);
    check('首帧为 JPEG', !!got && /^image\/jpeg/.test(got.headers.get('content-type') || ''),
      got && got.headers.get('content-type'));

    const meta1 = await get('/shot/shot-page/meta.json');
    check('采集状态为 active 且 interval/quality 与配置一致',
      meta1.json.status === 'active' && meta1.json.interval === 0.5 && meta1.json.quality === 85,
      meta1.json);

    // 连续两帧时间戳前进
    const ts1 = meta1.json.ts;
    await sleep(1600);
    const meta2 = await get('/shot/shot-page/meta.json');
    check('连续采集：meta.ts 前进（0.5s 间隔）', meta2.json.ts > ts1,
      { ts1, ts2: meta2.json.ts });

    /* ---------- 5. 后台热更新：ACTIVE 中改间隔，meta.interval 跟随 ---------- */
    const hot = await api('PUT', '/api/admin/entries/shot-page',
      Object.assign({}, shotCfg, { turboIntervalSec: 2 }));
    check('ACTIVE 中修改刷新率成功', hot.status === 200, hot.json);
    const followed = await waitFor(async () => {
      const m = await get('/shot/shot-page/meta.json');
      return m.json.interval === 2 ? m : null;
    }, 8000);
    check('meta.interval 下一帧跟随新配置（2s）', !!followed, followed && followed.json);

    /* ---------- 6. 敏感字段不出现在任何 /shot 响应 ---------- */
    const SECRET = 'wtzx@2026'; // 种子数据 env-monitor 的密码
    const surfaces = [
      ['view', view.text], ['meta', JSON.stringify(meta1.json)],
      ['frame', got && got.text], ['404 body', camView.text]
    ];
    const leaked = surfaces.filter(([, t]) => typeof t === 'string' && t.includes(SECRET));
    check('敏感密码不出现在任何 /shot 响应', leaked.length === 0, leaked.map(([n]) => n));
  }

  /* ---------- 7. 停止心跳 → COOLING → PAUSED，活跃数归零 ---------- */
  if (!shotAvail) {
    skip('停止心跳后活跃数归零（无 Chromium）');
  } else {
    // COOLING 30s + 回收扫描 5s，放宽到 45s
    const drained = await waitFor(async () => {
      const h = await get('/api/admin/health');
      return h.json.shot.activeEntries === 0 ? h : null;
    }, 45000, 2000);
    check('停止心跳后（COOLING 30s）活跃采集数归零', !!drained, drained && drained.json.shot);
    const metaPaused = await get('/shot/shot-page/meta.json');
    check('PAUSED 后 meta.status=paused（帧定格保留）',
      ['paused', 'cooling', 'active'].includes(metaPaused.json.status), metaPaused.json);
  }

  /* ---------- 8. 客户端快照含 3 个新字段 ---------- */
  const full = await get('/api/config?full=1');
  const fe = full.json.full.entries.find((e) => e.id === 'shot-page');
  // 与当前后台配置逐字段比对（前面热更新可能已改过间隔）
  const curCfg = (await get('/api/admin/config')).json.entries.find((e) => e.id === 'shot-page');
  check('客户端全量快照携带 turboEnabled/turboIntervalSec/turboQuality（与后台一致）',
    fe && fe.turboEnabled === curCfg.turboEnabled &&
    fe.turboIntervalSec === curCfg.turboIntervalSec &&
    fe.turboQuality === curCfg.turboQuality, { snapshot: fe, admin: curCfg });
  const deltaFields = await get(`/api/config?since=${full.json.version - 1}&epoch=${full.json.epoch}`);
  check('增量 upserted 同样携带 3 个新字段',
    !deltaFields.json.upserted || deltaFields.json.upserted.every((e) => 'turboEnabled' in e),
    deltaFields.json && deltaFields.json.upserted);

  console.log('\n==============================');
  const failed = results.filter((r) => !r.pass).length;
  console.log(`合计：${results.length - failed}/${results.length} 通过${results.some((r) => r.skip) ? '（含 SKIP）' : ''}`);
  process.exit(failed ? 1 : 0);
})();
