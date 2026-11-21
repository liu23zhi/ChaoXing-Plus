import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { BASE, CONSENT, KEY, KIND, MASTER, createDiagnostics, registerDiagnostics, serviceURL } from '../src/extension-diagnostics.js';

function mock(initial = {}) {
  let listener;
  const values = { ...initial };
  const modify = (items, remove = false) => {
    const changes = {};
    for (const [key, value] of Object.entries(items)) {
      if (values[key] === value) continue;
      changes[key] = { oldValue: values[key], newValue: value };
      if (remove) delete values[key]; else values[key] = value;
    }
    if (Object.keys(changes).length) listener?.(changes, 'local');
  };
  const storage = {
    get: async keys => Object.fromEntries(keys.filter(k => Object.hasOwn(values, k)).map(k => [k, values[k]])),
    set: async fields => modify(fields), remove: async k => modify({ [k]: undefined }, true)
  };
  return { storage, values, on: fn => { listener = fn; } };
}

function fixture({ initial = {}, send, ...options } = {}) {
  const m = mock({ [BASE]: 'https://first.invalid/service/', [KEY]: 'test-key-one', ...initial });
  const requests = [];
  const diag = createDiagnostics({ storage: m.storage, version: '6.3.0', now: () => Date.UTC(2026, 10, 21),
    send: async (url, opts) => { requests.push({ url, ...opts }); return send ? send(url, opts) : { status: 204 }; },
    batchDelay: 5, retryDelay: 8, timeout: 100, ...options });
  m.on(diag.onStorageChanged);
  return { m, diag, requests, enable: async () => diag.setEnabled(true, (await diag.inspect()).stamp) };
}

test('only HTTPS or an actual loopback HTTP service without userinfo, query, or fragment', () => {
  for (const raw of ['https://user:pw@host.invalid', 'http://localhost.bad.invalid', 'file:///tmp', 'data:text/a,b',
    'https://host.invalid?q=secret', 'https://host.invalid/#secret', 'http://192.0.2.100', '']) assert.equal(serviceURL(raw), '');
  assert.equal(serviceURL('http://[::1]:3060/subdir//'), 'http://[::1]:3060/subdir');
  assert.equal(serviceURL('http://127.0.0.1:3060/'), 'http://127.0.0.1:3060');
  assert.equal(serviceURL('https://service.invalid/home'), 'https://service.invalid/home');
});

test('without explicit consent or valid key, no send; consent stores a fingerprint only', async () => {
  const { diag, m, requests, enable } = fixture();
  await diag.record('extension.ready'); await sleep(20); assert.equal(requests.length, 0);
  assert.equal((await enable()).enabled, true);
  assert.match(m.values[CONSENT], /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(await diag.inspect()).includes('test-key-one'));
  await m.storage.set({ [KEY]: '' });
  assert.equal((await enable()).enabled, false);
  await diag.record('extension.ready'); await sleep(20); assert.equal(requests.length, 0);
});

test('fixed event vocabulary, batch counters, no raw fields, no redirects/cookies', async () => {
  const { diag, enable, requests } = fixture();
  await enable();
  await diag.record('wrong event with data');
  await diag.record('sync.success', 11);
  await diag.record('sync.success', { text: 'private raw console', url: 'private URL' });
  await diag.record('runtime.error', 'private raw data');
  await sleep(32);
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.url, 'https://first.invalid/service/api/extension-logs');
  assert.equal(req.headers.Authorization, 'Bearer test-key-one');
  assert.equal(req.redirect, 'error'); assert.equal(req.credentials, 'omit'); assert.equal(req.referrerPolicy, 'no-referrer');
  const time = '2026-11-21T00:00:00.000Z';
  assert.deepEqual(JSON.parse(req.body), { version: '6.3.0', entries: [
    { event: 'sync.success', time, level: 'info', duration_ms: 11, count: 2 },
    { event: 'runtime.error', time, level: 'error' }
  ] });
});

test('account/service switch or disabling cancels an outstanding batch and requires explicit consent again', async () => {
  const { diag, enable, m, requests } = fixture({ batchDelay: 12 });
  const old = (await enable()).stamp;
  await diag.record('network.offline');
  await m.storage.set({ [BASE]: 'https://second.invalid', [KEY]: 'test-key-two' });
  assert.equal((await diag.setEnabled(true, old)).enabled, false);
  await diag.record('extension.ready'); await sleep(30);
  assert.equal(requests.length, 0);
  await enable(); await diag.record('settings.saved');
  await diag.setEnabled(false); await sleep(30); assert.equal(requests.length, 0);
  await enable(); await diag.record('sync.success'); await m.storage.set({ [MASTER]: false }); await sleep(30);
  assert.equal(requests.length, 0);
  await m.storage.set({ [MASTER]: true }); await diag.record('runtime.error'); await sleep(32);
  assert.equal(requests.length, 1); assert.equal(requests[0].headers.Authorization, 'Bearer test-key-two');
  assert.deepEqual(JSON.parse(requests[0].body).entries.map(e => e.event), ['runtime.error']);
});

test('only transient failures retry once; identity change abandons pending retry', async () => {
  for (const [status, expected] of [[503,2],[429,2],[403,1]]) {
    const { diag, enable, requests } = fixture({ send: () => ({ status }) });
    await enable(); await diag.record('sync.failed'); await sleep(54);
    assert.equal(requests.length, expected);
  }
  const f = fixture({ send: () => { throw Error('temporary'); }, retryDelay: 60 });
  await f.enable(); await f.diag.record('extension.ready'); await sleep(22);
  await f.m.storage.set({ [KEY]: 'test-key-two' }); await sleep(75);
  assert.equal(f.requests.length, 1);
});

test('worker accepts toggles only from its own popup and discards extra fields on event messages', async () => {
  let handle;
  const m = mock({ [BASE]: 'https://status.invalid', [KEY]: 'test-key' });
  const api = { runtime: { id:'test-extension', getURL: p => 'chrome-extension://test-extension/' + p,
    getManifest: () => ({version:'6.3.0'}), onMessage: { addListener: fn => { handle = fn; } } },
    storage: { local:m.storage, onChanged: { addListener: fn => m.on(fn) } } };
  registerDiagnostics(api,'');
  const popup = { id:api.runtime.id, url:api.runtime.getURL('popup.html') };
  const page = { id:api.runtime.id, tab:{id:1}, url:'https://page.invalid/' };
  const call = (sender,msg) => new Promise(resolve => {
    if (!handle({kind:KIND,...msg},sender,resolve)) resolve('ignored');
  });
  const { stamp } = await call(popup,{op:'inspect'});
  assert.equal(await call(page,{op:'toggle',on:true,stamp}), 'ignored');
  assert.equal(await call(popup,{op:'record',event:'extension.ready'}), 'ignored');
  assert.equal((await call(popup,{op:'toggle',on:true,stamp})).enabled, true);
  assert.equal((await call(popup,{op:'toggle',on:false})).enabled,false);
});

test('dispatch re-reads the live account even before its browser storage notification arrives', async () => {
  const f = fixture({ batchDelay: 25 });
  await f.enable(); await f.diag.record('extension.ready');
  // Simulate a cross-context update racing the local onChanged delivery.
  const other = fixture({ initial: { [KEY]: 'test-key-two' } });
  const b = await other.enable();
  Object.assign(f.m.values,{ [KEY]: 'test-key-two', [CONSENT]: b.stamp });
  await sleep(70);
  assert.equal(f.requests.length, 0);
});
