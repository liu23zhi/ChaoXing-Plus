import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from '@typescript/typescript6';

const source = await readFile('src/projects/cx.ts', 'utf8');
const ast = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
const diagnosticNames = new Set([
  'getStudyAttachmentDiagnostics', 'getStudyMediaDiagnostics', 'getStudyJobDiagnostics'
]);
const noop = () => {};
const plain = (value) => JSON.parse(JSON.stringify(value));

function declarations(names) {
  return ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
    .map((node) => node.getText(ast).replace(/^export\s+/u, '')).join('\n');
}

function logPanelFormatter() {
  const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'formatDebugLogPanelValue');
  assert.ok(declaration, 'extract the real log-panel formatter');
  const context = evaluate(`const debugLogPanelMaxEntryTextLength = 4000;\n${declaration.getText(ast)}\nglobalThis.format = formatDebugLogPanelValue;`);
  return context.format;
}

function evaluate(code, globals = {}) {
  const context = vm.createContext(globals);
  vm.runInContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText, context);
  return context;
}

function attachment(overrides = {}) {
  return {
    jobid: 'job-1', job: true, isPassed: false,
    property: { mid: 'mid-1', name: 'sample-video.mp4', _jobid: 'job-1' },
    ...overrides
  };
}

function mediaElement(overrides = {}) {
  const listeners = new Map();
  return {
    currentTime: 12.5, duration: 100, ended: false, paused: false,
    readyState: 4, networkState: 1, error: null, playbackRate: 1,
    // These must never enter the new diagnostic fields.
    currentSrc: 'https://media.example/video?token=secret-token',
    src: 'https://media.example/video?signature=secret-signature',
    play: async () => {},
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    async dispatch(type) {
      await Promise.all([...(listeners.get(type) || [])].map((listener) => listener()));
    },
    ...overrides
  };
}

test('attachment diagnostics preserve unknown values and only confirm explicit completion evidence', () => {
  const context = evaluate(declarations(diagnosticNames));
  assert.equal(typeof context.getStudyAttachmentDiagnostics, 'function', 'provide attachment diagnostic helper');
  for (const value of [undefined, attachment({ job: undefined, isPassed: undefined })]) {
    assert.deepEqual(plain(context.getStudyAttachmentDiagnostics(value)), {
      attachmentJob: null, attachmentPassed: null, attachmentCompletionConfirmed: false
    });
  }
  assert.equal(context.getStudyAttachmentDiagnostics(attachment()).attachmentCompletionConfirmed, false);
  assert.equal(context.getStudyAttachmentDiagnostics(attachment({ isPassed: true })).attachmentCompletionConfirmed, true);
  assert.equal(context.getStudyAttachmentDiagnostics(attachment({ job: false })).attachmentCompletionConfirmed, true);
});

test('media diagnostics report numeric playback evidence without media URLs or raw errors', () => {
  const context = evaluate(declarations(diagnosticNames));
  assert.equal(typeof context.getStudyMediaDiagnostics, 'function', 'provide media diagnostic helper');
  const media = mediaElement({ currentTime: NaN, duration: Infinity,
    error: { code: 3, message: 'decoder failed https://secret.example?token=private' } });
  const detail = plain(context.getStudyMediaDiagnostics({ querySelector: () => media }));
  assert.deepEqual(detail, {
    mediaPresent: true, mediaCurrentTime: null, mediaDuration: null,
    mediaEnded: false, mediaPaused: false, mediaReadyState: 4,
    mediaNetworkState: 1, mediaErrorCode: 3
  });
  assert.deepEqual(plain(context.getStudyMediaDiagnostics({ querySelector: () => null })), {
    mediaPresent: false, mediaCurrentTime: null, mediaDuration: null,
    mediaEnded: null, mediaPaused: null, mediaReadyState: null,
    mediaNetworkState: null, mediaErrorCode: null
  });
  assert.doesNotMatch(JSON.stringify(detail), /secret|signature|https:|decoder/u);
});

