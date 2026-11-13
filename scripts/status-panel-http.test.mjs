import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';
import { withMinimalDom } from './test-helpers/minimal-dom.mjs';

// 状态页接真实 HTTP 取数后的**三种语义**回归。
//
// 这三条是本任务的核心，它们的共同点是「数据层的空/无权限被人性化地画成图表」：
//   - 403 → 必须显示「无权限查看」，不是空图、不是「全部失败」
//   - points: [] → 必须显示「暂无采样数据」，**不补 0 桶**（补了会变成深灰「全挂」）
//   - 取数失败 → 必须保留旧快照
//
// 为什么必须用真实浏览器量：`createStatusPanelSection` 的产物要断言
// **渲染出的格子数**与 DOM 标记，纯 Node 侧只能断言数据结构，测不到「界面上到底画了什么」。
// 数据结构断言留在 panel-status-http.test.mjs，这里是渲染层。

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const statusPanelPath = resolve(scriptsDir, '..', 'src', 'projects', 'status-panel.ts');
const statusPanelHttpPath = resolve(scriptsDir, '..', 'src', 'projects', 'status-panel-http.ts');

async function loadModules() {
  const panel = await loadCompiledTypeScriptModule(statusPanelPath, ['status-panel.js', 'projects/status-panel.js']);
  const http = await loadCompiledTypeScriptModule(statusPanelHttpPath, ['status-panel-http.js', 'projects/status-panel-http.js']);
  return { panel, http };
}

const THEME = {
  surfaceStrong: '#ffffff', surface: '#fffafd',
  border: 'rgba(244,114,182,0.24)', borderStrong: 'rgba(219,39,119,0.34)',
  text: '#7a1039', muted: '#8a1a4d', subtle: '#7d2f52', primaryDeep: '#be185d',
  successFg: '#14663b', warningFg: '#7a4c00', dangerFg: '#a11818'
};

/** 摘要端点（`/adapter-service/service-status/summary`）的真实响应形状 —— 无 points。 */
function summaryResponse({ available = true, successRate = 0.98, retained = 120, totalRequests = 1200, failedRequests = 24, avgLatencyMs = 210, restartedAt = '2026-11-14T01:00:00+08:00' } = {}) {
  return {
    schemaVersion: 1,
    status: available ? 'healthy' : 'unknown',
    successRate,
    successRateAvailable: available,
    totalRequests,
    successRequests: totalRequests - failedRequests,
    failedRequests,
    avgLatencyMs,
    windowMinutes: 5,
    retained,
    capacity: 1440,
    restartedAt
  };
}

/** 后端 admin 端点响应（带 points），用于验证「有曲线时才画曲线」。 */
function backendResponse({ points, retained, restartedAt = '2026-11-14T01:00:00+08:00' }) {
  return {
    schemaVersion: 1,
    status: points.length > 0 ? 'healthy' : 'unknown',
    windowMinutes: 1440,
    points,
    summary: {
      status: points.length > 0 ? 'healthy' : 'unknown',
      successRate: points.length > 0 ? 0.98 : 0,
      avgLatencyMs: 210,
      totalRequests: points.length * 10,
      successRequests: points.length * 9,
      failedRequests: points.length,
      breakdown: { upstream: 1, timeout: 0, auth: 0, quota: 0 },
      windowMinutes: 5,
      pointsUsed: Math.min(5, points.length),
      startMinute: 0,
      endMinute: 0
    },
    capacity: 1440,
    retained,
    restartedAt
  };
}

/** 造 N 个逐分钟点，`minute` 是 Unix 秒 / 60。 */
function makePoints(count, nowMs, successRatio = 1) {
  const baseMinute = Math.floor(nowMs / 60000);
  return Array.from({ length: count }, (_, index) => {
    const total = 10;
    return {
      minute: baseMinute - (count - 1 - index),
      totalRequests: total,
      successRequests: Math.round(total * successRatio),
      failedRequests: total - Math.round(total * successRatio),
      upstreamFailures: 0, timeoutFailures: 0, authFailures: 0, quotaFailures: 0,
      avgLatencyMs: 200
    };
  });
}

