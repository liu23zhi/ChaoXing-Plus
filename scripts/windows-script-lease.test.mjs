import test from 'node:test';
import assert from 'node:assert/strict';
import * as lease from '../windows/node-source/script-lease.mjs';
const start = Date.UTC(2026, 10, 21, 0, 0, 0);
const activationUrl = 'https://adapter.example/api/script-command/a/activate';
const heartbeatUrl = 'https://adapter.example/api/script-command/a/heartbeat';
const deadline = start + 130000;
const token = 'sr_fixture-private-token';
const identity = 'ab'.repeat(32);

function clock() {
  let now = start;
  let next = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeoutImpl(callback, delay) {
      const id = ++next;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeoutImpl(id) { timers.delete(id); },
    async advance(to) {
      while (true) {
        const due = [...timers].filter(([, value]) => value.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      }
      now = to;
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    },
    get pending() { return timers.size; }
  };
}

function settings() {
  return {
    'common.settings.tiku-adapter.baseurl': 'https://adapter.example',
    'common.settings.tiku-adapter.script-activation-token': 'activation-fixture',
    'common.settings.tiku-adapter.script-session-url': activationUrl
  };
}

function grant(extra = {}) {
  return { token, identity, heartbeatUrl, expiresAt: new Date(deadline).toISOString(), ...extra };
}

test('activation uses a fresh 32-byte identity and consumes only the one-time settings', async () => {
  assert.equal(typeof lease.activateScriptSessionFromSettings, 'function', 'the lease activation boundary is missing');
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return Response.json({ token, heartbeatUrl: '/api/script-command/a/heartbeat', expiresAt: new Date(deadline).toISOString() });
  };
  const firstSettings = settings();
  const first = await lease.activateScriptSessionFromSettings(firstSettings, { fetchImpl, now: () => start });
  const second = await lease.activateScriptSessionFromSettings(settings(), { fetchImpl, now: () => start });
  assert.match(first.identity, /^[a-f0-9]{64}$/u);
  assert.notEqual(first.identity, second.identity);
  assert.equal(first.heartbeatUrl, heartbeatUrl);
  assert.equal(first.token, token);
  assert.deepEqual(JSON.parse(seen[0].init.body), { activationToken: 'activation-fixture', identity: first.identity });
  assert.equal(seen[0].url, activationUrl);
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers['Content-Type'], 'application/json');
  assert.equal(seen[0].init.headers['Cache-Control'], 'no-store');
  assert.equal(firstSettings['common.settings.tiku-adapter.key'], token);
  assert.equal(firstSettings['common.settings.tiku-adapter.script-identity'], first.identity);
  assert.equal(Object.hasOwn(firstSettings, 'common.settings.tiku-adapter.script-activation-token'), false);
  assert.equal(Object.hasOwn(firstSettings, 'common.settings.tiku-adapter.script-session-url'), false);
});

test('activation rejects an incomplete bootstrap and unsafe lease responses before installing credentials', async () => {
  assert.equal(typeof lease.activateScriptSessionFromSettings, 'function');
  assert.equal(await lease.activateScriptSessionFromSettings({}), null);
  await assert.rejects(lease.activateScriptSessionFromSettings({
    'common.settings.tiku-adapter.script-activation-token': 'activation-fixture'
  }), /激活/u);
  for (const response of [
    { heartbeatUrl: 'https://other.example/api/script-command/a/heartbeat' },
    { heartbeatUrl: '//other.example/api/script-command/a/heartbeat' },
    { heartbeatUrl: 'https://user:pass@adapter.example/api/script-command/a/heartbeat' },
    { heartbeatUrl: '/api/script-command/a/heartbeat#fragment' },
    { heartbeatUrl: '' },
    { expiresAt: 'invalid' },
    { expiresAt: new Date(start).toISOString() },
    { token: '' }
  ]) {
    const config = settings();
    await assert.rejects(lease.activateScriptSessionFromSettings(config, {
      now: () => start,
      fetchImpl: async () => Response.json({ ...grant(), ...response })
    }), /激活/u);
    assert.equal(config['common.settings.tiku-adapter.key'], undefined);
  }
});

test('the lease sends one authenticated heartbeat each minute and cannot extend its activation deadline', async () => {
  assert.equal(typeof lease.startScriptSessionLease, 'function');
  const time = clock();
  const calls = [];
  const failures = [];
  lease.startScriptSessionLease(grant(), {
    ...time,
    fetchImpl: async (url, init) => {
      calls.push({ at: time.now(), url, init });
      return Response.json({ expiresAt: '2099-01-01T00:00:00Z' });
    },
    onInvalid: (reason) => failures.push(reason)
  });
  await time.advance(start + 59999);
  assert.equal(calls.length, 0);
  await time.advance(start + 60000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, heartbeatUrl);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + token);
  assert.equal(calls[0].init.headers['X-Script-Identity'], identity);
  await time.advance(start + 120000);
  assert.equal(calls.length, 2);
  await time.advance(deadline);
  assert.deepEqual(failures, ['expired']);
  assert.equal(time.pending, 0);
  await time.advance(start + 360000);
  assert.equal(calls.length, 2);
});

test('HTTP, network and malformed heartbeat failures stop once without leaking response details', async () => {
  assert.equal(typeof lease.startScriptSessionLease, 'function');
  for (const fetchImpl of [
    async () => Response.json({ message: token }, { status: 401 }),
    async () => Response.json({ message: token }, { status: 403 }),
    async () => Response.json({ message: token }, { status: 500 }),
    async () => { throw new Error(token); },
    async () => new Response('<html>gateway</html>'),
    async () => Response.json({ expiresAt: 'invalid' })
  ]) {
    const time = clock();
    const failures = [];
    lease.startScriptSessionLease(grant(), { ...time, fetchImpl, onInvalid: (reason) => failures.push(reason) });
    await time.advance(start + 60000);
    assert.deepEqual(failures, ['heartbeat-failed']);
    assert.equal(time.pending, 0);
    await time.advance(start + 240000);
    assert.equal(failures.length, 1);
  }
});

test('heartbeat timeout fails closed while a normal close aborts in-flight work without reporting failure', async () => {
  assert.equal(typeof lease.startScriptSessionLease, 'function');
  for (const cancel of [false, true]) {
    const time = clock();
    const failures = [];
    let requestSignal;
    const control = lease.startScriptSessionLease(grant(), {
      ...time,
      fetchImpl: async (_url, init) => {
        requestSignal = init.signal;
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      },
      onInvalid: (reason) => failures.push(reason)
    });
    await time.advance(start + 60000);
    assert.equal(requestSignal.aborted, false);
    if (cancel) control.close();
    await time.advance(start + 70000);
    assert.equal(requestSignal.aborted, true);
    assert.deepEqual(failures, cancel ? [] : ['heartbeat-failed']);
    assert.equal(time.pending, 0);
  }
});

test('expiry interrupts a heartbeat and never waits for the network to stop the client', async () => {
  assert.equal(typeof lease.startScriptSessionLease, 'function');
  const time = clock();
  const failures = [];
  let requestSignal;
  lease.startScriptSessionLease(grant({ expiresAt: new Date(start + 65000).toISOString() }), {
    ...time,
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
    onInvalid: (reason) => failures.push(reason)
  });
  await time.advance(start + 65000);
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(failures, ['expired']);
  assert.equal(time.pending, 0);
});