test('job diagnostics explicitly report that a new task has not been enqueued', () => {
  const context = evaluate(declarations(diagnosticNames));
  assert.equal(typeof context.getStudyJobDiagnostics, 'function', 'provide job diagnostic helper');
  const detail = context.getStudyJobDiagnostics(attachment());
  assert.equal(detail.executionState, 'not-enqueued');
  for (const key of ['executionStartedAt', 'executionEndedAt', 'executionDurationMs', 'mediaExecution', 'errorName']) {
    assert.equal(detail[key], null, key);
  }
});

function searchFixture({ execute = async () => ({ outcome: 'ended', completionConfirmed: false }), rawAttachment = attachment() } = {}) {
  const logs = [];
  const media = mediaElement();
  const document = { querySelector: (selector) => /video|audio/u.test(selector) ? media : null, querySelectorAll: () => [] };
  const root = {
    getAttribute(name) {
      return name === 'jobid' ? 'job-1' : name === 'data' ? '{"jobid":"job-1"}'
        : name === 'src' ? '/ananas/modules/video/index.html' : null;
    },
    contentWindow: { document }
  };
  root.contentWindow.frameElement = root;
  const context = evaluate(declarations(new Set([...diagnosticNames,
    'searchJob', 'mergeVisibleContentState', 'isVisibleQuestionFallbackState'])), {
    $gm: { unsafeWindow: { document: {}, attachments: [rawAttachment] } },
    getDeferredChapterContext: () => ({ tabKey: 'tab-1', state: { tasks: {} } }),
    searchIFrame: () => [root], domSearch: () => ({ videojs: {} }),
    CXAnalyses: { getCurrentChapterStayKey: () => 'chapter-1', isCurrentChapterFinished: () => false },
    getCurrentChapterCompletionDiagnostics: () => ({ currentChapterFinished: false }),
    buildChapterCorrelationId: () => 'correlation', clearTopCenterNotice: noop, scrollToLearningTask: noop,
    logDebug(level, label, detail, text, meta) { logs.push({ level, label, detail: plain(detail), text, meta }); },
    $message: { warn: noop, info: noop, success: noop },
    $console: { warn: noop, log: noop }, JobRunner: { media: execute }
  });
  const jobs = [];
  return {
    logs, jobs,
    search: () => context.searchJob({ enableMedia: true, restudy: false, forceLearn: false }, jobs)
  };
}

test('the enabled log panel retains skip reason and task state inside bounded diagnostic output', async () => {
  const fixture = searchFixture();
  const first = fixture.search();
  await first.job.func();
  fixture.search();
  const skipped = fixture.logs.filter((log) => log.detail?.reason === 'already-searched').at(-1).detail;
  const formatted = logPanelFormatter()(skipped);
  for (const field of ['reason', 'hasPreviousHandler', 'visibleContentStateReason', 'executionState', 'attachmentCompletionConfirmed', 'mediaCurrentTime']) {
    assert.match(formatted, new RegExp(`"${field}"`, 'u'), `log panel retains ${field}`);
  }
});

