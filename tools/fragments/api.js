/**
 * 共享 JSON 请求助手（构建期注入，见 tools/build-pages.mjs）。
 *
 * 管理后台与远程控制台都以「同源相对路径 + JSON」方式调用服务端，
 * 差异仅在错误文案；这里统一实现，页面侧保留一个三行适配器即可。
 */
async function apiJson(method, path, body, opts) {
  opts = opts || {};
  var res;
  try {
    res = await fetch(path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error((opts.connectPrefix || '') + e.message);
  }
  var text = await res.text();
  var json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 响应 */ }
  if (!res.ok) {
    var fallback = opts.httpError ? opts.httpError(res.status) : ('HTTP ' + res.status);
    throw new Error((json && json.error) || fallback);
  }
  return json;
}
