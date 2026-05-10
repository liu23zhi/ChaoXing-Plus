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

  assert.equal(source.includes("process.env.DEFAULT_TIKU_BASE_URL ?? 'https://tiku.zelly.cn/'"), true);
  assert.equal(source.includes('__DEFAULT_TIKU_BASE_URL__'), true);
  assert.equal(source.includes('define:'), true);
});

test('type declarations expose the injected tiku baseurl global', async () => {
  const source = await readFile(typesPath, 'utf8');

  assert.equal(source.includes('declare const __DEFAULT_TIKU_BASE_URL__: string;'), true);
});

test('common panel renders updated tiku adapter labels and bottom action buttons', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const baseurlLabel = createElement('label', { text: '题库地址' });"), true);
  assert.equal(source.includes("const keyLabel = createElement('label', { text: '令牌' });"), true);
  assert.equal(source.includes('这里的设置会直接作用于当前学习流程。'), true);
  assert.equal(source.includes('默认对接 POST {baseurl}/adapter-service/search'), false);
  assert.equal(source.includes('开关项已改为状态方块，选择项改为平铺按钮，便于快速切换。'), false);
  assert.equal(source.includes('const actionsRow = createElement(\'div\');'), true);
  assert.equal(source.includes('actionsRow.append(saveButton, jumpButton);'), true);
  assert.equal(source.includes('container.append(header, baseurlWrap, keyWrap, actionsRow);'), true);
  assert.equal(source.includes('baseurlRow.append(baseurlInput);'), true);
  assert.equal(source.includes('题库配置已保存。'), true);
});

test('common panel defines a shared wrap style for long question text', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes('function applyQuestionTextWrapStyle(element: HTMLElement)'), true);
  assert.equal(source.includes("element.style.whiteSpace = 'normal';"), true);
  assert.equal(source.includes("element.style.overflowWrap = 'anywhere';"), true);
  assert.equal(source.includes("element.style.wordBreak = 'break-word';"), true);
});

test('common panel applies the shared wrap style to work-result and tiku question text', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const title = createElement('div', { text: result.question || '未识别题目' });"), true);
  assert.equal(source.includes('applyQuestionTextWrapStyle(title);'), true);
  assert.equal(source.includes("const question = createElement('div', { text: entry[0] || '' });"), true);
  assert.equal(source.includes('applyQuestionTextWrapStyle(question);'), true);
});

test('common panel applies the shared wrap style to long tiku error text', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes('text: info.error ? `错误：${info.error}` : `结果数：${info.results.length}`'), true);
  assert.equal(source.includes('applyQuestionTextWrapStyle(sub);'), true);
});

test('common panel applies the shared wrap style to top-level work-result errors and app cache links', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const error = createElement('div', { text: result.error });"), true);
  assert.equal(source.includes('applyQuestionTextWrapStyle(error);'), true);
  assert.equal(source.includes('link.textContent = cache.homepage;'), true);
  assert.equal(source.includes('applyQuestionTextWrapStyle(link);'), true);
});

test('common panel applies the shared wrap style to cache source metadata in both panels', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const meta = createElement('div', { text: `来源：${cache.from || '未知题库'}` });"), true);
  assert.equal(source.includes('applyQuestionTextWrapStyle(meta);'), true);
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

test('missing-key warning offers a jump action to the configured tiku baseurl', async () => {
  const source = await readFile(workUtilPath, 'utf8');

  assert.equal(source.includes('denyButtonText: problem === \'missing-key\' ? \'跳转\' : undefined'), true);
  assert.equal(source.includes("window.open(baseurl, '_blank', 'noopener,noreferrer');"), true);
  assert.equal(source.includes('void $modal.alert({'), true);
});

test('tiku adapter config exposes AI fallback request helpers and standardized error parsing', async () => {
  const source = await readFile(commonPath, 'utf8');
  const configSource = await readFile(resolve(process.cwd(), 'src', 'projects', 'tiku-adapter-config.ts'), 'utf8');

  assert.equal(source.includes('AI 兜底搜题'), true);
  assert.equal(source.includes('AI 兜底失败后行为'), true);
  assert.equal(configSource.includes('createTikuAdapterAIFallbackUrl'), true);
  assert.equal(configSource.includes('requestTikuAdapterAIFallback'), true);
  assert.equal(configSource.includes('type TikuAdapterAIFallbackErrorCode ='), true);
});