test('real search distinguishes queued, running and returned tasks while keeping media results out of scheduling', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const mediaResult = { outcome: 'ended', completionConfirmed: false, completionWaitTimedOut: true };
  const fixture = searchFixture({ execute: () => pending });
  const first = fixture.search();
  const initial = fixture.logs.find((log) => log.label === '任务点搜索诊断').detail.taskDiagnostics;
  assert.equal(initial.executionState, 'not-enqueued');
  assert.equal(initial.visibleContentStateReason, 'attachment-job');
  assert.equal(initial.chapterStatusApplicable, false);
  assert.equal(initial.attachmentJob, true);
  assert.equal(initial.attachmentPassed, false);
  assert.equal(initial.mediaCurrentTime, 12.5);
  const queued = fixture.logs.find((log) => log.detail?.reason === 'job-enqueued').detail.taskDiagnostics;
  assert.equal(queued.executionState, 'queued');
  const executing = first.job.func();
  assert.equal(fixture.search().job, undefined);
  const running = fixture.logs.filter((log) => log.label === '任务点搜索诊断').at(-1).detail.taskDiagnostics;
  assert.equal(running.executionState, 'running');
  release(mediaResult);
  const result = await executing;
  assert.equal(result?.finished, undefined, 'diagnostic success cannot change ordinary-task completion ledger');
  assert.equal(fixture.search().job, undefined);
  const returned = fixture.logs.filter((log) => log.label === '任务点搜索诊断').at(-1).detail.taskDiagnostics;
  assert.equal(returned.executionState, 'returned');
  assert.equal(returned.visibleContentStateReason, 'already-searched-media');
  assert.deepEqual(returned.mediaExecution, mediaResult);
  assert.equal(returned.attachmentJob, true);
  assert.equal(returned.attachmentPassed, false);
  assert.equal(returned.attachmentCompletionConfirmed, false);
  assert.equal(returned.currentChapterFinished, false);
  assert.equal(typeof returned.executionStartedAt, 'number');
  assert.equal(typeof returned.executionEndedAt, 'number');
  assert.ok(returned.executionDurationMs >= 0);
  const skipped = fixture.logs.filter((log) => log.detail?.reason === 'already-searched').at(-1).detail;
  assert.equal(skipped.hasPreviousHandler, true);
  assert.equal(skipped.handlerScheduled, false);
  assert.equal(skipped.hasFunc, false);
  const formattedSkip = logPanelFormatter()(skipped);
  for (const field of ['reason', 'hasPreviousHandler', 'attachmentCompletionConfirmed', 'visibleContentStateReason', 'executionState', 'mediaCurrentTime']) {
    assert.match(formattedSkip, new RegExp(`"${field}"`, 'u'), `log panel retains ${field}`);
  }
  assert.equal(fixture.jobs.length, 1);
});

test('real search retains thrown execution evidence without copying the raw exception into diagnostics', async () => {
  const fixture = searchFixture({ execute: async () => { throw new TypeError('https://secret.example?token=private'); } });
  const first = fixture.search();
  await assert.rejects(first.job.func(), { name: 'TypeError' });
  assert.equal(fixture.search().job, undefined);
  const log = fixture.logs.filter((entry) => entry.label === '任务点搜索诊断').at(-1);
  assert.equal(log.detail.taskDiagnostics.executionState, 'threw');
  assert.equal(log.detail.taskDiagnostics.errorName, 'TypeError');
  assert.equal(log.detail.taskDiagnostics.mediaExecution, null);
  assert.doesNotMatch(JSON.stringify(fixture.logs), /secret\.example|token=private/u);
  assert.ok(fixture.logs.some((entry) => entry.label === '任务执行结果诊断'));
});

for (const failure of [
  Object.assign(new Error('private-message'), { name: 'https://secret.example?token=private-name' }),
  'https://secret.example?token=private-string'
]) {
  test(`real search classifies ${typeof failure === 'string' ? 'primitive' : 'custom-named'} failures without leaking their contents`, async () => {
    const fixture = searchFixture({ execute: async () => { throw failure; } });
    const first = fixture.search();
    await assert.rejects(first.job.func(), (error) => error === failure);
    fixture.search();
    const log = fixture.logs.filter((entry) => entry.label === '任务点搜索诊断').at(-1);
    assert.equal(log.detail.taskDiagnostics.executionState, 'threw');
    assert.equal(log.detail.taskDiagnostics.errorName, 'UnknownError');
    assert.equal(log.detail.taskDiagnostics.attachmentCompletionConfirmed, false);
    assert.doesNotMatch(JSON.stringify(fixture.logs), /secret\.example|private-name|private-string|private-message/u);
  });
}

