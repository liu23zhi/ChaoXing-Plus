import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from '@typescript/typescript6';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function declarations(path, names) {
  const source = await readFile(path, 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  return names.map((name) => {
    const node = ast.statements.find((entry) => (ts.isFunctionDeclaration(entry) || ts.isClassDeclaration(entry)) && entry.name?.text === name
      || ts.isVariableStatement(entry) && entry.declarationList.declarations.some((item) => item.name.getText(ast) === name));
    assert.ok(node, `${path}: ${name}`);
    return node.getText(ast).replace(/^export /u, '');
  }).join('\n');
}

async function fixture({ paused = false, manual = false } = {}) {
  const attributes = new Map();
  const document = new EventTarget();
  document.documentElement = { getAttribute: (key) => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, value) };
  const window = { document };
  window.top = window;
  document.defaultView = window;
  let deadlines = 0;
  let listeners = 0;
  const context = vm.createContext({ document, window, Event, CustomEvent, AbortController,
    setTimeout(callback, ms, ...args) { if (ms === 1270000) deadlines++; return setTimeout(callback, ms, ...args); },
    clearTimeout, setInterval, clearInterval,
    sleep: delay, domSearchAll: (_elements, root) => ({ title: [root], options: [] }),
    AnswerWrapperHandlerConfig: { timeout_seconds: 1260 },
    isWindowsManualAnswerMode: () => manual,
    getWindowsRuntimeSetting: (name, fallback) => name === 'answer-threads' ? 1 : fallback,
    showTopCenterNotice() {}, clearTopCenterNotice() {}, workResultsMethods: () => ({ refresh() {} })
  });
  const source = [
    (await readFile('src/projects/tab-answer-pause.ts', 'utf8')).replace(/^export /gm, ''),
    await declarations('src/core/utils/event.js', ['CommonEventEmitter']),
    await declarations('src/core/worker/interface.ts', ['DEFAULT_WORKER_THREAD_COUNT', 'resolveWorkerThreadCount']),
    await declarations('src/core/worker/worker.js', ['OCSWorker', 'waitForContinuate']),
    await declarations('src/projects/cx.ts', ['tikuAdapterBalanceRecoveryState', 'trackTikuAdapterWorker',
      'untrackTikuAdapterWorker', 'stopTikuAdapterWorkers', 'continueTikuAdapterWorkers', 'waitForTabAnswerContinue',
      'normalizeWindowsAnswerKey', 'matchesWindowsAnswerKey', 'formatWindowsAnswerKey',
      'createWindowsManualAnswerGate', 'createWindowsManualAnswerGateController'])
  ].join('\n');
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  const api = vm.runInContext('({ OCSWorker, trackTikuAdapterWorker, untrackTikuAdapterWorker, tikuAdapterBalanceRecoveryState, continueTikuAdapterWorkers, controller: getTabAnswerPauseController(), authorize: createWindowsManualAnswerGateController([document]) })', context);
  const realSubscribe = api.controller.subscribe.bind(api.controller);
  api.controller.subscribe = (listener) => {
    listeners++;
    const unsubscribe = realSubscribe(listener);
    let active = true;
    return () => { if (active) { active = false; listeners--; unsubscribe(); } };
  };
  api.controller.setPaused(paused);
  return { ...api, document,
    create(options = {}, retain = false) {
      const worker = new api.OCSWorker({ root: [{ ownerDocument: document }], elements: {},
        answerer: async () => [], work: async () => ({ finish: true }), ...options });
      return api.trackTikuAdapterWorker(api.authorize(worker), retain);
    },
    pressPermit() {
      const event = new Event('keydown');
      Object.assign(event, { key: 'F8', repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
      document.dispatchEvent(event);
    },
    get deadlines() { return deadlines; }, get listenerCount() { return listeners; }
  };
}

test('new main and retry workers honor pre-pause before start and release all tab subscriptions on settled', async () => {
  const api = await fixture({ paused: true });
  let calls = 0;
  const workers = [api.create({ answerer: async () => { calls++; return []; } }), api.create({ answerer: async () => { calls++; return []; } })];
  const running = workers.map((worker) => worker.doWork());
  try {
    await delay(40);
    assert.equal(calls, 0);
    assert.equal(api.deadlines, 0);
    assert.equal(workers.every((worker) => worker.isStop), true);
    api.controller.setPaused(false);
    await Promise.all(running);
    assert.equal(calls, 2);
    assert.equal(api.listenerCount, 0);
  } finally { workers.forEach((worker) => worker.emit('close')); await Promise.allSettled(running); }
});

test('an active retry worker cannot apply an in-flight answer until the panel continues it', async () => {
  const api = await fixture();
  let release;
  let started;
  const searchStarted = new Promise((resolve) => { started = resolve; });
  let applied = 0;
  const worker = api.create({ answerer: () => { started(); return new Promise((resolve) => { release = resolve; }); },
    work: async () => { applied++; return { finish: true }; } });
  const running = worker.doWork();
  try {
    await searchStarted;
    api.controller.setPaused(true);
    release([{ name: 'fixture', results: [{ answer: 'A' }] }]);
    await delay(40);
    assert.equal(applied, 0);
    api.controller.setPaused(false);
    await running;
    assert.equal(applied, 1);
  } finally { worker.emit('close'); await running.catch(() => {}); }
});

test('tab pause composes with the actual Windows permit without consuming a search deadline', async () => {
  const api = await fixture({ manual: true });
  let calls = 0;
  const worker = api.create({ answerer: async () => { calls++; return []; } });
  const running = worker.doWork();
  try {
    await delay(30);
    api.controller.setPaused(true);
    api.pressPermit();
    await delay(40);
    assert.equal(calls, 0);
    assert.equal(api.deadlines, 0);
    api.controller.setPaused(false);
    await running;
    assert.equal(calls, 1);
    assert.equal(api.deadlines, 1);
  } finally { worker.emit('close'); await running.catch(() => {}); }
});

test('a paged worker re-subscribes on its next doWork and explicit untrack releases it', async () => {
  const api = await fixture();
  let calls = 0;
  const worker = api.create({ answerer: async () => { calls++; return []; } }, true);
  await worker.doWork();
  assert.equal(api.listenerCount, 0);
  api.controller.setPaused(true);
  const running = worker.doWork();
  try {
    await delay(40);
    assert.equal(calls, 1);
    assert.equal(api.listenerCount, 1);
    api.controller.setPaused(false);
    await running;
    api.untrackTikuAdapterWorker(worker);
    assert.equal(api.listenerCount, 0);
    assert.equal(api.tikuAdapterBalanceRecoveryState.workers.has(worker), false);
  } finally { worker.emit('close'); await running.catch(() => {}); }
});

test('continue from either pause source cannot bypass the other source', async () => {
  const api = await fixture({ paused: true });
  const worker = api.create();
  api.tikuAdapterBalanceRecoveryState.paused = true;
  api.controller.setPaused(false);
  assert.equal(worker.isStop, true);
  api.controller.setPaused(true);
  api.tikuAdapterBalanceRecoveryState.paused = false;
  api.continueTikuAdapterWorkers();
  assert.equal(worker.isStop, true);
  api.untrackTikuAdapterWorker(worker);
  assert.equal(api.listenerCount, 0);
});

test('close cancels pre-search pause and removes listeners without sending or timing a request', async () => {
  const api = await fixture({ paused: true });
  let calls = 0;
  const worker = api.create({ answerer: async () => { calls++; return []; } });
  const running = worker.doWork();
  await delay(20);
  worker.emit('close');
  await running;
  assert.equal(calls, 0);
  assert.equal(api.deadlines, 0);
  assert.equal(api.listenerCount, 0);
});
