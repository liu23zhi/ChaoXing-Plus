import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const buildScriptPath = resolve(process.cwd(), 'build.mjs');
const commonPath = resolve(process.cwd(), 'src', 'projects', 'common.ts');
const workUtilPath = resolve(process.cwd(), 'src', 'utils', 'work.ts');
const typesPath = resolve(process.cwd(), 'src', 'types.d.ts');

test('build script injects the default tiku baseurl define', async () => {
  const source = await readFile(buildScriptPath, 'utf8');

  assert.equal(source.includes('process.env.DEFAULT_TIKU_BASE_URL'), true);
  assert.equal(source.includes('__DEFAULT_TIKU_BASE_URL__'), true);
  assert.equal(source.includes('define:'), true);
});

test('type declarations expose the injected tiku baseurl global', async () => {
  const source = await readFile(typesPath, 'utf8');

  assert.equal(source.includes('declare const __DEFAULT_TIKU_BASE_URL__: string;'), true);
});

test('common panel renders tiku adapter baseurl, key, save, and jump controls', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const saveButton = createElement('button', { text: '保存' });"), true);
  assert.equal(source.includes("saveButton.onclick = async () => {"), true);
  assert.equal(source.includes('题库配置已保存。'), true);
  assert.equal(source.includes('跳转'), true);
});

test('common settings build answerer wrappers from stored tiku adapter config', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes('createTikuAdapterAnswererWrapper'), true);
  assert.equal(source.includes('TIKU_ADAPTER_BASEURL_KEY'), true);
  assert.equal(source.includes('TIKU_ADAPTER_KEY_KEY'), true);
  assert.equal(source.includes('resolveTikuAdapterBaseUrl'), true);
});

test('empty-wrapper warning explains whether baseurl or key is missing', async () => {
  const source = await readFile(workUtilPath, 'utf8');

  assert.equal(source.includes('请先填写题库 key。'), true);
  assert.equal(source.includes('请先填写正确的题库 baseurl。'), true);
  assert.equal(source.includes('getTikuAdapterConfigProblem'), true);
});
