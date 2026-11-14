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
const outDir = createTestDirectory('deep-thinking-cjs');
const helperModulePath = resolve(outDir, 'projects', 'tiku-adapter-config.js');
const helperSourcePath = resolveTestPath('src', 'projects', 'tiku-adapter-config.ts');
const commonSourcePath = resolveTestPath('src', 'projects', 'common.ts');
const cxSourcePath = resolveTestPath('src', 'projects', 'cx.ts');
const messageSourcePath = resolveTestPath('src', 'runtime', 'message.ts');
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

async function loadAnswererFactory(factoryName, dependencies) {
  const source = await readFile(cxSourcePath, 'utf8');
  const parsed = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
  let factory;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === factoryName) factory = node;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(factory, `${factoryName} exists`);
  const initializer = ts.isArrowFunction(factory.initializer) ? factory.initializer.body : factory.initializer;
  let workerExpression = initializer;
  while (ts.isCallExpression(workerExpression)) workerExpression = workerExpression.arguments[0];
  assert.ok(ts.isNewExpression(workerExpression));
  const answerer = workerExpression.arguments[0].properties.find((property) => property.name?.getText(parsed) === 'answerer').initializer;
  const code = ts.transpileModule(
    `return (workerOptions = {}) => (${answerer.getText(parsed)});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  return Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}

test('normal search sends deepThinking only when enabled on async and legacy routes', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/search/health')) {
      return Response.json({ success: true, status: 'succeeded', taskId: 'probe', statusUrl: 'https://adapter.local/api/search/status?taskId=probe' });
    }
    if (String(url).includes('taskId=probe')) {
      return Response.json({ success: true, status: 'succeeded', taskId: 'probe', result: { answer: {} } });
    }
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return String(url).endsWith('/search/tasks')
      ? Response.json({ success: true, status: 'succeeded', taskId: 'search', result: { answer: {} } })
      : Response.json({ question: '题目', answer: {} });
  };

  try {
    for (const asyncSearch of [true, false]) {
      const wrapper = mod.createTikuAdapterAnswererWrapper({
        baseurl: 'https://adapter.local',
        key: 'secret',
        asyncSearch
      });
      assert.deepEqual(Object.keys(wrapper.data), [
        'qid', 'question', 'options', 'type', 'courseName', 'extra', 'skipCache', 'deepThinking', 'questionEvidence'
      ]);
      for (const deepThinking of [false, true]) {
        const env = { title: '题目', type: 'single', options: 'A\nB', deepThinking };
        const data = Object.fromEntries(Object.entries(wrapper.data).map(([key, value]) => [
          key, typeof value === 'object' && value?.handler ? Function(value.handler)()(env) : value
        ]));
        await wrapper.executeRequest({ data, timeoutMs: 1000 });
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), [
    '/api/search/tasks', '/api/search/tasks',
    '/api/search', '/api/search'
  ]);
  for (const [index, request] of requests.entries()) {
    assert.equal(Object.hasOwn(request.body, 'deepThinking'), index % 2 === 1);
    if (index % 2 === 1) assert.equal(request.body.deepThinking, true);
  }
});

for (const factoryName of ['createChapterWorker', 'createWorkOrExamWorker']) {
  test(`${factoryName} looks up answers by mode without changing skipCache`, async () => {
    for (const [deepThinking, skipCache] of [[false, false], [false, true], [true, false]]) {
      const cacheModes = [];
      const cacheIdentities = [];
      const requests = [];
      const makeAnswerer = await loadAnswererFactory(factoryName, {
        chapterTestTaskQuestionTitleTransform: (titles) => titles[0].innerText,
        workOrExamQuestionTitleTransform: (titles) => titles[0].innerText,
        sleep: async () => {},
        // 这里注入的是 answerer 里搜题前等待所读的自由变量（秒），
        // 与已废弃的 CommonWorkOptions.period（从未接线）无关。
        searchDelaySeconds: 3,
        resolveChapterQuestionType: (root) => root.questionType,
        resolveWorkOrExamQuestionTypeRoot: (elements) => elements.root,
        resolveAnswerSearchType: (root) => root.questionType,
        optimizationElementWithImage: (element) => element,
        extractQuestionImageEvidence: () => ({ stemImages: [{ url: 'https://img.test/1.png', alt: 'formula', index: 0 }], optionImages: [] }),
        extractQuestionOptionTexts: (options) => options.map((option) => option.innerText),
        answererWrappers: [],
        defaultAnswerWrapperHandler: async (_wrappers, request) => {
          requests.push(request);
          return [{ name: '题库', results: [{ answer: 'fresh' }] }];
        },
        withTikuAdapterAdminWarnings: (infos) => infos,
        appendAIFallbackSearchInfos: async (infos) => infos,
        deduplicateSearchRequest: (_key, request) => request(),
        enableAIFallbackAnswer: false,
        deepThinking,
        aiFallbackFailureAction: 'skip',
        appsMethods: () => ({
          searchAnswerInCaches: async (_title, provider, mode, identity) => {
            cacheModes.push(mode);
            cacheIdentities.push(identity);
            return mode === 'normal'
              ? [{ name: '本地缓存', results: [{ answer: 'cached' }] }]
              : provider();
          }
        })
      });
      const root = { questionType: 'single' };
      const elements = { title: [{ innerText: '同一道题' }], options: [{ innerText: 'A' }], root };
      const infos = await makeAnswerer({ skipCache })(elements, { root, type: 'single', elements });
      const shouldRequest = deepThinking || skipCache;
      assert.deepEqual(cacheModes, skipCache ? [] : [deepThinking ? 'deep' : 'normal']);
      assert.deepEqual(cacheIdentities, skipCache ? [] : [{ type: 'single', options: ['A'], questionEvidence: {
        stemImages: [{ url: 'https://img.test/1.png', alt: 'formula', index: 0 }], optionImages: []
      } }]);
      assert.equal(requests.length, shouldRequest ? 1 : 0);
      assert.equal(infos[0].results[0].answer, shouldRequest ? 'fresh' : 'cached');
      if (shouldRequest) {
        assert.equal(requests[0].deepThinking, deepThinking);
        assert.equal(requests[0].skipCache, skipCache);
        assert.equal(requests[0].questionEvidence.stemImages[0].alt, 'formula');
      }
    }
  });
}

test('search mode uses async and sync choices while persisting the existing boolean setting', async () => {
  const source = await readFile(commonSourcePath, 'utf8');
  assert.match(source, /useAsyncTikuSearch:\s*true/);
  assert.match(source, /getStudySettingValue\('useAsyncTikuSearch',\s*stored\.useAsyncTikuSearch\s*\?\?\s*true\)/);
  assert.match(source, /useAsyncTikuSearch:\s*\{\s*label:\s*'搜题方式',[\s\S]*?options:\s*\[\s*\['true',\s*'异步'\],\s*\['false',\s*'同步'\]\s*\],[\s\S]*?defaultValue:\s*true/);
  assert.match(source, /setStudySettingValue\(script, key, key === 'useAsyncTikuSearch' \? value === 'true' : value\)/);
});

test('AI fallback omits deepThinking by default and sends true when enabled', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  const bodies = [];
  const urls = [];

  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    bodies.push(JSON.parse(init.body));
    return Response.json({
      success: true,
      result: { question: '題目', answer: '答案' }
    });
  };

  try {
    const requests = [
      { deepThinking: undefined, preferAsyncTask: false },
      { deepThinking: true, preferAsyncTask: false },
      { deepThinking: true, preferAsyncTask: true }
    ];
    for (const { deepThinking, preferAsyncTask } of requests) {
      await mod.requestTikuAdapterAIFallback(
        { baseurl: 'https://adapter.local', key: 'secret' },
        { title: '題目', type: 'single', options: 'A\nB', ...(deepThinking === true ? { deepThinking: true } : {}) },
        { requestTimeoutMs: 1000, retryAttempts: 1, retryDelayMs: 0, preferAsyncTask }
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(Object.hasOwn(bodies[0], 'deepThinking'), false);
  assert.equal(bodies[1].deepThinking, true);
  assert.match(urls[2], /\/adapter-service\/ai-fallback\/tasks$/);
  assert.equal(bodies[2].deepThinking, true);
});

test('deep thinking is a disabled-by-default learning setting with a cost and latency note', async () => {
  const source = await readFile(commonSourcePath, 'utf8');

  assert.match(source, /deepThinking:\s*false/);
  assert.match(source, /getStudySettingValue\('deepThinking',\s*stored\.deepThinking\s*\?\?\s*false\)/);
  assert.match(source, /deepThinking:\s*\{[\s\S]{0,220}?label:\s*'深度思考'[\s\S]{0,220}?type:\s*'checkbox'[\s\S]{0,220}?defaultValue:\s*false/);
  assert.match(source, /深度思考[\s\S]{0,100}(?:更慢|更长)[\s\S]{0,100}(?:费用|成本)[\s\S]{0,30}(?:更高|增加)/);
  assert.ok(source.includes("const aiSearchKeys = ['enableAIFallbackAnswer', 'useAsyncTikuSearch', 'deepThinking', 'aiFallbackFailureAction'];"));
  assert.ok(source.includes("createSettingsGroup('AI 搜题', '深度思考会增加等待时间，且费用可能更高；默认关闭。', aiSearchKeys)"));
});

test('enabling deep thinking asks for confirmation before persisting the setting', async () => {
  const source = await readFile(commonSourcePath, 'utf8');
  const messageSource = await readFile(messageSourcePath, 'utf8');
  const clickHandlerStart = source.indexOf("if (key === 'deepThinking' && !checked)");
  const clickHandlerEnd = source.indexOf('\n    };', clickHandlerStart);
  const clickHandler = source.slice(clickHandlerStart, clickHandlerEnd);

  assert.notEqual(clickHandlerStart, -1);
  assert.match(clickHandler, /\$modal\.confirm\(/);
  assert.match(clickHandler, /费用(?:也)?可能更高/);
  assert.match(clickHandler, /if \(confirmed\)/);
  assert.match(clickHandler, /setStudySettingValue\(script, key, true\)/);
  assert.match(clickHandler, /return;/);
  assert.match(messageSource, /return runtimeSwal\.fire\(/);
  assert.match(messageSource, /async confirm\([\s\S]*?await fireSwal\(/);
});

test('chapter and work or exam search chains forward deep thinking to both adapter routes', async () => {
  const source = await readFile(cxSourcePath, 'utf8');
  const chapterStart = source.search(/async chapter\s*\(/u);
  const workStart = source.indexOf('function workOrExam(');
  const chapterBlock = source.slice(chapterStart, workStart);
  const workBlock = source.slice(workStart);
  const fallbackStart = source.indexOf('async function appendAIFallbackSearchInfos');
  const fallbackBlock = source.slice(fallbackStart, source.indexOf('\n}', fallbackStart) + 2);

  assert.notEqual(chapterStart, -1);
  assert.notEqual(workStart, -1);
  assert.match(fallbackBlock, /Pick<CommonWorkOptions,[^>]*deepThinking/);
  assert.match(fallbackBlock, /deepThinking:\s*workOptions\.deepThinking/);

  for (const block of [chapterBlock, workBlock]) {
    assert.match(block, /deepThinking,/);
    assert.match(block, /defaultAnswerWrapperHandler\(answererWrappers,\s*\{[\s\S]{0,180}deepThinking/);
    assert.match(block, /appendAIFallbackSearchInfos\([\s\S]{0,300}deepThinking/);
    assert.match(block, /JSON\.stringify\(\[[\s\S]{0,260}deepThinking/);
  }
});

test('completed chapter and work or exam answers persist under their search mode', async () => {
  const source = await readFile(cxSourcePath, 'utf8');
  const chapterStart = source.search(/async chapter\s*\(/u);
  const workStart = source.indexOf('function workOrExam(');
  const chapterBlock = source.slice(chapterStart, workStart);
  const workBlock = source.slice(workStart);
  assert.match(chapterBlock, /addQuestionCacheFromWorkResult\?\.\(cacheableResults, deepThinking \? 'deep' : 'normal'\)/);
  const workWrites = workBlock.match(/addQuestionCacheFromWorkResult\?\.\(simplifyWorkResult\(\[current\], workOrExamQuestionTitleTransform\), deepThinking \? 'deep' : 'normal'\)/g) ?? [];
  assert.equal(workWrites.length, 2);
});
