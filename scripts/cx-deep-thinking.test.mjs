import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const outDir = resolve(process.cwd(), '.tmp-tests-deep-thinking-cjs');
const helperModulePath = resolve(outDir, 'projects', 'tiku-adapter-config.js');
const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'tiku-adapter-config.ts');
const commonSourcePath = resolve(process.cwd(), 'src', 'projects', 'common.ts');
const cxSourcePath = resolve(process.cwd(), 'src', 'projects', 'cx.ts');
const messageSourcePath = resolve(process.cwd(), 'src', 'runtime', 'message.ts');
const tscCliPath = resolve(process.cwd(), 'scripts', 'test-helpers', 'tsc-compat.mjs');

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

test('normal search never sends deepThinking outside the seven-field search contract', async () => {
  const mod = await loadHelperModule();
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local',
    key: 'secret'
  });

  assert.equal(wrapper.data.deepThinking, undefined);
  assert.deepEqual(Object.keys(wrapper.data), ['qid', 'question', 'options', 'type', 'courseName', 'extra', 'skipCache']);
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
  const chapterStart = source.indexOf('async chapter(frame: HTMLIFrameElement, options: CommonWorkOptions)');
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
