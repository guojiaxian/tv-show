#!/usr/bin/env node
/**
 * 生成管理后台与远程控制台：server/admin/index.html、server/console.html
 *
 * 两页与电脑端客户端一样以「模板 + 构建期片段」维护，仍输出单文件：
 *   tools/admin-template.html    管理后台模板
 *   tools/console-template.html  远程控制台模板
 *   tools/fragments/api.js       两页共用的 JSON 请求助手（注入到 __API_JS__）
 *
 * 用法：node tools/build-pages.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { read, renderTemplate } from './build-common.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 片段按 IIFE 内层级缩进两格后注入（模板里的占位符单独占一行）
const apiJs = read(resolve(ROOT, 'tools/fragments/api.js'))
  .trimEnd()
  .split('\n')
  .map((line) => (line ? '  ' + line : line))
  .join('\n');

const PAGES = [
  {
    label: '管理后台',
    template: resolve(ROOT, 'tools/admin-template.html'),
    output: resolve(ROOT, 'server/admin/index.html')
  },
  {
    label: '远程控制台',
    template: resolve(ROOT, 'tools/console-template.html'),
    output: resolve(ROOT, 'server/console.html')
  }
];

const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1) + ' KB';

for (const page of PAGES) {
  const html = renderTemplate(page.template, { __API_JS__: apiJs }, page.label);
  mkdirSync(dirname(page.output), { recursive: true });
  writeFileSync(page.output, html, 'utf8');
  console.log(`已生成${page.label}：${page.output}（${kb(html)}）`);
}
