#!/usr/bin/env node
/**
 * 反向代理模块（电脑浏览器客户端专用）
 * ---------------------------------------------------------------------------
 * 为什么需要它：浏览器同源策略下，跨域 iframe 无法注入脚本，因此「自动登录」
 * 只有在被代理成同源后才可行。这里把配置里的内网大屏按路径前缀代理到同源下：
 *
 *   /proxy/<entryId>/<rest...>   →   <entry.url 的 origin 根>/<rest...>
 *
 * 映射不变式：**前缀映射到上游 origin 根、路径 1:1 原样镜像**。
 * 由它自然得到两个正确结论：
 *   1) 上游页面的相对 URL（`js/a.js`）解析结果与直连完全一致，无需注入 <base>；
 *   2) 页面的根相对 URL（`/api/x`，即浏览器会用「代理服务器的根」去解析）
 *      必须改写为 `/proxy/<id>/api/x`，这也正是「前缀↔origin 根」的含义。
 *
 * 零依赖：只用 node:http / node:https / node:zlib / node:url。
 *
 * 设计取舍（见 README「电脑浏览器客户端」章节）：
 *   - 只对 HTML 做「属性级」改写，绝不对 JS/CSS 做正则文本替换（会误伤字符串
 *     拼接、日期、注释）；运行时地址由注入的 shim 统一收敛。
 *   - 文本响应改写后必须删掉 Content-Encoding/Content-Length，改分块发送。
 *   - 二进制、大文件、text/event-stream 一律流式直通，SSE 不缓冲。
 *   - 目标只能由 data.entries 的 id 推导，禁止用 URL 参数指定目标（防 SSRF）。
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const transpile = require('./transpile');

const PREFIX = '/proxy/';
/** 需要缓冲改写的文本响应体积上限；超过就流式直通 */
const MAX_BUFFER_BYTES = 5 * 1024 * 1024;
/** 单个入口的并发上游连接上限（2×2 分区 + 轮询会同时打很多请求） */
const MAX_CONCURRENCY_PER_ENTRY = 24;
/** 上游连接与响应超时 */
const UPSTREAM_TIMEOUT_MS = 20000;

/** 请求方向需要剥离的 hop-by-hop 头 */
const DROP_REQUEST_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

/** 响应方向需要剥离的 hop-by-hop 头 */
const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'trailer', 'te',
  'proxy-authenticate'
]);

/**
 * 会阻止 / 干扰同源页面被 iframe 嵌套的响应头，必须剥掉。
 * 注意：被代理页面与 18000 的管理接口同源，这是既有「内网免登录」设计的固有
 * 风险，代理侧只能做入口白名单，详见 README。
 */
const DROP_FRAME_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy'
]);

/* ============================ 路径与目标 ============================ */

/**
 * 解析代理路径（**必须用未归一化的原始 pathname**，
 * 否则 `/cockpit/` 与 `/cockpit` 会被混为一谈）。
 * @returns {{entryId: string, upstreamPath: string}|null} null 表示不是合法的代理路径
 */
function parseProxyPath(pathname) {
  const raw = String(pathname || '');
  if (raw !== '/proxy' && !raw.startsWith(PREFIX)) return null;
  if (raw === '/proxy' || raw === PREFIX) return null; // 缺 entryId
  const body = raw.slice(PREFIX.length);
  const slash = body.indexOf('/');
  const entryId = slash < 0 ? body : body.slice(0, slash);
  if (!entryId) return null;
  let upstreamPath = slash < 0 ? '/' : body.slice(slash);
  if (!upstreamPath.startsWith('/')) upstreamPath = `/${upstreamPath}`;
  return { entryId: decodeURIComponent(entryId), upstreamPath };
}

/** 由入口与上游路径构造目标 URL（查询串原样透传） */
function buildTarget(entry, upstreamPath, search) {
  const base = new URL(entry.url);
  const target = new URL(base.origin);
  target.pathname = upstreamPath;
  target.search = search || '';
  return target;
}

/** 把上游 URL 还原为代理路径（用于 Location / Referer 改写） */
function toProxyPath(entryId, upstreamUrl) {
  const u = upstreamUrl instanceof URL ? upstreamUrl : new URL(String(upstreamUrl));
  return `${PREFIX}${encodeURIComponent(entryId)}${u.pathname}${u.search}`;
}

/* ============================ 请求头改写 ============================ */

/** 把可能带代理前缀的 Referer/Origin 还原成上游视角的地址 */
function upstreamViewOf(value, entry, target) {
  if (!value) return null;
  const raw = String(value);
  try {
    const u = new URL(raw);
    const parsed = parseProxyPath(u.pathname);
    if (parsed) {
      // 父页面在代理下发的地址：还原本地上游路径
      const origin = new URL(entry.url).origin;
      return `${origin}${parsed.upstreamPath}${u.search}`;
    }
    // 父页面自身地址（18000 的 /app）：退化为上游根，避免上游校验 Referer 时直接失败
    return `${target.origin}/`;
  } catch (e) {
    return `${target.origin}/`;
  }
}

