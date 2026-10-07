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

async function createRuntime(responses, action = 'pause') {
  const notifications = [];
  const root = {};
  let requests = 0;
  const source = [
    await declarations('src/core/utils/event.ts', ['CommonEventEmitter']),
    await declarations('src/core/worker/worker.ts', ['OCSWorker']),
    await declarations('src/projects/cx.ts', [
      'manualAnswerRequiredMessage', 'aiFallbackNoAnswerMessage', 'hasAnyResolvedSearchResults', 'appendAIFallbackSearchInfos',
      'notifyManualAnswerRequired', 'unfinishedQuestionRetryAttempts',
      'retryUnfinishedChapterQuestionAtIndex', 'retryUnfinishedChapterQuestions',
      'retryUnfinishedWorkOrExamQuestionAtIndex', 'retryUnfinishedWorkOrExamQuestions'
    ])
  ].join('\n');
  const globals = {
    setTimeout, clearTimeout, setInterval, clearInterval,
    domSearchAll: () => ({ title: [{}], options: [{}] }),
    AnswerWrapperHandlerConfig: { timeout_seconds: 1 },
    getStoredTikuAdapterConfig: () => ({}),
    requestTikuAdapterAIFallback: async () => {
      const response = responses[Math.min(requests++, responses.length - 1)];
      return [{
        name: 'AI', results: response.success ? [{ answer: 'A' }] : [], response,
        error: response.success ? undefined : `${response.error.code}: upstream detail`
      }];
    },
    showTopCenterNotice: (message) => notifications.push(['notice', message]),
    $message: { warn: ({ content }) => notifications.push(['message', content]) },
    $console: { warn: (message) => notifications.push(['console', message]) },
    roots: [root],
    document: { querySelectorAll: () => [root] },
    cacheableResults: [],
    chapterActionCorrelationId: 'chapter', workExamCorrelationId: 'work', type: 'work',
    logDebug() {},
    workResultsMethods: () => ({ patchResult() {} }),
    shouldSkipCacheForAutomaticRetry: () => undefined,
    simplifyWorkResult: (results) => results.map((result) => ({ ...result, finish: result.result?.finish })),
    chapterTestTaskQuestionTitleTransform() {}, workOrExamQuestionTitleTransform() {}
  };
  const context = vm.createContext(globals);
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(code, context);
  const runtime = vm.runInContext(`({
    OCSWorker, appendAIFallbackSearchInfos,
    notify: typeof notifyManualAnswerRequired === 'function' ? notifyManualAnswerRequired : undefined,
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
  return { ...runtime, createWorker, notifications, get requests() { return requests; } };
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

test('empty searches still report the existing generic error', async () => {
  const runtime = await createRuntime([success]);
  const worker = runtime.createWorker();
  worker.opts.answerer = async () => [];
  const results = await worker.doWork();
  assert.equal(results[0].error, '搜索不到答案, 请重新运行, 或者忽略此题。');
});

test('successful searches finish without an error', async () => {
  const runtime = await createRuntime([success]);
  const results = await runtime.createWorker().doWork();
  assert.equal(results[0].result.finish, true);
  assert.equal(results[0].error, undefined);
});
