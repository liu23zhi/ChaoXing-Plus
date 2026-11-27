import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from '@typescript/typescript6';
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

/** 摘要端点（`/api/service-status/summary`）的真实响应形状 —— 无 points。 */
function summaryResponse({ available = true, successRate = 0.98, retained = 120, totalRequests = 1200, failedRequests = 24, avgLatencyMs = 210, restartedAt = '2026-11-14T01:00:00+08:00', searchTotalRequests = 100, searchSuccessRequests = 98, searchAvgLatencyMs = 210, searchSamples = 5 } = {}) {
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
    restartedAt,
    endpoints: {
      search: {
        totalRequests: searchTotalRequests,
        successRequests: searchSuccessRequests,
        avgLatencyMs: searchAvgLatencyMs,
        samples: searchSamples
      },
      other: { totalRequests: 1100, successRequests: 1098, avgLatencyMs: 120, samples: 5 }
    }
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

test('判据③ 渲染层：无搜题分桶时显示暂无搜题状态，不拿全站状态顶替', async () => {
  const { panel } = await loadModules();
  const snapshot = panel.normalizeServiceStatusSnapshot(backendResponse({ points: [], retained: 0 }));

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() });

    assert.equal(section.dataset.cxStatusKind, 'empty');
    assert.equal(section.querySelectorAll('[data-cx-status-cell]').length, 0,
      'empty 必须渲染 0 个格子，不是 288 也不是 1440');
    assert.equal(section.querySelectorAll('[data-cx-status-band]').length, 0, '没有搜题摘要时不伪造色带');
    assert.equal(section.querySelectorAll('[data-cx-status-minutes]').length, 0, 'empty 不建逐分钟列表');
    assert.equal(section.dataset.cxStatusMode, 'search');
    assert.match(section.textContentAll, /搜题接口/);
    assert.match(section.textContentAll, /未提供搜题接口统计/);
    assert.doesNotMatch(section.textContentAll, /服务自 .*起开始采样/);
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
    endpoint: '/api/service-status/summary',
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
    endpoint: '/api/service-status/summary',
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
    endpoint: '/api/service-status/summary',
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
    endpoint: '/api/service-status/summary',
    accessKey: '',
    requester: async () => { requested = true; return summaryResponse(); }
  });
  const snapshot = await fetcher({ now: Date.now() });

  assert.equal(snapshot.kind, 'no-token', '没配 key 必须是 no-token，不是 rejected');
  assert.equal(requested, false, '没配 key 时压根不该发请求（前端已知结果）');

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() });
    assert.equal(section.dataset.cxStatusKind, 'no-token');
    assert.ok(section.querySelector('[data-cx-status-dot="未配置访问令牌"]'));
    assert.match(section.textContentAll, /未配置访问令牌/);
    assert.match(section.textContentAll, /题库配置/, '必须指向具体去哪填');
  });
});

test('★(b) no-token 与 rejected 的 kind、标记、文案三者都不同', async () => {
  const { panel, http } = await loadModules();

  const noToken = await http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/api/service-status/summary',
    accessKey: '',
    requester: async () => summaryResponse()
  })({ now: Date.now() });

  const rejected = await http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/api/service-status/summary',
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
    endpoint: '/api/service-status/summary',
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
    endpoint: '/api/admin/service-status',
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
    endpoint: '/api/admin/service-status',
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
    endpoint: '/api/admin/service-status',
    requester: async () => backendResponse({ points: makePoints(60, nowMs), retained: 60 })
  }));
  const recovered = await panel.refreshServiceStatusSnapshot({ now: nowMs + 2000 });
  assert.equal(recovered.kind, 'ok');
  assert.equal(recovered.retained, 60, '恢复后应反映新数据');
});

// ---------------------------------------------------------------------------
// 判据⑤：正常数据 → 288 格（既有 11 档配色不回归）
// ---------------------------------------------------------------------------

