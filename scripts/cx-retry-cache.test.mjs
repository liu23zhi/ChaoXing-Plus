import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import ts from '@typescript/typescript6';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

const execFileAsync = promisify(execFile);
const outDir = createTestDirectory('cx-retry-cache-cjs');
const helperModulePath = resolve(outDir, 'cx-retry-cache.js');
const helperSourcePath = resolveTestPath('src', 'projects', 'cx-retry-cache.ts');
const tscCliPath = resolveTestPath('scripts', 'test-helpers', 'tsc-compat.mjs');

async function loadHelperModule() {
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'package.json'), '{"type":"commonjs"}\n');
  await execFileAsync(process.execPath, [
    tscCliPath,
    helperSourcePath,
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck'
  ]);
  const require = createRequire(import.meta.url);
  delete require.cache[helperModulePath];
  return require(helperModulePath);
}

const helperModule = await loadHelperModule();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadAnswererFactory(factoryName, dependencies) {
  const source = await readFile(resolveTestPath('src', 'projects', 'cx.ts'), 'utf8');
  const parsed = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
  let factory;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === factoryName) {
      factory = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(factory);
  const initializer = ts.isArrowFunction(factory.initializer) ? factory.initializer.body : factory.initializer;
  let workerExpression = initializer;
  while (ts.isCallExpression(workerExpression)) workerExpression = workerExpression.arguments[0];
  assert.ok(ts.isNewExpression(workerExpression));
  const properties = workerExpression.arguments[0].properties;
  const answerer = properties.find((property) => property.name?.getText(parsed) === 'answerer').initializer;
  const scope = factory.parent.parent.parent;
  const deduplicator = scope.statements.find((statement) =>
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) =>
      declaration.name.getText(parsed) === 'deduplicateSearchRequest'
    )
  );
  const code = ts.transpileModule(
    `${deduplicator?.getText(parsed) ?? ''}\nreturn (workerOptions = {}) => (${answerer.getText(parsed)});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  return Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}

test('automatic retry keeps server deduplication available when the search timed out', async () => {
  const mod = helperModule;

  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    error: '题库请求超时，可能是题库问题，或者请检查网络或者重试。'
  }), undefined);
  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    ctx: {
      searchInfos: [{ error: 'request timeout' }]
    }
  }), undefined);
});

test('automatic retry keeps server deduplication available after network or task errors', async () => {
  const mod = helperModule;

  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    ctx: {
      searchInfos: [{ error: '题库连接失败，请检查网络。' }]
    }
  }), undefined);
  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    error: 'Failed to fetch',
    ctx: { searchInfos: [{ error: 'UPSTREAM_ERROR: 状态查询失败' }] }
  }), undefined);
  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    result: { finish: false },
    ctx: { searchInfos: [
      { results: [{ answer: 'A' }] },
      { error: 'Failed to fetch', results: [] }
    ] }
  }), undefined);
});

test('automatic retry keeps cache enabled when no answer is displayed', async () => {
  const mod = helperModule;

  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    result: { finish: false },
    ctx: {
      searchInfos: [{ results: [] }]
    }
  }), undefined);
});

test('automatic retry bypasses cache when a returned answer did not match', async () => {
  const mod = helperModule;

  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    result: { finish: false },
    ctx: {
      searchInfos: [{
        results: [{ answer: '错误答案' }]
      }]
    }
  }), true);
  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    error: '答案未匹配',
    result: { finish: false },
    ctx: { searchInfos: [{ results: [{ answer: '错误答案' }] }] }
  }), true);
});

test('manual retry refreshes mismatched answers but preserves cache after network errors', () => {
  const mod = helperModule;
  assert.equal(mod.shouldSkipCacheForManualRetry({
    searchInfos: [{ results: [['题目', '错误答案', {}]] }]
  }), true);
  assert.equal(mod.shouldSkipCacheForManualRetry({
    error: 'Failed to fetch',
    searchInfos: [{ error: 'UPSTREAM_ERROR: 状态查询失败', results: [] }]
  }), undefined);
  assert.equal(mod.shouldSkipCacheForManualRetry({
    searchInfos: [{ results: [['题目', 'A', {}]] }, { error: 'Failed to fetch', results: [] }]
  }), undefined);
  assert.equal(mod.shouldSkipCacheForManualRetry(undefined), undefined);
});

test('local answer cache requires a usable answer and no provider errors', async () => {
  const mod = helperModule;

  assert.equal(mod.shouldCacheSearchInfos([]), false);
  assert.equal(mod.shouldCacheSearchInfos([{ name: '题库', results: [], error: 'request failed' }]), false);
  assert.equal(mod.shouldCacheSearchInfos([{ name: '题库', results: [] }]), false);
  assert.equal(mod.shouldCacheSearchInfos([{ name: '题库', results: [{ answer: '  ' }] }]), false);
  assert.equal(mod.shouldCacheSearchInfos([{ name: '题库', results: [{ answer: 'A' }] }, { error: 'Failed to fetch' }]), false);
  assert.equal(mod.shouldCacheSearchInfos([{ name: '题库', results: [{ answer: 'A' }] }]), true);
});

test('identical pending search requests share one provider and release successful results', async () => {
  assert.equal(typeof helperModule.createSearchRequestDeduplicator, 'function');
  const deduplicate = helperModule.createSearchRequestDeduplicator();
  const pending = deferred();
  let calls = 0;
  const provider = () => {
    calls++;
    return pending.promise;
  };
  const first = deduplicate('same', provider);
  const second = deduplicate('same', provider);
  await Promise.resolve();
  assert.equal(calls, 1);
  pending.resolve([{ answer: 'A' }]);
  assert.deepEqual(await first, [{ answer: 'A' }]);
  assert.deepEqual(await second, [{ answer: 'A' }]);
  assert.deepEqual(await deduplicate('same', async () => {
    calls++;
    return [];
  }), []);
  assert.equal(calls, 2);
});

test('different search request keys start in parallel', async () => {
  assert.equal(typeof helperModule.createSearchRequestDeduplicator, 'function');
  const deduplicate = helperModule.createSearchRequestDeduplicator();
  const pending = deferred();
  const started = [];
  const request = (key) => deduplicate(key, async () => {
    started.push(key);
    await pending.promise;
    return key;
  });
  const first = request('first');
  const second = request('second');
  await Promise.resolve();
  assert.deepEqual(started, ['first', 'second']);
  pending.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
});

test('rejected and synchronously thrown searches release their pending request keys', async () => {
  assert.equal(typeof helperModule.createSearchRequestDeduplicator, 'function');
  for (const synchronous of [false, true]) {
    const deduplicate = helperModule.createSearchRequestDeduplicator();
    const error = new Error('provider failed');
    let calls = 0;
    const provider = () => {
      calls++;
      if (synchronous) throw error;
      return Promise.reject(error);
    };
    const first = deduplicate('failed', provider);
    const second = deduplicate('failed', provider);
    await assert.rejects(first, error);
    await assert.rejects(second, error);
    assert.equal(calls, 1);
    assert.equal(await deduplicate('failed', async () => 'recovered'), 'recovered');
  }
});

for (const factoryName of ['createChapterWorker', 'createWorkOrExamWorker']) {
  test(`${factoryName} merges the whole search chain and keeps fresh retries independent`, async () => {
    const pending = deferred();
    const fallbackPending = deferred();
    const firstSleep = deferred();
    const requests = [];
    let fallbackCalls = 0;
    let sleepCalls = 0;
    const makeAnswerer = await loadAnswererFactory(factoryName, {
      createSearchRequestDeduplicator: helperModule.createSearchRequestDeduplicator,
      chapterTestTaskQuestionTitleTransform: (titles) => titles[0].innerText,
      workOrExamQuestionTitleTransform: (titles) => titles[0].innerText,
      sleep: async () => {
        const call = ++sleepCalls;
        if (call === 1) await firstSleep.promise;
      },
      // answerer 搜题前等待读的自由变量（秒）。
      searchDelaySeconds: 3,
      resolveChapterQuestionType: (root) => root.questionType,
      resolveWorkOrExamQuestionTypeRoot: (elements) => elements.root,
      resolveAnswerSearchType: (root) => root.questionType,
      optimizationElementWithImage: (element) => element,
      extractQuestionImageEvidence: () => ({ stemImages: [], optionImages: [] }),
      extractQuestionOptionTexts: (options) => options.map((option) => option.innerText),
      answererWrappers: [],
      defaultAnswerWrapperHandler: async (_wrappers, request) => {
        requests.push(request);
        await pending.promise;
        return [];
      },
      withTikuAdapterAdminWarnings: (result) => result,
      appendAIFallbackSearchInfos: async () => {
        fallbackCalls++;
        await fallbackPending.promise;
        return [{ name: 'AI', results: [{ answer: 'A' }] }];
      },
      enableAIFallbackAnswer: true,
      deepThinking: false,
      aiFallbackFailureAction: 'skip',
      appsMethods: () => ({ searchAnswerInCaches: (_title, provider) => provider() })
    });
    const run = (answerer, questionType = 'single', optionText = 'A') => {
      const root = { questionType };
      const elements = { title: [{ innerText: 'same question' }], options: [{ innerText: optionText }], root };
      return answerer(elements, { root, type: questionType, elements });
    };
    const answerer = makeAnswerer();
    const first = run(answerer);
    await new Promise(setImmediate);
    const second = run(answerer);
    await new Promise(setImmediate);
    assert.equal(sleepCalls, 1);
    assert.equal(requests.length, 0);
    firstSleep.resolve();
    await new Promise(setImmediate);
    assert.equal(requests.length, 1);
    pending.resolve();
    await new Promise(setImmediate);
    const duringFallback = run(answerer);
    const forcedFallback = factoryName === 'createChapterWorker'
      ? run(makeAnswerer({ forceAIFallbackOnly: true }))
      : undefined;
    await new Promise(setImmediate);
    assert.equal(requests.length, 1);
    assert.equal(fallbackCalls, forcedFallback ? 2 : 1);
    fallbackPending.resolve();
    await Promise.all([first, second, duringFallback, ...(forcedFallback ? [forcedFallback] : [])]);
    assert.equal(requests.length, 1);
    const next = run(answerer);
    const fresh = run(makeAnswerer({ skipCache: true }));
    const changedOptions = run(answerer, 'single', 'B');
    const changedType = run(answerer, 'multiple');
    await new Promise(setImmediate);
    assert.equal(requests.length, 5);
    assert.equal(requests.filter((request) => request.skipCache).length, 1);
    const results = await Promise.all([first, second, duringFallback, next, fresh, changedOptions, changedType]);
    assert.ok(results.every((result) => result[0].results[0].answer === 'A'));
    await run(answerer);
    assert.equal(requests.length, 6);
  });

  test(`${factoryName} keeps identical question text with different image evidence in separate pending searches`, async () => {
    const pending = deferred();
    const requests = [];
    const fallbackPayloads = [];
    const makeAnswerer = await loadAnswererFactory(factoryName, {
      createSearchRequestDeduplicator: helperModule.createSearchRequestDeduplicator,
      chapterTestTaskQuestionTitleTransform: (titles) => titles[0].innerText,
      workOrExamQuestionTitleTransform: (titles) => titles[0].innerText,
      sleep: async () => {}, searchDelaySeconds: 0,
      resolveChapterQuestionType: () => 'single',
      resolveWorkOrExamQuestionTypeRoot: (elements) => elements.root,
      resolveAnswerSearchType: () => 'single',
      extractQuestionImageEvidence: (titles) => titles[0].questionEvidence,
      extractQuestionOptionTexts: (options) => options.map((option) => option.innerText),
      answererWrappers: [],
      defaultAnswerWrapperHandler: async (_wrappers, request) => { requests.push(request); await pending.promise; return []; },
      withTikuAdapterAdminWarnings: (infos) => infos,
      appendAIFallbackSearchInfos: async (infos, _options, payload) => { fallbackPayloads.push(payload); return infos; },
      enableAIFallbackAnswer: true, deepThinking: false, aiFallbackFailureAction: 'skip',
      appsMethods: () => ({})
    });
    const answerer = makeAnswerer();
    const run = (alt) => {
      const questionEvidence = { stemImages: [{ url: 'https://img.test/same.png', alt, index: 0 }], optionImages: [] };
      const root = {};
      const elements = { title: [{ innerText: 'same question', questionEvidence }], options: [{ innerText: 'A' }], root };
      return answerer(elements, { root, type: 'single', elements });
    };
    const first = run('x²');
    const duplicate = run('x²');
    const distinct = run('x2');
    await new Promise(setImmediate);
    assert.equal(requests.length, 2);
    pending.resolve();
    await Promise.all([first, duplicate, distinct]);
    assert.deepEqual(fallbackPayloads.map((payload) => payload.questionEvidence.stemImages[0].alt).sort(), ['x2', 'x²']);
  });
}
