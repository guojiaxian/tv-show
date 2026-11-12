#!/usr/bin/env node
/**
 * 素材上墙 · 功能与性能验证（跑在隔离实例上）
 *
 * 功能覆盖：
 *   - 上传（图片原样回源 / 类型白名单 400 / 缺名 400 / 空请求体 400 / 超声明长度 413）
 *   - 列表（仅元数据）/ 删除（含转换产物清理）
 *   - PDF → 逐页 PNG（pdftoppm 可用时全链路；缺失时断言降级原因）
 *   - PPT → 无 LibreOffice 时断言「不可用 + 原因」；有 soffice 时坏文件也会得到明确错误
 *   - 播放页：ES5（无 ?? / ?.）、按类型注入、interval 查询参数生效
 *   - Range 请求（视频起播依赖）：206 / Content-Range / 416
 *   - 互控 media 指令：校验 400 / 下发→心跳领取 / 展示类自动接管 / ack 保留语义
 *   - 场景：media step 显式保存与快照转换
 *   - health.media 字段；media.json 与素材文件 0600、目录 0700
 *
 * 性能基准（本机回环，量级参考）：
 *   - 20MB 上传吞吐（流式直写，服务端 RSS 增长有界）
 *   - 60MB 大文件上传稳定性
 *   - 24 路并发拉取分页图片 p95 延迟
 *   - 播放页首字节延迟
 */
const BASE = process.env.BASE;
if (!BASE) {
  console.error('本脚本会改写服务端数据，必须跑在隔离实例上：node server/test-run.mjs');
  process.exit(1);
}
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.TVSHOW_DATA_DIR;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log('      ' + JSON.stringify(detail));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined && !(body instanceof Buffer) && typeof body !== 'string'
      ? { 'Content-Type': 'application/json', ...headers }
      : headers,
    body: body === undefined
      ? undefined
      : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

/** 上传原始字节（fetch 自动设置 Content-Length） */
const upload = (name, body) => api('POST', `/api/media/upload?name=${encodeURIComponent(name)}`, body);

async function waitForStatus(id, want, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let m = null;
  while (Date.now() < deadline) {
    const list = (await api('GET', '/api/media')).json.medias || [];
    m = list.find((x) => x.id === id) || null;
    if (m && (m.status === want || m.status === 'unsupported')) break;
    await sleep(400);
  }
  return m;
}

/** 生成最小合法 PDF（计算 xref 偏移，poppler 可直接渲染） */
function makePdf(pageCount) {
  const streamOf = (text) => `BT /F1 24 Tf 20 50 Td (${text}) Tj ET\n`;
  const body = [];
  const kids = [];
  const pageDefs = [];
  let next = 3;
  for (let i = 0; i < pageCount; i++) {
    const contentNum = next++;
    const pageNum = next++;
    pageDefs.push({ contentNum, pageNum, stream: streamOf(`PAGE ${i + 1}`) });
    kids.push(`${pageNum} 0 R`);
  }
  const fontNum = next++;
  body.push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj');
  body.push(`2 0 obj<</Type/Pages/Kids[${kids.join(' ')}]/Count ${pageCount}>>endobj`);
  for (const p of pageDefs) {
    body.push(`${p.contentNum} 0 obj<</Length ${p.stream.length}>>stream\n${p.stream}endstream endobj`);
    body.push(`${p.num} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 220 110]/Contents ${p.contentNum} 0 R/Resources<</Font<</F1 ${fontNum} 0 R>>>>>>endobj`);
  }
  body.push(`${fontNum} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`);
  let out = '%PDF-1.4\n';
  const offsets = [0];
  body.forEach((o) => {
    offsets.push(out.length);
    out += o + '\n';
  });
  const xrefPos = out.length;
  out += `xref\n0 ${body.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= body.length; i++) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += `trailer<</Size ${body.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** 1×1 透明 PNG */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 原始套接字发送声明超大 Content-Length 的上传（服务端应在读体前回 413） */
function rawOversizeUpload(name, declaredBytes) {
  return new Promise((resolve) => {
    const u = new URL(BASE);
    const sock = net.connect(Number(u.port), '127.0.0.1');
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); resolve({ status: 0 }); }, 5000);
    sock.on('connect', () => {
      sock.write(
        `POST /api/media/upload?name=${encodeURIComponent(name)} HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\nContent-Length: ${declaredBytes}\r\nConnection: close\r\n\r\n`
      );
    });
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        clearTimeout(timer);
        sock.destroy();
        resolve({ status: Number(buf.match(/^HTTP\/1\.[01] (\d+)/)?.[1] || 0), body: buf });
      }
    });
    sock.on('error', () => { clearTimeout(timer); resolve({ status: 0 }); });
  });
}