test('普通状态页面不展示管理员逐分钟曲线或全站请求数据', async () => {
  const { panel, http } = await loadModules();

  const nowMs = Date.parse('2026-11-14T01:30:00+08:00');
  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com',
    endpoint: '/api/admin/service-status',
    requester: async () => backendResponse({ points: makePoints(1440, nowMs), retained: 1440 })
  });
  const snapshot = await fetcher({ now: nowMs });

  assert.equal(snapshot.kind, 'ok');
  assert.equal(snapshot.retained, 1440, 'retained 是语义字段，必须原样带上');

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: nowMs });
    assert.equal(section.dataset.cxStatusMode, 'search');
    assert.equal(section.querySelectorAll('[data-cx-status-cell]').length, 0);
    assert.equal(section.querySelectorAll('[data-cx-status-band]').length, 0, '管理员响应缺搜题摘要时不伪造色带');
    assert.match(section.textContentAll, /未提供搜题接口统计/);
    assert.doesNotMatch(section.textContentAll, /1440|最近每分钟|24 小时预览/);
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
    endpoint: '/api/admin/service-status',
    requester: async () => { called = true; return {}; }
  });
  assert.equal(await fetcher({ now: Date.now() }), null);
  assert.equal(called, false, '没 baseurl 时不应发请求');
});

test('搜题历史取自独立searchPoints，当前窗口无请求仍保留24小时历史', async () => {
  const { panel, http } = await loadModules();
  const now = Date.parse('2026-11-20T13:17:00+08:00');
  const searchPoints = [{ minute: Math.floor((now - 3600000) / 60000), totalRequests: 10, successRequests: 7 }];
  const seen = [];
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com', accessKey: 'tk-test', includeSearchHistory: true,
    requester: async (url, init) => {
      seen.push({ url, init });
      return url.endsWith('/series') ? { searchPoints, points: [{ minute: searchPoints[0].minute, totalRequests: 999, successRequests: 999 }] }
        : summaryResponse({ available: false, searchTotalRequests: 0, searchSuccessRequests: 0 });
    }
  });
  const snapshot = await fetcher({ now });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(item => item.url).sort(), ['https://tiku.example.com/api/service-status/series', 'https://tiku.example.com/api/service-status/summary']);
  assert.ok(seen.every(item => item.init.headers.Authorization === 'Bearer tk-test'));
  assert.equal(snapshot.search.totalRequests, 0);
  assert.equal(snapshot.searchHistory[0].requests, 10);
  assert.equal(snapshot.searchHistory[0].succeeded, 7);
  const totals = panel.buildServiceStatusBuckets(snapshot.searchHistory, now + panel.STATUS_BUCKET_MS).reduce((n, bucket) => n + bucket.requests, 0);
  assert.equal(totals, 10, '全站999次请求不得进入搜题色带');
});

test('搜题历史失败或旧接口缺字段时不伪造；摘要和历史网络失败独立处理', async () => {
  const { http } = await loadModules();
  const now = Date.now();
  for (const series of [null, { points: [{ minute: Math.floor(now / 60000), totalRequests: 999, successRequests: 0 }] }]) {
    const fetcher = http.createServiceStatusHttpFetcher({
      baseurl: 'https://tiku.example.com', accessKey: 'tk-test', includeSearchHistory: true,
      requester: async url => {
        if (url.endsWith('/series')) {
          if (series === null) throw new Error('series offline');
          return series;
        }
        return summaryResponse();
      }
    });
    const snapshot = await fetcher({ now });
    assert.equal(snapshot.search.totalRequests > 0, true);
    assert.equal(snapshot.searchHistory, null);
  }
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com', accessKey: 'tk-test', includeSearchHistory: true,
    requester: async url => {
      if (url.endsWith('/summary')) throw new Error('summary offline');
      return { searchPoints: [{ minute: Math.floor(now / 60000), totalRequests: 5, successRequests: 5 }] };
    }
  });
  const snapshot = await fetcher({ now });
  assert.equal(snapshot.search, null);
  assert.equal(snapshot.searchHistory[0].requests, 5);
});

