#!/usr/bin/env node
/**
 * 生成电脑浏览器客户端页面：server/client/index.html
 *
 * 与 tools/build-preview.mjs 同源思路：预览页是「虚拟遥控器测试台」，
 * 这里是**正式交付**给电脑端使用的客户端页面，由服务端 /app 直接托管。
 *
 * 数据来自工程内真实文件，保证电脑端与电视端不会走样：
 *   app/src/main/assets/config.json      （引导配置：服务器地址 + 兜底内容）
 *   app/src/main/assets/js/auto_login.js （自动登录脚本，与电视端同一份）
 *   tools/client-template.html           （页面模板：样式 + 交互全部在这里）
 *
 * 用法：node tools/build-client.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = resolve(ROOT, 'app/src/main/assets');
const TEMPLATE = resolve(ROOT, 'tools/client-template.html');
const OUTPUT = resolve(ROOT, 'server/client/index.html');

const read = (p) => readFileSync(p, 'utf8');

/** 内联进 <script> 文本节点时，只需转义可以提前结束标签的 "</" */
const inline = (text) => text.replace(/<\/(script)/gi, '<\\/$1');

const bootstrap = read(resolve(ASSETS, 'config.json'));
const loginJs = read(resolve(ASSETS, 'js/auto_login.js'));
const template = read(TEMPLATE);

// 引导配置必须合法，且要能解析出兜底内容（否则客户端启动后无内容可渲染）
const boot = JSON.parse(bootstrap);
const fallback = boot.fallback ?? boot; // 兼容旧格式（顶层直接是配置）
if (!Array.isArray(fallback.entries) || fallback.entries.length === 0) {
  throw new Error('config.json 中没有可用的兜底入口（fallback.entries 为空）');
}
if (!boot.serverBaseUrl) {
  console.warn('警告：config.json 未配置 serverBaseUrl，以本地文件方式打开时将无内容可同步');
}

const html = template
  .replace('__BOOTSTRAP__', () => inline(bootstrap.trim()))
  .replace('__AUTO_LOGIN_JS__', () => inline(loginJs));

const leftover = html.match(/__BOOTSTRAP__|__AUTO_LOGIN_JS__/);
if (leftover) throw new Error(`模板占位符未被全部替换：${leftover[0]}`);

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, html, 'utf8');

const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB';
console.log('已生成电脑端客户端页面：' + OUTPUT);
console.log('  服务端地址（仅本地文件打开时使用）：' + (boot.serverBaseUrl || '(未配置)'));
console.log('  兜底入口数：' + fallback.entries.length +
  '（' + fallback.entries.map((e) => e.title).join('、') + '）');
console.log('  auto_login.js  ' + kb(loginJs));
console.log('  合计           ' + kb(html));
console.log('  访问地址：http://<服务器IP>:18000/          （站点首页，别名 /app）');