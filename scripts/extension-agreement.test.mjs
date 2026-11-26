import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgreementController, readAgreementJSON } from '../src/extension-agreement-core.js';

const base = 'https://tiku.fixture.test/sub';
const key = 'fixture-access';
const deviceId = '7075530c-7398-40eb-b5b1-9f1ce331f762';
const secret = 'agd_' + 'a'.repeat(43);
const proof = hash(key);
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function fixture() {
  let published = 'v1', acknowledged = '', bodyMode = '', disconnected = false, time = 1000;
  let publishDuringRead, stageFailure = false, statusMode = '';
  const reads = [], writes = [];
  const memory = {
    'common.settings.tiku-adapter.baseurl': base,
    'common.settings.tiku-adapter.key': key,
    'common.settings.device-id': 'fixture-browser'
  };
  const body = version => 'Fixture only <script>not markup</script> ' + version;
  const service = async (url, init) => {
    const u = new URL(url);
    const endpoint = u.pathname.split('/').at(-1);
    reads.push({ endpoint, url, headers: init.headers, method: init.method, body: init.body,
      redirect: init.redirect, credentials: init.credentials });
    if (disconnected) throw Error('offline');
    if (endpoint === 'devices') return new Response(JSON.stringify({ deviceId, deviceCredential: secret }), { status: 201 });
    assert.equal(init.headers['X-Agreement-Device'], secret);
    assert.equal(init.headers.Authorization, 'Bearer ' + key);
    const out = {
      status: () => ({
        version: published, deviceId, needsAcceptance: acknowledged !== published,
        ...(statusMode === 'no-hash' ? {} : { content_hash: hash(body(published)) })
      }),
      current: () => ({
        type: 'user_agreement', version: published, summary: 'test-only', body: body(published),
        publishedAt: '2026-01-01T00:00:00Z', needsAcceptance: acknowledged !== published,
        content_hash: hash(body(published))
      }),
      consents: () => {
        const data = JSON.parse(init.body);
        assert.deepEqual(Object.keys(data), ['version']);
        if (data.version !== published) return null;
        acknowledged = data.version;
        return { accepted: true, version: data.version, deviceId, acceptedAt: '2026-01-01T00:00:01.123Z' };
      }
    };
    if (endpoint === 'current') {
      if (publishDuringRead) await publishDuringRead();
      if (u.searchParams.get('version') !== published) return new Response('{"code":"version_conflict"}', { status: 409 });
      if (bodyMode === 'bad-hash') return Response.json({ ...out.current(), body: 'Replacement' });
      if (bodyMode === 'too-large') return Response.json({ ...out.current(), body: 'a'.repeat(300 * 1024) });
    }
    const result = out[endpoint]?.();
    return result ? Response.json(result) : new Response('{"code":"version_conflict"}', { status: 409 });
  };
  const controller = createAgreementController({
    read: async names => Object.fromEntries(names.map(name => [name, structuredClone(memory[name])])),
    write: async values => {
      writes.push(values);
      if (stageFailure && Object.keys(values).some(name => name.includes('.stage.'))) throw Error('out of space');
      Object.assign(memory, structuredClone(values));
    },
    remove: async names => { for (const name of [].concat(names)) delete memory[name]; },
    request: service,
    defaultBase: base,
    now: () => time
  });
  const run = (op, data = {}, reader = 'tab1') => controller.run(op, data, reader);
  const advance = by => { time += by; };
  return { run, reads, writes, memory, advance, publish: version => { published = version; },
    offline: () => { disconnected = true; }, online: () => { disconnected = false; },
    failStage: enabled => { stageFailure = enabled; }, omitHash: () => { statusMode = 'no-hash'; },
    corruptBody: mode => { bodyMode = mode; }, duringCurrent: fn => { publishDuringRead = fn; } };
}
const grip = state => ({ version: state.document.version, hash: state.document.hash });