function sanitizeRequestHeaders(reqHeaders, entry, target) {
  const out = {};
  Object.keys(reqHeaders).forEach((k) => {
    const lower = k.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(lower)) return;
    // 这三个下面统一以规范大小写重写：若在这里按原样复制，会同时出现
    // 小写与大写两套键，造成重复头（Node 会按大小写不敏感合并，值不可控）
    if (lower === 'host' || lower === 'origin' || lower === 'referer') return;
    out[k] = reqHeaders[k];
  });
  // 上游看到的必须是自己：Host / Origin / Referer
  out.Host = target.host;
  if (reqHeaders.origin) {
    const o = upstreamViewOf(reqHeaders.origin, entry, target);
    out.Origin = new URL(o).origin;
  }
  if (reqHeaders.referer) {
    out.Referer = upstreamViewOf(reqHeaders.referer, entry, target);
  }
  // 主动要明文，便于按需改写文本；上游仍压缩时下面用 zlib 解
  delete out['Accept-Encoding'];
  delete out['accept-encoding'];
  return out;
}

/* ============================ 响应头改写 ============================ */

/** Set-Cookie 的 Path 需要做前缀拼接，Domain 必须去掉 */
function rewriteSetCookie(value, entryId) {
  const raw = String(value);
  const parts = raw.split(';');
  const kept = [];
  let sawPath = false;
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i].trim();
    const eq = seg.indexOf('=');
    const name = (eq < 0 ? seg : seg.slice(0, eq)).trim().toLowerCase();
    const val = eq < 0 ? '' : seg.slice(eq + 1).trim();
    if (name === 'domain') continue; // 上游域名在代理下不成立
    if (name === 'path') {
      sawPath = true;
      const upstreamPath = val || '/';
      kept.push(`Path=${PREFIX}${encodeURIComponent(entryId)}${upstreamPath}`);
      continue;
    }
    kept.push(seg);
  }
  if (!sawPath) kept.push(`Path=${PREFIX}${encodeURIComponent(entryId)}/`);
  // SameSite=None 在浏览器里必须配 Secure，否则会被丢弃；localhost 视为安全上下文
  const hasSameSiteNone = kept.some((s) => /^samesite\s*=\s*none$/i.test(s));
  const hasSecure = kept.some((s) => /^secure$/i.test(s));
  if (hasSameSiteNone && !hasSecure) kept.push('Secure');
  return [parts[0].trim(), ...kept].join('; ');
}

/** Location 改写：相对的先按上游请求地址解析，再加前缀；已带前缀不重复加 */
function rewriteLocation(value, entry, target) {
  const raw = String(value);
  try {
    const resolved = new URL(raw, target.href);
    // 目标不是本入口的上游源（跳到别的站点）→ 原样放过，属已知限制
    if (resolved.origin !== target.origin) return raw;
    const proxied = toProxyPath(entry.id, resolved);
    // 防环：万一上游自己就返回了带前缀的地址
    if (raw.startsWith(PREFIX)) return raw;
    return proxied;
  } catch (e) {
    return raw;
  }
}

/**
 * 生成回给浏览器的响应头。
 * @param {object} upHeaders 上游响应头
 * @param {{entry: object, target: URL, rewritten: boolean}} ctx
 */
function sanitizeResponseHeaders(upHeaders, ctx) {
  const { entry, target, rewritten } = ctx;
  const out = {};
  Object.keys(upHeaders).forEach((k) => {
    const lower = k.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lower)) return;
    if (DROP_FRAME_HEADERS.has(lower)) return;
    if (rewritten && (lower === 'content-encoding' || lower === 'content-length')) return;
    // location / set-cookie 下面要单独改写，这里不能按原样复制，
    // 否则会与改写后的结果形成重复头
    if (lower === 'location' || lower === 'set-cookie') return;
    out[k] = upHeaders[k];
  });
  if (upHeaders.location) out.Location = rewriteLocation(upHeaders.location, entry, target);
  if (upHeaders['set-cookie']) {
    out['Set-Cookie'] = upHeaders['set-cookie'].map((v) => rewriteSetCookie(v, entry.id));
  }
  return out;
}

/* ============================ 内容改写 ============================ */

/** JS 类 Content-Type（用于判断是否需要转译） */
const JS_CONTENT_TYPES = new Set([
  'application/javascript', 'text/javascript', 'application/x-javascript',
  'application/ecmascript', 'text/ecmascript', 'module'
]);

/**
 * 判断是否需要（且允许）缓冲改写。
 * @param {string} contentType
 * @param {string|number} contentLength
 * @param {object} [entry] 入口；只有开启 compatTranspile 且 esbuild 可用时才把 JS 判为 'js'
 */
function rewriteKindOf(contentType, contentLength, entry) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (!ct) return null;
  if (ct === 'text/event-stream') return null; // SSE 缓冲即坏
  const size = Number(contentLength);
  if (Number.isFinite(size) && size > MAX_BUFFER_BYTES) return null;
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html';
  // 旧内核兼容转译：把 JS 交给 esbuild 降级（详见 transpile.js）。esbuild 缺失时
  // 退回 'text'，行为与未开启时完全一致，绝不因为依赖缺失而拒发内容。
  if (entry && entry.compatTranspile === true && JS_CONTENT_TYPES.has(ct) && transpile.isAvailable()) {
    return 'js';
  }
  if (ct === 'text/css' || ct === 'text/plain' ||
      JS_CONTENT_TYPES.has(ct) ||
      ct === 'application/json' || ct === 'application/xml' || ct === 'text/xml' ||
      ct === 'image/svg+xml') return 'text';
  return null;
}

