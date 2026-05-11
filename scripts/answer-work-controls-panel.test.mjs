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
  assert.equal(source.includes("const uploadModeField = createConfigField(studyScript, 'upload', {"), true);
  assert.equal(source.includes("label: '完成后动作'"), true);
  assert.equal(source.includes("['submit', '自动提交']"), true);
  assert.equal(source.includes("['save', '自动保存']"), true);
  assert.equal(source.includes("const isCompactChoiceField = key === 'aiFallbackFailureAction' || key === 'upload';"), true);
  assert.equal(source.includes("optionGrid.style.gridTemplateColumns = '1fr';"), true);
  assert.equal(source.includes("const uploadModeField = createElement('label');"), false);
  assert.equal(source.includes("const uploadModeLabel = createElement('span', { text: '完成后动作' });"), false);
  assert.equal(source.includes("const actionModeRow = createElement('div');"), true);
  assert.equal(source.includes("actionModeRow.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';"), true);
  assert.equal(source.includes("actionModeRow.append(aiFallbackFailureActionField, uploadModeField);"), true);
});

test('common moves AI fallback controls from the study settings section into the work results control hero', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const aiFallbackToggleField = createConfigField(studyScript, 'enableAIFallbackAnswer', {"), true);
  assert.equal(source.includes("const aiAnswerRow = createElement('div');"), true);
  assert.equal(source.includes("aiAnswerRow.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';"), true);
  assert.equal(source.includes('aiAnswerRow.append(answerToggleField, aiFallbackToggleField);'), true);
  assert.equal(source.includes("const aiFallbackFailureActionField = createConfigField(studyScript, 'aiFallbackFailureAction', {"), true);
  assert.equal(source.includes("label: 'AI 兜底失败后行为'"), true);
  assert.equal(source.includes("['pause', '停留当前页']"), true);
  assert.equal(source.includes("['skip', '继续后续流程']"), true);
  assert.equal(source.includes("const isCompactChoiceField = key === 'aiFallbackFailureAction' || key === 'upload';"), true);
  assert.equal(source.includes("optionGrid.style.gridTemplateColumns = '1fr';"), true);
  assert.equal(source.includes('hero.append(heroTop, aiAnswerRow, actionModeRow, metricRow, heroActions);'), true);
  assert.equal(source.includes("const taskKeys = [\n    'enableMedia',\n    'enablePPT',\n    'enableChapterTest',\n    'enableRandomFallbackAnswer',\n    'enableAIFallbackAnswer'"), false);
  assert.equal(source.includes("const taskKeys = [\n    'enableMedia',\n    'enablePPT',\n    'enableChapterTest',\n    'enableRandomFallbackAnswer',\n    'aiFallbackFailureAction'"), false);
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

test('common watches shared config attributes so the floating panel updates live across pages', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const SHARED_STORE_ATTRIBUTE_PREFIX = 'data-chaoxing-plus-shared-';"), true);
  assert.equal(source.includes('new MutationObserver((mutations) => {'), true);
  assert.equal(source.includes('const shouldRefreshPanel = mutations.some(({ attributeName }) => {'), true);
  assert.equal(source.includes('return Boolean(attributeName?.startsWith(SHARED_STORE_ATTRIBUTE_PREFIX));'), true);
  assert.equal(source.includes('if (shouldRefreshPanel) {'), true);
  assert.equal(source.includes('renderWorkResultsPanel();'), true);
});

test('common shares all study settings across domains and warns for playback rate at or above 2x', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const SHARED_STUDY_SETTINGS_PREFIX = 'cx.new.study.';"), true);
  assert.equal(source.includes('function isSharedStudySettingKey(key: string) {'), true);
  assert.equal(source.includes('return key.startsWith(SHARED_STUDY_SETTINGS_PREFIX);'), true);
  assert.equal(source.includes('function syncStudySettingCrossDomain(key: string, value: unknown) {'), true);
  assert.equal(source.includes('if (isSharedStudySettingKey(storageKey)) {'), true);
  assert.equal(source.includes('syncStudySettingCrossDomain(storageKey, nextValue);'), true);
  assert.equal(source.includes("if (key === 'playbackRate' && options.warn !== false) {\n    void maybeWarnHighPlaybackRate(script, value);\n  }"), true);
  assert.equal(source.includes('if (!Number.isFinite(rate) || rate < 2 || hasWarnedHighPlaybackRateInCurrentPage) {'), true);
  assert.equal(source.includes("const confirmed = await $modal.confirm({"), true);
  assert.equal(source.includes("content: '当前倍速已达到或超过 2 倍。超星存在较强风控，高倍速可能导致进度清空、回退或学习异常，请谨慎使用。'"), true);
  assert.equal(source.includes("confirmButtonText: '继续使用'"), true);
  assert.equal(source.includes("cancelButtonText: '降到 1 倍'"), true);
  assert.equal(source.includes("setStudySettingValueInternal(script, 'playbackRate', 1, { warn: false });"), true);
});