test('搜题24小时色带为单行288格，当前5分钟立即显色，无请求与不可用均用灰色但有不同说明', async () => {
  const { panel } = await loadModules();
  const now = Date.parse('2026-11-20T13:17:00+08:00');
  const minute = Math.floor(now / 60000);
  const history = [
    { minute: minute - 1, totalRequests: 2, successRequests: 2 },
    { minute: minute - 2, totalRequests: 8, successRequests: 0 },
    { minute: minute - 6, totalRequests: 3, successRequests: 0 },
    { minute: minute - 11, totalRequests: 4, successRequests: 4 },
    { minute: minute - 1441, totalRequests: 999, successRequests: 999 }
  ];
  await withMinimalDom(async () => {
    const snapshot = panel.normalizeServiceStatusSnapshot({ ...summaryResponse({ searchTotalRequests: 0 }), searchPoints: history });
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now, onRequestRefresh() {} });
    const band = section.querySelector('[data-cx-status-band]');
    assert.ok(band);
    assert.equal(band.style.flexWrap, 'nowrap');
    const cells = band.querySelectorAll('[data-cx-status-bucket]');
    assert.equal(cells.length, 288);
    assert.equal(cells.at(-1).style.background, panel.resolveServiceStatusTier(0.2).color, '当前部分窗口按成功总数/请求总数加权');
    assert.equal(cells.at(-2).style.background, '#7f1d1d');
    assert.equal(cells.at(-3).style.background, panel.resolveServiceStatusTier(1).color);
    assert.equal(cells.at(-4).style.background, '#d1d5db');
    assert.match(section.textContentAll, /最近 24 小时/);
    assert.doesNotMatch(section.textContentAll, /999/);
    band.onkeydown({ key: 'Home', preventDefault() {} });
    assert.match(section.querySelector('[data-cx-status-bucket-detail]').textContent, /暂无采样/); // no point, not an observed zero.
    band.onkeydown({ key: 'End', preventDefault() {} });
    assert.match(section.querySelector('[data-cx-status-bucket-detail]').textContent, /20.*10 次/);
    const missing = panel.createStatusPanelSection({ theme: THEME, snapshot: panel.normalizeServiceStatusSnapshot(summaryResponse()), now });
    assert.equal(missing.querySelectorAll('[data-cx-status-band]').length, 1);
    const missingCells = missing.querySelectorAll('[data-cx-status-bucket]');
    assert.equal(missingCells.length, 288);
    assert.equal([...missingCells].every(cell => cell.style.background === '#d1d5db'), true,
      '历史暂不可用时所有格子必须是灰色');
    assert.match(missing.textContentAll, /历史暂不可用/);
    const empty = panel.createStatusPanelSection({ theme: THEME, snapshot: panel.normalizeServiceStatusSnapshot({ ...summaryResponse(), searchPoints: [] }), now });
    const emptyCells = empty.querySelectorAll('[data-cx-status-bucket]');
    assert.equal(emptyCells.length, 288);
    assert.equal([...emptyCells].every(cell => cell.style.background === '#d1d5db'), true,
      '没有搜题请求时所有格子必须是灰色');
    assert.match(empty.textContentAll, /暂无采样/);
  });
});

test('fetcher 把 endpoint 拼成绝对 URL，且不依赖默认常量', async () => {
  const { http } = await loadModules();
  const seen = [];
  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com/',
    endpoint: '/api/service-status/summary',
    requester: async (url) => { seen.push(url); return summaryResponse({ retained: 0, available: false }); }
  });
  await fetcher({ now: Date.now() });
  assert.deepEqual(seen, ['https://tiku.example.com/api/service-status/summary'],
    'baseurl 尾部斜杠要被吃掉，endpoint 前导斜杠保留');
});