/** 按 Content-Encoding 解压（上游忽略了我们「不要压缩」的请求时） */
function decodeBody(buffer, contentEncoding) {
  const enc = String(contentEncoding || '').toLowerCase().trim();
  if (!enc || enc === 'identity') return buffer;
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer);
  if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  if (enc === 'deflate') {
    try {
      return zlib.inflateSync(buffer);
    } catch (e) {
      return zlib.inflateRawSync(buffer); // 有些服务端发的是裸 deflate
    }
  }
  return buffer;
}

/** 转义成可安全内联进 <script> 文本节点的字面量 */
const jsLiteral = (s) => JSON.stringify(String(s)).replace(/</g, '\\u003c');

/**
 * 旧内核兼容垫片：按需补齐目标内核缺失的运行时 API。
 * ---------------------------------------------------------------------------
 * 与「语法转译」（transpile.js）互补：转译解决 `class A { x = 1 }` / `??` 这类
 * **语法**在旧内核上直接白屏的致命问题；垫片解决 `String.replaceAll` /
 * `Promise.allSettled` 这类**API**缺失导致的运行时报错。两者由同一个入口级开关
 * compatTranspile 控制。
 *
 * 只用 ES5 语法编写：它会在任何可能的目标内核上、先于业务脚本执行。
 * 全部按「存在性守卫」安装，在现代内核上就是一段空转代码。
 */
