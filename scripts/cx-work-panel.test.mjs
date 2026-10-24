import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cxProjectPath = resolve(scriptsDir, '..', 'src', 'projects', 'cx.ts');

// 源码检出可能是 CRLF，断言只关心代码结构，先统一换行再比较。
async function readCxSource() {
  return (await readFile(cxProjectPath, 'utf8')).replace(/\r\n/g, '\n');
}

async function loadCxFunction(name, context) {
  const source = await readCxSource();
  const parsed = ts.createSourceFile(cxProjectPath, source, ts.ScriptTarget.Latest, true);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      declaration = node.getText(parsed);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(declaration, `Expected ${name} function in cx.ts`);
  const code = ts.transpileModule(declaration, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  vm.runInContext(code, context);
  return context[name];
}

test('work script hides its standalone runtime panel so work pages reuse common results panel', async () => {
  const source = await readCxSource();

  const workScriptBlock = source.match(/work:\s*\{[\s\S]*?autoRead:\s*\{/);

  assert.notEqual(workScriptBlock, null);
  assert.equal(workScriptBlock[0].includes('hideInPanel: true'), true);
});

test('study clears work results before moving to the next chapter page', async () => {
  const source = await readCxSource();

  assert.equal(source.includes('const resetWorkResults = () => {'), true);
  assert.equal(source.includes('workResultsMethods().clearRuntimeControls?.();'), true);
  assert.equal(source.includes('workResultsMethods().setResults?.([]);'), true);
  assert.equal(source.includes('resetWorkResults();'), true);
});

test('cx clears stale work result questions when study or work pages load before rendering detected questions', async () => {
  const source = await readCxSource();

  assert.equal(source.includes('function clearWorkResultsOnPageLoad()'), true);
  assert.equal(source.includes('clearWorkResultsOnPageLoad();'), true);
  assert.equal(source.includes('export async function study(opts: StudyOptions) {\n  clearWorkResultsOnPageLoad();'), true);
  assert.equal(source.includes("oncomplete() {\n        clearWorkResultsOnPageLoad();\n        const isExam = /\\/exam\\/preview/.test(location.href);"), true);
  assert.equal(source.includes('workResultsMethods().init?.();'), true);
  assert.equal(source.includes('workResultsMethods().setResults?.(simplified);'), true);
  assert.equal(source.includes('workResultsMethods().appendResults?.(simplified);'), true);
});

test('chapter, preview, and step-by-step work publish initialized questions before search', async () => {
  const source = await readCxSource();

  assert.equal(source.includes('async onResultsInitialized(res) {'), true);
  assert.equal(source.includes('workResultsMethods().setResults?.(simplified);'), true);
  assert.equal(source.includes('workResultsMethods().appendResults?.(simplified);'), true);
  assert.equal(source.includes('const currentBatchStart = Math.max(0, currentResults.length - results.length);'), true);
  assert.equal(source.includes('workResultsMethods().setResults?.([...currentResults.slice(0, currentBatchStart), ...results]);'), true);
});

test('step-by-step updates replace the current page batch without losing accumulated results or duplicating questions', async () => {
  const state = { results: [] };
  const context = vm.createContext({
    state,
    workResultsMethods: () => ({
      getResults: () => state.results,
      setResults: (results) => { state.results = results; }
    })
  });
  const replaceCurrentWorkResults = await loadCxFunction('replaceCurrentWorkResults', context);

  state.results.push(
    { question: '已完成题目', requested: true, resolved: true, finish: true },
    { question: '当前题目', requested: false, resolved: false }
  );
  replaceCurrentWorkResults([{ question: '当前题目', requested: false, searching: true }]);
  replaceCurrentWorkResults([{ question: '当前题目', requested: true, resolved: false }]);

  assert.equal(state.results.length, 2);
  assert.equal(state.results[0].question, '已完成题目');
  assert.equal(state.results[0].finish, true);
  assert.equal(state.results[1].question, '当前题目');
  assert.equal(state.results[1].requested, true);

  state.results.push({ question: '下一题', requested: false, resolved: false });
  replaceCurrentWorkResults([{ question: '下一题', requested: false, searching: true }]);
  assert.equal(state.results.length, 3);
  assert.deepEqual(Array.from(state.results, (item) => item.question), ['已完成题目', '当前题目', '下一题']);
});

test('step-by-step work processes the current page once even when no next button exists', async () => {
  const context = vm.createContext({});
  const collectStepwiseWorkResults = await loadCxFunction('collectStepwiseWorkResults', context);
  let processedPages = 0;
  let nextButtonChecks = 0;

  const results = await collectStepwiseWorkResults({
    runCurrentPage: async () => [{ page: ++processedPages }],
    hasCurrentPage: () => true,
    getNextButton: () => { nextButtonChecks++; return null; },
    waitAfterPage: async () => {},
    advancePage: async () => assert.fail('must not advance without a next button')
  });

  assert.equal(processedPages, 1);
  assert.equal(nextButtonChecks, 1);
  assert.deepEqual(Array.from(results, (result) => result.page), [1]);
});

test('step-by-step work processes and advances every page including the final page without a next button', async () => {
  const context = vm.createContext({});
  const collectStepwiseWorkResults = await loadCxFunction('collectStepwiseWorkResults', context);
  let page = 0;
  const advanced = [];

  const results = await collectStepwiseWorkResults({
    runCurrentPage: async () => [{ page: ++page }],
    hasCurrentPage: () => page < 2,
    getNextButton: () => page === 1 ? 'next' : null,
    waitAfterPage: async () => {},
    advancePage: async (button) => { advanced.push(button); }
  });

  assert.deepEqual(advanced, ['next']);
  assert.deepEqual(Array.from(results, (result) => result.page), [1, 2]);
});

test('step-by-step collection stops before checking or advancing the next page when paused', async () => {
  const context = vm.createContext({});
  const collectStepwiseWorkResults = await loadCxFunction('collectStepwiseWorkResults', context);
  let pageChecks = 0;
  let nextButtonChecks = 0;
  let advances = 0;
  let paused = false;
  let pageDone = false;
  const results = await collectStepwiseWorkResults({
    runCurrentPage: async () => { paused = true; return [{ page: 1 }]; },
    hasCurrentPage: () => { pageChecks++; return !pageDone; },
    shouldContinue: () => !paused,
    getNextButton: () => { nextButtonChecks++; return 'next'; },
    waitAfterPage: async () => {},
    advancePage: async () => { advances++; pageDone = true; }
  });

  assert.equal(pageChecks, 1);
  assert.equal(nextButtonChecks, 0);
  assert.equal(advances, 0);
  assert.deepEqual(Array.from(results), [{ page: 1 }]);
});

test('step-by-step worker stays balance-tracked through page runs and releases after the task', async () => {
  const source = await readCxSource();

  assert.equal(source.includes("const worker = createWorkOrExamWorker('.questionLi', { retainForBalanceRecovery: !preview_mode });"), true);
  assert.match(source, /\}\)\(\)\.finally\(\(\) => \{\s+untrackTikuAdapterWorker\(worker\);\s+clearRuntimeControls\(\);\s+\}\);/u);
});

test('chapter, preview, and step-by-step results refresh after retries and before save or submit', async () => {
  const source = await readCxSource();
  const chapterRetry = source.indexOf('const retryableResults = await retryUnfinishedChapterQuestions(results);');
  const previewRetry = source.indexOf('const retryableResults = await retryUnfinishedWorkOrExamQuestions(results);');
  const stepRetry = source.indexOf('notifyManualAnswerRequired(accumulatedResults);');
  const chapterRefresh = source.indexOf('workResultsMethods().refresh?.();', chapterRetry);
  const previewRefresh = source.indexOf('workResultsMethods().refresh?.();', previewRetry);
  const stepRefresh = source.indexOf('workResultsMethods().refresh?.();', stepRetry);

  assert.ok(chapterRetry >= 0);
  assert.ok(previewRetry >= 0);
  assert.ok(stepRetry >= 0);
  assert.ok(chapterRefresh > chapterRetry);
  assert.ok(chapterRefresh < source.indexOf('await sleep(stopSecondWhenFinish * 1000);', chapterRetry));
  assert.ok(previewRefresh > previewRetry);
  assert.ok(previewRefresh < source.indexOf('await uploadWorkOrExamResults(retryableResults);', previewRetry));
  assert.ok(stepRefresh > stepRetry);
  assert.ok(stepRefresh < source.indexOf('await uploadWorkOrExamResults(accumulatedResults);', stepRetry));
});

test('balance pause guards chapter, preview, and stepwise upload plus stepwise page navigation', async () => {
  const source = await readCxSource();

  assert.match(source, /const retryableResults = await retryUnfinishedChapterQuestions\(results\);\s+await waitForTikuAdapterBalanceRecovery\(\);/u);
  assert.match(source, /const retryableResults = await retryUnfinishedWorkOrExamQuestions\(results\);\s+await waitForTikuAdapterBalanceRecovery\(\);/u);
  assert.match(source, /shouldContinue: \(\) => !tikuAdapterBalanceRecoveryState\.paused,/u);
  assert.match(source, /waitForContinue: waitForTikuAdapterBalanceRecovery,/u);
  assert.match(source, /await uploadWorkOrExamResults\(accumulatedResults\);/u);
  assert.match(source, /async function uploadWorkOrExamResults\(results:[\s\S]*?await waitForTikuAdapterBalanceRecovery\(\);/u);
});

test('runtime controls remain available while an automatic retry is paused for balance recovery', async () => {
  const source = await readCxSource();

  assert.equal(source.match(/isRunning: \(\) => worker\.isRunning \|\| tikuAdapterBalanceRecoveryState\.paused,/gu)?.length, 3);
  assert.equal(source.match(/isStopped: \(\) => worker\.isStop \|\| tikuAdapterBalanceRecoveryState\.paused,/gu)?.length, 3);
  assert.doesNotMatch(source, /worker\.on\('done', clearRuntimeControls\);/u);
});

test('work and exam upload waits through a balance pause before upload and before submit or save', async () => {
  const runScenario = async (uploadMode, pauseAtSleep) => {
    let paused = false;
    let sleepCalls = 0;
    let uploadCalls = 0;
    let submitCalls = 0;
    let saveCalls = 0;
    const context = vm.createContext({
      tikuAdapterBalanceRecoveryState: { paused },
      preview_mode: false,
      waitForTikuAdapterBalanceRecovery: async () => {
        while (context.tikuAdapterBalanceRecoveryState.paused) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      },
      upload: uploadMode,
      type: 'work',
      enableExamAutoSubmit: true,
      stopSecondWhenFinish: 0,
      worker: {
        async uploadHandler({ callback }) {
          uploadCalls++;
          await callback(100, true);
        }
      },
      sleep: async () => {
        if (++sleepCalls === pauseAtSleep) {
          context.tikuAdapterBalanceRecoveryState.paused = true;
        }
      },
      $console: { info() {} },
      $message: { info() {}, success() {} },
      logDebug() {},
      workExamCorrelationId: '',
      submitWorkOrExamPage: async () => { submitCalls++; },
      saveWorkOrExamPage: async () => { saveCalls++; }
    });
    const uploadWorkOrExamResults = await loadCxFunction('uploadWorkOrExamResults', context);
    const running = uploadWorkOrExamResults([]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(submitCalls, 0);
    assert.equal(saveCalls, 0);
    if (pauseAtSleep === 1) {
      assert.equal(uploadCalls, 0, 'must not reach the upload handler while paused');
    } else {
      assert.equal(uploadCalls, 1, 'pause occurred inside the upload callback delay');
    }

    context.tikuAdapterBalanceRecoveryState.paused = false;
    await running;
    assert.equal(submitCalls, uploadMode === 'submit' ? 1 : 0);
    assert.equal(saveCalls, uploadMode === 'save' ? 1 : 0);
  };

  for (const uploadMode of ['submit', 'save']) {
    await runScenario(uploadMode, 1);
    await runScenario(uploadMode, 2);
  }
});

test('workOrExam uses step-by-step exam selectors and ignores generic type distractors', async () => {
  const source = await readCxSource();

  assert.equal(source.includes("const workOrExamTitleSelector = !preview_mode"), true);
  assert.equal(source.includes("'.splitS-left .mark_name'"), true);
  assert.equal(source.includes("'.line_wid_half.fl,.line_wid_half.fr'"), true);
  assert.equal(source.includes('function resolveWorkOrExamQuestionTypeRoot('), true);
  assert.equal(source.includes("elements.type.find((element) => element.getAttribute('name')?.match(/type\\d+/))"), true);
  assert.equal(source.includes('resolveWorkOrExamQuestionTypeRoot(elements) ?? elements.options[0]?.closest(\'.questionLi\') ?? document'), true);
});

test('workOrExam applies choice answers with native click before synthetic fallback', async () => {
  const source = await readCxSource();

  assert.equal(source.includes('function isWorkOrExamChoiceChecked('), true);
  assert.equal(source.includes('const checkedBeforeClick = isWorkOrExamChoiceChecked(option);'), true);
  assert.equal(source.includes('option.click();'), true);
  assert.equal(source.includes('checkedAfterNativeClick = isWorkOrExamChoiceChecked(option);'), true);
  assert.equal(source.includes('triggerSyntheticClick(option);'), true);
  assert.equal(source.includes('作业/考试选项应用诊断'), true);
});

test('workOrExam auto uploads work and exam results after answering', async () => {
  const source = await readCxSource();

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
  assert.equal(source.includes('const accumulatedResults = await collectStepwiseWorkResults({'), true);
  assert.equal(source.includes('runCurrentPage: () => worker.doWork({ enable_debug: false }),'), true);
  assert.equal(source.includes('await uploadWorkOrExamResults(accumulatedResults);'), true);
});

test('workOrExam gates exam auto-submit behind the panel switch', async () => {
  const source = await readCxSource();

  assert.equal(source.includes('enableExamAutoSubmit,'), true);
  assert.equal(source.includes("const shouldAllowSubmitForPage = upload === 'submit' && (type !== 'exam' || enableExamAutoSubmit);"), true);
  assert.equal(source.includes("const uploadHandlerType = shouldAllowSubmitForPage ? 100 : upload === 'submit' ? 'save' : upload;"), true);
  assert.equal(source.includes("const examAutoSubmitBlocked = upload === 'submit' && type === 'exam' && !enableExamAutoSubmit;"), true);
  assert.equal(source.includes('enableExamAutoSubmit,'), true);
  assert.equal(source.includes('examAutoSubmitBlocked,'), true);
  assert.equal(source.includes('uploadHandlerType,'), true);
});

test('workOrExam submits through the window that owns chaoxing submit functions', async () => {
  const source = await readCxSource();

  assert.equal(source.includes('function getWorkOrExamRuntimeWindowCandidates('), true);
  assert.equal(source.includes('function findWorkOrExamRuntimeWindow('), true);
  assert.equal(source.includes("findWorkOrExamRuntimeWindow(['btnBlueSubmit', 'submitCheckTimes'])"), true);
  assert.equal(source.includes("findWorkOrExamRuntimeWindow(['noSubmit'])"), true);
  assert.equal(source.includes('runtimeWindowSource'), true);
  assert.equal(source.includes('candidateWindowHasFunction(candidate.window, name)'), true);
});

test('workOrExam fallback submit confirms chaoxing popup before retrying generic submit buttons', async () => {
  const source = await readCxSource();

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
  const source = await readCxSource();

  assert.equal(source.includes('function describeWorkOrExamClickTarget('), true);
  assert.equal(source.includes('function isWorkOrExamClickableElement('), true);
  assert.equal(source.includes('const workOrExamClickableSelector ='), true);
  assert.equal(source.includes("element.matches(workOrExamClickableSelector)"), true);
  assert.equal(source.includes('return isElementVisible(element) && element.matches(workOrExamClickableSelector) && !element.matches(\':disabled,[disabled],[aria-disabled="true"]\');'), true);
  assert.equal(source.includes('firstFallbackSubmitTarget'), true);
  assert.equal(source.includes('confirmationFallbackTarget'), true);
});

test('workOrExam exposes an on-page debug log panel for submit diagnostics', async () => {
  const source = await readCxSource();

  assert.equal(source.includes("title.textContent = '超星学习助手';"), true);
  assert.equal(source.includes('Chaoxing Plus ${debugLogPanelLevel.toUpperCase()} Log'), false);
  assert.equal(source.includes("const debugLogPanelSettingKey = 'cx.new.study.enableDebugLogPanel';"), true);
  assert.equal(source.includes('const debugLogPanelDefaultEnabled = false;'), true);
  assert.equal(source.includes('function isDebugLogPanelEnabled('), true);
  assert.equal(source.includes('runtimeStore.get(debugLogPanelSettingKey, debugLogPanelDefaultEnabled)'), true);
  assert.equal(source.includes('let debugLogPanelEnabledState: boolean | undefined;'), true);
  assert.equal(source.includes('function refreshDebugLogPanelEnabledState()'), true);
  assert.equal(source.includes('function getSharedRuntimeStoreAttributeName(key: string)'), true);
  assert.equal(source.includes("return `data-chaoxing-plus-shared-${key.replace(/[^a-z0-9_-]/gi, '-')}`;"), true);
  assert.equal(source.includes('const sharedDebugLogPanelAttribute = getSharedRuntimeStoreAttributeName(debugLogPanelSettingKey);'), true);
  assert.equal(source.includes('function syncDebugLogPanelVisibility('), true);
  assert.equal(source.includes('const debugLogPanelZIndex = 2147483643;'), true);
  assert.equal(source.includes('panel.style.zIndex = String(debugLogPanelZIndex);'), true);
  assert.equal(source.includes("document.addEventListener('DOMContentLoaded', syncDebugLogPanelVisibility, { once: true });"), true);
  assert.match(source, /try \{\s*syncDebugLogPanelVisibility\(\);\s*\} catch/);
  assert.equal(source.includes('removeDebugLogPanel();'), true);
  assert.equal(source.includes('ensureDebugLogPanel();'), true);
  assert.equal(source.includes('function getDebugLogPanelSyncDocuments()'), true);
  assert.equal(source.includes('for (const syncDocument of getDebugLogPanelSyncDocuments()) {'), true);
  assert.equal(source.includes('debugLogPanelObserver.observe(syncDocument.documentElement, { attributes: true });'), true);
  assert.equal(source.includes("syncDocument.addEventListener('chaoxing-plus:shared-store-sync', onSharedStoreChanged);"), true);
  assert.equal(source.includes("syncDocument.addEventListener('chaoxing-plus:shared-store-hydrate', onSharedStoreChanged);"), true);
  assert.equal(source.includes('function createDebugLogPanelController(targetDocument: Document)'), true);
  assert.equal(source.includes('if (targetDocument !== document)'), true);
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

test('debug log panel batches rendering and bounds each entry so answering is not blocked by log DOM work', async () => {
  const source = await readCxSource();

  assert.equal(source.includes('const debugLogPanelRenderBatchSize = 20;'), true);
  assert.equal(source.includes('const debugLogPanelMaxEntryTextLength = 4000;'), true);
  assert.equal(source.includes('function flushDebugLogPanelEntries('), true);
  assert.equal(source.includes('requestAnimationFrame'), true);
  assert.equal(source.includes('DocumentFragment'), true);
  assert.equal(source.includes('debugLogPanelRenderStateKey'), true);
  assert.equal(source.includes('text.slice(0, debugLogPanelMaxEntryTextLength)'), true);
});

test('workOrExam debug log panel can be dragged from its header', async () => {
  const source = await readCxSource();

  assert.equal(source.includes('function bindDebugLogPanelDrag('), true);
  assert.equal(source.includes("header.dataset.cxDebugLogPanelDragHandle = 'true';"), true);
  assert.equal(source.includes("header.style.cursor = 'move';"), true);
  assert.equal(source.includes("header.style.touchAction = 'none';"), true);
  assert.equal(source.includes("header.addEventListener('pointerdown', (event) => {"), true);
  assert.equal(source.includes("panel.style.left = `${nextLeft}px`;"), true);
  assert.equal(source.includes("panel.style.right = 'auto';"), true);
  assert.equal(source.includes("panel.style.bottom = 'auto';"), true);
  assert.equal(source.includes('bindDebugLogPanelDrag(panel, header, targetDocument);'), true);
});