// ---------------------------------------------------------------------------
// successRateAvailable：区分「全失败」与「没请求」（服务端权威字段）
// ---------------------------------------------------------------------------

test('★ 无搜题请求样本时只显示搜题接口暂无采样', async () => {
  const { panel, http } = await loadModules();

  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com',
    endpoint: '/api/service-status/summary',
    requester: async () => summaryResponse({ available: false, successRate: 0, retained: 0, totalRequests: 0, failedRequests: 0, searchTotalRequests: 0, searchSuccessRequests: 0, searchSamples: 0 })
  });
  const snapshot = await fetcher({ now: Date.now() });

  assert.equal(snapshot.kind, 'empty', 'available=false 必须落 empty（窗口内无请求）');
  assert.equal(snapshot.successRateAvailable, false);

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() });
    assert.equal(section.querySelectorAll('[data-cx-status-cell]').length, 0);
    assert.match(section.textContentAll, /尚未采集到搜题接口状态数据/);
  });
});

test('★ successRateAvailable=true 且 successRate=0（全失败）→ kind=ok，绝不落 empty', async () => {
  const { panel, http } = await loadModules();

  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com',
    endpoint: '/api/service-status/summary',
    // 100 请求 0 成功 —— 这是「全失败」，必须报警感，不能当成「没数据」。
    requester: async () => summaryResponse({ available: true, successRate: 0, retained: 5, totalRequests: 100, failedRequests: 100, searchTotalRequests: 10, searchSuccessRequests: 0 })
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
    assert.match(section.textContentAll, /0 次成功 \/ 10 次请求/);
    assert.doesNotMatch(section.textContentAll, /100 次请求/, '不显示其他接口或全站请求数量');
  });
});

test('★ 两个语义在界面上必须可区分（全失败 vs 没请求，文案与 kind 都不同）', async () => {
  const { panel } = await loadModules();
  const nowMs = Date.now();

  const allFailed = panel.normalizeServiceStatusSnapshot(summaryResponse({
    available: true, successRate: 0, retained: 5, totalRequests: 100, failedRequests: 100, searchTotalRequests: 10, searchSuccessRequests: 0
  }));
  const noTraffic = panel.normalizeServiceStatusSnapshot(summaryResponse({
    available: false, successRate: 0, retained: 0, totalRequests: 0, failedRequests: 0, searchTotalRequests: 0, searchSuccessRequests: 0, searchSamples: 0
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

test('★ 普通状态页只展示搜题接口统计，不渲染全站指标或时间曲线', async () => {
  const { panel, http } = await loadModules();

  const fetcher = http.createServiceStatusHttpFetcher({
    accessKey: 'tk-test',
    baseurl: 'https://tiku.example.com',
    endpoint: '/api/service-status/summary',
    requester: async () => summaryResponse({ available: true, successRate: 0.98, retained: 120, totalRequests: 1200, failedRequests: 24, avgLatencyMs: 210, searchTotalRequests: 10, searchSuccessRequests: 8, searchAvgLatencyMs: 345 })
  });
  const snapshot = await fetcher({ now: Date.now() });
  assert.equal(snapshot.kind, 'ok');
  assert.deepEqual(snapshot.buckets, [], 'summary 端点没有 points，buckets 必须为空');

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.now() });
    assert.equal(section.dataset.cxStatusMode, 'search', '普通用户视图必须明确标为搜题接口状态');
    assert.equal(section.querySelectorAll('[data-cx-status-cell]').length, 0,
      'summary 模式不得渲染任何色带格子（不能伪造曲线）');
    assert.equal(section.querySelectorAll('[data-cx-status-band]').length, 1, '摘要接口缺历史时显示灰色搜题色带');

    assert.match(section.textContentAll, /搜题接口/);
    assert.ok(section.querySelector('[data-cx-status-dot="降级"]'), '状态应按搜题分桶计算，而不是按全站成功率');
    assert.match(section.textContentAll, /80\.0%/);
    assert.match(section.textContentAll, /345ms/);
    assert.match(section.textContentAll, /8 次成功/);
    assert.match(section.textContentAll, /10 次请求/);
    assert.doesNotMatch(section.textContentAll, /1200|全站|当前窗口摘要|失败请求/);
    assert.doesNotMatch(section.textContentAll, /98\.0%/, '全站 98% 不得替代搜题接口 80%');
  });
});

test('★ 缺少搜题接口分桶时明确显示无数据，不回退到全站状态', async () => {
  const { panel } = await loadModules();
  const nowMs = Date.parse('2026-11-14T01:30:00+08:00');
  const snapshot = panel.normalizeServiceStatusSnapshot(
    backendResponse({ points: makePoints(1440, nowMs), retained: 1440 })
  );
  assert.equal(snapshot.kind, 'ok');

  await withMinimalDom(() => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: nowMs });
    assert.equal(section.dataset.cxStatusMode, 'search');
    assert.equal(section.querySelectorAll('[data-cx-status-cell]').length, 0);
    assert.match(section.textContentAll, /未提供搜题接口统计/);
  });
});