function mediaFixture(options = {}) {
  const logs = [];
  const waits = [];
  const timers = [];
  const intervals = new Set();
  const media = options.missingMedia ? null : mediaElement();
  const rawAttachment = attachment(options.attachment);
  let now = 1000;
  let chapterFinished = false;
  const document = {
    querySelector: (selector) => /video|audio/u.test(selector) ? media : null,
    querySelectorAll: () => []
  };
  let mediaMethod;
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(ast) === 'JobRunner' && declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) {
        mediaMethod = declaration.initializer.properties.find((node) => node.name?.getText(ast) === 'media');
      }
    }
  }
  assert.ok(mediaMethod, 'extract the real media runner');
  const context = evaluate(`${declarations(diagnosticNames)}\nconst JobRunner = { ${mediaMethod.getText(ast)} };\nglobalThis.runner = JobRunner;`, {
    Date: class extends Date { static now() { return now; } },
    waitForMedia: async () => media,
    domSearch: () => ({ videojs: options.missingPlayer ? null : {} }),
    state: { study: {} }, topWindow: {}, fixedVideoProgress: noop,
    CXAnalyses: { getCurrentChapterStayKey: () => 'chapter-1', isCurrentChapterFinished: () => chapterFinished },
    getCurrentChapterCompletionDiagnostics: () => ({ currentChapterFinished: chapterFinished }),
    buildChapterCorrelationId: () => 'media-correlation',
    logDebug(level, label, detail, text, meta) { logs.push({ level, label, detail: plain(detail), text, meta }); },
    $console: { error: noop, warn: noop, log: noop }, $message: { error: noop, warn: noop },
    setInterval(callback, delay) { const timer = { callback, delay }; intervals.add(timer); return timer; },
    clearInterval(timer) { intervals.delete(timer); },
    setTimeout(callback, delay) { const timer = { callback, delay, active: true }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.active = false; },
    inspectVideoLoadState: () => ({ loadFailureDetected: Boolean(options.loadFailed), loadFailureReason: options.loadFailed ? 'media-error' : 'none', routeControls: [] }),
    shouldWaitAfterVideoRouteSwitch: () => false, trySwitchVideoRoute: () => false,
    isVideoLoadFailure: () => Boolean(options.loadFailed), VIDEO_ROUTE_SWITCH_GRACE_MS: 10000,
    hasFaceRecognition: () => false, hasNewFaceRecognition: () => false,
    sleep: async (duration) => { now += duration; }, playMedia: async (play) => { await play(); return true; },
    async waitForAttachmentComplete(value, timeout) {
      waits.push({ type: 'attachment', timeout });
      if (options.attachmentWait) return options.attachmentWait(value);
      now += options.attachmentWaitResult ? 1000 : timeout;
      if (options.attachmentWaitResult && options.confirmation !== 'unknown') {
        if (options.confirmation === 'no-longer-job') value.job = false;
        else value.isPassed = true;
      }
      return Boolean(options.attachmentWaitResult);
    },
    async waitForCurrentChapterFinished(timeout) {
      waits.push({ type: 'chapter', timeout });
      now += options.chapterWaitResult ? 1000 : timeout;
      chapterFinished = Boolean(options.chapterWaitResult);
      return chapterFinished;
    }
  });
  return {
    logs, waits, media, timers,
    start: () => context.runner.media({ enableAnswer: false, videoQuizStrategy: 'ignore' }, document, rawAttachment),
    async tickIntervals() { await Promise.all([...intervals].map((timer) => timer.callback())); },
    async runTimeout(delay) {
      const timer = timers.find((entry) => entry.active && entry.delay === delay);
      assert.ok(timer, `scheduled timeout ${delay} ms`);
      timer.active = false;
      now += delay;
      await timer.callback();
    },
    terminalLogs: () => logs.filter((log) => log.label === '媒体任务执行结果诊断')
  };
}

async function startMedia(fixture) {
  const pending = fixture.start();
  await Promise.resolve();
  await Promise.resolve();
  return { pending };
}

async function endMedia(fixture) {
  fixture.media.currentTime = fixture.media.duration;
  fixture.media.ended = true;
  await fixture.media.dispatch('ended');
}

