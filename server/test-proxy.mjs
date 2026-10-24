#!/usr/bin/env node
/**
 * 反向代理端到端验证（零依赖）
 *
 * 为什么要自起「假上游」：真机环境里的三个内网大屏不可达，而代理的正确性完全
 * 取决于它对上游的请求与响应做了什么。所以这里在本机起一个可控的上游站点，
 * 覆盖子路径入口、根相对/绝对地址、重定向、Cookie、gzip、304、SSE、WebSocket。
 *
 * 必须跑在隔离实例上（会通过管理接口创建指向假上游的入口）：
 *   node server/test-run.mjs
 */
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';

const BASE = process.env.BASE;
if (!BASE) {
  console.error('本脚本会改写服务端数据，必须跑在隔离实例上：node server/test-run.mjs');
  process.exit(1);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log('      ' + JSON.stringify(detail));
};

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function api(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

/** 记录上游收到的原始请求路径，用于验证「路径 1:1 镜像」不变式 */
const seenPaths = [];

(async () => {
  const upPort = await freePort();
  const UP = `http://127.0.0.1:${upPort}`;
  const basePort = new URL(BASE).port;

  /* ==================== 假上游站点 ==================== */
  const upstream = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    seenPaths.push(p);

    const send = (status, headers, body) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    const html = (extraHeaders) => send(200, {
      'Content-Type': 'text/html; charset=utf-8',
      ...extraHeaders
    }, `<!doctype html><html><head><title>up</title>
      <script src="/assets/app.js"></script>
      <script src="${UP}/abs.js"></script>
      <script src="//127.0.0.1:${upPort}/proto.js"></script>
      <script src=/bare.js></script>
      <link href=/bare.css rel=stylesheet>
      </head><body><form><input id="username"><input id="password" type="password">
      <button id="loginBtn">登录</button></form></body></html>`);

    if (p === '/') return html({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    if (p === '/cockpit') return html({ 'X-Frame-Options': 'SAMEORIGIN' });
    if (p === '/assets/app.js' || p === '/abs.js' || p === '/proto.js' ||
        p === '/bare.js' || p === '/bare.css') {
      return send(200, { 'Content-Type': 'application/javascript; charset=utf-8' }, 'window.__up=1;');
    }
    if (p === '/echo-headers') {
      // 代理会改写文本响应里的上游绝对地址，直接回 JSON 会让断言读到「被改写后」的值，
      // 所以这里先把请求头 base64 编码再回传，测试端解码后即可看到上游真实收到的头。
      const enc = Buffer.from(JSON.stringify(req.headers), 'utf8').toString('base64');
      return send(200, { 'Content-Type': 'application/json' }, JSON.stringify({ enc }));
    }
    if (p === '/gzip.js') {
      // 故意无视客户端的 Accept-Encoding，强制压缩，验证代理能解压后再改写
      const body = zlib.gzipSync(Buffer.from(`var u="${UP}/abs.js";`, 'utf8'));
      return send(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': body.length
      }, body);
    }
    if (p === '/es2022.js') {
      // 模拟内网大屏的真实产物：公有类字段 / 空值合并 / 可选链
      // —— Chrome 66 解析这种脚本会直接抛语法错误，表现为整页白屏
      return send(200, { 'Content-Type': 'application/javascript; charset=utf-8' },
        'class Probe{field=1;static st=2;m(a){return a?.b??3;}}\nwindow.__probe=Probe;\n');
    }
    if (p === '/legacy.js') {
      return send(200, { 'Content-Type': 'application/javascript; charset=utf-8' },
        'window.__legacy="keep me as is";\n');
    }
    if (p === '/cookie') {
      return send(200, {
        'Content-Type': 'text/plain',
        'Set-Cookie': ['sid=abc; Path=/cockpit; Domain=example.com; HttpOnly; Max-Age=600']
      }, 'cookie');
    }
    if (p === '/etag') {
      if (req.headers['if-none-match'] === '"up-1"') return send(304, { ETag: '"up-1"' }, '');
      return send(200, { ETag: '"up-1"', 'Content-Type': 'text/plain' }, 'etag-body');
    }
    if (p === '/redirect-abs') return send(302, { Location: `${UP}/target` }, '');
    if (p === '/redirect-rel') return send(302, { Location: '/target' }, '');
    if (p === '/redirect-cross') return send(302, { Location: 'http://example.com/x' }, '');
    if (p === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write('data: hello\n\n');
      setTimeout(() => { try { res.end('data: bye\n\n'); } catch (e) { /* 忽略 */ } }, 1200);
      return undefined;
    }
    return send(404, { 'Content-Type': 'text/plain' }, 'upstream 404');
  });

  upstream.on('upgrade', (req, socket, head) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dummy\r\n\r\n');
    if (head && head.length) socket.write('echo:' + head.toString());
    socket.on('data', (d) => { try { socket.write('echo:' + d.toString()); } catch (e) { /* 忽略 */ } });
    socket.on('error', () => { /* 忽略 */ });
  });

  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

  const created = [];
  const addEntry = async (id, url, extra = {}) => {
    const r = await api('POST', '/api/admin/entries', { id, title: `代理验证 ${id}`, url, ...extra });
    if (r.status === 201) created.push(id);
    return r;
  };

  try {
    /* ==================== 准备入口 ==================== */
    const rootEntry = await addEntry('proxy-root', `${UP}/`);
    const subEntry = await addEntry('proxy-sub', `${UP}/cockpit`, {
      autoLogin: { enabled: true, username: 'show', password: 'wtzv@2026', usernameSelector: '#username', passwordSelector: '#password', submitSelector: '#loginBtn' }
    });
    check('创建指向假上游的入口成功',
      rootEntry.status === 201 && subEntry.status === 201,
      { root: rootEntry.status, sub: subEntry.status, err: subEntry.json });

    /* ---------- 1. 客户端页面托管 ---------- */
    const appPage = await fetch(`${BASE}/app`);
    const appHtml = await appPage.text();
    check('电脑端客户端页面由 /app 托管',
      appPage.status === 200 && /text\/html/.test(appPage.headers.get('content-type') || '') &&
      appHtml.includes('数智中心大屏聚合平台') && appHtml.includes('tvshow.localSettings'),
      { status: appPage.status, ct: appPage.headers.get('content-type') });

    // 站点首页也是客户端页面，且工具栏上的跳转按钮指向 /setting 与 /preview
    const rootPage = await fetch(`${BASE}/`);
    const rootHtml = await rootPage.text();
    check('站点首页 / 亦为客户端页面，且工具栏按钮指向新的专用路径',
      rootPage.status === 200 && rootHtml.includes('tvshow.localSettings') &&
      rootHtml.includes('href="/setting"') && rootHtml.includes('href="/preview"'),
      { status: rootPage.status });

    /* ---------- 2. 子路径入口路径 1:1 镜像 ---------- */
    seenPaths.length = 0;
    const sub = await fetch(`${BASE}/proxy/proxy-sub/cockpit`);
    const subHtml = await sub.text();
    check('子路径入口：/proxy/<id>/cockpit → 上游 /cockpit',
      sub.status === 200 && seenPaths[0] === '/cockpit',
      { status: sub.status, seen: seenPaths.slice() });
    check('子路径入口的根相对资源镜像到上游根（前缀↔origin 根）',
      (await fetch(`${BASE}/proxy/proxy-sub/assets/app.js`)).status === 200 &&
      seenPaths.includes('/assets/app.js'),
      seenPaths.slice());

    /* ---------- 3. HTML 属性级改写 + shim ---------- */
    check('HTML 中的根相对与绝对地址被改写为代理前缀',
      subHtml.includes('/proxy/proxy-sub/assets/app.js') &&
      subHtml.includes('/proxy/proxy-sub/abs.js') &&
      subHtml.includes('/proxy/proxy-sub/proto.js') &&
      !subHtml.includes(`${UP}/abs.js`),
      subHtml.slice(0, 400));
    check('HTML 顶部注入了运行时 shim（patch fetch/XHR/history/WS）',
      subHtml.includes('__TV_PROXY__') && subHtml.includes('patchCtor') &&
      subHtml.indexOf('__TV_PROXY__') < subHtml.indexOf('/assets/app.js'),
      null);
    check('HTML 中不带引号的根相对属性同样被改写（现场虚拟化平台就是这种写法）',
      subHtml.includes('src=/proxy/proxy-sub/bare.js') &&
      subHtml.includes('href=/proxy/proxy-sub/bare.css'),
      subHtml.slice(subHtml.indexOf('<body'), subHtml.indexOf('<body') + 200));

    /* ---------- 3b. spaHistory：history 路由 SPA 的前缀剥离 ---------- */
    const spaEntry = await addEntry('proxy-spa', `${UP}/dashboard`, { spaHistory: true });
    const spaHtml = spaEntry.status === 201
      ? await (await fetch(`${BASE}/proxy/proxy-spa/cockpit`)).text()
      : '';
    check('spaHistory 入口：shim 在文档开头注入前缀剥离脚本（启动 + popstate）',
      spaHtml.includes("stripP();window.addEventListener('popstate',stripP)") &&
      spaHtml.includes('replaceState') &&
      spaHtml.indexOf('stripP') < spaHtml.indexOf('/assets/app.js'),
      { status: spaEntry.status, hasSnippet: spaHtml.includes('stripP') });
    check('未开启 spaHistory 的入口不注入剥离脚本',
      !subHtml.includes('stripP'),
      null);

    /* ---------- 4. 阻止嵌套的响应头被剥离 ---------- */
    const rootRes = await fetch(`${BASE}/proxy/proxy-root/`);
    const rootBody = await rootRes.text();
    check('X-Frame-Options / CSP 被剥离，页面可被同源 iframe 嵌套',
      !rootRes.headers.get('x-frame-options') && !rootRes.headers.get('content-security-policy'),
      { xfo: rootRes.headers.get('x-frame-options'), csp: rootRes.headers.get('content-security-policy') });
    check('改写后 Content-Length 与实际字节一致且无 Content-Encoding',
      Number(rootRes.headers.get('content-length')) === Buffer.byteLength(rootBody) &&
      !rootRes.headers.get('content-encoding'),
      { cl: rootRes.headers.get('content-length'), real: Buffer.byteLength(rootBody), ce: rootRes.headers.get('content-encoding') });

    /* ---------- 5. 请求头改写 ---------- */
    const echoedEnc = await (await fetch(`${BASE}/proxy/proxy-root/echo-headers`, {
      headers: { Origin: `${BASE}`, Referer: `${BASE}/app` }
    })).json();
    const echoed = JSON.parse(Buffer.from(echoedEnc.enc, 'base64').toString('utf8'));
    check('上游收到的是自己的 Host（而非代理的 Host）',
      echoed.host === `127.0.0.1:${upPort}`, echoed.host);
    check('Origin / Referer 已改写为上游视角',
      echoed.origin === UP && String(echoed.referer || '').startsWith(UP),
      { origin: echoed.origin, referer: echoed.referer });
    // 注意：Connection: close 是 Node 以 agent:false 直连上游时自动加上的
    // hop-by-hop 头，属代理↔上游之间的正常行为；客户端发来的 connection 已被剥离。
    check('hop-by-hop 头与 Accept-Encoding 不下发（便于改写明文）',
      !echoed['keep-alive'] && !echoed['accept-encoding'] &&
      !echoed['transfer-encoding'] && !echoed.te,
      { connection: echoed.connection, ae: echoed['accept-encoding'], te: echoed['transfer-encoding'] });

    /* ---------- 6. 重定向 ---------- */
    const ra = await fetch(`${BASE}/proxy/proxy-root/redirect-abs`, { redirect: 'manual' });
    const rr = await fetch(`${BASE}/proxy/proxy-root/redirect-rel`, { redirect: 'manual' });
    const rc = await fetch(`${BASE}/proxy/proxy-root/redirect-cross`, { redirect: 'manual' });
    check('绝对地址重定向改写为代理前缀且不跟随',
      ra.status === 302 && ra.headers.get('location') === '/proxy/proxy-root/target',
      { status: ra.status, loc: ra.headers.get('location') });
    check('相对地址重定向按上游地址解析后加前缀',
      rr.status === 302 && rr.headers.get('location') === '/proxy/proxy-root/target',
      { status: rr.status, loc: rr.headers.get('location') });
    check('跨域重定向原样放过（跳出 iframe 属已知限制）',
      rc.status === 302 && rc.headers.get('location') === 'http://example.com/x',
      { loc: rc.headers.get('location') });

    /* ---------- 6b. 脚本跳转丢前缀的 Referer 兜底 ---------- */
    const escaped = await fetch(`${BASE}/escaped/page`, {
      redirect: 'manual',
      headers: { Referer: `${BASE}/proxy/proxy-root/somepage` }
    });
    check('被代理页脚本跳转打到根路径时，按 Referer 302 回带前缀的地址',
      escaped.status === 302 && escaped.headers.get('location') === '/proxy/proxy-root/escaped/page',
      { status: escaped.status, loc: escaped.headers.get('location') });

    const notEscaped = await fetch(`${BASE}/escaped/page`, {
      redirect: 'manual',
      headers: { Referer: `${BASE}/app` }
    });
    check('非代理来源的未知路径仍返回 404（兜底不遮蔽真实路由）',
      notEscaped.status === 404, { status: notEscaped.status });

    /* ---------- 7. Cookie 路径改写 ---------- */
    const ck = await fetch(`${BASE}/proxy/proxy-sub/cookie`);
    const setCookie = ck.headers.get('set-cookie') || '';
    check('Set-Cookie 的 Path 前缀拼接正确、Domain 被去掉、其余属性保留',
      setCookie.includes('Path=/proxy/proxy-sub/cockpit') &&
      !/Domain=/i.test(setCookie) && /HttpOnly/i.test(setCookie) && /Max-Age=600/i.test(setCookie),
      setCookie);

    /* ---------- 8. gzip 文本解压后改写 ---------- */
    const gz = await fetch(`${BASE}/proxy/proxy-root/gzip.js`);
    const gzText = await gz.text();
    check('上游强制 gzip 的 JS 被解压、改写且不再带 Content-Encoding',
      gzText.includes('/proxy/proxy-root/abs.js') && !gzText.includes(`${UP}/abs.js`) &&
      !gz.headers.get('content-encoding'),
      { body: gzText, ce: gz.headers.get('content-encoding') });
    check('绝对地址改写吃掉整段 scheme，不残留 https:/proxy/…（否则浏览器会当成 host=proxy）',
      gzText === 'var u="/proxy/proxy-root/abs.js";', gzText);

    /* ---------- 9. 304 透传 ---------- */
    const nm = await fetch(`${BASE}/proxy/proxy-root/etag`, { headers: { 'If-None-Match': '"up-1"' } });
    const nmText = await nm.text();
    check('上游 304 原样透传且 body 为空',
      nm.status === 304 && nmText === '', { status: nm.status, text: nmText });

    /* ---------- 9b. 文档请求不透传条件头（防旧 HTML 被上游 304 冻住） ---------- */
    const docCond = await fetch(`${BASE}/proxy/proxy-root/etag`, {
      headers: { 'If-None-Match': '"up-1"', Accept: 'text/html' }
    });
    const docCondText = await docCond.text();
    check('文档导航请求丢弃 If-None-Match，始终拿到改写后的新鲜 200',
      docCond.status === 200 && docCondText === 'etag-body',
      { status: docCond.status, text: docCondText });
    check('改写后的 HTML 带 Cache-Control: no-cache（强制每次回源）',
      rootRes.headers.get('cache-control') === 'no-cache',
      { cc: rootRes.headers.get('cache-control') });

    /* ---------- 10. SSE 不被整体缓冲 ---------- */
    const t0 = Date.now();
    const sse = await fetch(`${BASE}/proxy/proxy-root/sse`);
    const reader = sse.body.getReader();
    const first = await reader.read();
    const firstMs = Date.now() - t0;
    reader.cancel().catch(() => {});
    check('text/event-stream 流式直通（首字节未被缓冲到结束）',
      firstMs < 800 && new TextDecoder().decode(first.value).includes('hello'),
      { firstMs, chunk: first.value ? new TextDecoder().decode(first.value) : null });

    /* ---------- 11. 安全：未知入口 / 路径穿越 / 自指向 ---------- */
    const unknown = await api('GET', '/proxy/not-exist/');
    check('未知入口返回 404', unknown.status === 404 && /不存在/.test(unknown.json.error), unknown.json);

    seenPaths.length = 0;
    await fetch(`${BASE}/proxy/proxy-sub/..%2f..%2fetc%2fpasswd`);
    check('编码过的穿越路径不会被解码，无法逃出上游根',
      seenPaths.length > 0 && /%2f/i.test(seenPaths[0]) && !/\//.test(seenPaths[0].replace(/^\//, '')),
      seenPaths.slice());

    const selfEntry = await addEntry('proxy-self', `${BASE}/`);
    const selfRes = await api('GET', '/proxy/proxy-self/');
    check('指向服务端自身的入口被拒绝（防代理环）',
      selfEntry.status === 201 && selfRes.status === 400 && /自身/.test(selfRes.json.error),
      { add: selfEntry.status, res: selfRes.status, err: selfRes.json });

    /* ---------- 12. WebSocket 转发 ---------- */
    const wsResult = await new Promise((resolve) => {
      const u = new URL(`${BASE}/proxy/proxy-root/ws`);
      const req = http.request({
        hostname: u.hostname, port: u.port, path: u.pathname,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13'
        }
      });
      const timer = setTimeout(() => resolve({ ok: false, reason: '超时' }), 4000);
      req.on('upgrade', (res, socket) => {
        socket.once('data', (d) => {
          clearTimeout(timer);
          socket.destroy();
          resolve({ ok: res.statusCode === 101, status: res.statusCode, echoed: d.toString() });
        });
        socket.write('ping-frame');
      });
      req.on('response', (res) => { clearTimeout(timer); resolve({ ok: false, reason: 'HTTP ' + res.statusCode }); });
      req.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.message }); });
      req.end();
    });
    check('WebSocket 升级转发并双向透传数据',
      wsResult.ok === true && wsResult.echoed === 'echo:ping-frame', wsResult);

    /* ---------- 13. 并发上限不误伤正常访问 ---------- */
    const many = await Promise.all(Array.from({ length: 8 }, () => fetch(`${BASE}/proxy/proxy-root/assets/app.js`)));
    check('并发访问 8 路均正常返回（未触发误限流）',
      many.every((r) => r.status === 200), many.map((r) => r.status));

    /* ---------- 15. 旧内核兼容转译（compatTranspile） ---------- */
    const compatEntry = await addEntry('proxy-compat', `${UP}/`, { compatTranspile: true });
    const badTarget = await addEntry('proxy-bad-target', `${UP}/`,
      { compatTranspile: true, compatTarget: 'chrome; rm -rf /' });
    check('合法目标建入口成功、非法转译目标被 400 拒绝',
      compatEntry.status === 201 && badTarget.status === 400 && /目标内核/.test(badTarget.json.error || ''),
      { ok: compatEntry.status, bad: badTarget.status, err: badTarget.json });

    const compatHtml = compatEntry.status === 201
      ? await (await fetch(`${BASE}/proxy/proxy-compat/`)).text()
      : '';
    check('开启兼容转译的入口：HTML 注入兼容垫片，且排在业务脚本之前',
      compatHtml.includes('__TV_COMPAT__') && compatHtml.includes('SP.replaceAll') &&
      compatHtml.indexOf('__TV_COMPAT__') < compatHtml.indexOf('/assets/app.js'),
      { injected: compatHtml.includes('__TV_COMPAT__') });
    check('未开启兼容转译的入口不注入垫片',
      !rootBody.includes('__TV_COMPAT__'), null);

    const compatJs = await fetch(`${BASE}/proxy/proxy-compat/es2022.js`);
    const compatJsText = await compatJs.text();
    check('转译生效：ES2022 产物降级后不含 ?? / ?. 与类字段，主体内容保留',
      compatJs.status === 200 && !compatJsText.includes('??') && !compatJsText.includes('?.') &&
      !/field\s*=/.test(compatJsText) && compatJsText.includes('constructor(){') &&
      compatJsText.includes('__probe'),
      { status: compatJs.status, body: compatJsText.slice(0, 300) });
    check('转译后的 JS 保持 JS 类型、长度准确、带 no-cache（防止旧缓存冻住转译前脚本）',
      /javascript/.test(compatJs.headers.get('content-type') || '') &&
      Number(compatJs.headers.get('content-length')) === Buffer.byteLength(compatJsText) &&
      compatJs.headers.get('cache-control') === 'no-cache',
      { ct: compatJs.headers.get('content-type'), cc: compatJs.headers.get('cache-control') });

    check('未开启兼容转译的入口：JS 响应原样透传（不降级、不改写内容）',
      (await (await fetch(`${BASE}/proxy/proxy-root/legacy.js`)).text()) ===
      'window.__legacy="keep me as is";\n', null);

    const before2 = await api('GET', '/api/admin/health');
    await fetch(`${BASE}/proxy/proxy-compat/es2022.js?cb=1`);
    await fetch(`${BASE}/proxy/proxy-compat/es2022.js?cb=2`);
    const after2 = await api('GET', '/api/admin/health');
    check('转译产物按内容缓存：相同内容重复请求命中缓存，不重复转译',
      before2.json.transpile.available === true &&
      after2.json.transpile.stats.hits > before2.json.transpile.stats.hits,
      { before: before2.json.transpile.stats, after: after2.json.transpile.stats });

    /* 垫片行为：先把 Node 自带的实现删掉，再执行页面里注入的那段源码 */
    const natives = {
      replaceAll: String.prototype.replaceAll,
      matchAll: String.prototype.matchAll,
      trimStart: String.prototype.trimStart,
      trimEnd: String.prototype.trimEnd,
      flat: Array.prototype.flat,
      flatMap: Array.prototype.flatMap,
      allSettled: Promise.allSettled
    };
    /* Chrome 67+ 才有的东西，一并删掉，验证垫片真的补齐（AI 页面靠 BigInt 才能完成初始化） */
    const natives64 = {
      BigInt: globalThis.BigInt,
      apAt: Array.prototype.at,
      spAt: String.prototype.at,
      findLast: Array.prototype.findLast,
      toSorted: Array.prototype.toSorted,
      fromEntries: Object.fromEntries,
      promiseAny: Promise.any,
      queueMicrotask: globalThis.queueMicrotask,
      setBigUint64: DataView.prototype.setBigUint64,
      getBigUint64: DataView.prototype.getBigUint64
    };
    let shimOk = false;
    let shimDetail = {};
    try {
      delete String.prototype.replaceAll;
      delete String.prototype.matchAll;
      delete String.prototype.trimStart;
      delete String.prototype.trimEnd;
      delete Array.prototype.flat;
      delete Array.prototype.flatMap;
      delete Promise.allSettled;
      delete globalThis.BigInt;
      delete Array.prototype.at;
      delete String.prototype.at;
      delete Array.prototype.findLast;
      delete Array.prototype.toSorted;
      delete Object.fromEntries;
      delete Promise.any;
      delete globalThis.queueMicrotask;
      delete DataView.prototype.setBigUint64;
      delete DataView.prototype.getBigUint64;
      const start = compatHtml.indexOf('<script>(function(){');
      const src = compatHtml.slice(compatHtml.indexOf('(function(){', start), compatHtml.indexOf('</script>', start));
      new Function(src)();
      const settled = await Promise.allSettled([Promise.resolve('v'), Promise.reject(new Error('e'))]);
      shimDetail = {
        replaceAll: 'a.b.c'.replaceAll('.', '-'),
        replaceAllMeta: 'a+b'.replaceAll('+', '-'),
        matchAll: [...'x1y2'.matchAll(/[a-z](\d)/g)].map((m) => m[1]).join(','),
        flatMap: JSON.stringify([1, 2].flatMap((v) => [v, v * 2])),
        flat: JSON.stringify([1, [2, [3]]].flat()),
        trim: '  x  '.trimStart().trimEnd(),
        settled: settled.map((r) => r.status).join(','),
        globalThis: typeof globalThis !== 'undefined',
        bigint: typeof BigInt === 'function' && BigInt.asUintN(64, 5) === 5 && BigInt.asIntN(64, -1) === -1,
        at: [1, 2, 3].at(-1) === 3 && 'abc'.at(-1) === 'c',
        findLast: (() => { const x = [{ n: 1 }, { n: 2 }].findLast((v) => v.n === 2); return x && x.n; })(),
        toSorted: JSON.stringify([3, 1, 2].toSorted()),
        fromEntries: JSON.stringify(Object.fromEntries([['a', 1]])),
        promiseAny: await Promise.any([Promise.reject(new Error('x')), Promise.resolve('ok')]),
        bigU64: (() => { const dv = new DataView(new ArrayBuffer(8)); dv.setBigUint64(0, 4294967297, true); return dv.getBigUint64(0, true); })(),
        queueMicrotask: typeof queueMicrotask === 'function'
      };
      shimOk = shimDetail.replaceAll === 'a-b-c' && shimDetail.replaceAllMeta === 'a-b' &&
        shimDetail.matchAll === '1,2' && shimDetail.flatMap === '[1,2,2,4]' &&
        shimDetail.flat === '[1,[2,[3]]]' && shimDetail.trim === 'x' &&
        shimDetail.settled === 'fulfilled,rejected' && shimDetail.globalThis === true &&
        shimDetail.bigint === true && shimDetail.at === true && shimDetail.findLast === 2 &&
        shimDetail.toSorted === '[1,2,3]' && shimDetail.fromEntries === '{"a":1}' &&
        shimDetail.promiseAny === 'ok' && shimDetail.bigU64 === 4294967297 &&
        shimDetail.queueMicrotask === true;
    } finally {
      Object.assign(String.prototype, { replaceAll: natives.replaceAll, matchAll: natives.matchAll, trimStart: natives.trimStart, trimEnd: natives.trimEnd });
      Object.assign(Array.prototype, { flat: natives.flat, flatMap: natives.flatMap });
      Promise.allSettled = natives.allSettled;
      if (natives64.BigInt) globalThis.BigInt = natives64.BigInt;
      Object.assign(Array.prototype, { at: natives64.apAt, findLast: natives64.findLast, toSorted: natives64.toSorted });
      Object.assign(String.prototype, { at: natives64.spAt });
      Object.assign(Object, { fromEntries: natives64.fromEntries });
      Promise.any = natives64.promiseAny;
      globalThis.queueMicrotask = natives64.queueMicrotask;
      Object.assign(DataView.prototype, { setBigUint64: natives64.setBigUint64, getBigUint64: natives64.getBigUint64 });
    }
    check('注入的兼容垫片补齐 replaceAll/flatMap/allSettled 及 BigInt/at/findLast/toSorted/fromEntries/Promise.any 等 Chrome 67+ API',
      shimOk, shimDetail);

    /* ---------- 14. 代理不改变服务端原有接口 ---------- */
    const health = await api('GET', '/api/admin/health');
    const config = await api('GET', '/api/config?full=1');
    check('接入代理后原有接口行为不变',
      health.status === 200 && health.json.ok === true &&
      config.status === 200 && Array.isArray(config.json.full.entries) &&
      config.json.full.entries.some((e) => e.id === 'proxy-root'),
      { health: health.status, config: config.status });

    /* ==================== 清理 ==================== */
    let cleaned = true;
    for (const id of created) {
      const r = await api('DELETE', `/api/admin/entries/${id}`);
      if (r.status !== 200) cleaned = false;
    }
    const after = await api('GET', '/api/admin/health');
    check('测试入口已清理（条目数回到 3）', cleaned && after.json.entries === 3, { entries: after.json.entries });
  } finally {
    upstream.close();
  }

  console.log('\n========================================');
  const failed = results.filter((r) => !r.pass).length;
  console.log(`合计：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})();