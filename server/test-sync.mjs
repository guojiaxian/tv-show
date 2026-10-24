#!/usr/bin/env node
/**
 * 客户端同步协议逻辑验证
 * ---------------------------------------------------------------------------
 * 本环境无法启动 Android 模拟器，因此用 Node **逐行复刻** 客户端
 * ConfigClient.merge / ConfigRepository.syncNow 的算法，对接真实服务端验证协议行为：
 *   首次全量、304、增量(meta/新增/修改/删除/排序)、版本回退降级、代次变化降级、
 *   服务端不可用保持本地内容。
 *
 * 复刻部分与 Kotlin 源码一一对应，详见 app/src/main/java/com/digitalcenter/tvshow/net/。
 */
const BASE = process.env.BASE;
if (!BASE) {
  console.error('本脚本会改写服务端数据，必须跑在隔离实例上：node server/test-run.mjs');
  process.exit(1);
}
const DEAD = 'http://127.0.0.1:1'; // 用于模拟服务端不可用

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) console.log('      ' + JSON.stringify(detail));
};

/* ============ 复刻 ConfigClient.fetch 的 HTTP 语义 ============ */

async function fetchOutcome(base, local, { attempts = 3 } = {}) {
  const since = local ? local.version : 0;
  const epoch = local ? local.epoch : 0;
  const etag = local && local.version > 0 ? `"${epoch}-${since}"` : null;

  let lastError = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const headers = { Accept: 'application/json' };
      if (etag) headers['If-None-Match'] = etag;
      const res = await fetch(`${base}/api/config?since=${since}&epoch=${epoch}`, { headers });
      if (res.status === 304) return { kind: 'NotModified', etag: res.headers.get('etag') };
      if (res.status !== 200) throw new Error('服务端返回 HTTP ' + res.status);
      const etagOut = res.headers.get('etag');
      const root = JSON.parse(await res.text());
      if (root.full) {
        return {
          kind: 'Full',
          etag: etagOut,
          config: {
            appTitle: root.full.appTitle,
            appSubtitle: root.full.appSubtitle,
            exitConfirm: root.full.exitConfirm,
            exitTip: root.full.exitTip,
            entries: root.full.entries,
            version: root.version,
            epoch: root.epoch
          }
        };
      }
      return {
        kind: 'Delta',
        etag: etagOut,
        version: root.version,
        epoch: root.epoch,
        meta: root.meta || null,
        upserted: root.upserted || [],
        deletedIds: root.deletedIds || [],
        order: root.order || null
      };
    } catch (e) {
      lastError = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastError;
}

/* ============ 复刻 ConfigClient.merge ============ */

function merge(current, outcome) {
  if (outcome.kind === 'NotModified') return current;
  if (outcome.kind === 'Full') return outcome.config;
  // Delta
  if (current == null) return null;
  if (outcome.epoch !== current.epoch) return null;      // 代次变化 → 必须全量
  if (outcome.version <= current.version) return null;   // 版本必须单调递增

  const merged = new Map();
  current.entries.forEach((e) => merged.set(e.id, e));
  outcome.deletedIds.forEach((id) => merged.delete(id));
  outcome.upserted.forEach((e) => merged.set(e.id, e));

  // 服务端下发了完整顺序 → 整体重排（Map 的 set 不会改变已有键的位置）
  let ordered;
  if (outcome.order) {
    ordered = [];
    outcome.order.forEach((id) => {
      if (merged.has(id)) { ordered.push(merged.get(id)); merged.delete(id); }
    });
    merged.forEach((v) => ordered.push(v)); // 兜底：未列出的追加在后面
  } else {
    ordered = Array.from(merged.values());
  }

  const meta = outcome.meta;
  return {
    appTitle: meta ? meta.appTitle : current.appTitle,
    appSubtitle: meta ? meta.appSubtitle : current.appSubtitle,
    exitConfirm: meta ? meta.exitConfirm : current.exitConfirm,
    exitTip: meta ? meta.exitTip : current.exitTip,
    entries: ordered,
    version: outcome.version,
    epoch: outcome.epoch
  };
}

/* ============ 复刻 ConfigRepository.syncNow 的编排 ============ */

