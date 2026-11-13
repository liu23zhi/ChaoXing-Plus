import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const statusPanelPath = resolve(scriptsDir, '..', 'src', 'projects', 'status-panel.ts');

async function loadStatusPanel() {
  return loadCompiledTypeScriptModule(statusPanelPath, ['status-panel.js', 'projects/status-panel.js']);
}

// ---------------------------------------------------------------------------
// 11 档配色：色值与边界
// ---------------------------------------------------------------------------

// 期望值一律写字面量，不引用 status-panel.ts 的常量 —— 常量与期望共享时，
// 常量漂移会让期望同步漂移，断言恒真（假钉子的第 4 类形态）。
const EXPECTED_TIERS = [
  { id: 't100', min: 100, max: 100, color: '#15803d', label: '全部成功' },
  { id: 't99', min: 99, max: 100, color: '#16a34a', label: '优秀' },
  { id: 't97', min: 97, max: 99, color: '#22c55e', label: '良好' },
  { id: 't95', min: 95, max: 97, color: '#65a30d', label: '接近正常' },
  { id: 't90', min: 90, max: 95, color: '#a3e635', label: '基本正常' },
  { id: 't80', min: 80, max: 90, color: '#eab308', label: '偶发失败' },
  { id: 't70', min: 70, max: 80, color: '#f59e0b', label: '轻度降级' },
  { id: 't50', min: 50, max: 70, color: '#f97316', label: '明显异常' },
  { id: 't30', min: 30, max: 50, color: '#ea580c', label: '严重异常' },
  { id: 't10', min: 0, max: 30, color: '#dc2626', label: '几乎全失败' },
  { id: 't0', min: 0, max: 0, color: '#7f1d1d', label: '全部失败' }
];

test('11 档配色的色值与档位边界与 117 §3.1 一致', async () => {
  const mod = await loadStatusPanel();

  assert.equal(mod.SERVICE_STATUS_TIERS.length, 11, '必须正好 11 档（117 §3.1）');
  const actual = mod.SERVICE_STATUS_TIERS.map((tier) => ({
    id: tier.id, min: tier.minPercent, max: tier.maxPercent, color: tier.color, label: tier.label
  }));
  // 从好到差比对；顺序本身也是契约（渲染图例按它反序）。
  const byWorstFirst = [...EXPECTED_TIERS].reverse().filter((tier) => tier.id !== 't100');
  assert.deepEqual(
    actual.filter((tier) => tier.id !== 't100'),
    byWorstFirst,
    '11 档的 id / 边界 / 色值 / 文案必须逐项一致'
  );
  // 纯绿单列一档：放在最前（第 1 档），与 99%~<100% 分开。
  assert.deepEqual(actual[0].id, 't0');
  assert.deepEqual(
    mod.SERVICE_STATUS_TIERS.find((tier) => tier.id === 't100'),
    { id: 't100', minPercent: 100, maxPercent: 100, color: '#15803d', label: '全部成功' }
  );

  // 无数据档不在 11 档里（117 §3.1 表里它是独立一行，不能算进 11）。
  assert.equal(mod.SERVICE_STATUS_TIERS.some((tier) => tier.id === 'none'), false);
  assert.equal(mod.SERVICE_STATUS_NO_DATA_TIER.color, '#d1d5db');
  assert.equal(mod.SERVICE_STATUS_NO_DATA_TIER.label, '无数据');
});

