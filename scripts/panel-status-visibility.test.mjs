import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';

// 面板状态可见性回归：七个状态必须互斥可枚举，且错误提示必须给出下一步。

const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'work-results-status.ts');

async function loadHelperModule() {
  return loadCompiledTypeScriptModule(helperSourcePath, ['projects/work-results-status.js', 'work-results-status.js']);
}

function result(overrides = {}) {
  return {
    question: '示例题目',
    requested: false,
    resolved: false,
    finish: false,
    manual: false,
    retrying: false,
    searchInfos: [],
    ...overrides
  };
}

const ANSWERED = { requested: true, resolved: true, finish: true, searchInfos: [{ name: 'tiku', results: [['题', '答案', {}]] }] };

test('panel activity state enumerates exactly the seven documented states', async () => {
  const mod = await loadHelperModule();
  const states = new Set();
  const push = (input) => states.add(mod.resolvePanelActivityState(input).state);

  push({ results: [] });
  push({ results: [result({ searching: true })] });
  push({ results: [result({ requested: true })], running: true });
  push({ results: [result({ requested: true })], paused: true });
  push({ results: [result({ requested: true, manual: true })] });
  push({ results: [result(ANSWERED)] });
  push({ results: [result({ requested: true, error: 'boom' })] });

  assert.deepEqual(
    Array.from(states).sort(),
    ['answering', 'completed', 'error', 'idle', 'paused', 'searching', 'waiting-manual']
  );
});

test('panel activity states are mutually exclusive with a documented priority', async () => {
  const mod = await loadHelperModule();

  // 暂停最高优先：用户已要求停下，不能再显示搜题中。
  assert.equal(mod.resolvePanelActivityState({ results: [result({ searching: true })], paused: true }).state, 'paused');
  // 搜题中优先于答题中：还没拿到答案就不能说在答题。
  assert.equal(
    mod.resolvePanelActivityState({ results: [result({ searching: true })], running: true }).state,
    'searching'
  );
  // 运行中优先于出错：还有 worker 在跑时，个别题失败不等于整体失败。
  assert.equal(
    mod.resolvePanelActivityState({ results: [result({ requested: true, error: 'x' })], running: true }).state,
    'answering'
  );
  // 全部完成才算已完成，部分完成仍是答题中/空闲。
  assert.equal(mod.resolvePanelActivityState({ results: [result(ANSWERED), result(ANSWERED)] }).state, 'completed');
  assert.equal(
    mod.resolvePanelActivityState({ results: [result(ANSWERED), result({ requested: true })] }).state,
    'idle'
  );
});

test('panel activity snapshot always carries label, detail, tone and pulse', async () => {
  const mod = await loadHelperModule();
  const snapshots = [
    mod.resolvePanelActivityState({ results: [] }),
    mod.resolvePanelActivityState({ results: [result({ searching: true })] }),
    mod.resolvePanelActivityState({ results: [result({ requested: true })], running: true }),
    mod.resolvePanelActivityState({ results: [result({ requested: true })], paused: true }),
    mod.resolvePanelActivityState({ results: [result({ requested: true, manual: true })] }),
    mod.resolvePanelActivityState({ results: [result(ANSWERED)] }),
    mod.resolvePanelActivityState({ results: [result({ requested: true, error: 'x' })] })
  ];
  for (const snapshot of snapshots) {
    assert.equal(typeof snapshot.label, 'string');
    assert.ok(snapshot.label.length > 0, '状态必须有可见文字');
    assert.equal(typeof snapshot.detail, 'string');
    assert.ok(snapshot.detail.length > 0, '状态必须说明现在发生了什么');
    assert.ok(['idle', 'active', 'paused', 'manual', 'success', 'danger'].includes(snapshot.tone));
    assert.equal(typeof snapshot.pulse, 'boolean');
  }
  // 只有进行中的状态脉冲，静止状态不闪。
  assert.equal(mod.resolvePanelActivityState({ results: [result({ searching: true })] }).pulse, true);
  assert.equal(mod.resolvePanelActivityState({ results: [result(ANSWERED)] }).pulse, false);
});

test('balance and quota errors get different next steps', async () => {
  const mod = await loadHelperModule();
  const balance = mod.describeSearchErrorNextStep('{"error":{"code":"INSUFFICIENT_BALANCE","message":"当前账号余额不足，请充值后重试。"}}');
  const quota = mod.describeSearchErrorNextStep('{"error":{"code":"ACCESS_TOKEN_QUOTA_EXCEEDED","message":"当前 Key 额度已用尽或本次请求将超额，请调整额度或更换 Key 后重试。"}}');

  assert.match(balance, /充值/u, '余额不足必须指向充值');
  assert.doesNotMatch(balance, /更换 Key/u, '余额不足不能要求更换 Key');
  assert.match(quota, /调整额度|更换 Key/u, '额度用尽必须指向额度或换 Key');
  assert.doesNotMatch(quota, /充值/u, '额度用尽不能引导充值');
  assert.notEqual(balance, quota);
  // 不能只回显错误码。
  for (const text of [balance, quota]) {
    assert.match(text, /^下一步：/u);
    assert.doesNotMatch(text, /^ACCESS_TOKEN_QUOTA_EXCEEDED$/u);
  }
});

test('every documented error code maps to an actionable next step', async () => {
  const mod = await loadHelperModule();
  const cases = [
    ['AI_UNAVAILABLE', /稍后重试|关闭 AI 兜底/u],
    ['NO_ANSWER', /AI 兜底|手动作答/u],
    ['UPSTREAM_ERROR', /稍等/u],
    ['INVALID_INPUT', /题干与选项/u],
    ['UNSAFE_TO_ANSWER', /手动作答/u],
    ['访问令牌鉴权失败', /题库配置/u],
    ['Failed to fetch', /网络/u],
    ['服务器内部错误', /题库服务/u],
    ['完全未知的错误', /重答本题/u]
  ];
  for (const [raw, pattern] of cases) {
    const text = mod.describeSearchErrorNextStep(raw);
    assert.match(text, /^下一步：/u, raw);
    assert.match(text, pattern, `${raw} → ${text}`);
  }
});

test('empty and undefined errors still produce a next step', async () => {
  const mod = await loadHelperModule();
  for (const raw of ['', undefined, null]) {
    const text = mod.describeSearchErrorNextStep(raw);
    assert.match(text, /^下一步：/u);
    assert.ok(text.length > 5);
  }
});
