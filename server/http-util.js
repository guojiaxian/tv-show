/**
 * HTTP 基础设施：错误类型、响应写出、请求体读取、跨域头。
 * ---------------------------------------------------------------------------
 * 由 server.js 抽出的公共部分，供各路由模块复用；不持有任何业务状态。
 */
'use strict';

const fs = require('node:fs');

/** 请求体上限：超限返回 413，避免大包拖垮服务端内存 */
const MAX_BODY_BYTES = 256 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

/** 取必填字符串字段：自动 trim、限长、可拒绝空串 */
function requireString(v, name, { max = 500, allowEmpty = false } = {}) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s && !allowEmpty) throw bad(`${name} 不能为空`);
  if (s.length > max) throw bad(`${name} 长度不能超过 ${max}`);
  return s;
}

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

function sendEmpty(res, status, extraHeaders = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...extraHeaders });
  res.end();
}

/**
 * 托管一个静态 HTML 页面（客户端 / 管理页 / 预览页）。
 * 三个页面都是构建或源码产物，文件缺失时给出可执行的补救命令，避免只看到 404。
 */
function serveHtmlFile(res, file, missingHint) {
  if (!fs.existsSync(file)) return sendJson(res, 500, { error: missingHint });
  const html = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': html.length,
    'Cache-Control': 'no-store'
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      // 超限后只标记并丢弃后续数据，不再 destroy 请求：
      // 立即 destroy 会让客户端收不到 413 响应，只剩 ECONNRESET。
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, '请求体过大'));
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
  'Access-Control-Allow-Headers': 'Content-Type,If-None-Match'
};

module.exports = {
  MAX_BODY_BYTES,
  HttpError,
  bad,
  requireString,
  sendJson,
  sendEmpty,
  serveHtmlFile,
  readBody,
  CORS
};
