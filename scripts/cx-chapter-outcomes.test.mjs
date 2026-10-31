import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from '@typescript/typescript6';

async function searchFixture(outcome, overrides = {}) {
  const source = await readFile('src/projects/cx.ts', 'utf8');
  const ast = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['searchJob', 'mergeVisibleContentState', 'isVisibleQuestionFallbackState']);
  const declarations = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
  const attachment = { jobid: 'job-1', job: true, isPassed: false, property: { mid: 'mid-1', name: 'chapter' } };
  const frameDocument = { querySelector: () => null, querySelectorAll: () => [] };
  const root = {
    getAttribute: (name) => name === 'jobid' ? 'job-1' : name === 'data' ? '{"jobid":"job-1"}' : name === 'src' ? '/ananas/modules/work/index.html' : null,
    contentWindow: { document: frameDocument }
  };
  root.contentWindow.frameElement = root;
  let executions = 0;
  const context = vm.createContext({
    $gm: { unsafeWindow: { document: {}, attachments: [attachment] } },
    getDeferredChapterContext: () => ({ tabKey: 'tab-1', state: { tasks: {} } }),
    searchIFrame: () => [root],
    domSearch: () => ({ chapterTest: {} }),
    CXAnalyses: { getCurrentChapterStayKey: () => 'chapter-1', isCurrentChapterFinished: () => false },
    buildChapterCorrelationId: () => 'correlation', logDebug() {}, clearTopCenterNotice() {}, scrollToLearningTask() {},
    $message: { warn() {}, info() {}, success() {} }, $console: { warn() {}, log() {} },
    JobRunner: { chapter: async () => { executions++; return outcome; } }
  });
  vm.runInContext(ts.transpileModule(declarations.map((node) => node.getText(ast)).join('\n').replace(/export /g, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 }
  }).outputText, context);
  return { search: (jobs = [], retry) => context.searchJob({ enableAnswer: true, enableChapterTest: true, workOptions: {}, ...overrides }, jobs, retry), executions: () => executions };
}

for (const disposition of ['saved', 'not-ready', 'retryable-failure']) {
  test(`${disposition} does not release the real searched job into an unbounded rescan`, async () => {
    const fixture = await searchFixture({ finished: false, disposition });
    const searched = [];
    const first = fixture.search(searched);
    assert.equal((await first.job.func()).disposition, disposition);
    assert.equal(fixture.search(searched).job, undefined);
    assert.equal(fixture.executions(), 1);
    assert.equal(searched.length, 1);
  });
}

test('disabled real chapter job reports a resumable block instead of a missing job', async () => {
  const fixture = await searchFixture({ finished: false }, { enableAnswer: false });
  const result = fixture.search([], { tabKey: 'tab-1', jobId: 'job-1' });
  assert.equal(result.job, undefined);
  assert.equal(result.blocked?.jobId, 'job-1');
  assert.equal(result.blocked?.reason, 'disabled');
});

