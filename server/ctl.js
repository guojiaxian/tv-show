/**
 * 多设备互控 · 控制通道模块
 * ---------------------------------------------------------------------------
 * 零依赖：仅使用 Node 内置模块。设计见 docs/远程控制台-设计方案.md（v4）。
 *
 * 职责（全部挂在 /api/ctl/* 前缀，由 server.js 分发）：
 *   POST /api/ctl/beat              设备心跳：注册 / 上报状态 / 领指令 / 同步模式
 *   POST /api/ctl/send              控制端下发指令（targets 支持 ["*"]）
 *   POST /api/ctl/release           控制端「取消控制」：managed=false + desired 清空
 *   GET  /api/ctl/devices           设备列表（含在线判定 / 待送达标记）
 *   PUT  /api/ctl/device/:id        改名 / 开关 bootRestore
 *   DELETE /api/ctl/device/:id      从档案移除（下次心跳会重新注册）
 *   POST /api/ctl/scenes            保存场景（直接传 steps 或快照当前现场）
 *   POST /api/ctl/scenes/:id/apply  应用场景（逐台下发，seq 逐台自增）
 *   PUT  /api/ctl/scenes/:id        场景重命名
 *   DELETE /api/ctl/scenes/:id      删除场景
 *
 * 数据：server/data/devices.json（独立于 config.json，原子写 + .bak 备份）。
 * 心跳高频字段（reported / lastSeenAt）只在内存，不落盘。
 *
 * 核心语义（设计 §8）：
 *   - managed 是模式权威状态：展示类指令自动置 true（强制接管），
 *     release / 设备开关意图 switchTo:"local" 置 false 并清空 desired；
 *   - desired 只保留最后一条指令（覆盖不排队）；设备 ack 维护类指令后自动清除，
 *     展示类保留（供 boot 恢复重发）；
 *   - seq 全局自增，最后写入者胜。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ============================ 常量 ============================ */

const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ALLOWED_KINDS = ['tv', 'pc', 'tablet'];
/** 展示类指令：应用后设备自动进入远程被控 */
const DISPLAY_CMDS = ['show', 'rotate', 'zone', 'home'];
/** 维护类指令：不改变模式，两种模式下都可用 */
const MAINTAIN_CMDS = ['refresh', 'sync'];
const ALL_CMDS = [...DISPLAY_CMDS, ...MAINTAIN_CMDS];
/** 场景 step 允许的指令（与展示类一致：场景就是一批展示指令的快照） */
const SCENE_CMDS = DISPLAY_CMDS;
const ONLINE_SEC = 10;
const RECENT_SEC = 60;
const MAX_DEVICES = 500;
const MAX_SCENES = 50;
const MAX_BODY_BYTES = 256 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

/* ============================ 模块工厂 ============================ */

