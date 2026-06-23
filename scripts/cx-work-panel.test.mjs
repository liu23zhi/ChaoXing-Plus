import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cxProjectPath = resolve(scriptsDir, '..', 'src', 'projects', 'cx.ts');

test('work script hides its standalone runtime panel so work pages reuse common results panel', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  const workScriptBlock = source.match(/work:\s*\{[\s\S]*?autoRead:\s*\{/);

  assert.notEqual(workScriptBlock, null);
  assert.equal(workScriptBlock[0].includes('hideInPanel: true'), true);
});

test('study clears work results before moving to the next chapter page', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('const resetWorkResults = () => {'), true);
  assert.equal(source.includes('workResultsMethods().clearRuntimeControls?.();'), true);
  assert.equal(source.includes('workResultsMethods().setResults?.([]);'), true);
  assert.equal(source.includes('resetWorkResults();'), true);
});

test('cx clears stale work result questions when study or work pages load before rendering detected questions', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('function clearWorkResultsOnPageLoad()'), true);
  assert.equal(source.includes('clearWorkResultsOnPageLoad();'), true);
  assert.equal(source.includes('export async function study(opts: StudyOptions) {\n  clearWorkResultsOnPageLoad();'), true);
  assert.equal(source.includes("oncomplete() {\n        clearWorkResultsOnPageLoad();\n        const isExam = /\\/exam\\/preview/.test(location.href);"), true);
  assert.equal(source.includes('workResultsMethods().init?.();'), true);
  assert.equal(source.includes('workResultsMethods().setResults?.(simplified);'), true);
  assert.equal(source.includes('workResultsMethods().appendResults?.(simplified);'), true);
});

test('workOrExam uses step-by-step exam selectors and ignores generic type distractors', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes("const workOrExamTitleSelector = !preview_mode"), true);
  assert.equal(source.includes("'.splitS-left .mark_name'"), true);
  assert.equal(source.includes("'.line_wid_half.fl,.line_wid_half.fr'"), true);
  assert.equal(source.includes('function resolveWorkOrExamQuestionTypeRoot('), true);
  assert.equal(source.includes("elements.type.find((element) => element.getAttribute('name')?.match(/type\\d+/))"), true);
  assert.equal(source.includes('resolveWorkOrExamQuestionTypeRoot(elements) ?? elements.options[0]?.closest(\'.questionLi\') ?? document'), true);
});

test('workOrExam applies choice answers with native click before synthetic fallback', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('function isWorkOrExamChoiceChecked('), true);
  assert.equal(source.includes('const checkedBeforeClick = isWorkOrExamChoiceChecked(option);'), true);
  assert.equal(source.includes('option.click();'), true);
  assert.equal(source.includes('checkedAfterNativeClick = isWorkOrExamChoiceChecked(option);'), true);
  assert.equal(source.includes('triggerSyntheticClick(option);'), true);
  assert.equal(source.includes('作业/考试选项应用诊断'), true);
});

test('workOrExam auto uploads work and exam results after answering', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('async function uploadWorkOrExamResults(results:'), true);
  assert.equal(source.includes("const shouldAllowSubmitForPage = upload === 'submit' && (type !== 'exam' || enableExamAutoSubmit);"), true);
  assert.equal(source.includes("const uploadHandlerType = shouldAllowSubmitForPage ? 100 : upload === 'submit' ? 'save' : upload;"), true);
  assert.equal(source.includes('type: uploadHandlerType,'), true);
  assert.equal(source.includes('const shouldSubmit = shouldAllowSubmitForPage && uploadable;'), true);
  assert.equal(source.includes('submitWorkOrExamPage(type);'), true);
  assert.equal(source.includes('saveWorkOrExamPage(type);'), true);
  assert.equal(source.includes('const results = await worker.doWork();'), true);
  assert.equal(source.includes('const retryableResults = await retryUnfinishedWorkOrExamQuestions(results);'), true);
  assert.equal(source.includes('await uploadWorkOrExamResults(retryableResults);'), true);
  assert.equal(source.includes('const accumulatedResults = [];'), true);
  assert.equal(source.includes('accumulatedResults.push(...results);'), true);
  assert.equal(source.includes('await uploadWorkOrExamResults(accumulatedResults);'), true);
});

test('workOrExam gates exam auto-submit behind the panel switch', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('enableExamAutoSubmit,'), true);
  assert.equal(source.includes("const shouldAllowSubmitForPage = upload === 'submit' && (type !== 'exam' || enableExamAutoSubmit);"), true);
  assert.equal(source.includes("const uploadHandlerType = shouldAllowSubmitForPage ? 100 : upload === 'submit' ? 'save' : upload;"), true);
  assert.equal(source.includes("const examAutoSubmitBlocked = upload === 'submit' && type === 'exam' && !enableExamAutoSubmit;"), true);
  assert.equal(source.includes('enableExamAutoSubmit,'), true);
  assert.equal(source.includes('examAutoSubmitBlocked,'), true);
  assert.equal(source.includes('uploadHandlerType,'), true);
});

