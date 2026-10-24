'use strict';

/**
 * 摄像头 MJPEG 转码模块
 * ---------------------------------------------------------------------------
 * RTSP(H.265) --ffmpeg--> MJPEG(multipart/x-mixed-replace) --> 浏览器 <img>
 *
 * 为什么这么设计：
 *   1) 平台的 RTSP 码流是 H.265/HEVC，浏览器与 Android WebView 都不能可靠
 *      解码，因此必须由服务端转码；
 *   2) 输出选 MJPEG 而非 HLS/WebRTC：`<img>` 原生支持 multipart/x-mixed-replace，
 *      客户端零第三方库，电视端 WebView 同样可用（HLS 需 hls.js，WebRTC 需信令）；
 *   3) 画面墙取**子码流**（640×360@10fps，实测约占 6% 单核），单画面取
 *      主码流（1920×1080@12fps 缩放输出），在清晰度与开销间取得平衡。
 *
 * 进程模型：
 *   - 每个「摄像头 + 画质」共享一个 ffmpeg 进程，多个观看者广播同一份数据；
 *   - 最后一个观看者离开后延迟回收进程（切换布局时会立刻断流，CPU 随即释放）；
 *   - ffmpeg 异常退出时按退避自动重启，浏览器会保留最后一帧，重连后自动续播。
 *
 * 安全：RTSP 地址与凭据只存在服务端，客户端只能按**摄像头编号**点播，
 *       无法传入任意 URL（与 proxy.js 同一防 SSRF 原则）。
 *
 * 零依赖：只用 node:child_process / node:net / node:crypto / node:fs / node:path。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

/** ffmpeg mpjpeg 复用器固定使用该边界名 */
const BOUNDARY = 'ffmpeg';
/** 无观看者后延迟回收进程的时长（毫秒） */
const IDLE_MS = 8000;
/** 全局 ffmpeg 进程上限，防止异常情况下拖垮服务器 */
const MAX_PROCS = 14;
/** 通道在线探测结果缓存时长 */
const PROBE_TTL = 15000;
/** 单次探测超时 */
const PROBE_TIMEOUT = 4000;
/** 画面墙每行画面数（3 列） */
const WALL_COLS = 3;
/** 画面墙行数（3×3） */
const WALL_ROWS = 3;

const DEFAULT_TITLES = ['摄像头 1', '摄像头 2', '摄像头 3', '摄像头 4',
  '摄像头 5', '摄像头 6', '摄像头 7', '摄像头 8'];

/** 运行时配置（由 server.js 在加载数据后调用 configure 注入） */
let cfg = {
  enabled: false,
  host: '',
  port: 554,
  username: '',
  password: '',
  count: 8,
  titles: {},
  /** 画面墙品牌格要放的图片：绝对路径，或相对项目根的相对路径；留空则该格为纯黑 */
  logo: '',
  /** 品牌格在 3×3 中的序号（1 起，从左到右、从上到下）；其余格子依次排摄像头 */
  logoCell: 5,
  ffmpeg: 'ffmpeg'
};

function configure(next) {
  if (!next || typeof next !== 'object') return;
  cfg = Object.assign({}, cfg, next);
  // 配置变化后已建立的流转码参数可能失效，全部停掉等待重建
  if (!cfg.enabled) stopAll();
}

/** 摄像头编号是否合法：1..count 的整数 */
function isValidId(id) {
  const n = Number(id);
  return Number.isInteger(n) && n >= 1 && n <= cfg.count;
}

/** 主码流 x01 / 子码流 x02 */
function channelOf(id, quality) {
  return Number(id) * 100 + (quality === 'high' ? 1 : 2);
}

function titleOf(id) {
  const t = cfg.titles && cfg.titles[String(id)];
  return t ? String(t) : (DEFAULT_TITLES[id - 1] || `摄像头 ${id}`);
}

/** 品牌格图片的绝对路径；未配置或文件不存在时返回 ''（该格退化为纯黑） */
function logoFile() {
  const raw = String(cfg.logo || '').trim();
  if (!raw) return '';
  const abs = path.isAbsolute(raw) ? raw : path.join(__dirname, '..', raw);
  try {
    return fs.statSync(abs).isFile() ? abs : '';
  } catch (e) {
    return '';
  }
}

/**
 * 画面墙 9 个格子的内容（从左到右、从上到下）：
 *   数字 → 摄像头编号；'logo' → 品牌格（图片压在黑底居中）；null → 空位
 * 品牌格占用一格后，其余摄像头依次往后挪，保证 8 路仍全部上墙。
 */