// ---------------------------------------------------------------------------
// 判据③：points: [] → 不补 0 桶
// ---------------------------------------------------------------------------

test('判据③ 空 points 归一化成 kind=empty，且 buckets 是空数组（不是 288/1440 个 0）', async () => {
  const { panel } = await loadModules();

  const snapshot = panel.normalizeServiceStatusSnapshot(backendResponse({ points: [], retained: 0 }));

  assert.equal(snapshot.kind, 'empty', 'retained=0 必须落 empty');
  assert.equal(snapshot.retained, 0);
  assert.deepEqual(snapshot.buckets, [], '空快照的 buckets 必须是 []，补 0 会让整条色带变深灰');
  assert.deepEqual(snapshot.minuteSamples, []);
  assert.equal(snapshot.restartedAtMs, Date.parse('2026-11-14T01:00:00+08:00'), 'restartedAt 必须被 parse');

  // 关键交叉断言：即便拿这份空快照去建桶，格子里的 successRate 也必须是 null（无数据），
  // 且**没有任何一格是 0**（0 会被分档成「全部失败」暗红）。
  const buckets = panel.buildServiceStatusBuckets(snapshot.buckets, Date.parse('2026-11-14T01:30:00+08:00'));
  assert.equal(buckets.length, 288, 'buildServiceStatusBuckets 仍恒定产出 288 格');
  assert.equal(buckets.every((bucket) => bucket.successRate === null), true,
    '空数据下每格 successRate 必须为 null');
  assert.equal(buckets.some((bucket) => bucket.successRate === 0), false,
    '绝不能出现 successRate === 0（那会渲染成「全部失败」暗红）');
});

test('判据③ 渲染层：empty 不建任何格子，显示「暂无采样数据」', async () => {
  const { panel } = await loadModules();
  const snapshot = panel.normalizeServiceStatusSnapshot(backendResponse({ points: [], retained: 0 }));

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() });

    assert.equal(section.dataset.cxStatusKind, 'empty');
    assert.equal(section.querySelectorAll('[data-cx-status-cell]').length, 0,
      'empty 必须渲染 0 个格子，不是 288 也不是 1440');
    assert.equal(section.querySelectorAll('[data-cx-status-band]').length, 0, 'empty 不建色带');
    assert.equal(section.querySelectorAll('[data-cx-status-minutes]').length, 0, 'empty 不建逐分钟列表');
    assert.ok(section.querySelector('[data-cx-status-notice="empty"]'), '必须有 empty 说明卡片');
    assert.match(section.textContentAll, /暂无采样数据/);
    assert.match(section.textContentAll, /01:00/, '必须显示「自某时刻起」的时间');
  });
});

// ---------------------------------------------------------------------------
// 判据②：403 → 无权限查看
// ---------------------------------------------------------------------------

test('判据② 403 归一化成 kind=rejected，渲染「无权查看」且不画任何图表', async () => {
  const { panel, http } = await loadModules();

  const forbiddenError = Object.assign(new Error('service-status HTTP 403'), { status: 403 });
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    accessKey: 'tk-abc',
    requester: async () => { throw forbiddenError; }
  });
  const snapshot = await fetcher({ now: Date.now() });

  assert.equal(snapshot.kind, 'rejected', '403 必须落 rejected（带 key 但被拒）');
  assert.equal(snapshot.authProblem, 'forbidden', '403 的 authProblem 必须是 forbidden');

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() });
    assert.equal(section.dataset.cxStatusKind, 'rejected');
    assert.equal(section.querySelectorAll('[data-cx-status-cell]').length, 0, '403 不得渲染任何格子');
    assert.equal(section.querySelectorAll('[data-cx-status-band]').length, 0, '403 不得渲染色带');
    assert.ok(section.querySelector('[data-cx-status-notice="forbidden"]'));
    assert.match(section.textContentAll, /无权查看/);
    // 反向断言：403 不能被说成「异常」或「全部失败」，否则用户以为服务挂了。
    assert.equal(/全部失败/.test(section.textContentAll), false, '403 不得出现「全部失败」');
    assert.equal(section.querySelector('[data-cx-status-dot="异常"]'), null, '403 不得显示「异常」状态点');
  });
});