test('new install remains incomplete until current content staged and a deliberate 5-second action receives a receipt', async () => {
  const f = fixture();
  await f.run('install');
  const view = await f.run('refresh');
  assert.equal(view.installState, 'incomplete');
  assert.equal(view.document.version, 'v1');
  assert.equal(view.document.body, 'Fixture only <script>not markup</script> v1');
  assert.deepEqual(f.reads.map(x => x.endpoint), ['devices', 'status', 'current']);
  assert.equal(f.reads[0].method, 'POST');
  assert.deepEqual(f.reads[0].headers, {});
  assert.equal(f.reads[2].url, base + '/api/agreements/current?version=v1');
  assert.ok(f.reads.every(x => x.redirect === 'error' && x.credentials === 'omit'));
  assert.equal((await f.run('authorize', { base, keyHash: proof })).allowed, false);
  assert.equal((await f.run('accept', grip(view))).acceptedVersion, null);
  await f.run('prepare', grip(view));
  f.advance(4999);
  assert.equal((await f.run('accept', grip(view))).acceptedVersion, null);
  assert.equal(f.reads.filter(x => x.endpoint === 'consents').length, 0);
  f.advance(1);
  assert.equal((await f.run('accept', grip(view))).acceptedVersion, 'v1');
  assert.equal((await f.run('authorize', { base, keyHash: proof })).allowed, true);
  const again = await f.run('refresh');
  assert.equal(again.installState, 'complete');
  assert.equal(again.canSign, false);
  assert.equal(JSON.stringify(again).includes(secret), false);
  assert.equal(JSON.stringify(again).includes(key), false);
});

test('same profile shares consent; tabs have their own timers, teardown and pending attempts are idempotent', async () => {
  const f = fixture();
  const view = await f.run('refresh');
  await f.run('prepare', grip(view), 'tab1');
  f.advance(5000);
  assert.equal((await f.run('accept', grip(view), 'tab2')).acceptedVersion, null);
  await f.run('abandon', {}, 'tab1');
  assert.equal((await f.run('accept', grip(view), 'tab1')).acceptedVersion, null);
  await f.run('prepare', grip(view), 'tab1');
  await f.run('prepare', grip(view), 'tab2');
  f.advance(5000);
  const states = await Promise.all([f.run('accept', grip(view), 'tab1'), f.run('accept', grip(view), 'tab2')]);
  assert.equal(f.reads.filter(x => x.endpoint === 'consents').length, 1);
  assert.ok(states.every(s => s.acceptedVersion === 'v1'));
});

test('network or cache failure preserves old display but cannot grant permission or adopt a new pending version', async () => {
  const f = fixture();
  const first = await f.run('refresh');
  await f.run('prepare', grip(first));
  f.advance(5000);
  await f.run('accept', grip(first));
  f.publish('v2');
  f.corruptBody('bad-hash');
  const failed = await f.run('refresh');
  assert.equal(failed.document.version, 'v1');
  assert.equal(failed.pendingVersion, null);
  assert.equal(failed.canSign, false);
  assert.equal((await f.run('authorize', { base, keyHash: proof })).allowed, false);
  const count = f.reads.length;
  await f.run('refresh');
  assert.equal(f.reads.length, count, 'failed download respects backoff');
  f.advance(300000);
  f.failStage(true);
  f.corruptBody('');
  assert.equal((await f.run('refresh')).document.version, 'v1');
  f.failStage(false);
  f.advance(300000);
  const next = await f.run('refresh');
  assert.equal(next.document.version, 'v2');
  assert.equal(next.pendingVersion, 'v2');
  assert.equal((await f.run('accept', grip(first))).canSign, true);
  await f.run('prepare', grip(next));
  f.advance(5000);
  f.offline();
  assert.equal((await f.run('accept', grip(next))).acceptedVersion, 'v1');
  assert.equal((await f.run('authorize', { base, keyHash: proof })).allowed, false);
  f.online();
  const recovered = await f.run('refresh', { online: true });
  assert.equal(recovered.canSign, true);
  assert.equal(recovered.pendingVersion, 'v2');
});

