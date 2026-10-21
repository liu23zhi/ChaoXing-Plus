import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const manualMessage = '检测到题目但当前无法安全自动作答，请手动处理。';

async function declarations(path, names) {
  const source = await readFile(resolve(path), 'utf8');
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found = [];
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.includes(node.name?.text)) {
      found.push(node.getText(parsed));
    }
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(parsed))) {
      found.push(`const ${node.getText(parsed)};`);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return found.join('\n').replace(/^export /gm, '');
}

async function createRuntime(responses, action = 'pause', modalConfirmResponses = [true]) {
  const notifications = [];
  const root = {};
  let requests = 0;
  let modalConfirmCalls = 0;
  let panelRefreshes = 0;
  const source = [
    await declarations('src/core/utils/event.ts', ['CommonEventEmitter']),
    await declarations('src/core/worker/interface.ts', ['DEFAULT_WORKER_THREAD_COUNT', 'resolveWorkerThreadCount']),
    await declarations('src/core/worker/worker.ts', ['OCSWorker']),
    await declarations('src/projects/cx-retry-cache.ts', ['hasInsufficientBalanceError']),
    await declarations('src/projects/cx.ts', [
      'manualAnswerRequiredMessage', 'aiFallbackNoAnswerMessage', 'hasAnyResolvedSearchResults', 'appendAIFallbackSearchInfos',
      'notifyManualAnswerRequired', 'notifyTikuAdapterInsufficientBalance', 'requestTikuAdapterBalanceRecovery', 'allowTikuAdapterRetryAfterBalanceRecovery', 'trackTikuAdapterWorker', 'untrackTikuAdapterWorker', 'stopTikuAdapterWorkers', 'continueTikuAdapterWorkers', 'tikuAdapterBalanceRecoveryState', 'unfinishedQuestionRetryAttempts',
      'retryUnfinishedChapterQuestionAtIndex', 'retryUnfinishedChapterQuestions',
      'retryUnfinishedWorkOrExamQuestionAtIndex', 'retryUnfinishedWorkOrExamQuestions'
    ])
  ].join('\n');
  const globals = {
    setTimeout, clearTimeout, setInterval, clearInterval,
    domSearchAll: () => ({ title: [{}], options: [{}] }),
    AnswerWrapperHandlerConfig: { timeout_seconds: 1 },
    getStoredTikuAdapterConfig: () => ({}),
    resetTikuAdapterBalanceGuard: () => {},
    requestTikuAdapterAIFallback: async () => {
      const response = responses[Math.min(requests++, responses.length - 1)];
      const detail = response.error?.message || 'upstream detail';
      return [{
        name: 'AI', results: response.success ? [{ answer: 'A' }] : [], response,
        error: response.success ? undefined : `${response.error.code}: ${detail}`
      }];
    },
    showTopCenterNotice: (message) => notifications.push(['notice', message]),
    $message: { warn: ({ content }) => notifications.push(['message', content]) },
    $modal: { confirm: async ({ content }) => { notifications.push(['modal', content]); const response = modalConfirmResponses[Math.min(modalConfirmCalls++, modalConfirmResponses.length - 1)]; return response !== false; } },
    $console: { warn: (message) => notifications.push(['console', message]) },
    roots: [root],
    document: { querySelectorAll: () => [root] },
    cacheableResults: [],
    chapterActionCorrelationId: 'chapter', workExamCorrelationId: 'work', type: 'work',
    logDebug() {},
    workResultsMethods: () => ({ patchResult() {}, refresh() { panelRefreshes++; } }),
    shouldSkipCacheForAutomaticRetry: () => undefined,
    simplifyWorkResult: (results) => results.map((result) => ({ ...result, finish: result.result?.finish })),
    chapterTestTaskQuestionTitleTransform() {}, workOrExamQuestionTitleTransform() {}
  };
  const context = vm.createContext(globals);
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(code, context);
  const runtime = vm.runInContext(`({
    OCSWorker, resolveWorkerThreadCount, appendAIFallbackSearchInfos,
    notify: typeof notifyManualAnswerRequired === 'function' ? notifyManualAnswerRequired : undefined,
    notifyBalance: typeof notifyTikuAdapterInsufficientBalance === 'function' ? notifyTikuAdapterInsufficientBalance : undefined,
    recoverBalance: typeof requestTikuAdapterBalanceRecovery === 'function' ? requestTikuAdapterBalanceRecovery : undefined,
    allowRetryAfterBalanceRecovery: typeof allowTikuAdapterRetryAfterBalanceRecovery === 'function' ? allowTikuAdapterRetryAfterBalanceRecovery : undefined,
    balanceState: tikuAdapterBalanceRecoveryState,
    trackTikuAdapterWorker: typeof trackTikuAdapterWorker === 'function' ? trackTikuAdapterWorker : undefined,
    untrackTikuAdapterWorker: typeof untrackTikuAdapterWorker === 'function' ? untrackTikuAdapterWorker : undefined,
    retryChapter: retryUnfinishedChapterQuestions,
    retryWork: retryUnfinishedWorkOrExamQuestions
  })`, context);
  const createWorker = () => new runtime.OCSWorker({
    root: [root], elements: {}, thread: 1,
    answerer: () => runtime.appendAIFallbackSearchInfos([], {
      enableAIFallbackAnswer: true, aiFallbackFailureAction: action
    }, { title: 'Question', type: 'single', optionsText: 'A' }),
    work: async (ctx) => ({ finish: ctx.searchInfos.some((info) => info.results.length > 0) })
  });
  context.createChapterWorker = createWorker;
  context.createWorkOrExamWorker = createWorker;
  return { ...runtime, createWorker, notifications, get requests() { return requests; }, get modalConfirmCalls() { return modalConfirmCalls; }, get panelRefreshes() { return panelRefreshes; } };
}

