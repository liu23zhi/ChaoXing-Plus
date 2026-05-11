import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const commonPath = resolve(scriptsDir, '..', 'src', 'projects', 'common.ts');

test('common work results panel renders pause continue and retry controls', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const pauseButton = createElement('button', { text: isPaused ? '继续答题' : '暂停答题' });"), true);
  assert.equal(source.includes("const retryButton = createElement('button', { text: result.retrying ? '正在重答...' : '重答本题' });"), true);
  assert.equal(source.includes('setRuntimeControls(controls: WorkResultsRuntimeControls)'), true);
  assert.equal(source.includes('clearRuntimeControls()'), true);
  assert.equal(source.includes('patchResult(index: number, patch: Partial<SimplifyWorkResult>)'), true);
});

test('common work results panel uses the shared tone helper for number and question views', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const tone = resolveWorkResultTone(result, index === state.workResults.currentResultIndex);"), true);
  assert.equal(source.includes("if (tone === 'manual')"), true);
  assert.equal(source.includes("if (tone === 'danger')"), true);
  assert.equal(source.includes("item.style.borderLeft = index === state.workResults.currentResultIndex ? '4px solid #2563eb' : '4px solid transparent';"), true);
  assert.equal(source.includes('formatWorkResultStatus(result)'), true);
});

test('common work options default to submit and expose upload mode toggle in the study panel', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("upload: 'submit'"), true);
  assert.equal(source.includes("upload: getStudySettingValue('upload', 'submit')"), true);
  assert.equal(source.includes("const uploadModeField = createConfigField(studyScript, 'upload', {"), false);
  assert.equal(source.includes('uploadModeField.append(uploadModeSelect);'), false);
  assert.equal(source.includes("const uploadModeField = createElement('label');"), true);
  assert.equal(source.includes("const uploadModeLabel = createElement('span', { text: '完成后动作' });"), true);
  assert.equal(source.includes("option.value = value;"), true);
  assert.equal(source.includes("option.textContent = value === 'submit' ? '自动提交' : '自动保存';"), true);
});

test('common study panel exposes random fallback and ai fallback controls', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes('enableRandomFallbackAnswer'), true);
  assert.equal(source.includes("label: '无答案时随机作答'"), true);
  assert.equal(source.includes("defaultValue: false"), true);
  assert.equal(source.includes('enableAIFallbackAnswer'), true);
  assert.equal(source.includes("label: 'AI 兜底搜题'"), true);
  assert.equal(source.includes('aiFallbackFailureAction'), true);
  assert.equal(source.includes("label: 'AI 兜底失败后行为'"), true);
});

test('common only warns high playback rate on user setting changes and only once per page load', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes('let hasWarnedHighPlaybackRateInCurrentPage = false;'), true);
  assert.equal(source.includes('if (!Number.isFinite(rate) || rate < 2 || hasWarnedHighPlaybackRateInCurrentPage) {'), true);
  assert.equal(source.includes('hasWarnedHighPlaybackRateInCurrentPage = true;'), true);
  assert.equal(source.includes('const STUDY_PLAYBACK_RATE_WARNING_ACK_KEY'), false);
  assert.equal(source.includes('runtimeStore.get(STUDY_PLAYBACK_RATE_WARNING_ACK_KEY, 0)'), false);
  assert.equal(source.includes('runtimeStore.set(STUDY_PLAYBACK_RATE_WARNING_ACK_KEY, rate)'), false);
  assert.equal(source.includes("void $modal.alert('当前倍速已达到或超过 2 倍。超星存在较强风控，高倍速可能导致进度清空、回退或学习异常，请谨慎使用。');"), true);
  assert.equal(source.includes("if (key === 'playbackRate') {\n    maybeWarnHighPlaybackRate(value);\n  }"), true);
});