function buildCompatShim(entry) {
  const target = String(entry.compatTarget || transpile.DEFAULT_TARGET);
  return `<script>(function(){
var g=typeof window!=="undefined"?window:(typeof self!=="undefined"?self:this);
try{g.__TV_COMPAT__={target:${jsLiteral(target)}};}catch(e){}
if(typeof g.globalThis==="undefined"){try{Object.defineProperty(g,"globalThis",{value:g,configurable:true,writable:true});}catch(e){g.globalThis=g;}}
var SP=String.prototype,AP=Array.prototype,P=g.Promise;
if(typeof SP.replaceAll!=="function"){SP.replaceAll=function(search,replacement){
if(search instanceof RegExp){if(!search.global)throw new TypeError("replaceAll must be called with a global RegExp");return this.replace(search,replacement);}
var esc=String(search).replace(/[.*+?^\${}()|[\\]\\\\]/g,"\\\\$&");
return this.replace(new RegExp(esc,"g"),replacement);};}
if(typeof SP.matchAll!=="function"){SP.matchAll=function(rx){
var s=String(this),re;
if(rx instanceof RegExp){if(!rx.global)throw new TypeError("matchAll must be called with a global RegExp");re=rx;}
else re=new RegExp(rx==null?"":String(rx),"g");
var li=re.lastIndex||0;
var it={next:function(){
if(li>s.length)return {done:true,value:undefined};
var r=new RegExp(re.source,re.flags||"g");r.lastIndex=li;
var m=r.exec(s);
if(!m)return {done:true,value:undefined};
li=m[0]===""?li+1:r.lastIndex;
return {done:false,value:m};}};
if(typeof Symbol!=="undefined"&&Symbol.iterator)it[Symbol.iterator]=function(){return this;};
return it;};}
if(typeof SP.trimStart!=="function")SP.trimStart=SP.trimLeft||function(){return this.replace(/^\\s+/,"");};
if(typeof SP.trimEnd!=="function")SP.trimEnd=SP.trimRight||function(){return this.replace(/\\s+$/,"");};
if(typeof AP.flat!=="function"){AP.flat=function(d){var n=Number(d)||0;var out=[];var add=function(a){for(var i=0;i<a.length;i++){var v=a[i];if(n>1&&Array.isArray(v))add(v);else out.push(v);}};if(n<1)return AP.slice.call(this);add(this);return out;};}
if(typeof AP.flatMap!=="function"){AP.flatMap=function(fn,thisArg){var out=[];this.forEach(function(v,i,a){var r=fn.call(thisArg,v,i,a);if(Array.isArray(r)){for(var j=0;j<r.length;j++)out.push(r[j]);}else out.push(r);});return out;};}
if(P&&typeof P.allSettled!=="function"){P.allSettled=function(list){
var arr=Array.from?Array.from(list):AP.slice.call(list);
return P.all(arr.map(function(p){return P.resolve(p).then(function(v){return {status:"fulfilled",value:v};},function(e){return {status:"rejected",reason:e};});}));};}

// ---- 64 位 / 新数组 API 垫片（Chrome 67+ 才有）--------------------------------
// Uptime Kuma 这类站点会把 webidl-conversions 一起打包进来，它在**模块初始化**阶段
// 就读取 BigInt.asUintN / asIntN，Chrome 66 下直接 ReferenceError，整个 bundle 初始化
// 中断 → 全白且没有任何画面。Array.prototype.at 则用在心跳列表渲染里，缺了会 TypeError。
// 这里只做「值都能转成 Number」的等价实现：该模块的用途就是把宽度受限的整数转成 JS 数字，
// 帧长度编码也只用到 < 2^53 的范围，够用。
if(typeof g.BigInt!=="function"){
  var BI=function(v){return Number(v);};
  BI.asIntN=function(b,v){return Number(v);};
  BI.asUintN=function(b,v){return Number(v);};
  BI.prototype={};
  try{Object.defineProperty(BI,"name",{value:"BigInt"});}catch(e){}
  g.BigInt=BI;
}
if(g.DataView){
  var DVP=g.DataView.prototype;
  if(typeof DVP.setBigUint64!=="function"){DVP.setBigUint64=function(off,val,le){
    var v=Number(val)||0,h=Math.floor(v/4294967296),l=v>>>0;
    if(le){this.setUint32(off,l,true);this.setUint32(off+4,h,true);}
    else{this.setUint32(off,h,false);this.setUint32(off+4,l,false);}
  };}
  if(typeof DVP.getBigUint64!=="function"){DVP.getBigUint64=function(off,le){
    var h=le?this.getUint32(off+4,true):this.getUint32(off,false);
    var l=le?this.getUint32(off,true):this.getUint32(off+4,false);
    return h*4294967296+l;
  };}
}
if(typeof AP.at!=="function"){AP.at=function(i){var n=Number(i)||0,l=this.length;n=n<0?l+n:n;return n<0||n>=l?void 0:this[n];};}
if(typeof SP.at!=="function"){SP.at=function(i){var n=Number(i)||0,l=this.length;n=n<0?l+n:n;return n<0||n>=l?void 0:this.charAt(n);};}
if(typeof AP.findLast!=="function"){AP.findLast=function(f,t){for(var i=this.length-1;i>=0;i--){if(f.call(t,this[i],i,this))return this[i];}return void 0;};}
if(typeof AP.findLastIndex!=="function"){AP.findLastIndex=function(f,t){for(var i=this.length-1;i>=0;i--){if(f.call(t,this[i],i,this))return i;}return -1;};}
if(typeof AP.toReversed!=="function"){AP.toReversed=function(){var a=AP.slice.call(this);a.reverse();return a;};}
if(typeof AP.toSorted!=="function"){AP.toSorted=function(c){var a=AP.slice.call(this);a.sort(c);return a;};}
if(typeof AP.toSpliced!=="function"){AP.toSpliced=function(st,dc){var a=AP.slice.call(this);var rest=AP.slice.call(arguments,2);a.splice.apply(a,[st,dc].concat(rest));return a;};}
if(typeof AP.with!=="function"){AP.with=function(i,v){var a=AP.slice.call(this);var n=Number(i)||0;n=n<0?a.length+n:n;a[n]=v;return a;};}
if(typeof Object.fromEntries!=="function"){Object.fromEntries=function(it){var o={},a=Array.from(it),i;for(i=0;i<a.length;i++)o[a[i][0]]=a[i][1];return o;};}
if(typeof Object.hasOwn!=="function"){Object.hasOwn=function(o,k){return Object.prototype.hasOwnProperty.call(o,k);};}
if(P&&typeof P.any!=="function"){P.any=function(list){return new P(function(res,rej){
var a=Array.from(list);if(!a.length){rej(new Error("All promises were rejected"));return;}
var n=0;a.forEach(function(p){P.resolve(p).then(res,function(){if(++n===a.length)rej(new Error("All promises were rejected"));});});});};}
if(typeof g.queueMicrotask!=="function"){g.queueMicrotask=function(fn){P.resolve().then(fn);};}
})();</script>`;
}

/**
 * 注入到 <head> 最前的 shim：
 * 运行时把指向上游源的绝对地址、以及根相对地址收敛到代理前缀。
 * 之所以不在服务端对 JS 做正则改写，就是为了让它来干这件事。
 */
