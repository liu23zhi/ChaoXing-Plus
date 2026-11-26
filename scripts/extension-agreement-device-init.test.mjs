import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAgreementController } from '../src/extension-agreement-core.js';

const shared = 'common.settings.device-id';
const browser = 'common.settings.device-instance';
const enabled = 'common.settings.extension-enabled';
const source = 'common.settings.tiku-adapter.baseurl';
const access = 'common.settings.tiku-adapter.key';
const privateId = 'agreement.local-device.v1';
const replacement = 'agreement.last-device-replacement.v1';
const base = 'https://owned.invalid/tiku';
const key = 'owned-account-one';
const body = 'Local-only agreement fixture.';
const publishedAt = '2026-11-01T00:00:00Z';
const hash = data => createHash('sha256').update(data).digest('hex');
const statusPath = '/api/agreements/status';

function fixture(initial = {}) {
  const memory = { [access]: key, ...initial };
  const agreements = new Map(), calls = [], writes = [];
  let time = 100, controller;
  const response = data => Response.json(data);
  function enroll() {
    const deviceId = randomUUID(), credential = 'agd_' + String(agreements.size + 1).padStart(43, '0');
    const state = { deviceId, credential, owner: null };
    agreements.set(credential, state);
    return state;
  }
  function restart() {
    controller = createAgreementController({
      defaultBase: base, now: () => time,
      read: async names => Object.fromEntries(names.map(name => [name, structuredClone(memory[name])])),
      async write(values) { writes.push(values); Object.assign(memory, structuredClone(values)); },
      async remove(names) { for (const name of names) delete memory[name]; },
      async request(url, init) {
        const u = new URL(url);
        const endpoint = u.pathname.split('/api/').at(-1);
        calls.push({ url, endpoint, headers: init.headers });
        assert.equal(u.origin, new URL(base).origin, 'fixture policy rejects any other endpoint');
        if (endpoint === 'agreements/devices') {
          const { deviceId, credential } = enroll();
          return response({ deviceId, deviceCredential: credential });
        }
        if (endpoint === 'search/health') return response({ success: true, status: 'succeeded', taskId: 'fixture', statusUrl: '/fixture' });
        const state = agreements.get(init.headers['X-Agreement-Device']);
        assert.ok(state);
        const token = init.headers.Authorization;
        if (state.owner && state.owner !== token) return new Response('', { status: 403 });
        const current = { version: 'v1', deviceId: state.deviceId, needsAcceptance: !state.owner,
          content_hash: hash(body), type: 'user_agreement', summary: 'Owned fixture', body, publishedAt };
        if (endpoint === 'agreements/status' || endpoint === 'agreements/current') return response(current);
        assert.equal(endpoint, 'agreements/consents');
        state.owner = token;
        return response({ accepted: true, version: 'v1', deviceId: state.deviceId, acceptedAt: publishedAt });
      }
    });
  }
  restart();
  const changesFor = patch => Object.fromEntries(Object.entries(patch).map(([k, newValue]) =>
    [k, { oldValue: memory[k], newValue }]
  ));
  function set(patch) {
    const changes = changesFor(patch);
    Object.assign(memory, patch);
    controller.changed(changes);
  }
  const run = (op, data, reader = 'owned') => controller.run(op, data, reader);
  async function sign() {
    const view = await run('refresh');
    assert.equal(view.phase, 'pending');
    const ref = { version: view.document.version, hash: view.document.hash };
    await run('prepare', ref);
    time += 5000;
    const confirmed = await run('accept', ref);
    assert.equal(confirmed.phase, 'accepted');
    return confirmed.scope;
  }
  const authorize = (token = key, url = base) => run('authorize', { base: url, keyHash: hash(token) });
  const count = name => calls.filter(row => row.endpoint === name).length;
  return { memory, agreements, calls, writes, enroll, restart, set, run, sign, authorize, count };
}

