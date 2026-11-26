import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';
import { createHash } from 'node:crypto';
import { createAgreementController } from '../src/extension-agreement-core.js';

const defaultBase = 'https://configured.fixture.invalid';
const otherBase = 'https://second.fixture.invalid';
const key = 'synthetic-owned-access';
const hash = data => createHash('sha256').update(data).digest('hex');
const proofId = '7075530c-7398-40eb-b5b1-9f1ce331f762';
const body = '仅用于验证信任边界，不是正式协议。';

test('authorization uses Chromium extension messaging, not page events', async (t) => {
  const saved = Object.fromEntries(['chrome', 'window', 'document', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
    delete globalThis.__CXPLUS_BROWSER_AGREEMENT_GATE__;
  });
  const calls = [];
  let reply = { allowed: false };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: {
    id: 'owned-fixture-extension',
    sendMessage: async msg => { calls.push(msg); return reply; },
  } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  // A pure content-runtime check must not access the page's event transport at all.
  Object.defineProperty(globalThis, 'document', { configurable: true, get() { throw new Error('not a trusted transport'); } });
  globalThis.__CXPLUS_BROWSER_AGREEMENT_GATE__ = true;
  const { hasTikuAgreement } = await loadCompiledTypeScriptModule('src/runtime/agreement-gate.ts');
  assert.equal(await hasTikuAgreement(defaultBase, key), false);
  assert.deepEqual(calls, [{ kind: 'chaoxing-plus:agreement', operation: 'authorize', base: defaultBase, keyHash: hash(key) }]);
  reply = { allowed: true };
  assert.equal(await hasTikuAgreement(defaultBase, key), true);
  delete globalThis.chrome;
  assert.equal(await hasTikuAgreement(defaultBase, key), false, 'unavailable privileged recipient stays closed');
});

test('packaged ordinary runtime is an isolated content script and has no page authorization event', async () => {
  const build = await readFile('build.mjs', 'utf8');
  const content = await readFile('src/extension-agreement-content.js', 'utf8');
  const gate = await readFile('src/runtime/agreement-gate.ts', 'utf8');
  assert.match(build, /world:\s*'ISOLATED'/);
  assert.match(build, /js:\s*\[[^\]]*'chaoxing-plus\.js'/);
  assert.doesNotMatch(content + gate, /chaoxing-plus:agreement-(check|result)/);
});

function fixture(storage = {}) {
  const requests = [];
  let time = 10000;
  const configBase = 'common.settings.tiku-adapter.baseurl';
  const configKey = 'common.settings.tiku-adapter.key';
  Object.assign(storage, { [configBase]: storage[configBase] ?? defaultBase, [configKey]: storage[configKey] ?? key,
    'common.settings.device-id': 'owned-fixture-profile' });
  const controller = createAgreementController({
    defaultBase,
    read: async keys => Object.fromEntries(keys.map(k => [k, structuredClone(storage[k])])),
    write: async values => Object.assign(storage, structuredClone(values)),
    remove: async keys => keys.forEach(k => { delete storage[k]; }),
    now: () => time,
    request: async (url, init) => {
      const u = new URL(url);
      const operation = u.pathname.split('/').at(-1);
      requests.push({ origin: u.origin, operation, auth: Boolean(init.headers.Authorization) });
      if (operation === 'health') return Response.json({ success: true, status: 'succeeded',
        taskId: 'owned', statusUrl: '/api/search/status?taskId=owned',
        deviceAccess: { allowed: true, reason: 'already-registered', limit: 2, used: 3 } });
      if (operation === 'devices') return Response.json({ deviceId: proofId, deviceCredential: 'agd_' + 'x'.repeat(43) }, { status: 201 });
      if (operation === 'consents') storage.accepted = true;
      const status = { version: 'v1', deviceId: proofId, needsAcceptance: !storage.accepted, content_hash: hash(body) };
      return Response.json(operation === 'status' ? status : operation === 'consents'
        ? { accepted: true, acceptedAt: '2026-11-27T01:00:01Z', version: 'v1', deviceId: proofId }
        : { ...status, type: 'user_agreement', summary: 'fixture', publishedAt: '2026-11-27T01:00:00Z', body });
    }
  });
  return { storage, requests, run: (op, data = {}) => controller.run(op, data, 'fixture:0:doc'), tick: by => { time += by; } };
}