test('fetcher 带 Authorization: Bearer <key>（AuthOrAccessToken 需要它才走 access-token 分支）', async () => {
  const { http } = await loadModules();
  const seen = [];
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/api/service-status/summary',
    accessKey: 'tk-abc123',
    scriptIdentity: 'fixture-session',
    requester: async (url, init) => { seen.push({ url, init }); return summaryResponse(); }
  });
  await fetcher({ now: Date.now() });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.headers.Authorization, 'Bearer tk-abc123',
    '必须带 Bearer，否则 AuthOrAccessToken 会回退到登录 JWT 分支 → 401');
  assert.equal(seen[0].init.headers['X-Script-Identity'], 'fixture-session');
});

test('fetcher 在没配 key 时不发请求（所以也不会伪造空 Bearer）', async () => {
  const { http } = await loadModules();
  const seen = [];
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://tiku.example.com',
    endpoint: '/api/service-status/summary',
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
  //   GET /api/admin/service-status + **有效普通 token** → **401**，不是 403。
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
    endpoint: '/api/service-status/summary',
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

// ---------------------------------------------------------------------------
// getBaseurl：状态 Tab 必须跟随「保存后的」题库地址（138 §5.2 的 P2）
// ---------------------------------------------------------------------------
//
// 用户实测缺陷：在面板改了题库设置里的 URL，状态 TAB 依旧请求**默认 URL**。
// 根因是 mountServiceStatusHttpFetcher 把 baseurl 当**值**捕获进 fetcher，
// 之后不重建就永远用旧地址。
//
// 这一组是**变异验证逼出来的**：先只改实现（加 getBaseurl 支持）不写用例时，
// 把 `typeof options.getBaseurl === 'function'` 短路成 `false &&` 测试仍然全绿
// —— 说明既有 23 条一条都没覆盖到新行为。所以下列断言是补上真实防线，不是装饰。

test('判据：getBaseurl 优先于 baseurl（同一 fetcher 两次取值可用不同地址）', async () => {
  const { http } = await loadModules();

  let currentBaseurl = 'https://first.example.com';
  const seenUrls = [];
  const fetcher = http.createServiceStatusHttpFetcher({
    // 快照值是**旧**地址 —— 若 getBaseurl 未生效，请求会打到它。
    baseurl: 'https://stale.example.com',
    getBaseurl: () => currentBaseurl,
    endpoint: '/api/service-status/summary',
    accessKey: 'tk-abc',
    requester: async (url) => {
      seenUrls.push(url);
      return { ok: true, status: 200, json: async () => ({ status: 'up' }) };
    }
  });

  await fetcher({ now: Date.now() });
  currentBaseurl = 'https://second.example.com';
  await fetcher({ now: Date.now() });

  assert.equal(seenUrls.length, 2, '两次取值都应发出请求');
  assert.match(seenUrls[0], /^https:\/\/first\.example\.com\//, '第一次必须用 getBaseurl 的当前值');
  assert.match(seenUrls[1], /^https:\/\/second\.example\.com\//,
    '第二次必须用**改过之后**的地址 —— 这一条就是「状态 Tab 跟随题库设置」的直接判据');
  // 反向断言：绝不能用 baseurl 快照值。短路 getBaseurl 的实现会命中这里。
  for (const url of seenUrls) {
    assert.equal(url.includes('stale.example.com'), false,
      'getBaseurl 存在时不得退回 baseurl 快照值（这正是用户报的旧地址）');
  }
});

test('判据：getBaseurl 返回空串时退回 baseurl（不是直接放弃请求）', async () => {
  const { http } = await loadModules();

  const seenUrls = [];
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://fallback.example.com',
    getBaseurl: () => '   ',
    endpoint: '/api/service-status/summary',
    accessKey: 'tk-abc',
    requester: async (url) => {
      seenUrls.push(url);
      return { ok: true, status: 200, json: async () => ({ status: 'up' }) };
    }
  });

  await fetcher({ now: Date.now() });
  assert.equal(seenUrls.length, 1, '空白 getBaseurl 不应导致不发请求');
  assert.match(seenUrls[0], /^https:\/\/fallback\.example\.com\//, '应退回 baseurl');
});

test('判据：getBaseurl 抛异常时退回 baseurl，不得让状态页崩掉', async () => {
  const { http } = await loadModules();

  const seenUrls = [];
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'https://fallback.example.com',
    getBaseurl: () => {
      throw new Error('storage corrupted');
    },
    endpoint: '/api/service-status/summary',
    accessKey: 'tk-abc',
    requester: async (url) => {
      seenUrls.push(url);
      return { ok: true, status: 200, json: async () => ({ status: 'up' }) };
    }
  });

  // 核心：不抛。状态页是旁路展示，配置读取抛错不该把整块带塌。
  const snapshot = await fetcher({ now: Date.now() });
  assert.ok(snapshot, '必须返回快照而不是抛异常');
  assert.match(seenUrls[0], /^https:\/\/fallback\.example\.com\//, '应退回 baseurl');
});

test('判据：baseurl 与 getBaseurl 都不给时返回 null（静默，不抛）', async () => {
  const { http } = await loadModules();

  let called = false;
  const fetcher = http.createServiceStatusHttpFetcher({
    endpoint: '/api/service-status/summary',
    accessKey: 'tk-abc',
    requester: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ status: 'up' }) };
    }
  });

  const snapshot = await fetcher({ now: Date.now() });
  assert.equal(snapshot, null, '没有地址时必须返回 null，交给「还没设置题库地址」的静默分支');
  assert.equal(called, false, '没地址就不该发请求');
});

