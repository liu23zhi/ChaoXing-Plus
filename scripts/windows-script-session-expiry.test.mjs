import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const fromRepo = (file) => pathToFileURL(resolve(file));
const { PageSession } = await import(fromRepo('windows/node-source/inject.mjs'));
const { createScriptSessionExpiryHandler } = await import(fromRepo('windows/node-source/self-destruct-control.mjs'));
const bootstrap = await readFile(fromRepo('windows/share-file/windows-bootstrap.js'), 'utf8');
const url = 'https://example.invalid/';
const kind = 'script-session-expired';
const eventName = 'chaoxing-plus:' + kind;
const prefix = '__CX_WIN_MSG__';

function makePage({ top = true, registration = 'available' } = {}) {
  const messages = [];
  const window = new EventTarget();
  window.self = window;
  window.top = top ? window : {};
  window.location = { href: url, origin: 'https://example.invalid', pathname: '/' };
  let registrations = 0;
  const addEventListener = window.addEventListener.bind(window);
  if (registration === 'missing') window.addEventListener = undefined;
  else window.addEventListener = (name, handler, options) => {
    if (name === eventName) {
      registrations += 1;
      if (registration === 'throws') throw new Error('fixture rejected registration');
    }
    addEventListener(name, handler, options);
  };
  const context = vm.createContext({
    window,
    document: { readyState: 'complete', addEventListener() {} },
    console: { log(value) { messages.push(String(value)); } }
  });
  const readMessages = () => messages.filter((value) => value.startsWith(prefix));
  const decoded = () => readMessages().map((value) => JSON.parse(value.slice(prefix.length)));
  return {
    evaluate: (source) => vm.runInContext(source, context),
    dispatchExpiry: () => window.dispatchEvent(new Event(eventName)),
    expiryMessages: () => decoded().filter((message) => message.kind === kind),
    get rawExpiryMessage() {
      return readMessages().findLast((value) => JSON.parse(value.slice(prefix.length)).kind === kind);
    },
    get ready() { return decoded().some((message) => message.kind === 'ready'); },
    get registrations() { return registrations; }
  };
}

async function attach(t, page, {
  instanceToken = 'fixture-instance', frameId = 'top', onScriptSessionExpired, onSilentEvent
} = {}) {
  const session = new PageSession({
    port: 9333, target: { id: 'fixture', url }, instanceToken, injectStrategy: 'runtime',
    assets: { bootstrap, bundle: '', trampoline: '', style: '' },
    configStore: {
      isEnabled: () => true,
      settingsSnapshot: () => ({ 'common.settings.windows-panel-enabled': false })
    },
    logger: { info() {}, warn() {} },
    onScriptSessionExpired, onSilentEvent
  });
  t.after(() => session.close());
  session.topFrameId = 'top';
  session.contexts.set(1, { frameId });
  session.injectSource = async (_id, source) => page.evaluate(source);
  await session.injectBootstrap(1);
  assert.equal(session.stats.bootstraps, 1);
  assert.equal(page.ready, true);
  return session;
}

test('an ordinary session and a script-session iframe do not register the expiry listener', async (t) => {
  const normal = makePage();
  await attach(t, normal);
  normal.dispatchExpiry();
  assert.equal(normal.registrations, 0, 'ordinary page must not install the optional listener');
  assert.deepEqual(normal.expiryMessages(), []);

  const child = makePage({ top: false });
  await attach(t, child, { frameId: 'child', onScriptSessionExpired: () => assert.fail('child must not notify host') });
  child.dispatchExpiry();
  assert.equal(child.registrations, 0);
  assert.deepEqual(child.expiryMessages(), []);
});