// ---------------------------------------------------------------------------
// 队长 (a)：服务端 message 必须透出来，不能被统一文案盖掉
// ---------------------------------------------------------------------------

test('★(a) 401 带服务端 message（脚本令牌）→ 界面必须出现这句话', async () => {
  const { panel, http } = await loadModules();

  const SCRIPT_TOKEN_MESSAGE = '脚本请求必须使用绑定身份码的运行会话';
  // 真实形态：服务端 401 + {"message": "..."}
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    accessKey: 'tk-script-bound',
    requester: async () => {
      throw Object.assign(new Error('service-status HTTP 401'), {
        status: 401,
        body: { message: SCRIPT_TOKEN_MESSAGE }
      });
    }
  });
  const snapshot = await fetcher({ now: Date.now() });

  assert.equal(snapshot.kind, 'rejected');
  assert.equal(snapshot.authProblem, 'unauthorized');
  assert.equal(snapshot.serverMessage, SCRIPT_TOKEN_MESSAGE, '服务端 message 必须被读出来');

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() });
    assert.equal(section.textContentAll.includes(SCRIPT_TOKEN_MESSAGE), true,
      '界面必须原样显示服务端 message，不能被「未配置访问令牌」之类的统一文案盖掉');
  });
});

test('★(a) 服务端没给 message 时才回退通用文案', async () => {
  // ⚠️ 这条用例守的是一个**只在异常路径才出现**的缺陷，值得单独记下来：
  //
  // 初版 `readServerMessage` 在服务端没给 message 时兜底读了 `error.message`，
  // 而那是**本地构造的调试措辞**（`service-status HTTP 403` / `HTTP 401`）。
  // 结果用户界面上直接出现了 "无权查看 … 无权查看 HTTP 403" —— 技术措辞泄漏到 UI。
  //
  // 为什么平时发现不了：正常路径（200 / 服务端给了 message）完全不经过这条兜底，
  // 只有「4xx 且 body 里没有 message」时才露出来。当时是这条用例把它抓出来的。
  //
  // 修法：`readServerMessage` **只认** `error.serverMessage` 与 `error.body.message`，
  // 彻底不读 `error.message`。`error.message` 是给开发者调试用的，不是用户文案。
  // 保留这条断言（下面最后一行）是为了防止将来有人「顺手加个兜底」把它加回来。
  const { panel, http } = await loadModules();

  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    accessKey: 'tk-abc',
    requester: async () => { throw Object.assign(new Error('service-status HTTP 401'), { status: 401 }); }
  });
  const snapshot = await fetcher({ now: Date.now() });
  assert.equal(snapshot.serverMessage, '', '没 message 时必须是空串');

  await withMinimalDom(() => {
    const text = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() }).textContentAll;
    assert.match(text, /令牌/, '必须给一个能指导用户下一步的通用文案');
    assert.equal(/undefined|\[object Object\]/.test(text), false, '不得把空值渲染成 undefined');
    // 核心防线：界面不得出现 HTTP 状态码这类技术措辞（见上方注释）。
    assert.equal(/HTTP \d{3}/.test(text), false,
      '界面不得出现 "HTTP 401/403" 这类调试措辞 —— error.message 不是用户文案');
  });
});

// ---------------------------------------------------------------------------
// 队长 (b)：no-token 与 rejected 必须分开
// ---------------------------------------------------------------------------

test('★(b) 没配 key → kind=no-token，且**不发请求**', async () => {
  const { panel, http } = await loadModules();

  let requested = false;
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    accessKey: '',
    requester: async () => { requested = true; return summaryResponse(); }
  });
  const snapshot = await fetcher({ now: Date.now() });

  assert.equal(snapshot.kind, 'no-token', '没配 key 必须是 no-token，不是 rejected');
  assert.equal(requested, false, '没配 key 时压根不该发请求（前端已知结果）');

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() });
    assert.equal(section.dataset.cxStatusKind, 'no-token');
    assert.ok(section.querySelector('[data-cx-status-notice="no-token"]'));
    assert.match(section.textContentAll, /未配置访问令牌/);
    assert.match(section.textContentAll, /题库配置/, '必须指向具体去哪填');
  });
});

