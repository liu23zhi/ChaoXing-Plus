import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
let browser;
const runtimes = new Map();

async function declarations(path, names) {
  const source = await readFile(path, 'utf8');
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  return names.map((name) => {
    const declaration = parsed.statements.find((node) =>
      ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name)
      || (ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(parsed) === name)));
    assert.ok(declaration, `${path}: ${name}`);
    return declaration.getText(parsed).replace(/^export /, '');
  }).join('\n');
}

before(async () => {
  const shared = [
    await declarations('src/core/utils/event.ts', ['CommonEventEmitter']),
    await declarations('src/core/worker/interface.ts', ['DEFAULT_WORKER_THREAD_COUNT', 'resolveWorkerThreadCount']),
    await declarations('src/projects/cx.ts', [
      'isWindowsHostRuntime', 'getWindowsRuntimeSetting', 'normalizeWindowsAnswerKey',
      'matchesWindowsAnswerKey', 'formatWindowsAnswerKey', 'isWindowsManualAnswerMode', 'createWindowsManualAnswerGate',
      'createWindowsManualAnswerGateController'
    ])
  ].join('\n');
  for (const extension of ['ts', 'js']) {
    const worker = await declarations(`src/core/worker/worker.${extension}`, ['OCSWorker', 'waitForContinuate']);
    runtimes.set(extension, ts.transpileModule(`(() => {
      const topWindow = window.top;
      const settings = {};
      const runtimeStore = { get(key, fallback) { return Object.hasOwn(settings, key) ? settings[key] : fallback; } };
      const showTopCenterNotice = () => {};
      const clearTopCenterNotice = () => {};
      const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
      const domSearchAll = (_elements, root) => ({ title: [root], options: [] });
      const AnswerWrapperHandlerConfig = { timeout_seconds: 1260 };
      const actualSetTimeout = window.setTimeout.bind(window);
      window.searchDeadlines = 0;
      window.keyListeners = new Set();
      const addListener = document.addEventListener.bind(document);
      const removeListener = document.removeEventListener.bind(document);
      document.addEventListener = (type, listener, options) => {
        if (type === 'keydown') window.keyListeners.add(listener);
        return addListener(type, listener, options);
      };
      document.removeEventListener = (type, listener, options) => {
        if (type === 'keydown') window.keyListeners.delete(listener);
        return removeListener(type, listener, options);
      };
      window.setTimeout = (callback, ms, ...args) => {
        if (ms === 1270000) { window.searchDeadlines++; ms = 80; }
        return actualSetTimeout(callback, ms, ...args);
      };
      ${shared}
      ${worker}
      window.createGate = () => createWindowsManualAnswerGate([document]);
      window.startFlow = (options = {}) => {
        window.__CX_WIN_HOST__ = {};
        settings['common.settings.windows-answer-mode'] = options.manual === false ? 'auto' : 'manual';
        settings['common.settings.windows-answer-key'] = 'Ctrl+Alt+Shift+S';
        settings['common.settings.windows-answer-threads'] = options.permitCount || 1;
        if (!options.reuseAuthorization) window.authorization = createWindowsManualAnswerGateController([document]);
        window.state = { calls: 0, applied: 0, done: false, updates: [], doneEvents: 0, settledEvents: 0 };
        const state = window.state;
        const worker = new OCSWorker({
          root: Array.from({ length: options.empty ? 0 : options.questions || 1 }, () => document.createElement('section')),
          elements: {},
          thread: options.thread || 1,
          beforeSearch: options.noHook ? undefined : (_ctx, signal) => {
            if (options.hookError) throw new Error('permission hook failed');
            if (options.hookNever) return new Promise(() => {});
            return undefined;
          },
          answerer: async () => {
            state.calls++;
            if (options.closeInFlight) {
              const pending = new Promise((done) => { window.releaseSearch = done; });
              window.searchCompletion = pending.then(() => {
                state.searchReturned = true;
                return [{ name: 'fixture', results: [{ question: 'fixture', answer: ' A ' }] }];
              });
              // Close in this renderer turn, before the shortened search timer can run.
              queueMicrotask(() => {
                state.searchStartedBeforeClose = state.calls === 1 && !worker.isClose;
                worker.emit('stop');
                state.pausedBeforeClose = worker.isStop;
                worker.emit('close');
              });
              return window.searchCompletion;
            }
            if (options.search === 'never') return new Promise(() => {});
            if (options.delay) await new Promise((done) => actualSetTimeout(done, options.delay));
            return [{ name: 'fixture', results: [{ question: 'fixture', answer: ' A ' }] }];
          },
          work: async () => { state.applied++; return { finish: true }; },
          onElementSearched: () => {
            if (options.initializationError === 'elements') throw new Error('elements initialization failed');
          },
          onResultsInitialized: () => {
            if (options.initializationError === 'results') throw new Error('results initialization failed');
          },
          onResultsUpdate: (result) => {
            state.updates.push({ requested: result.requested, resolved: result.resolved, error: result.error });
          }
        });
        if (!options.noHook && !options.hookError && !options.hookNever) window.authorization(worker);
        window.worker = worker;
        worker.on('done', () => { state.doneEvents++; });
        worker.on('settled', () => { state.settledEvents++; });
        window.runCurrentWorker = () => {
          state.done = false;
          window.flow = worker.doWork().then((results) => {
            state.done = true;
            state.rawResults = results;
            state.results = results.map((result) => ({
              requested: result.requested, resolved: result.resolved,
              finish: result.result?.finish, error: result.error,
              answers: result.ctx.searchInfos.flatMap((info) => info.results.map((item) => item.answer))
            }));
            return state.results;
          }, (error) => { state.done = true; state.failure = String(error); });
        };
        window.runCurrentWorker();
      };
    })();`, { compilerOptions: { target: ts.ScriptTarget.ES2019 } }).outputText);
  }
  browser = await puppeteer.launch({
    headless: true, executablePath: process.env.CX_BROWSER_EXECUTABLE,
    protocolTimeout: 15000,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server']
  });
});

