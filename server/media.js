/**
 * 素材上墙模块（远程素材上屏）
 * ---------------------------------------------------------------------------
 * 零依赖：仅使用 Node 内置模块；PDF/PPT 转换调用系统命令行工具（可选依赖，
 * 缺失时该类型降级为「不可用」并给出原因，服务端照常启动 —— 沿用 esbuild 先例）。
 *
 *   POST /api/media/upload?name=<文件名>   上传（请求体 = 原始文件字节，非 multipart）
 *   GET  /api/media                        素材列表（仅元数据）
 *   DELETE /api/media/<id>                 删除素材（含转换产物）
 *   GET  /media/<id>/view?interval=10      播放页（ES5，Web 与 TV 两端共用）
 *   GET  /media/<id>/raw                   原始文件（图片/视频；支持 Range，视频起播必需）
 *   GET  /media/<id>/page-N.png            分页图片（PDF/PPT/DOC 转换产物）
 *   GET  /media/<id>/preview               预览缩略（图片→原图；分页→第 1 页）
 *
 * 素材类型（详见 docs/素材上墙-分析与设计.md）：
 *   image  图片 jpg/jpeg/png/webp/bmp —— 生成 1920×1080 适配副本给电视端；gif/svg 原样
 *   pdf    PDF       —— pdftoppm（poppler-utils）逐页转 PNG
 *   ppt    PPT/PPTX  —— soffice（LibreOffice）转 PDF 后同上
 *   doc    DOC/DOCX  —— 同 ppt 管线
 *   video  mp4/webm  —— 原样 <video> 播放
 *
 * 状态机：processing（转换中）→ ready | unsupported（附原因）。
 * 图片/视频上传即 ready；PDF/PPT 异步转换，控制台轮询就绪后自动下发 media 指令。
 *
 * 安全：文件名只取 basename 并限长；扩展名白名单；上传按 Content-Length 限额
 * （默认 200MB，超限 413）且落盘时逐块复核；文件与注册表 0600/0700。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

/* ============================ 常量 ============================ */

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_NAME_CHARS = 120;
const PDF_DPI = 120;
const SOFFICE_TIMEOUT_MS = 180 * 1000;
const PDF_TIMEOUT_MS = 120 * 1000;
const TOOL_CACHE_MS = 60 * 1000;
/* 电视端 WebView 解码超大照片容易黑屏/内存不足：图片上传时生成 1080p 适配副本，
   原图保留用于预览/下载；GIF/SVG 不转换（动图/矢量） */
const IMAGE_VIEW_MAX_W = 1920;
const IMAGE_VIEW_MAX_H = 1080;
const IMAGE_VIEW_QUALITY = 88;
const IMAGE_VIEW_TIMEOUT_MS = 30 * 1000;
const IMAGE_NO_VIEW_EXT = new Set(['.gif', '.svg']);

/** 扩展名 → 类型（白名单，其余一律 400） */
const EXT_KIND = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image',
  '.webp': 'image', '.bmp': 'image', '.svg': 'image',
  '.pdf': 'pdf',
  '.ppt': 'ppt', '.pptx': 'ppt',
  '.doc': 'doc', '.docx': 'doc',
  '.mp4': 'video', '.webm': 'video'
};

const KIND_LABEL = { image: '图片', pdf: 'PDF', ppt: 'PPT', doc: '文档', video: '视频' };

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm'
};

/** 分页类型：转换成 page-N.png 后由播放页定时翻页 */
const PAGED_KINDS = ['pdf', 'ppt', 'doc'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

/* ============================ 工具 ============================ */

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/** 工具可用性探测（带缓存）：exit 0 = 可用；pdftoppm -v 在个别版本返回 1 但会打印版本号 */
const toolCache = new Map();
function hasTool(bin, args) {
  const cached = toolCache.get(bin);
  const now = Date.now();
  if (cached && now - cached.at < TOOL_CACHE_MS) return cached.ok;
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
      toolCache.set(bin, { ok, at: now });
      resolve(ok);
    };
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      toolCache.set(bin, { ok: false, at: now });
      return resolve(false);
    }
    const timer = setTimeout(() => finish(false), 8000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', () => finish(false));
    child.on('close', (code) => {
      finish(code === 0 || /version|poppler|libreoffice/i.test(out));
    });
  });
}

/** 运行一次命令行工具；超时 SIGKILL，非零退出抛错 */
function runTool(bin, args, timeoutMs, failMsg) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(new Error(`${failMsg}：${e.message}`));
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* 忽略 */ }
      reject(new Error(`${failMsg}：处理超时`));
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${failMsg}：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const detail = (stderr || stdout || `退出码 ${code}`).trim().split('\n').pop();
      reject(new Error(`${failMsg}：${String(detail || '').slice(0, 160)}`));
    });
  });
}

