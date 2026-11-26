// Child of three-mode-contract.fixture.go. The only network destination is the
// Go fixture's loopback listener. The production modules do not spawn clients.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACK, BASE, BROWSER, DEVICE, KEY, LAUNCH, createDiagnostics } from '../../src/extension-diagnostics.js';
import { startHostExamDiagnostics } from '../../windows/node-source/extension-diagnostics.mjs';

assert.equal(process.permission.has('child'), false, 'sender must not be able to launch a process');
assert.equal(process.permission.has('fs.write'), false, 'sender must not be able to write files');
const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const f = JSON.parse(Buffer.concat(input));
assert.match(f.origin, /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/);
const api = f.origin + '/api/extension-logs';
const network = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const dest = new URL(url);
  assert.ok(dest.origin === f.origin && [api, api + '/policy', api + '/start'].includes(dest.origin + dest.pathname),
    'refused a destination outside the owned diagnostic service');
  assert.equal(init.redirect, 'error', 'no forwarding diagnostic credentials');
  return network(url, init);
};
const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const settings = token => ({ [BASE]: f.origin, [KEY]: token, [DEVICE]: f.device });
const eventTime = '2026-11-27T02:03:04.567Z';
function storage(initial = {}) {
  const values = { ...initial };
  return {
    get: async keys => Object.fromEntries([keys].flat().map(k => [k, values[k]])),
    set: async fields => { Object.assign(values, fields); },
    remove: async k => { delete values[k]; },
  };
}