function wallCells() {
  const total = WALL_COLS * WALL_ROWS;
  const logoCell = Math.min(total, Math.max(1, Number(cfg.logoCell) || total + 1));
  const cells = [];
  let id = 1;
  for (let i = 1; i <= total; i++) {
    if (i === logoCell && logoFile()) { cells.push('logo'); continue; }
    cells.push(id <= cfg.count ? id++ : null);
  }
  return cells;
}

/** 第 row 行（1 起）要显示的三个格子；空格合成时用黑帧占位 */
function wallRowIds(row) {
  const cells = wallCells();
  return cells.slice((row - 1) * WALL_COLS, row * WALL_COLS);
}

/** 仅路径部分，用于 RTSP 请求行与 Digest 的 uri 字段 */
function rtspPath(id, quality) {
  return `/Streaming/Channels/${channelOf(id, quality)}`;
}

/** 无凭据的绝对地址：Digest 认证要求请求行 uri 与摘要中的 uri 完全一致，
 *  因此探测时凭据只能放在 Authorization 头里，不能写进 URL。 */
function rtspUri(id, quality) {
  return `rtsp://${cfg.host}:${cfg.port}${rtspPath(id, quality)}`;
}

/** 带凭据的地址（供 ffmpeg 使用）；密码内的特殊字符（如 @）必须转义 */
function buildRtspUrl(id, quality) {
  const user = encodeURIComponent(cfg.username || '');
  const pass = encodeURIComponent(cfg.password || '');
  const auth = user ? `${user}${pass ? ':' + pass : ''}@` : '';
  return `rtsp://${auth}${cfg.host}:${cfg.port}${rtspPath(id, quality)}`;
}

/* ------------------------------------------------------------------ *
 * 通道在线探测：RTSP DESCRIBE + Digest 认证
 * ------------------------------------------------------------------ */

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const probeCache = new Map(); // id -> { at, online }

function probeChannel(id) {
  const cached = probeCache.get(id);
  const now = Date.now();
  if (cached && now - cached.at < PROBE_TTL) return Promise.resolve(cached.online);

  const uri = rtspUri(id, 'low');
  return new Promise((resolve) => {
    let done = false;
    let socket;
    let timer;
    const finish = (online) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (socket) socket.destroy(); } catch (e) { /* ignore */ }
      probeCache.set(id, { at: Date.now(), online });
      resolve(online);
    };

    try {
      socket = net.connect({ host: cfg.host, port: cfg.port });
    } catch (e) {
      return finish(false);
    }
    timer = setTimeout(() => finish(false), PROBE_TIMEOUT);
    socket.on('error', () => finish(false));

    let buf = '';
    let cseq = 0;
    const send = (method, auth) => {
      const lines = [`${method} ${uri} RTSP/1.0`, `CSeq: ${++cseq}`, 'Accept: application/sdp'];
      if (auth) lines.push(`Authorization: ${auth}`);
      lines.push('', '');
      socket.write(lines.join('\r\n'));
    };
    const digest = (head, method) => {
      const realm = (head.match(/realm="([^"]+)"/) || [])[1];
      const nonce = (head.match(/nonce="([^"]+)"/) || [])[1];
      if (!realm || !nonce) return null;
      const ha1 = md5(`${cfg.username}:${realm}:${cfg.password}`);
      const ha2 = md5(`${method}:${uri}`);
      return `Digest username="${cfg.username}", realm="${realm}", nonce="${nonce}", ` +
        `uri="${uri}", response="${md5(`${ha1}:${nonce}:${ha2}`)}"`;
    };

    let authed = false;
    socket.on('connect', () => send('DESCRIBE', null));
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      // 只处理首个响应，避免旧响应干扰
      if (!/\r\n\r\n/.test(buf)) return;
      const head = buf.slice(0, buf.indexOf('\r\n\r\n'));
      if (/^RTSP\/1\.0 200/.test(head)) return finish(true);
      if (/^RTSP\/1\.0 401/.test(head) && !authed) {
        const auth = digest(head, 'DESCRIBE');
        if (auth) {
          authed = true;
          buf = '';
          return send('DESCRIBE', auth);
        }
      }
      return finish(false);
    });
  });
}

/** 并发受限的批量探测，供 /api/cameras 使用 */
async function listCameras() {
  const ids = [];
  for (let i = 1; i <= cfg.count; i++) ids.push(i);
  const online = new Map();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      online.set(id, await probeChannel(id));
    }
  });
  await Promise.all(workers);
  return ids.map((id) => ({
    id,
    title: titleOf(id),
    online: online.get(id) === true
  }));
}

/* ------------------------------------------------------------------ *
 * 转码进程与多客户端广播
 * ------------------------------------------------------------------ */