function createCtl({ dataDir, getEntries, getContentVersion, log = () => {} }) {
  const DATA_FILE = path.join(dataDir, 'devices.json');
  const BACKUP_FILE = `${DATA_FILE}.bak`;

  let data = null; // { seq, devices: [], scenes: [] }
  /** 串行化写操作，避免并发请求基于同一份旧数据互相覆盖（与 server.js 一致） */
  let writeChain = Promise.resolve();

  /* ---------- 数据层 ---------- */

  function seedData() {
    return { seq: 0, devices: [], scenes: [] };
  }

  function normalizeDevice(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || '');
    if (!DEVICE_ID_PATTERN.test(id)) return null;
    const kind = ALLOWED_KINDS.includes(raw.kind) ? raw.kind : 'pc';
    return {
      id,
      name: String(raw.name || `新设备-${id.slice(-4)}`).slice(0, 60),
      kind,
      appVersion: String(raw.appVersion || '').slice(0, 20),
      registeredAt: raw.registeredAt || new Date().toISOString(),
      managed: raw.managed === true,
      // bootRestore 仅注册时按 kind 定默认值，之后落盘值优先
      bootRestore: raw.bootRestore === undefined || raw.bootRestore === null
        ? kind !== 'tablet'
        : raw.bootRestore === true,
      desired: normalizeDesired(raw.desired),
      ackedSeq: Number.isFinite(Number(raw.ackedSeq)) ? Number(raw.ackedSeq) : 0,
      // 以下为内存态（不落盘）
      reported: null,
      lastSeenAt: 0
    };
  }

  function normalizeDesired(raw) {
    if (!raw || typeof raw !== 'object' || !ALL_CMDS.includes(raw.cmd)) return null;
    return {
      seq: Number(raw.seq) || 0,
      cmd: String(raw.cmd),
      args: raw.args && typeof raw.args === 'object' ? raw.args : {},
      issuedAt: raw.issuedAt || new Date().toISOString()
    };
  }

  function normalizeScene(raw, i) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || `scene-${i + 1}`);
    const steps = Array.isArray(raw.steps)
      ? raw.steps
          .filter((s) => s && typeof s === 'object' && SCENE_CMDS.includes(s.cmd))
          .map((s) => ({ deviceId: String(s.deviceId || ''), cmd: String(s.cmd), args: s.args || {} }))
      : [];
    return {
      id,
      name: String(raw.name || '未命名场景').slice(0, 60),
      createdAt: raw.createdAt || new Date().toISOString(),
      steps
    };
  }

  function loadData() {
    for (const file of [DATA_FILE, BACKUP_FILE]) {
      if (!fs.existsSync(file)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const devices = Array.isArray(parsed.devices)
          ? parsed.devices.map(normalizeDevice).filter(Boolean)
          : [];
        const scenes = Array.isArray(parsed.scenes)
          ? parsed.scenes.map(normalizeScene).filter(Boolean)
          : [];
        const seq = Math.max(0, Number(parsed.seq) || 0);
        // seq 不得小于任何已下发 desired 的 seq，否则旧指令会被判为“已送达”
        const maxSeq = devices.reduce((m, d) => Math.max(m, d.desired ? d.desired.seq : 0), 0);
        data = { seq: Math.max(seq, maxSeq), devices, scenes };
        log(`[ctl] 已加载 ${file}（设备=${devices.length}，场景=${scenes.length}，seq=${data.seq}）`);
        return;
      } catch (e) {
        log(`[ctl] ${file} 解析失败：${e.message}`);
      }
    }
    data = seedData();
    log('[ctl] 未找到数据文件，使用空档案初始化');
  }

  /** 原子写盘：剥离内存态字段（reported / lastSeenAt） */
  function persist() {
    const snapshot = {
      seq: data.seq,
      devices: data.devices.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        appVersion: d.appVersion,
        registeredAt: d.registeredAt,
        managed: d.managed,
        bootRestore: d.bootRestore,
        desired: d.desired,
        ackedSeq: d.ackedSeq
      })),
      scenes: data.scenes
    };
    const tmp = `${DATA_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    if (fs.existsSync(DATA_FILE)) {
      try {
        fs.copyFileSync(DATA_FILE, BACKUP_FILE);
      } catch (e) {
        log(`[ctl] 备份失败：${e.message}`);
      }
    }
    fs.renameSync(tmp, DATA_FILE);
  }

  /** 串行执行一次「读-改-写」；needPersist=false 时不写盘（纯内存心跳态更新） */
  function mutate(fn, { needPersist = true } = {}) {
    const run = () => {
      const result = fn(data);
      if (needPersist) persist();
      return result;
    };
    const p = writeChain.then(run, run);
    writeChain = p.catch(() => {});
    return p;
  }

  /* ---------- 指令校验 ---------- */

  /**
   * 校验并规范化指令参数。展示类的 rotate 在 phaseSync 时由服务端生成对齐
   * 间隔边界的 startedAt；非 phaseSync 时删除 startedAt（由设备收到时自定）。
   */
  function validateCommand(cmd, args) {
    if (!ALL_CMDS.includes(cmd)) throw bad(`未知指令「${cmd}」，可用：${ALL_CMDS.join(' / ')}`);
    args = args && typeof args === 'object' ? { ...args } : {};

    if (cmd === 'show') {
      const entryId = String(args.entryId || '').trim();
      if (!entryId) throw bad('show 需要 entryId');
      if (!entryExists(entryId)) throw bad(`入口「${entryId}」不存在`);
      return { cmd, args: { entryId } };
    }

    if (cmd === 'rotate') {
      const intervalSec = Math.round(Number(args.intervalSec));
      if (!Number.isFinite(intervalSec) || intervalSec < 1 || intervalSec > 3600) {
        throw bad('轮询间隔需在 1–3600 秒之间');
      }
      const items = Array.isArray(args.items) ? args.items.map(String).filter(Boolean) : [];
      if (!items.length) throw bad('轮询序列 items 不能为空');
      for (const id of items) {
        if (!entryExists(id)) throw bad(`轮询引用的入口「${id}」不存在`);
      }
      const norm = { intervalSec, items: [...new Set(items)], phaseSync: args.phaseSync === true };
      // 同相切换：所有目标设备共用同一时钟起点（取整到间隔边界），翻页时机一致
      if (norm.phaseSync) {
        const now = Date.now();
        norm.startedAt = Math.floor(now / (intervalSec * 1000)) * intervalSec * 1000;
      }
      return { cmd, args: norm };
    }

    if (cmd === 'zone') {
      const slots = Array.isArray(args.slots) ? args.slots : null;
      if (!slots || slots.length !== 4) throw bad('zone.slots 必须恰好 4 个元素（2×2）');
      const norm = slots.map((s) => {
        if (s === null || s === undefined || s === '') return null;
        const id = String(s);
        if (!entryExists(id)) throw bad(`分区引用的入口「${id}」不存在`);
        return id;
      });
      return { cmd, args: { slots: norm } };
    }

    // home / refresh / sync：无参数
    return { cmd, args: {} };
  }

  function entryExists(id) {
    return getEntries().some((e) => e.id === id);
  }

  /* ---------- 心跳 ---------- */

  /** 连接来源 IP 归一化：去掉 IPv4-mapped 的 ::ffff: 前缀 */
  function normalizeIp(remoteAddr) {
    const raw = String(remoteAddr || '');
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  }

  async function handleBeat(body, remoteAddr) {
    const deviceId = String(body.deviceId || '').trim();
    if (!DEVICE_ID_PATTERN.test(deviceId)) {
      throw bad('deviceId 格式应为小写字母/数字/短横线（≤64 字符）');
    }
    const kind = ALLOWED_KINDS.includes(body.kind) ? body.kind : 'pc';
    const state = body.state && typeof body.state === 'object' ? body.state : { mode: 'home' };
    const ackedSeq = Number.isFinite(Number(body.ackedSeq)) ? Number(body.ackedSeq) : 0;
    const boot = body.boot === true;
    const switchTo = body.switchTo === 'local' || body.switchTo === 'remote' ? body.switchTo : null;

    // 落盘判定（设计 §5.2）：心跳态（reported/lastSeenAt/ackedSeq）仅内存；
    // 注册、模式翻转、desired 清除才写盘。dirty 在 mutate 回调内同步置位。
    let dirty = false;
    const result = await mutate((d) => {
      let dev = d.devices.find((x) => x.id === deviceId);
      if (!dev) {
        if (d.devices.length >= MAX_DEVICES) throw bad('设备档案已满，无法注册新设备');
        dev = normalizeDevice({
          id: deviceId,
          name: String(body.name || '').trim().slice(0, 60) || `新设备-${deviceId.slice(-4)}`,
          kind,
          appVersion: body.appVersion
        });
        d.devices.push(dev);
        dirty = true;
        log(`[ctl] 设备注册：${dev.id}（${kind}）「${dev.name}」`);
      }
      // 身份字段每次心跳刷新（appVersion 可随升级变化；name 不覆盖，以档案为准）
      dev.kind = kind;
      dev.appVersion = String(body.appVersion || '').slice(0, 20);
      // 连接来源 IP（仅内存，随 DHCP 变化属正常；控制台展示用）
      dev.remoteIp = normalizeIp(remoteAddr);
      dev.reported = state;
      dev.lastSeenAt = Date.now();

      // 设备端脱离/交还意图（v6：受控端本地操作偏离指令画面时自动发送）。
      // 幂等；响应回带 managed 供设备确认。
      // 指令优先规则（设计 §8.3）：有未确认的展示指令在途时忽略交还意图——
      // 设备先应用指令（本拍响应即下发），避免“指令刚下、现场恰好本地操作”竞态丢失指令。
      if (switchTo === 'local') {
        const hasUnacked = dev.desired && dev.desired.seq > dev.ackedSeq;
        if (!hasUnacked) {
          if (dev.managed || dev.desired) log(`[ctl] ${dev.id} 现场交还本地控制`);
          dev.managed = false;
          dev.desired = null;
          dirty = true;
        }
      } else if (switchTo === 'remote') {
        dev.managed = true;
        dirty = true;
      }

      // ack 推进：维护类指令 ack 后即清除（无需 boot 恢复），清除需落盘；
      // 展示类 desired 保留（boot 恢复重发用）。ackedSeq 本身不落盘——
      // 服务端重启后最坏重发一次指令，设备端应用幂等，无副作用。
      if (dev.desired && ackedSeq >= dev.desired.seq && MAINTAIN_CMDS.includes(dev.desired.cmd)) {
        dev.desired = null;
        dirty = true;
      }
      dev.ackedSeq = Math.max(dev.ackedSeq, Math.min(ackedSeq, d.seq));

      // desired 下发规则（设计 §7.1）
      let desired = null;
      if (dev.desired && dev.desired.seq > dev.ackedSeq) {
        desired = { seq: dev.desired.seq, cmd: dev.desired.cmd, args: dev.desired.args };
      } else if (boot && dev.managed && dev.bootRestore && dev.desired) {
        desired = { seq: dev.desired.seq, cmd: dev.desired.cmd, args: dev.desired.args };
      }
      // content：内容版本随心跳下发——客户端发现落后即立即强制同步
      //（Web 管理后台保存后 ≤3 秒全场生效，设计 §五 同步策略修订）
      return {
        ok: true,
        name: dev.name,
        managed: dev.managed,
        serverTime: Date.now(),
        desired,
        content: getContentVersion ? getContentVersion() : null
      };
    }, { needPersist: false });

    if (dirty) await mutate(() => undefined, { needPersist: true });
    return result;
  }

  /* ---------- 下发 / 取消控制 ---------- */

  function resolveTargets(targetIds) {
    if (!Array.isArray(targetIds) || !targetIds.length) throw bad('targets 不能为空');
    if (targetIds.includes('*')) return data.devices.slice();
    const found = [];
    for (const t of targetIds.map(String)) {
      const dev = data.devices.find((x) => x.id === t);
      if (!dev) throw bad(`设备「${t}」不存在或尚未注册`);
      found.push(dev);
    }
    return found;
  }

  async function handleSend(body) {
    const { cmd, args } = validateCommand(String(body.cmd || ''), body.args);
    const targets = resolveTargets(body.targets);
    const isDisplay = DISPLAY_CMDS.includes(cmd);
    return mutate((d) => {
      d.seq += 1; // 同一批指令共享同一 seq
      const issuedAt = new Date().toISOString();
      const results = [];
      for (const dev of targets) {
        const record = d.devices.find((x) => x.id === dev.id);
        if (!record) continue;
        if (isDisplay) record.managed = true; // 展示类指令 = 强制接管（设计 §8）
        record.desired = { seq: d.seq, cmd, args, issuedAt };
        results.push({ id: record.id, ok: true, seq: d.seq });
      }
      log(`[ctl] 下发 ${cmd} → ${results.map((r) => r.id).join(', ')}（seq=${d.seq}）`);
      return { ok: true, seq: d.seq, results };
    });
  }

  async function handleRelease(body) {
    const targets = resolveTargets(body.targets);
    return mutate((d) => {
      const results = [];
      for (const dev of targets) {
        const record = d.devices.find((x) => x.id === dev.id);
        if (!record) continue;
        record.managed = false;
        record.desired = null;
        results.push({ id: record.id, ok: true });
      }
      log(`[ctl] 取消控制 → ${results.map((r) => r.id).join(', ')}`);
      return { ok: true, results };
    });
  }

  /* ---------- 设备列表 / 档案管理 ---------- */

  function onlineOf(lastSeenAt) {
    if (!lastSeenAt) return 'offline';
    const age = (Date.now() - lastSeenAt) / 1000;
    if (age < ONLINE_SEC) return 'online';
    if (age < RECENT_SEC) return 'recent';
    return 'offline';
  }

  function devicesPayload() {
    return {
      seq: data.seq,
      devices: data.devices.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          appVersion: d.appVersion,
          managed: d.managed,
          bootRestore: d.bootRestore,
          desired: d.desired,
          ackedSeq: d.ackedSeq,
          pending: !!(d.desired && d.desired.seq > d.ackedSeq),
          online: onlineOf(d.lastSeenAt),
          lastSeenAt: d.lastSeenAt || null,
          ip: d.remoteIp || null,
          reported: d.reported
        })),
      // 场景随列表一并下发（控制屏一次轮询拿全，避免第二个接口）
      scenes: data.scenes
    };
  }

  async function handleDeviceUpdate(id, body) {
    return mutate((d) => {
      const dev = d.devices.find((x) => x.id === id);
      if (!dev) throw new HttpError(404, `设备「${id}」不存在`);
      if (body.name !== undefined) {
        const name = String(body.name || '').trim().slice(0, 60);
        if (!name) throw bad('设备名不能为空');
        dev.name = name;
      }
      if (body.bootRestore !== undefined) dev.bootRestore = body.bootRestore === true;
      return { ok: true, device: { id: dev.id, name: dev.name, bootRestore: dev.bootRestore } };
    });
  }

  async function handleDeviceDelete(id) {
    return mutate((d) => {
      const idx = d.devices.findIndex((x) => x.id === id);
      if (idx < 0) throw new HttpError(404, `设备「${id}」不存在`);
      d.devices.splice(idx, 1);
      return { ok: true, deleted: id };
    });
  }

  /* ---------- 场景 ---------- */

  /** 把设备当前状态转为等价恢复指令（“存为场景”时对本地控制设备使用，设计 §9.2） */
  function stepFromReported(dev) {
    const r = dev.reported;
    if (!r || typeof r !== 'object') return null;
    try {
      switch (String(r.mode || '')) {
        case 'page':
        case 'camera': {
          const entryId = String(r.entryId || '');
          return entryExists(entryId) ? { deviceId: dev.id, cmd: 'show', args: { entryId } } : null;
        }
        case 'rotate': {
          const rot = r.rotate || {};
          const items = Array.isArray(rot.items) ? rot.items.map(String).filter((x) => entryExists(x)) : [];
          const intervalSec = Math.round(Number(rot.intervalSec));
          if (!items.length || !Number.isFinite(intervalSec)) return null;
          return {
            deviceId: dev.id,
            cmd: 'rotate',
            args: { intervalSec: Math.min(3600, Math.max(1, intervalSec)), items, phaseSync: false }
          };
        }
        case 'zone': {
          const slots = Array.isArray(r.zone && r.zone.slots) ? r.zone.slots : null;
          if (!slots || slots.length !== 4) return null;
          const norm = slots.map((s) => (s && entryExists(String(s)) ? String(s) : null));
          return { deviceId: dev.id, cmd: 'zone', args: { slots: norm } };
        }
        case 'home':
          return { deviceId: dev.id, cmd: 'home', args: {} };
        default:
          return null; // control / 未知模式不生成 step
      }
    } catch (e) {
      return null;
    }
  }

  async function handleSceneCreate(body) {
    const name = String(body.name || '').trim().slice(0, 60);
    if (!name) throw bad('场景名不能为空');
    if (data.scenes.length >= MAX_SCENES) throw bad('场景数量已达上限');

    let steps = null;
    let skippedInfo = null;
    if (Array.isArray(body.steps)) {
      // 显式 steps：逐条校验（entryId 存在性 + 指令白名单）
      if (!body.steps.length) throw bad('场景 steps 不能为空');
      steps = body.steps.map((s) => {
        const { cmd, args } = validateCommand(String(s.cmd || ''), s.args);
        if (!SCENE_CMDS.includes(cmd)) throw bad(`场景不允许维护类指令「${cmd}」`);
        return { deviceId: String(s.deviceId || ''), cmd, args };
      });
      for (const s of steps) {
        if (!DEVICE_ID_PATTERN.test(s.deviceId)) throw bad(`场景引用的设备「${s.deviceId}」不合法`);
        if (!data.devices.some((x) => x.id === s.deviceId)) throw bad(`场景引用的设备「${s.deviceId}」不存在`);
      }
    } else {
      // 快照当前现场（设计 §9.2）：受控设备取 desired，本地设备把 reported 转等价指令
      const skipped = [];
      steps = [];
      for (const dev of data.devices) {
        if (onlineOf(dev.lastSeenAt) === 'offline') {
          skipped.push({ id: dev.id, reason: 'offline' });
          continue;
        }
        let step = null;
        if (dev.managed && dev.desired && DISPLAY_CMDS.includes(dev.desired.cmd)) {
          step = { deviceId: dev.id, cmd: dev.desired.cmd, args: dev.desired.args };
        } else {
          step = stepFromReported(dev);
        }
        if (step) steps.push(step);
        else skipped.push({ id: dev.id, reason: 'no-report' });
      }
      if (!steps.length) throw bad('当前没有可入场景的设备状态（全部离线或无可转换状态）');
      skippedInfo = skipped;
    }

    const scene = normalizeScene(
      { id: `scene-${crypto.randomBytes(3).toString('hex')}`, name, steps },
      data.scenes.length
    );
    return mutate((d) => {
      d.scenes.push(scene);
      log(`[ctl] 场景保存：「${name}」（${scene.steps.length} 步）`);
      const res = { ok: true, scene };
      if (skippedInfo) res.skipped = skippedInfo;
      return res;
    });
  }

  async function handleSceneApply(id) {
    const scene = data.scenes.find((s) => s.id === id);
    if (!scene) throw new HttpError(404, `场景「${id}」不存在`);
    return mutate((d) => {
      const results = [];
      for (const step of scene.steps) {
        const dev = d.devices.find((x) => x.id === step.deviceId);
        if (!dev) {
          results.push({ id: step.deviceId, ok: false, reason: 'device-gone' });
          continue;
        }
        d.seq += 1; // 场景应用逐台自增 seq（设计 §9.2）
        dev.managed = true;
        dev.desired = { seq: d.seq, cmd: step.cmd, args: step.args, issuedAt: new Date().toISOString() };
        results.push({ id: dev.id, ok: true, seq: d.seq });
      }
      const applied = results.filter((r) => r.ok).length;
      log(`[ctl] 场景应用：「${scene.name}」已下发 ${applied}/${results.length}`);
      return { ok: true, applied, total: results.length, results };
    });
  }

  async function handleSceneUpdate(id, body) {
    return mutate((d) => {
      const scene = d.scenes.find((s) => s.id === id);
      if (!scene) throw new HttpError(404, `场景「${id}」不存在`);
      if (body.name !== undefined) {
        const name = String(body.name || '').trim().slice(0, 60);
        if (!name) throw bad('场景名不能为空');
        scene.name = name;
      }
      return { ok: true, scene };
    });
  }

  async function handleSceneDelete(id) {
    return mutate((d) => {
      const idx = d.scenes.findIndex((s) => s.id === id);
      if (idx < 0) throw new HttpError(404, `场景「${id}」不存在`);
      d.scenes.splice(idx, 1);
      return { ok: true, deleted: id };
    });
  }

  /* ---------- HTTP 工具与路由 ---------- */

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

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new HttpError(413, '请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(bad('请求体不是合法 JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  function isCtlPath(pathname) {
    return pathname === '/api/ctl' || pathname.startsWith('/api/ctl/');
  }

  /**
   * 路由入口：模块内自行消化 HttpError（与 proxy/camera 惯例一致，
   * 不向 server.js 抛异常——那边只识别自己定义的 HttpError 类）。
   */
  async function handle(req, res, url) {
    try {
      await route(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log(`[ctl] ${req.method} ${url.pathname} ${err.message}`);
      if (res.headersSent) return res.end();
      sendJson(res, status, { error: err.message || '服务端内部错误' }, CORS);
    }
  }

  async function route(req, res, url) {
    const p = url.pathname.replace(/\/+$/, '') || '/api/ctl';
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204, { ...CORS });
      res.end();
      return;
    }

    if (p === '/api/ctl/beat' && method === 'POST') {
      const body = await readBody(req);
      sendJson(res, 200, await handleBeat(body, req.socket.remoteAddress), CORS);
      return;
    }

    if (p === '/api/ctl/send' && method === 'POST') {
      sendJson(res, 200, await handleSend(await readBody(req)), CORS);
      return;
    }

    if (p === '/api/ctl/release' && method === 'POST') {
      sendJson(res, 200, await handleRelease(await readBody(req)), CORS);
      return;
    }

    if (p === '/api/ctl/devices' && method === 'GET') {
      sendJson(res, 200, devicesPayload(), CORS);
      return;
    }

    if (p === '/api/ctl/scenes' && method === 'POST') {
      sendJson(res, 201, await handleSceneCreate(await readBody(req)), CORS);
      return;
    }

    const applyMatch = p.match(/^\/api\/ctl\/scenes\/([^/]+)\/apply$/);
    if (applyMatch && method === 'POST') {
      sendJson(res, 200, await handleSceneApply(decodeURIComponent(applyMatch[1])), CORS);
      return;
    }

    const sceneMatch = p.match(/^\/api\/ctl\/scenes\/([^/]+)$/);
    if (sceneMatch) {
      const id = decodeURIComponent(sceneMatch[1]);
      if (method === 'PUT') {
        sendJson(res, 200, await handleSceneUpdate(id, await readBody(req)), CORS);
        return;
      }
      if (method === 'DELETE') {
        sendJson(res, 200, await handleSceneDelete(id), CORS);
        return;
      }
    }

    const deviceMatch = p.match(/^\/api\/ctl\/device\/([^/]+)$/);
    if (deviceMatch) {
      const id = decodeURIComponent(deviceMatch[1]);
      if (method === 'PUT') {
        sendJson(res, 200, await handleDeviceUpdate(id, await readBody(req)), CORS);
        return;
      }
      if (method === 'DELETE') {
        sendJson(res, 200, await handleDeviceDelete(id), CORS);
        return;
      }
    }

    throw new HttpError(404, `未找到控制接口 ${method} ${p}`);
  }

  function status() {
    return {
      devices: data.devices.length,
      online: data.devices.filter((d) => onlineOf(d.lastSeenAt) === 'online').length,
      managed: data.devices.filter((d) => d.managed).length,
      scenes: data.scenes.length,
      seq: data.seq
    };
  }

  // 初始化
  fs.mkdirSync(dataDir, { recursive: true });
  loadData();
  if (!fs.existsSync(DATA_FILE)) persist();

  return { isCtlPath, handle, status };
}

module.exports = { createCtl };