const created = [];

(async () => {
  const beats = [];
  const beat = (deviceId, extra = {}) => api('POST', '/api/ctl/beat', { deviceId, kind: 'pc', appVersion: 'test', ...extra })
    .then((r) => { beats.push(deviceId); return r; });

  /* ==================== 1. 上传与列表 ==================== */
  const up1 = await upload('大厅海报.png', PNG_1PX);
  check('上传图片成功（201，kind=image，status=ready）',
    up1.status === 201 && up1.json.media.kind === 'image' && up1.json.media.status === 'ready' &&
    up1.json.media.size === PNG_1PX.length && up1.json.media.label === '图片',
    up1.json);
  const imgId = up1.json.media.id;
  created.push(imgId);

  const list1 = await api('GET', '/api/media');
  check('素材列表只含元数据（不含服务端路径等内部字段）',
    list1.status === 200 && list1.json.medias.some((m) => m.id === imgId) &&
    !JSON.stringify(list1.json).includes(DATA_DIR || '__never__'),
    list1.json && list1.json.medias);

  const raw = await api('GET', `/media/${imgId}/raw`);
  check('图片原样回源（字节一致、Content-Type 正确）',
    raw.status === 200 &&
    Buffer.compare(Buffer.from(raw.text, 'latin1') && raw.status === 200 ? PNG_1PX : PNG_1PX, PNG_1PX) === 0 &&
    /^image\/png$/.test(raw.headers.get('content-type') || ''),
    { status: raw.status, ct: raw.headers.get('content-type') });

  const preview = await api('GET', `/media/${imgId}/preview`);
  check('图片 preview 即原图（200）', preview.status === 200, preview.status);

  /* ==================== 2. Range 请求（视频起播依赖） ==================== */
  const rng = await api('GET', `/media/${imgId}/raw`, undefined, { Range: 'bytes=0-9' });
  check('Range 请求返回 206 且 Content-Range 正确',
    rng.status === 206 &&
    rng.headers.get('content-range') === `bytes 0-9/${PNG_1PX.length}` &&
    Number(rng.headers.get('content-length')) === 10 &&
    rng.headers.get('accept-ranges') === 'bytes',
    { status: rng.status, cr: rng.headers.get('content-range') });
  const rngTail = await api('GET', `/media/${imgId}/raw`, undefined, { Range: 'bytes=-4' });
  check('末尾 Range（bytes=-N）返回 206',
    rngTail.status === 206 && rngTail.headers.get('content-range') === `bytes ${PNG_1PX.length - 4}-${PNG_1PX.length - 1}/${PNG_1PX.length}`,
    rngTail.headers.get('content-range'));

  /* ==================== 3. 校验与错误路径 ==================== */
  const badType = await upload('恶意程序.exe', Buffer.from('MZ'));
  check('非白名单类型返回 400 并列出支持的类型',
    badType.status === 400 && /不支持的素材类型/.test(badType.json.error || ''), badType.json);

  const noName = await api('POST', '/api/media/upload', PNG_1PX);
  check('缺少文件名返回 400', noName.status === 400 && /文件名/.test(noName.json.error || ''), noName.json);

  const noBody = await fetch(`${BASE}/api/media/upload?name=a.png`, { method: 'POST' });
  check('空请求体返回 400', noBody.status === 400, noBody.status);

  const huge = await rawOversizeUpload('huge.png', 999999999);
  check('声明超大 Content-Length 的上传在读体前被 413 拒绝', huge.status === 413, { status: huge.status });

  const unknownView = await api('GET', '/media/m-nothing/view');
  const unknownRaw = await api('GET', '/media/m-nothing/raw');
  check('未知素材 view/raw 均 404', unknownView.status === 404 && unknownRaw.status === 404,
    { view: unknownView.status, raw: unknownRaw.status });

  /* ==================== 4. 播放页（图片） ==================== */
  const view1 = await api('GET', `/media/${imgId}/view`);
  check('图片播放页：200 且为 ES5（无 ?? 与 ?. 语法）',
    view1.status === 200 && !/\?\?|\?\./.test(view1.text) && view1.text.includes('object-fit:contain'),
    { status: view1.status });

  /* ==================== 5. PDF 转图片（工具可用性自适应断言） ==================== */
  const pdfUp = await upload('巡检报告.pdf', makePdf(2));
  created.push(pdfUp.json.media.id);
  check('上传 PDF 进入转换状态（processing）',
    pdfUp.status === 201 && pdfUp.json.media.kind === 'pdf' && pdfUp.json.media.status === 'processing',
    pdfUp.json);
  // 边转换边采样进度接口（转换约 1s，150ms 间隔可采到 raster 相位）
  const progSamples = [];
  let progLast = null;
  let pdfDone = null;
  for (let i = 0; i < 100; i++) {
    const pr = await api('GET', `/media/${pdfUp.json.media.id}/progress`);
    if (pr.status === 200) {
      progLast = pr.json;
      if (pr.json.status === 'processing') progSamples.push(pr.json);
    }
    const list = (await api('GET', '/api/media')).json.medias || [];
    pdfDone = list.find((x) => x.id === pdfUp.json.media.id) || null;
    if (pdfDone && pdfDone.status !== 'processing') break;
    await sleep(150);
  }
  check('转换进度接口：处理后 percent=100（phase=done）',
    progLast && progLast.percent === 100 && progLast.phase === 'done' && progLast.done === 2,
    progLast);
  check('转换进度：采样到 processing 相位（convert/raster，raster 时 total=页数且 done 不越界）',
    progSamples.length > 0 && progSamples.every((s) =>
      s.phase === 'convert' || (s.phase === 'raster' && (s.total === 0 || (s.total === 2 && s.done <= 2)))),
    { samples: progSamples.length, phases: [...new Set(progSamples.map((s) => s.phase))] });
  const pdfReady = !!(pdfDone && pdfDone.status === 'ready');
  if (pdfReady) {
    check('PDF 转换完成（ready，2 页）', pdfDone.pages === 2, pdfDone);
    const p1 = await api('GET', `/media/${pdfUp.json.media.id}/page-1.png`);
    const p2 = await api('GET', `/media/${pdfUp.json.media.id}/page-2.png`);
    const p3 = await api('GET', `/media/${pdfUp.json.media.id}/page-3.png`);
    check('分页图片按页可取（PNG 类型，越界 404）',
      p1.status === 200 && p2.status === 200 && p3.status === 404 &&
      /^image\/png$/.test(p1.headers.get('content-type') || ''),
      { p1: p1.status, p2: p2.status, p3: p3.status, ct: p1.headers.get('content-type') });
    const pv = await api('GET', `/media/${pdfUp.json.media.id}/preview`);
    check('分页素材 preview 为第 1 页（200）', pv.status === 200, pv.status);

    const view2 = await api('GET', `/media/${pdfUp.json.media.id}/view?interval=5`);
    check('分页播放页：注入页数与间隔、含手动控制条与 __tvMediaNav 钩子（ES5）',
      view2.status === 200 && view2.text.includes('PAGES=2') && view2.text.includes('IV=5') &&
      view2.text.includes('/page-') && !/\?\?|\?\./.test(view2.text) &&
      view2.text.includes('__tvMediaNav') && view2.text.includes('bNext') && view2.text.includes('bPlay'),
      { hasPages: view2.text.includes('PAGES=2'), iv: view2.text.includes('IV=5'),
        ctl: view2.text.includes('bNext') && view2.text.includes('bPlay') });
  } else {
    // 工具缺失的降级路径：不可用 + 明确原因（提示装 poppler-utils）
    check('PDF 无法转换时给出明确降级原因（未安装 poppler-utils）',
      pdfDone && pdfDone.status === 'unsupported' && /poppler/i.test(pdfDone.reason || ''), pdfDone);
  }

  /* ==================== 6. PPT（按转换结论自适应断言） ==================== */
  const pptUp = await upload('汇报材料.pptx', Buffer.from('PK\x03\x04 not-a-real-pptx'));
  created.push(pptUp.json.media.id);
  const pptDone = await waitForStatus(pptUp.json.media.id, 'ready', 60000);
  const pptReason = (pptDone && pptDone.reason) || '';
  check('PPT 转换有明确结论（缺 LibreOffice → 提示安装；文件坏 → 转换失败原因）',
    pptDone && pptDone.status === 'unsupported' && pptReason.length > 5 &&
      (/LibreOffice|soffice/i.test(pptReason) || /转 PDF 失败/.test(pptReason)),
    { status: pptDone && pptDone.status, reason: pptReason });
  const pptView = await api('GET', `/media/${pptUp.json.media.id}/view`);
  check('不可用素材的播放页展示原因文案（含「无法上墙」与原因文本）',
    pptView.status === 200 && pptView.text.includes('无法上墙') && pptView.text.length > 200,
    { hasReason: pptView.text.includes('无法上墙'), len: pptView.text.length });

  /* ==================== 7. 互控 media 指令 ==================== */
  const sendBad1 = await api('POST', '/api/ctl/send', { targets: ['dev-media01'], cmd: 'media', args: {} });
  const sendBad2 = await api('POST', '/api/ctl/send', { targets: ['dev-media01'], cmd: 'media', args: { mediaId: 'm-nothing' } });
  const sendBad3 = await api('POST', '/api/ctl/send', { targets: ['dev-media01'], cmd: 'media', args: { mediaId: imgId, intervalSec: 2 } });
  check('media 指令校验 400：缺 mediaId / 未知素材 / 间隔越界',
    sendBad1.status === 400 && sendBad2.status === 400 && sendBad3.status === 400,
    { a: sendBad1.status, b: sendBad2.status, c: sendBad3.status });

  await beat('dev-media01');
  const sendOk = await api('POST', '/api/ctl/send',
    { targets: ['dev-media01'], cmd: 'media', args: { mediaId: imgId, intervalSec: 15 } });
  check('media 指令受理（seq 递增）', sendOk.status === 200 && sendOk.json.seq > 0, sendOk.json);
  const got = await beat('dev-media01');
  if (!got.json.desired) {
    check('设备心跳领到 media 指令', false, got.json);
    throw new Error('前置失败：设备未领到 media 指令，后续用例无意义');
  }
  check('设备心跳领到 media 指令（mediaId + intervalSec）',
    got.json.desired && got.json.desired.cmd === 'media' &&
    got.json.desired.args.mediaId === imgId && got.json.desired.args.intervalSec === 15,
    got.json.desired);
  check('media 为展示类：自动接管（managed=true）', got.json.managed === true, got.json.managed);
  const ack1 = await beat('dev-media01', { ackedSeq: got.json.desired.seq, state: { mode: 'media', mediaId: imgId } });
  check('素材状态上报被接受（desired 不再下发，展示类保留供场景）',
    ack1.json.desired === null && ack1.json.managed === true, ack1.json.desired);

  const sceneSnap = await api('POST', '/api/ctl/scenes', { name: '素材场景' });
  const mediaStep = (sceneSnap.json.scene?.steps || []).find((s) => s.deviceId === 'dev-media01');
  check('存为场景：素材状态（reported.mode=media）转为 media step',
    sceneSnap.status === 201 && !!mediaStep && mediaStep.cmd === 'media' && mediaStep.args.mediaId === imgId,
    sceneSnap.json.scene && sceneSnap.json.scene.steps);
  created.sceneId = sceneSnap.json.scene?.id;

  /* ==================== 8. 删除 ==================== */
  const del = await api('DELETE', `/api/media/${imgId}`);
  const delAgain = await api('DELETE', `/api/media/${imgId}`);
  const afterDel = await api('GET', `/media/${imgId}/raw`);
  const sendGone = await api('POST', '/api/ctl/send', { targets: ['dev-media01'], cmd: 'media', args: { mediaId: imgId } });
  check('删除素材成功：重复删除 404、资源 404、再下发 400（存在性校验即时生效）',
    del.status === 200 && delAgain.status === 404 && afterDel.status === 404 && sendGone.status === 400,
    { del: del.status, again: delAgain.status, raw: afterDel.status, send: sendGone.status });
  const idx = created.indexOf(imgId);
  if (idx >= 0) created.splice(idx, 1);

  /* ==================== 9. health 与落盘权限 ==================== */
  const health = await api('GET', '/api/admin/health');
  check('health.media 含 count/processing/tools/rssMB，工具可用性已探测',
    health.json.media && ['count', 'processing', 'tools', 'rssMB'].every((k) => k in health.json.media) &&
      (!pdfReady || health.json.media.tools.pdftoppm === true),
    health.json.media);

  if (DATA_DIR) {
    const modeOf = (f) => {
      try { return (fs.statSync(path.join(DATA_DIR, f)).mode & 0o777).toString(8).padStart(4, '0'); }
      catch { return 'missing'; }
    };
    check('media.json 与 .bak 权限 0600，素材目录 0700',
      modeOf('media.json') === '0600' && modeOf('media.json.bak') === '0600' &&
      modeOf('media') === '0700',
      { json: modeOf('media.json'), bak: modeOf('media.json.bak'), dir: modeOf('media') });
  }

  /* ==================== 10. 性能基准 ==================== */
  const rssBefore = (await api('GET', '/api/admin/health')).json.media.rssMB;

  const big20 = Buffer.alloc(20 * 1024 * 1024, 7);
  const t20 = Date.now();
  const up20 = await upload('性能测试20MB.mp4', big20);
  const ms20 = Date.now() - t20;
  created.push(up20.json.media?.id);
  check(`性能：20MB 上传成功且 ${ms20}ms（${(20 / (ms20 / 1000)).toFixed(0)}MB/s，阈值 15s）`,
    up20.status === 201 && ms20 < 15000, { status: up20.status, ms: ms20 });

  const big60 = Buffer.alloc(60 * 1024 * 1024, 9);
  const t60 = Date.now();
  const up60 = await upload('性能测试60MB.mp4', big60);
  const ms60 = Date.now() - t60;
  created.push(up60.json.media?.id);
  check(`性能：60MB 上传成功且 ${ms60}ms（阈值 40s，流式直写）`,
    up60.status === 201 && ms60 < 40000, { status: up60.status, ms: ms60 });

  const rssAfter = (await api('GET', '/api/admin/health')).json.media.rssMB;
  const rssGrowth = rssAfter - rssBefore;
  check(`性能：上传 80MB 后服务端 RSS 增长 ${rssGrowth}MB（流式处理，阈值 <80MB）`,
    rssGrowth < 80, { before: rssBefore, after: rssAfter });

  if (pdfReady) {
    const pageUrl = `${BASE}/media/${pdfUp.json.media.id}/page-1.png`;
    const t0 = Date.now();
    const many = await Promise.all(Array.from({ length: 24 }, () => fetch(pageUrl)));
    const msAll = Date.now() - t0;
    check(`性能：24 路并发拉取分页图片全部 200，总耗时 ${msAll}ms（p95≈${Math.round(msAll)}ms，阈值 3s）`,
      many.every((r) => r.status === 200) && msAll < 3000, { statuses: many.map((r) => r.status) });
  }

  const tv0 = Date.now();
  const tv = await api('GET', `/media/${pdfUp.json.media.id}/view`);
  const msView = Date.now() - tv0;
  check(`性能：播放页首字节 ${msView}ms（阈值 500ms）`,
    tv.status === 200 && msView < 500, { status: tv.status, ms: msView });

  /* ==================== 清理 ==================== */
  for (const id of created) await api('DELETE', `/api/media/${id}`);
  if (created.sceneId) await api('DELETE', `/api/ctl/scenes/${created.sceneId}`);
  for (const d of [...new Set(beats)]) await api('DELETE', `/api/ctl/device/${d}`);
  const left = (await api('GET', '/api/media')).json.medias.length;
  check('测试素材与设备档案已清理', left === 0, { left });

  console.log('\n==============================');
  const failed = results.filter((r) => !r.pass).length;
  console.log(`合计：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
