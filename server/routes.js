/**
 * HTTP 路由层：页面托管、客户端接口、管理接口、增量协议与入口校验。
 * ---------------------------------------------------------------------------
 * 从 server.js 抽出的路由部分。运行期依赖（代理 / 截图 / 互控模块）通过
 * 取值函数注入，因为这些实例在 start() 里才创建。
 */
'use strict';

const { URL } = require('node:url');
const crypto = require('node:crypto');
const transpile = require('./transpile');
const {
  HttpError,
  bad,
  requireString,
  sendJson,
  sendEmpty,
  serveHtmlFile,
  readBody,
  CORS
} = require('./http-util');
const { ID_PATTERN, COLOR_PATTERN, ALLOWED_ICONS } = require('./store');

/** 入口类型：普通网页 / 内置摄像头画面墙 */
const ALLOWED_TYPES = ['url', 'camera'];

/* ============================ 校验 ============================ */

/** 校验并规范化一个入口；existingId 用于更新场景（允许沿用自身 id） */
function validateEntry(body, { existingId = null, existingType = null, takenIds = new Set() } = {}) {
  if (!body || typeof body !== 'object') throw bad('请求体必须是 JSON 对象');

  // 管理后台表单不含 type：更新已有入口时沿用原类型，避免把画面墙入口改回普通网页
  const fallbackType = ALLOWED_TYPES.includes(existingType) ? existingType : 'url';
  const type = ALLOWED_TYPES.includes(body.type) ? body.type : fallbackType;

  // 画面墙是客户端内置页面，不依赖外部网址；普通网页仍强制校验 URL
  let url = String(body.url || '').trim();
  if (type === 'camera') {
    url = '';
  } else {
    url = requireString(body.url, 'URL', { max: 2000 });
    if (!/^https?:\/\/.+/i.test(url)) throw bad('URL 必须以 http:// 或 https:// 开头');
  }

  let accent = String(body.accent || '#2FD2F5').trim();
  if (!COLOR_PATTERN.test(accent)) throw bad('主题色格式应为 #RRGGBB');

  const icon = ALLOWED_ICONS.includes(body.icon) ? body.icon : 'default';

  let scale = Number(body.scale);
  if (!Number.isFinite(scale)) scale = 0;
  scale = Math.round(scale);
  if (scale !== 0 && (scale < 50 || scale > 200)) throw bad('缩放需为 0（自动）或 50–200 之间');

  let id = existingId;
  if (!id) {
    const raw = String(body.id || '').trim().toLowerCase();
    id = raw || `entry-${crypto.randomBytes(3).toString('hex')}`;
    if (!ID_PATTERN.test(id)) throw bad('ID 只能包含小写字母、数字与短横线，且不超过 64 字符');
    if (takenIds.has(id)) throw bad(`ID「${id}」已存在`);
  }

  // 旧内核兼容：目标内核留空表示用默认值（chrome66）
  const compatTarget = String(body.compatTarget || '').trim();
  if (compatTarget && !transpile.isTarget(compatTarget)) {
    throw bad('转译目标内核格式应为 chrome66 / es2019 / safari13 这类标识');
  }

  // 极速模式（截图展示）参数：非法直接 400，不落库
  let turboIntervalSec = body.turboIntervalSec === undefined || body.turboIntervalSec === ''
    ? 2 : Number(body.turboIntervalSec);
  if (!Number.isFinite(turboIntervalSec)) throw bad('极速刷新率必须是数字（单位：秒）');
  if (Math.abs(Math.round(turboIntervalSec * 10) / 10 - turboIntervalSec) > 1e-9) {
    throw bad('极速刷新率最多支持一位小数（如 0.5、2、3.5）');
  }
  if (turboIntervalSec < 0.2 || turboIntervalSec > 60) throw bad('极速刷新率需在 0.2 ~ 60 秒之间');
  turboIntervalSec = Math.round(turboIntervalSec * 10) / 10;
  const turboQuality = body.turboQuality === undefined || body.turboQuality === ''
    ? 75 : Number(body.turboQuality);
  if (!Number.isInteger(turboQuality) || turboQuality < 50 || turboQuality > 95) {
    throw bad('极速 JPEG 质量需为 50 ~ 95 之间的整数');
  }

  const entry = {
    id,
    type,
    title: requireString(body.title, '标题', { max: 120 }),
    subtitle: String(body.subtitle || '').trim().slice(0, 200),
    url,
    accent,
    icon,
    scale,
    autoFit: body.autoFit !== false,
    allowInsecureSsl: body.allowInsecureSsl === true,
    openOriginal: body.openOriginal === true,
    spaHistory: body.spaHistory === true,
    compatTranspile: body.compatTranspile === true,
    compatTarget,
    // 极速模式（截图展示）：默认全部参与；camera 类型不参与（/shot 兜底 404）
    turboEnabled: body.turboEnabled !== false,
    turboIntervalSec,
    turboQuality
  };

  const al = body.autoLogin;
  if (al && typeof al === 'object' && (al.enabled === true || al.username || al.password)) {
    entry.autoLogin = {
      enabled: al.enabled !== false,
      username: String(al.username || '').trim().slice(0, 200),
      password: String(al.password || ''),
      usernameSelector: String(al.usernameSelector || '').trim().slice(0, 300),
      passwordSelector: String(al.passwordSelector || '').trim().slice(0, 300),
      submitSelector: String(al.submitSelector || '').trim().slice(0, 300),
      successSelector: String(al.successSelector || '').trim().slice(0, 300)
    };
    if (entry.autoLogin.enabled && !entry.autoLogin.password) {
      throw bad('启用自动登录时必须填写密码');
    }
  }
  return entry;
}