function buildShim(entry, prefix) {
  const origin = new URL(entry.url).origin;
  const spaSnippet = entry.spaHistory === true
    ? `function stripP(){try{var lp=location.pathname;` +
      `var rest=lp===P?'':(lp.indexOf(P+'/')===0?lp.slice(P.length):null);` +
      `if(rest===null){window.__TV_STRIP__={done:false,lp:lp};return;}` +
      `RS(history.state,'',(rest||'/')+location.search+location.hash);` +
      `window.__TV_STRIP__={done:true,from:lp,to:location.pathname};` +
    `}catch(e){window.__TV_STRIP__={done:false,err:String(e&&e.message||e)};}}` +
      `stripP();window.addEventListener('popstate',stripP);window.addEventListener('DOMContentLoaded',stripP);`
    : '';
  return `<script>(function(){` +
    `var P=${jsLiteral(prefix)},O=${jsLiteral(origin)};` +
    `var H=O.replace(/^[a-z]+:\\/\\//i,'');` +
    // 原生 replaceState：stripP 必须用它。若走下面被 fix() 包过的版本，
    // 剥掉的前缀会被立刻加回来，剥离等于没做
    `var RS=history.replaceState.bind(history);` +
    `function fix(u){` +
      `if(typeof u!=='string'||!u)return u;` +
      `if(u.indexOf(O)===0)return P+u.slice(O.length);` +
      `if(u.indexOf('//'+H)===0)return P+u.slice(2+H.length);` +
      // 已经带代理前缀的路径直接放行：SPA 启动时常把 location.pathname 原样写回
      // history（如 pushState(pathname+'#/')），若再拼一次前缀，baseURI 会变成
      // 双前缀，后续按相对路径懒加载的 chunk 全部 404，页面卡在启动画面
      `if(u===P||u.indexOf(P+'/')===0||u.indexOf(P+'#')===0||u.indexOf(P+'?')===0)return u;` +
      `if(u.charAt(0)==='/'&&u.charAt(1)!=='/')return P+u;` +
      // 指向本代理源自身的绝对地址（如页面用 location.host 拼出的 ws://<host>/mqtt）：
      // 路径也要挂到前缀下，否则会打到本服务的根路径上
      `if(/^[a-z][a-z0-9+.-]*:\\/\\//i.test(u)){try{var a=new URL(u);` +
        `if(a.host===location.host&&a.pathname!==P&&a.pathname.indexOf(P+'/')!==0)return P+a.pathname+a.search;` +
      `}catch(e){}}` +
      `return u;` +
    `}` +
    `window.__TV_PROXY__={prefix:P,origin:O,fix:fix};` +
    // fetch
    `if(window.fetch){var f=window.fetch;window.fetch=function(input,init){` +
      `try{if(typeof input==='string')input=fix(input);` +
      `else if(input&&input.url&&fix(input.url)!==input.url)input=new Request(fix(input.url),input);` +
      `}catch(e){}return f.call(this,input,init);};}` +
    // XMLHttpRequest
    `if(window.XMLHttpRequest){var o=XMLHttpRequest.prototype.open;` +
      `XMLHttpRequest.prototype.open=function(m,u){` +
      `try{arguments[1]=fix(u);}catch(e){}return o.apply(this,arguments);};}` +
    // history
    `if(window.history){['pushState','replaceState'].forEach(function(n){` +
      `var h=history[n];if(typeof h!=='function')return;` +
      `history[n]=function(s,t,u){try{if(u!=null)arguments[2]=fix(String(u));}catch(e){}` +
      `return h.apply(this,arguments);};});}` +
    // WebSocket / EventSource
    `function patchCtor(name){var C=window[name];if(typeof C!=='function')return;` +
      `function W(u,p){return p===undefined?new C(fix(u)):new C(fix(u),p);}` +
      `W.prototype=C.prototype;W.CONNECTING=C.CONNECTING;W.OPEN=C.OPEN;W.CLOSING=C.CLOSING;W.CLOSED=C.CLOSED;` +
      `window[name]=W;}` +
    `patchCtor('WebSocket');patchCtor('EventSource');` +
    // history 路由 SPA（如 Uptime Kuma）：路由器启动时直接读 location.pathname，
    // 带代理前缀的路径匹配不到任何路由，页面会渲染成 SPA 自己的 404。
    // 在文档最开头把前缀从地址剥掉（此前的资源请求已按改写后的绝对地址发出，不受影响）；
    // SPA 的 pushState 已被 fix() 加回前缀（保证刷新/直开可用），但后退/前进时路由器
    // 会重新读 pathname，需在路由器自己的 popstate 监听器之前把前缀剥掉。
    // 传统多页站点不要开启：剥前缀会让相对路径的表单/链接逃出代理（仅 GET 有兜底）。
    spaSnippet +
  `})();</script>`;
}

/* ---------------------------------------------------------------------------
 * 服务端自动登录注入
 * ---------------------------------------------------------------------------
 * 「强制原址打开」的入口会在独立标签页直接访问代理地址——那里没有客户端外壳，
 * 客户端无法注入自动登录脚本。因此对配置了自动登录的入口，代理在返回 HTML 时
 * 直接把配置与 auto_login.js（与电视端/电脑端同一份）注入进页面，独立标签页
 * 也能自动填充登录。标记 __TV_AUTOLOGIN_SERVER__ 供客户端判重，避免重复注入。
 * ------------------------------------------------------------------------- */

/** 启动时读取一次自动登录脚本；读不到（如部署不含 app 目录）则静默停用 */
let AUTO_LOGIN_SRC = '';
try {
  AUTO_LOGIN_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'js', 'auto_login.js'),
    'utf8'
  );
} catch (e) { /* 保持为空，注入自动跳过 */ }

function buildAutoLoginInject(entry) {
  const al = entry.autoLogin;
  if (!AUTO_LOGIN_SRC || !al || al.enabled === false || !al.password) return '';
  // auto_login.js 不含 </script>，可安全内联；配置里的字符串统一转义 <
  const cfg = JSON.stringify({
    enabled: true,
    username: String(al.username || ''),
    password: String(al.password || ''),
    usernameSelector: String(al.usernameSelector || ''),
    passwordSelector: String(al.passwordSelector || ''),
    submitSelector: String(al.submitSelector || ''),
    successSelector: String(al.successSelector || '')
  }).replace(/</g, '\\u003c');
  return `<script>window.__TV_AUTOLOGIN__=${cfg};window.__TV_AUTOLOGIN_SERVER__=true;</script>` +
    `<script>${AUTO_LOGIN_SRC}</script>`;
}