test('an existing status fetcher uses one current approved source-key pair, and cancels on takeover or revocation', async () => {
  const { http } = await loadModules();
  const a = 'https://first.fixture.invalid', b = 'https://second.fixture.invalid';
  let current = { baseurl: a, accessKey: 'fixture-a' };
  const hits = [];
  let release;
  let pause;
  const fetchStatus = http.createServiceStatusHttpFetcher({
    getConfig: () => current,
    includeSearchHistory: true,
    requester: async (url, init) => {
      hits.push([new URL(url).origin, init.headers.Authorization]);
      if (pause) await new Promise(resolve => { release = resolve; current = { baseurl: b, accessKey: 'fixture-b' }; });
      return summaryResponse();
    }
  });
  await fetchStatus();
  assert.deepEqual(hits, [[a, 'Bearer fixture-a'], [a, 'Bearer fixture-a']]);
  hits.length = 0;
  pause = true;
  const original = fetchStatus();
  pause = false;
  release();
  assert.equal(await original, null, 'old data may not publish after a source switch');
  assert.deepEqual(hits, [[a, 'Bearer fixture-a']], 'the follow-up request is canceled before dispatch');
  hits.length = 0;
  await fetchStatus();
  assert.deepEqual(hits, [[b, 'Bearer fixture-b'], [b, 'Bearer fixture-b']]);
  hits.length = 0;
  current = { baseurl: b, accessKey: '' };
  assert.equal((await fetchStatus()).kind, 'no-token');
  assert.deepEqual(hits, []);
});


