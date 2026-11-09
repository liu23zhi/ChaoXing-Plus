import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from '@typescript/typescript6';

function declaration(source, name, path) {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let found;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast).replace(/^export /u, '');
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found, `${name} must remain available in ${path}`);
  return found;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture({ preview = true, pageCount = 2, holdUpload = false, countdownMs = 10000, holdInitialPage = 0,
  holdNavigationDirection } = {}) {
  const [cx, common, scope] = await Promise.all([
    readFile('src/projects/cx.ts', 'utf8'), readFile('src/projects/common.ts', 'utf8'),
    readFile('src/projects/cx-answer-run-scope.ts', 'utf8')
  ]);
  const roots = Array.from({ length: pageCount }, (_, index) => {
    const title = { textContent: `Question ${index + 1}`, innerText: `Question ${index + 1}` };
    return { title, cleared: false, querySelectorAll: () => [title], querySelector: () => null };
  });
  const state = { workResults: { results: [], runtimeControls: undefined, resetOperation: undefined, currentResultIndex: 0 } };
  const firstAnswer = deferred();
  const heldPageEntered = deferred();
  const countdown = deferred();
  const countdownEntered = deferred();
  const navigationEntered = deferred();
  const navigationSleep = deferred();
  let navigationSleepPending = false;
  let navigationHeld = false;
  let currentPage = 0;
  const events = [];
  const invalidNavigations = [];
  const workers = [];
  const errors = [];
  const document = { defaultView: null, querySelectorAll: () => preview ? roots : [roots[currentPage]], querySelector(selector) {
    if (selector.includes('getTheNextQuestion(1)') && currentPage + 1 < roots.length) return { click: () => navigate(1) };
    if (selector.includes('getTheNextQuestion(-1)') && currentPage > 0) return { click: () => navigate(-1) };
    return null;
  } };
  roots.forEach((root) => { root.ownerDocument = document; });
  const navigate = (direction) => {
    if (currentPage + direction < 0 || currentPage + direction >= roots.length) invalidNavigations.push([currentPage, direction]);
    currentPage = Math.max(0, Math.min(roots.length - 1, currentPage + direction));
    events.push(`navigate:${currentPage}`);
    if (!navigationHeld && direction === holdNavigationDirection) navigationSleepPending = true;
  };
  const window = { document, frames: [], noSubmit: () => events.push('save'), getTheNextQuestion: navigate };
  window.parent = window.top = window;
  document.defaultView = window;
  const simplify = (results) => results.map((result) => ({ question: result.ctx.elements.title[0].textContent,
    requested: result.requested, resolved: result.resolved, finish: result.result?.finish, searchInfos: [], manual: false,
    attempt: result.ctx.attempt }));
  class Worker {
    isRunning = false;
    isStop = false;
    isClose = false;
    listeners = new Map();
    constructor(opts) { this.opts = opts; this.id = workers.length; workers.push(this); }
    on(name, callback) { const list = this.listeners.get(name) ?? []; list.push(callback); this.listeners.set(name, list); }
    once(name, callback) { this.on(name, callback); }
    off() {}
    emit(name) { if (name === 'close') this.isClose = true; for (const callback of this.listeners.get(name) ?? []) callback(); }
    async doWork() {
      this.isRunning = true;
      const targets = typeof this.opts.root === 'string' ? (preview ? roots : [roots[currentPage]]) : this.opts.root;
      this.results = targets.map((root) => ({ requested: false, resolved: false, ctx: { root, attempt: this.id, elements: { title: [root.title] } } }));
      await this.opts.onResultsInitialized?.(this.results);
      if (this.id === 0 && !holdUpload && (preview || currentPage === holdInitialPage)) {
        heldPageEntered.resolve();
        await firstAnswer.promise;
      }
      for (const result of this.results) { result.requested = true; result.resolved = true; result.result = { finish: true }; }
      await this.opts.onResultsUpdate?.(this.results[0], 0, this.results);
      this.isRunning = false;
      events.push(`answered:${this.id}:${targets.map((root) => root.title.textContent).join(',')}`);
      return this.results;
    }
    async uploadHandler({ callback }) { events.push(`upload:${this.id}`); await callback(100, true); }
  }
  const methods = {
    init() { state.workResults.results = []; },
    setResults(results) { state.workResults.results = results; },
    appendResults(results) { state.workResults.results.push(...results); },
    getResults: () => state.workResults.results,
    updateWorkStateByResults() {},
    patchResult(index, patch) { if (state.workResults.results[index]) Object.assign(state.workResults.results[index], patch); },
    setRuntimeControls(controls) { state.workResults.runtimeControls = controls; },
    clearRuntimeControls() { state.workResults.runtimeControls = undefined; }, refresh() {}
  };
  const context = vm.createContext({ state, window, document, topWindow: window, console,
    $gm: { unsafeWindow: window }, OCSWorker: Worker, DEFAULT_WORKER_THREAD_COUNT: 1,
    CXAnalyses: { getCurrentChapterStayKey: () => 'fixture' }, buildChapterCorrelationId: () => 'fixture',
    createWindowsManualAnswerGateController: () => (worker) => worker, trackTikuAdapterWorker: (worker) => worker,
    untrackTikuAdapterWorker() {}, isWindowsHostRuntime: () => false, confirmBeforeAutoAnswer: async () => true,
    isWindowsManualAnswerMode: () => false,
    isWindowsAutoSubmitEnabled: () => true, createSearchRequestDeduplicator: () => () => {},
    getWorkOrExamTitleSelector: () => 'title', getWorkOrExamQuestionSelector: () => '.singleQuesId',
    transformWorkOrExamQuestionTitle: (titles) => titles.map((title) => title.textContent).join(''),
    queryWorkOrExamQuestionRoots: () => preview ? roots : [roots[currentPage]], questionTypeInputSelector: 'type',
    workResultsMethods: () => methods, appsMethods: () => ({}), simplifyWorkResult: simplify,
    resolveAnswerSearchType: () => 'single', resolveQuestionTypeForWork: () => 'single', normalizeResultQuestionType: (type) => type,
    detectManualAnswer: () => false, notifyManualAnswerRequired() {},
    tikuAdapterBalanceRecoveryState: { paused: false }, waitForTikuAdapterBalanceRecovery: async () => {},
    allowTikuAdapterRetryAfterBalanceRecovery: async () => true, resetTikuAdapterBalanceGuard() {}, getStoredTikuAdapterConfig: () => ({}),
    shouldSkipCacheForManualRetry: () => false, shouldSkipCacheForAutomaticRetry: () => false,
    waitForTabAnswerContinue: async () => {}, resetCxQuestionAnswers: (targets) => {
      for (const root of targets) { root.cleared = true; events.push(`clear:${root.title.textContent}`); }
    },
    triggerSyntheticClick: (button) => { button.click(); return true; },
    sleep: async (ms) => {
      if (ms === 1000 && navigationSleepPending) {
        navigationSleepPending = false;
        navigationHeld = true;
        navigationEntered.resolve();
        await navigationSleep.promise;
      }
      if (holdUpload && ms === countdownMs) { countdownEntered.resolve(); await countdown.promise; }
    },
    retryUnfinishedResultsInOrder: async (results) => results,
    $message: { info() {}, success() {}, error: (message) => errors.push(message) }, $console: { info() {} }, logDebug() {},
    syncWorkResultsControlDocument() {}, renderWorkResultsPanel() {},
    setWorkResults: (results) => { state.workResults.results = results; },
    patchWorkResult: (index, patch) => methods.patchResult(index, patch)
  });
  const code = [scope.replace(/^export /gmu, ''), declaration(cx, 'replaceCurrentWorkResults', 'cx.ts'), declaration(cx, 'workOrExam', 'cx.ts'),
    declaration(common, 'clearAndRetryWorkResults', 'common.ts')].join('\n');
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.workOrExam('work', { preview_mode: preview, answererWrappers: [], searchDelaySeconds: 0, thread: 1, upload: 'save',
    stopSecondWhenFinish: 10, redundanceWordsText: '', answerSeparators: '#', answerMatchMode: 'exact',
    enableRandomFallbackAnswer: false, enableAIFallbackAnswer: false, deepThinking: false, aiFallbackFailureAction: 'pause' });
  await new Promise((done) => setImmediate(done));
  return { context, state, roots, events, workers, errors, firstAnswer, heldPageEntered, countdown, countdownEntered,
    navigationEntered, navigationSleep, invalidNavigations,
    currentPage: () => currentPage, settle: () => new Promise((done) => setImmediate(done)) };
}

