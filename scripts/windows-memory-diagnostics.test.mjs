import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { PageSession } from '../windows/node-source/inject.mjs';

const load = () => import('../windows/node-source/memory-diagnostics.mjs');

function fixture(diagnostics, options = {}) {
  const enabled = options.enabled !== false;
  const setter = Object.prototype.hasOwnProperty.call(options, 'setter') ? options.setter : true;
  const page = vm.createContext({});
  page.window = page;
  page.self = page;
  page.top = page;
  page.received = [];
  page.__CX_WIN_HOST__ = { setDiagnostics(payload) { page.received.push(payload); return setter; } };
  const contexts = [];
  const session = new PageSession({
    port: 9333,
    target: { id: 'diagnostics', url: 'https://a.chaoxing.com/exam-ans/' },
    assets: { bootstrap: 'true;', bundle: 'true;', style: '' },
    configStore: { isEnabled: () => true, settingsSnapshot: () => ({ 'common.settings.windows-panel-enabled': enabled }) },
    instanceToken: 'diagnostics-instance', injectStrategy: 'runtime', injectRetries: 0,
    logger: { info() {}, warn() {} }, diagnostics
  });
  session.topFrameId = 'top';
  session.contexts.set(1, { frameId: 'top' });
  session.contexts.set(2, { frameId: 'child' });
  session.bootstrapped.add(1);
  session.bootstrapped.add(2);
  session.diagnosticsReadyContexts.add(1);
  session.diagnosticsReadyContexts.add(2);
  session.frameUrls.set('top', session.target.url);
  session.connection = { closed: false, async send(method, params) {
    assert.equal(method, 'Runtime.evaluate');
    contexts.push(params.contextId);
    const value = vm.runInContext(params.expression, page);
    return { result: { value } };
  }, close() { this.closed = true; } };
  return { session, page, contexts };
}

test('memory diagnostics keeps only the latest 100 fixed metadata records with monotonic time', async () => {
  const { createHostDiagnostics, HOST_DIAGNOSTIC_CODES } = await load();
  let now = 100;
  const diagnostics = createHostDiagnostics({ clock: () => now });
  assert.equal(diagnostics.record('host-started'), true);
  now = 90;
  assert.equal(diagnostics.record('client-started', 'info'), true);
  assert.deepEqual(diagnostics.snapshot().map((entry) => entry.elapsedMs), [0, 0]);
  assert.equal(diagnostics.record('C:\\private\\token=secret'), false);
  assert.equal(diagnostics.record('page-error', 'secret'), false);
  for (let index = 0; index < 120; index++) {
    now = 101 + index;
    diagnostics.record(index % 2 ? 'bundle-ready' : 'bootstrap-ready');
  }
  const entries = diagnostics.snapshot();
  assert.equal(entries.length, 100);
  assert.equal(entries[0].sequence, 23);
  assert.equal(entries.at(-1).sequence, 122);
  assert.ok(entries.every((entry, index) => Object.keys(entry).join(',') === 'sequence,elapsedMs,level,code'
    && HOST_DIAGNOSTIC_CODES.includes(entry.code)
    && (index === 0 || entry.sequence > entries[index - 1].sequence && entry.elapsedMs >= entries[index - 1].elapsedMs)));
  entries[0].code = 'secret';
  entries.length = 0;
  assert.equal(diagnostics.snapshot().length, 100);
  assert.notEqual(diagnostics.snapshot()[0].code, 'secret');
});

test('PageSession sends the complete metadata snapshot only to the active top context', async () => {
  const { createHostDiagnostics } = await load();
  const diagnostics = createHostDiagnostics();
  diagnostics.record('host-started');
  diagnostics.record('endpoint-ready');
  const { session, page, contexts } = fixture(diagnostics);
  assert.equal(await session.broadcastDiagnostics(), true);
  assert.deepEqual(contexts, [1]);
  assert.deepEqual(JSON.parse(JSON.stringify(page.received[0])), {
    source: 'chaoxing-plus-windows-host', instance: 'diagnostics-instance', entries: diagnostics.snapshot()
  });
  session.clearContext(1);
  assert.equal(await session.broadcastDiagnostics(), false);
  assert.deepEqual(contexts, [1]);
  session.close();
});

test('hidden panels never receive diagnostics, while memory records remain independent of disk logging', async () => {
  const { createHostDiagnostics } = await load();
  const diagnostics = createHostDiagnostics();
  diagnostics.record('host-started');
  const { session, contexts } = fixture(diagnostics, { enabled: false });
  assert.equal(await session.broadcastDiagnostics(), false);
  assert.deepEqual(contexts, []);
  assert.equal(diagnostics.snapshot().length, 1);
  session.close();
});