const streams = new Map(); // `${id}:${quality}` -> Stream

class Stream {
  constructor(spec) {
    // spec: { kind:'single', id, quality } | { kind:'wall', row, ids:[id|null,...] }
    this.spec = spec;
    this.clients = new Set();
    this.proc = null;
    this.idleTimer = null;
    this.restartDelay = 1000;
    this.restartTimer = null;
    this.starting = false;
    this.failed = false;
    this.stderr = '';
  }

  get key() {
    return this.spec.kind === 'wall' ? `wall:${this.spec.row}` : `${this.spec.id}:${this.spec.quality}`;
  }

  /** 有新观看者：写响应头并加入广播 */
  add(req, res) {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      'X-Accel-Buffering': 'no'
    });
    this.clients.add(res);
    const drop = () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.scheduleIdleStop();
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('close', drop);
    this.ensureRunning();
  }

  ensureRunning() {
    if (this.proc || this.restartTimer || this.starting) return;
    if (streams.size > MAX_PROCS) return; // 超限时静默等待，退避后由 idle 回收
    this.start();
  }

  /** 起进程前先解析输入：画面墙需要探测在线状态（异步），单路直接起 */
  async start() {
    this.starting = true;
    try {
      const online = await this.resolveInputs();
      if (this.clients.size === 0 || this.proc || this.restartTimer) return;
      this.spawnProc(online);
    } catch (e) {
      this.scheduleRestart();
    } finally {
      this.starting = false;
    }
  }

  /**
   * 画面墙每行由 3 路合成。离线通道换成黑帧输入——否则单路 RTSP 连不上会
   * 让整个 filter graph 卡住或退出，连带把同行的好画面一起拖黑。
   */
  async resolveInputs() {
    if (this.spec.kind !== 'wall') return null;
    const online = [];
    for (const cell of this.spec.ids) {
      // 品牌格与空位都不需要探测通道（合成时直接用黑帧）
      online.push(typeof cell === 'number' ? await probeChannel(cell) : false);
    }
    return online;
  }

  buildArgs(online) {
    if (this.spec.kind === 'wall') return this.wallArgs(online);
    return [
      '-nostdin',
      '-loglevel', 'error',
      // 低延迟：不做输入缓冲，且限制 RTSP 读超时，避免网络抖动时无限等待
      '-rtsp_transport', 'tcp',
      '-stimeout', '5000000',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-i', buildRtspUrl(this.spec.id, this.spec.quality),
      '-an',
      // 画面墙直接用子码流原生 640×360，无需缩放；单画面把主码流降到 720p 输出
      '-vf', this.spec.quality === 'high' ? 'fps=12,scale=1280:-2' : 'fps=10',
      '-q:v', '6',
      '-f', 'mpjpeg',
      '-'
    ];
  }

  /**
   * 把一行 3 路画面横向拼成 1920×360 输出。
   * 为什么在服务端拼：浏览器对同一域名只并发 6 条 HTTP/1.1 连接，而 MJPEG 是
   * 永不结束的长连接——8 路画面会占满 6 条后把其余请求永久排队（表现为随机
   * 几格永远黑屏）。按行拼接后整面墙只占 3 条连接，还能留出余量给接口请求。
   */
  wallArgs(online) {
    const ids = this.spec.ids;
    const args = ['-nostdin', '-loglevel', 'error'];
    ids.forEach((id, i) => {
      if (typeof id === 'number' && online[i]) {
        args.push('-rtsp_transport', 'tcp', '-stimeout', '5000000',
          '-fflags', 'nobuffer', '-flags', 'low_delay',
          '-i', buildRtspUrl(id, 'low'));
      } else {
        // 空位与品牌格都用黑帧：品牌格的图由客户端叠在黑底上画，
        // 不在这里合成——墙面是 object-fit:fill，格子宽高比随窗口变化，
        // 合成进视频的图会被横向抻宽（实测 7.5%），比例对不上原素材。
        args.push('-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=10');
      }
    });
    let fc = '';
    for (let i = 0; i < ids.length; i++) {
      fc += `[${i}:v]fps=10,scale=640:360,setpts=PTS-STARTPTS[v${i}];`;
    }
    for (let i = 0; i < ids.length; i++) fc += `[v${i}]`;
    fc += `hstack=inputs=${ids.length},fps=10[out]`;
    return args.concat([
      '-an',
      '-filter_complex', fc,
      '-map', '[out]',
      '-q:v', '7',
      '-f', 'mpjpeg',
      '-'
    ]);
  }

  spawnProc(online) {
    const args = this.buildArgs(online);

    let proc;
    try {
      proc = spawn(cfg.ffmpeg || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.failed = true;
      return this.scheduleRestart();
    }
    this.proc = proc;
    this.failed = false;

    proc.stdout.on('data', (chunk) => this.broadcast(chunk));
    proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-500);
    });
    proc.on('error', () => {
      this.proc = null;
      this.failed = true;
      this.scheduleRestart();
    });
    proc.on('exit', (code) => {
      this.proc = null;
      if (code === 0 && this.clients.size === 0) return; // 正常空闲退出
      this.scheduleRestart();
    });
  }

  /** 异常退出后按退避重启，最长 8 秒一次，保证网络恢复后自动续播 */
  scheduleRestart() {
    if (this.clients.size === 0 || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 8000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // 走 ensureRunning 而不是直接 spawnProc：画面墙借此重探在线状态，
      // 掉线又恢复的通道才能重新入画（否则会一直用黑帧占位）
      if (this.clients.size > 0) this.ensureRunning();
    }, delay);
  }

  broadcast(chunk) {
    this.restartDelay = 1000; // 收到数据即视为恢复
    for (const res of this.clients) {
      if (res.writableEnded) { this.clients.delete(res); continue; }
      try { res.write(chunk); } catch (e) { this.clients.delete(res); }
    }
  }

  scheduleIdleStop() {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.clients.size === 0) this.stop();
    }, IDLE_MS);
  }

  stop() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.proc) {
      const proc = this.proc;
      this.proc = null;
      try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
    streams.delete(this.key);
  }
}

