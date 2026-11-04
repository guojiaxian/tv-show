#!/usr/bin/env node
/**
 * 同 IP 归并验证：同一台机器上的两个浏览器（不同 localStorage deviceId）
 * 心跳来源 IP 相同，控制台只应显示一行。
 *
 * 为什么单独起实例：主测试实例监听 127.0.0.1，回环地址不参与归并
 * （自动化多开不能并成一台）。这里绑定本机一个**内网 IPv4**，让服务端
 * 看到真实的非回环来源地址。没有可用内网地址时跳过。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** 优先 10/8，其次 192.168/16，最后 172.16/12；排除回环与 docker 桥 */
function lanIp() {
  const all = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      all.push(a.address);
    }
  }
  const pick = (re) => all.find((ip) => re.test(ip) && !/^172\.1[789]\./.test(ip) && ip !== '172.17.0.1');
  return pick(/^10\./) || pick(/^192\.168\./) || pick(/^172\.(1[6-9]|2\d|3[01])\./) || '';
}

const IP = lanIp();
if (!IP) {
  console.log('SKIP 本机没有可用的内网 IPv4，跳过同 IP 归并验证');
  process.exit(0);
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, IP, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const BASE = `http://${IP}:${await freePort()}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'tvshow-merge-'));

const server = spawn(process.execPath,
  [path.join(DIR, 'server.js'), '--port', String(new URL(BASE).port), '--host', IP],
  { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TVSHOW_DATA_DIR: dataDir } });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log('      ' + JSON.stringify(detail));
};

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const beat = (deviceId, extra = {}) => api('POST', '/api/ctl/beat', {
  deviceId, kind: 'pc', appVersion: 'test-merge', ackedSeq: 0, ...extra
});
const devices = async () => (await api('GET', '/api/ctl/devices')).json.devices;

let failed = 0;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE + '/api/admin/health')).ok) break;
    } catch (e) { /* 服务端未就绪 */ }
    await new Promise((r) => setTimeout(r, 200));
    if (i === 99) throw new Error('隔离实例未就绪');
  }

  /* 同一 IP 的两条档案（模拟同一台电脑的两个浏览器） */
  await beat('dev-merge0001', { name: '客厅电脑', state: { mode: 'home' } });
  await beat('dev-merge0002', { name: '新设备-0002', state: { mode: 'home' } });

  const list1 = await devices();
  const aliasesOk = list1.length === 1 &&
    list1[0].id === 'dev-merge0001' &&
    list1[0].aliases.includes('dev-merge0002');
  check('同一 IP 的第二条档案自动并入主记录（列表只有一行）', aliasesOk,
    list1.map((d) => ({ id: d.id, name: d.name, ip: d.ip, aliases: d.aliases })));
  check('合并保留更早注册的名称（不被「新设备-xxxx」覆盖）',
    list1.length === 1 && list1[0].name === '客厅电脑', list1[0] && list1[0].name);

  /* 别名 id 继续心跳：仍是同一行 */
  const b2 = await beat('dev-merge0002', { name: '新设备-0002', state: { mode: 'home' } });
  const list2 = await devices();
  check('别名 id 的心跳不再新增设备', list2.length === 1 && b2.json.managed === false,
    { count: list2.length, resp: b2.json });

  /* 合并后的档案仍可接收指令：用旧别名 id 下发（控制台遗留行 / 页面旧 id） */
  const sent = await api('POST', '/api/ctl/send', { targets: ['dev-merge0002'], cmd: 'show', args: { entryId: 'storage-monitor' } });
  const list3 = await devices();
  check('用别名 id 也能下发指令（解析到合并后的设备）',
    sent.status === 200 && list3.length === 1 && list3[0].managed === true && !!list3[0].desired,
    { status: sent.status, sent: sent.json, dev: list3[0] });

  const b3 = await beat('dev-merge0001', { state: { mode: 'home' } });
  check('合并后的设备心跳能领到指令',
    b3.json.desired && b3.json.desired.cmd === 'show' && b3.json.desired.seq === sent.json.seq,
    b3.json);
  // 应用后回报 ack：展示类指令保留（供开机恢复），但「待送达」应结束
  await beat('dev-merge0001', { state: { mode: 'page', entryId: 'storage-monitor' }, ackedSeq: sent.json.seq });
  const list4 = await devices();
  check('ack 后设备仍是远程控制且不再待送达',
    list4.length === 1 && list4[0].managed === true && list4[0].pending === false,
    list4[0] && { managed: list4[0].managed, pending: list4[0].pending, ackedSeq: list4[0].ackedSeq });

  /* 落盘检查：重复档案已删除、别名与来源 IP 已保存（重启后不会又冒出两行） */
  const saved = JSON.parse(readFileSync(path.join(dataDir, 'devices.json'), 'utf8'));
  const rec = saved.devices.find((d) => d.id === 'dev-merge0001');
  check('devices.json 不再保留重复档案，且保存 lastIp / aliases',
    saved.devices.length === 1 && !!rec && rec.lastIp === IP && rec.aliases.includes('dev-merge0002'),
    saved.devices.map((d) => ({ id: d.id, lastIp: d.lastIp, aliases: d.aliases })));
} catch (e) {
  console.log('FAIL  ' + e.message);
  failed++;
} finally {
  server.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}

if (results.some((r) => !r.pass)) failed++;
console.log(`\n${failed === 0 ? '同 IP 归并验证通过' : '同 IP 归并验证未通过'}`);
process.exit(failed === 0 ? 0 : 1);
