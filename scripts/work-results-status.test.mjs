import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';

const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'work-results-status.ts');

async function loadHelperModule() {
  return loadCompiledTypeScriptModule(helperSourcePath, ['projects/work-results-status.js', 'work-results-status.js']);
}

function createResult(overrides = {}) {
  return {
    question: '示例题目',
    type: 'single',
    requested: false,
    resolved: false,
    finish: false,
    manual: false,
    retrying: false,
    searchInfos: [],
    ...overrides
  };
}

test('marks answered results as success tone when usable answers exist', async () => {
  const mod = await loadHelperModule();
  const result = createResult({
    requested: true,
    resolved: true,
    finish: true,
    searchInfos: [{ name: 'tikuAdapter', results: [['题目', '答案', {}]] }]
  });

  assert.equal(typeof mod.resolveWorkResultStatusSource, 'function');
  assert.equal(typeof mod.resolveWorkResultTone, 'function');
  assert.equal(mod.resolveWorkResultStatusSource(result), 'answered');
  assert.equal(mod.resolveWorkResultTone(result, false), 'success');
});

test('marks unresolved results as danger tone when no answers were found', async () => {
  const mod = await loadHelperModule();
  const result = createResult({
    requested: true,
    resolved: false,
    searchInfos: []
  });

  assert.equal(mod.resolveWorkResultStatusSource(result), 'unresolved');
  assert.equal(mod.resolveWorkResultTone(result, false), 'danger');
});

test('marks manual results as yellow before success or failure tones', async () => {
  const mod = await loadHelperModule();
  const result = createResult({
    requested: true,
    resolved: true,
    finish: true,
    manual: true,
    searchInfos: [{ name: 'tikuAdapter', results: [['题目', '答案', {}]] }]
  });

  assert.equal(mod.resolveWorkResultStatusSource(result), 'manual');
  assert.equal(mod.resolveWorkResultTone(result, false), 'manual');
});

test('selected tone overrides every other status', async () => {
  const mod = await loadHelperModule();
  const result = createResult({
    requested: true,
    resolved: true,
    finish: true,
    manual: true,
    searchInfos: [{ name: 'tikuAdapter', results: [['题目', '答案', {}]] }]
  });

  assert.equal(mod.resolveWorkResultTone(result, true), 'selected');
});

test('formats manual and retrying labels explicitly', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.formatWorkResultStatus, 'function');
  assert.equal(mod.formatWorkResultStatus(createResult()), '等待搜索中');
  assert.equal(mod.formatWorkResultStatus(createResult({ manual: true })), '已人工答题');
  assert.equal(mod.formatWorkResultStatus(createResult({ retrying: true })), '正在重答...');
  assert.equal(mod.formatWorkResultStatus(createResult({ searching: true })), '搜题中');
  assert.equal(
    mod.formatWorkResultStatus(createResult({ requested: true, searchInfos: [] })),
    '未搜索到答案'
  );
});

test('search-in-progress is separate from the completed search requested flag', async () => {
  const mod = await loadHelperModule();
  const result = createResult({ searching: true });

  assert.equal(result.requested, false);
  assert.equal(mod.formatWorkResultStatus(result), '搜题中');
  assert.equal(mod.resolveWorkResultStatusSource(result), 'idle');
});

test('summarizes structured tiku errors while preserving a plain-text fallback', async () => {
  const mod = await loadHelperModule();
  const raw = JSON.stringify({
    errCode: 401,
    message: '访问令牌鉴权失败',
    detail: '访问令牌不存在',
    request: {
      method: 'POST',
      path: '/adapter-service/search',
      authorization: 'Bearer tk_2...ec71'
    }
  });

  assert.equal(typeof mod.summarizeSearchInfoError, 'function');
  assert.deepEqual(mod.summarizeSearchInfoError(raw), {
    title: '访问令牌鉴权失败',
    details: [
      '状态码：401',
      '请求：POST /adapter-service/search',
      '详情：访问令牌不存在'
    ]
  });
  assert.deepEqual(mod.summarizeSearchInfoError('network failed\nmore detail'), {
    title: 'network failed',
    details: []
  });
});