const failure = { success: false, error: { code: 'NO_ANSWER' } };
const success = { success: true };

test('AI failure stays quiet during answering and preserves its final error', async () => {
  const runtime = await createRuntime([failure]);
  const results = await runtime.createWorker().doWork();
  assert.deepEqual(runtime.notifications, []);
  assert.match(results[0].error, /AI 兜底未返回可用答案/);
  assert.equal(results[0].error.includes(manualMessage), false);
});

test('worker defaults to four concurrent search requests while preserving result order', async () => {
  const runtime = await createRuntime([success]);
  const roots = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  let active = 0;
  let maxActive = 0;
  let activeResolvers = 0;
  let maxActiveResolvers = 0;
  const searchOrder = [];
  const answerOrder = [];
  const worker = new runtime.OCSWorker({
    root: roots,
    elements: {},
    answerer: async (_elements, ctx) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, ctx.root.id === 0 ? 80 : 10));
      active -= 1;
      searchOrder.push(ctx.root.id);
      return [{ name: 'fixture', results: [{ question: String(ctx.root.id), answer: 'A' }] }];
    },
    work: async (ctx) => {
      maxActiveResolvers = Math.max(maxActiveResolvers, ++activeResolvers);
      answerOrder.push(ctx.root.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeResolvers -= 1;
      return { finish: true };
    }
  });

  const results = await worker.doWork();

  assert.equal(maxActive, 4);
  assert.notEqual(searchOrder[0], 0);
  assert.equal(maxActiveResolvers, 1);
  assert.deepEqual(answerOrder, [0, 1, 2, 3, 4]);
  assert.deepEqual(Array.from(results, (result) => result.ctx.root.id), [0, 1, 2, 3, 4]);
});

test('worker thread count defaults to four and normalizes invalid values', async () => {
  const runtime = await createRuntime([success]);

  assert.equal(runtime.resolveWorkerThreadCount(undefined), 4);
  assert.equal(runtime.resolveWorkerThreadCount(0), 1);
  assert.equal(runtime.resolveWorkerThreadCount(-2), 1);
  assert.equal(runtime.resolveWorkerThreadCount(2.9), 2);
  assert.equal(runtime.resolveWorkerThreadCount(Number.NaN), 4);
});

