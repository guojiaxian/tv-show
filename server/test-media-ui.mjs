#!/usr/bin/env node
/**
 * 素材上墙 · 端到端验证（Playwright 驱动真实浏览器）
 *
 *   page1 = 显示端（/）      ：接收 media 指令 → 内嵌播放页 → reported.mode=media
 *   page2 = 控制台（/console）：设备卡「素材上墙」→ 本地选择文件上传 → 就绪自动下发
 *
 * 覆盖：控制台上传流程（进度/自动下发）、显示端真实切到素材播放页、
 *       控制台卡片摘要显示素材名、本地脱离自动交还、群组按钮入口存在、
 *       播放页图片真实渲染、运行期无 JS 异常。
 */
import { loadChromium, launchOptions } from './test-pw.mjs';

const loaded = loadChromium();
if (!loaded) {
  console.log('SKIP 未安装 playwright-core / Chromium，跳过素材上墙端到端验证');
  process.exit(0);
}

const BASE = process.env.BASE;
if (!BASE) {
  console.error('本脚本会改写服务端数据，必须跑在隔离实例上：node server/test-run.mjs');
  process.exit(1);
}

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log('      ' + JSON.stringify(detail));
};

async function api(method, path, body) {
  const isBuf = Buffer.isBuffer(body);
  const res = await fetch(BASE + path, {
    method,
    headers: body && !isBuf ? { 'Content-Type': 'application/json' } : {},
    body: body === undefined ? undefined : (isBuf ? body : JSON.stringify(body))
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const deviceOf = async (id) =>
  (await api('GET', '/api/ctl/devices')).json.devices.find((d) => d.id === id);

async function waitUntil(fn, { timeout = 10000, interval = 300, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val; // 返回查询值本身（调用方可能需要对象，如素材条目）
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

/** 生成一张 480×280 的纯色 PNG（测试素材，内容无关紧要） */
function png480() {
  // 任意合法 PNG 即可；1×1 PNG 也能验证链路，这里用 1×1 红点
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
}

/** 生成最小合法 3 页 PDF（计算 xref 偏移），用于分页播放器（PPT/PDF 共用）实测 */
function makePdf3() {
  const streamOf = (t) => `BT /F1 24 Tf 20 50 Td (${t}) Tj ET\n`;
  const body = [];
  const kids = [];
  const defs = [];
  let next = 3;
  for (let i = 0; i < 3; i++) {
    const c = next++, p = next++;
    defs.push({ c, p, s: streamOf(`PAGE ${i + 1}`) });
    kids.push(`${p} 0 R`);
  }
  const fontNum = next++;
  body.push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj');
  body.push(`2 0 obj<</Type/Pages/Kids[${kids.join(' ')}]/Count 3>>endobj`);
  for (const d of defs) {
    body.push(`${d.c} 0 obj<</Length ${d.s.length}>>stream\n${d.s}endstream endobj`);
    body.push(`${d.p} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 220 110]/Contents ${d.c} 0 R/Resources<</Font<</F1 ${fontNum} 0 R>>>>>>endobj`);
  }
  body.push(`${fontNum} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`);
  let out = '%PDF-1.4\n';
  const offs = [0];
  body.forEach((o) => { offs.push(out.length); out += o + '\n'; });
  const xref = out.length;
  out += `xref\n0 ${body.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= body.length; i++) out += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer<</Size ${body.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  const browser = await loaded.chromium.launch(launchOptions(loaded));
  const errors = [];

  /* ---------- 清理前置套件档案 ---------- */
  {
    const pre = (await api('GET', '/api/ctl/devices')).json;
    for (const d of pre.devices || []) await api('DELETE', '/api/ctl/device/' + encodeURIComponent(d.id));
    for (const m of (await api('GET', '/api/media')).json.medias || []) {
      await api('DELETE', '/api/media/' + encodeURIComponent(m.id));
    }
  }

  /* ==================== 显示端（/） ==================== */
  const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page1 = await ctx1.newPage();
  page1.on('pageerror', (e) => errors.push('[显示端] pageerror: ' + String(e).split('\n')[0]));
  page1.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    const loc = (m.location() && m.location().url) || '';
    if (loc.startsWith(BASE + '/proxy/') || loc.startsWith(BASE + '/cam/') || loc.startsWith(BASE + '/shot/') || loc.startsWith(BASE + '/media/')) return;
    if (/^WebSocket connection/.test(m.text())) return;
    errors.push('[显示端] console: ' + m.text());
  });
  await page1.goto(BASE + '/', { waitUntil: 'load' });
  await waitUntil(() => page1.evaluate(() => !!localStorage.getItem('tvshow.deviceId')), { label: 'deviceId' });
  const deviceId = await page1.evaluate(() => localStorage.getItem('tvshow.deviceId'));
  const registered = await waitUntil(async () => !!(await deviceOf(deviceId)), { label: '注册' });
  check('显示端打开即注册为受控设备', registered, deviceId);

  /* ==================== 控制台（/console） ==================== */
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page2 = await ctx2.newPage();
  page2.on('pageerror', (e) => errors.push('[控制台] pageerror: ' + String(e).split('\n')[0]));
  page2.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    errors.push('[控制台] console: ' + m.text());
  });
  await page2.goto(BASE + '/console', { waitUntil: 'load' });
  await page2.click('#btnReload');

  // 设备卡与底部操作条都有「素材上墙」入口
  const entryOk = await waitUntil(() => page2.evaluate((id) => {
    const card = document.querySelector(`[data-device-id="${id}"]`);
    const cardBtn = card ? Array.from(card.querySelectorAll('.ops .btn')).find((b) => b.textContent === '素材上墙') : null;
    const footBtn = document.getElementById('btnMedia');
    return !!cardBtn && !!footBtn && footBtn.textContent === '素材上墙';
  }, deviceId), { label: '素材入口渲染' });
  check('设备卡与底部操作条均提供「素材上墙」入口', entryOk);

  /* ---------- 设备卡单台上传 → 自动下发 → 显示端播放 ---------- */
  await page2.evaluate((id) => {
    const card = document.querySelector(`[data-device-id="${id}"]`);
    Array.from(card.querySelectorAll('.ops .btn')).find((b) => b.textContent === '素材上墙').click();
  }, deviceId);
  const modalOpen = await waitUntil(() => page2.evaluate(() =>
    !document.getElementById('mask').hidden &&
    !!document.querySelector('#modalBox input[type="file"]')), { label: '弹层' });
  check('点击设备卡「素材上墙」弹出上传弹层（含文件选择与素材列表）', modalOpen);

  // 上传不自动下发：图片行只提供「上墙」手动入口（自动翻页仅分页素材）
  await page2.setInputFiles('#modalBox input[type="file"]', {
    name: '现场海报.png',
    mimeType: 'image/png',
    buffer: png480()
  });
  const uploaded = await waitUntil(async () => {
    const list = (await api('GET', '/api/media')).json.medias || [];
    return list.find((m) => m.name === '现场海报.png') || null;
  }, { timeout: 8000, label: '素材入库' });
  check('从弹层选择本地文件后素材自动上传入库', !!uploaded, uploaded && uploaded.name);
  const mediaId = uploaded && uploaded.id;

  const imageRow = await waitUntil(() => page2.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#modalBox .row .btn'));
    return {
      manual: !!btns.find((b) => b.textContent === '上墙' && !b.disabled),
      auto: !!btns.find((b) => b.textContent === '自动翻页' && !b.disabled)
    };
  }), { timeout: 8000, label: '素材行按钮' });
  check('图片素材行提供「上墙」手动入口，不显示自动翻页', imageRow.manual && !imageRow.auto, imageRow);

  // 手动上墙：显示后不自动翻页
  await page2.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#modalBox .row .btn'));
    const send = btns.find((b) => b.textContent === '上墙' && !b.disabled);
    if (send) send.click();
  });
  const sent = await waitUntil(async () => {
    const d = await deviceOf(deviceId);
    return !!(d && d.desired && d.desired.cmd === 'media' && d.desired.args.mediaId === mediaId &&
      d.desired.args.auto === false);
  }, { timeout: 8000, label: '手动上墙下发' });
  check('点「上墙」下发手动模式（auto=false，不自动翻页）', sent, await deviceOf(deviceId));
  const managedNow = await waitUntil(async () => (await deviceOf(deviceId)).managed === true, { label: '接管' });
  check('media 为展示类指令：设备自动进入远程被控', managedNow);

  // 显示端真实切到素材播放页（iframe 指向 /media/<id>/view）
  const iframeOk = await waitUntil(() => page1.evaluate(() => {
    const f = document.querySelector('#frameViewport iframe');
    return f && /\/media\/m-[0-9a-f]+\/view/.test(f.src || '') && !document.getElementById('displayScreen').hidden;
  }), { label: '显示端切素材页' });
  check('显示端真实切换到素材播放页（内嵌 /media/<id>/view）', iframeOk);

  // 播放页图片真实渲染出来（naturalWidth > 0）
  const imgLoaded = await waitUntil(() => page1.evaluate(() => {
    const f = document.querySelector('#frameViewport iframe');
    try {
      const img = f.contentDocument && f.contentDocument.querySelector('#stage img');
      return !!img && img.naturalWidth > 0;
    } catch (e) { return false; }
  }), { timeout: 8000, label: '图片渲染' });
  check('播放页内图片真实加载渲染（naturalWidth>0）', imgLoaded);

  // 心跳上报 mode=media → 控制台卡片摘要显示「素材：现场海报.png」
  const reported = await waitUntil(async () => {
    const d = await deviceOf(deviceId);
    return d.reported && d.reported.mode === 'media' && d.reported.mediaId === mediaId;
  }, { timeout: 8000, label: 'reported=media' });
  check('显示端心跳上报 mode=media + mediaId', reported, await deviceOf(deviceId));
  // 注意：此时控制台弹层仍开着（遮罩拦截指针），卡片由 3s 轮询自动重建，不要点被遮住的按钮
  const summaryOk = await waitUntil(() => page2.evaluate(() =>
    Array.from(document.querySelectorAll('#deviceList .card .st'))
      .some((st) => st.textContent.includes('素材：现场海报.png'))), { timeout: 10000, label: '摘要' });
  check('控制台设备卡摘要显示「素材：现场海报.png」', summaryOk);

  /* ---------- 控制台预览：弹层缩略图 / 预览按钮 / Esc 只关浮层 ---------- */
  const thumbOk = await waitUntil(() => page2.evaluate(() => {
    const t = document.querySelector('#modalBox .media-thumb');
    return t && t.naturalWidth > 0 ? t.naturalWidth : false;
  }), { timeout: 8000, label: '缩略图' });
  check('素材弹层行内缩略图真实加载（preview 接口同源可读）', thumbOk > 0);

  await page2.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#modalBox .row .btn'));
    const pv = btns.find((b) => b.textContent === '预览' && !b.disabled);
    if (pv) pv.click();
  });
  const pvOpen = await waitUntil(() => page2.evaluate(() => {
    const m = document.getElementById('mediaPvMask');
    const f = m && m.querySelector('iframe');
    return !!(m && f && f.src.includes('/media/') && f.src.includes('/view'));
  }), { label: '预览浮层' });
  check('弹层「预览」按钮打开预览浮层（内嵌与设备端同一播放页）', pvOpen);
  await page2.keyboard.press('Escape');
  const pvClosed = await waitUntil(() => page2.evaluate(() =>
    !document.getElementById('mediaPvMask') && !document.getElementById('mask').hidden), { label: 'Esc 分层关闭' });
  check('Esc 只关闭预览浮层，素材弹层保持打开（分层关闭）', pvClosed);

  /* ---------- 本地脱离：显示端点「返回首页」→ 自动交还本地 ---------- */
  await page1.click('#btnBack');
  const released = await waitUntil(async () => (await deviceOf(deviceId)).managed === false, { timeout: 10000, label: '自动交还' });
  check('显示端本地操作脱离素材画面 → 自动交还本地控制', released);

  /* ---------- 上墙按钮（列表手动下发）与删除 ---------- */
  await page2.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#modalBox .row .btn'));
    const send = btns.find((b) => b.textContent === '上墙' && !b.disabled);
    if (send) send.click();
  });
  const resent = await waitUntil(async () => {
    const d = await deviceOf(deviceId);
    return !!(d && d.desired && d.desired.cmd === 'media' && d.desired.args.auto === false);
  }, { timeout: 8000, label: '手动上墙下发' });
  check('素材列表「上墙」按钮可再次手动下发（auto=false）', resent);

  /* ---------- 上墙后控制台随时预览：关闭弹层 → 点设备卡「素材：xxx」摘要 ---------- */
  await page2.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#modalBox footer .btn'));
    const close = btns.find((b) => b.textContent === '关闭');
    if (close) close.click();
  });
  await waitUntil(() => page2.evaluate(() => document.getElementById('mask').hidden), { label: '弹层关闭' });
  // 设备重新应用素材（上一条 resend 后心跳领取）→ 摘要变回可点击的「素材：xxx」
  const chipClickable = await waitUntil(() => page2.evaluate((id) => {
    const card = document.querySelector(`[data-device-id="${id}"]`);
    const chip = card && card.querySelector('.chip.sm-link');
    return chip && chip.textContent.includes('素材：') ? chip : false;
  }, deviceId), { timeout: 12000, label: '可点击摘要' });
  check('上墙后设备卡「素材：xxx」摘要变为可点击（随时预览入口）', !!chipClickable,
    chipClickable && chipClickable.textContent);
  if (chipClickable) {
    // evaluate 返回的是序列化对象，点击需用 Playwright 定位器
    await page2.click(`[data-device-id="${deviceId}"] .chip.sm-link`);
    const chipPv = await waitUntil(() => page2.evaluate((mid) => {
      const m = document.getElementById('mediaPvMask');
      const f = m && m.querySelector('iframe');
      return !!(m && f && f.src.includes('/media/' + mid + '/view'));
    }, mediaId), { label: '摘要预览' });
    check('点击摘要打开当前素材预览浮层（无需重开素材弹层）', chipPv);
    await page2.keyboard.press('Escape');
    await waitUntil(() => page2.evaluate(() => !document.getElementById('mediaPvMask')), { label: '预览关闭' });
  }

  /* ---------- 重新打开素材弹层执行删除 ---------- */
  await page2.evaluate((id) => {
    const card = document.querySelector(`[data-device-id="${id}"]`);
    Array.from(card.querySelectorAll('.ops .btn')).find((b) => b.textContent === '素材上墙').click();
  }, deviceId);
  await waitUntil(() => page2.evaluate(() =>
    !document.getElementById('mask').hidden && !!document.querySelector('#modalBox input[type="file"]')),
    { label: '弹层重开' });

  // 删除素材：确认弹层 → 服务端删除。
  // 素材行由 syncList 异步渲染，重开弹层后要等「删除」按钮真的出现再点（否则扑空致超时）
  await waitUntil(() => page2.evaluate(() =>
    !!Array.from(document.querySelectorAll('#modalBox .row .btn')).find((b) => b.textContent === '删除')),
    { timeout: 8000, label: '删除按钮渲染' });
  await page2.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#modalBox .row .btn'));
    const del = btns.find((b) => b.textContent === '删除');
    if (del) del.click();
  });
  await page2.waitForTimeout(300);
  // 删除确认是素材弹层之上的嵌套确认层：确认后只关确认层，素材弹层必须保持打开
  await page2.waitForSelector('#mediaDelMask .confirm-btn:has-text("删除")', { timeout: 5000 });
  await page2.click('#mediaDelMask .confirm-btn:has-text("删除")');
  const deleted = await waitUntil(async () =>
    ((await api('GET', '/api/media')).json.medias || []).length === 0, { label: '素材删除' });
  check('弹层内删除素材生效（列表清空）', deleted);
  const dialogKept = await page2.evaluate(() =>
    !document.getElementById('mask').hidden &&
    !!document.querySelector('#modalBox input[type="file"]') &&
    !document.getElementById('mediaDelMask'));
  check('删除素材后不退出上墙管理弹层（确认层已关闭）', dialogKept);

  // 关闭弹层
  await page2.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#modalBox footer .btn'));
    const close = btns.find((b) => b.textContent === '关闭');
    if (close) close.click();
  });

  /* ---------- 分页素材（PDF）：上传 → 手动上墙（默认不翻页）→ 自动翻页设置 → 播放/暂停/循环 ---------- */
  {
    // 打开设备卡「素材上墙」弹层（目标 = 该设备）
    await page2.evaluate((id) => {
      const card = document.querySelector(`[data-device-id="${id}"]`);
      Array.from(card.querySelectorAll('.ops .btn')).find((b) => b.textContent === '素材上墙').click();
    }, deviceId);
    await waitUntil(() => page2.evaluate(() =>
      !document.getElementById('mask').hidden && !!document.querySelector('#modalBox input[type="file"]')),
      { label: '素材弹层' });

    // 从弹层上传 PDF（真实 UI 链路：上传 → 转换进度 → 就绪后由用户选择上墙方式）
    await page2.setInputFiles('#modalBox input[type="file"]', {
      name: '翻页演示.pdf', mimeType: 'application/pdf', buffer: makePdf3()
    });
    // 实时进度：转换期间进度文本出现过（相位提示或「已转换 x/N 页」）
    const sawProgress = await waitUntil(() => page2.evaluate(() => {
      const n = document.getElementById('mediaProgNote');
      return n && n.style.display !== 'none' && n.textContent ? n.textContent : false;
    }), { timeout: 10000, interval: 100, label: '进度文本' });
    check('转换期间显示实时进度文本（相位/页数）', !!sawProgress, sawProgress);

    const mediaId2 = await waitUntil(async () => {
      const list = (await api('GET', '/api/media')).json.medias || [];
      const m = list.find((x) => x.name === '翻页演示.pdf');
      return m && m.status === 'ready' ? m.id : false;
    }, { timeout: 20000, label: 'PDF 就绪' });
    check('PDF 转换完成（ready）', !!mediaId2, mediaId2);

    if (mediaId2) {
      // 分页素材行应同时提供「上墙」与「自动翻页」
      const pagedRow = await waitUntil(() => page2.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('#modalBox .row .btn'));
        const st = {
          manual: !!btns.find((b) => b.textContent === '上墙' && !b.disabled),
          auto: !!btns.find((b) => b.textContent === '自动翻页' && !b.disabled)
        };
        return st.manual && st.auto ? st : false; // 等待两个按钮都渲染出来
      }), { timeout: 8000, label: '分页素材按钮' });
      check('分页素材行提供「上墙」与「自动翻页」两个入口', pagedRow.manual && pagedRow.auto, pagedRow);

      /* ---------- 默认手动：点「上墙」后停在当前页，不自动翻页 ---------- */
      await page2.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('#modalBox .row .btn'));
        const send = btns.find((b) => b.textContent === '上墙' && !b.disabled);
        if (send) send.click();
      });
      const manualSent = await waitUntil(async () => {
        const d = await deviceOf(deviceId);
        return !!(d && d.desired && d.desired.cmd === 'media' && d.desired.args.mediaId === mediaId2 &&
          d.desired.args.auto === false);
      }, { timeout: 8000, label: '手动上墙' });
      check('分页素材点「上墙」下发手动模式（auto=false）', manualSent);

      const t0 = Date.now();
      const switched = await waitUntil(() => page1.evaluate((mid) => {
        const f = document.querySelector('#frameViewport iframe');
        return f && f.src.includes('/media/' + mid + '/view') && f.src.includes('interval=10');
      }, mediaId2), { label: '切到分页素材' });
      const firstPage = await waitUntil(() => page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        try {
          // 双缓冲：首帧可能加载在 ca 或 cb 任一图层，不能只查第一个 img
          const imgs = Array.from(f.contentDocument.querySelectorAll('#stage img'));
          return imgs.some((img) => img.naturalWidth > 0);
        } catch (e) { return false; }
      }), { timeout: 8000, label: '首页渲染' });
      const firstPageMs = Date.now() - t0;
      let pageDbg = null;
      if (!firstPage) {
        pageDbg = await page1.evaluate(() => {
          const f = document.querySelector('#frameViewport iframe');
          try {
            const d = f.contentDocument;
            return {
              ready: d.readyState,
              body: (d.body && d.body.innerHTML || '').slice(0, 240),
              imgs: Array.from(d.querySelectorAll('#stage img')).map((i) => ({
                src: i.getAttribute('src'), nw: i.naturalWidth, complete: i.complete
              })),
              ov: d.getElementById('ov') ? d.getElementById('ov').textContent : ''
            };
          } catch (e) { return { err: String(e) }; }
        });
      }
      check(`分页素材首帧 ${firstPageMs}ms（阈值 10s，含心跳领取 + 页面加载）`,
        switched && firstPage && firstPageMs < 10000, { switched, firstPage, ms: firstPageMs, pageDbg });

      const manualState = await page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        try { return f.contentDocument.defaultView.__tvMediaState(); } catch (e) { return null; }
      });
      check('手动模式：播放页 mode=manual / auto=false',
        manualState && manualState.mode === 'manual' && manualState.auto === false, manualState);
      await sleep(4000); // 超过最小自动间隔（3s），手动模式页码必须不动
      const manualStill = await page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        try { return f.contentDocument.defaultView.__tvMediaState(); } catch (e) { return null; }
      });
      check('手动模式 4s 后仍停在第 1 页（默认不自动翻页）',
        manualStill && manualStill.page === 1, manualStill);

      /* ---------- 自动翻页：弹框设置间隔 5s + 循环，确定后开始自动播放 ---------- */
      await page2.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('#modalBox .row .btn'));
        const auto = btns.find((b) => b.textContent === '自动翻页' && !b.disabled);
        if (auto) auto.click();
      });
      await page2.waitForSelector('#mediaAutoMask select', { timeout: 5000 });
      await page2.selectOption('#mediaAutoMask select', '5');
      const loopChecked = await page2.evaluate(() =>
        document.querySelector('#mediaAutoMask input[type="checkbox"]').checked);
      check('自动翻页弹框默认循环播放', loopChecked === true, loopChecked);
      await page2.click('#mediaAutoMask .btn.primary');

      const autoSent = await waitUntil(async () => {
        const d = await deviceOf(deviceId);
        return !!(d && d.desired && d.desired.cmd === 'media' && d.desired.args.mediaId === mediaId2 &&
          d.desired.args.auto === true && Number(d.desired.args.intervalSec) === 5 &&
          d.desired.args.loop === true);
      }, { timeout: 8000, label: '自动翻页下发' });
      check('自动翻页确定后下发 auto=true / intervalSec=5 / loop=true', autoSent,
        await deviceOf(deviceId));

      const switchedAuto = await waitUntil(() => page1.evaluate((mid) => {
        const f = document.querySelector('#frameViewport iframe');
        return f && f.src.includes('/media/' + mid + '/view') && f.src.includes('interval=5');
      }, mediaId2), { timeout: 10000, label: '切到自动播放' });
      const autoState = await waitUntil(() => page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        try {
          const st = f.contentDocument.defaultView.__tvMediaState();
          return st && st.mode === 'auto' && st.auto === true ? st : false;
        } catch (e) { return false; }
      }), { timeout: 8000, label: '自动状态' });
      check('显示端自动模式生效（mode=auto / auto=true）', switchedAuto && !!autoState, autoState);

      // 5s 间隔自动翻页：10s 内页码必须从 1/3 推进到 2/3
      const advanced = await waitUntil(() => page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        try { return f.contentDocument.defaultView.__tvMediaState().page >= 2; } catch (e) { return false; }
      }), { timeout: 12000, label: '自动翻页' });
      const ovNow = await page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        try { return f.contentDocument.getElementById('ov').textContent; } catch (e) { return ''; }
      });
      check(`自动翻页生效（5s 间隔推进到 2/3，当前 ${ovNow.trim()}）`, advanced, ovNow);

      /* ---------- 手动播放：暂停后页码静止，「下一页」立即手动翻页 ---------- */
      await page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        f.contentDocument.getElementById('bPlay').click();
      });
      const paused = await waitUntil(() => page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        try { return f.contentDocument.getElementById('ov').textContent.includes('已暂停') ? true : false; }
        catch (e) { return false; }
      }), { label: '暂停' });
      const pageAtPause = await page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        return f.contentDocument.getElementById('ov').textContent.match(/(\d)\/3/)[1];
      });
      await sleep(6500); // 超过一个自动翻页间隔
      const stillAfterPause = await page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        return f.contentDocument.getElementById('ov').textContent;
      });
      check(`暂停自动翻页后页码静止（${pageAtPause}/3，6.5s 后仍为 ${stillAfterPause.trim()}）`,
        paused && stillAfterPause.includes('已暂停') && stillAfterPause.includes(pageAtPause + '/3'),
        { paused, pageAtPause, after: stillAfterPause });

      // 手动翻页：只点一次「下一页」，用播放页状态钩子核对闭包真值（page/auto）
      const expectNext = String((Number(pageAtPause) % 3) + 1);
      await page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        f.contentDocument.getElementById('bNext').click();
      });
      const stAfter = await page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        return f.contentDocument.defaultView.__tvMediaState ? f.contentDocument.defaultView.__tvMediaState() : null;
      });
      const ovAfter = await page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        try { return f.contentDocument.getElementById('ov').textContent; } catch (e) { return 'ERR'; }
      });
      const manualNext = stAfter && stAfter.page === Number(expectNext) && stAfter.auto === false;
      check(`暂停态下「下一页」手动翻页立即生效（${pageAtPause}/3 → ${expectNext}/3，保持暂停）`,
        manualNext, { stAfter, ovAfter });

      /* ---------- 不循环：到末页自动停止 ---------- */
      await page2.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('#modalBox .row .btn'));
        const auto = btns.find((b) => b.textContent === '自动翻页' && !b.disabled);
        if (auto) auto.click();
      });
      await page2.waitForSelector('#mediaAutoMask select', { timeout: 5000 });
      await page2.selectOption('#mediaAutoMask select', '3');
      await page2.uncheck('#mediaAutoMask input[type="checkbox"]');
      await page2.click('#mediaAutoMask .btn.primary');
      const noLoopEnd = await waitUntil(() => page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        try {
          const st = f.contentDocument.defaultView.__tvMediaState();
          return st && st.page === 3 && st.ended === true ? st : false;
        } catch (e) { return false; }
      }), { timeout: 15000, label: '末页停止' });
      const endOv = await page1.evaluate(() => {
        const f = document.querySelector('#frameViewport iframe');
        try { return f.contentDocument.getElementById('ov').textContent; } catch (e) { return ''; }
      });
      check('不循环：自动翻到末页后停止并显示「已到末页」',
        !!noLoopEnd && noLoopEnd.auto === false && noLoopEnd.loop === false && endOv.includes('已到末页'),
        { noLoopEnd, ov: endOv });

      await api('POST', '/api/ctl/release', { targets: [deviceId] });
      await waitUntil(async () => (await deviceOf(deviceId)).managed === false, { label: '交还' });
    } else {
      check('分页素材链路（环境无 pdftoppm，自适应跳过）', true, 'conversion unavailable');
    }
    // 清理：关闭弹层 + 删除测试素材（不影响后续断言）
    await page2.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('#modalBox footer .btn'));
      const close = btns.find((b) => b.textContent === '关闭');
      if (close) close.click();
    });
    if (mediaId2) await api('DELETE', '/api/media/' + encodeURIComponent(mediaId2));
  }

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