async function uploadFixture({ autoSubmit = true, actions = {}, expired = false, current = true, retakePrompts = [] } = {}) {
  const source = await readFile('src/projects/cx.ts', 'utf8');
  const begin = source.indexOf('let chapterFinished = false;');
  const end = source.indexOf('\n    } finally {', begin);
  assert.ok(begin > 0 && end > begin);
  const doc = { querySelector: (selector) => selector.startsWith('form ') ? { value: 'job-1' } : null };
  const originalAlert = () => {};
  const frameWindow = { document: doc, alert: originalAlert, ...actions };
  frameWindow.parent = frameWindow;
  const frame = { getAttribute: (name) => name === 'jobid' ? 'job-1' : null };
  let cacheWrites = 0;
  const phases = [];
  const confirmation = { document: doc, ownerWindow: frameWindow, popup: {} };
  const context = vm.createContext({
    frameWindow, frameDocument: doc, frame, topWindow: frameWindow,
    upload: 'submit', retryableResults: [], cacheableResults: [], deepThinking: false,
    allowStaticExpiryFallback: true, chapterActionCorrelationId: '',
    uploadInProgress: false, sleep: async () => {}, waitForTikuAdapterBalanceRecovery: async () => {},
    worker: { uploadHandler: async ({ callback }) => callback(100, true), emit() {} },
    isWindowsAutoSubmitEnabled: () => autoSubmit,
    isChapterTestExpired: () => false,
    getDeferredChapterContext: () => ({ scope: '["course","class","chapter"]', tabKey: 'tab-1' }),
    chapterTaskContext: { scope: '["course","class","chapter"]', tabKey: 'tab-1' },
    chapterTaskJobId: 'job-1',
    isDeferredChapterContextCurrent: () => current,
    createChapterConfirmationSession: () => ({ find: () => confirmation, current: () => confirmation, clear() {}, release() {} }),
    submitChapterSubmissionConfirmation: () => { frameWindow.submitCheckTimes?.(); return true; },
    invokeChapterActionWithExpiryCapture: async (_window, _doc, action, _wait, options) => {
      phases.push(options?.phase || 'save');
      await action();
      return expired;
    },
    detectChapterRetakePrompt: () => retakePrompts.shift() ?? false,
    showTopCenterNotice() {}, clearChapterRetakePrompt() {}, notifyManualAnswerRequired() {},
    createChapterWorker: () => ({ doWork: async () => [] }), roots: [], logDebug() {},
    appsMethods: () => ({ addQuestionCacheFromWorkResult: () => cacheWrites++ }),
    $console: { info() {}, warn() {} }, $message: { info() {}, success() {}, warn() {} }
  });
  const body = source.slice(begin, end);
  const code = ts.transpileModule(`async function run() { ${body} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInContext(code, context);
  return { run: () => context.run(), cacheWrites: () => cacheWrites, phases, frameWindow, originalAlert };
}

test('the actual upload callback cannot complete or cache a chapter with no submit functions', async () => {
  const fixture = await uploadFixture();
  await assert.rejects(fixture.run(), /提交入口尚未就绪/);
  assert.equal(fixture.cacheWrites(), 0);
  assert.deepEqual(fixture.phases, []);
});

test('no-auto-submit saves once with a paused outcome and restores the page alert', async () => {
  let saves = 0;
  const fixture = await uploadFixture({ autoSubmit: false, actions: { noSubmit: () => saves++ } });
  const outcome = await fixture.run();
  assert.equal(outcome.finished, false);
  assert.equal(outcome.disposition, 'saved');
  assert.equal(saves, 1);
  assert.equal(fixture.cacheWrites(), 0);
  assert.equal(fixture.frameWindow.alert, fixture.originalAlert);
});

test('the actual upload callback requires the submit evidence phase before completion', async () => {
  const fixture = await uploadFixture({ actions: { btnBlueSubmit() {}, submitCheckTimes() {} } });
  const outcome = await fixture.run();
  assert.equal(outcome.finished, true);
  assert.equal(fixture.cacheWrites(), 1);
  assert.deepEqual(fixture.phases, ['open-confirmation', 'submit']);
});

test('a stale document is rejected before a submit action even when the tab is not paused', async () => {
  const source = await readFile('src/projects/cx.ts', 'utf8');
  const ast = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'waitForTabAnswerContinue');
  const context = vm.createContext({ getTabAnswerPauseController: () => ({ isPaused: () => false }) });
  vm.runInContext(ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  await assert.rejects(context.waitForTabAnswerContinue({ defaultView: { document: {} } }), /页面已切换/);
});

test('a stale task cannot submit even if the iframe document is still being reused', async () => {
  let submissions = 0;
  const fixture = await uploadFixture({ current: false, actions: { btnBlueSubmit() { submissions++; }, submitCheckTimes() { submissions++; } } });
  await assert.rejects(fixture.run(), /任务已切换/);
  assert.equal(submissions, 0);
  assert.equal(fixture.cacheWrites(), 0);
});

test('a different job in the same tab cannot fall through to parent submit functions', async () => {
  let submissions = 0;
  const fixture = await uploadFixture();
  fixture.frameWindow.document.querySelector = (selector) => selector.startsWith('form ') ? { value: 'job-2' } : null;
  const parent = {
    document: { querySelector: () => null },
    btnBlueSubmit() { submissions++; }, submitCheckTimes() { submissions++; }
  };
  parent.parent = parent;
  fixture.frameWindow.parent = parent;
  await assert.rejects(fixture.run(), /任务已切换/);
  assert.equal(submissions, 0);
  assert.equal(fixture.cacheWrites(), 0);
});

for (const stillRequiresRetake of [true, false]) {
  test(`AI resubmission ${stillRequiresRetake ? 'keeps an unpassed task retryable' : 'can complete a passed task'}`, async () => {
    const fixture = await uploadFixture({
      actions: { btnBlueSubmit() {}, submitCheckTimes() {} },
      retakePrompts: [true, stillRequiresRetake]
    });
    const outcome = await fixture.run();
    assert.equal(outcome.finished, !stillRequiresRetake);
    assert.equal(outcome.disposition, stillRequiresRetake ? 'retryable-failure' : 'completed');
    assert.equal(fixture.cacheWrites(), 0);
    assert.deepEqual(fixture.phases, ['open-confirmation', 'submit', 'open-confirmation', 'submit']);
  });
}