test('★(b) no-token 与 rejected 的 kind、标记、文案三者都不同', async () => {
  const { panel, http } = await loadModules();

  const noToken = await http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    accessKey: '',
    requester: async () => summaryResponse()
  })({ now: Date.now() });

  const rejected = await http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    accessKey: 'tk-bad',
    requester: async () => { throw Object.assign(new Error('HTTP 401'), { status: 401 }); }
  })({ now: Date.now() });

  assert.notEqual(noToken.kind, rejected.kind, 'kind 必须不同');

  await withMinimalDom(() => {
    const a = panel.createStatusPanelSection({ theme: THEME, snapshot: noToken, now: Date.now() });
    const b = panel.createStatusPanelSection({ theme: THEME, snapshot: rejected, now: Date.now() });
    assert.notEqual(a.dataset.cxStatusKind, b.dataset.cxStatusKind);
    assert.notEqual(a.textContentAll, b.textContentAll, '文案必须不同，否则用户无从判断该做什么');

    // no-token 必须引导去填；rejected 不能说「未配置」（用户明明配了）。
    assert.match(a.textContentAll, /未配置/);
    assert.equal(/未配置/.test(b.textContentAll), false,
      'rejected 不得说「未配置」—— 用户明明填了，是填了不被接受');
  });
});

test('判据②+ 401 与 403 分开：401「令牌未通过验证」，403「无权查看」', async () => {
  const { panel, http } = await loadModules();

  const make = (status) => http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    accessKey: 'tk-x',
    requester: async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); }
  });

  const unauthorized = await make(401)({ now: Date.now() });
  const forbidden = await make(403)({ now: Date.now() });

  assert.equal(unauthorized.kind, 'rejected');
  assert.equal(unauthorized.authProblem, 'unauthorized', '401 必须标成 unauthorized');
  assert.equal(forbidden.authProblem, 'forbidden', '403 必须标成 forbidden');

  await withMinimalDom(() => {
    const unauthorizedText = panel.createStatusPanelSection({ theme: THEME, snapshot: unauthorized, now: Date.now() }).textContentAll;
    const forbiddenText = panel.createStatusPanelSection({ theme: THEME, snapshot: forbidden, now: Date.now() }).textContentAll;

    assert.match(unauthorizedText, /令牌/, '401 必须围绕令牌说事');
    assert.equal(/联系管理员/.test(unauthorizedText), false, '401 不该让用户去找管理员');

    assert.match(forbiddenText, /无权查看/, '403 必须说无权');
    assert.match(forbiddenText, /联系管理员|权限/, '403 必须指向权限问题');

    // 两者文案必须真的不同，不能是同一句。
    assert.notEqual(unauthorizedText, forbiddenText, '401 与 403 的界面文案必须可区分');
  });
});

test('判据② 403 分支不能靠 status 数字以外的信号误判：网络错误要走「保留旧快照」而非 forbidden', async () => {
  const { http } = await loadModules();

  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/admin/service-status',
    requester: async () => { throw new Error('network down'); }
  });
  const snapshot = await fetcher({ now: Date.now() });
  assert.equal(snapshot, null, '非 403 的失败必须返回 null（交给 refresh 保留旧快照），不能冒充 forbidden');
});

// ---------------------------------------------------------------------------
// 判据④：失败保留旧快照
// ---------------------------------------------------------------------------