test('legacy custom destination never receives a token before explicit extension-owned source confirmation', async () => {
  const f = fixture({ 'common.settings.tiku-adapter.baseurl': otherBase });
  const view = await f.run('refresh');
  assert.equal(view.phase, 'source-unconfirmed');
  assert.ok(f.requests.every(r => !r.auth));
  const result = await f.run('confirm-source', { base: otherBase });
  assert.equal(result.phase, 'pending');
  assert.ok(f.requests.some(r => r.origin === otherBase && r.auth));
  f.storage['common.settings.tiku-adapter.baseurl'] = defaultBase;
  await f.run('refresh');
  assert.ok(f.requests.filter(r => r.origin === defaultBase).every(r => !r.auth));
});

test('an old reading timer is not accepted after a worker restart, and a new reading can recover', async () => {
  const first = fixture();
  const pending = await first.run('refresh');
  const doc = { version: pending.document.version, hash: pending.document.hash };
  await first.run('prepare', doc);
  first.tick(5000);
  const resumed = fixture(first.storage);
  const stale = await resumed.run('accept', doc);
  assert.equal(stale.resetReading, true);
  assert.equal(resumed.requests.filter(r => r.operation === 'consents').length, 0);
  assert.equal((await resumed.run('prepare', doc)).phase, 'pending');
  resumed.tick(5000);
  assert.equal((await resumed.run('accept', doc)).phase, 'accepted');
  assert.equal(resumed.requests.filter(r => r.operation === 'consents').length, 1);
});

test('authority is rechecked after real health and task probes, immediately before task creation', async (t) => {
  const names = ['chrome', 'window', 'navigator', 'fetch', '__CXPLUS_BROWSER_AGREEMENT_GATE__'];
  const saved = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  let allowed = true;
  const calls = [];
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime: { id: 'owned-fixture-extension', sendMessage: async () => ({ allowed }) }
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  globalThis.__CXPLUS_BROWSER_AGREEMENT_GATE__ = true;
  globalThis.fetch = async (url, init) => {
    const endpoint = new URL(url).pathname;
    calls.push([endpoint, init.method]);
    if (endpoint === '/api/search/health') return Response.json({
      success: true, status: 'succeeded', taskId: 'owned-probe', statusUrl: '/api/search/status?taskId=owned-probe'
    });
    if (endpoint === '/api/search/status') {
      allowed = false; // The test service updates its authorization while a harmless probe finishes.
      return Response.json({ success: true, status: 'succeeded', taskId: 'owned-probe', result: { answer: {} } });
    }
    return Response.json({ success: true, status: 'succeeded', result: {} });
  };
  const { requestTikuAdapterSearchTask } = await loadCompiledTypeScriptModule('src/projects/tiku-adapter-config.ts');
  await assert.rejects(requestTikuAdapterSearchTask({ baseurl: defaultBase, key }, { question: 'owned test' }, {
    retryAttempts: 1, healthProbeDelayMs: 0
  }), /阅读并同意/);
  assert.deepEqual(calls, [['/api/search/health', 'GET'], ['/api/search/status', 'GET']]);
});

test('the approved provider can be explicitly diagnosed or cleared without a lookup or a leaked token in the response', async () => {
  const f = fixture();
  await f.run('refresh');
  assert.equal(f.requests.some(r => r.operation === 'health'), false);
  const result = await f.run('diagnose');
  assert.equal(result.state, 'ok');
  assert.deepEqual({ limit: result.deviceLimit, used: result.deviceUsed }, { limit: 2, used: 3 });
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.ok(f.requests.some(r => r.operation === 'health' && r.auth));
  const count = f.requests.filter(r => r.auth).length;
  assert.equal((await f.run('clear-source-key')).cleared, true);
  assert.equal(f.storage['common.settings.tiku-adapter.key'], '');
  assert.equal((await f.run('diagnose')).state, 'missing-key');
  await f.run('refresh');
  assert.equal(f.requests.filter(r => r.auth).length, count);
});

test('clearing an old local token from invalid configuration still performs no request', async () => {
  const f = fixture({ 'common.settings.tiku-adapter.baseurl': 'http://legacy.fixture.invalid' });
  assert.equal((await f.run('clear-source-key')).cleared, true);
  assert.equal(f.storage['common.settings.tiku-adapter.key'], '');
  assert.deepEqual(f.requests, []);
});