test('11 档配色两两不同：没有任何两档共用同一个色值', async () => {
  const mod = await loadStatusPanel();
  const colors = [...mod.SERVICE_STATUS_TIERS, mod.SERVICE_STATUS_NO_DATA_TIER].map((tier) => tier.color);

  assert.equal(colors.length, 12, '11 档 + 无数据 = 12 种状态（117 §3.2 的可辨上限）');
  assert.equal(new Set(colors).size, 12, `色值必须唯一，实际 ${JSON.stringify(colors)}`);
  for (const color of colors) {
    assert.match(color, /^#[0-9a-f]{6}$/u, `色值必须是小写 6 位 HEX，实际 ${color}`);
  }
});

// ---------------------------------------------------------------------------
// 分档行为：边界一律半开区间 [min, max)
// ---------------------------------------------------------------------------

test('档位边界逐条落档：每个边界值都落在文档指定的那一档', async () => {
  const mod = await loadStatusPanel();

  // 每条断言同时给出「右端点」与「右端点减一档」两个值：
  // 若边界判断写成 <= 或 <，这两个值里必有一个落错档。
  const boundaryCases = [
    // 恰好 100% 是纯绿单点档
    [1, 't100'], [0.999999999, 't99'], [0.999, 't99'],
    // 99% 起是 t99
    [0.99, 't99'], [0.9899999, 't97'],
    // 97% 起是 t97
    [0.97, 't97'], [0.9699999, 't95'],
    // 95% 起是 t95
    [0.95, 't95'], [0.9499999, 't90'],
    // 90% 起是 t90
    [0.9, 't90'], [0.8999999, 't80'],
    // 80% 起是 t80
    [0.8, 't80'], [0.7999999, 't70'],
    // 70% 起是 t70
    [0.7, 't70'], [0.6999999, 't50'],
    // 50% 起是 t50
    [0.5, 't50'], [0.4999999, 't30'],
    // 30% 起是 t30
    [0.3, 't30'], [0.2999999, 't10'],
    // 0% 起（有请求）是暗红单点档；任何 >0 都进 t10
    [0, 't0'], [0.000001, 't10'], [0.0999999, 't10']
  ];

  for (const [rate, expected] of boundaryCases) {
    assert.equal(
      mod.resolveServiceStatusTier(rate).id,
      expected,
      `成功率 ${rate} 应落 ${expected}，实际 ${mod.resolveServiceStatusTier(rate).id}`
    );
  }

  // 三档关键边界单独再钉一次（任务书判据 ⑤ 点名的三个值）。
  assert.equal(mod.resolveServiceStatusTier(0).id, 't0', '0 必须是暗红（全部失败）');
  assert.equal(mod.resolveServiceStatusTier(0.999).id, 't99', '99.9% 必须是 t99');
  assert.equal(mod.resolveServiceStatusTier(1).id, 't100', '100% 必须是纯绿');
});

test('0 与「无数据」是两个不同的档位，且颜色不同（判据 ⑦）', async () => {
  const mod = await loadStatusPanel();

  const totalFailure = mod.resolveServiceStatusTier(0);
  const noData = mod.resolveServiceStatusTier(null);

  assert.equal(totalFailure.id, 't0');
  assert.equal(noData.id, 'none');
  assert.notEqual(totalFailure.color, noData.color);
  // 无数据必须比暗红浅：浅灰 #d1d5db vs 暗红 #7f1d1d。
  // 断言具体色值，不写成「两者不等」——最小亮度差是设计意图，不是偶然。
  assert.equal(noData.color, '#d1d5db');
  assert.equal(totalFailure.color, '#7f1d1d');

  // undefined 与非有限数一律算无数据，不能落进最低档（否则会渲染成暗红）。
  for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(mod.resolveServiceStatusTier(value).id, 'none', `${String(value)} 必须落无数据档`);
  }
});

test('成功率超出 0..1 时被夹到边界，而不是落进无数据档', async () => {
  const mod = await loadStatusPanel();
  assert.equal(mod.resolveServiceStatusTier(1.5).id, 't100');
  assert.equal(mod.resolveServiceStatusTier(-0.5).id, 't0');
});

test('成功率文案：0 / 100 不带小数，其余保留一位', async () => {
  const mod = await loadStatusPanel();
  assert.equal(mod.formatServiceStatusPercent(1), '100%');
  assert.equal(mod.formatServiceStatusPercent(0), '0%');
  assert.equal(mod.formatServiceStatusPercent(0.999), '99.9%');
  assert.equal(mod.formatServiceStatusPercent(0.12), '12.0%');
  assert.equal(mod.formatServiceStatusPercent(null), '无数据');
});

// ---------------------------------------------------------------------------
// 288 格 → 24h 的映射
// ---------------------------------------------------------------------------