/** 画面墙网页（ES5）：三条按行合成的 MJPEG 纵向铺满 1920×1080，
 *  供轮询展示 / 分区展示的 WebView 与 iframe 内嵌加载（原生 CameraWallActivity 不走这里） */
function cameraViewHtml() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=1920,initial-scale=1"><title>机房监控画面墙</title>' +
    '<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}' +
    'img{display:block;width:100%;height:33.334%;object-fit:fill;background:#000}</style>' +
    '</head><body>' +
    '<img src="/cam/wall.mjpg?row=1" alt="">' +
    '<img src="/cam/wall.mjpg?row=2" alt="">' +
    '<img src="/cam/wall.mjpg?row=3" alt="">' +
    '</body></html>';
}

/**
 * 处理 GET /cam/<id>.mjpg（quality=high 为主码流，默认子码流）
 *     与 GET /cam/wall.mjpg?row=<1..3>（画面墙按行合成的一整条画面）
 *     与 GET /cam/logo.png（画面墙品牌格图片，客户端叠在黑底上显示）
 *     与 GET /cam/view（画面墙网页，轮询/分区 WebView 内嵌用）
 * 返回 false 表示不是本模块的路径，交给上层继续找路由。
 */
function handleStream(req, res, url) {
  if (!cfg.enabled) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '摄像头模块未启用' }));
  }

  // 品牌格图片：客户端叠在黑底上显示，交给浏览器按 contain 缩放，
  // 比例与原素材严格一致（合成进 MJPEG 会被墙面 fill 抻宽）
  if (url.pathname === '/cam/logo.png') {
    const file = logoFile();
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '未配置品牌格图片' }));
    }
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '品牌格图片读取失败' }));
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
    res.end(buf);
    return true;
  }

  if (url.pathname === '/cam/view') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(cameraViewHtml());
  }

  if (url.pathname === '/cam/wall.mjpg') {
    const row = Number(url.searchParams.get('row') || 1);
    if (!Number.isInteger(row) || row < 1 || row > WALL_ROWS) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: `画面墙行号需为 1-${WALL_ROWS}` }));
    }
    const key = `wall:${row}`;
    let wall = streams.get(key);
    if (!wall) {
      wall = new Stream({ kind: 'wall', row, ids: wallRowIds(row) });
      streams.set(key, wall);
    }
    wall.add(req, res);
    return true;
  }

  const m = /^\/cam\/(\d+)\.mjpg$/.exec(url.pathname);
  if (!m) return false;
  const id = Number(m[1]);
  if (!isValidId(id)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: `摄像头编号需为 1-${cfg.count}` }));
  }
  const quality = url.searchParams.get('q') === 'high' ? 'high' : 'low';
  const key = `${id}:${quality}`;
  let stream = streams.get(key);
  if (!stream) {
    stream = new Stream({ kind: 'single', id, quality });
    streams.set(key, stream);
  }
  stream.add(req, res);
  return true;
}

function stopAll() {
  for (const stream of Array.from(streams.values())) stream.stop();
  streams.clear();
}

module.exports = {
  configure,
  isValidId,
  listCameras,
  wallCells,
  handleStream,
  stopAll,
  get config() { return cfg; }
};
