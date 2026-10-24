#!/usr/bin/env node
/**
 * 控制通道（/api/ctl/*）端到端验证：直接打真实 HTTP 接口（隔离实例上运行）。
 * 覆盖：注册/心跳、desired 下发与 ack 闭环、boot 恢复、模式开关（switchTo）、
 *       release、存储转发、targets=["*"]、校验 400、seq 仲裁、设备档案管理、
 *       场景保存/应用/管理、health、/console 别名。
 */
const BASE = process.env.BASE;
if (!BASE) {
  console.error('本脚本会改写控制通道数据，必须跑在隔离实例上：node server/test-run.mjs');
  process.exit(1);
}
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.TVSHOW_DATA_DIR;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log('      ' + JSON.stringify(detail));
};

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}
const beat = (deviceId, extra = {}) => api('POST', '/api/ctl/beat', { deviceId, kind: 'pc', appVersion: 'test', ...extra });

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- 1. 注册与心跳 ---------- */
  let r = await beat('dev-aaaa1111', { name: '', state: { mode: 'home' } });
  check('首次心跳注册成功（ok=true）', r.status === 200 && r.json && r.json.ok === true, r);
  check('心跳响应携带内容版本 content（即时同步依据）',
    r.json.content && Number.isFinite(r.json.content.version) && Number.isFinite(r.json.content.epoch), r.json.content);

  r = await api('GET', '/api/ctl/devices');
  const dev1 = r.json && r.json.devices && r.json.devices.find((d) => d.id === 'dev-aaaa1111');
  check('设备档案记录连接来源 IP（127.0.0.1）', !!dev1 && dev1.ip === '127.0.0.1', dev1 && dev1.ip);
  check('注册后出现在设备列表，默认名「新设备-xxxx」', !!dev1 && /^新设备-/.test(dev1.name), dev1);
  check('注册默认 managed=false（初次进入即本地控制）', !!dev1 && dev1.managed === false, dev1);
  check('pc 设备 bootRestore 默认开', !!dev1 && dev1.bootRestore === true, dev1);
  check('无 desired 时响应 desired=null（无操作不重发）', (await beat('dev-aaaa1111')).json.desired === null);

  r = await beat('dev-bbbb2222', { kind: 'tablet' });
  r = await api('GET', '/api/ctl/devices');
  const tab = r.json.devices.find((d) => d.id === 'dev-bbbb2222');
  check('tablet 设备 bootRestore 默认关', tab && tab.bootRestore === false, tab);

  r = await beat('dev-cccc3333', { kind: 'tv' });
  check('tv 设备注册成功', r.status === 200 && r.json.ok === true);

  r = await beat('dev-aaaa1111');
  r = await api('GET', '/api/ctl/devices');
  check('重复心跳幂等（不新增设备）', r.json.devices.length === 3, r.json.devices.length);

  r = await api('GET', '/api/ctl/devices');
  check('在线判定 online（刚心跳过）', r.json.devices.every((d) => d.online === 'online'), r.json.devices.map((d) => d.online));

  /* ---------- 2. 下发 → 领取 → ack 闭环 ---------- */
  r = await api('POST', '/api/ctl/send', { targets: ['dev-aaaa1111'], cmd: 'show', args: { entryId: 'storage-monitor' } });
  check('send show 受理（返回 seq）', r.status === 200 && r.json.ok && r.json.seq > 0, r);
  const seq1 = r.json.seq;

  r = await beat('dev-aaaa1111');
  check('设备心跳领到指令（seq/cmd/args 完整）',
    r.json.desired && r.json.desired.seq === seq1 && r.json.desired.cmd === 'show' &&
    r.json.desired.args.entryId === 'storage-monitor', r.json.desired);
  check('展示类指令自动 managed=true（强制接管）', r.json.managed === true, r.json.managed);

  // ack 后不再下发（desired 保留供 boot 恢复，但 seq 不再大于 ackedSeq）
  r = await beat('dev-aaaa1111', { ackedSeq: seq1 });
  check('ack 后不再重复下发', r.json.desired === null, r.json.desired);

  // 列表 pending 标记
  r = await api('POST', '/api/ctl/send', { targets: ['dev-cccc3333'], cmd: 'home' });
  const seq2 = r.json.seq;
  r = await api('GET', '/api/ctl/devices');
  check('待送达标记 pending=true（未 ack）',
    r.json.devices.find((d) => d.id === 'dev-cccc3333').pending === true);
  await beat('dev-cccc3333', { ackedSeq: seq2 });
  r = await api('GET', '/api/ctl/devices');
  check('ack 后 pending=false',
    r.json.devices.find((d) => d.id === 'dev-cccc3333').pending === false);

  /* ---------- 3. boot 恢复 ---------- */
  r = await beat('dev-aaaa1111', { boot: true, ackedSeq: seq1 });
  check('受控 + bootRestore 开 → boot 无条件重发', r.json.desired && r.json.desired.seq === seq1, r.json.desired);

  // 本地控制态 boot 不重发
  r = await api('POST', '/api/ctl/release', { targets: ['dev-aaaa1111'] });
  check('release 受理', r.status === 200 && r.json.ok === true);
  r = await beat('dev-aaaa1111', { boot: true, ackedSeq: 0 });
  check('本地控制态 boot 不重发（managed=false）', r.json.desired === null, r.json);
  check('release 后 managed=false', r.json.managed === false);

  // bootRestore 关的受控设备 boot 不重发
  await api('POST', '/api/ctl/send', { targets: ['dev-bbbb2222'], cmd: 'home' });
  r = await api('GET', '/api/ctl/devices');
  const tabSeq = r.json.devices.find((d) => d.id === 'dev-bbbb2222').desired.seq;
  await beat('dev-bbbb2222', { ackedSeq: tabSeq });
  r = await beat('dev-bbbb2222', { boot: true, ackedSeq: tabSeq });
  check('bootRestore 关的受控设备 boot 不重发', r.json.desired === null, r.json);

  /* ---------- 4. 模式开关 switchTo ---------- */
  await api('POST', '/api/ctl/send', { targets: ['dev-aaaa1111'], cmd: 'home' });
  r = await beat('dev-aaaa1111');
  const homeSeq = r.json.desired.seq;
  await beat('dev-aaaa1111', { ackedSeq: homeSeq });
  r = await beat('dev-aaaa1111', { switchTo: 'local' });
  check('switchTo=local → managed=false', r.json.managed === false, r.json);
  r = await api('GET', '/api/ctl/devices');
  check('switchTo=local → desired 清空',
    r.json.devices.find((d) => d.id === 'dev-aaaa1111').desired === null);

  r = await beat('dev-aaaa1111', { switchTo: 'local' });
  check('switchTo 重复发送幂等（managed 仍 false）', r.json.managed === false);

  r = await beat('dev-aaaa1111', { switchTo: 'remote' });
  check('switchTo=remote → managed=true（设备可主动请求受控）', r.json.managed === true);

  // 展示类指令覆盖：send 后 managed 回 true
  await api('POST', '/api/ctl/release', { targets: ['dev-aaaa1111'] });
  await api('POST', '/api/ctl/send', { targets: ['dev-aaaa1111'], cmd: 'home' });
  r = await beat('dev-aaaa1111');
  check('本地态再收展示指令 → 自动切回受控', r.json.managed === true);

  /* ---------- 5. 维护类指令与 desired 清除 ---------- */
  r = await api('POST', '/api/ctl/send', { targets: ['dev-aaaa1111'], cmd: 'refresh' });
  const refSeq = r.json.seq;
  r = await api('GET', '/api/ctl/devices');
  check('维护类指令不改 managed', r.json.devices.find((d) => d.id === 'dev-aaaa1111').managed === true);
  r = await beat('dev-aaaa1111', { ackedSeq: refSeq });
  check('维护类指令可送达', true);
  r = await api('GET', '/api/ctl/devices');
  check('维护类 ack 后 desired 自动清除（无需 boot 恢复）',
    r.json.devices.find((d) => d.id === 'dev-aaaa1111').desired === null);

  /* ---------- 6. rotate / zone 校验与 phaseSync ---------- */
  r = await api('POST', '/api/ctl/send', {
    targets: ['dev-aaaa1111'], cmd: 'rotate',
    args: { intervalSec: 15, items: ['storage-monitor', 'env-monitor'], phaseSync: true }
  });
  const rotSeq = r.json.seq;
  r = await beat('dev-aaaa1111');
  check('rotate phaseSync=true → 服务端生成对齐边界的 startedAt',
    r.json.desired && r.json.desired.cmd === 'rotate' &&
    Number.isFinite(r.json.desired.args.startedAt) &&
    r.json.desired.args.startedAt % (15 * 1000) === 0, r.json.desired && r.json.desired.args);

  r = await api('POST', '/api/ctl/send', {
    targets: ['dev-cccc3333'], cmd: 'rotate',
    args: { intervalSec: 15, items: ['storage-monitor'], phaseSync: false }
  });
  r = await beat('dev-cccc3333');
  check('rotate phaseSync=false（默认）→ 无 startedAt（设备自定）',
    r.json.desired && r.json.desired.args.startedAt === undefined, r.json.desired && r.json.desired.args);

  r = await api('POST', '/api/ctl/send', {
    targets: ['dev-aaaa1111'], cmd: 'zone',
    args: { slots: ['storage-monitor', null, 'env-monitor', 'security-cockpit'] }
  });
  r = await beat('dev-aaaa1111');
  check('zone 下发 slots 保留 null 与 id',
    r.json.desired && JSON.stringify(r.json.desired.args.slots) ===
    JSON.stringify(['storage-monitor', null, 'env-monitor', 'security-cockpit']), r.json.desired && r.json.desired.args);

  /* ---------- 7. 校验 400 ---------- */
  const bads = [
    [{ targets: ['dev-aaaa1111'], cmd: 'hack', args: {} }, '未知 cmd'],
    [{ targets: ['dev-aaaa1111'], cmd: 'show', args: { entryId: 'no-such' } }, 'show 引用不存在入口'],
    [{ targets: ['dev-aaaa1111'], cmd: 'show', args: {} }, 'show 缺 entryId'],
    [{ targets: ['dev-aaaa1111'], cmd: 'rotate', args: { intervalSec: 15, items: [] } }, 'rotate 空 items'],
    [{ targets: ['dev-aaaa1111'], cmd: 'rotate', args: { intervalSec: 0, items: ['storage-monitor'] } }, 'rotate 间隔越界'],
    [{ targets: ['dev-aaaa1111'], cmd: 'rotate', args: { intervalSec: 15, items: ['no-such'] } }, 'rotate 引用不存在入口'],
    [{ targets: ['dev-aaaa1111'], cmd: 'zone', args: { slots: [null, null, null] } }, 'zone slots 数量错误'],
    [{ targets: [], cmd: 'home' }, '空 targets'],
    [{ targets: ['dev-zzzz9999'], cmd: 'home' }, 'target 不存在']
  ];
  for (const [body, name] of bads) {
    r = await api('POST', '/api/ctl/send', body);
    check(`校验 400：${name}`, r.status === 400, { status: r.status });
  }
  r = await beat('DEV-UPPER');
  check('校验 400：deviceId 大写不合法', r.status === 400, r.status);

  /* ---------- 8. seq 仲裁（最后写入者胜）与 ["*"] ---------- */
  r = await api('POST', '/api/ctl/send', { targets: ['*'], cmd: 'home' });
  check('targets=["*"] 命中全部设备', r.json.results.length === 3, r.json.results);
  const starSeq = r.json.seq;
  r = await api('GET', '/api/ctl/devices');
  check('群发后全部设备 desired.seq 相同且 managed=true',
    r.json.devices.every((d) => d.desired && d.desired.seq === starSeq && d.managed === true));

  r = await api('POST', '/api/ctl/send', { targets: ['dev-bbbb2222'], cmd: 'home' });
  check('seq 全局单调递增', r.json.seq > starSeq, { before: starSeq, after: r.json.seq });

  /* ---------- 9. 存储转发（离线设备） ---------- */
  // dev-cccc3333 此刻"离线"（不再心跳）：下发后档案已更新
  const beforeDevices = (await api('GET', '/api/ctl/devices')).json;
  await api('POST', '/api/ctl/send', { targets: ['dev-cccc3333'], cmd: 'show', args: { entryId: 'env-monitor' } });
  const afterDevices = (await api('GET', '/api/ctl/devices')).json;
  check('离线设备下发 → 档案已更新（存储转发）',
    afterDevices.devices.find((d) => d.id === 'dev-cccc3333').desired.cmd === 'show');
  check('离线设备下发 → lastSeen 未变化（没有伪造心跳）',
    beforeDevices.devices.find((d) => d.id === 'dev-cccc3333').lastSeenAt ===
    afterDevices.devices.find((d) => d.id === 'dev-cccc3333').lastSeenAt);
  // 恢复后第一拍领取
  r = await beat('dev-cccc3333');
  check('离线设备恢复后第一拍即领取', r.json.desired && r.json.desired.cmd === 'show', r.json.desired);

  /* ---------- 10. 设备档案管理 ---------- */
  r = await api('PUT', '/api/ctl/device/dev-aaaa1111', { name: '一号电脑' });
  check('改名生效', r.status === 200 && r.json.device.name === '一号电脑', r);
  r = await beat('dev-aaaa1111');
  check('心跳响应回显新名字', r.json.name === '一号电脑', r.json);
  r = await api('PUT', '/api/ctl/device/dev-aaaa1111', { bootRestore: false });
  check('bootRestore 可逐台关闭', r.json.device.bootRestore === false);
  r = await api('PUT', '/api/ctl/device/dev-none', { name: 'x' });
  check('更新不存在设备 404', r.status === 404);

  r = await api('DELETE', '/api/ctl/device/dev-bbbb2222');
  check('删除设备受理', r.status === 200);
  r = await beat('dev-bbbb2222', { kind: 'tablet' });
  r = await api('GET', '/api/ctl/devices');
  check('删除后下次心跳重新注册（重置效果）', r.json.devices.some((d) => d.id === 'dev-bbbb2222'));
  check('重新注册 bootRestore 回到 kind 默认（tablet=关）',
    r.json.devices.find((d) => d.id === 'dev-bbbb2222').bootRestore === false);

  /* ---------- 11. 场景 ---------- */
  // 快照保存：当前 dev-aaaa1111 受控（desired=zone）、dev-cccc3333 受控（desired=show）
  r = await api('POST', '/api/ctl/scenes', { name: '晨会' });
  check('快照保存场景（受控设备取 desired）',
    r.status === 201 && r.json.scene && r.json.scene.steps.length >= 2, r.json);
  const sceneId = r.json.scene.id;
  const showStep = r.json.scene.steps.find((s) => s.cmd === 'show');
  check('快照 step 保留指令与参数', !!showStep && showStep.args.entryId === 'env-monitor', showStep);

  // 显式 steps 保存 + 校验
  r = await api('POST', '/api/ctl/scenes', {
    name: '值守',
    steps: [{ deviceId: 'dev-aaaa1111', cmd: 'show', args: { entryId: 'storage-monitor' } }]
  });
  check('显式 steps 保存场景', r.status === 201 && r.json.scene.steps.length === 1);
  r = await api('POST', '/api/ctl/scenes', {
    name: '坏场景',
    steps: [{ deviceId: 'dev-aaaa1111', cmd: 'refresh' }]
  });
  check('场景校验 400：维护类指令不允许入场景', r.status === 400, r.status);

  // 应用场景：逐台 seq 自增 + 未受控设备自动接管
  await api('POST', '/api/ctl/release', { targets: ['*'] });
  r = await api('POST', `/api/ctl/scenes/${sceneId}/apply`);
  check('应用场景返回 applied 计数', r.status === 200 && r.json.applied >= 2 && r.json.total >= 2, r.json);
  const applySeqs = r.json.results.map((x) => x.seq);
  check('场景应用 seq 逐台自增（各不相同）', new Set(applySeqs).size === applySeqs.length, applySeqs);
  r = await api('GET', '/api/ctl/devices');
  check('场景应用后设备自动接管（managed=true）',
    r.json.devices.every((d) => d.managed === true));

  // 重命名 / 删除
  r = await api('PUT', `/api/ctl/scenes/${sceneId}`, { name: '晨会V2' });
  check('场景重命名', r.json.scene.name === '晨会V2');
  r = await api('DELETE', `/api/ctl/scenes/${sceneId}`);
  check('场景删除', r.status === 200);
  r = await api('POST', `/api/ctl/scenes/${sceneId}/apply`);
  check('应用已删场景 404', r.status === 404);

  /* ---------- 12. health 与 /console ---------- */
  r = await api('GET', '/api/admin/health');
  check('health 含 ctl 字段（设备/在线/场景/seq）',
    r.json.ctl && typeof r.json.ctl.devices === 'number' &&
    typeof r.json.ctl.online === 'number' && typeof r.json.ctl.scenes === 'number', r.json.ctl);

  const consolePage = await fetch(BASE + '/console');
  const consoleText = consolePage.status === 200 ? await consolePage.text() : '';
  check('/console 是独立控制台页面（远程控制且不注册受控）',
    consolePage.status === 200 && /远程控制/.test(consoleText) &&
    /api\/ctl\/send/.test(consoleText) && !/tvshow\.localSettings/.test(consoleText));

  /* ---------- 13. 落盘核对 ---------- */
  if (DATA_DIR) {
    const file = join(DATA_DIR, 'devices.json');
    check('devices.json 已落盘', existsSync(file));
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    check('落盘不含内存态字段（reported/lastSeenAt）',
      disk.devices.every((d) => d.reported === undefined && d.lastSeenAt === undefined));
    check('落盘保留 managed/desired/bootRestore',
      disk.devices.every((d) => 'managed' in d && 'bootRestore' in d));
  }

  /* ---------- 汇总 ---------- */
  const pass = results.filter((x) => x.pass).length;
  console.log('\n==============================');
  console.log(`合计：${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