function atLocal(hours, minutes) {
  const date = new Date(2026, 10, 13, hours, minutes, 0, 0);
  return date.getTime();
}

test('288 格恒定：窗口起点 = 对齐后的 now − 24h，每格 5 分钟', async () => {
  const mod = await loadStatusPanel();

  assert.equal(mod.STATUS_BUCKET_COUNT, 288);
  assert.equal(mod.STATUS_BUCKET_MINUTES, 5);
  assert.equal(mod.STATUS_BAND_ROWS, 1, '单行渐变色带（118 §3.1）');
  assert.equal(mod.STATUS_BAND_COLUMNS, 288);

  const now = atLocal(14, 7); // 14:07 → 向下对齐到 14:05
  const buckets = mod.buildServiceStatusBuckets([], now);
  assert.equal(buckets.length, 288, '无论有没有数据，格子数恒为 288');

  const alignedNow = mod.alignServiceStatusWindowEnd(now);
  assert.equal(alignedNow, atLocal(14, 5), 'now 必须向下对齐到 5 分钟边界');
  // 窗口是右开区间 [alignedNow − 24h, alignedNow)：最后一格覆盖最近一个**已结束**的
  // 5 分钟 [14:00, 14:05)，不是 [14:05, 14:10) —— 后者还没走完，数据不完整。
  assert.equal(buckets[287].startMs, alignedNow - 5 * 60 * 1000, '最后一格是最近一个已结束的 5 分钟');
  assert.equal(buckets[287].startMs, atLocal(14, 0));
  assert.equal(buckets[0].startMs, alignedNow - 24 * 3600 * 1000, '第一格起点 = alignedNow − 24h');

  // 相邻格恒定相差 5 分钟，且逐格严格递增。
  for (let index = 1; index < buckets.length; index += 1) {
    assert.equal(buckets[index].startMs - buckets[index - 1].startMs, 5 * 60 * 1000, `第 ${index} 格间距必须是 5 分钟`);
  }

  // resolveServiceStatusBucketStart 与 build 出来的格子必须逐格一致（防止两处算式漂移）。
  for (const index of [0, 1, 96, 143, 144, 287]) {
    assert.equal(mod.resolveServiceStatusBucketStart(now, index), buckets[index].startMs, `第 ${index} 格起点不一致`);
  }

  // 覆盖的总时长正好 24 小时。
  assert.equal(
    buckets[buckets.length - 1].startMs + 5 * 60 * 1000 - buckets[0].startMs,
    24 * 3600 * 1000
  );
});

test('样本按 5 分钟落到对应格；窗口外的样本被丢弃', async () => {
  const mod = await loadStatusPanel();
  const now = atLocal(14, 7);
  const alignedNow = mod.alignServiceStatusWindowEnd(now);
  const windowStart = alignedNow - 24 * 3600 * 1000;

  const buckets = mod.buildServiceStatusBuckets([
    // 第 0 格的 3 个样本，其中两个在同 5 分钟内 → 必须累加
    { startMs: windowStart + 0, requests: 10, succeeded: 10 },
    { startMs: windowStart + 60_000, requests: 10, succeeded: 5 },
    { startMs: windowStart + 4 * 60_000, requests: 10, succeeded: 0 },
    // 第 287 格（最近一个已结束的 5 分钟 = alignedNow − 5min）
    { startMs: alignedNow - 5 * 60_000, requests: 40, succeeded: 40 },
    // 窗口外：过早
    { startMs: windowStart - 5 * 60_000, requests: 99, succeeded: 0 },
    // 窗口外：未来（右端是开区间，alignedNow 本身已经在窗口外）
    { startMs: alignedNow, requests: 99, succeeded: 0 },
    { startMs: alignedNow + 10 * 60_000, requests: 99, succeeded: 0 }
  ], now);

  assert.equal(buckets.length, 288);
  assert.equal(buckets[0].requests, 30, '同格样本必须累加请求数');
  assert.equal(buckets[0].succeeded, 15, '同格样本必须累加成功数');
  // 加权平均：15/30 = 0.5，不是三个样本成功率的简单平均 (1 + 0.5 + 0)/3 = 0.5（此处巧合相等，
  // 下面再用一组不等权样本证明是加权）。
  assert.equal(buckets[0].successRate, 0.5);
  assert.equal(buckets[0].successRate / 1, 0.5);

  assert.equal(buckets[287].requests, 40);
  assert.equal(buckets[287].successRate, 1);

  // 窗口外的样本没有污染任何格子。
  const totalRequests = buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
  assert.equal(totalRequests, 30 + 40, `窗口外样本必须丢弃，实际总数 ${totalRequests}`);
});