/** 正则特殊字符转义（用在把上游 host 拼进 RegExp 时） */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把「指向上游源的 URL」替换成代理前缀。
 * 两种写法都要吃掉整段 scheme：
 *   - 绝对地址 `https://10.8.16.10:30000/x`  → `/proxy/<id>/x`
 *   - 协议相对 `//10.8.16.10:30000/x`        → `/proxy/<id>/x`
 * 若只先替换 `//host`，绝对地址会残留成 `https:/proxy/<id>/x`，浏览器把它归一化成
 * host=proxy 的地址（DNS 查不到 → ERR_NAME_NOT_RESOLVED）。现场虚拟化平台的
 * getRealIp 请求就是这么坏的。
 */
function rewriteOrigin(text, entry, prefix) {
  const host = new URL(entry.url).origin.replace(/^[a-z]+:\/\//i, '');
  const pattern = new RegExp(`(?:[a-z][a-z0-9+.\\-]*:)?//${escapeRe(host)}`, 'gi');
  return text.replace(pattern, prefix);
}

/**
 * HTML 改写：
 *   1) 上游源的绝对地址（含协议相对）→ 代理前缀
 *   2) 标签属性里的根相对地址 → 代理前缀
 *   3) 注入 shim
 * 刻意不碰内联 <style>/<script> 里的根相对地址（正则改 JS/CSS 风险大于收益）。
 */
function rewriteHtml(html, entry, prefix) {
  // 1) 绝对地址。上游源字符串本身无歧义，全局替换是安全的。
  let out = rewriteOrigin(html, entry, prefix);

  // 2) 属性级根相对地址。上游 HTML 可能用不带引号的属性（`<script src=/a.js>`，
  //    现场虚拟化平台就是这种写法），因此引号分支之外还要有裸值分支 —— 否则这些
  //    根相对资源会请求到代理服务器的根路径上，只能靠 Referer 兜底 302 抢救。
  out = out.replace(
    /(\s(?:src|href|action|poster|formaction|data-src|data-href|srcset)\s*=\s*)(?:(["'])([^"']*)\2|([^\s"'`=<>]+))/gi,
    (m, head, q, quoted, bare) => {
      const val = quoted !== undefined ? quoted : bare;
      if (val.startsWith('//')) return m;            // 协议相对已在第 1 步处理
      if (!val.startsWith('/')) return m;            // 相对地址无需前缀（路径 1:1 镜像）
      if (/^\/(proxy\/|#)/.test(val)) return m;      // 已是代理路径或纯锚点
      return quoted !== undefined ? `${head}${q}${prefix}${val}${q}` : `${head}${prefix}${val}`;
    }
  );

  // 3) shim 必须最先执行，才能拦住应用脚本发出的请求；随后按需注入自动登录。
  //    兼容垫片要排在代理 shim 之前：它补齐的 globalThis / replaceAll 等 API
  //    是后面所有脚本（含 shim 自己）的前提。
  const compat = entry.compatTranspile === true ? buildCompatShim(entry) : '';
  const shim = compat + buildShim(entry, prefix) + buildAutoLoginInject(entry);
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, (m) => m + shim);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, (m) => m + shim);
  } else {
    out = shim + out;
  }
  return out;
}

/** 文本（JS/CSS/JSON/SVG）只做绝对地址改写 —— 字符串替换上游源是无歧义的 */
function rewriteText(text, entry, prefix) {
  return rewriteOrigin(text, entry, prefix);
}

/**
 * JS 改写：先按目标内核转译（旧内核兼容），再做绝对地址改写。
 * 三层「兜底即回退」：esbuild 不可用 / 转译抛错 / 原文不是合法 UTF-8（转译前提是
 * 能正确解析，非 UTF-8 文本硬转会把中文串弄坏）—— 任何一种情况都用原文继续，
 * 保证脚本内容一定拿得到。
 */
function rewriteJs(text, entry, prefix, utf8Ok) {
  let src = text;
  if (utf8Ok) {
    const out = transpile.transform(text, entry.compatTarget);
    if (out) src = out;
  }
  return rewriteText(src, entry, prefix);
}

/* ============================ 代理主体 ============================ */

/**
 * @param {object} opts
 * @param {() => Array} opts.getEntries 取当前入口列表（由 server.js 注入，避免循环依赖）
 * @param {number} opts.listenPort  本服务监听端口，用于拒绝指向自身的回环目标
 * @param {(msg: string) => void} [opts.log]
 */
function createProxy(opts) {
  const getEntries = opts.getEntries;
  const listenPort = Number(opts.listenPort) || 0;
  const log = opts.log || (() => {});
  transpile.setLogger(log);
  /** 每个入口的在途请求数 */
  const inflight = new Map();

  const entryOf = (id) => (getEntries() || []).find((e) => e.id === id) || null;

  const isProxyPath = (pathname) =>
    String(pathname || '') === '/proxy' || String(pathname || '').startsWith(PREFIX);

  /** 拒绝「entry 指向 18000 自身」这种配置，避免形成代理环 */
  function isSelfTarget(target, req) {
    if (!listenPort) return false;
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    if (port !== listenPort) return false;
    const host = String(target.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
    const reqHost = String((req.headers.host || '').split(':')[0]).toLowerCase();
    return !!reqHost && reqHost === host;
  }

  function sendError(res, status, message) {
    const text = JSON.stringify({ error: message });
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store'
    });
    res.end(text);
  }

  /**
   * 兜底：被代理页面里用脚本跳转 `location.href = '/x'` 时前缀会丢失
   * （`window.location` 是 [Unforgeable]，shim 拦不住赋值），请求就打到了本服务的根路径。
   * 在**本服务所有路由都没命中之后**调用这里：若 Referer 指向某个代理入口，就 302 回带前缀的地址。
   * 只在 404 之前兜底，因此不会遮蔽任何真实接口；只处理 GET/HEAD，避免 POST 被改成 GET 语义。
   */
  function handleEscaped(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (url.pathname === PREFIX.slice(0, -1) || url.pathname.startsWith(PREFIX)) return false;
    const ref = req.headers.referer || req.headers.referrer;
    if (!ref) return false;
    let refPath;
    try {
      refPath = new URL(ref).pathname;
    } catch (e) {
      return false;
    }
    const parsed = parseProxyPath(refPath);
    if (!parsed || !entryOf(parsed.entryId)) return false;
    const location = `${PREFIX}${encodeURIComponent(parsed.entryId)}${url.pathname}${url.search}`;
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': 0 });
    res.end();
    return true;
  }

  /** 只转发「路径是否被归一化过」之外的一切：请求体流式 pipe，不走 readBody */
  function handle(req, res, url) {
    const parsed = parseProxyPath(url.pathname);
    if (!parsed) return sendError(res, 404, '代理路径需要 /proxy/<entryId>/ 前缀');

    const entry = entryOf(parsed.entryId);
    if (!entry) return sendError(res, 404, `入口「${parsed.entryId}」不存在`);

    let target;
    try {
      target = buildTarget(entry, parsed.upstreamPath, url.search);
    } catch (e) {
      return sendError(res, 400, `入口地址不合法：${e.message}`);
    }
    if (isSelfTarget(target, req)) return sendError(res, 400, '入口地址指向服务端自身，已拒绝');

    const count = inflight.get(entry.id) || 0;
    if (count >= MAX_CONCURRENCY_PER_ENTRY) {
      return sendError(res, 503, `入口「${entry.id}」并发过高，请稍后重试`);
    }
    inflight.set(entry.id, count + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inflight.set(entry.id, Math.max(0, (inflight.get(entry.id) || 1) - 1));
    };
    res.on('close', release);

    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const prefix = `${PREFIX}${encodeURIComponent(entry.id)}`;

    // 文档导航请求不下发条件请求头：上游的 ETag/Last-Modified 只反映**上游原始内容**，
    // 而代理会对返回内容做改写（注入 shim、改写地址等）。若放行 If-None-Match，
    // 上游会按未改写的内容回 304，浏览器就会一直沿用代理改写规则过期前的旧 HTML
    //（本次 Kuma「未找到该页面」的元凶：旧 HTML 里没有 SPA 前缀剥离脚本）。
    // 静态资源（JS/CSS）的改写仅涉及地址替换，且 304 透传有测试保障，维持原样。
    //
    // 例外：开启旧内核兼容转译的入口，其 JS 产物与上游 ETag 指向的字节已不同，
    // 放行条件头会让浏览器把「转译前」的旧脚本一直用下去（白屏依旧），
    // 因此这类请求也一律要全量内容。
    const compatJs = entry.compatTranspile === true && /\.m?js$/i.test(target.pathname);
    if (req.method === 'GET' &&
        (String(req.headers.accept || '').includes('text/html') || compatJs)) {
      delete req.headers['if-none-match'];
      delete req.headers['if-modified-since'];
    }

    const upstream = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: sanitizeRequestHeaders(req.headers, entry, target),
      // 每个请求独立连接：避免不同入口/不同会话共用长连接串味
      agent: false,
      rejectUnauthorized: isHttps ? entry.allowInsecureSsl !== true : undefined
    });

    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error('上游响应超时'));
    });

    upstream.on('response', (upRes) => {
      const kind = rewriteKindOf(upRes.headers['content-type'], upRes.headers['content-length'], entry);
      const ctx = { entry, target, rewritten: !!kind };

      if (!kind) {
        // 二进制 / 大文件 / SSE：流式直通，绝不缓冲
        res.writeHead(upRes.statusCode || 502, sanitizeResponseHeaders(upRes.headers, ctx));
        upRes.pipe(res);
        return;
      }

      const chunks = [];
      let size = 0;
      let aborted = false;
      upRes.on('data', (c) => {
        if (aborted) return;
        size += c.length;
        if (size > MAX_BUFFER_BYTES) {
          // 没预估到体积：退化为「直通 + 放弃改写」，保持原编码/长度，仍保证页面能用
          aborted = true;
          res.writeHead(upRes.statusCode || 502, sanitizeResponseHeaders(
            upRes.headers, { entry, target, rewritten: false }));
          if (chunks.length) res.write(Buffer.concat(chunks));
          upRes.pipe(res);
          return;
        }
        chunks.push(c);
      });
      upRes.on('end', () => {
        if (aborted) return;
        let body;
        try {
          body = decodeBody(Buffer.concat(chunks), upRes.headers['content-encoding']);
        } catch (e) {
          log(`[proxy] 解压失败（${entry.id}）：${e.message}`);
          sendError(res, 502, '上游响应解压失败');
          return;
        }
        const text = body.toString('utf8');
        let rewrittenText;
        if (kind === 'html') {
          rewrittenText = rewriteHtml(text, entry, prefix);
        } else if (kind === 'js') {
          // 原文能原样编码回同一串字节，才认为它是合法 UTF-8、可以做语法转译
          rewrittenText = rewriteJs(text, entry, prefix, Buffer.from(text, 'utf8').equals(body));
        } else {
          rewrittenText = rewriteText(text, entry, prefix);
        }
        const out = Buffer.from(rewrittenText, 'utf8');
        const headers = sanitizeResponseHeaders(upRes.headers, ctx);
        headers['Content-Type'] = upRes.headers['content-type'] || 'text/html; charset=utf-8';
        headers['Content-Length'] = out.length; // 已删除上游的旧长度，这里给准确值
        // 改写后的 HTML 必须每次回源重验证（配合上面丢弃条件头 = 每次拿到新鲜内容），
        // 防止浏览器用旧缓存把新注入的脚本「冻」在改写规则之外
        if (kind === 'html') headers['Cache-Control'] = 'no-cache';
        // 转译后的 JS 同理：产物与上游 ETag 对应的内容已经不是同一份字节了
        if (kind === 'js') headers['Cache-Control'] = 'no-cache';
        res.writeHead(upRes.statusCode || 502, headers);
        res.end(out);
      });
    });

    upstream.on('error', (err) => {
      release();
      if (res.headersSent) return res.end();
      sendError(res, 502, `无法连接上游「${entry.title || entry.id}」：${err.message}`);
    });

    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });

    req.pipe(upstream);
    return undefined;
  }

  /**
   * WebSocket 升级转发。必须把客户端首帧 head 一并写给上游，否则会丢数据。
   */
  function handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (e) {
      return socket.destroy();
    }
    const parsed = parseProxyPath(url.pathname);
    if (!parsed) return socket.destroy();

    const entry = entryOf(parsed.entryId);
    if (!entry) return socket.destroy();

    let target;
    try {
      target = buildTarget(entry, parsed.upstreamPath, url.search);
    } catch (e) {
      return socket.destroy();
    }
    if (isSelfTarget(target, req)) return socket.destroy();

    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers = sanitizeRequestHeaders(req.headers, entry, target);
    headers.Connection = 'Upgrade';
    headers.Upgrade = req.headers.upgrade || 'websocket';
    if (req.headers['sec-websocket-key']) headers['Sec-WebSocket-Key'] = req.headers['sec-websocket-key'];
    if (req.headers['sec-websocket-version']) headers['Sec-WebSocket-Version'] = req.headers['sec-websocket-version'];
    if (req.headers['sec-websocket-protocol']) headers['Sec-WebSocket-Protocol'] = req.headers['sec-websocket-protocol'];

    const upstream = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      headers,
      agent: false,
      rejectUnauthorized: isHttps ? entry.allowInsecureSsl !== true : undefined
    });

    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || 'Switching Protocols'}`];
      let sawConnection = false;
      let sawUpgrade = false;
      Object.keys(upRes.headers).forEach((k) => {
        const lower = k.toLowerCase();
        // 101 必须保留 Connection / Upgrade，否则客户端不认为升级成功
        if (lower !== 'connection' && lower !== 'upgrade' && DROP_RESPONSE_HEADERS.has(lower)) return;
        if (lower === 'connection') sawConnection = true;
        if (lower === 'upgrade') sawUpgrade = true;
        const v = upRes.headers[k];
        if (Array.isArray(v)) v.forEach((one) => lines.push(`${k}: ${one}`));
        else lines.push(`${k}: ${v}`);
      });
      if (!sawUpgrade) lines.push(`Upgrade: ${req.headers.upgrade || 'websocket'}`);
      if (!sawConnection) lines.push('Connection: Upgrade');
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head); // 客户端首帧，丢了会卡死握手
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      const close = () => {
        try { upSocket.destroy(); } catch (e) { /* 忽略 */ }
        try { socket.destroy(); } catch (e) { /* 忽略 */ }
      };
      upSocket.on('error', close);
      upSocket.on('close', close);
      socket.on('error', close);
      socket.on('close', close);
    });

    upstream.on('response', () => {
      // 上游没同意升级
      try { socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); } catch (e) { /* 忽略 */ }
      socket.destroy();
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
    return undefined;
  }

  return { isProxyPath, handle, handleUpgrade, handleEscaped, parseProxyPath, rewriteHtml, rewriteText };
}

module.exports = {
  createProxy,
  parseProxyPath,
  buildTarget,
  toProxyPath,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
  rewriteSetCookie,
  rewriteLocation,
  rewriteHtml,
  rewriteText,
  rewriteJs,
  rewriteKindOf,
  buildShim,
  buildCompatShim,
  PREFIX
};