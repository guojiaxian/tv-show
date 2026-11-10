#!/usr/bin/env node
/**
 * 页面改版探测验证（server/page-watch.js）
 *
 * 用本地 HTTP 服务模拟「目标大屏页面」：
 *  - 有 ETag 的页面：ETag 变化 = 页面重新发布；
 *  - 无 ETag 的页面：正文变化需连续两轮一致才确认（避免实时数据误判）；
 *  - 正文持续变化（实时数据页面）：判定为不可靠并停止探测。
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPageWatch } = require('./page-watch.js');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log('      ' + JSON.stringify(detail));
};

let etag = '"v1"';
let noValidator = false;
let body = '<html>A</html>';

const httpServer = createServer((req, res) => {
  if (noValidator) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(body);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html', ETag: etag });
  res.end('<html>v1</html>');
});

await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const port = httpServer.address().port;
const url = `http://127.0.0.1:${port}/page`;

const changes = [];
const watch = createPageWatch({
  getEntries: () => [{ id: 'demo', type: 'url', url }, { id: 'wall', type: 'camera', url: '' }],
  onChange: (id) => { changes.push(id); },
  log: () => {}
});

try {
  /* 1. 首次探测：只记基线 */
  await watch.probeAll();
  const first = watch.snapshot();
  check('首次探测记录页面指纹', !!first.demo && first.demo.length > 0, first);
  check('画面墙入口不参与探测（无 URL）', first.wall === undefined, first);
  check('首次探测不触发重载回调（只记基线）', changes.length === 0, changes);
  check('探测状态可上报（周期/已探测数/时间）',
    watch.status().watched === 1 && watch.status().lastProbeAt > 0, watch.status());

  /* 2. ETag 不变：不触发 */
  await watch.probeAll();
  check('页面未变（ETag 相同）不触发重载', changes.length === 0, changes);

  /* 3. 页面重新发布（ETag 变化）：触发一次，指纹更新 */
  etag = '"v2"';
  await watch.probeAll();
  const second = watch.snapshot();
  check('页面重新发布后指纹变化', second.demo !== first.demo, { before: first.demo, after: second.demo });
  check('指纹变化触发一次重载回调', changes.length === 1 && changes[0] === 'demo', changes);

  /* 4. 无 ETag：正文取样，连续两轮一致才确认改版 */
  noValidator = true;
  body = '<html>B</html>';
  await watch.probeAll(); // 进入正文模式（记基线）
  check('无校验头页面进入正文取样模式', !!watch.snapshot().demo, watch.snapshot());
  body = '<html>C</html>';
  await watch.probeAll(); // 第一轮新内容：待确认
  check('正文变化首轮只进入待确认（不立即重载）', changes.length === 1, changes);
  await watch.probeAll(); // 第二轮仍为 C：确认改版
  check('正文连续两轮一致后确认改版并触发重载', changes.length === 2, changes);

  /* 5. 实时数据页面（正文每轮都变）：判定不可靠后停止探测 */
  let n = 0;
  const changesBefore = changes.length;
  for (let i = 0; i < 6; i++) {
    body = `<html>tick-${++n}</html>`;
    await watch.probeAll();
  }
  check('正文持续变化时停止探测（不反复触发重载）',
    changes.length - changesBefore <= 1 && watch.snapshot().demo === undefined,
    { changes: changes.length - changesBefore, pages: watch.snapshot() });
} finally {
  watch.stop();
  await new Promise((resolve) => httpServer.close(resolve));
}

const pass = results.filter((r) => r.pass).length;
console.log('\n==============================');
console.log(`合计：${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