async function syncNow(serverBaseUrl, local) {
  try {
    let outcome = await fetchOutcome(serverBaseUrl, local);
    let merged = merge(local, outcome);
    if (merged === null && outcome.kind !== 'NotModified') {
      outcome = await fetchOutcome(serverBaseUrl, null); // 传 null → 服务端返回全量
      merged = merge(null, outcome);
    }
    const changed = merged !== null && (
      !local || local.version !== merged.version ||
      JSON.stringify(local.entries) !== JSON.stringify(merged.entries) ||
      local.appTitle !== merged.appTitle
    );
    return { state: changed ? 'UPDATED' : 'UP_TO_DATE', config: merged ?? local, outcome: outcome.kind };
  } catch (e) {
    return { state: 'OFFLINE', config: local, error: e.message };
  }
}

/* ============ 服务端操作小工具 ============ */

const admin = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
};
const idsOf = (c) => c.entries.map((e) => e.id).join(',');

(async () => {
  /* ---------- 0. 复位到干净状态 ---------- */
  let cfg = (await admin('GET', '/api/admin/config')).json;
  for (const e of cfg.entries) {
    if (!['storage-monitor', 'env-monitor', 'security-cockpit'].includes(e.id)) {
      await admin('DELETE', '/api/admin/entries/' + e.id);
    }
  }
  await admin('PUT', '/api/admin/meta', { appTitle: '数智中心大屏聚合平台' });

  /* ---------- 1. 无本地缓存 → 全量 ---------- */
  let local = null;
  let r = await syncNow(BASE, local);
  check('首次同步（无本地缓存）拿到全量配置',
    r.state === 'UPDATED' && r.outcome === 'Full' && r.config.entries.length >= 3 &&
    r.config.version > 0,
    { state: r.state, outcome: r.outcome, v: r.config.version, n: r.config.entries.length });
  local = r.config;

  /* ---------- 2. 无变更 → 304，内容不变 ---------- */
  r = await syncNow(BASE, local);
  check('再次同步无变更时走 304 且状态为“已是最新”',
    r.state === 'UP_TO_DATE' && r.outcome === 'NotModified' &&
    JSON.stringify(r.config) === JSON.stringify(local),
    { state: r.state, outcome: r.outcome });
  local = r.config;

  /* ---------- 3. 服务端改标题 → 增量只带 meta ---------- */
  await admin('PUT', '/api/admin/meta', { appTitle: '标题已改（增量验证）' });
  r = await syncNow(BASE, local);
  const entriesUnchanged = idsOf(r.config) === idsOf(local) && r.config.entries.length === local.entries.length;
  check('改标题后增量同步生效且未重复下发条目',
    r.state === 'UPDATED' && r.outcome === 'Delta' &&
    r.config.appTitle === '标题已改（增量验证）' && entriesUnchanged &&
    r.config.version > local.version,
    { state: r.state, outcome: r.outcome, title: r.config.appTitle, v: r.config.version });
  local = r.config;

  /* ---------- 4. 新增页面 → 增量 upserted ---------- */
  await admin('POST', '/api/admin/entries', {
    id: 'sync-test-a', title: '增量测试A', url: 'http://10.0.0.1:1/', accent: '#8B7CFF', icon: 'env'
  });
  r = await syncNow(BASE, local);
  check('新增页面后本地条目数 +1 且新条目内容正确',
    r.config.entries.length === local.entries.length + 1 &&
    r.config.entries.some((e) => e.id === 'sync-test-a' && e.title === '增量测试A'),
    { before: local.entries.length, after: r.config.entries.length, ids: idsOf(r.config) });
  local = r.config;

  /* ---------- 5. 修改页面 → 增量 upserted 覆盖同 id ---------- */
  await admin('PUT', '/api/admin/entries/sync-test-a', {
    title: '增量测试A（改）', url: 'http://10.0.0.2:2/', accent: '#3FE0A6', icon: 'security'
  });
  r = await syncNow(BASE, local);
  const edited = r.config.entries.find((e) => e.id === 'sync-test-a');
  check('修改页面后本地同 id 条目被覆盖、总数不变',
    edited.title === '增量测试A（改）' && edited.url === 'http://10.0.0.2:2/' &&
    r.config.entries.length === local.entries.length,
    { edited, n: r.config.entries.length });
  local = r.config;

  /* ---------- 6. 删除页面 → 增量 deletedIds ---------- */
  await admin('DELETE', '/api/admin/entries/sync-test-a');
  r = await syncNow(BASE, local);
  check('删除页面后本地条目被移除',
    r.config.entries.length === local.entries.length - 1 &&
    !r.config.entries.some((e) => e.id === 'sync-test-a'),
    { before: local.entries.length, after: r.config.entries.length });
  local = r.config;

  /* ---------- 7. 排序 → 本地顺序跟随服务端 ---------- */
  const serverOrder = (await admin('GET', '/api/admin/config')).json.entries.map((e) => e.id);
  const reversed = serverOrder.slice().reverse();
  await admin('POST', '/api/admin/entries/reorder', { ids: reversed });
  r = await syncNow(BASE, local);
  check('排序后本地顺序与服务端一致',
    idsOf(r.config) === reversed.join(','),
    { local: idsOf(r.config), server: reversed.join(',') });
  local = r.config;

  /* ---------- 8. 版本回退（本地 version 高于服务端）→ 降级全量 ---------- */
  const staleAhead = { ...local, version: local.version + 100 };
  r = await syncNow(BASE, staleAhead);
  check('本地版本高于服务端时自动降级为全量（不产生错误状态）',
    r.outcome === 'Full' && r.config.version === local.version &&
    r.config.entries.length === local.entries.length,
    { outcome: r.outcome, serverV: local.version, gotV: r.config.version });

  /* ---------- 9. 代次变化 → 强制全量 ---------- */
  const beforeEpoch = (await admin('GET', '/api/admin/health')).json.epoch;
  await admin('POST', '/api/admin/epoch/bump');
  r = await syncNow(BASE, local);
  check('服务端 bump 代次后客户端重新拉取全量',
    r.outcome === 'Full' && r.config.epoch === beforeEpoch + 1 &&
    r.config.entries.length === local.entries.length,
    { outcome: r.outcome, epochBefore: beforeEpoch, epochAfter: r.config.epoch });
  local = r.config;

  /* ---------- 10. 服务端不可用 → 保留本地内容 ---------- */
  const cached = JSON.parse(JSON.stringify(local));
  r = await syncNow(DEAD, cached);
  check('服务端不可用时返回 OFFLINE 且本地内容完整保留',
    r.state === 'OFFLINE' && !!r.error &&
    JSON.stringify(r.config) === JSON.stringify(cached),
    { state: r.state, error: r.error, n: r.config.entries.length });

  /* ---------- 11. 恢复后继续正常同步 ---------- */
  r = await syncNow(BASE, cached);
  check('服务端恢复后同步正常（无变更 → 304）',
    r.state === 'UP_TO_DATE' && r.outcome === 'NotModified', { state: r.state, outcome: r.outcome });

  /* ---------- 12. 增量负载确实小于全量（避免全量传输） ---------- */
  const fullRes = await fetch(`${BASE}/api/config?full=1`);
  const fullText = await fullRes.text();
  await admin('PUT', '/api/admin/meta', { appSubtitle: '增量体积对比' });
  const deltaRes = await fetch(`${BASE}/api/config?since=${local.version}&epoch=${local.epoch}`);
  const deltaText = await deltaRes.text();
  check('单字段变更时增量响应显著小于全量响应',
    deltaText.length < fullText.length * 0.6,
    { fullBytes: fullText.length, deltaBytes: deltaText.length, ratio: +(deltaText.length / fullText.length).toFixed(2) });

  /* ---------- 13. 清理测试痕迹 ---------- */
  await admin('PUT', '/api/admin/meta', { appTitle: '数智中心大屏聚合平台', appSubtitle: 'DIGITAL CENTER · DISPLAY HUB' });
  const order = (await admin('GET', '/api/admin/config')).json.entries.map((e) => e.id);
  const normalized = ['storage-monitor', 'env-monitor', 'security-cockpit'].filter((id) => order.includes(id));
  await admin('POST', '/api/admin/entries/reorder', { ids: normalized });
  const final = (await admin('GET', '/api/admin/config')).json;
  check('测试数据已清理（仅保留初始 3 个入口，顺序已复位）',
    final.entries.length === 3 && final.entries.map((e) => e.id).join(',') === normalized.join(','),
    { entries: final.entries.map((e) => e.id) });

  console.log('\n========================================');
  const failed = results.filter((x) => !x.pass).length;
  console.log(`合计：${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
