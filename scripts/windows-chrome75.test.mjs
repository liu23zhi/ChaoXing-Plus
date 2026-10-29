import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkChrome75Syntax } from '../windows/share-file/chrome75-syntax.mjs';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const outDir = resolve(root, '.tmp-tests-windows-chrome75-cjs');
const helperModulePath = resolve(outDir, 'projects', 'tiku-adapter-config.js');
const helperSourcePath = resolve(root, 'src', 'projects', 'tiku-adapter-config.ts');
const tscCliPath = resolve(root, 'scripts', 'test-helpers', 'tsc-compat.mjs');

async function compileTikuAdapterModule() {
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

async function loadTikuAdapterModule() {
  await compileTikuAdapterModule();
  const require = createRequire(import.meta.url);
  delete require.cache[helperModulePath];
  return require(helperModulePath);
}

test('内置题库 handler 字符串全部是 Chrome 75 可解析语法', async () => {
  const mod = await loadTikuAdapterModule();
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local/',
    key: 'test-key'
  });
  const handlers = {
    'response handler': wrapper.handler,
    'data.question handler': wrapper.data.question.handler,
    'data.options handler': wrapper.data.options.handler,
    'data.type handler': wrapper.data.type.handler,
    'data.skipCache handler': wrapper.data.skipCache.handler,
    'data.deepThinking handler': wrapper.data.deepThinking.handler
  };
  for (const [label, source] of Object.entries(handlers)) {
    const result = checkChrome75Syntax(source, { label, functionBody: true });
    assert.equal(result.ok, true, `${label} 含 Chrome 75 不支持的语法：${result.unsupported.join('、')}`);
  }
  // 选项 handler 必须保持单行：它会被 Function(...) 直接求值，且测试依赖单行约定。
  assert.equal(wrapper.data.options.handler.split('\n').length, 1);
  // 回归：内容逻辑未被改坏（ES2019 化只改语法，不改语义）。
  const resolveOptions = Function(wrapper.data.options.handler)();
  assert.deepEqual(
    resolveOptions({ options: 'A. 选项一\nB. 选项二\nwordNum = "";\n$(document).ready();' }),
    ['A. 选项一', 'B. 选项二']
  );
  const resolveResponse = Function(wrapper.handler)();
  assert.deepEqual(
    resolveResponse({ question: 'q', type: 0, answer: { answerKeyText: 'A' } }),
    ['q', 'A', { source: 'tikuAdapter' }]
  );
  assert.deepEqual(
    resolveResponse({ question: 'q', type: 0, answer: { answerIndex: [1, 3] } }),
    ['q', 'BD', { source: 'tikuAdapter' }]
  );
  assert.deepEqual(
    resolveResponse({ question: 'q', type: 2, answer: { bestAnswer: [' 填空一 ', '填空二'] } }),
    ['q', '填空一#填空二', { source: 'tikuAdapter' }]
  );
});

test('Windows 页面 bootstrap 与 trampoline 是 Chrome 75 可解析语法', async () => {
  const files = [
    ['windows/share-file/windows-bootstrap.js', 'windows-bootstrap.js'],
    ['windows/share-file/trampoline.js', 'trampoline.js']
  ];
  for (const [relative, label] of files) {
    const source = await readFile(resolve(root, relative), 'utf8');
    const result = checkChrome75Syntax(source, { label });
    assert.equal(result.ok, true, `${label} 含 Chrome 75 不支持的语法：${result.unsupported.join('、')}`);
  }
});

test('bootstrap 保持关键约定：消息前缀、去重标记、共享配置过滤与 polyfill', async () => {
  const source = await readFile(resolve(root, 'windows/share-file/windows-bootstrap.js'), 'utf8');
  assert.equal(source.includes("var MESSAGE_PREFIX = '__CX_WIN_MSG__';"), true);
  assert.equal(source.includes("var MARK_KEY = '__CX_WIN_MARK__';"), true);
  assert.equal(source.includes("var HOST_KEY = '__CX_WIN_HOST__';"), true);
  assert.equal(source.includes('function installPolyfills()'), true);
  assert.equal(source.includes('elementProto.replaceChildren'), true);
  assert.equal(source.includes('PromiseCtor.allSettled'), true);
  assert.equal(source.includes('cryptoObj.randomUUID'), true);
  assert.equal(source.includes("'common.work-results.results'"), true);
  assert.equal(source.includes("'common.apps.question-caches'"), true);
  assert.equal(source.includes('chaoxing-plus:shared-store-hydrate'), true);
  assert.equal(source.includes('chaoxing-plus:shared-store-sync'), true);
});

test('windows 构建脚本与入口脚本约定', async () => {
  const buildSource = await readFile(resolve(root, 'windows/share-file/build.windows.mjs'), 'utf8');
  assert.equal(buildSource.includes("target: 'chrome75'"), true);
  assert.equal(buildSource.includes('checkChrome75Syntax'), true);
  assert.equal(buildSource.includes('package-manifest.json'), true);
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['build:windows'], 'node windows/share-file/build.windows.mjs');
  assert.equal(packageJson.scripts.windows, 'windows\\native-source\\start-windows.cmd');
  assert.equal(packageJson.scripts['windows:node'], 'node windows/node-source/main.mjs');
  assert.equal(packageJson.scripts['windows:self-check'], 'build-windows\\bin\\chaoxing_plus.exe --self-check');
});

test.after(async () => {
  await rm(outDir, { recursive: true, force: true });
});

