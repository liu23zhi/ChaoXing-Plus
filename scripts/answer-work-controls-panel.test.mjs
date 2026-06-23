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
  assert.equal(source.includes("item.style.borderLeft = index === state.workResults.currentResultIndex ? `4px solid ${panelPinkTheme.primary}` : '4px solid transparent';"), true);
  assert.equal(source.includes('formatWorkResultStatus(result)'), true);
});

test('common preserves work result scroll and retrying state across result refreshes', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("retrying: item.retrying ?? state.workResults.results[index]?.retrying ?? false"), true);
  assert.equal(source.includes('retrying: item.retrying ?? false'), false);
  assert.equal(source.includes("list.dataset.workResultsList = 'true';"), true);
  assert.equal(source.includes("const workResultsListScrollTop = panel.body.querySelector<HTMLElement>('[data-work-results-list=\"true\"]')?.scrollTop ?? 0;"), true);
  assert.equal(source.includes('panel.body.replaceChildren(createWorkResultsPanel());'), true);
  assert.equal(source.includes('panel.root.scrollTop = rootScrollTop;'), true);
  assert.equal(source.includes('panel.body.scrollTop = bodyScrollTop;'), true);
  assert.equal(source.includes('nextWorkResultsList.scrollTop = workResultsListScrollTop;'), true);
});

test('common work options default to submit and expose upload mode toggle in the study panel', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("upload: 'submit'"), true);
  assert.equal(source.includes('enableExamAutoSubmit: boolean;'), true);
  assert.equal(source.includes('enableDebugLogPanel: boolean;'), true);
  assert.equal(source.includes('enableLocalQuestionCache: boolean;'), true);
  assert.equal(source.includes('enableExamAutoSubmit: false'), true);
  assert.equal(source.includes('enableDebugLogPanel: false'), true);
  assert.equal(source.includes('enableLocalQuestionCache: true'), true);
  assert.equal(source.includes("upload: getStudySettingValue('upload', 'submit')"), true);
  assert.equal(source.includes("enableExamAutoSubmit: getStudySettingValue('enableExamAutoSubmit', stored.enableExamAutoSubmit ?? false)"), true);
  assert.equal(source.includes("enableDebugLogPanel: getStudySettingValue('enableDebugLogPanel', stored.enableDebugLogPanel ?? false)"), true);
  assert.equal(source.includes("enableLocalQuestionCache: getStudySettingValue('enableLocalQuestionCache', stored.enableLocalQuestionCache ?? true)"), true);
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

test('common exposes exam auto-submit and debug log switches in the panel', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("label: '考试自动交卷'"), true);
  assert.equal(source.includes("title: '开启后，考试答题完成且完成率满足提交条件时才会自动交卷。默认关闭。'"), true);
  assert.equal(source.includes("enableExamAutoSubmit: {\n      label: '考试自动交卷',\n      attrs: { type: 'checkbox', title: '开启后，考试答题完成且完成率满足提交条件时才会自动交卷。默认关闭。' },\n      defaultValue: false\n    }"), true);
  assert.equal(source.includes("label: '日志窗口'"), true);
  assert.equal(source.includes("title: '开启后在页面右下角显示调试日志窗口。默认关闭。'"), true);
  assert.equal(source.includes("const examAndDebugKeys = ['enableExamAutoSubmit', 'enableDebugLogPanel'];"), true);
  assert.equal(source.includes("createSettingsGroup('考试与诊断', '控制考试自动交卷权限和页面日志窗口。', examAndDebugKeys)"), true);
  assert.equal(source.includes("enableExamAutoSubmit: getStudySettingValue('enableExamAutoSubmit', false)"), true);
  assert.equal(source.includes("enableDebugLogPanel: getStudySettingValue('enableDebugLogPanel', false)"), true);
  assert.equal(source.includes("const examAutoSubmitToggleField = createConfigField(studyScript, 'enableExamAutoSubmit', {"), true);
  assert.equal(source.includes("const debugLogPanelToggleField = createConfigField(studyScript, 'enableDebugLogPanel', {"), true);
  assert.equal(source.includes("const examAndDebugRow = createElement('div');"), true);
  assert.equal(source.includes('examAndDebugRow.append(examAutoSubmitToggleField, debugLogPanelToggleField, localQuestionCacheToggleField);'), true);
  assert.equal(source.includes('hero.append(heroTop, aiAnswerRow, actionModeRow, examAndDebugRow, metricRow, heroActions);'), true);
});

test('common exposes a default-enabled local question cache switch and gates cache reads', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("label: '本地题库缓存'"), true);
  assert.equal(source.includes("title: '开启后优先使用本地已缓存题目答案。默认开启。'"), true);
  assert.equal(source.includes("const cacheKeys = ['enableLocalQuestionCache'];"), true);
  assert.equal(source.includes("createSettingsGroup('题库缓存', '控制是否优先使用本地缓存命中题目答案。', cacheKeys)"), true);
  assert.equal(source.includes("enableLocalQuestionCache: getStudySettingValue('enableLocalQuestionCache', true)"), true);
  assert.equal(source.includes("const localQuestionCacheToggleField = createConfigField(studyScript, 'enableLocalQuestionCache', {"), true);
  assert.equal(source.includes('examAndDebugRow.append(examAutoSubmitToggleField, debugLogPanelToggleField, localQuestionCacheToggleField);'), true);
  assert.equal(source.includes("function isLocalQuestionCacheEnabled()"), true);
  assert.equal(source.includes("return getStudySettingValue('enableLocalQuestionCache', true);"), true);
  assert.equal(source.includes('if (!isLocalQuestionCacheEnabled()) {'), true);
  assert.equal(source.includes('return provider().then((result) => {'), true);
  assert.equal(source.includes('if (Array.isArray(result)) {'), true);
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
  assert.equal(source.includes('hero.append(heroTop, aiAnswerRow, actionModeRow, examAndDebugRow, metricRow, heroActions);'), true);
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
  assert.match(source, /if \(key === 'playbackRate' && options\.warn !== false\) \{\s+void maybeWarnHighPlaybackRate\(script, value\);\s+\}/);
  assert.equal(source.includes('if (!Number.isFinite(rate) || rate < 2 || hasWarnedHighPlaybackRateInCurrentPage) {'), true);
  assert.equal(source.includes("const confirmed = await $modal.confirm({"), true);
  assert.equal(source.includes("content: '当前倍速已达到或超过 2 倍。超星存在较强风控，高倍速可能导致进度清空、回退或学习异常，请谨慎使用。'"), true);
  assert.equal(source.includes("confirmButtonText: '继续使用'"), true);
  assert.equal(source.includes("cancelButtonText: '降到 1 倍'"), true);
  assert.equal(source.includes("setStudySettingValueInternal(script, 'playbackRate', 1, { warn: false });"), true);
});

