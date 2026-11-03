import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from '@typescript/typescript6';

let modulePromise;
async function createScope() {
  modulePromise ??= (async () => {
    const source = await readFile('src/projects/cx-answer-run-scope.ts', 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 }
    }).outputText;
    return import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
  })();
  return (await modulePromise).createCxAnswerRunScope();
}

function createWorker(callback = () => {}) {
  const events = [];
  const worker = {
    isClose: false,
    opts: {
      onResultsInitialized: callback,
      onResultsUpdate: callback,
      onElementSearched: callback
    },
    emit(event) { events.push({ event, closed: this.isClose }); }
  };
  return { worker, events };
}

test('cancel closes every tracked worker before emitting close and invalidates its callbacks', async () => {
  const scope = await createScope();
  const calls = [];
  const main = createWorker(function (...args) { calls.push({ owner: this, args }); return 'callback result'; });
  const retry = createWorker();
  const ai = createWorker();
  const token = scope.capture();
  assert.equal(scope.track(main.worker), main.worker);
  scope.track(main.worker);
  scope.track(retry.worker);
  scope.track(ai.worker);
  const owner = {};
  assert.equal(main.worker.opts.onResultsInitialized.call(owner, 1), 'callback result');
  assert.deepEqual(calls, [{ owner, args: [1] }]);
  scope.cancel();
  assert.equal(scope.isCurrent(token), false);
  for (const { worker, events } of [main, retry, ai]) {
    assert.equal(worker.isClose, true);
    assert.deepEqual(events, [{ event: 'close', closed: true }]);
    worker.opts.onResultsInitialized(2);
    worker.opts.onResultsUpdate(3);
    worker.opts.onElementSearched(4);
  }
  assert.equal(calls.length, 1);
});

test('a new generation runs fresh workers while saved old callbacks stay invalid', async () => {
  const scope = await createScope();
  let oldCalls = 0;
  let freshCalls = 0;
  const old = createWorker(() => oldCalls++);
  scope.track(old.worker);
  const oldCallback = old.worker.opts.onResultsUpdate;
  scope.cancel();
  const token = scope.capture();
  const fresh = createWorker(() => freshCalls++);
  scope.track(fresh.worker);
  oldCallback();
  fresh.worker.opts.onResultsUpdate();
  assert.equal(scope.isCurrent(token), true);
  assert.equal(oldCalls, 0);
  assert.equal(freshCalls, 1);
  assert.equal(await scope.wait(Promise.resolve(42)), 42);
  scope.cancel();
  assert.deepEqual(old.events, [{ event: 'close', closed: true }]);
  assert.deepEqual(fresh.events, [{ event: 'close', closed: true }]);
});

test('cancel immediately rejects pending waits and consumes late task rejections', async () => {
  const scope = await createScope();
  let rejectLate;
  const task = new Promise((_resolve, reject) => { rejectLate = reject; });
  const pending = scope.wait(task);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  scope.cancel();
  await rejected;
  rejectLate(new Error('late rejection'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await scope.wait(Promise.resolve('new run')), 'new run');
});

test('wait preserves task errors and settled work is not retroactively cancelled', async () => {
  const scope = await createScope();
  const expected = new Error('search failed');
  await assert.rejects(scope.wait(Promise.reject(expected)), (error) => error === expected);
  const settled = scope.wait(Promise.resolve('done'));
  assert.equal(await settled, 'done');
  scope.cancel();
  assert.equal(await settled, 'done');
});

test('a throwing close listener cannot leave other workers or waits running', async () => {
  const scope = await createScope();
  const first = createWorker();
  first.worker.emit = () => { throw new Error('stale listener'); };
  const second = createWorker();
  scope.track(first.worker);
  scope.track(second.worker);
  const pending = scope.wait(new Promise(() => {}));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  assert.doesNotThrow(() => scope.cancel());
  await rejected;
  assert.equal(second.worker.isClose, true);
  assert.deepEqual(second.events, [{ event: 'close', closed: true }]);
});