/* ============================ 模块工厂 ============================ */

function createMedia({ dataDir, log = () => {} }) {
  const ASSET_DIR = path.join(dataDir, 'media');
  const REGISTRY_FILE = path.join(dataDir, 'media.json');
  const BACKUP_FILE = `${REGISTRY_FILE}.bak`;
  /** 播放页默认翻页间隔（秒），下发指令可覆盖（3–3600） */
  const DEFAULT_INTERVAL_SEC = 10;

  let registry = { medias: [] };
  let writeChain = Promise.resolve();
  /**
   * 每个素材最近一次「上墙方式」（手动/自动 + 间隔 + 循环）。
   * 电视端 2.3 / 旧网页只会加载 /media/<id>/view?interval=N，不带 auto/loop，
   * 服务端用这份记录补默认值，保证不升级 APK 也能按控制台选择的方式播放。
   */
  const playback = new Map();

  fs.mkdirSync(ASSET_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(ASSET_DIR, 0o700); } catch (e) { /* 个别文件系统忽略 */ }
  loadRegistry();
  if (!fs.existsSync(REGISTRY_FILE)) persist();
  // 启动即探测转换工具可用性（异步、带缓存）：health.tools 尽早给出真实值而非 null
  hasTool('pdftoppm', ['-v']);
  hasTool('soffice', ['--version']);

  /* ---------- 注册表 ---------- */

  function loadRegistry() {
    for (const file of [REGISTRY_FILE, BACKUP_FILE]) {
      if (!fs.existsSync(file)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && Array.isArray(parsed.medias)) {
          registry = {
            medias: parsed.medias
              .filter((m) => m && typeof m.id === 'string' && /^[a-z0-9-]{1,64}$/.test(m.id))
              .map((m) => ({
                id: m.id,
                name: String(m.name || '素材').slice(0, MAX_NAME_CHARS),
                kind: KIND_LABEL[m.kind] ? m.kind : 'image',
                ext: String(m.ext || ''),
                size: Number(m.size) || 0,
                pages: Math.max(0, Number(m.pages) || 0),
                phase: m.phase === 'convert' || m.phase === 'raster' || m.phase === 'done' ? m.phase : '',
                total: Math.max(0, Number(m.total) || 0),
                intervalSec: Math.min(3600, Math.max(3, Number(m.intervalSec) || DEFAULT_INTERVAL_SEC)),
                status: m.status === 'ready' || m.status === 'unsupported' ? m.status : 'unsupported',
                reason: String(m.reason || '').slice(0, 200),
                createdAt: m.createdAt || new Date().toISOString()
              }))
          };
          log(`[media] 已加载 ${file}（素材=${registry.medias.length}）`);
          return;
        }
      } catch (e) {
        log(`[media] ${file} 解析失败：${e.message}`);
      }
    }
  }

  function persist() {
    const tmp = `${REGISTRY_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), { encoding: 'utf8', mode: 0o600 });
    if (fs.existsSync(REGISTRY_FILE)) {
      try {
        fs.copyFileSync(REGISTRY_FILE, BACKUP_FILE);
        fs.chmodSync(BACKUP_FILE, 0o600);
      } catch (e) { log(`[media] 备份失败：${e.message}`); }
    }
    fs.renameSync(tmp, REGISTRY_FILE);
    try { fs.chmodSync(REGISTRY_FILE, 0o600); } catch (e) { /* 忽略 */ }
  }

  /** 串行化「读-改-写」，与 store/ctl 同惯例 */
  function mutate(fn) {
    const run = () => {
      const result = fn(registry);
      persist();
      return result;
    };
    const p = writeChain.then(run, run);
    writeChain = p.catch(() => {});
    return p;
  }

  const mediaOf = (id) => registry.medias.find((m) => m.id === id) || null;
  const exists = (id) => !!mediaOf(id);

  /** 记录上墙方式（ctl 下发 media 指令时调用；只影响后续 /view 的默认值） */
  function setPlayback(id, opts = {}) {
    if (!mediaOf(id)) return;
    playback.set(id, {
      auto: opts.auto === true,
      intervalSec: clampInterval(opts.intervalSec, DEFAULT_INTERVAL_SEC),
      loop: opts.loop !== false
    });
  }

  /** 读取 PDF 总页数（poppler 的 pdfinfo；缺失/失败返回 0，进度退化为不确定） */
  async function pdfPageCount(file) {
    if (!(await hasTool('pdfinfo', ['-v']))) return 0;
    try {
      const out = await runTool('pdfinfo', [file], 15000, '读取 PDF 页数失败');
      const m = (out.stdout || '').match(/Pages:\s*(\d+)/);
      if (m) return Number(m[1]);
    } catch (e) { /* 进度退化为不确定 */ }
    return 0;
  }

  /* ---------- 路径 ---------- */

  const origFileOf = (id) => path.join(ASSET_DIR, `${id}.orig`);
  const viewFileOf = (id) => path.join(ASSET_DIR, `${id}.view.jpg`);

  /** 超大图片生成电视端适配副本；失败时保留原图，不阻断上传 */
  async function makeImageView(media) {
    if (media.kind !== 'image' || IMAGE_NO_VIEW_EXT.has(media.ext)) return false;
    await runTool('convert', [
      origFileOf(media.id),
      '-auto-orient',
      '-background', 'black',
      '-alpha', 'remove',
      '-alpha', 'off',
      '-resize', `${IMAGE_VIEW_MAX_W}x${IMAGE_VIEW_MAX_H}>`,
      '-strip',
      '-quality', String(IMAGE_VIEW_QUALITY),
      viewFileOf(media.id),
    ], IMAGE_VIEW_TIMEOUT_MS, '图片适配转换失败');
    return true;
  }
  const pdfFileOf = (id) => path.join(ASSET_DIR, `${id}.pdf`);
  const pageFileOf = (id, n) => path.join(ASSET_DIR, `${id}.page-${n}.png`);

  /* ---------- 上传 ---------- */

  function sanitizeName(raw) {
    const base = String(raw || '').split(/[\\/]/).pop().trim();
    if (!base) throw bad('缺少素材文件名（?name=）');
    if (base.length > MAX_NAME_CHARS) throw bad(`文件名过长（最多 ${MAX_NAME_CHARS} 字符）`);
    return base;
  }

  /** 请求体流式写盘：按 Content-Length 限额，逐块复核防超发 */
  function streamToFile(req, file, expectedBytes) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file, { mode: 0o600 });
      let received = 0;
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        fn(v);
      };
      req.on('data', (c) => {
        received += c.length;
        if (received > expectedBytes) {
          try { req.destroy(); } catch (e) { /* 忽略 */ }
          try { out.destroy(); } catch (e) { /* 忽略 */ }
          done(reject, new HttpError(413, '请求体超出声明的 Content-Length'));
        }
      });
      req.on('error', (e) => done(reject, e));
      out.on('error', (e) => done(reject, e));
      out.on('finish', () => done(resolve, received));
      req.pipe(out);
    });
  }

  async function handleUpload(req, res, url) {
    if (registry.medias.length >= 200) throw bad('素材数量已达上限（200），请先删除不需要的素材');
    const name = sanitizeName(url.searchParams.get('name'));
    const ext = path.extname(name).toLowerCase();
    const kind = EXT_KIND[ext];
    if (!kind) {
      throw bad('不支持的素材类型（支持：图片 jpg/png/gif/webp/bmp/svg、PDF、PPT/PPTX、DOC/DOCX、MP4/WebM）');
    }
    const declared = Number(req.headers['content-length']);
    if (!Number.isFinite(declared) || declared <= 0) throw bad('缺少请求体（应为素材文件的原始内容）');
    if (declared > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, `素材过大（上限 ${Math.round(MAX_UPLOAD_BYTES / 1048576)}MB）`);
    }

    const id = 'm-' + crypto.randomBytes(4).toString('hex');
    const received = await streamToFile(req, origFileOf(id), declared);
    if (received !== declared) {
      try { fs.unlinkSync(origFileOf(id)); } catch (e) { /* 忽略 */ }
      throw bad('上传不完整，请重试');
    }

    const media = {
      id,
      name,
      kind,
      ext,
      size: received,
      pages: 0,
      intervalSec: DEFAULT_INTERVAL_SEC,
      status: PAGED_KINDS.includes(kind) ? 'processing' : 'ready',
      reason: '',
      createdAt: new Date().toISOString()
    };
    if (kind === 'image' && !IMAGE_NO_VIEW_EXT.has(ext)) {
      try {
        await makeImageView(media);
      } catch (e) {
        log(`[media] ${name} 图片适配失败，回退原图：${e.message}`);
      }
    }
    await mutate((d) => { d.medias.push(media); });
    log(`[media] 已上传 ${name}（${kind}，${(received / 1024).toFixed(0)}KB）`);
    if (media.status === 'processing') enqueueProcess(media);

    sendJson(res, 201, { ok: true, media: publicOf(media) });
  }

  /* ---------- 转换管线 ---------- */

  let processChain = Promise.resolve();
  function enqueueProcess(media) {
    const p = processChain.then(() => processMedia(media), () => processMedia(media));
    processChain = p.catch(() => {});
    return p;
  }

  async function processMedia(media) {
    try {
      if (media.kind === 'pdf') {
        media.phase = 'raster';
        media.total = await pdfPageCount(origFileOf(media.id));
        await mutate(() => undefined);
        media.pages = await renderPdf(origFileOf(media.id), media.id);
      } else if (media.kind === 'ppt' || media.kind === 'doc') {
        if (!(await hasTool('soffice', ['--version']))) {
          throw new Error('服务器未安装 LibreOffice（soffice），无法转换 PPT/文档；安装 libreoffice-headless 后删除重传即可');
        }
        // 阶段 1：Office → PDF（soffice 单步 opaque，进度为不定长）
        media.phase = 'convert';
        await mutate(() => undefined);
        const out = await runTool('soffice',
          ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', ASSET_DIR, origFileOf(media.id)],
          SOFFICE_TIMEOUT_MS, 'PPT/文档转 PDF 失败');
        void out;
        const produced = path.join(ASSET_DIR, path.basename(origFileOf(media.id), path.extname(origFileOf(media.id))) + '.pdf');
        if (!fs.existsSync(produced)) throw new Error('PPT/文档转 PDF 失败：未生成 PDF（文件可能损坏或受密码保护）');
        fs.renameSync(produced, pdfFileOf(media.id));
        // 阶段 2：PDF → 逐页 PNG（pdfinfo 给出总页数，进度可确定）
        media.phase = 'raster';
        media.total = await pdfPageCount(pdfFileOf(media.id));
        await mutate(() => undefined);
        media.pages = await renderPdf(pdfFileOf(media.id), media.id);
      }
      media.phase = 'done';
      media.status = 'ready';
      log(`[media] ${media.name} 处理完成（${media.pages} 页）`);
    } catch (e) {
      media.status = 'unsupported';
      media.reason = String(e.message || e).slice(0, 200);
      log(`[media] ${media.name} 无法上墙：${media.reason}`);
    }
    await mutate(() => undefined);
  }

  /** pdftoppm 逐页转 PNG 并归一化为 page-N.png；返回页数 */
  async function renderPdf(pdfFile, id) {
    if (!(await hasTool('pdftoppm', ['-v']))) {
      throw new Error('服务器未安装 poppler-utils（pdftoppm），无法把 PDF 转成图片；安装后删除重传即可');
    }
    const prefix = path.join(ASSET_DIR, `${id}.rawpage`);
    for (const stale of fs.readdirSync(ASSET_DIR)) {
      if (stale.startsWith(`${id}.rawpage`) || stale.startsWith(`${id}.page-`)) {
        try { fs.unlinkSync(path.join(ASSET_DIR, stale)); } catch (e) { /* 忽略 */ }
      }
    }
    await runTool('pdftoppm', ['-png', '-r', String(PDF_DPI), pdfFile, prefix],
      PDF_TIMEOUT_MS, 'PDF 转图片失败');
    const produced = fs.readdirSync(ASSET_DIR)
      .filter((n) => n.startsWith(`${id}.rawpage`) && n.endsWith('.png'))
      .sort((a, b) => pageNumOf(a) - pageNumOf(b));
    if (!produced.length) {
      throw new Error('PDF 转图片失败：未生成页面（文件可能损坏或受密码保护）');
    }
    produced.forEach((name, i) => {
      fs.renameSync(path.join(ASSET_DIR, name), pageFileOf(id, i + 1));
    });
    return produced.length;
  }

  const pageNumOf = (name) => Number((name.match(/-(\d+)\.png$/) || [])[1] || 0);

  /* ---------- 删除 ---------- */

  async function handleDelete(id) {
    const media = mediaOf(id);
    if (!media) throw new HttpError(404, `素材「${id}」不存在`);
    const victims = [origFileOf(id), pdfFileOf(id)];
    for (let n = 1; n <= Math.max(media.pages, 1); n++) victims.push(pageFileOf(id, n));
    for (const f of victims) {
      try { fs.unlinkSync(f); } catch (e) { /* 文件可能不存在 */ }
    }
    // 兜底清理同名残留（rawpage-*）
    for (const stale of fs.readdirSync(ASSET_DIR)) {
      if (stale.startsWith(`${id}.`)) {
        try { fs.unlinkSync(path.join(ASSET_DIR, stale)); } catch (e) { /* 忽略 */ }
      }
    }
    await mutate((d) => {
      d.medias = d.medias.filter((m) => m.id !== id);
    });
    playback.delete(id);
    log(`[media] 已删除 ${media.name}`);
    return { ok: true, deleted: id };
  }

  /* ---------- HTTP ---------- */

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  function sendJson(res, status, body, extraHeaders = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      ...extraHeaders
    });
    res.end(text);
  }

  const publicOf = (m) => ({
    id: m.id, name: m.name, kind: m.kind, label: KIND_LABEL[m.kind] || m.kind,
    ext: m.ext, size: m.size, pages: m.pages, status: m.status,
    reason: m.reason || '', createdAt: m.createdAt,
    progress: progressOf(m)
  });

  /**
   * 转换进度（实时）：raster 相位按「已生成的分页文件数 / 总页数」计算百分比；
   * convert 相位（soffice）为单步 opaque，返回不定长（percent=0，前端放动画）。
   * done 通过数输出目录里的 rawpage 文件得出，开销为一次 readdir。
   */
  function progressOf(m) {
    if (m.status === 'ready') {
      return { status: 'ready', phase: 'done', done: m.pages, total: m.pages, percent: 100 };
    }
    if (m.status !== 'processing') {
      return { status: m.status, phase: '', done: 0, total: 0, percent: 0 };
    }
    let done = 0;
    try {
      done = fs.readdirSync(ASSET_DIR)
        .filter((n) => n.startsWith(m.id + '.rawpage') && n.endsWith('.png')).length;
    } catch (e) { /* 目录读取失败按 0 */ }
    if (m.phase === 'raster' && m.total > 0) {
      const done2 = Math.min(done, m.total);
      return {
        status: 'processing', phase: 'raster', done: done2, total: m.total,
        percent: Math.min(99, Math.round((done2 / m.total) * 100))
      };
    }
    return { status: 'processing', phase: m.phase || 'convert', done: 0, total: m.total || 0, percent: 0 };
  }

  function isMediaPath(pathname) {
    const p = String(pathname || '');
    return p === '/api/media' || p.startsWith('/api/media/') ||
      p === '/media' || p.startsWith('/media/');
  }

  const ASSET_RE = /^\/media\/([a-z0-9-]{1,64})(\/view|\/raw|\/preview|\/progress|\/page-(\d+)\.png)$/;

  function handle(req, res, url) {
    try {
      route(req, res, url).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (status >= 500) log(`[media] ${req.method} ${url.pathname} ${err.message}`);
        if (res.headersSent) return res.end();
        if (status === 413) {
          sendJson(res, status, { error: err.message || '请求体过大' }, { ...CORS, Connection: 'close' });
          res.once('finish', () => { try { req.destroy(); } catch (e) { /* 忽略 */ } });
          return;
        }
        sendJson(res, status, { error: err.message || '服务端内部错误' }, CORS);
      });
    } catch (err) {
      // 同步抛出的校验错误（handleUpload 内的同步分支）
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: err.message || '服务端内部错误' }, CORS);
      else res.end();
    }
    return undefined;
  }

  async function route(req, res, url) {
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    /* ---------- /api/media/* ---------- */
    if (url.pathname === '/api/media' && method === 'GET') {
      sendJson(res, 200, { medias: registry.medias.map(publicOf) }, CORS);
      return;
    }
    if (url.pathname === '/api/media/upload' && method === 'POST') {
      await handleUpload(req, res, url);
      return;
    }
    const delMatch = url.pathname.match(/^\/api\/media\/([a-z0-9-]{1,64})$/);
    if (delMatch && method === 'DELETE') {
      sendJson(res, 200, await handleDelete(decodeURIComponent(delMatch[1])), CORS);
      return;
    }

    /* ---------- /media/<id>/*（播放端资源） ---------- */
    const m = url.pathname.match(ASSET_RE);
    if (m && method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const action = m[2];
      const media = mediaOf(id);
      if (!media) {
        return sendJson(res, 404, { error: '素材不存在或已被删除' }, CORS);
      }

      if (action === '/view') {
        const pb = playback.get(media.id) || null;
        const interval = clampInterval(url.searchParams.get('interval'), pb ? pb.intervalSec : media.intervalSec);
        // 默认手动翻页（auto=0）；未显式带参时沿用该素材最近一次上墙方式
        //（兼容只传 interval 的旧客户端），显式 auto/loop 优先（预览强制手动）
        const auto = parseBool(url.searchParams.get('auto'), pb ? pb.auto : false);
        const loop = parseBool(url.searchParams.get('loop'), pb ? pb.loop : true);
        return sendView(res, media, interval, auto, loop);
      }
      if (action === '/progress') {
        return sendJson(res, 200, progressOf(media), CORS);
      }
      if (action === '/raw') {
        return sendRaw(res, media, req.headers.range);
      }
      if (action === '/preview') {
        if (media.kind === 'image') return sendRaw(res, media, req.headers.range);
        if (PAGED_KINDS.includes(media.kind) && media.pages >= 1) {
          return sendPage(res, id, 1);
        }
        return sendJson(res, 404, { error: '该素材没有预览图' }, CORS);
      }
      const pageN = Number(m[3]);
      if (action.startsWith('/page-') && Number.isInteger(pageN)) {
        if (!PAGED_KINDS.includes(media.kind) || pageN < 1 || pageN > media.pages) {
          return sendJson(res, 404, { error: '页码不存在' }, CORS);
        }
        return sendPage(res, id, pageN);
      }
    }

    throw new HttpError(404, `未找到素材接口 ${method} ${url.pathname}`);
  }

  function clampInterval(v, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback || DEFAULT_INTERVAL_SEC;
    return Math.min(3600, Math.max(3, n));
  }

  function parseBool(v, fallback) {
    if (v === null || v === undefined || v === '') return fallback;
    const s = String(v).toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes') return true;
    if (s === '0' || s === 'false' || s === 'no') return false;
    return fallback;
  }

  function sendPage(res, id, n) {
    const file = pageFileOf(id, n);
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      return sendJson(res, 404, { error: '页码不存在' }, CORS);
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  }

  /** 原始文件（图片/视频）；视频需要 Range 支持（206 分片），否则部分内核拒绝起播 */
  function sendRaw(res, media, rangeHeader) {
    const view = viewFileOf(media.id);
    const useView = media.kind === 'image' && !IMAGE_NO_VIEW_EXT.has(media.ext) && fs.existsSync(view);
    const file = useView ? view : origFileOf(media.id);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      return sendJson(res, 404, { error: '素材文件缺失' }, CORS);
    }
    const type = useView ? 'image/jpeg' : (MIME[media.ext] || 'application/octet-stream');
    streamFileWithRange(res, file, stat.size, type, String(rangeHeader || ''));
  }

  function streamFileWithRange(res, file, size, type, rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (match && (match[1] || match[2])) {
      if (match[1] === '' && match[2] !== '') {
        // bytes=-N：末尾 N 字节
        const n = Number(match[2]);
        start = Math.max(0, size - n);
      } else {
        start = Number(match[1] || 0);
        if (match[2] !== '') end = Math.min(size - 1, Number(match[2]));
      }
      if (start >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      partial = true;
    }
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    };
    if (partial) {
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
    } else {
      headers['Content-Length'] = size;
      res.writeHead(200, headers);
    }
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => { try { res.destroy(); } catch (e) { /* 忽略 */ } });
    res.on('close', () => { try { stream.destroy(); } catch (e) { /* 忽略 */ } });
    stream.pipe(res);
  }

  /* ---------- 播放页（ES5，Chrome 66 底线） ---------- */

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function sendView(res, media, interval, auto, loop) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(viewHtml(media, interval, auto, loop));
  }

  function viewHtml(media, interval, auto, loop) {
    const base = '/media/' + encodeURIComponent(media.id);
    const head =
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=1920,initial-scale=1">' +
      '<title>' + esc(media.name) + '</title>' +
      '<style>' +
      'html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}' +
      /* 不能用 inset：Chrome 66 不支持（Chrome 87+），会导致舞台塌缩为 0×0 全黑 */
      '#stage{position:absolute;top:0;right:0;bottom:0;left:0}' +
      '#stage img,#stage video{position:absolute;top:0;right:0;bottom:0;left:0;width:100%;height:100%;object-fit:contain}' +
      '#ov{position:absolute;left:14px;bottom:12px;z-index:9;color:#fff;font:15px/1.5 ' +
      '"Microsoft YaHei",sans-serif;background:rgba(8,16,32,.55);border-radius:8px;' +
      'padding:6px 12px;pointer-events:none;transition:opacity .5s linear}' +
      '#ov.hide{opacity:0}' +
      /* 手动播放控制条（右下角，与左下角页码指示相对）：页内按钮供 Web/预览鼠标点击，
         电视端遥控器由 Activity 转发 __tvMediaNav（受控锁定时被拦截，见 MediaDisplayActivity） */
      '#ctl{position:absolute;right:14px;bottom:12px;z-index:10;display:flex;gap:6px}' +
      '#ctl button{font:14px/1.4 "Microsoft YaHei",sans-serif;color:#e8f1ff;' +
      'background:rgba(8,16,32,.6);border:1px solid rgba(255,255,255,.28);border-radius:8px;' +
      'padding:6px 14px;cursor:pointer}' +
      '#ctl button:hover{background:rgba(47,210,245,.35);border-color:#2FD2F5}' +
      '.err{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;' +
      'color:#8fa6c4;font:20px "Microsoft YaHei",sans-serif;text-align:center;line-height:2}' +
      '</style></head><body>';

    if (media.status === 'unsupported') {
      return head + '<div class="err">该素材无法上墙<br>' + esc(media.reason || '') + '</div></body></html>';
    }
    if (media.status !== 'ready') {
      return head + '<div class="err">素材处理中，请稍候…<br>（控制台就绪后会自动下发）</div></body></html>';
    }

    if (media.kind === 'video') {
      return head +
        '<div id="stage"><video id="v" src="' + base + '/raw" autoplay muted loop playsinline></video></div>' +
        '<script>(function(){var v=document.getElementById("v");' +
        'v.onerror=function(){setTimeout(function(){try{v.load();v.play();}catch(e){}},3000);};' +
        'var p=function(){var t=v.play();if(t&&t.catch)t.catch(function(){});};' +
        'if(v.readyState>=2)p();else v.oncanplay=p;' +
        'document.addEventListener("click",p);})();</script>' +
        '</body></html>';
    }

    if (media.kind === 'image') {
      return head +
        '<div id="stage"><img src="' + base + '/raw" alt=""></div>' +
        '<script>(function(){var im=document.querySelector("#stage img");' +
        'im.onerror=function(){setTimeout(function(){im.src="' + base + '/raw?t="+(new Date()).getTime();},3000);};})();</script>' +
        '</body></html>';
    }

    /* ---------- 分页播放器（PDF / PPT / DOC）：双缓冲 + 手动/自动翻页 + 可配循环 ---------- */
    const pages = Math.max(1, media.pages || 1);
    return head +
      '<div id="stage"><img id="ca" alt=""><img id="cb" alt=""></div>' +
      '<div id="ov">1/' + pages + ' · ' + (auto ? interval + 's/页' : '手动翻页') + '</div>' +
      '<div id="ctl">' +
      '<button id="bPrev" type="button">◀ 上一页</button>' +
      '<button id="bPlay" type="button"' + (auto ? '' : ' style="display:none"') + '>暂停</button>' +
      '<button id="bNext" type="button">下一页 ▶</button>' +
      '</div>' +
      '<script>' +
      '(function(){' +
      'var PAGES=' + pages + ',IV=' + interval + ',MODE_AUTO=' + (auto ? 1 : 0) + ',LOOP=' + (loop ? 1 : 0) + ';' +
      'var BASE="' + base + '";' +
      'var imgs=[document.getElementById("ca"),document.getElementById("cb")];' +
      'var cur=0,page=1,timer=0,fails=0,auto=!!MODE_AUTO,ended=false;' +
      'var ov=document.getElementById("ov");' +
      'var bPlay=document.getElementById("bPlay");' +
      'function urlOf(n){return BASE+"/page-"+n+".png?t="+(new Date()).getTime();}' +
      'function preload(n){var im=new Image();im.onload=function(){fails=0;};' +
      'im.onerror=function(){if(++fails>=6){clearInterval(timer);ov.innerHTML="页面加载失败";}' +
      'else setTimeout(function(){preload(n);},2000);};' +
      'im.src=urlOf(n);return im;}' +
      'function paint(){var s=page+"/"+PAGES+" · ";' +
      'if(ended)s+="已到末页";' +
      'else if(!MODE_AUTO)s+="手动翻页";' +
      'else if(!auto)s+="已暂停";' +
      'else s+=IV+"s/页"+(LOOP?"":" · 不循环");' +
      'ov.innerHTML=s;}' +
      'function show(n){' +
      'var el=imgs[1-cur];el.style.zIndex="3";imgs[cur].style.zIndex="2";' +
      'el.onload=function(){el.style.zIndex="3";cur=1-cur;paint();};' +
      'el.src=urlOf(n);}' +
      'function wrap(n){return (n-1+PAGES)%PAGES+1;}' +
      'function restartTimer(){clearInterval(timer);if(auto&&!ended){timer=setInterval(next,IV*1000);' +
      'try{window.__tvMediaLog.push({at:Date.now(),ev:"intervalOn"});}catch(e){}}}' +
      'function next(){go(1,"tick");}' +
      'function go(d,via){' +
      'var raw=page+d,target;' +
      'if(raw>PAGES){' +
      'if(!LOOP){if(via==="tick"){ended=true;auto=false;restartTimer();paint();blink();' +
      'try{window.__tvMediaLog.push({at:Date.now(),ev:"end"});}catch(e){}return;}target=PAGES;}' +
      'else target=1;' +
      '}else if(raw<1){target=LOOP?PAGES:1;}else target=raw;' +
      'if(via!=="tick")ended=false;' +
      'if(target===page){restartTimer();paint();blink();return;}' +
      'page=target;show(page);preload(wrap(page+d));restartTimer();blink();' +
      'try{window.__tvMediaLog.push({at:Date.now(),d:d,page:page,via:via||"?"});}catch(e){}}' +
      'window.__tvMediaLog=[];' +
      'function setAuto(on){if(!MODE_AUTO)return;' +
      'if(on&&ended){page=1;show(page);preload(2>PAGES?1:2);}' +
      'auto=on;ended=false;bPlay.innerHTML=on?"暂停":"播放";' +
      'try{window.__tvMediaLog.push({at:Date.now(),ev:"setAuto",auto:on});}catch(e){}' +
      'restartTimer();paint();blink();}' +
      /* 手动/自动播放入口（电视端 Activity 转发遥控器按键；Web/预览用页内按钮与方向键） */
      'window.__tvMediaNav=function(act){' +
      'if(act==="prev")go(-1,"nav");else if(act==="next")go(1,"nav");else if(act==="toggle")setAuto(!auto,"nav");};' +
      /* 状态钩子：测试与现场排查用（mode=manual|auto / page / auto / loop / ended） */
      'window.__tvMediaState=function(){return{page:page,auto:auto,cur:cur,PAGES:PAGES,' +
      'mode:MODE_AUTO?"auto":"manual",loop:!!LOOP,ended:ended};};' +
      'function fit(){var im=new Image();im.onload=function(){show(1);preload(2>PAGES?1:2);};im.src=urlOf(1);}' +
      'document.getElementById("bPrev").onclick=function(){go(-1,"btn");};' +
      'document.getElementById("bNext").onclick=function(){go(1,"btn");};' +
      'bPlay.onclick=function(){setAuto(!auto,"btn");};' +
      'document.addEventListener("keydown",function(ev){' +
      'var k=ev.key;' +
      'if(k==="ArrowLeft"){ev.preventDefault();go(-1,"key");}' +
      'else if(k==="ArrowRight"){ev.preventDefault();go(1,"key");}' +
      'else if((k===" "||k==="Spacebar")&&MODE_AUTO){ev.preventDefault();setAuto(!auto,"key");}' +
      '},false);' +
      'if(MODE_AUTO)timer=setInterval(next,IV*1000);fit();' +
      /* 收到任何按键 / 点击时把信息浮层亮出来（现场确认当前页码），3 秒后淡出 */
      'var ovT=0;function blink(){ov.className="";clearTimeout(ovT);' +
      'ovT=setTimeout(function(){ov.className="hide";},3000);}' +
      'blink();document.addEventListener("keydown",blink,false);document.addEventListener("click",blink,false);' +
      '})();</script>' +
      '</body></html>';
  }

  /* ---------- health ---------- */

  function status() {
    return {
      count: registry.medias.length,
      processing: registry.medias.filter((m) => m.status === 'processing').length,
      unsupported: registry.medias.filter((m) => m.status === 'unsupported').length,
      storageMB: Math.round(registry.medias.reduce((s, m) => s + (m.size || 0), 0) / 1048576 * 10) / 10,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      tools: {
        pdftoppm: toolCache.get('pdftoppm') ? toolCache.get('pdftoppm').ok : null,
        soffice: toolCache.get('soffice') ? toolCache.get('soffice').ok : null
      }
    };
  }

  return {
    isMediaPath,
    handle,
    status,
    /** 供 ctl 校验 media 指令目标是否存在 */
    exists,
    /** 供 ctl 记录该素材最近一次上墙方式（手动/自动 + 间隔 + 循环） */
    setPlayback,
    /** 供测试/运维核对 */
    _internals: { ASSET_DIR, REGISTRY_FILE, DEFAULT_INTERVAL_SEC, viewHtml }
  };
}

module.exports = { createMedia };