test('聚合成加权平均（成功总数/请求总数），不是各样本成功率的简单平均', async () => {
  const mod = await loadStatusPanel();
  const now = atLocal(14, 7);
  const windowStart = mod.alignServiceStatusWindowEnd(now) - 24 * 3600 * 1000;

  // 两个样本：1 次请求成功（100%）+ 99 次请求成功 0 次（0%）。
  // 简单平均 = 50%，加权平均 = 1/100 = 1%。
  const [first] = mod.buildServiceStatusBuckets([
    { startMs: windowStart, requests: 1, succeeded: 1 },
    { startMs: windowStart + 60_000, requests: 99, succeeded: 0 }
  ], now);

  assert.equal(first.requests, 100);
  assert.equal(first.successRate, 0.01, '必须按请求数加权，不能简单平均各样本成功率');
  assert.equal(mod.resolveServiceStatusTier(first.successRate).id, 't10');
});

test('无请求的格子 successRate 是 null，不是 0（判据 ⑦ 的格子版本）', async () => {
  const mod = await loadStatusPanel();

  // 全部无数据
  const empty = mod.buildServiceStatusBuckets([], atLocal(14, 7));
  for (const bucket of empty) {
    assert.equal(bucket.successRate, null, '没有请求的格子 successRate 必须是 null');
    assert.equal(bucket.requests, 0);
  }

  // 有请求但全失败 → 0（不是 null）
  const alignedNow = mod.alignServiceStatusWindowEnd(atLocal(14, 7));
  const failed = mod.buildServiceStatusBuckets([
    { startMs: alignedNow - 5 * 60_000, requests: 10, succeeded: 0 }
  ], atLocal(14, 7));
  assert.equal(failed[287].successRate, 0, '有请求且全失败必须是 0，不是 null');
  assert.equal(mod.resolveServiceStatusTier(failed[287].successRate).id, 't0');

  // 逐格分档：空窗口必须全部落 none 档，且颜色是无数据灰而不是最低档暗红。
  for (const bucket of empty) {
    const tier = mod.resolveServiceStatusTier(bucket.successRate);
    assert.equal(tier.id, 'none');
    assert.equal(tier.color, '#d1d5db');
    assert.notEqual(tier.color, '#7f1d1d');
  }
});

test('恶意/异常样本不会让格子数变化，也不会抛错', async () => {
  const mod = await loadStatusPanel();
  const now = atLocal(14, 7);
  const alignedNow = mod.alignServiceStatusWindowEnd(now);

  const buckets = mod.buildServiceStatusBuckets([
    null,
    undefined,
    { startMs: Number.NaN, requests: 5, succeeded: 5 },
    { startMs: alignedNow, requests: 0, succeeded: 0 },
    { startMs: alignedNow, requests: -5, succeeded: 3 },
    { startMs: alignedNow, requests: 10, succeeded: 99 } // 成功数 > 请求数
  ], now);

  assert.equal(buckets.length, 288);
  const last = buckets[287];
  assert.equal(last.requests, 0, 'requests <= 0 的样本必须被忽略');
  assert.equal(last.successRate, null);
});

// ---------------------------------------------------------------------------
// 快照归一化与 fixture
// ---------------------------------------------------------------------------