test('worker publishes every question before searching, then reports searching, search completion, and answer completion', async () => {
  const runtime = await createRuntime([success]);
  const events = [];
  const roots = [{ id: 0 }, { id: 1 }];
  const worker = new runtime.OCSWorker({
    root: roots,
    elements: {},
    thread: 1,
    onResultsInitialized: (results) => {
      events.push({
        kind: 'initialized',
        questions: Array.from(results, (result) => ({
          requested: result.requested,
          resolved: result.resolved,
          searching: result.searching ?? false
        }))
      });
    },
    onResultsUpdate: (result, index) => {
      events.push({
        kind: result.searching ? 'searching' : result.resolved ? 'answered' : 'searched',
        index,
        requested: result.requested,
        resolved: result.resolved
      });
    },
    answerer: async (_elements, ctx) => {
      events.push({ kind: 'answerer', index: ctx.root.id });
      return [{ name: 'fixture', results: [{ question: '题目', answer: '答案' }] }];
    },
    work: async () => ({ finish: true })
  });

  await worker.doWork();

  const initializedIndex = events.findIndex((event) => event.kind === 'initialized');
  assert.notEqual(initializedIndex, -1);
  assert.deepEqual(events[initializedIndex].questions, [
    { requested: false, resolved: false, searching: false },
    { requested: false, resolved: false, searching: false }
  ]);
  for (const index of [0, 1]) {
    const searchingIndex = events.findIndex((event) => event.kind === 'searching' && event.index === index);
    const answererIndex = events.findIndex((event) => event.kind === 'answerer' && event.index === index);
    const searchedIndex = events.findIndex((event) => event.kind === 'searched' && event.index === index);
    const answeredIndex = events.findIndex((event) => event.kind === 'answered' && event.index === index);
    assert.ok(initializedIndex < searchingIndex);
    assert.ok(searchingIndex < answererIndex);
    assert.ok(answererIndex < searchedIndex);
    assert.ok(searchedIndex < answeredIndex);
    assert.equal(events[searchingIndex].requested, false);
    assert.equal(events[searchedIndex].requested, true);
    assert.equal(events[searchedIndex].resolved, false);
  }
});

for (const mode of ['Chapter', 'Work']) {
  test(`${mode} retry success never requests manual intervention`, async () => {
    const runtime = await createRuntime([failure, failure, success]);
    const initial = await runtime.createWorker().doWork();
    const results = await runtime[`retry${mode}`](initial);
    assert.equal(runtime.requests, 3);
    assert.equal(results[0].result.finish, true);
    assert.deepEqual(runtime.notifications, []);
    assert.equal(typeof runtime.notify, 'function');
    runtime.notify(results);
    assert.deepEqual(runtime.notifications, []);
  });

  test(`${mode} exhausted retries notify once after the final attempt`, async () => {
    const runtime = await createRuntime([failure]);
    const initial = await runtime.createWorker().doWork();
    const results = await runtime[`retry${mode}`](initial);
    assert.equal(runtime.requests, 4);
    assert.deepEqual(runtime.notifications, []);
    assert.equal(typeof runtime.notify, 'function');
    runtime.notify([...results, ...results]);
    assert.deepEqual(runtime.notifications, [
      ['notice', manualMessage], ['message', manualMessage], ['console', manualMessage]
    ]);
  });
}

test('skip failures retained in search results notify only when the final answer is unfinished', async () => {
  const runtime = await createRuntime([failure], 'skip');
  const results = await runtime.createWorker().doWork();
  assert.deepEqual(runtime.notifications, []);
  assert.match(results[0].ctx.searchInfos[0].error, /upstream detail/);
  assert.equal(results[0].ctx.searchInfos[0].error.includes(manualMessage), false);
  assert.equal(typeof runtime.notify, 'function');
  runtime.notify([{ ...results[0], result: { finish: true } }]);
  assert.deepEqual(runtime.notifications, []);
  runtime.notify(results);
  assert.equal(runtime.notifications[0][1], manualMessage);
});

test('unavailable AI keeps its existing log without a manual-intervention warning', async () => {
  const runtime = await createRuntime([{ success: false, error: { code: 'AI_UNAVAILABLE' } }]);
  const results = await runtime.createWorker().doWork();
  assert.equal(typeof runtime.notify, 'function');
  runtime.notify(results);
  assert.deepEqual(runtime.notifications, [['console', 'AI 兜底未配置，已跳过 AI 搜题']]);
});