test('判据④ 取数失败保留旧快照；下一次成功能回到正常', async () => {
  const { panel, http } = await loadModules();

  const nowMs = Date.parse('2026-11-14T01:30:00+08:00');
  panel.setCachedServiceStatusSnapshot(null);

  // 第一次：成功，得到正常快照。
  panel.setServiceStatusFetcher(http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/admin/service-status',
    requester: async () => backendResponse({ points: makePoints(120, nowMs), retained: 120 })
  }));
  const good = await panel.refreshServiceStatusSnapshot({ now: nowMs });
  assert.equal(good.kind, 'ok');
  assert.equal(good.buckets.length > 0, true);
  const goodBucketCount = good.buckets.length;

  // 第二次：失败 → 必须保留上一份，不清空。
  panel.setServiceStatusFetcher(async () => { throw new Error('upstream 502'); });
  const afterFailure = await panel.refreshServiceStatusSnapshot({ now: nowMs + 1000 });
  assert.notEqual(afterFailure, null, '失败后不得清空快照');
  assert.equal(afterFailure.kind, 'ok');
  assert.equal(afterFailure.buckets.length, goodBucketCount, '失败后必须保留上一份的 buckets');
  assert.equal(panel.readCachedServiceStatusSnapshot().kind, 'ok', '缓存必须仍是正常快照');

  // 第三次：又成功 → 回到正常（证明不是「一旦失败就永久卡住」）。
  // 注意 fetcher 的契约是返回**已归一化**的 snapshot，不是原始 HTTP body；
  // 所以这里必须走 createServiceStatusHttpFetcher，不能直接返回 backendResponse。
  panel.setServiceStatusFetcher(http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/admin/service-status',
    requester: async () => backendResponse({ points: makePoints(60, nowMs), retained: 60 })
  }));
  const recovered = await panel.refreshServiceStatusSnapshot({ now: nowMs + 2000 });
  assert.equal(recovered.kind, 'ok');
  assert.equal(recovered.retained, 60, '恢复后应反映新数据');
});

// ---------------------------------------------------------------------------
// 判据⑤：正常数据 → 288 格（既有 11 档配色不回归）
// ---------------------------------------------------------------------------

test('判据⑤ 正常 1440 点 → 288 格，且分档仍走 11 档配色', async () => {
  const { panel, http } = await loadModules();

  const nowMs = Date.parse('2026-11-14T01:30:00+08:00');
  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/admin/service-status',
    requester: async () => backendResponse({ points: makePoints(1440, nowMs), retained: 1440 })
  });
  const snapshot = await fetcher({ now: nowMs });

  assert.equal(snapshot.kind, 'ok');
  assert.equal(snapshot.retained, 1440, 'retained 是语义字段，必须原样带上');

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: nowMs });
    const cells = section.querySelectorAll('[data-cx-status-cell]');
    assert.equal(cells.length, 288, `正常数据必须渲染 288 格，实际 ${cells.length}`);

    // 每一格的 tier 必须是 11 档 + none 里的一个（既有配色不回归）。
    const allowed = new Set([
      't100', 't99', 't97', 't95', 't90', 't80', 't70', 't50', 't30', 't10', 't0', 'none'
    ]);
    for (const cell of cells) {
      assert.equal(allowed.has(cell.dataset.cxStatusTier), true,
        `未知档位 ${cell.dataset.cxStatusTier}（11 档配色被破坏）`);
    }
    // 数据全是「全成功」→ 覆盖到样本的格子必须落在绿色系的档位（t100/t99/t97）。
    // 这条同时证明「tier 是真算出来的」而不是统一写死某个值。
    const greenTiers = new Set(['t100', 't99', 't97']);
    const dataCells = cells.filter((cell) => cell.dataset.cxStatusTier !== 'none');
    assert.equal(dataCells.length > 0, true, '1440 点必须覆盖到格子');
    for (const cell of dataCells) {
      assert.equal(greenTiers.has(cell.dataset.cxStatusTier), true,
        `全成功数据应落绿色系档位，实际 ${cell.dataset.cxStatusTier}`);
    }
    // 反向：不能出现任何「全部失败」暗红格（那说明 0 被当成了有数据）。
    assert.equal(cells.filter((cell) => cell.dataset.cxStatusTier === 't0').length, 0,
      '全成功数据下不得出现 t0（全失败）');
  });
});