test('clearing an active preview run restarts every question and ignores late old results and upload', async () => {
  const f = await fixture();
  assert.equal(f.workers.length, 1);
  await f.context.clearAndRetryWorkResults();
  f.firstAnswer.resolve();
  await f.settle();
  assert.equal(f.workers[0].isClose, true);
  assert.equal(f.roots.every((root) => root.cleared), true);
  assert.deepEqual(Array.from(f.state.workResults.results, (result) => [result.question, result.finish]), [['Question 1', true], ['Question 2', true]]);
  assert.deepEqual(Array.from(f.state.workResults.results, (result) => result.attempt), [1, 2], 'late old callbacks must not replace restarted results');
  assert.equal(f.events.some((event) => event.startsWith('upload:') || event === 'save'), false);
  assert.equal(f.workers.length, 3);
  assert.deepEqual(f.errors, []);
});

test('clearing during the old completion countdown prevents its late save', async () => {
  const f = await fixture({ holdUpload: true });
  await f.countdownEntered.promise;
  await f.context.clearAndRetryWorkResults();
  f.countdown.resolve();
  await f.settle();
  assert.equal(f.events.includes('save'), false);
  assert.equal(f.events.some((event) => event.startsWith('upload:')), false);
  assert.equal(f.workers.length, 3);
  assert.deepEqual(f.errors, []);
});