test('diagnostics requires strict true acknowledgement and waits before retrying a rejected setter', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createHostDiagnostics } = await load();
  const diagnostics = createHostDiagnostics();
  diagnostics.record('host-started');
  for (const response of [false, 'true', 1, undefined]) {
    const { session, page, contexts } = fixture(diagnostics, { setter: response });
    assert.equal(await session.broadcastDiagnostics(), false);
    page.__CX_WIN_HOST__.setDiagnostics = () => true;
    assert.equal(await session.broadcastDiagnostics(), false);
    assert.equal(contexts.length, 1);
    t.mock.timers.tick(2000);
    assert.equal(await session.diagnosticDelivery, true);
    assert.equal(contexts.length, 2);
    session.close();
  }
});

test('continuous metadata changes cannot bypass the two-second failed-delivery backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createHostDiagnostics } = await load();
  const diagnostics = createHostDiagnostics();
  diagnostics.record('host-started');
  const { session, page, contexts } = fixture(diagnostics, { setter: false });
  assert.equal(await session.broadcastDiagnostics(), false);
  page.__CX_WIN_HOST__.setDiagnostics = (payload) => { page.received.push(payload); return true; };
  for (let index = 0; index < 30; index++) {
    diagnostics.record('config-updated');
    assert.equal(await session.broadcastDiagnostics(), false);
  }
  t.mock.timers.tick(1999);
  diagnostics.record('bundle-ready');
  assert.equal(await session.broadcastDiagnostics(), false);
  assert.equal(contexts.length, 1);
  t.mock.timers.tick(1);
  assert.equal(await session.diagnosticDelivery, true);
  assert.equal(contexts.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(page.received.at(-1).entries)), diagnostics.snapshot());
  session.close();
});

test('changes arriving during a failed delivery cannot trigger an immediate second CDP request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createHostDiagnostics } = await load();
  const diagnostics = createHostDiagnostics();
  diagnostics.record('host-started');
  const { session, page } = fixture(diagnostics);
  const originalSend = session.connection.send.bind(session.connection);
  let attempts = 0;
  let finish;
  session.connection.send = (...args) => {
    attempts++;
    return attempts === 1 ? new Promise((resolve) => { finish = resolve; }) : originalSend(...args);
  };
  const delivery = session.broadcastDiagnostics();
  diagnostics.record('endpoint-ready');
  const queuedDelivery = session.broadcastDiagnostics();
  finish({ result: { value: false } });
  assert.equal(await delivery, false);
  assert.equal(await queuedDelivery, false);
  assert.equal(attempts, 1);
  t.mock.timers.tick(2000);
  assert.equal(await session.diagnosticDelivery, true);
  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(page.received.at(-1).entries)), diagnostics.snapshot());
  session.close();
});

test('a newly confirmed top context cancels the old document backoff and replays immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createHostDiagnostics } = await load();
  const diagnostics = createHostDiagnostics();
  diagnostics.record('host-started');
  const { session, page, contexts } = fixture(diagnostics, { setter: false });
  assert.equal(await session.broadcastDiagnostics(), false);
  assert.notEqual(session.diagnosticRetryTimer, null);
  page.__CX_WIN_HOST__.setDiagnostics = () => true;
  session.injectSource = async () => {};
  await session.handleEvent({ method: 'Runtime.executionContextCreated', params: {
    context: { id: 3, origin: 'https://a.chaoxing.com', auxData: { isDefault: true, frameId: 'top' } }
  } });
  await session.diagnosticDelivery;
  assert.equal(session.diagnosticRetryTimer, null);
  assert.deepEqual(contexts, [1, 3]);
  t.mock.timers.tick(2000);
  await session.diagnosticDelivery;
  assert.deepEqual(contexts, [1, 3]);
  session.close();
});

test('an in-flight old-document failure cannot delay the newly confirmed top context', async () => {
  const { createHostDiagnostics } = await load();
  const diagnostics = createHostDiagnostics();
  diagnostics.record('host-started');
  const { session } = fixture(diagnostics);
  const originalSend = session.connection.send.bind(session.connection);
  const attemptedContexts = [];
  let finish;
  session.connection.send = (...args) => {
    attemptedContexts.push(args[1].contextId);
    return attemptedContexts.length === 1 ? new Promise((resolve) => { finish = resolve; }) : originalSend(...args);
  };
  const delivery = session.broadcastDiagnostics();
  session.injectSource = async () => {};
  await session.handleEvent({ method: 'Runtime.executionContextCreated', params: {
    context: { id: 3, origin: 'https://a.chaoxing.com', auxData: { isDefault: true, frameId: 'top' } }
  } });
  finish({ result: { value: false } });
  assert.equal(await delivery, true);
  assert.deepEqual(attemptedContexts, [1, 3]);
  assert.equal(session.diagnosticRetryTimer, null);
  session.close();
});