const fresh = ['policy:200', 'start:201', 'entries:201'];
const trace = [];
let wireFault;
function transport(mode, token, browser) {
  return async (url, init) => {
    try {
      const isPolicy = url === api + '/policy?mode=' + mode;
      assert.ok(isPolicy || url === api + '/start' || url === api, 'request outside the owned routes');
      assert.equal(init.method, isPolicy ? 'GET' : 'POST');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
      const headers = new Headers(init.headers);
      assert.ok(headers.get('authorization') === 'Bearer ' + token, 'wrong credential family');
      assert.ok(headers.get('x-script-identity') === (mode === 'native_exam' ? f.identity : null), 'wrong identity binding');
      const body = isPolicy ? null : JSON.parse(init.body);
      const op = isPolicy ? 'policy' : url === api ? 'entries' : 'start';
      if (body) {
        assert.deepEqual(Object.keys(body).sort(), ['version', 'device_id', 'mode', 'launch_id',
          ...(browser ? ['browser_id'] : []), ...(op === 'entries' ? ['entries'] : [])].sort());
        assert.equal(body.mode, mode);
        assert.equal(body.device_id, f.device);
        assert.equal(body.browser_id, browser);
        assert.equal(body.version, version);
        assert.match(body.launch_id, uuid);
      }
      const res = await fetch(url, init);
      trace.push({ op, status: res.status, launch: body?.launch_id });
      const ack = await res.clone().json();
      if (isPolicy) assert.deepEqual(ack, { enabled: true });
      else if (op === 'start') assert.deepEqual(ack, { created: res.status === 201 });
      else assert.deepEqual(ack, { accepted: body.entries.length });
      return res;
    } catch (err) { wireFault = err; throw err; }
  };
}
async function onWire(steps, work) {
  const start = trace.length;
  let result;
  try { result = await work(); } finally { if (wireFault) throw wireFault; }
  assert.deepEqual(trace.slice(start).map(({ op, status }) => op + ':' + status), steps);
  return result;
}
function extension(local, session, token, browser) {
  return createDiagnostics({ storage: local, session, version,
    send: transport(browser ? 'native_browser' : 'extension', token, browser),
    // Flush explicitly via status(); a dormant browser must not keep this test process alive.
    now: () => Date.parse(eventTime), batchDelay: 60_000, schedule: (fn, ms) => setTimeout(fn, ms).unref(),
  });
}
async function event(sender, code, duration) {
  await sender.record(code, duration);
  assert.equal((await sender.status()).state, 'enabled');
}
async function direct(op, token, identity, mode, body) {
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  if (identity) headers['X-Script-Identity'] = identity;
  const url = api + (op === 'policy' ? '/policy?mode=' + mode : op === 'start' ? '/start' : '');
  const res = await fetch(url, { method: op === 'policy' ? 'GET' : 'POST', redirect: 'error', credentials: 'omit',
    headers, ...(op === 'policy' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: await res.json() };
}

const local = storage(settings(f.normalA)), session = storage();
let ext = extension(local, session, f.normalA);
await onWire(['policy:200'], () => ext.wake());
assert.equal((await session.get(LAUNCH))[LAUNCH], undefined);
assert.deepEqual(await readdir(f.dir), [], 'quiet profile must not leave files even on the legacy provider');
if (f.current) {
  const quiet = await direct('start', f.normalA, null, 'extension', {
    mode: 'extension', device_id: f.device, launch_id: randomUUID(), version,
  });
  assert.deepEqual(quiet, { status: 201, body: { created: true } });
  assert.deepEqual(await readdir(f.dir), [], 'registered Start alone must not publish a file');
}
await onWire(['start:201', 'entries:201'], async () => { await ext.record('not-an-allowed-event'); await ext.record('sync.success', 17); await event(ext, 'sync.success', 18); });
const first = (await session.get(LAUNCH))[LAUNCH];
const meta = { mode: 'extension', device_id: f.device, launch_id: first, version };
const entries = [{ event: 'settings.saved', level: 'info', time: new Date().toISOString() }];
ext = extension(local, session, f.normalA); // MV3 worker reconstructed, storage.session retained
await onWire(['policy:200', 'entries:201'], () => event(ext, 'settings.saved'));
await session.remove(ACK); // sender lost its acknowledgement; identify an actual server replay
await onWire(['policy:200'], () => ext.wake());
await onWire(['start:200', 'entries:201'], () => event(ext, 'runtime.error'));
const nextSession = storage();
await onWire(fresh, () => event(extension(local, nextSession, f.normalA), 'network.offline'));
const next = (await nextSession.get(LAUNCH))[LAUNCH];
assert.notEqual(next, first, 'browser restart must rotate the launch');

// Deliberately reuse the launch value across accounts and browser scopes.
// A's accepted start must not authorize B or another mode/browser to append.
async function absentScope(token, body) {
  const result = await direct('entries', token, null, body.mode, { ...body, entries });
  assert.equal(result.status, 409);
  assert.equal(result.body.need_start, true);
}
await absentScope(f.normalB, meta);
await onWire(fresh, () => event(extension(storage(settings(f.normalB)), storage({ [LAUNCH]: first }), f.normalB), 'sync.failed'));
const browsers = Array.from({ length: 3 }, () => randomUUID()); // host-supplied browser identities, not page IDs
assert.equal(new Set(browsers).size, 3);
for (const [i, browser] of browsers.entries()) {
  await absentScope(f.normalA, { ...meta, mode: 'native_browser', browser_id: browser });
  const managed = extension(storage({ ...settings(f.normalA), [BROWSER]: browser }), storage({ [LAUNCH]: first }), f.normalA, browser);
  await onWire(fresh, () => event(managed, 'sync.success', 100 + i));
}

const leaseKey = 'common.settings.tiku-adapter.script-session-token', binding = 'common.settings.tiku-adapter.script-identity';
const grant = { ...settings(f.lease), [leaseKey]: f.lease, [binding]: f.identity };
const activation = { identity: f.identity, expiresAt: f.expiresAt };
const exam = (cfg, active) => startHostExamDiagnostics(cfg, active, { version, send: transport('native_exam', f.lease) });
for (const [cfg, active] of [[{ ...grant, [KEY]: f.normalA, [leaseKey]: f.normalA }, activation],
  [grant, { ...activation, identity: 'cd'.repeat(32) }], [grant, { ...activation, expiresAt: '2000-01-01T00:00:00Z' }]]) {
  assert.equal(await onWire([], () => exam(cfg, active)), false);
}
assert.equal(await onWire(fresh, () => exam(grant, activation)), true);
const examLaunch = trace.at(-1).launch;
for (const [mode, token, id] of [['native_exam', f.normalA, f.identity], ['native_exam', f.lease, 'cd'.repeat(32)],
  ['extension', f.lease, null], ['native_browser', f.lease, null]]) {
  const body = { ...meta, mode, ...(mode === 'native_browser' ? { browser_id: browsers[0] } : {}) };
  for (const op of ['policy', 'start', 'entries']) {
    const res = await direct(op, token, id, mode, op === 'entries' ? { ...body, entries } : body);
    assert.equal(res.status, 401, mode + ' incorrectly admitted ' + op);
  }
}

// Independently read real store output, never a receiver maintained by this JS driver.
const key = (owner, mode, launch, browser = null) => JSON.stringify([owner, mode, launch, browser]);
const wanted = new Map([
  [key(f.ownerA, 'extension', first), ['sync.success:17:2', 'settings.saved', 'runtime.error']],
  [key(f.ownerA, 'extension', next), ['network.offline']],
  [key(f.ownerB, 'extension', first), ['sync.failed']],
  [key(f.ownerA, 'native_exam', examLaunch), ['extension.ready']],
  ...browsers.map((browser, i) => [key(f.ownerA, 'native_browser', first, browser), ['sync.success:' + (100 + i)]]),
]);
const files = (await readdir(f.dir, { recursive: true })).filter(name => name.endsWith('.jsonl'));
assert.equal(files.length, wanted.size);
let rows = 0;
for (const file of files) {
  const raw = await readFile(join(f.dir, file), 'utf8');
  for (const secret of [f.normalA, f.normalB, f.lease, f.identity]) assert.ok(!raw.includes(secret), 'credential reached JSONL');
  const records = raw.trimEnd().split('\n').map(line => JSON.parse(line));
  const scopes = records.map(r => key(r.user_id, r.mode, r.launch_id, r.browser_id));
  assert.equal(new Set(scopes).size, 1, 'mixed launch scope in one physical file');
  assert.ok(wanted.has(scopes[0]), 'unexpected or duplicate file scope');
  for (const r of records) {
    assert.equal(r.device_id, f.device);
    assert.equal(r.version, version);
    assert.equal(Object.hasOwn(r, 'browser_id'), r.mode === 'native_browser');
    if (r.event !== 'session.start') {
      assert.ok(Number.isFinite(Date.parse(r.received_at)), 'receipt timestamp must be present');
      if (r.mode !== 'native_exam') assert.equal(Date.parse(r.time), Date.parse(eventTime));
    }
  }
  if (f.current) {
    const r = records[0];
    const directory = r.mode === 'native_exam' ? 'client/Exam_Client_Injection'
      : r.mode === 'native_browser' ? 'client/Browser_extensions/Multi-browser_mode/' + f.device : 'client/Browser_extensions';
    const suffix = '_u' + r.user_id + '_m' + r.mode + '_d' + f.device
      + (r.browser_id ? '_b' + r.browser_id : '') + '_s' + r.launch_id + '.jsonl';
    assert.equal(file.slice(0, file.lastIndexOf('/')), directory);
    assert.match(file.slice(file.lastIndexOf('/') + 1, -suffix.length), /^\d{19}$/);
    assert.ok(file.endsWith(suffix), 'filename includes the whole mode-specific identity');
  }
  assert.deepEqual(records.map(r => [r.event, r.duration_ms, r.count].filter(n => n !== undefined).join(':')),
    [...(f.current ? [] : ['session.start']), ...wanted.get(scopes[0])]);
  rows += records.length;
  wanted.delete(scopes[0]);
}
assert.equal(wanted.size, 0);
assert.equal(rows, f.current ? 9 : 16);
console.log('CONTRACT: extension = device only; worker resumed, lost ACK replay 200, restart created a new file');
console.log('CONTRACT: native_browser = one device, three host-provided browser IDs; four foreign-scope appends rejected 409');
console.log('CONTRACT: native_exam = pre-existing live lease + bound identity; ordinary/expired/mismatched sender input made zero requests');
console.log('CONTRACT: 12 cross-family/binding HTTP denials (401); two accounts, seven physical JSONL files, ' + rows + ' rows');