for (const [confirmation, source] of [['passed', 'attachment-passed'], ['no-longer-job', 'attachment-no-longer-job']]) {
  test(`real media execution reports ${source} confirmation without changing completion scheduling`, async () => {
    const fixture = mediaFixture({ attachmentWaitResult: true, confirmation });
    const { pending } = await startMedia(fixture);
    await endMedia(fixture);
    const result = await pending;
    assert.equal(result?.outcome, 'ended');
    assert.equal(result.completionConfirmed, true);
    assert.equal(result.completionSource, source);
    assert.equal(result.completionWaitTimedOut, false);
    assert.equal(result.attachmentWaitResult, true);
    assert.equal(result.chapterWaitResult, null);
    assert.equal(result.mediaEnded, true);
    assert.equal(result.mediaCurrentTime, 100);
    assert.equal(result.finished, undefined);
    assert.deepEqual(fixture.waits, [{ type: 'attachment', timeout: 15000 }]);
    assert.equal(fixture.terminalLogs().length, 1);
    assert.equal(fixture.terminalLogs()[0].level, 'info');
    assert.equal(fixture.terminalLogs()[0].meta.correlationId, 'media-correlation');
  });
}

test('real media execution reports chapter icon confirmation after attachment wait fails', async () => {
  const fixture = mediaFixture({ chapterWaitResult: true });
  const { pending } = await startMedia(fixture);
  await endMedia(fixture);
  const result = await pending;
  assert.equal(result?.completionConfirmed, true);
  assert.equal(result.completionSource, 'chapter-icon');
  assert.equal(result.attachmentWaitResult, false);
  assert.equal(result.chapterWaitResult, true);
  assert.deepEqual(fixture.waits, [{ type: 'attachment', timeout: 15000 }, { type: 'chapter', timeout: 10000 }]);
});

test('real media execution distinguishes ended playback from completion confirmation timeout', async () => {
  const fixture = mediaFixture();
  const { pending } = await startMedia(fixture);
  await endMedia(fixture);
  const result = await pending;
  assert.equal(result?.outcome, 'ended');
  assert.equal(result.completionConfirmed, false);
  assert.equal(result.completionSource, 'none');
  assert.equal(result.completionWaitTimedOut, true);
  assert.equal(result.attachmentWaitResult, false);
  assert.equal(result.chapterWaitResult, false);
  assert.equal(result.executionDurationMs, 25000);
  assert.equal(fixture.terminalLogs().length, 1);
  assert.equal(fixture.terminalLogs()[0].level, 'warn');
  assert.doesNotMatch(JSON.stringify(fixture.terminalLogs()), /secret-token|secret-signature|https:\/\/media/u);
});

test('an unknown attachment flag cannot turn the legacy successful wait check into explicit confirmation', async () => {
  const fixture = mediaFixture({ attachment: { job: undefined, isPassed: undefined }, attachmentWaitResult: true, confirmation: 'unknown' });
  const { pending } = await startMedia(fixture);
  await endMedia(fixture);
  const result = await pending;
  assert.equal(result?.attachmentWaitResult, true);
  assert.equal(result.attachmentJob, null);
  assert.equal(result.attachmentPassed, null);
  assert.equal(result.completionConfirmed, false);
  assert.equal(result.completionSource, 'none');
  assert.equal(result.completionWaitTimedOut, false, 'a skipped check is not an elapsed timeout');
});

test('missing media returns an error diagnostic without running completion waits', async () => {
  const fixture = mediaFixture({ missingMedia: true });
  const result = await fixture.start();
  assert.equal(result?.outcome, 'media-not-found');
  assert.equal(result.completionConfirmed, false);
  assert.equal(result.completionWaitTimedOut, false);
  assert.equal(result.attachmentWaitResult, null);
  assert.equal(result.chapterWaitResult, null);
  assert.deepEqual(fixture.waits, []);
  assert.equal(fixture.terminalLogs().length, 1);
  assert.equal(fixture.terminalLogs()[0].level, 'error');
});

test('a missing player container is reported even when a media element exists', async () => {
  const fixture = mediaFixture({ missingPlayer: true });
  const result = await fixture.start();
  assert.equal(result?.outcome, 'media-not-found');
  assert.equal(result.mediaPresent, true);
  assert.equal(result.completionConfirmed, false);
  assert.deepEqual(fixture.waits, []);
  assert.equal(fixture.terminalLogs().length, 1);
  assert.equal(fixture.terminalLogs()[0].level, 'error');
});