test('fresh agreement never writes shared ID; first business ID keeps the signed subject, subsequent conflict does not', async () => {
  const f = fixture();
  const signed = await f.sign();
  assert.equal(f.memory[shared], undefined, 'agreement cannot initialize the shared ID');
  assert.equal(f.writes.some(entry => Object.hasOwn(entry, shared)), false);
  assert.equal(f.count('agreements/devices'), 1);

  f.set({ [shared]: 'business-first' });
  assert.equal((await f.run('refresh')).scope, signed);
  assert.equal((await f.authorize()).allowed, true);
  await f.run('diagnose');
  assert.equal(f.calls.at(-1).headers['X-Device-Id'], 'business-first', 'health headers use actual business ID');
  f.restart();
  assert.equal((await f.run('refresh')).scope, signed);
  assert.equal(f.count('agreements/devices'), 1);

  f.set({ [shared]: 'business-after-conflict' });
  assert.equal((await f.authorize()).allowed, false);
  const displaced = await f.run('refresh');
  assert.equal(displaced.phase, 'pending');
  assert.notEqual(displaced.scope, signed);
  assert.equal(f.count('agreements/devices'), 2);
  f.set({ [shared]: undefined });
  assert.equal((await f.authorize()).allowed, false, 'an established business ID cannot silently fall back to old consent');
});

test('persisted conflict is never the bootstrap subject even before any storage event or after restart', async () => {
  const nextId = randomUUID();
  for (const mark of [nextId, randomUUID()]) {
    const f = fixture();
    const signed = await f.sign();
    // An authoritative read can already see the atomic replacement while the worker has not received any events.
    Object.assign(f.memory, { [shared]: nextId, [replacement]: mark });
    f.restart();
    assert.equal((await f.authorize()).allowed, false);
    const next = await f.run('refresh');
    assert.equal(next.phase, 'pending');
    assert.notEqual(next.scope, signed);
    assert.equal(f.count('agreements/devices'), 2);
    f.set({ [shared]: undefined });
    assert.equal((await f.authorize()).allowed, false, 'removing the shared ID cannot resurrect the bootstrap scope');
  }
});

test('an observed A to B conflict before any queued configuration read cannot bind B to the bootstrap subject', async () => {
  const f = fixture();
  const initial = await f.sign();
  f.set({ [shared]: 'business-a' });
  f.set({ [shared]: 'business-b' }); // queue saw both changes, no operation read A
  assert.equal((await f.authorize()).allowed, false);
  assert.notEqual((await f.run('refresh')).scope, initial);
  assert.equal(f.count('agreements/devices'), 2);
});

test('legacy signed credential is found in its existing scope; account/source change still requires live proof', async () => {
  const legacy = 'owned-legacy-device';
  const f = fixture({ [shared]: legacy });
  const scope = hash(JSON.stringify([base, legacy]));
  const { deviceId, credential } = f.enroll();
  f.agreements.get(credential).owner = 'Bearer ' + key;
  f.memory['agreement.device.' + scope] = { deviceId, deviceCredential: credential };
  f.memory['agreement.cache.' + scope] = { deviceId, acceptedVersion: 'v1',
    document: { version: 'v1', hash: hash(body), summary: 'Owned fixture', body, publishedAt } };
  assert.equal((await f.run('refresh')).phase, 'accepted');
  assert.equal((await f.run('refresh')).scope, scope);
  assert.equal((await f.authorize()).allowed, true);
  assert.equal(f.calls.some(row => row.url.endsWith(statusPath) && row.headers['X-Agreement-Device'] === credential), true);
  assert.equal(f.count('agreements/devices'), 0);
  assert.equal(f.memory[privateId], undefined);
  f.set({ [access]: 'owned-account-two' });
  assert.equal((await f.authorize('owned-account-two')).allowed, false);
  const before = f.calls.length;
  f.set({ [source]: 'https://other.owned.invalid/tiku' });
  assert.equal((await f.authorize('owned-account-two', f.memory[source])).allowed, false);
  assert.equal(f.calls.length, before, 'unconfirmed source gets no proof or key');
});

test('host and disabled profiles never authorize or initialize a normal agreement subject', async () => {
  for (const state of [{ [shared]: 'owned-managed-host', [browser]: randomUUID() }, { [enabled]: false }]) {
    const f = fixture(state);
    assert.equal((await f.authorize()).allowed, false);
    assert.equal(f.memory[shared], state[shared]);
    assert.equal(f.memory[privateId], undefined);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await f.sign();
  f.set({ [shared]: 'owned-managed-host', [browser]: randomUUID() });
  const before = f.calls.length;
  assert.equal((await f.run('refresh')).phase, 'host');
  assert.equal((await f.authorize()).allowed, false);
  assert.equal(f.calls.length, before);
  assert.equal(f.memory[shared], 'owned-managed-host');
});
