import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const outDir = resolve(process.cwd(), '.tmp-tests-tiku-cjs');
const helperModulePath = resolve(outDir, 'projects', 'tiku-adapter-config.js');
const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'tiku-adapter-config.ts');
const tscCliPath = resolve(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');

async function compileHelperModule() {
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
}

async function loadHelperModule() {
  await compileHelperModule();
  const require = createRequire(import.meta.url);
  delete require.cache[helperModulePath];
  return require(helperModulePath);
}

test('normalizes baseurl by trimming whitespace and trailing slashes', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.normalizeTikuAdapterBaseUrl, 'function');
  assert.equal(mod.normalizeTikuAdapterBaseUrl(' https://example.com/// '), 'https://example.com');
});

test('resolves search url from normalized baseurl', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.createTikuAdapterSearchUrl, 'function');
  assert.equal(
    mod.createTikuAdapterSearchUrl('https://adapter.local/'),
    'https://adapter.local/adapter-service/search'
  );
});

test('creates bearer authorization header text', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.createTikuAdapterAuthorizationHeader, 'function');
  assert.equal(mod.createTikuAdapterAuthorizationHeader('  secret-key  '), 'Bearer secret-key');
});

test('reports missing key as an unavailable config', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.getTikuAdapterConfigProblem, 'function');
  assert.equal(
    mod.getTikuAdapterConfigProblem({
      baseurl: 'https://adapter.local',
      key: ''
    }),
    'missing-key'
  );
});

test('maps current chaoxing question types to tikuAdapter numeric types', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.resolveTikuAdapterQuestionType, 'function');
  assert.equal(mod.resolveTikuAdapterQuestionType('single'), 0);
  assert.equal(mod.resolveTikuAdapterQuestionType('multiple'), 1);
  assert.equal(mod.resolveTikuAdapterQuestionType('judgement'), 3);
  assert.equal(mod.resolveTikuAdapterQuestionType('completion'), 2);
  assert.equal(mod.resolveTikuAdapterQuestionType('line'), 2);
  assert.equal(mod.resolveTikuAdapterQuestionType('unknown'), 4);
});

test('creates a post fetch wrapper with bearer auth and adapter search url', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.createTikuAdapterAnswererWrapper, 'function');
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local/',
    key: 'demo-key'
  });

  assert.equal(wrapper.url, 'https://adapter.local/adapter-service/search');
  assert.equal(wrapper.method, 'post');
  assert.equal(wrapper.type, 'fetch');
  assert.equal(wrapper.contentType, 'json');
  assert.deepEqual(wrapper.headers, {
    Authorization: 'Bearer demo-key'
  });
});

test('tiku adapter wrapper prefers computed choice keys for objective choice answers', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.createTikuAdapterAnswererWrapper, 'function');
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local/',
    key: 'demo-key'
  });
  const handler = Function(wrapper.handler)();
  const result = handler({
    question: '多选题',
    type: 1,
    answer: {
      answerIndex: [0, 2],
      answerKeyText: 'AC',
      answerText: '答案一#答案二',
      bestAnswer: ['答案一', '答案二']
    }
  });

  assert.deepEqual(result, ['多选题', 'AC', { source: 'tikuAdapter' }]);
});