test('exhausted video routes retain the original delayed exit and emit one failed terminal result', async () => {
  const fixture = mediaFixture({ loadFailed: true });
  const { pending } = await startMedia(fixture);
  await fixture.tickIntervals();
  await fixture.runTimeout(3000);
  const result = await pending;
  assert.equal(result?.outcome, 'load-failed');
  assert.equal(result.completionConfirmed, false);
  assert.equal(result.completionWaitTimedOut, false);
  assert.equal(result.attachmentWaitResult, null);
  assert.equal(result.chapterWaitResult, null);
  assert.deepEqual(fixture.waits, []);
  assert.equal(fixture.terminalLogs().length, 1);
  assert.equal(fixture.terminalLogs()[0].level, 'error');
  await endMedia(fixture);
  assert.equal(fixture.terminalLogs().length, 1, 'a late ended event cannot publish a second terminal result');
});

test('duplicate media ended events execute confirmation waits and publish a terminal result once', async () => {
  let release;
  const confirmation = new Promise((resolve) => { release = resolve; });
  const fixture = mediaFixture({ attachmentWait: () => confirmation });
  const { pending } = await startMedia(fixture);
  fixture.media.ended = true;
  const first = fixture.media.dispatch('ended');
  const second = fixture.media.dispatch('ended');
  release(false);
  await Promise.all([first, second, pending]);
  assert.deepEqual(fixture.waits, [{ type: 'attachment', timeout: 15000 }, { type: 'chapter', timeout: 10000 }]);
  assert.equal(fixture.terminalLogs().length, 1);
});

test('an ended event racing a pending failure exit cannot publish conflicting terminal logs', async () => {
  const fixture = mediaFixture({ loadFailed: true });
  const { pending } = await startMedia(fixture);
  await fixture.tickIntervals();
  await endMedia(fixture);
  if (fixture.timers.some((timer) => timer.active && timer.delay === 3000)) {
    await fixture.runTimeout(3000);
  }
  const result = await pending;
  assert.ok(['ended', 'load-failed'].includes(result?.outcome));
  assert.equal(fixture.terminalLogs().length, 1);
  assert.equal(fixture.terminalLogs()[0].detail.mediaExecution.outcome, result.outcome);
});

test('a delayed failure exit wins once while an ended event is still waiting for completion evidence', async () => {
  let release;
  const confirmation = new Promise((resolve) => { release = resolve; });
  const fixture = mediaFixture({ loadFailed: true, attachmentWait: () => confirmation });
  const { pending } = await startMedia(fixture);
  await fixture.tickIntervals();
  const ended = endMedia(fixture);
  await Promise.resolve();
  assert.deepEqual(fixture.waits, [{ type: 'attachment', timeout: 15000 }]);
  await fixture.runTimeout(3000);
  const result = await pending;
  assert.equal(result.outcome, 'load-failed');
  assert.equal(result.attachmentJob, true);
  assert.equal(result.attachmentPassed, false);
  assert.equal(result.attachmentCompletionConfirmed, false);
  assert.equal(result.completionConfirmed, false);
  assert.equal(result.completionSource, 'none');
  assert.equal(result.completionWaitTimedOut, false);
  assert.equal(result.attachmentWaitResult, null);
  assert.equal(result.chapterWaitResult, null);
  assert.equal(fixture.terminalLogs().length, 1);
  assert.equal(fixture.terminalLogs()[0].detail.mediaExecution.outcome, 'load-failed');
  release(false);
  await ended;
  assert.deepEqual(fixture.waits, [{ type: 'attachment', timeout: 15000 }, { type: 'chapter', timeout: 10000 }]);
  assert.equal(fixture.terminalLogs().length, 1, 'late completion wait cannot overwrite the failed terminal result');
  assert.equal(fixture.terminalLogs()[0].detail.mediaExecution.outcome, 'load-failed');
});