test('the actual status mount keeps parallel reads and default redirects in the frozen host', async () => {
  const { http } = await loadModules();
  const text = await readFile(resolve(scriptsDir, '..', 'src/projects/common.ts'), 'utf8');
  const ast = ts.createSourceFile('common.ts', text, ts.ScriptTarget.Latest, true);
  const mount = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'mountServiceStatusHttpFetcher');
  const code = ts.transpileModule(mount.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const ordinary of [false, true]) {
    let release;
    let fetcher;
    const held = new Promise(resolve => { release = resolve; });
    const starts = [];
    const context = {
      usesBrowserAgreementGate: () => ordinary,
      DEFAULT_TIKU_BASE_URL: 'https://mounted.fixture.invalid',
      getStoredTikuAdapterConfig: () => ({ baseurl: 'https://mounted.fixture.invalid', key: 'local-only' }),
      resolveTikuAdapterBaseUrl: raw => raw,
      runtimeStore: { getProviderConfigRevision: () => 1 },
      setServiceStatusFetcher: fn => { fetcher = fn; },
      createServiceStatusHttpFetcher: http.createServiceStatusHttpFetcher,
      fetchServiceStatusRequester: async (_url, init) => {
        starts.push(init.redirect ?? 'default');
        if (starts.length === 1) await held;
        return summaryResponse();
      }
    };
    vm.runInNewContext(code + '; mountServiceStatusHttpFetcher();', context);
    const running = fetcher();
    const beforeRelease = starts.slice();
    release();
    await running;
    if (ordinary) {
      assert.deepEqual(beforeRelease, ['error']);
      assert.deepEqual(starts, ['error', 'error']);
    } else {
      assert.deepEqual(beforeRelease, ['default', 'default']);
      assert.deepEqual(starts, ['default', 'default']);
    }
  }
});

test('search series has its own trusted clock and never borrows the summary clock or older generation', async () => {
  const { http, panel } = await loadModules();
  const at = '2026-11-27T05:04:30.123Z';
  const minute = Math.floor(Date.parse(at) / 60000);
  const restart = '2026-11-26T11:04:30+08:00';
  const summary = { ...summaryResponse(), restartedAt: restart, asOf: '2026-11-27T05:04:00Z' };
  const series = { asOf: at, restartedAt: restart, latestSampleAt: '2026-11-27T05:03:30.123Z',
    searchPoints: [{ minute: minute - 2, totalRequests: 0, successRequests: 0, avgLatencyMs: 0 },
      { minute: minute - 1, totalRequests: 2, successRequests: 1, avgLatencyMs: 0 }] };
  let replies = { summary, series };
  const fetcher = http.createServiceStatusHttpFetcher({
    baseurl: 'http://127.0.0.1', accessKey: 'owned-fixture', includeSearchHistory: true,
    requester: async url => url.endsWith('/series') ? replies.series : replies.summary
  });
  let snapshot = await fetcher({ now: Date.parse('2031-06-01T00:00:00Z') });
  assert.equal(snapshot.searchHistoryTiming.asOfMs, Date.parse(at));
  assert.equal(snapshot.searchHistoryTiming.latestMs, Date.parse(series.latestSampleAt));
  assert.equal(snapshot.searchHistory[1].avgLatencyMs, 0);
  await withMinimalDom(async () => {
    const section = panel.createStatusPanelSection({ theme: THEME, snapshot, now: Date.parse('2031-06-01T00:00:00Z') });
    const band = section.querySelector('[data-cx-status-band]');
    const layer = section.querySelector('[data-cx-status-zoom]');
    assert.equal(band.getAttribute('aria-expanded'), 'false');
    band.onclick();
    assert.equal(band.getAttribute('aria-expanded'), 'true');
    assert.equal(layer.hidden, false);
    assert.match(layer.textContentAll, /13:02.*已采样无请求/);
    assert.match(layer.textContentAll, /13:03.*0 毫秒/);
    assert.match(layer.textContentAll, /13:04.*暂无采样/);
    assert.doesNotMatch(layer.textContentAll, /2031/);
  });

  const newer = '2026-11-27T05:04:31.123Z';
  replies = { summary, series: { ...series, restartedAt: newer, asOf: newer, latestSampleAt: null,
    endpoints: { search: { samples: 0, totalRequests: 0, successRequests: 0, avgLatencyMs: 0 } }, searchPoints: [] } };
  snapshot = await fetcher({ now: Date.now() });
  assert.equal(snapshot.restartedAtMs, Date.parse(newer));
  assert.equal(snapshot.search.totalRequests, 0);
  assert.deepEqual(snapshot.searchHistory, []);
  replies = { summary: { ...summary, restartedAt: newer }, series };
  snapshot = await fetcher({ now: Date.now() });
  assert.equal(snapshot.searchHistory, null);
  assert.equal(snapshot.searchHistoryTiming, undefined);
});