test('an active top page sends a complete expiry envelope, once after reattach, and ordinary takeover silences it', async (t) => {
  const page = makePage();
  let delivered = 0;
  const onScriptSessionExpired = (...args) => {
    assert.deepEqual(args, [], 'page fields must not become host expiry inputs');
    delivered += 1;
  };
  await attach(t, page, { instanceToken: 'script-fixture', onScriptSessionExpired });
  const reattached = await attach(t, page, { instanceToken: 'script-fixture', onScriptSessionExpired });
  page.dispatchExpiry();
  assert.deepEqual(page.expiryMessages(), [{
    source: 'chaoxing-plus-windows', instance: 'script-fixture', kind, detail: {}
  }]);
  assert.equal(page.registrations, 1);
  reattached.handleConsoleEvent({ executionContextId: 1, args: [{ type: 'string', value: page.rawExpiryMessage }] });
  assert.equal(delivered, 1);

  await attach(t, page, { instanceToken: 'ordinary-takeover' });
  page.dispatchExpiry();
  assert.equal(page.expiryMessages().length, 1, 'the old document listener must not speak for the new host');
});

test('a missing or throwing optional listener cannot stop the page bootstrap', async (t) => {
  for (const registration of ['missing', 'throws']) {
    const page = makePage({ registration });
    await attach(t, page, { onScriptSessionExpired: () => assert.fail('no listener should fire') });
    page.dispatchExpiry();
    assert.deepEqual(page.expiryMessages(), []);
  }
});

test('the host rejects wrong identity, subframes, unknown top frames and unarmed sessions', async (t) => {
  const page = makePage();
  let checks = 0;
  let silentCalls = 0;
  const session = await attach(t, page, {
    onScriptSessionExpired: () => { checks += 1; },
    onSilentEvent: () => { silentCalls += 1; }
  });
  const valid = { source: 'chaoxing-plus-windows', instance: 'fixture-instance', kind, detail: { expiresAt: 0 } };
  session.contexts.set(2, { frameId: 'child' });
  session.bootstrapped.add(2);
  await session.handlePageMessage({ ...valid, source: 'foreign' }, 1);
  await session.handlePageMessage({ ...valid, instance: 'stale' }, 1);
  await session.handlePageMessage(valid, 2);
  await session.handlePageMessage(valid, 999);
  session.topFrameId = null;
  await session.handlePageMessage(valid, 1);
  assert.equal(checks, 0);
  assert.equal(silentCalls, 0, 'expiry must not share the frame-tree fallback of generic silent controls');
  session.topFrameId = 'top';
  await session.handlePageMessage(valid, 1);
  assert.equal(checks, 1);
  session.contexts.set(3, { frameId: 'top' });
  session.bootstrapped.add(3);
  await session.handlePageMessage(valid, 1);
  session.close();
  await session.handlePageMessage(valid, 3);
  assert.equal(checks, 1, 'an old top context and a closed session must not request a check');

  const unarmed = await attach(t, makePage(), { onSilentEvent: () => { silentCalls += 1; } });
  await unarmed.handlePageMessage(valid, 1);
  assert.equal(silentCalls, 0);
});

test('the host checks only the activation response deadline, not any page expiry claim', () => {
  assert.equal(typeof createScriptSessionExpiryHandler, 'function');
  const start = Date.UTC(2026, 10, 8, 0, 0, 0);
  let now = start;
  let requests = 0;
  const request = () => { requests += 1; };
  const check = createScriptSessionExpiryHandler('2026-11-08T08:00:01+08:00', request, () => now);
  assert.equal(typeof check, 'function');
  check({ expiresAt: '1990-01-01T00:00:00Z' });
  now = start + 999;
  check();
  assert.equal(requests, 0);
  now = start + 1000;
  check();
  assert.equal(requests, 1);

  for (const invalid of [undefined, '', '0', 0, {}, '2026-11-08T08:01:00', '2026-02-31T00:00:00Z', '2026-11-08T00:00:00Z']) {
    assert.equal(createScriptSessionExpiryHandler(invalid, request, () => start), null);
  }
  for (const future of [start + 1000, (start + 1000) / 1000]) {
    const checkNumeric = createScriptSessionExpiryHandler(future, request, () => now);
    assert.equal(checkNumeric, null, 'a session must still be valid when activated');
  }
});
