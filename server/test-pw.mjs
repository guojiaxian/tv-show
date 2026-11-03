/**
 * Playwright 加载器（浏览器端到端测试共用）。
 *
 * 解析顺序：环境变量 > 常规模块解析（CI 在 server 目录 npm ci 后可用）> 本机调试目录。
 * Chromium 可执行文件同理：环境变量 > playwright 自己报告的路径 > ms-playwright 目录扫描。
 * 任一缺失返回 null，调用方打印 SKIP 后正常退出，保证无浏览器环境也能跑完整回归。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    'playwright-core',
    '/root/.pwtest/node_modules/playwright-core'
  ];
  let pw = null;
  for (const name of candidates) {
    if (!name) continue;
    try {
      pw = require(name);
      break;
    } catch (e) {
      // 继续尝试下一个来源
    }
  }
  if (!pw || !pw.chromium) return null;

  let executablePath = process.env.PLAYWRIGHT_CHROMIUM || '';
  if (!executablePath && typeof pw.chromium.executablePath === 'function') {
    try {
      const p = pw.chromium.executablePath();
      if (p && fs.existsSync(p)) executablePath = p;
    } catch (e) {
      // 未安装浏览器时 executablePath 可能抛错，走目录扫描兜底
    }
  }
  if (!executablePath) {
    const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || '/root/.cache/ms-playwright';
    try {
      executablePath = fs.readdirSync(dir)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort()
        .map((d) => [`${dir}/${d}/chrome-linux64/chrome`, `${dir}/${d}/chrome-linux/chrome`])
        .flat()
        .find((p) => fs.existsSync(p)) || '';
    } catch (e) {
      executablePath = '';
    }
  }

  return { chromium: pw.chromium, executablePath: executablePath || null };
}

/** 浏览器启动参数：有明确可执行文件时指定它，否则交给 playwright 自己解析 */
export function launchOptions(loaded) {
  const opts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (loaded.executablePath) opts.executablePath = loaded.executablePath;
  return opts;
}