test('insufficient balance keeps the actionable adapter error instead of the generic no-answer message', async () => {
  const runtime = await createRuntime([{
    success: false,
    error: {
      code: 'INSUFFICIENT_BALANCE',
      message: '当前余额不足，AI 兜底已禁用，请充值后再使用'
    }
  }]);
  const results = await runtime.createWorker().doWork();

  assert.match(results[0].error, /当前余额不足，AI 兜底已禁用，请充值后再使用/);
  assert.doesNotMatch(results[0].error, /AI 兜底未返回可用答案/);
  assert.equal(runtime.notifications.filter(([kind]) => kind === 'modal').length, 1);
});

test('skip mode preserves insufficient balance details in search results', async () => {
  const runtime = await createRuntime([{
    success: false,
    error: {
      code: 'INSUFFICIENT_BALANCE',
      message: '当前余额不足，AI 兜底已禁用，请充值后再使用'
    }
  }], 'skip');
  const results = await runtime.createWorker().doWork();

  assert.match(results[0].ctx.searchInfos[0].error, /当前余额不足，AI 兜底已禁用，请充值后再使用/);
  assert.doesNotMatch(results[0].ctx.searchInfos[0].error, /AI 兜底未返回可用答案/);
});

test('empty searches still report the existing generic error', async () => {
  const runtime = await createRuntime([success]);
  const worker = runtime.createWorker();
  worker.opts.answerer = async () => [];
  const results = await worker.doWork();
  assert.equal(results[0].error, '搜索不到答案, 请重新运行, 或者忽略此题。');
});

for (const mode of ['Chapter', 'Work']) {
  test(`${mode} retries a balance-failed question after the explicit recovery confirmation`, async () => {
    const runtime = await createRuntime([
      { success: false, error: { code: 'INSUFFICIENT_BALANCE', message: '当前余额不足，请充值后再使用' } },
      success
    ]);
    const initial = await runtime.createWorker().doWork();
    assert.equal(runtime.requests, 1);
    assert.equal(runtime.balanceState.paused, false);

    const results = await runtime[`retry${mode}`](initial);
    assert.equal(runtime.requests, 2);
    assert.equal(results[0].result.finish, true);
    assert.equal(results[0].error, undefined);
  });

  test(`${mode} waits for balance recovery between retries and respects the three-retry limit`, async () => {
    const balanceFailure = { success: false, error: { code: 'INSUFFICIENT_BALANCE', message: '当前余额不足，请充值后再使用' } };
    const runtime = await createRuntime([balanceFailure]);
    const initial = await runtime.createWorker().doWork();

    const results = await runtime[`retry${mode}`](initial);

    assert.equal(runtime.requests, 4, 'one initial request plus three retries');
    assert.equal(runtime.modalConfirmCalls, 4, 'each insufficient-balance response requires confirmation');
    assert.equal(results[0].result.finish, false);
    assert.match(results[0].error, /余额不足/);
  });

  test(`${mode} does not retry while balance recovery remains paused`, async () => {
    const runtime = await createRuntime([
      { success: false, error: { code: 'INSUFFICIENT_BALANCE', message: '当前余额不足，请充值后再使用' } },
      success
    ], 'pause', [false]);
    const initial = await runtime.createWorker().doWork();

    assert.equal(runtime.balanceState.paused, true);
    const results = await runtime[`retry${mode}`](initial);

    assert.equal(runtime.requests, 1);
    assert.equal(results[0].result.finish, false);
  });

  test(`${mode} stops unfinished retries when balance recovery is declined`, async () => {
    const balanceFailure = { success: false, error: { code: 'INSUFFICIENT_BALANCE', message: '当前余额不足，请充值后再使用' } };
    const runtime = await createRuntime([balanceFailure], 'pause', [true, false]);
    const initial = await runtime.createWorker().doWork();

    const results = await runtime[`retry${mode}`](initial);

    assert.equal(runtime.requests, 2, 'the retry that encountered insufficient balance must finish before pausing');
    assert.equal(runtime.modalConfirmCalls, 2, 'the retry must request a new confirmation');
    assert.equal(runtime.balanceState.paused, true);
    assert.equal(results[0].result.finish, false);
    assert.match(results[0].error, /余额不足/);
  });
}