test('判据⑤ 分钟内聚合按 minute 字段换算（后端 minute 是 Unix 秒/60）', async () => {
  const { panel } = await loadModules();

  // 一个明确的时间点：2026-11-14 01:00:00 +08:00 = Unix 秒 …，minute = 秒/60
  const epochMs = Date.parse('2026-11-14T01:00:00+08:00');
  const minute = Math.floor(epochMs / 60000);
  assert.equal(minute * 60000, epochMs, '前提：该时刻正好是整分钟');

  const snapshot = panel.normalizeServiceStatusSnapshot(backendResponse({
    points: [{ minute, totalRequests: 10, successRequests: 10, failedRequests: 0,
      upstreamFailures: 0, timeoutFailures: 0, authFailures: 0, quotaFailures: 0, avgLatencyMs: 100 }],
    retained: 1
  }));

  assert.equal(snapshot.buckets.length, 1);
  assert.equal(snapshot.buckets[0].startMs, epochMs, 'minute × 60000 必须还原成原始毫秒时间');
  assert.equal(snapshot.buckets[0].requests, 10);
  assert.equal(snapshot.buckets[0].succeeded, 10);
});

test('normalizeServiceStatusSnapshot 用 retained 判空，不只靠 points.length', async () => {
  const { panel } = await loadModules();

  // retained 明确说 0 —— 即使 points 里被塞了脏数据也不该当成有数据。
  const zeroRetained = panel.normalizeServiceStatusSnapshot({
    ...backendResponse({ points: makePoints(3, Date.now()), retained: 0 })
  });
  assert.equal(zeroRetained.kind, 'empty', 'retained=0 优先于 points.length');

  // 反向：retained > 0 且有 points → ok。
  const withData = panel.normalizeServiceStatusSnapshot(
    backendResponse({ points: makePoints(3, Date.now()), retained: 3 })
  );
  assert.equal(withData.kind, 'ok');
  assert.equal(withData.retained, 3);
});

test('fetcher 在 baseurl 为空时静默返回 null（未配置题库地址不是错误）', async () => {
  const { http } = await loadModules();
  let called = false;
  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: '',
    endpoint: '/adapter-service/admin/service-status',
    requester: async () => { called = true; return {}; }
  });
  assert.equal(await fetcher({ now: Date.now() }), null);
  assert.equal(called, false, '没 baseurl 时不应发请求');
});

test('fetcher 把 endpoint 拼成绝对 URL，且不依赖默认常量', async () => {
  const { http } = await loadModules();
  const seen = [];
  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com/',
    endpoint: '/adapter-service/service-status/summary',
    requester: async (url) => { seen.push(url); return summaryResponse({ retained: 0, available: false }); }
  });
  await fetcher({ now: Date.now() });
  assert.deepEqual(seen, ['https://tiku.example.com/adapter-service/service-status/summary'],
    'baseurl 尾部斜杠要被吃掉，endpoint 前导斜杠保留');
});

// ---------------------------------------------------------------------------
// successRateAvailable：区分「全失败」与「没请求」（服务端权威字段）
// ---------------------------------------------------------------------------

test('★ successRateAvailable=false（没请求）→ kind=empty；不画格子', async () => {
  const { panel, http } = await loadModules();

  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    requester: async () => summaryResponse({ available: false, successRate: 0, retained: 0, totalRequests: 0, failedRequests: 0 })
  });
  const snapshot = await fetcher({ now: Date.now() });

  assert.equal(snapshot.kind, 'empty', 'available=false 必须落 empty（窗口内无请求）');
  assert.equal(snapshot.successRateAvailable, false);

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() });
    assert.equal(section.querySelectorAll('[data-cx-status-cell]').length, 0);
    assert.match(section.textContentAll, /暂无采样数据/);
  });
});