test('fixture 覆盖三种关键形态：无数据 / 全失败 / 全成功', async () => {
  const mod = await loadStatusPanel();
  const snapshot = mod.createFixtureServiceStatusSnapshot(atLocal(14, 7));

  const buckets = mod.buildServiceStatusBuckets(snapshot.buckets, atLocal(14, 7));
  const tiers = buckets.map((bucket) => mod.resolveServiceStatusTier(bucket.successRate).id);

  assert.equal(tiers.filter((id) => id === 'none').length, 96, 'fixture 必须有 96 格无数据（8 小时夜间）');
  assert.ok(tiers.includes('t0'), 'fixture 必须包含一段全部失败');
  assert.ok(tiers.includes('t100'), 'fixture 必须包含全成功时段');
  // 「无数据」与「全失败」在同一个 fixture 里同时出现，才能验证两者视觉可分。
  assert.ok(tiers.indexOf('none') >= 0 && tiers.indexOf('t0') >= 0);
});

test('后端响应归一化：camelCase 与 snake_case 都能读，缺失字段降级不抛错', async () => {
  const mod = await loadStatusPanel();

  const camel = mod.normalizeServiceStatusSnapshot({
    status: 'degraded',
    successRate: 0.42,
    avgLatencyMs: 512,
    totalRequests: 100,
    failedRequests: 58,
    breakdown: { upstream: 3, timeout: 1, auth: 2, quota: 4 },
    buckets: [{ startMs: 1000, requests: 10, succeeded: 5 }]
  });
  assert.equal(camel.status, 'degraded');
  assert.equal(camel.successRate, 0.42);
  assert.equal(camel.avgLatencyMs, 512);
  assert.equal(camel.breakdown.quota, 4);
  assert.equal(camel.buckets.length, 1);

  const snake = mod.normalizeServiceStatusSnapshot({
    data: {
      status: 'healthy',
      success_rate: 0.99,
      avg_latency_ms: 120,
      total_requests: 50,
      failed_requests: 1,
      breakdown: { upstream: 1 },
      history: [{ start_ms: 2000, total: 8, success: 8 }]
    }
  });
  assert.equal(snake.status, 'healthy');
  assert.equal(snake.successRate, 0.99);
  assert.equal(snake.totalRequests, 50);
  assert.equal(snake.buckets.length, 1);
  assert.equal(snake.buckets[0].requests, 8);
  assert.equal(snake.breakdown.auth, 0, '缺失字段必须降级为 0 而不是 NaN');

  // 整体不可用 → null，让渲染层显示「没有数据」而不是伪造一个全 0 的快照。
  assert.equal(mod.normalizeServiceStatusSnapshot(null), null);
  assert.equal(mod.normalizeServiceStatusSnapshot('not-an-object'), null);
  assert.equal(mod.normalizeServiceStatusSnapshot([]), null);
});

test('拉取失败时保留上一份快照，不清空', async () => {
  const mod = await loadStatusPanel();
  const good = mod.createFixtureServiceStatusSnapshot(atLocal(14, 7));
  mod.setCachedServiceStatusSnapshot(good);

  mod.setServiceStatusFetcher(async () => { throw new Error('upstream down'); });
  try {
    const after = await mod.refreshServiceStatusSnapshot({ now: atLocal(14, 7) });
    assert.equal(after, good, '拉取失败必须返回上一份快照');
    assert.equal(mod.readCachedServiceStatusSnapshot(), good, '缓存不能被清空');
  } finally {
    mod.setServiceStatusFetcher(async (options) => mod.createFixtureServiceStatusSnapshot(options.now));
    mod.setCachedServiceStatusSnapshot(null);
  }
});

test('并发刷新共享同一次请求（首屏不会连发两次）', async () => {
  const mod = await loadStatusPanel();
  let calls = 0;
  mod.setServiceStatusFetcher(async (options) => {
    calls += 1;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    return mod.createFixtureServiceStatusSnapshot(options.now);
  });
  try {
    await Promise.all([
      mod.refreshServiceStatusSnapshot({ now: atLocal(14, 7) }),
      mod.refreshServiceStatusSnapshot({ now: atLocal(14, 7) })
    ]);
    assert.equal(calls, 1, `并发刷新必须只发一次请求，实际 ${calls} 次`);
  } finally {
    mod.setServiceStatusFetcher(async (options) => mod.createFixtureServiceStatusSnapshot(options.now));
    mod.setCachedServiceStatusSnapshot(null);
  }
});
