import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from '@typescript/typescript6';

const source = await readFile('src/projects/cx.ts', 'utf8');
const parsed = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
const helperNames = new Set([
  'hasPendingCurrentPageJobAttachments', 'getDeferredChapterContext',
  'saveDeferredChapterContext', 'isDeferredChapterContextCurrent',
  'switchDeferredChapterTab', 'buildVisibleContentRecoverySignature', 'study'
]);
const declarations = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && helperNames.has(node.name?.text));
assert.equal(declarations.length, helperNames.size, 'extract the current study implementation and all queue context helpers');
const studyCode = ts.transpileModule(declarations.map((node) => node.getText(parsed).replace(/^export\s+/, '')).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
const ledgerSource = await readFile('src/projects/cx-deferred-chapters.ts', 'utf8');
const ledgerCode = ts.transpileModule(ledgerSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const ledger = await import(`data:text/javascript;base64,${Buffer.from(ledgerCode).toString('base64')}`);
const attribute = 'data-chaoxing-plus-deferred-chapters';

function task(jobId, retryResults = [{ finished: true }], extra = {}) {
  return { jobId, retryResults, staticExpired: true, ...extra };
}

function fixture(tabTasks, options = {}) {
  const shared = {
    tabTasks, activeTab: 0, chapterId: 'chapter-1', courseId: 'course-1', classId: 'class-1',
    attributes: new Map(), events: [], warnings: [], retryCount: new Map(), normalCount: new Map(),
    runtimeCount: 0, ...options
  };
  const tabKeys = tabTasks.map((_, index) => `tab-${index + 1}`);
  const currentTasks = () => shared.tabTasks[shared.activeTab] || [];
  const tabs = tabKeys.map((key, index) => ({
    getAttribute(name) { return name === 'id' ? key : null; },
    classList: { contains(name) { return name === 'active' && shared.activeTab === index; } },
    click() { shared.events.push(`switch:${key}`); shared.activeTab = index; }
  }));
  const document = {
    documentElement: {
      getAttribute(name) { return shared.attributes.get(name) ?? null; },
      setAttribute(name, value) { shared.attributes.set(name, value); }
    },
    querySelector(selector) {
      if (selector === '#curCourseId') return { value: shared.courseId };
      if (selector === '#curClazzId') return { value: shared.classId };
      if (selector === '#curChapterId') return { value: shared.chapterId };
      return null;
    },
    querySelectorAll() { return []; }
  };
  const unsafeWindow = {};
  Object.defineProperty(unsafeWindow, 'attachments', { get() {
    return currentTasks().filter((item) => !item.attachmentMissing).map((item) => ({
      jobid: item.jobId, property: { _jobid: item.jobId }, job: !item.complete, isPassed: item.complete
    }));
  } });
  const topWindow = {
    document,
    location: { pathname: '/mycourse/studentstudy', href: 'https://example.test/mycourse/studentstudy', reload() { shared.events.push('reload'); } },
    PCount: { next() { shared.events.push('next-chapter'); } }
  };

  function createRuntime() {
    shared.runtimeCount += 1;
    let context;
    const noop = () => {};
    const chapterKey = () => shared.chapterId;
    const stayKey = () => `${shared.chapterId}:${tabKeys[shared.activeTab]}`;
    const log = { error: noop, warn: (message) => shared.warnings.push(message), info: noop, log: noop };
    const sandbox = {
      ...ledger, topWindow, $gm: { unsafeWindow },
      deferredChaptersAttribute: attribute,
      siblingSubTaskRefreshDelayMs: 0,
      VISIBLE_CONTENT_RECOVERY_STORAGE_KEY: 'recovery',
      clearWorkResultsOnPageLoad: noop,
      waitForTopWindowLoad: async () => {},
      getVisibleContentRecoveryStorage: () => null,
      resumeVisibleContentRecovery: async () => true,
      getUnfinishedQuestionRetryAttempts: () => shared.retryAttempts ?? 2,
      setTimeout(callback) { callback(); return 1; },
      async sleep(ms) {
        shared.sleepCount = (shared.sleepCount || 0) + 1;
        assert.ok(shared.sleepCount < 200, 'study must not loop without a finite retry/missing bound');
        await shared.onSleep?.(ms, shared);
      },
      getSiblingSubTaskTabs: () => tabs,
      triggerSyntheticClick(element) { element.click(); return true; },
      buildChapterCorrelationId: () => 'correlation', logDebug: noop,
      $console: log, $message: { ...log, success: noop },
      $modal: { alert: async () => {}, notice: async () => {} },
      showTopCenterNotice: noop, settingsMethods: () => ({}), workResultsMethods: () => ({}),
      shouldCheckSiblingSubTasksForState: () => false,
      isVisibleQuestionFallbackState: () => false,
      getCurrentChapterCompletionDiagnostics: () => ({ currentChapterFinished: true }),
      getSiblingSubTaskDiagnostics: () => ({ hasSiblingSubTasks: tabs.length > 1 }),
      CXAnalyses: {
        getCurrentChapterKey: chapterKey, getCurrentChapterStayKey: stayKey,
        clearChapterSubTaskProgress: noop,
        getChapterStayState: () => ({ chapterStayKey: stayKey(), returnedToSameChapter: false, repeatCount: 0 }),
        getChapterSubTaskProgress: () => ({ attempts: 0 }),
        isInFinalTab: () => shared.activeTab === tabs.length - 1,
        isStuckInBreakingMode: async () => false,
        isInFinalChapter: () => false,
        getChapterInfos: () => [true, false].map((active) => ({
          unFinishCount: 1,
          element: { parentElement: {
            classList: { contains(name) { return name === 'posCatalog_active' && active; } },
            querySelector(selector) {
              return selector === '.posCatalog_name'
                ? { click() { shared.events.push(active ? 'current-chapter' : 'next-unfinished-chapter'); } }
                : null;
            }
          } }
        })),
        scrollToActiveChapter: noop,
        trySwitchToNextUnvisitedSubTask() { shared.events.push('legacy-switch'); return { switched: false }; }
      },
      searchJob(opts, searchedJobs, retryTarget) {
        const deferred = Object.values(context.getDeferredChapterContext().state.tasks);
        const candidate = retryTarget
          ? currentTasks().find((item) => item.jobId === retryTarget.jobId && !item.invisible)
          : currentTasks().find((item) => !item.complete && !item.invisible
            && !searchedJobs.some((job) => job.jobId === item.jobId)
            && !deferred.some((entry) => entry.tabKey === tabKeys[shared.activeTab] && entry.jobId === item.jobId));
        if (!candidate) return { visibleContentState: 'finished-job' };
        const key = `${tabKeys[shared.activeTab]}:${candidate.jobId}`;
        const job = {
          jobId: candidate.jobId, chapterTest: candidate.chapterTest !== false,
          async func(finalAttempt = false) {
            const counts = finalAttempt ? shared.retryCount : shared.normalCount;
            const count = (counts.get(key) || 0) + 1;
            counts.set(key, count);
            shared.events.push(`${finalAttempt ? 'retry' : 'normal'}:${key}`);
            await candidate.onExecute?.(finalAttempt, count, shared);
            let result;
            if (finalAttempt) {
              result = candidate.retryResults[Math.min(count - 1, candidate.retryResults.length - 1)];
            } else {
              result = candidate.normalResult ?? (candidate.staticExpired ? { expired: true, staticExpired: true } : { finished: true });
            }
            if (result instanceof Error) throw result;
            if (result?.finished) candidate.complete = true;
            return result;
          }
        };
        searchedJobs.push(job);
        return { job, visibleContentState: 'job' };
      }
    };
    context = vm.createContext(sandbox);
    vm.runInContext(studyCode, context, { filename: 'cx-study-extracted.js' });
    return context;
  }
  function state() {
    const saved = JSON.parse(shared.attributes.get(attribute) || '{}');
    return saved[JSON.stringify([shared.courseId, shared.classId, shared.chapterId])];
  }
  async function run(mode = 'manually') {
    await createRuntime().study({ mode });
  }
  async function settle(maxRuns = 12) {
    for (let index = 0; index < maxRuns; index += 1) {
      await run();
      if (state()?.phase === 'settled') return;
    }
    assert.fail('chapter queue did not settle in the permitted page rebuilds');
  }
  return { shared, tabs, createRuntime, state, run, settle };
}

test('all ordinary jobs across multiple tabs finish before multiple deferred jobs are revisited', async () => {
  const f = fixture([
    [task('expired-a'), task('normal-a', [], { staticExpired: false }), task('expired-b')],
    [task('normal-b', [], { staticExpired: false }), task('expired-c')],
    [task('normal-c', [], { staticExpired: false })]
  ]);
  await f.settle();
  const firstRetry = f.shared.events.findIndex((event) => event.startsWith('retry:'));
  assert.ok(firstRetry > f.shared.events.indexOf('normal:tab-3:normal-c'));
  assert.deepEqual(f.shared.events.filter((event) => event.startsWith('retry:')), [
    'retry:tab-1:expired-a', 'retry:tab-1:expired-b', 'retry:tab-2:expired-c'
  ]);
  assert.equal(Object.values(f.state().tasks).length, 3);
  assert.ok(Object.values(f.state().tasks).every((entry) => entry.state === 'complete' && entry.attempts === 1));
});

test('identical job ids in different tabs keep independent retry budgets', async () => {
  const f = fixture([[task('same', [{}])], [task('same', [{ finished: true }])]]);
  await f.settle();
  const entries = Object.values(f.state().tasks);
  assert.deepEqual(entries.map((entry) => [entry.tabKey, entry.attempts, entry.state]), [
    ['tab-1', 3, 'abandoned'], ['tab-2', 1, 'complete']
  ]);
});

test('deferred ordinary failures stop at the configured total submission count', async () => {
  const f = fixture([[task('failure', [{ finished: false }])]], { retryAttempts: 1 });
  await f.settle();
  await f.run();
  assert.equal(f.shared.retryCount.get('tab-1:failure'), 2);
  assert.equal(Object.values(f.state().tasks)[0].attempts, 2);
  assert.equal(Object.values(f.state().tasks)[0].state, 'abandoned');
});

test('an ordinary submission exception consumes the initial attempt and later exceptions stay bounded', async () => {
  const f = fixture([[task('throwing', [new Error('retry failed')], {
    normalResult: new Error('initial submission failed')
  })]]);
  await f.settle();
  await f.run();
  assert.equal(f.shared.normalCount.get('tab-1:throwing'), 1);
  assert.equal(f.shared.retryCount.get('tab-1:throwing'), 2);
  assert.equal(Object.values(f.state().tasks)[0].attempts, 3);
  assert.equal(Object.values(f.state().tasks)[0].state, 'abandoned');
});

test('a terminal expiry is attempted once and does not reopen after rebuilding study', async () => {
  const f = fixture([[task('terminal', [{ expired: true, terminalExpired: true }]), task('later')]]);
  await f.settle();
  await f.run();
  await f.run();
  assert.equal(f.shared.retryCount.get('tab-1:terminal'), 1);
  assert.equal(f.shared.retryCount.get('tab-1:later'), 1);
  const terminal = Object.values(f.state().tasks).find((entry) => entry.jobId === 'terminal');
  assert.equal(terminal.terminalExpired, true);
  assert.equal(terminal.state, 'abandoned');
});

test('terminal expiry on the first submission is abandoned while other tasks continue', async () => {
  const f = fixture([[task('terminal', [], {
    normalResult: { expired: true, terminalExpired: true }
  }), task('ordinary', [], { staticExpired: false })]]);
  await f.settle();
  await f.run();
  assert.deepEqual(f.shared.events, ['normal:tab-1:terminal', 'normal:tab-1:ordinary']);
  const terminal = Object.values(f.state().tasks)[0];
  assert.equal(terminal.attempts, 1);
  assert.equal(terminal.terminalExpired, true);
  assert.equal(terminal.state, 'abandoned');
});

test('reserved attempts survive navigation away and a fresh study instance', async () => {
  const expiring = task('rebuild', [{}]);
  const f = fixture([[expiring], []]);
  expiring.onExecute = (finalAttempt, count, shared) => {
    if (finalAttempt && count === 1) shared.activeTab = 1;
  };
  await f.run();
  await f.run();
  await f.run();
  assert.equal(f.shared.retryCount.get('tab-1:rebuild'), 1);
  assert.equal(Object.values(f.state().tasks)[0].attempts, 1);
  await f.settle();
  assert.equal(f.shared.retryCount.get('tab-1:rebuild'), 3);
  assert.equal(Object.values(f.state().tasks)[0].attempts, 3);
  assert.equal(Object.values(f.state().tasks)[0].state, 'abandoned');
  assert.ok(f.shared.runtimeCount >= 4);
});

test('overlapping study instances cannot overwrite newer attempt totals with a stale result', async () => {
  let releaseFirst;
  let enteredFirst;
  const firstStarted = new Promise((resolve) => { enteredFirst = resolve; });
  const firstResult = new Promise((resolve) => { releaseFirst = resolve; });
  const f = fixture([[task('concurrent', [{}], {
    onExecute(finalAttempt, count) {
      if (finalAttempt && count === 1) {
        enteredFirst();
        return firstResult;
      }
    }
  })]]);
  const scope = JSON.stringify(['course-1', 'class-1', 'chapter-1']);
  const state = ledger.createChapterDeferredState(scope);
  ledger.recordChapterDeferral(state, 'tab-1', 'concurrent');
  ledger.markChapterTabInspected(state, 'tab-1');
  f.shared.attributes.set(attribute, JSON.stringify({ [scope]: state }));
  const first = f.run();
  await firstStarted;
  await f.run();
  releaseFirst();
  await first;
  assert.equal(f.shared.retryCount.get('tab-1:concurrent'), 3);
  assert.equal(Object.values(f.state().tasks)[0].attempts, 3);
  assert.equal(Object.values(f.state().tasks)[0].state, 'abandoned');
});

test('a stale overlapping result cannot reopen a task after another instance observes terminal expiry', async () => {
  let releaseFirst;
  let enteredFirst;
  const firstStarted = new Promise((resolve) => { enteredFirst = resolve; });
  const firstResult = new Promise((resolve) => { releaseFirst = resolve; });
  const f = fixture([[task('terminal-race', [{}, { expired: true, terminalExpired: true }], {
    onExecute(finalAttempt, count) {
      if (finalAttempt && count === 1) {
        enteredFirst();
        return firstResult;
      }
    }
  })]]);
  const scope = JSON.stringify(['course-1', 'class-1', 'chapter-1']);
  const state = ledger.createChapterDeferredState(scope);
  ledger.recordChapterDeferral(state, 'tab-1', 'terminal-race');
  ledger.markChapterTabInspected(state, 'tab-1');
  f.shared.attributes.set(attribute, JSON.stringify({ [scope]: state }));
  const first = f.run();
  await firstStarted;
  await f.run();
  releaseFirst();
  await first;
  assert.equal(f.shared.retryCount.get('tab-1:terminal-race'), 2);
  assert.equal(Object.values(f.state().tasks)[0].terminalExpired, true);
  assert.equal(Object.values(f.state().tasks)[0].state, 'abandoned');
});

test('manual choice during the ordinary scan immediately pauses later tasks and tab switching', async () => {
  const f = fixture([[task('manual', [], { normalResult: { manual: true } }), task('later')], [task('other-tab')]]);
  await f.run();
  assert.deepEqual(f.shared.events, ['normal:tab-1:manual']);
  assert.equal(f.state(), undefined);
});

test('manual choice during a deferred revisit pauses and rolls back its attempt reservation', async () => {
  const f = fixture([[task('manual', [{ manual: true }]), task('later')]]);
  await f.run();
  assert.deepEqual(f.shared.events, ['normal:tab-1:manual', 'normal:tab-1:later', 'retry:tab-1:manual']);
  const entries = Object.values(f.state().tasks);
  assert.equal(entries[0].attempts, 0);
  assert.equal(entries[0].state, 'deferred');
  assert.equal(f.shared.retryCount.has('tab-1:later'), false);
});

test('manual tab navigation records only the originating task and cancels later execution and switching', async () => {
  const f = fixture([[task('moving', [], {
    onExecute(finalAttempt, count, shared) { shared.activeTab = 1; }
  })], [task('other')]]);
  await f.run();
  assert.deepEqual(f.shared.events, ['normal:tab-1:moving']);
  assert.deepEqual(f.state().inspectedTabs, []);
  assert.deepEqual(Object.values(f.state().tasks).map((entry) => [entry.tabKey, entry.jobId, entry.attempts]), [
    ['tab-1', 'moving', 0]
  ]);
  assert.equal(f.shared.activeTab, 1);
});

test('manual chapter navigation preserves a terminal retry result in its original scope without touching the new chapter', async () => {
  const f = fixture([[task('moving', [{ expired: true, terminalExpired: true }], {
    onExecute(finalAttempt, count, shared) { if (finalAttempt) shared.chapterId = 'chapter-2'; }
  })]]);
  await f.run();
  const saved = JSON.parse(f.shared.attributes.get(attribute));
  assert.equal(f.state(), undefined);
  const previous = saved[JSON.stringify(['course-1', 'class-1', 'chapter-1'])];
  assert.equal(Object.values(previous.tasks)[0].attempts, 1);
  assert.equal(Object.values(previous.tasks)[0].terminalExpired, true);
  assert.equal(Object.values(previous.tasks)[0].state, 'abandoned');
  assert.deepEqual(f.shared.events, ['normal:tab-1:moving', 'retry:tab-1:moving']);
});

test('terminal expiry received after initial submission navigates away is retained only under the original chapter', async () => {
  const f = fixture([[task('initial-terminal', [], {
    normalResult: { expired: true, terminalExpired: true },
    onExecute(finalAttempt, count, shared) { shared.chapterId = 'chapter-2'; }
  }), task('later')]]);
  await f.run();
  assert.equal(f.state(), undefined);
  const saved = JSON.parse(f.shared.attributes.get(attribute));
  const previous = saved[JSON.stringify(['course-1', 'class-1', 'chapter-1'])];
  assert.deepEqual(Object.values(previous.tasks).map((entry) => [entry.jobId, entry.attempts, entry.state, entry.terminalExpired]), [
    ['initial-terminal', 1, 'abandoned', true]
  ]);
  assert.deepEqual(f.shared.events, ['normal:tab-1:initial-terminal']);
  f.shared.chapterId = 'chapter-1';
  await f.run();
  assert.equal(f.shared.normalCount.get('tab-1:initial-terminal'), 1);
  assert.equal(f.shared.retryCount.has('tab-1:initial-terminal'), false);
});

test('temporarily missing deferred jobs have a finite bound without consuming answer attempts', async () => {
  const missing = task('missing');
  const f = fixture([[missing]], { onSleep() { missing.invisible = true; } });
  await f.settle();
  const entry = Object.values(f.state().tasks)[0];
  assert.equal(entry.missingVisits, 3);
  assert.equal(entry.attempts, 0);
  assert.equal(entry.state, 'abandoned');
  assert.equal(f.shared.retryCount.size, 0);
});

test('auto-next guard cancels chapter navigation if the user changes tabs during the countdown', async () => {
  const f = fixture([[task('expired')], []], {
    onSleep(ms, shared) { if (ms === 5000) shared.activeTab = 1; }
  });
  await f.run('next');
  await f.run('next');
  await f.run('next');
  assert.equal(f.shared.events.includes('next-chapter'), false);
  assert.ok(f.shared.warnings.some((message) => String(message).includes('自动跳转已取消')));
});

for (const [description, result, expectedState] of [
  ['completed', { finished: true }, 'complete'],
  ['abandoned', { expired: true, terminalExpired: true }, 'abandoned']
]) {
  test(`job navigation reaches the next unfinished chapter after ${description} revisits leave the page on an earlier tab`, async () => {
    const f = fixture([
      [task('expired', [result])],
      [task('ordinary-2', [], { staticExpired: false })],
      [task('ordinary-3', [], { staticExpired: false })]
    ]);
    for (let run = 0; run < 4; run += 1) await f.run('job');
    assert.equal(f.shared.activeTab, 0, 'the revisit ended on the first tab, rather than the final tab');
    assert.equal(Object.values(f.state().tasks)[0].state, expectedState);
    assert.equal(f.shared.events.filter((event) => event === 'next-unfinished-chapter').length, 1);
    assert.ok(f.shared.events.indexOf('normal:tab-3:ordinary-3') < f.shared.events.indexOf('retry:tab-1:expired'));
  });
}

test('manual tab navigation during the retry interval stops before another task or chapter navigation', async () => {
  const f = fixture([[task('waiting', [{}]), task('later')], []], {
    onSleep(ms, shared) {
      if (ms === 1000 && shared.retryCount.get('tab-1:waiting') === 1) shared.activeTab = 1;
    }
  });
  const scope = JSON.stringify(['course-1', 'class-1', 'chapter-1']);
  const state = ledger.createChapterDeferredState(scope);
  ledger.recordChapterDeferral(state, 'tab-1', 'waiting');
  ledger.recordChapterDeferral(state, 'tab-1', 'later');
  ledger.markChapterTabInspected(state, 'tab-1');
  ledger.markChapterTabInspected(state, 'tab-2');
  f.shared.attributes.set(attribute, JSON.stringify({ [scope]: state }));
  await f.run('next');
  assert.deepEqual(f.shared.events, ['retry:tab-1:waiting']);
  assert.equal(f.shared.activeTab, 1);
  assert.equal(Object.values(f.state().tasks)[0].attempts, 1);
  assert.equal(f.shared.retryCount.has('tab-1:later'), false);
});