test('★ successRateAvailable=true 且 successRate=0（全失败）→ kind=ok，绝不落 empty', async () => {
  const { panel, http } = await loadModules();

  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    // 100 请求 0 成功 —— 这是「全失败」，必须报警感，不能当成「没数据」。
    requester: async () => summaryResponse({ available: true, successRate: 0, retained: 5, totalRequests: 100, failedRequests: 100 })
  });
  const snapshot = await fetcher({ now: Date.now() });

  assert.equal(snapshot.kind, 'ok', 'available=true 时即使 successRate=0 也必须是 ok（全失败要看得见）');
  assert.equal(snapshot.successRateAvailable, true);
  assert.equal(snapshot.successRate, 0, 'successRate 必须保留 0，不能被降级成 null/无数据');
  assert.equal(snapshot.failedRequests, 100);

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() });
    // 摘要卡片必须显示 0%（不是「窗口内无请求」）。
    assert.match(section.textContentAll, /0%/);
    assert.equal(/窗口内无请求/.test(section.textContentAll), false,
      '全失败不能被说成「窗口内无请求」');
    assert.match(section.textContentAll, /100/, '失败数必须显示出来');
  });
});

test('★ 两个语义在界面上必须可区分（全失败 vs 没请求，文案与 kind 都不同）', async () => {
  const { panel } = await loadModules();
  const nowMs = Date.now();

  const allFailed = panel.normalizeServiceStatusSnapshot(summaryResponse({
    available: true, successRate: 0, retained: 5, totalRequests: 100, failedRequests: 100
  }));
  const noTraffic = panel.normalizeServiceStatusSnapshot(summaryResponse({
    available: false, successRate: 0, retained: 0, totalRequests: 0, failedRequests: 0
  }));

  assert.equal(allFailed.kind, 'ok');
  assert.equal(noTraffic.kind, 'empty');
  assert.notEqual(allFailed.kind, noTraffic.kind, '两者 kind 必须不同');

  await withMinimalDom(() => {
    const a = panel.createStatusPanelSection({ theme: THEME, snapshot: allFailed, now: nowMs }).textContentAll;
    const b = panel.createStatusPanelSection({ theme: THEME, snapshot: noTraffic, now: nowMs }).textContentAll;
    assert.notEqual(a, b, '全失败与没请求的界面文案必须不同，否则用户无法分辨');
  });
});

// ---------------------------------------------------------------------------
// summary 端点无 points → 摘要模式，不画曲线
// ---------------------------------------------------------------------------

test('★ summary 端点（无 points）→ 摘要模式：不渲染 288 格，改渲染聚合指标', async () => {
  const { panel, http } = await loadModules();

  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    requester: async () => summaryResponse({ available: true, successRate: 0.98, retained: 120, totalRequests: 1200, failedRequests: 24, avgLatencyMs: 210 })
  });
  const snapshot = await fetcher({ now: Date.now() });
  assert.equal(snapshot.kind, 'ok');
  assert.deepEqual(snapshot.buckets, [], 'summary 端点没有 points，buckets 必须为空');

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() });
    assert.equal(section.dataset.cxStatusMode, 'summary', '无 points 时必须标明 summary 模式');
    assert.equal(section.querySelectorAll('[data-cx-status-cell]').length, 0,
      'summary 模式不得渲染任何色带格子（不能伪造曲线）');
    assert.equal(section.querySelectorAll('[data-cx-status-band]').length, 0);

    // 聚合指标必须真的渲染出来，且带口径说明（窗口内，不是累计）。
    const metrics = section.querySelectorAll('[data-cx-status-metric]');
    assert.ok(metrics.length >= 4, `摘要模式必须渲染聚合指标，实际 ${metrics.length} 项`);
    assert.match(section.textContentAll, /成功率/);
    assert.match(section.textContentAll, /98\.0%/);
    assert.match(section.textContentAll, /210ms/);
    assert.match(section.textContentAll, /1200/);
    assert.match(section.textContentAll, /最近 5 分钟窗口/, '必须说明这是窗口内数字');
    assert.match(section.textContentAll, /摘要视图/, '必须让用户知道这是摘要，不是曲线');
  });
});

test('★ admin 端点（带 points）→ detail 模式，仍渲染 288 格（既有配色不回归）', async () => {
  const { panel } = await loadModules();
  const nowMs = Date.parse('2026-11-14T01:30:00+08:00');
  const snapshot = panel.normalizeServiceStatusSnapshot(
    backendResponse({ points: makePoints(1440, nowMs), retained: 1440 })
  );
  assert.equal(snapshot.kind, 'ok');

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: nowMs });
    assert.equal(section.dataset.cxStatusMode, 'detail', '有 points 时必须标明 detail 模式');
    assert.equal(section.querySelectorAll('[data-cx-status-cell]').length, 288);
  });
});