test('dedicated search decoder rejects malformed minutes, bogus zero and ambiguous duplicate coverage', async () => {
  const { panel } = await loadModules();
  const valid = { minute: 29929263, totalRequests: 1, successRequests: 0, avgLatencyMs: 17 };
  for (const searchPoints of [
    [valid, valid],
    [{ ...valid, totalRequests: null, successRequests: null }],
    [{ ...valid, successRequests: 2 }],
    [{ ...valid, avgLatencyMs: -1 }],
    [{ startMs: 1795752000000, requests: 1, succeeded: 1 }]
  ]) {
    const snap = panel.normalizeServiceStatusSnapshot({ searchPoints, points: [valid] });
    assert.equal(snap.searchHistory, null);
  }
});

test('recent summary cannot mistake last-day coverage for recent idle or nested admin search', async () => {
  const { panel } = await loadModules();
  const asOf = '2026-11-27T05:04:30Z';
  const minute = Math.floor(Date.parse(asOf) / 60000);
  const rows = offsets => offsets.map(offset => ({ minute: minute + offset, totalRequests: 0, successRequests: 0, avgLatencyMs: 0 }));
  const wire = { ...summaryResponse({ searchTotalRequests: 0, searchSuccessRequests: 0 }), asOf };
  await withMinimalDom(async () => {
    const draw = value => panel.createStatusPanelSection({ theme: THEME, now: Date.parse('2031-01-01T00:00:00Z'),
      snapshot: panel.normalizeServiceStatusSnapshot(value) }).querySelector('[data-cx-status-search]').textContentAll;
    assert.match(draw({ ...wire, searchPoints: rows([-8]) }), /最近窗口暂无搜题采样/);
    assert.match(draw({ ...wire, searchPoints: rows([-1]) }), /覆盖不足/);
    assert.match(draw({ ...wire, searchPoints: rows([-4, -3, -2, -1, 0]) }), /最近采样窗口内没有搜题请求/);
    assert.match(draw({ ...wire, searchPoints: rows([0]) }), /13:04:30（北京时间）/);
    assert.match(draw({ ...wire, asOf: 'untrusted clock', searchPoints: rows([-1]) }), /覆盖未知/);
    const adminOnly = { summary: { endpoints: wire.endpoints }, points: rows([0]), processPoints: [{ memory: 999 }] };
    assert.match(draw(adminOnly), /暂未提供搜题接口统计/);
    assert.doesNotMatch(draw(adminOnly), /999|全部成功/);
  });
});
