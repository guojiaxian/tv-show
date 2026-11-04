/**
 * 服务端验证脚本统一入口：在**隔离实例**上依次运行三个测试。
 *
 * 为什么要隔离：test-api / test-admin / test-sync 会通过管理接口改标题、
 * 增删页面、bump epoch、留下 tombstone，这些改动**不可逆**。
 * 如果直接打到正在使用的服务端（默认 18000），就会把真实数据冲掉
 * （曾因此把管理后台改好的系统标题复原成默认值）。
 *
 * 因此这里另起一个服务端进程：独立端口 + 独立临时数据目录，跑完即删。
 *
 *   node server/test-run.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SUITES = ['test-api.mjs', 'test-admin.mjs', 'test-sync.mjs', 'test-proxy.mjs', 'test-camera.mjs', 'test-shot.mjs', 'test-ctl.mjs', 'test-ctl-ui.mjs'];

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const waitHealthy = async (base, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/admin/health`);
      if (res.ok) return;
    } catch {
      // 服务端还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`隔离实例在 ${timeoutMs / 1000} 秒内未就绪`);
};

const runSuite = (file, base) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(DIR, file)], {
    stdio: 'inherit',
    // 同时下发数据目录，供需要直接读盘核对的断言使用
    env: { ...process.env, BASE: base, TVSHOW_DATA_DIR: dataDir }
  });
  child.on('exit', (code) => resolve(code ?? 1));
});

const port = await freePort();
const dataDir = mkdtempSync(path.join(tmpdir(), 'tvshow-test-'));
const base = `http://127.0.0.1:${port}`;

const server = spawn(
  process.execPath,
  [path.join(DIR, 'server.js'), '--port', String(port), '--host', '127.0.0.1'],
  { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, TVSHOW_DATA_DIR: dataDir } }
);

let failed = 0;
try {
  await waitHealthy(base);
  console.log(`隔离实例就绪：${base}`);
  console.log(`临时数据目录：${dataDir}（跑完自动删除，不影响正在使用的服务端）`);

  for (const suite of SUITES) {
    console.log(`\n──────── ${suite} ────────`);
    if ((await runSuite(suite, base)) !== 0) failed++;
  }
} finally {
  server.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '全部验证脚本通过' : `${failed} 个验证脚本未通过`}`);
process.exit(failed === 0 ? 0 : 1);