test('closed or replaced contexts cannot acknowledge an old diagnostics delivery', async () => {
  const { createHostDiagnostics } = await load();
  const diagnostics = createHostDiagnostics();
  diagnostics.record('host-started');
  for (const close of [false, true]) {
    const { session } = fixture(diagnostics);
    let resolve;
    session.connection.send = () => new Promise((done) => { resolve = done; });
    const delivery = session.broadcastDiagnostics();
    await Promise.resolve();
    if (close) session.close();
    else session.contexts.set(1, { frameId: 'top' });
    resolve({ result: { value: true } });
    assert.equal(await delivery, false);
    session.close();
  }
});

test('diagnostics waits for confirmed bootstrap and deduplicates an acknowledged revision', async () => {
  const { createHostDiagnostics } = await load();
  const diagnostics = createHostDiagnostics();
  diagnostics.record('host-started');
  const { session, contexts } = fixture(diagnostics);
  session.diagnosticsReadyContexts.clear();
  assert.equal(await session.broadcastDiagnostics(), false);
  assert.deepEqual(contexts, []);
  session.diagnosticsReadyContexts.add(1);
  assert.equal(await session.broadcastDiagnostics(), true);
  assert.equal(await session.broadcastDiagnostics(), true);
  assert.deepEqual(contexts, [1]);
  diagnostics.record('endpoint-ready');
  assert.equal(await session.broadcastDiagnostics(), true);
  assert.deepEqual(contexts, [1, 1]);
  session.close();
});

test('failed delivery retries after two seconds without a new event and cancels on close or context destruction', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createHostDiagnostics } = await load();
  for (const cancellation of ['none', 'close', 'context']) {
    const diagnostics = createHostDiagnostics();
    diagnostics.record('host-started');
    const { session, page, contexts } = fixture(diagnostics, { setter: false });
    assert.equal(await session.broadcastDiagnostics(), false);
    assert.notEqual(session.diagnosticRetryTimer, null);
    page.__CX_WIN_HOST__.setDiagnostics = () => true;
    if (cancellation === 'close') session.close();
    if (cancellation === 'context') session.clearContext(1);
    t.mock.timers.tick(1999);
    assert.equal(contexts.length, 1);
    t.mock.timers.tick(1);
    await session.diagnosticDelivery;
    assert.equal(contexts.length, cancellation === 'none' ? 2 : 1);
    assert.equal(session.diagnosticRetryTimer, null);
    assert.equal(diagnostics.snapshot().length, 1);
    session.close();
  }
});

test('a late bootstrap result cannot mark a replacement context ready for diagnostics', async () => {
  const { createHostDiagnostics } = await load();
  const diagnostics = createHostDiagnostics();
  const { session } = fixture(diagnostics);
  session.bootstrapped.clear();
  session.diagnosticsReadyContexts.clear();
  let finish;
  session.injectSource = () => new Promise((done) => { finish = done; });
  const injection = session.injectBootstrap(1);
  session.clearContext(1);
  session.contexts.set(1, { frameId: 'top' });
  finish();
  await injection;
  assert.equal(session.diagnosticsReadyContexts.has(1), false);
  assert.deepEqual(diagnostics.snapshot(), []);
  session.close();
});

test('only confirmed top bootstrap and bundle events reach memory diagnostics; raw errors never do', async () => {
  const { createHostDiagnostics } = await load();
  const diagnostics = createHostDiagnostics();
  const { session } = fixture(diagnostics);
  session.bootstrapped.clear();
  session.injectSource = async () => {};
  await session.injectBootstrap(2);
  await session.injectBundle(2);
  assert.deepEqual(diagnostics.snapshot(), []);
  await session.injectBootstrap(1);
  await session.injectBundle(1);
  assert.deepEqual(diagnostics.snapshot().map((entry) => entry.code), ['bootstrap-ready', 'bundle-ready']);
  await session.handleEvent({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'token=secret/private/question' } } });
  await session.handleEvent({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'another secret' } } });
  assert.equal(diagnostics.snapshot().filter((entry) => entry.code === 'page-error').length, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /secret|private|question/u);
  session.close();
});