test('old contract, wrong configuration, stale read and oversized decoded bodies all fail closed', async () => {
  const f = fixture();
  f.omitHash();
  const old = await f.run('refresh');
  assert.equal(old.document.offlineOnly, true);
  assert.equal(old.canSign, false);
  assert.equal((await f.run('authorize', { base, keyHash: proof })).allowed, false);
  const g = fixture();
  g.duringCurrent(async () => { g.publish('v2'); });
  assert.equal((await g.run('refresh')).pendingVersion, null);
  g.duringCurrent(null);
  g.advance(300000);
  g.corruptBody('too-large');
  assert.equal((await g.run('refresh')).pendingVersion, null);
  const h = fixture();
  assert.equal((await h.run('authorize', { base: 'https://other.fixture.test', keyHash: proof })).allowed, false);
  assert.equal((await h.run('authorize', { base, keyHash: hash('another-key') })).allowed, false);
  assert.equal(h.reads.length, 0);
  h.memory['common.settings.tiku-adapter.baseurl'] = 'http://different.fixture.test/';
  assert.equal((await h.run('refresh')).canSign, false);
  assert.equal(h.reads.length, 0);
});

test('a delayed response cannot write or grant across a configuration change', async () => {
  const f = fixture();
  f.duringCurrent(async () => { f.memory['common.settings.tiku-adapter.key'] = 'different'; });
  assert.equal((await f.run('refresh')).canSign, false);
  assert.equal(f.writes.some(w => Object.values(w).some(v => v?.pendingVersion === 'v1')), false);
});

test('reader limits actual streamed UTF-8 bytes, not just untrusted Content-Length', async () => {
  const bad = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('a'.repeat(600)));
      controller.enqueue(new TextEncoder().encode('b'.repeat(600)));
      controller.close();
    }
  }), { headers: { 'Content-Type': 'application/json', 'Content-Length': '42' } });
  await assert.rejects(readAgreementJSON(bad, 1024));
});

test('browser installation and upgrade mark the shared guide incomplete even when creating its tab fails', async () => {
  const { registerAgreement } = await import('../src/extension-agreement-worker.js');
  const values = {};
  const slots = {};
  const tabs = [];
  const bind = name => ({ addListener: listener => { slots[name] = listener; } });
  const chrome = {
    storage: {
      local: {
        get: async keys => Object.fromEntries(keys.map(key => [key, values[key]])),
        set: async value => { Object.assign(values, value); },
        remove: async keys => { for (const key of keys) delete values[key]; }
      },
      onChanged: bind('storage')
    },
    runtime: {
      id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path,
      onMessage: bind('message'), onInstalled: bind('installed')
    },
    tabs: {
      onRemoved: bind('removed'),
      create: async data => { tabs.push(data.url); throw Error('tab refused'); }
    }
  };
  registerAgreement(chrome, base);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  slots.installed({ reason: 'chrome_update' }); await settle();
  assert.deepEqual(tabs, []);
  slots.installed({ reason: 'install' }); await settle();
  assert.equal(values['agreement.install.v1'], 'incomplete');
  assert.equal(tabs.length, 1);
  values['agreement.install.v1'] = 'complete';
  slots.installed({ reason: 'update' }); await settle();
  assert.equal(values['agreement.install.v1'], 'incomplete');
  assert.deepEqual(tabs, Array(2).fill('chrome-extension://test-extension/extension-agreement.html'));
  values['common.settings.device-instance'] = 'native-owned';
  slots.installed({ reason: 'update' }); await settle();
  assert.equal(tabs.length, 2);
});

test('changing the source cannot forward the device proof or a key already tied to another base', async () => {
  const f = fixture();
  await f.run('refresh');
  const originalContacts = f.reads.length;
  f.memory['common.settings.tiku-adapter.baseurl'] = 'https://another.fixture.test/sub';
  const state = await f.run('refresh');
  assert.equal(state.phase, 'configuration');
  assert.equal(state.document.offlineOnly, true);
  assert.equal(f.reads.length, originalContacts);
});