/* ============================ 增量协议 ============================ */

function etagOf(d) {
  return `"${d.epoch}-${d.version}"`;
}

/** 解析客户端持有的 epoch：优先取 epoch 查询参数，其次从 If-None-Match 的 ETag 中解析 */
function clientEpochOf(searchParams, ifNoneMatch) {
  const q = searchParams.get('epoch');
  if (q !== null && Number.isFinite(Number(q))) return Number(q);
  if (ifNoneMatch) {
    const head = String(ifNoneMatch).replace(/"/g, '').split('-')[0];
    if (Number.isFinite(Number(head))) return Number(head);
  }
  return null; // 客户端未提供，无法判断代次
}

/** 客户端拉取：全量 / 增量 / 304 */
function buildClientPayload(d, { since, ifNoneMatch, searchParams }) {
  const etag = etagOf(d);
  if (ifNoneMatch && ifNoneMatch === etag) {
    return { status: 304, etag };
  }

  const sinceNum = Number.isFinite(Number(since)) && Number(since) > 0 ? Number(since) : 0;
  const clientEpoch = clientEpochOf(searchParams, ifNoneMatch);
  const epochMismatch = clientEpoch !== null && clientEpoch !== d.epoch;

  // 首次拉取 / 删除痕迹已被裁剪 / 代次变化 / 版本超前（服务端被回滚过）→ 全量
  if (!sinceNum || sinceNum < d.prunedBeforeRev || epochMismatch || sinceNum > d.version) {
    return { status: 200, etag, body: { full: fullSnapshot(d), version: d.version, epoch: d.epoch } };
  }

  if (sinceNum === d.version) {
    return { status: 304, etag };
  }

  const body = { version: d.version, epoch: d.epoch, since: sinceNum };
  if (d.metaRev > sinceNum) {
    body.meta = fullMeta(d);
  }
  // 顺序变化必须显式下发：增量里新增/修改条目的位置无法表达“整体重排”，
  // 客户端仅凭 upserted 无法区分“改了一个字段”和“顺序变了”。
  if (d.orderRev > sinceNum) {
    body.order = d.entries.map((e) => e.id);
  }
  const upserted = d.entries.filter((e) => e.rev > sinceNum);
  const deletedIds = d.tombstones.filter((t) => t.rev > sinceNum).map((t) => t.id);
  if (upserted.length) body.upserted = upserted;
  if (deletedIds.length) body.deletedIds = deletedIds;
  return { status: 200, etag, body };
}

/** 全量快照：不含内部 bookkeeping 字段（rev/prunedBeforeRev） */
function fullSnapshot(d) {
  return {
    appTitle: d.appTitle,
    appSubtitle: d.appSubtitle,
    exitConfirm: d.exitConfirm,
    exitTip: d.exitTip,
    entries: d.entries.map((e) => {
      const copy = { ...e };
      delete copy.rev;
      return copy;
    }),
    cameras: { enabled: d.cameras.enabled, count: d.cameras.count, titles: d.cameras.titles }
  };
}

function fullMeta(d) {
  return {
    appTitle: d.appTitle,
    appSubtitle: d.appSubtitle,
    exitConfirm: d.exitConfirm,
    exitTip: d.exitTip
  };
}

/* ============================ 路由 ============================ */

/**
 * 创建路由入口。
 * @param {object} opts
 * @param {object} opts.store      数据仓库（data / mutate）
 * @param {object} opts.camera     摄像头画面墙模块
 * @param {object} opts.files      { adminFile, clientFile, previewFile, consoleFile }
 * @param {function} opts.getProxy 反向代理实例取值（start() 内创建）
 * @param {function} opts.getShot  极速模式实例取值
 * @param {function} opts.getCtl   互控通道实例取值
 */
function createRouter({ store, camera, files, getProxy, getShot, getCtl }) {
  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // 数据与写入口：读操作直接看当前快照，写操作走串行 mutate
    const data = store.data;
    const mutate = store.mutate;
    const proxy = getProxy();
    const shot = getShot();
    const ctl = getCtl();

    // 反向代理必须用**未归一化**的原始 pathname（/cockpit/ 与 /cockpit 语义不同），
    // 所以要放在下面的尾斜杠归一化之前。
    if (proxy && proxy.isProxyPath(url.pathname)) return proxy.handle(req, res, url);

    // 极速模式（截图展示）：/shot/<id>/view|frame.jpg|meta.json|beat
    if (shot && shot.isShotPath(url.pathname)) return shot.handle(req, res, url);

    // 多设备互控 · 控制通道：/api/ctl/*
    if (ctl && ctl.isCtlPath(url.pathname)) return ctl.handle(req, res, url);

    const p = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') return sendEmpty(res, 204, CORS);

    /* ---------- 电脑浏览器客户端页面（站点首页） ---------- */
    // 站点根路径即电脑端客户端（纯显示端）；/app、/client 为历史别名，保持可用
    if (p === '/' || p === '/index.html' || p === '/app' || p === '/client' ||
        p === '/app/index.html' || p === '/client/index.html') {
      return serveHtmlFile(res, files.clientFile, '电脑端客户端页面缺失，请先执行 node tools/build-client.mjs');
    }

    /* ---------- 多设备互控 · 独立控制台（纯控制端，不注册受控） ---------- */
    if (p === '/console') {
      return serveHtmlFile(res, files.consoleFile, '控制台页面缺失');
    }

    /* ---------- 管理（设置）页面 ---------- */
    // 专用路径 /setting；/admin 为历史别名
    if (p === '/setting' || p === '/setting/index.html' || p === '/admin' || p === '/admin/index.html') {
      return serveHtmlFile(res, files.adminFile, '管理页面文件缺失');
    }

    /* ---------- 电视端预览页面 ---------- */
    if (p === '/preview' || p === '/preview.html') {
      return serveHtmlFile(res, files.previewFile, '预览页缺失，请先执行 node tools/build-preview.mjs');
    }

    /* ---------- 客户端接口 ---------- */
    if (p === '/api/version' && method === 'GET') {
      return sendJson(res, 200, { version: data.version, epoch: data.epoch }, { ...CORS, ETag: etagOf(data) });
    }

    if (p === '/api/config' && method === 'GET') {
      // 只有显式 true/1 才强制全量：?full=0、?full=false 按增量处理（旧实现把字符串当真值）
      const full = url.searchParams.get('full');
      const wantFull = full === '1' || full === 'true';
      const since = url.searchParams.get('since');
      const inm = req.headers['if-none-match'];
      const result = wantFull
        ? { status: 200, etag: etagOf(data), body: { full: fullSnapshot(data), version: data.version, epoch: data.epoch } }
        : buildClientPayload(data, { since, ifNoneMatch: inm, searchParams: url.searchParams });
      if (result.status === 304) return sendEmpty(res, 304, { ...CORS, ETag: result.etag });
      return sendJson(res, 200, result.body, { ...CORS, ETag: result.etag });
    }

    /* ---------- 摄像头画面墙（客户端按编号点播，服务端转码为 MJPEG） ---------- */
    if (p === '/api/cameras' && method === 'GET') {
      if (!data.cameras.enabled) return sendJson(res, 200, { enabled: false, cameras: [], cells: [] }, CORS);
      const list = await camera.listCameras();
      // cells 是画面墙 9 格的排布（编号 / 'logo' / null），客户端据此渲染浮层，
      // 与服务端按行合成的画面保持同一套顺序，避免两边各写一份规则
      return sendJson(res, 200, { enabled: true, cameras: list, cells: camera.wallCells() }, CORS);
    }

    if (p.startsWith('/cam/') && method === 'GET') {
      if (camera.handleStream(req, res, url)) return;
      return sendJson(res, 404, { error: '无效的摄像头地址' }, CORS);
    }

    /* ---------- 管理接口 ---------- */
    if (p === '/api/admin/health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        version: data.version,
        epoch: data.epoch,
        entries: data.entries.length,
        tombstones: data.tombstones.length,
        updatedAt: data.updatedAt,
        uptimeSec: Math.round(process.uptime()),
        // 旧内核兼容转译能力（esbuild 是否装上、命中情况），便于现场诊断白屏
        transpile: transpile.status(),
        // 极速模式（截图采集）能力与活跃数
        shot: shot
          ? shot.status()
          : { available: false, reason: '未初始化', activeEntries: 0 },
        // 多设备互控：设备档案规模与在线数
        ctl: ctl ? ctl.status() : null
      }, { ...CORS, ETag: etagOf(data) });
    }

    if (p === '/api/admin/config' && method === 'GET') {
      return sendJson(res, 200, data, { ...CORS, ETag: etagOf(data) });
    }

    if (p === '/api/admin/meta' && method === 'PUT') {
      const body = await readBody(req);
      await mutate((d) => {
        if (body.appTitle !== undefined) d.appTitle = requireString(body.appTitle, '系统标题', { max: 60 });
        if (body.appSubtitle !== undefined) d.appSubtitle = String(body.appSubtitle || '').trim().slice(0, 80);
        if (body.exitConfirm !== undefined) d.exitConfirm = body.exitConfirm !== false;
        if (body.exitTip !== undefined) d.exitTip = String(body.exitTip || '').trim().slice(0, 80);
        d.metaRev = d.version + 1; // mutate 之后 version 会 +1，使 metaRev 恰好等于新版本
      });
      return sendJson(res, 200, { ok: true, version: data.version, meta: fullMeta(data) }, { ...CORS, ETag: etagOf(data) });
    }

    if (p === '/api/admin/entries' && method === 'POST') {
      const body = await readBody(req);
      const taken = new Set(data.entries.map((e) => e.id));
      const entry = validateEntry(body, { takenIds: taken });
      await mutate((d) => {
        // 写锁内复查：并发创建同 id 时，validateEntry 的外层检查已过期
        if (d.entries.some((e) => e.id === entry.id)) throw bad(`ID「${entry.id}」已存在`);
        entry.rev = d.version + 1;
        d.entries.push(entry);
      });
      return sendJson(res, 201, { ok: true, version: data.version, entry }, { ...CORS });
    }

    // 注意：reorder 必须放在 entries/:id 之前，否则会被通配路由当成 id="reorder"
    if (p === '/api/admin/entries/reorder' && method === 'POST') {
      const body = await readBody(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
      if (!ids || ids.length !== data.entries.length) throw bad('ids 必须包含全部入口 id');
      const current = new Set(data.entries.map((e) => e.id));
      if (ids.some((id) => !current.has(id)) || new Set(ids).size !== ids.length) {
        throw bad('ids 与现有入口不一致');
      }
      await mutate((d) => {
        d.entries.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        // 顺序本身也是数据：记 orderRev，客户端据此整体重排（无需重发全部条目）
        d.orderRev = d.version + 1;
      });
      return sendJson(res, 200, { ok: true, version: data.version, ids }, { ...CORS });
    }

    const entryMatch = p.match(/^\/api\/admin\/entries\/([^/]+)$/);
    if (entryMatch) {
      const id = decodeURIComponent(entryMatch[1]);
      const idx = data.entries.findIndex((e) => e.id === id);
      if (idx < 0) throw new HttpError(404, `入口「${id}」不存在`);

      if (method === 'PUT') {
        const body = await readBody(req);
        const entry = validateEntry(body, { existingId: id, existingType: data.entries[idx].type });
        await mutate((d) => {
          const i = d.entries.findIndex((e) => e.id === id);
          // 外层 idx 校验与写锁之间可能已被并发删除，必须重新定位；
          // 否则 i=-1 会把 entry 写到数组的 "-1" 属性上（不入数组但接口谎报成功）
          if (i < 0) throw new HttpError(404, `入口「${id}」不存在`);
          entry.rev = d.version + 1;
          d.entries[i] = entry;
        });
        return sendJson(res, 200, { ok: true, version: data.version, entry }, { ...CORS });
      }

      if (method === 'DELETE') {
        await mutate((d) => {
          const i = d.entries.findIndex((e) => e.id === id);
          // 必须复查：splice(-1, 1) 会误删数组最后一条（并发重复删除时的数据丢失事故）
          if (i < 0) throw new HttpError(404, `入口「${id}」不存在`);
          d.entries.splice(i, 1);
          d.tombstones = d.tombstones.filter((t) => t.id !== id);
          d.tombstones.push({ id, rev: d.version + 1 });
        });
        return sendJson(res, 200, { ok: true, version: data.version, deleted: id }, { ...CORS });
      }
    }

    if (p === '/api/admin/epoch/bump' && method === 'POST') {
      await mutate((d) => { d.epoch += 1; });
      return sendJson(res, 200, { ok: true, version: data.version, epoch: data.epoch }, { ...CORS });
    }

    // 被代理页面用 location.href='/x' 跳转时前缀会丢失，这里按 Referer 兜底回带前缀的地址
    if (proxy && proxy.handleEscaped(req, res, url)) return undefined;

    throw new HttpError(404, `未找到接口 ${method} ${p}`);
  }

  return { handle };
}

module.exports = { createRouter };