test('clearing after upload handling starts prevents the old final save callback', async () => {
  const f = await fixture({ holdUpload: true, countdownMs: 3000 });
  await f.countdownEntered.promise;
  assert.deepEqual(f.events.filter((event) => event.startsWith('upload:')), ['upload:0']);
  await f.context.clearAndRetryWorkResults();
  f.countdown.resolve();
  await f.settle();
  assert.equal(f.events.includes('save'), false);
  assert.deepEqual(Array.from(f.state.workResults.results, (result) => result.attempt), [1, 2]);
  assert.deepEqual(f.errors, []);
});

test('clearing a partial stepwise run discovers and resets every later page before reanswering', async () => {
  const f = await fixture({ preview: false, pageCount: 3 });
  assert.equal(f.state.workResults.results.length, 1, 'only the initial page has been searched');
  await f.context.clearAndRetryWorkResults();
  f.firstAnswer.resolve();
  await f.settle();
  assert.equal(f.roots.every((root) => root.cleared), true);
  assert.deepEqual(Array.from(f.state.workResults.results, (result) => [result.question, result.finish]),
    [['Question 1', true], ['Question 2', true], ['Question 3', true]]);
  const firstNewAnswer = f.events.findIndex((event) => /^answered:[1-9]/u.test(event));
  const initialLastPageClear = f.events.indexOf('clear:Question 3');
  assert.ok(initialLastPageClear >= 0 && initialLastPageClear < firstNewAnswer, 'all pages must be cleared before the first answer is applied');
  assert.equal(f.events.includes('save'), false);
  assert.deepEqual(f.errors, []);
});

test('clearing while the second stepwise page is active returns to and clears the first page', { timeout: 5000 }, async () => {
  const f = await fixture({ preview: false, pageCount: 3, holdInitialPage: 1 });
  await f.heldPageEntered.promise;
  assert.equal(f.currentPage(), 1, 'the initial pipeline has moved to the second page');
  assert.deepEqual(Array.from(f.state.workResults.results, (result) => result.question), ['Question 1', 'Question 2']);
  await f.context.clearAndRetryWorkResults();
  f.firstAnswer.resolve();
  await f.settle();
  assert.equal(f.roots.every((root) => root.cleared), true, 'all pages including the already left first page must be cleared');
  assert.deepEqual(Array.from(f.state.workResults.results, (result) => [result.question, result.finish]),
    [['Question 1', true], ['Question 2', true], ['Question 3', true]]);
  assert.deepEqual(Array.from(f.state.workResults.results, (result) => result.attempt), [1, 2, 3]);
  assert.equal(f.events.includes('save'), false);
  assert.deepEqual(f.errors, []);
});

test('clearing during a backward navigation wait uses the page already reached', { timeout: 5000 }, async () => {
  const f = await fixture({ preview: false, pageCount: 3, holdInitialPage: -1, holdNavigationDirection: -1 });
  await f.navigationEntered.promise;
  assert.equal(f.currentPage(), 1, 'the completed run has already moved from the third page to the second');
  await f.context.clearAndRetryWorkResults();
  f.navigationSleep.resolve();
  await f.settle();
  assert.deepEqual(f.invalidNavigations, [], 'clear must not use the pre-navigation index and navigate before the first page');
  assert.equal(f.roots.every((root) => root.cleared), true);
  assert.deepEqual(Array.from(f.state.workResults.results, (result) => [result.question, result.finish]),
    [['Question 1', true], ['Question 2', true], ['Question 3', true]]);
  assert.equal(f.events.includes('save'), false);
  assert.deepEqual(f.errors, []);
});
