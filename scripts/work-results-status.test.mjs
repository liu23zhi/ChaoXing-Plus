import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const helperModulePaths = [
  resolve(process.cwd(), '.tmp-tests', 'work-results-status.js'),
  resolve(process.cwd(), '.tmp-tests', 'projects', 'work-results-status.js')
];

async function loadHelperModule() {
  for (const helperModulePath of helperModulePaths) {
    try {
      return await import(pathToFileURL(helperModulePath).href);
    } catch {
      // try next compiled location
    }
  }

  return {};
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

test('selected tone overrides every other status with blue', async () => {
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
  assert.equal(mod.formatWorkResultStatus(createResult({ manual: true })), '已人工答题');
  assert.equal(mod.formatWorkResultStatus(createResult({ retrying: true })), '正在重答...');
  assert.equal(
    mod.formatWorkResultStatus(createResult({ requested: true, searchInfos: [] })),
    '未搜索到答案'
  );
});
