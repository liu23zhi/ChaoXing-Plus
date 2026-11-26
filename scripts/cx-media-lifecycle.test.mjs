import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from '@typescript/typescript6';

const source = await readFile('src/projects/cx.ts', 'utf8');
const ast = ts.createSourceFile('cx.ts', source, ts.ScriptTarget.Latest, true);
const helpers = new Set(['getStudyAttachmentDiagnostics', 'getStudyMediaDiagnostics']);
const code = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && helpers.has(node.name?.text))
  .map((node) => node.getText(ast)).join('\n');
const runner = ast.statements.filter(ts.isVariableStatement)
  .flatMap((node) => [...node.declarationList.declarations])
  .find((node) => node.name.getText(ast) === 'JobRunner');
const mediaMethod = runner.initializer.properties.find((node) => node.name?.getText(ast) === 'media');
const mediaCode = ts.transpileModule(`${code}\n globalThis.runMedia = ({${mediaMethod.getText(ast)}}).media;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const noop = () => {};

function fixture(options = {}) {
  let now = 1000;
  let plays = 0;
  let quizReads = 0;
  const logs = [];
  const timers = new Set();
  const intervals = new Set();
  const sleepers = [];
  const listeners = new Map();
  const media = {
    currentTime: 0, duration: 100, ended: false, paused: true, readyState: 4, networkState: 1, error: null,
    currentSrc: 'https://private.example?token=secret',
    async play() { plays++; if (options.rejectPlay) throw new Error('private playback error'); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    async dispatch(type) { await Promise.all([...(listeners.get(type) || [])].map((handler) => handler())); }
  };
  const videojs = {};
  const doc = {
    querySelector(selector) {
      if (selector === '#videoquiz-submit') { quizReads++; return null; }
      return /video|audio/u.test(selector) ? media : null;
    },
    querySelectorAll: () => []
  };
  const rawAttachment = { job: true, isPassed: false, jobid: 'job-1', property: { _jobid: 'job-1', name: 'video' } };
  const schedule = (set, callback, delay) => { const timer = { callback, delay }; set.add(timer); return timer; };
  const sandbox = {
    Date: class extends Date { static now() { return now; } },
    waitForMedia: async () => { if (options.waitError) throw options.waitError; return media; },
    domSearch: () => ({ videojs }), state: { study: {} }, topWindow: {}, fixedVideoProgress: noop,
    CXAnalyses: { getCurrentChapterStayKey: () => 'chapter-1' },
    buildChapterCorrelationId: () => 'correlation',
    logDebug(level, label, detail) {
      if (options.failTerminalLog && label === '媒体任务执行结果诊断') throw new Error('log store unavailable');
      logs.push({ level, label, detail: JSON.parse(JSON.stringify(detail)) });
    },
    $console: { error: noop, warn: noop, log: noop }, $message: { error: noop, warn: noop },
    setInterval: (callback, delay) => schedule(intervals, callback, delay), clearInterval: (timer) => intervals.delete(timer),
    setTimeout: (callback, delay) => schedule(timers, callback, delay), clearTimeout: (timer) => timers.delete(timer),
    inspectVideoLoadState: () => ({ loadFailureDetected: Boolean(options.loadFailed), routeControls: [] }),
    shouldWaitAfterVideoRouteSwitch: () => false, trySwitchVideoRoute: () => false,
    isVideoLoadFailure: () => Boolean(options.loadFailed), VIDEO_ROUTE_SWITCH_GRACE_MS: 10000,
    hasFaceRecognition: () => false, hasNewFaceRecognition: () => false,
    sleep: (duration) => new Promise((resolve) => sleepers.push({ duration, resolve })),
    playMedia: async (play) => { try { await play(); return true; } catch { return false; } },
    waitForAttachmentComplete: options.waitForAttachmentComplete || (async () => false),
    waitForCurrentChapterFinished: options.waitForCurrentChapterFinished || (async () => false)
  };
  vm.runInContext(mediaCode, vm.createContext(sandbox));
  return {
    media, logs, timers, intervals, sleepers, sandbox,
    plays: () => plays, quizReads: () => quizReads,
    listenerCount: () => [...listeners.values()].reduce((count, handlers) => count + handlers.size, 0),
    start: () => sandbox.runMedia({ enableAnswer: Boolean(options.quiz), videoQuizStrategy: options.quiz ? 'random' : 'ignore' }, doc, rawAttachment),
    async timeout(delay) {
      const timer = [...timers].find((item) => item.delay === delay);
      assert.ok(timer, `scheduled timeout ${delay}`);
      timers.delete(timer); now += delay; await timer.callback(); await flush();
    },
    async interval(delay) {
      for (const timer of [...intervals].filter((item) => item.delay === delay)) { now += delay; await timer.callback(); }
      await flush();
    },
    async wake() { const pending = sleepers.splice(0); pending.forEach((item) => item.resolve()); await flush(); },
    async end() { media.ended = true; media.currentTime = 100; await media.dispatch('ended'); await flush(); }
  };
}

test('failed media releases its listeners and delayed startup before returning', async () => {
  const f = fixture({ loadFailed: true });
  const pending = f.start(); await flush();
  await f.interval(3000); await f.timeout(3000);
  assert.equal((await pending).outcome, 'load-failed');
  await f.media.dispatch('pause'); await f.wake();
  for (const timer of [...f.timers]) await timer.callback();
  await flush();
  assert.equal(f.plays(), 0, 'failed playback cannot restart after its caller proceeds');
  assert.equal(f.listenerCount(), 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.intervals.size, 0);
});

test('ended media cancels an already queued pause recovery', async () => {
  const f = fixture(); const pending = f.start(); await flush();
  await f.media.dispatch('pause'); await flush();
  assert.equal(f.sleepers.length, 1);
  await f.end(); assert.equal((await pending).outcome, 'ended');
  await f.wake();
  assert.equal(f.plays(), 0, 'the paused callback must check termination again after waiting');
  assert.equal(f.listenerCount(), 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.intervals.size, 0);
});

test('media quiz polling stops after playback settles', async () => {
  const f = fixture({ quiz: true }); const pending = f.start(); await flush();
  const before = f.quizReads(); assert.equal(before, 1);
  await f.end(); await pending; await f.wake();
  assert.equal(f.quizReads(), before);
  assert.equal(f.sleepers.length, 0, 'a completed task cannot keep scheduling quiz work');
});

test('media element wait failures emit a safe terminal diagnostic and preserve rejection', async () => {
  const failure = Object.assign(new Error('https://private.example?token=secret'), { name: 'private-name' });
  const f = fixture({ waitError: failure });
  await assert.rejects(f.start(), (error) => error === failure);
  const terminal = f.logs.filter((entry) => entry.label === '媒体任务执行结果诊断');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].detail.outcome, 'media-wait-failed');
  assert.equal(terminal[0].detail.errorName, 'UnknownError');
  assert.doesNotMatch(JSON.stringify(f.logs), /private|secret|https:/u);
});

test('play requests, media state changes and completion waits produce bounded diagnostics', async () => {
  const f = fixture(); const pending = f.start(); await flush();
  await f.timeout(200);
  f.media.paused = false; await f.media.dispatch('playing');
  const before = f.logs.length;
  await f.media.dispatch('playing'); await f.media.dispatch('timeupdate');
  assert.equal(f.logs.length, before, 'unchanged events and timeupdate must not flood logs');
  await f.media.dispatch('waiting'); await f.interval(30000);
  assert.ok(f.logs.some((entry) => entry.detail.phase === 'play-request'));
  assert.ok(f.logs.some((entry) => entry.detail.phase === 'play-result' && entry.detail.played === true));
  assert.ok(f.logs.some((entry) => entry.detail.event === 'playing'));
  assert.ok(f.logs.some((entry) => entry.detail.event === 'waiting'));
  assert.ok(f.logs.some((entry) => entry.detail.phase === 'heartbeat'));
  await f.end(); await pending;
  assert.ok(f.logs.some((entry) => entry.detail.phase === 'attachment-wait-start'));
  assert.ok(f.logs.some((entry) => entry.detail.phase === 'chapter-wait-result' && entry.detail.confirmed === false));
  assert.doesNotMatch(JSON.stringify(f.logs), /private|secret|https:/u);
});

test('a rejected pause recovery uses the handled playback path', async () => {
  const f = fixture({ rejectPlay: true }); const pending = f.start(); await flush();
  await f.media.dispatch('pause'); await f.wake();
  assert.equal(f.plays(), 1);
  assert.ok(f.logs.some((entry) => entry.detail.phase === 'play-result' && entry.detail.played === false));
  await f.end(); await pending;
});

test('old media cleanup preserves a newer media owner sharing the same player container', async () => {
  const f = fixture(); const pending = f.start(); await flush();
  const player = f.sandbox.state.study.videojs;
  const newerMedia = {};
  f.sandbox.topWindow.currentMedia = newerMedia;
  await f.end(); await pending;
  assert.equal(f.sandbox.topWindow.currentMedia, newerMedia);
  assert.equal(f.sandbox.state.study.videojs, player);
});

for (const phase of ['before', 'during']) {
  test(`chapter completion from another page is ignored when navigation happens ${phase} confirmation`, async () => {
    let chapterKey = 'chapter-1';
    let waits = 0;
    const f = fixture({
      async waitForAttachmentComplete() { if (phase === 'before') chapterKey = 'chapter-2'; return false; },
      async waitForCurrentChapterFinished() { waits++; chapterKey = 'chapter-2'; return true; }
    });
    f.sandbox.CXAnalyses.getCurrentChapterStayKey = () => chapterKey;
    const pending = f.start(); await flush(); await f.end();
    const result = await pending;
    assert.equal(result.completionConfirmed, false);
    assert.equal(result.completionSource, 'none');
    assert.equal(result.chapterWaitResult, null, 'a different chapter result is not a timeout in the original chapter');
    assert.equal(result.completionWaitTimedOut, false);
    assert.equal(waits, phase === 'before' ? 0 : 1);
  });
}

test('an unavailable chapter owner cannot claim completion from a global icon', async () => {
  const f = fixture({ waitForCurrentChapterFinished: async () => true });
  f.sandbox.CXAnalyses.getCurrentChapterStayKey = () => '';
  const pending = f.start(); await flush(); await f.end();
  assert.equal((await pending).completionConfirmed, false);
});

test('a diagnostic output failure cannot replace the original media wait failure', async () => {
  const failure = new Error('media wait failed');
  const f = fixture({ waitError: failure, failTerminalLog: true });
  await assert.rejects(f.start(), (error) => error === failure);
});

test('the bounded log panel retains terminal durations, completion evidence and media error state', async () => {
  const f = fixture(); const pending = f.start(); await flush(); await f.end(); await pending;
  const formatter = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'formatDebugLogPanelValue');
  const panel = vm.createContext({ debugLogPanelMaxEntryTextLength: 4000 });
  vm.runInContext(ts.transpileModule(`${formatter.getText(ast)}\nglobalThis.format = formatDebugLogPanelValue;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText, panel);
  const terminal = f.logs.find((entry) => entry.label === '媒体任务执行结果诊断');
  const rendered = panel.format(terminal.detail);
  for (const key of ['executionDurationMs', 'completionWaitDurationMs', 'attemptedRouteCount', 'completionConfirmed',
    'completionWaitTimedOut', 'attachmentPassed', 'mediaCurrentTime', 'mediaErrorCode', 'mediaNetworkState']) {
    assert.ok(rendered.includes(`"${key}"`), `${key} remains visible in the log panel`);
  }
});

test('terminal diagnostics use the same positive attachment observation that ended the wait', async () => {
  const f = fixture({
    async waitForAttachmentComplete(initial, _timeout, _interval, onComplete) {
      onComplete({ ...initial, job: false });
      assert.equal(initial.job, true); // The detached starting snapshot is not rewritten.
      return true;
    }
  });
  const pending = f.start();
  await flush();
  await f.end();
  const result = await pending;
  assert.equal(result.completionConfirmed, true);
  assert.equal(result.completionSource, 'attachment-no-longer-job');
  assert.equal(result.attachmentWaitResult, true);
  assert.equal(result.chapterWaitResult, null);
});