test('fetcher 带 Authorization: Bearer <key>（AuthOrAccessToken 需要它才走 access-token 分支）', async () => {
  const { http } = await loadModules();
  const seen = [];
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    accessKey: 'tk-abc123',
    requester: async (url, init) => { seen.push({ url, init }); return summaryResponse(); }
  });
  await fetcher({ now: Date.now() });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.headers.Authorization, 'Bearer tk-abc123',
    '必须带 Bearer，否则 AuthOrAccessToken 会回退到登录 JWT 分支 → 401');
});

test('fetcher 在没配 key 时不发请求（所以也不会伪造空 Bearer）', async () => {
  const { http } = await loadModules();
  const seen = [];
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    accessKey: '',
    requester: async (url, init) => { seen.push({ url, init }); return summaryResponse(); }
  });
  const snapshot = await fetcher({ now: Date.now() });
  assert.equal(seen.length, 0, '没 key 时压根不发请求（前端已知 no-token）');
  assert.equal(snapshot.kind, 'no-token');
});

// ---------------------------------------------------------------------------
// 死分支守卫：kind='forbidden' 当前无产出点
// ---------------------------------------------------------------------------

test('死分支守卫：`kind=forbidden` 无产出点，两种 4xx 实际都落 rejected', async () => {
  // 这条用例的价值不是「测试功能」，而是**防止有人误以为 forbidden 已被覆盖**。
  //
  // 背景（captain 2026-11-14 起真实 TIKU 实例实测）：
  //   GET /adapter-service/admin/service-status + **有效普通 token** → **401**，不是 403。
  // 原因是 router.go 上挂了 `controller.Auth`，它用 `ParseJwtWithClaims` 验 JWT；
  // access token 不是 JWT，所以在 `RequireAdmin` 之前就被 401 拦掉。
  // ⇒ 这个服务里 403 在这条链路上根本到不了（`RequireAdmin` 的 403 只对
  //   「合法 JWT 但 role != admin」生效，而 PLUS 没有登录态）。
  //
  // 所以 `kind='forbidden'` 是**留给将来管理员视图的空位**，它有任何行为变化
  // 都说明有人加了新的产出点 —— 那时应该同时补真正的用例，而不是靠这条守卫。
  const { panel, http } = await loadModules();

  const make = (status) => http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/adapter-service/service-status/summary',
    accessKey: 'tk-test',
    requester: async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); }
  });

  for (const status of [401, 403]) {
    const snapshot = await make(status)({ now: Date.now() });
    assert.equal(snapshot.kind, 'rejected',
      `${status} 必须落 rejected —— 'forbidden' 当前无产出点，若这里变成 forbidden 说明新增了产出点，请补真用例`);
  }

  // 正向确认：**代码里**确实没有 `kind: 'forbidden'` 的产出点（只有消费点）。
  //
  // ⚠️ 必须先剥掉注释再匹配：这个文件的注释里就写着「检索 `kind: 'forbidden'` 零命中」，
  // 直接全文匹配会把解释性文字当成产出点（初版就是这么误报的）。
  const { readFile } = await import('node:fs/promises');
  const { resolve: resolvePath, dirname: dirnamePath } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = dirnamePath(fileURLToPath(import.meta.url));

  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/^\s*\/\/.*$/gm, '');      // 行注释

  for (const file of ['status-panel.ts', 'status-panel-http.ts']) {
    const source = stripComments(await readFile(resolvePath(dir, '..', 'src', 'projects', file), 'utf8'));
    const producers = source.match(/kind:\s*'forbidden'/g) ?? [];
    assert.equal(producers.length, 0,
      `${file} 的代码里出现了 kind:'forbidden' 的产出点。若这是有意新增的，请同时补该分支的行为用例，并删掉这条守卫`);
  }
});