test('manual retry waits for recovery confirmation and issues no request while recovery is declined', async () => {
  const runtime = await createRuntime([success], 'pause', [false, false, true]);
  await runtime.notifyBalance([{ name: 'Adapter', results: [], error: 'INSUFFICIENT_BALANCE: 当前余额不足' }]);

  assert.equal(runtime.balanceState.paused, true);
  assert.equal(await runtime.allowRetryAfterBalanceRecovery(), false);
  assert.equal(runtime.balanceState.paused, true);
  assert.equal(runtime.requests, 0);

  assert.equal(await runtime.allowRetryAfterBalanceRecovery(), true);
  assert.equal(runtime.balanceState.paused, false);
  assert.equal(runtime.requests, 0);
});

test('ordinary search balance rejection skips AI fallback in either failure action', async () => {
  for (const action of ['skip', 'pause']) {
    const runtime = await createRuntime([success], action);
    const infos = [{ name: 'Adapter', results: [], error: 'INSUFFICIENT_BALANCE: 当前余额不足' }];
    const result = await runtime.appendAIFallbackSearchInfos(infos, { enableAIFallbackAnswer: true, aiFallbackFailureAction: action }, { title: 'question', type: 'single', optionsText: 'A' });
    assert.equal(runtime.requests, 0);
    assert.equal(result, infos);
    assert.equal(runtime.notifications.filter(([kind]) => kind === 'modal').length, 1);
  }
});

test('balance recovery requires the explicit continue confirmation', async () => {
  const runtime = await createRuntime([success]);
  assert.equal(typeof runtime.notifyBalance, 'function');
  await runtime.notifyBalance([{ name: 'Adapter', results: [], error: 'INSUFFICIENT_BALANCE: 当前余额不足' }]);
  assert.equal(runtime.notifications.filter(([kind]) => kind === 'modal').length, 1);
  assert.match(runtime.notifications.find(([kind]) => kind === 'modal')?.[1], /已充值/);
});

test('balance recovery pauses active workers and only continues after confirmation', async () => {
  const runtime = await createRuntime([success], 'pause', [false, true]);
  const events = [];
  runtime.trackTikuAdapterWorker({
    emit: (event) => events.push(event),
    once: () => undefined
  });

  await runtime.notifyBalance([{ name: 'Adapter', results: [], error: 'INSUFFICIENT_BALANCE: 当前余额不足' }]);
  assert.equal(runtime.modalConfirmCalls, 1);
  assert.equal(runtime.panelRefreshes > 0, true);
  assert.deepEqual(events, ['stop']);
  await runtime.recoverBalance();
  assert.equal(runtime.modalConfirmCalls, 2);
  assert.deepEqual(events, ['stop', 'continuate']);
});

test('balance recovery keeps a paged worker tracked after an intermediate done event', async () => {
  const runtime = await createRuntime([success], 'pause', [false, true]);
  const listeners = new Map();
  const events = [];
  const worker = {
    once(event, listener) {
      const handlers = listeners.get(event) ?? [];
      handlers.push(listener);
      listeners.set(event, handlers);
    },
    emit(event) {
      events.push(event);
      const handlers = listeners.get(event) ?? [];
      listeners.delete(event);
      for (const listener of handlers) listener();
    }
  };

  runtime.trackTikuAdapterWorker(worker, true);
  worker.emit('done');
  await runtime.notifyBalance([{ name: 'Adapter', results: [], error: 'INSUFFICIENT_BALANCE: 当前余额不足' }]);

  assert.deepEqual(events, ['done', 'stop']);
  await runtime.recoverBalance();
  assert.deepEqual(events, ['done', 'stop', 'continuate']);
  runtime.untrackTikuAdapterWorker(worker);
  await runtime.notifyBalance([{ name: 'Adapter', results: [], error: 'INSUFFICIENT_BALANCE: 当前余额不足' }]);
  assert.deepEqual(events, ['done', 'stop', 'continuate']);
});

test('successful searches finish without an error', async () => {
  const runtime = await createRuntime([success]);
  const results = await runtime.createWorker().doWork();
  assert.equal(results[0].result.finish, true);
  assert.equal(results[0].error, undefined);
});
