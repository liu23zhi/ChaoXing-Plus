import test from 'node:test';
import assert from 'node:assert/strict';
import { registerAgreement } from '../src/extension-agreement-worker.js';

const instance = '01234567-89ab-4cde-8f01-23456789abcd';
const hostName = 'org.cxplus.ordinary_0123456789ab4cde8f0123456789abcd';
const sender = { id: 'owned-extension', tab: { id: 7 }, frameId: 0, documentId: 'owned-document',
  documentLifecycle: 'active', url: 'https://www.chaoxing.com/owned', origin: 'https://www.chaoxing.com' };
const request = { kind: 'chaoxing-plus:agreement', operation: 'authorize' };

function owned({ marker = { hostName, instance }, replies = [], error, timeoutMs } = {}) {
  const call = [], listeners = [];
  const hook = { addListener() {} };
  const runtime = {
    id: sender.id, getURL: path => 'chrome-extension://owned-extension/' + path,
    onMessage: { addListener: cb => listeners.push(cb) }, onInstalled: hook,
    sendNativeMessage(name, message, reply) {
      call.push({ name, message });
      if (!timeoutMs) {
        runtime.lastError = error;
        try { reply(replies.shift()); } finally { delete runtime.lastError; }
      }
    }
  };
  const browser = {
    runtime, tabs: { onRemoved: hook }, storage: {
      local: { async get() { throw new Error('native authority read mutable local storage'); } },
      session: { get: async () => ({ 'cxplus.ordinary.native.v1': marker }) }, onChanged: hook
    }
  };
  registerAgreement(browser, 'https://fixture.invalid', { ordinaryNative: true, timeoutMs });
  return { call, send: (data = request, source = sender) => new Promise(resolve => {
    if (!listeners[0](data, source, resolve)) resolve(undefined);
  }) };
}

test('native child gets exactly one current boolean, never forwards content fields or credentials', async () => {
  const { send, call } = owned({ replies: [{ allowed: true }, { allowed: false }] });
  assert.deepEqual(await send(), { allowed: true });
  assert.deepEqual(await send(), { allowed: false });
  const expected = { name: hostName, message: { op: 'authorize', instance } };
  assert.deepEqual(call, [expected, expected]); // no cached allow after a denial
  assert.deepEqual(await send({ ...request, base: 'https://fixture.invalid', keyHash: '0'.repeat(64) }), { allowed: false });
  assert.deepEqual(call, [expected, expected]);
});

test('untrusted document, absent marker, bad reply, port errors and timeouts fail closed', async () => {
  const blocked = owned();
  for (const source of [
    { ...sender, id: 'another-extension' }, { ...sender, origin: 'https://fixture.invalid' },
    { ...sender, url: 'https://evil.chaoxing.com.invalid/' }, { ...sender, url: 'about:blank' },
    { ...sender, documentLifecycle: 'cached' }, { ...sender, documentId: undefined }
  ]) assert.notDeepEqual(await blocked.send(request, source), { allowed: true });
  assert.deepEqual(blocked.call, []);
  const absent = owned({ marker: null });
  assert.deepEqual(await absent.send(), { allowed: false });
  assert.deepEqual(absent.call, []);
  assert.deepEqual(await owned({ marker: { hostName, instance, key: 'synthetic-not-a-credential' } }).send(), { allowed: false });
  assert.deepEqual(await owned({ replies: [{ allowed: true, token: 'synthetic-not-a-credential' }] }).send(), { allowed: false });
  assert.deepEqual(await owned({ replies: [{ allowed: 'true' }] }).send(), { allowed: false });
  assert.deepEqual(await owned({ replies: [{ allowed: true }], error: { message: 'no port' } }).send(), { allowed: false });
  assert.deepEqual(await owned({ timeoutMs: 15 }).send(), { allowed: false });
});