after(async () => { await browser?.close(); });

async function pageFor(t, extension, options) {
  const page = await browser.newPage();
  t.after(() => page.close());
  page.setDefaultTimeout(10000);
  await page.setContent('<!doctype html><html><body>Worker permission regression</body></html>');
  await page.addScriptTag({ content: runtimes.get(extension) });
  await page.evaluate((config) => { window.startFlow(config); }, options);
  return page;
}

async function authorize(page) {
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.down('Shift');
  try { await page.keyboard.press('S'); }
  finally {
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    await page.keyboard.up('Control');
  }
}

for (const extension of ['ts', 'js']) {
  test(`${extension}: manual permission and queued questions do not consume the actual search deadline`, async (t) => {
    const page = await pageFor(t, extension, { questions: 2 });
    await page.evaluate(() => new Promise((done) => setTimeout(done, 250)));
    assert.deepEqual(await page.evaluate(() => ({ calls: window.state.calls, deadlines: window.searchDeadlines, done: window.state.done })),
      { calls: 0, deadlines: 0, done: false });
    await authorize(page);
    await page.waitForFunction(() => window.state.applied === 1);
    await page.evaluate(() => new Promise((done) => setTimeout(done, 200)));
    assert.deepEqual(await page.evaluate(() => ({ calls: window.state.calls, deadlines: window.searchDeadlines, done: window.state.done })),
      { calls: 1, deadlines: 1, done: false });
    await authorize(page);
    await page.waitForFunction(() => window.state.done);
    assert.deepEqual(await page.evaluate(() => ({ calls: window.state.calls, applied: window.state.applied, results: window.state.results })), {
      calls: 2, applied: 2,
      results: Array.from({ length: 2 }, () => ({ requested: true, resolved: true, finish: true, answers: ['A'] }))
    });
  });

  test(`${extension}: ordinary searches remain bounded and late answers cannot replace timed-out results`, async (t) => {
    const page = await pageFor(t, extension, { manual: false, noHook: true, delay: 250 });
    await page.waitForFunction(() => window.state.done);
    const completed = await page.evaluate(() => ({ applied: window.state.applied, results: window.state.results }));
    assert.equal(completed.applied, 0);
    assert.equal(completed.results[0].finish, false);
    assert.match(completed.results[0].error, /答题超时/);
    assert.deepEqual(completed.results[0].answers, []);
    await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
    assert.deepEqual(await page.evaluate(() => ({ applied: window.state.applied, results: window.state.results })), completed);
  });

  test(`${extension}: a never-settling ordinary search still finishes with a timeout`, async (t) => {
    const page = await pageFor(t, extension, { manual: false, noHook: true, search: 'never' });
    await page.waitForFunction(() => window.state.done);
    assert.match(await page.evaluate(() => window.state.results[0].error), /答题超时/);
  });

  test(`${extension}: close cancels unauthorized work without queries, answers, or false no-answer updates`, async (t) => {
    for (const options of [{}, { hookNever: true }]) {
      const page = await pageFor(t, extension, options);
      await page.evaluate(() => { window.worker.emit('close'); });
      await page.waitForFunction(() => window.state.done);
      await authorize(page);
      assert.deepEqual(await page.evaluate(() => ({
        calls: window.state.calls, applied: window.state.applied,
        completedRows: window.state.updates.filter((result) => result.resolved).length,
        errors: window.state.updates.filter((result) => result.error).length
      })), { calls: 0, applied: 0, completedRows: 0, errors: 0 });
    }
  });

  test(`${extension}: close cancels paused in-flight work and suppresses its late answer`, async (t) => {
    const page = await pageFor(t, extension, { manual: false, closeInFlight: true });
    await page.waitForFunction(() => window.state.done);
    assert.deepEqual(await page.evaluate(() => ({
      calls: window.state.calls, started: window.state.searchStartedBeforeClose,
      paused: window.state.pausedBeforeClose, returned: Boolean(window.state.searchReturned),
      deadlines: window.searchDeadlines, applied: window.state.applied, resolved: window.state.rawResults[0].resolved
    })), { calls: 1, started: true, paused: true, returned: false, deadlines: 1, applied: 0, resolved: false });
    await page.evaluate(async () => {
      window.releaseSearch();
      await window.searchCompletion;
      await Promise.resolve();
    });
    assert.deepEqual(await page.evaluate(() => ({
      returned: window.state.searchReturned, applied: window.state.applied,
      resolved: window.state.rawResults[0].resolved, answers: window.state.rawResults[0].ctx.searchInfos,
      completedUpdates: window.state.updates.filter((result) => result.resolved).length
    })), { returned: true, applied: 0, resolved: false, answers: [], completedUpdates: 0 });
  });

  test(`${extension}: hook failures finish each question and ordinary automatic answers still apply`, async (t) => {
    const failed = await pageFor(t, extension, { hookError: true, questions: 2 });
    await failed.waitForFunction(() => window.state.done);
    assert.deepEqual(await failed.evaluate(() => ({ calls: window.state.calls, applied: window.state.applied })), { calls: 0, applied: 0 });
    assert.ok((await failed.evaluate(() => window.state.results)).every((result) => result.resolved && /permission hook failed/.test(result.error)));
    const automatic = await pageFor(t, extension, { manual: false, noHook: true, questions: 3, thread: 2 });
    await automatic.waitForFunction(() => window.state.done);
    assert.deepEqual(await automatic.evaluate(() => ({ calls: window.state.calls, applied: window.state.applied })), { calls: 3, applied: 3 });
  });

  test(`${extension}: abort removes only its own permit waiter and closing the gate cancels remaining waits`, async (t) => {
    const page = await pageFor(t, extension, {});
    const state = await page.evaluate(async () => {
      window.worker.emit('close');
      await window.flow;
      const gate = window.createGate();
      const controller = new AbortController();
      const canceled = gate.wait(controller.signal).then(() => false, () => true);
      const permitted = gate.wait().then(() => true);
      controller.abort();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, altKey: true, shiftKey: true }));
      const first = await Promise.all([canceled, permitted]);
      const closed = gate.wait().then(() => false, () => true);
      gate.close();
      const afterClose = gate.wait().then(() => false, () => true);
      return { first, closed: await closed, afterClose: await afterClose };
    });
    assert.deepEqual(state, { first: [true, true], closed: true, afterClose: true });
  });

  test(`${extension}: completed manual work can retry with fresh authorization and old callbacks cannot close the retry gate`, async (t) => {
    const page = await pageFor(t, extension, { permitCount: 4 });
    await page.waitForFunction(() => window.keyListeners.size === 1);
    await authorize(page);
    await page.waitForFunction(() => window.state.done);
    assert.equal(await page.evaluate(() => window.keyListeners.size), 0);
    await page.evaluate(() => {
      window.previousWorker = window.worker;
      window.startFlow({ reuseAuthorization: true, permitCount: 4 });
    });
    await page.waitForFunction(() => window.keyListeners.size === 1);
    assert.equal(await page.evaluate(() => window.state.calls), 0);
    await page.evaluate(() => { window.previousWorker.emit('close'); window.previousWorker.emit('done'); });
    assert.equal(await page.evaluate(() => window.keyListeners.size), 1);
    await authorize(page);
    await page.waitForFunction(() => window.state.done);
    assert.deepEqual(await page.evaluate(() => ({ calls: window.state.calls, applied: window.state.applied, listeners: window.keyListeners.size })),
      { calls: 1, applied: 1, listeners: 0 });
    await page.evaluate(() => { window.startFlow({ reuseAuthorization: true }); });
    await page.waitForFunction(() => window.keyListeners.size === 1);
    await page.evaluate(() => window.worker.emit('close'));
    await page.waitForFunction(() => window.state.done);
    assert.equal(await page.evaluate(() => window.keyListeners.size), 0);
  });

  test(`${extension}: concurrent retry workers share one keyboard permit budget and release only their own ownership`, async (t) => {
    const page = await pageFor(t, extension, {});
    await page.waitForFunction(() => window.keyListeners.size === 1);
    await page.evaluate(() => {
      window.firstWorker = window.worker;
      window.firstState = window.state;
      window.startFlow({ reuseAuthorization: true });
    });
    await page.waitForFunction(() => window.keyListeners.size === 1);
    await authorize(page);
    await page.waitForFunction(() => window.firstState.done || window.state.done);
    assert.deepEqual(await page.evaluate(() => ({ calls: window.firstState.calls + window.state.calls, listeners: window.keyListeners.size })),
      { calls: 1, listeners: 1 });
    await authorize(page);
    await page.waitForFunction(() => window.firstState.done && window.state.done);
    assert.deepEqual(await page.evaluate(() => ({ calls: window.firstState.calls + window.state.calls, applied: window.firstState.applied + window.state.applied, listeners: window.keyListeners.size })),
      { calls: 2, applied: 2, listeners: 0 });
  });

  test(`${extension}: a retry started by a done observer cannot inherit the completed worker's unused permits`, async (t) => {
    const page = await pageFor(t, extension, { permitCount: 4 });
    await page.waitForFunction(() => window.keyListeners.size === 1);
    await page.evaluate(() => {
      window.previousState = window.state;
      window.worker.on('done', () => {
        window.startFlow({ reuseAuthorization: true, permitCount: 4 });
        window.doneRetryStarted = true;
      });
    });
    await authorize(page);
    await page.waitForFunction(() => window.doneRetryStarted && window.previousState.done);
    assert.deepEqual(await page.evaluate(() => ({ calls: window.state.calls, done: window.state.done, listeners: window.keyListeners.size })),
      { calls: 0, done: false, listeners: 1 });
    await authorize(page);
    await page.waitForFunction(() => window.state.done);
    assert.deepEqual(await page.evaluate(() => ({ calls: window.state.calls, applied: window.state.applied, listeners: window.keyListeners.size })),
      { calls: 1, applied: 1, listeners: 0 });
  });

  test(`${extension}: one permit batch spans four pages of the same worker and the fifth page waits again`, async (t) => {
    const page = await pageFor(t, extension, { permitCount: 4 });
    await page.waitForFunction(() => window.keyListeners.size === 1);
    await authorize(page);
    await page.waitForFunction(() => window.state.done);
    for (let pageNumber = 2; pageNumber <= 4; pageNumber++) {
      assert.equal(await page.evaluate(() => window.keyListeners.size), 0);
      await page.evaluate(() => { window.runCurrentWorker(); });
      await page.waitForFunction(() => window.state.done);
      assert.equal(await page.evaluate(() => window.state.applied), pageNumber);
    }
    await page.evaluate(() => { window.runCurrentWorker(); });
    await page.waitForFunction(() => window.keyListeners.size === 1);
    assert.equal(await page.evaluate(() => window.state.calls), 4);
    await authorize(page);
    await page.waitForFunction(() => window.state.done);
    assert.deepEqual(await page.evaluate(() => ({ calls: window.state.calls, applied: window.state.applied, listeners: window.keyListeners.size })),
      { calls: 5, applied: 5, listeners: 0 });
    await page.evaluate(() => { window.worker.emit('close'); window.runCurrentWorker(); });
    await page.waitForFunction(() => window.state.done);
    assert.equal(await page.evaluate(() => window.state.calls), 5, 'close discards unused permits');
  });

  test(`${extension}: initialization failures release ownership without emitting a successful done event`, async (t) => {
    for (const failure of [{ empty: true }, { initializationError: 'elements' }, { initializationError: 'results' }]) {
      const page = await pageFor(t, extension, failure);
      await page.waitForFunction(() => window.state.done);
      assert.deepEqual(await page.evaluate(() => ({ doneEvents: window.state.doneEvents, settledEvents: window.state.settledEvents, running: window.worker.isRunning })),
        { doneEvents: 0, settledEvents: 1, running: false });
      await page.evaluate(() => { window.startFlow({ reuseAuthorization: true }); });
      await page.waitForFunction(() => window.keyListeners.size === 1);
      await authorize(page);
      await page.waitForFunction(() => window.state.done);
      assert.equal(await page.evaluate(() => window.keyListeners.size), 0);
    }
  });
}

test('both chapter and work/exam factories authorize before the worker starts searching', async () => {
  const source = await readFile('src/projects/cx.ts', 'utf8');
  assert.equal((source.match(/createWindowsManualAnswerGateController\(\[(?:frameDocument, document|document)\]\)/g) || []).length, 2);
  assert.equal((source.match(/authorizeManualAnswer\(new OCSWorker\(/g) || []).length, 2);
  assert.equal((source.match(/await manualAnswerGate\?\.wait\(\)/g) || []).length, 0);
});