test('workOrExam submits through the window that owns chaoxing submit functions', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('function getWorkOrExamRuntimeWindowCandidates('), true);
  assert.equal(source.includes('function findWorkOrExamRuntimeWindow('), true);
  assert.equal(source.includes("findWorkOrExamRuntimeWindow(['btnBlueSubmit', 'submitCheckTimes'])"), true);
  assert.equal(source.includes("findWorkOrExamRuntimeWindow(['noSubmit'])"), true);
  assert.equal(source.includes('runtimeWindowSource'), true);
  assert.equal(source.includes('candidateWindowHasFunction(candidate.window, name)'), true);
});

test('workOrExam fallback submit confirms chaoxing popup before retrying generic submit buttons', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('function clickWorkOrExamSubmitConfirmButton('), true);
  assert.equal(source.includes("doc.querySelector<HTMLElement>('#popok')"), true);
  assert.equal(source.includes("doc.querySelector<HTMLElement>('#workpop')"), true);
  assert.equal(source.includes("'#submitConfirmPop'"), true);
  assert.equal(source.includes('function isWorkOrExamConfirmRejectElement('), true);
  assert.equal(source.includes('!isWorkOrExamConfirmRejectElement(element)'), true);
  assert.equal(source.includes('const confirmationFallback = clickWorkOrExamSubmitConfirmButton();'), true);
  assert.equal(source.includes("confirmationFallback.clicked ? confirmationFallback : clickWorkOrExamActionButton('submit')"), true);
  assert.equal(source.includes('fallbackConfirmClicked'), true);
});

test('workOrExam fallback submit logs visible enabled click targets', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('function describeWorkOrExamClickTarget('), true);
  assert.equal(source.includes('function isWorkOrExamClickableElement('), true);
  assert.equal(source.includes('const workOrExamClickableSelector ='), true);
  assert.equal(source.includes("element.matches(workOrExamClickableSelector)"), true);
  assert.equal(source.includes('return isElementVisible(element) && element.matches(workOrExamClickableSelector) && !element.matches(\':disabled,[disabled],[aria-disabled="true"]\');'), true);
  assert.equal(source.includes('firstFallbackSubmitTarget'), true);
  assert.equal(source.includes('confirmationFallbackTarget'), true);
});

test('workOrExam exposes an on-page debug log panel for submit diagnostics', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes("const debugLogPanelSettingKey = 'cx.new.study.enableDebugLogPanel';"), true);
  assert.equal(source.includes('const debugLogPanelDefaultEnabled = false;'), true);
  assert.equal(source.includes('function isDebugLogPanelEnabled('), true);
  assert.equal(source.includes('runtimeStore.get(debugLogPanelSettingKey, debugLogPanelDefaultEnabled)'), true);
  assert.equal(source.includes('function getSharedRuntimeStoreAttributeName(key: string)'), true);
  assert.equal(source.includes("return `data-chaoxing-plus-shared-${key.replace(/[^a-z0-9_-]/gi, '-')}`;"), true);
  assert.equal(source.includes('const sharedDebugLogPanelAttribute = getSharedRuntimeStoreAttributeName(debugLogPanelSettingKey);'), true);
  assert.equal(source.includes('function syncDebugLogPanelVisibility('), true);
  assert.equal(source.includes('removeDebugLogPanel();'), true);
  assert.equal(source.includes('ensureDebugLogPanel();'), true);
  assert.equal(source.includes('function getDebugLogPanelSyncDocuments()'), true);
  assert.equal(source.includes('for (const syncDocument of getDebugLogPanelSyncDocuments()) {'), true);
  assert.equal(source.includes('debugLogPanelObserver.observe(syncDocument.documentElement, { attributes: true });'), true);
  assert.equal(source.includes("syncDocument.addEventListener('chaoxing-plus:shared-store-sync', syncDebugLogPanelVisibility);"), true);
  assert.equal(source.includes("syncDocument.addEventListener('chaoxing-plus:shared-store-hydrate', syncDebugLogPanelVisibility);"), true);
  assert.equal(source.includes("window.addEventListener('storage', (event) => {"), true);
  assert.equal(source.includes('if (event.key === debugLogPanelSettingKey) {'), true);
  assert.equal(source.includes('new MutationObserver((mutations) => {'), true);
  assert.equal(source.includes('return attributeName === sharedDebugLogPanelAttribute;'), true);
  assert.equal(source.includes('syncDebugLogPanelVisibility();'), true);
  assert.equal(source.includes("const debugLogPanelLevel: DebugLogLevel = 'debug';"), true);
  assert.equal(source.includes('function ensureDebugLogPanel('), true);
  assert.equal(source.includes('function removeDebugLogPanel('), true);
  assert.equal(source.includes("debugLogPanelBody.dataset.cxDebugLogPanelBody = 'true';"), true);
  assert.equal(source.includes('function collectDebugLogPanelText('), true);
  assert.equal(source.includes("copyButton.textContent = '复制';"), true);
  assert.equal(source.includes('navigator.clipboard.writeText(text);'), true);
  assert.equal(source.includes("targetDocument.execCommand('copy');"), true);
  assert.equal(source.includes('appendDebugLogPanelEntry(level, prefix, enrichedDetail, textDetail, meta);'), true);
  assert.equal(source.includes('作业/考试提交判定诊断'), true);
  assert.equal(source.includes('作业/考试提交函数诊断'), true);
});
