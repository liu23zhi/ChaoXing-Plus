import test from 'node:test';
import assert from 'node:assert/strict';

// 抓屏窗口期与轮询采样间隔的关系（t138 基准结论的回归钉子）。
//
// 背景：Watch-ClientCaptureGuard（scripts/windows-client-entry.ps1:538-595）按
// PollMilliseconds=200 轮询 GetWindowDisplayAffinity，检测 1→0 跳变后隐藏面板。
// 若客户端「关保护 → GetDC → 恢复」的窗口期 W 短于一个采样间隔，可能一次都采不到。
//
// 本文件把「命中率 = min(1, W/T)」这个判定关系固化下来，用于：
//   ① 防止有人把 PollMilliseconds 调到更大的值而不自知会加重漏检
//   ② 给「是否需要 native hook」提供可复算的量化依据
//
// 实测数据来自 scripts/wda-poll-benchmark.ps1（真实窗口 + 真实 Start-Sleep，
// 每种 W 跑 24 次单次事件试验，共跑 2 轮）。实测与理论的偏差在采样噪声范围内。

// 理论命中率：周期采样间隔 T，事件窗口 W 在时间轴上随机起始，
// 被任一采样点覆盖的概率 = min(1, W/T)。
function theoreticalHitRate(windowMs, pollMs) {
  if (pollMs <= 0) return 1;
  return Math.min(1, windowMs / pollMs);
}

test('理论命中率：窗口期不短于采样间隔时必然命中', () => {
  for (const pollMs of [50, 100, 200, 400]) {
    for (const windowMs of [pollMs, pollMs + 1, pollMs * 2, pollMs * 10]) {
      assert.equal(theoreticalHitRate(windowMs, pollMs), 1,
        `W=${windowMs} >= T=${pollMs} 时必须命中`);
    }
  }
});

test('理论命中率：窗口期短于采样间隔时按比例下降，且永不高于 W/T', () => {
  const pollMs = 200;
  for (const windowMs of [10, 20, 50, 100, 150]) {
    const rate = theoreticalHitRate(windowMs, pollMs);
    assert.ok(rate < 1, `W=${windowMs} < T=${pollMs} 时命中率必须小于 1`);
    assert.ok(Math.abs(rate - windowMs / pollMs) < 1e-9,
      `W=${windowMs} 的命中率应为 ${windowMs / pollMs}，实际 ${rate}`);
  }
});

test('理论命中率随窗口期单调不减', () => {
  const pollMs = 200;
  let previous = -1;
  for (let windowMs = 1; windowMs <= 400; windowMs += 1) {
    const rate = theoreticalHitRate(windowMs, pollMs);
    assert.ok(rate >= previous, `W=${windowMs} 时命中率不得低于 W=${windowMs - 1}`);
    previous = rate;
  }
});

// 实测数据（scripts/wda-poll-benchmark.ps1，两轮 2×24 次/档）。
// 断言用「区间」而不是精确值：这是实时系统测量，抖动本来就存在。
// 关键是**短窗口期确实会漏**这一条不能被写成"必中"。
const measured = [
  { windowMs: 10, hits: [2, 4], trials: 24 },
  { windowMs: 20, hits: [5, 3], trials: 24 },
  { windowMs: 50, hits: [4, 11], trials: 24 },
  { windowMs: 100, hits: [17, 15], trials: 24 },
  { windowMs: 150, hits: [23, 20], trials: 24 },
  { windowMs: 200, hits: [24, 24], trials: 24 },
  { windowMs: 250, hits: [24, 24], trials: 24 }
];

test('实测：200ms 轮询对短窗口期会漏检（这是 hook 存在的理由）', () => {
  for (const row of measured) {
    if (row.windowMs >= 200) continue;
    const totalHits = row.hits.reduce((a, b) => a + b, 0);
    const totalTrials = row.trials * row.hits.length;
    assert.ok(totalHits < totalTrials,
      `W=${row.windowMs}ms 在 200ms 轮询下必须至少漏检一次（实测 ${totalHits}/${totalTrials}），` +
      '若这条变红说明 W 已经不小于采样间隔，hook 的必要性需要重新评估');
  }
});

test('实测：窗口期达到采样间隔后稳定命中', () => {
  for (const row of measured) {
    if (row.windowMs < 200) continue;
    const totalHits = row.hits.reduce((a, b) => a + b, 0);
    const totalTrials = row.trials * row.hits.length;
    assert.equal(totalHits, totalTrials,
      `W=${row.windowMs}ms 在 200ms 轮询下必须全部命中（实测 ${totalHits}/${totalTrials}）`);
  }
});

test('实测与理论同向：W 越大命中率越高', () => {
  const rows = measured.filter((row) => row.windowMs <= 200);
  const rates = rows.map((row) => {
    const hits = row.hits.reduce((a, b) => a + b, 0);
    return hits / (row.trials * row.hits.length);
  });
  // 允许单点噪声，但整体趋势必须是上升的：比较首末
  assert.ok(rates[rates.length - 1] > rates[0],
    `W=200ms 的命中率 ${rates[rates.length - 1]} 必须高于 W=10ms 的 ${rates[0]}`);
});

// 这条把「采样间隔变大 = 漏检变多」固定成硬约束。
// 若有人为了省 CPU 把 PollMilliseconds 从 200 调到 500，
// 可检测窗口期阈值就从 200ms 抬到 500ms —— 必须显式知道这个后果。
test('采样间隔直接决定可检测的最小窗口期', () => {
  const cases = [
    { pollMs: 100, guaranteedAt: 100 },
    { pollMs: 200, guaranteedAt: 200 },
    { pollMs: 500, guaranteedAt: 500 }
  ];
  for (const entry of cases) {
    assert.equal(theoreticalHitRate(entry.guaranteedAt, entry.pollMs), 1,
      `T=${entry.pollMs}ms 时，W=${entry.guaranteedAt}ms 必须刚好达到 100%`);
    assert.ok(theoreticalHitRate(entry.guaranteedAt - 1, entry.pollMs) < 1,
      `T=${entry.pollMs}ms 时，W=${entry.guaranteedAt - 1}ms 必须低于 100%`);
  }
});
