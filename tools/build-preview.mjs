#!/usr/bin/env node
/**
 * 生成电脑端预览页：dist/preview.html
 *
 * 目的：在不安装 APK 的情况下，用浏览器验证客户端行为：
 *   1) 首页入口聚合界面与遥控器焦点导航
 *   2) 大屏展示页外壳（加载 / 失败重试 / 缩放 / 控制菜单 / 返回）
 *   3) 与 App 内完全相同的注入脚本（tv_nav.js + auto_login.js）
 *   4) **与 App 相同的服务端同步行为**：先渲染本地兜底内容，再按版本增量同步，
 *      服务器不可用时保留兜底内容并显示离线状态
 *
 * 数据来自工程内真实文件，保证预览页与 App 不会走样：
 *   app/src/main/assets/config.json      （引导配置：服务器地址 + 兜底内容）
 *   app/src/main/assets/js/tv_nav.js
 *   app/src/main/assets/js/auto_login.js
 *   tools/preview-template.html
 *
 * 用法：node tools/build-preview.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = resolve(ROOT, 'app/src/main/assets');
const TEMPLATE = resolve(ROOT, 'tools/preview-template.html');
const OUTPUT = resolve(ROOT, 'dist/preview.html');

const read = (p) => readFileSync(p, 'utf8');

/** 内联进 <script> 文本节点时，只需转义可以提前结束标签的 "</" */
const inline = (text) => text.replace(/<\/(script)/gi, '<\\/$1');

const bootstrap = read(resolve(ASSETS, 'config.json'));
const navJs = read(resolve(ASSETS, 'js/tv_nav.js'));
const loginJs = read(resolve(ASSETS, 'js/auto_login.js'));
const template = read(TEMPLATE);

// 引导配置必须合法，且要能解析出兜底内容（否则预览页启动后无内容可渲染）
const boot = JSON.parse(bootstrap);
const fallback = boot.fallback ?? boot; // 兼容旧格式（顶层直接是配置）
if (!Array.isArray(fallback.entries) || fallback.entries.length === 0) {
  throw new Error('config.json 中没有可用的兜底入口（fallback.entries 为空）');
}
if (!boot.serverBaseUrl) {
  console.warn('警告：config.json 未配置 serverBaseUrl，预览页将只能显示内置兜底内容');
}

const html = template
  .replace('__BOOTSTRAP__', () => inline(bootstrap.trim()))
  .replace('__TV_NAV_JS__', () => inline(navJs))
  .replace('__AUTO_LOGIN_JS__', () => inline(loginJs));

const leftover = html.match(/__BOOTSTRAP__|__TV_NAV_JS__|__AUTO_LOGIN_JS__/);
if (leftover) throw new Error(`模板占位符未被全部替换：${leftover[0]}`);

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, html, 'utf8');

const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB';
console.log('已生成预览页：' + OUTPUT);
console.log('  服务器地址：' + (boot.serverBaseUrl || '(未配置)'));
console.log('  兜底入口数：' + fallback.entries.length +
  '（' + fallback.entries.map((e) => e.title).join('、') + '）');
console.log('  tv_nav.js      ' + kb(navJs));
console.log('  auto_login.js  ' + kb(loginJs));
console.log('  合计           ' + kb(html));
