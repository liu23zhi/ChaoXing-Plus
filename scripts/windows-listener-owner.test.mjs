import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createListenerOwnershipVerifier,
  getListenerOwnerPid,
  getProcessParentChain,
  parseProcessParentChain
} from '../windows/node-source/launch.mjs';

const loadParser = async () => (await import('../windows/node-source/listener-owner.mjs')).parseNetstatListenerOwner;
const row = (local = '127.0.0.1:49321', state = 'LISTENING', pid = '4242', remote = '0.0.0.0:0') =>
  `  TCP    ${local}    ${remote}    ${state}    ${pid}`;
const queryOptions = (execFileImpl) => ({ platform: 'win32', systemRoot: 'C:\\Windows', execFileImpl });
const chainRow = (pid, parentPid, creation) => `${pid}|${parentPid}|${creation}`;
const parentChainOptions = (execFileImpl) => ({ platform: 'win32', systemRoot: 'C:\\Windows', execFileImpl });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('listener lookup uses netstat directly for every ownership check without caching a PID', async () => {
  const calls = [];
  const execFileImpl = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: row(undefined, undefined, String(4241 + calls.length)), stderr: '' };
  };
  assert.equal(await getListenerOwnerPid(49321, queryOptions(execFileImpl)), 4242);
  assert.equal(await getListenerOwnerPid(49321, queryOptions(execFileImpl)), 4243);
  assert.equal(calls.length, 2);
  for (const { command, args, options } of calls) {
    assert.equal(command, 'C:\\Windows\\System32\\netstat.exe');
    assert.deepEqual(args, ['-ano', '-p', 'tcp']);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.encoding, 'utf8');
    assert.ok(options.timeout > 0 && options.timeout <= 5000);
    assert.ok(options.maxBuffer > 0 && options.maxBuffer <= 4 * 1024 * 1024);
  }
});

test('netstat parser accepts the unique numeric IPv4 listener with either line ending and localized headers', async () => {
  const parse = await loadParser();
  for (const ending of ['\r\n', '\n']) {
    assert.equal(parse(['活动连接', '协议 本地地址 外部地址 状态 PID', row()].join(ending), 49321), 4242);
  }
  for (const [port, pid] of [[1, 1], [65535, 4294967295]]) {
    assert.equal(parse(row(`127.0.0.1:${port}`, 'LISTENING', String(pid)), port), pid);
  }
});

test('netstat parser ignores ordinary connections sharing the local listening port', async () => {
  const parse = await loadParser();
  for (const state of ['ESTABLISHED', 'TIME_WAIT', 'CLOSE_WAIT', 'SYN_SENT', 'SYN_RECEIVED', 'FIN_WAIT_1', 'FIN_WAIT_2', 'CLOSING', 'LAST_ACK', 'CLOSED', 'DELETE_TCB']) {
    assert.equal(parse([row(), row(undefined, state, '0', '127.0.0.1:48222')].join('\n'), 49321), 4242, state);
    assert.equal(parse(row(undefined, state, '4242', '127.0.0.1:48222'), 49321), null, state);
  }
});

test('netstat parser never substitutes wildcard, IPv6, another local address, a remote endpoint or a port substring', async () => {
  const parse = await loadParser();
  for (const local of ['0.0.0.0:49321', '[::]:49321', '[::1]:49321', '[::ffff:127.0.0.1]:49321', '127.0.0.2:49321', '127.0.0.1:4932', '127.0.0.1:493210', '127.0.0.1:049321']) {
    assert.equal(parse(row(local), 49321), null, local);
  }
  assert.equal(parse(row('127.0.0.1:48222', 'ESTABLISHED', '4242', '127.0.0.1:49321'), 49321), null);
  assert.equal(parse([row('127.0.0.2:49321', 'LISTENING', '99'), row()].join('\n'), 49321), 4242,
    'a separate interface is not a duplicate of the exact loopback endpoint');
});

test('netstat parser rejects duplicate listeners even when their PIDs agree', async () => {
  const parse = await loadParser();
  for (const pid of ['4242', '4243']) assert.equal(parse([row(), row(undefined, undefined, pid)].join('\n'), 49321), null);
});

test('netstat parser fails closed on invalid listener PIDs, malformed matching rows and unknown states', async () => {
  const parse = await loadParser();
  for (const pid of ['0', '-1', '+1', '1e3', '12x', '1.5', '4294967296', '9007199254740992']) {
    assert.equal(parse(row(undefined, undefined, pid), 49321), null, pid);
  }
  for (const malformed of [row().replace(/\s+4242$/, ''), row() + ' extra', row().replace('LISTENING', 'UNKNOWN'), row().replace('LISTENING', '侦听'), row().replace('TCP', 'UDP'), row(undefined, undefined, '4242', '127.0.0.1:1')]) {
    assert.equal(parse(malformed, 49321), null);
    assert.equal(parse([row(), malformed].join('\n'), 49321), null, 'a valid row cannot mask a malformed matching row');
  }
  assert.equal(parse('', 49321), null);
  assert.equal(parse(null, 49321), null);
  assert.equal(parse('x'.repeat(4 * 1024 * 1024 + 1), 49321), null);
});

test('listener lookup rejects invalid ports or unsupported execution environments before spawning', async () => {
  const parse = await loadParser();
  let calls = 0;
  const execFileImpl = async () => { calls++; return { stdout: row(), stderr: '' }; };
  for (const port of [0, -1, 65536, 1.5, NaN, Infinity, '49321', null, undefined]) {
    assert.equal(parse(row(), port), null);
    assert.equal(await getListenerOwnerPid(port, queryOptions(execFileImpl)), null);
  }
  assert.equal(await getListenerOwnerPid(49321, { ...queryOptions(execFileImpl), platform: 'linux' }), null);
  for (const systemRoot of ['', 'relative', '\\\\remote\\Windows']) {
    assert.equal(await getListenerOwnerPid(49321, { ...queryOptions(execFileImpl), systemRoot }), null);
  }
  assert.equal(calls, 0);
});

test('netstat failures reject partial output without a PowerShell fallback', async () => {
  for (const code of ['ENOENT', 'EACCES', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 1]) {
    let calls = 0;
    const execFileImpl = async () => {
      calls++;
      throw Object.assign(new Error('private failure detail must not escape'), { code, stdout: row() });
    };
    assert.equal(await getListenerOwnerPid(49321, queryOptions(execFileImpl)), null);
    assert.equal(calls, 1);
  }
  assert.equal(await getListenerOwnerPid(49321, queryOptions(async () => ({ stdout: row(), stderr: 'incomplete result' }))), null);
});

test('real Windows listener lookup returns the owned loopback PID, excludes a connected socket, and observes closure', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const accepted = new Set();
  const server = net.createServer((socket) => {
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
  });
  let client, port;
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    port = server.address().port;
    const elapsedMs = [];
    for (let index = 0; index < 3; index++) {
      const started = performance.now();
      assert.equal(await getListenerOwnerPid(port), process.pid);
      elapsedMs.push(Math.round(performance.now() - started));
    }
    client = net.createConnection({ host: '127.0.0.1', port });
    await new Promise((done, reject) => { client.once('connect', done); client.once('error', reject); });
    assert.equal(await getListenerOwnerPid(port), process.pid, 'established connections must not hide the actual listener');
    assert.equal(await getListenerOwnerPid(client.localPort), null, 'an owned established socket is not a listener');
    t.diagnostic(JSON.stringify({ netstatElapsedMs: elapsedMs }));
  } finally {
    client?.destroy();
    for (const socket of accepted) socket.destroy();
    if (server.listening) await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
    if (port) {
      assert.equal(await getListenerOwnerPid(port), null, 'closed test listener must not retain a cached PID');
      await new Promise((done, reject) => {
        const probe = net.createConnection({ host: '127.0.0.1', port });
        probe.once('connect', () => { probe.destroy(); reject(new Error('test-owned listener is still open')); });
        probe.once('error', (error) => { probe.destroy(); error.code === 'ECONNREFUSED' ? done() : reject(error); });
      });
    }
  }
});

test('parent-chain parser validates the fixed pid|parent|creation chain', () => {
  const parse = parseProcessParentChain;
  const valid = [chainRow(300, 200, 3000), chainRow(200, 101, 2000), chainRow(101, 50, 1000), chainRow(50, 0, 500)].join('\n');
  assert.deepEqual(parse(valid, 300), [
    { pid: 300, parentPid: 200, creation: 3000 },
    { pid: 200, parentPid: 101, creation: 2000 },
    { pid: 101, parentPid: 50, creation: 1000 },
    { pid: 50, parentPid: 0, creation: 500 }
  ]);
  assert.equal(parse(` ${chainRow(300, 200, 3000)} \r\n\r\n${chainRow(200, 0, 2000)}`, 300).length, 2);
  for (const bad of ['', '300|200', '300|200|3000|1', 'x|200|3000', '300|x|3000', '300|200|3000.5',
    '300|-1|3000', '0|200|3000', '301|200|3000', '4294967296|0|1', '300|4294967296|1']) {
    assert.equal(parse(bad, 300), null, bad);
  }
  assert.equal(parse([chainRow(300, 200, 3000), chainRow(201, 0, 2000)].join('\n'), 300), null, 'broken parent link');
  assert.equal(parse([chainRow(300, 200, 3000), chainRow(200, 0, 2000), chainRow(50, 0, 1000)].join('\n'), 300), null, 'extra row after root');
  const tooDeep = Array.from({ length: 11 }, (_, index) =>
    chainRow(1000 - index, index === 10 ? 0 : 999 - index, 10000 - index)).join('\n');
  assert.equal(parse(tooDeep, 1000), null, 'bounded ancestor depth');
  assert.equal(parse(null, 300), null);
  assert.equal(parse('', 300), null);
  assert.equal(parse(chainRow(300, 0, 1), 0), null);
  assert.equal(parse('x'.repeat(256 * 1024 + 1), 300), null);
});

test('process parent chain query uses PowerShell directly and fails closed', async () => {
  const calls = [];
  const execFileImpl = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: [chainRow(300, 200, 3000), chainRow(200, 0, 2000)].join('\r\n'), stderr: '' };
  };
  const chain = await getProcessParentChain(300, parentChainOptions(execFileImpl));
  assert.equal(chain.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(calls[0].args[0], '-NoProfile');
  assert.ok(calls[0].args.includes('-NonInteractive'));
  assert.ok(calls[0].args.includes('-Command'));
  const script = calls[0].args[calls[0].args.length - 1];
  assert.match(script, /Get-CimInstance Win32_Process/u);
  assert.match(script, /ProcessId = \$current/u);
  assert.match(script, /current = 300/u);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.encoding, 'utf8');
  assert.ok(calls[0].options.timeout >= 5000 && calls[0].options.timeout <= 20000);
  assert.ok(calls[0].options.maxBuffer > 0 && calls[0].options.maxBuffer <= 256 * 1024);

  assert.equal(await getProcessParentChain(300, parentChainOptions(async () => ({ stdout: '', stderr: 'query failed' }))), null);
  assert.equal(await getProcessParentChain(300, parentChainOptions(async () => { throw new Error('private detail'); })), null);
  assert.equal(await getProcessParentChain(300, parentChainOptions(async () => ({ stdout: 'not-a-chain', stderr: '' }))), null);
  let callsWithoutSpawn = 0;
  const countingExec = async () => { callsWithoutSpawn += 1; return { stdout: '', stderr: '' }; };
  for (const pid of [0, -1, 4294967296, 1.5, NaN, '300', null, undefined]) {
    assert.equal(await getProcessParentChain(pid, parentChainOptions(countingExec)), null, String(pid));
  }
  assert.equal(await getProcessParentChain(300, { ...parentChainOptions(countingExec), platform: 'linux' }), null);
  for (const systemRoot of ['', 'relative', '\\\\remote\\Windows']) {
    assert.equal(await getProcessParentChain(300, { ...parentChainOptions(countingExec), systemRoot }), null);
  }
  for (const maxDepth of [0, 9, 1.5]) {
    assert.equal(await getProcessParentChain(300, { ...parentChainOptions(countingExec), maxDepth }), null);
  }
  assert.equal(callsWithoutSpawn, 0);
});

test('ownership verifier accepts only the launched PID or its descendant chain', async () => {
  const chains = new Map([
    [300, [
      { pid: 300, parentPid: 200, creation: 3000 },
      { pid: 200, parentPid: 101, creation: 2000 },
      { pid: 101, parentPid: 50, creation: 1000 },
      { pid: 50, parentPid: 0, creation: 500 }
    ]],
    [200, [
      { pid: 200, parentPid: 101, creation: 2000 },
      { pid: 101, parentPid: 50, creation: 1000 },
      { pid: 50, parentPid: 0, creation: 500 }
    ]],
    [400, [
      { pid: 400, parentPid: 900, creation: 4000 },
      { pid: 900, parentPid: 0, creation: 1000 }
    ]],
    [500, [
      { pid: 500, parentPid: 501, creation: 5000 },
      { pid: 501, parentPid: 0, creation: 6000 }
    ]],
    [600, [
      { pid: 600, parentPid: 601, creation: 7000 },
      { pid: 601, parentPid: 0, creation: 6000 }
    ]]
  ]);
  const queries = [];
  const verifier = createListenerOwnershipVerifier({
    queryParentChain: async (pid) => { queries.push(pid); return chains.get(pid) ?? null; }
  });
  assert.deepEqual(await verifier.verify(101, 101), { verified: true, reason: 'direct', depth: 0 }, 'direct PID needs no query');
  assert.deepEqual(await verifier.verify(300, 101), { verified: true, reason: 'descendant', depth: 2 });
  assert.deepEqual(await verifier.verify(200, 101), { verified: true, reason: 'child', depth: 1 });
  assert.deepEqual(await verifier.verify(400, 101), { verified: false, reason: 'not-descendant', depth: -1 });
  assert.equal((await verifier.verify(500, 101)).reason, 'invalid-creation-order');
  assert.deepEqual(await verifier.verify(600, 101), { verified: false, reason: 'not-descendant', depth: -1 },
    'a valid chain with an older parent still is not a descendant of the client');
  assert.equal(queries.includes(101), false, 'direct PID must not trigger a process query');
  const before = queries.length;
  assert.deepEqual(await verifier.verify(300, 101), { verified: true, reason: 'descendant', depth: 2 });
  assert.equal(queries.length, before, 'repeat checks reuse the cached chain');
  assert.equal((await verifier.verify(999, 101)).reason, 'process-query-unavailable');
  assert.equal((await verifier.verify(300, 0)).reason, 'unknown-client');
  assert.equal((await verifier.verify(null, 101)).reason, 'unknown-owner');
  const failed = createListenerOwnershipVerifier({ queryParentChain: async () => { throw new Error('denied'); } });
  assert.equal((await failed.verify(300, 101)).reason, 'process-query-failed');
  const broken = createListenerOwnershipVerifier({
    queryParentChain: async (pid) => [{ pid, parentPid: 42, creation: 10 }]
  });
  assert.equal((await broken.verify(300, 101)).reason, 'not-descendant');
  const malformed = createListenerOwnershipVerifier({
    queryParentChain: async (pid) => [{ pid, parentPid: 200, creation: 10 }, { pid: 777, parentPid: 0, creation: 5 }]
  });
  assert.equal((await malformed.verify(300, 101)).reason, 'broken-chain');

  // Transient query failures are cached briefly, then retried so a slow WMI
  // response cannot permanently reject an otherwise valid listener.
  let flakyQueries = 0;
  let clockValue = 1000;
  const flaky = createListenerOwnershipVerifier({
    failureCacheMs: 30000,
    now: () => clockValue,
    queryParentChain: async () => { flakyQueries += 1; return null; }
  });
  assert.equal((await flaky.verify(300, 101)).reason, 'process-query-unavailable');
  assert.equal((await flaky.verify(300, 101)).reason, 'process-query-unavailable');
  assert.equal(flakyQueries, 1, 'failure result is cached inside the retry window');
  clockValue += 30001;
  await flaky.verify(300, 101);
  assert.equal(flakyQueries, 2, 'failure is retried after the short TTL');
  const clearing = createListenerOwnershipVerifier({ queryParentChain: async (pid) => chains.get(pid) ?? null });
  await clearing.verify(300, 101);
  clearing.clearCache();
  await clearing.verify(300, 101);
});

test('real Windows listener owned by a grandchild passes descendant ownership verification', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-listener-descendant-'));
  const grandchildPath = path.join(directory, 'grandchild.cjs');
  const childPath = path.join(directory, 'child.cjs');
  await fs.writeFile(grandchildPath, [
    "const net = require('node:net');",
    "const server = net.createServer((socket) => socket.destroy());",
    "server.listen(0, '127.0.0.1', () => { process.stdout.write(String(server.address().port) + '\\n'); });",
    'setInterval(() => {}, 1000);'
  ].join('\n'), 'utf8');
  await fs.writeFile(childPath, [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, [process.argv[2]], { stdio: ['ignore', 'inherit', 'inherit'] });",
    "process.on('exit', () => { try { child.kill(); } catch {} });",
    'setInterval(() => {}, 1000);'
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [childPath, grandchildPath], {
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true
  });
  let sleeper = null;
  t.after(async () => {
    try { sleeper?.kill(); } catch {}
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await fs.rm(directory, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('grandchild listener did not start')), 15000);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/^(\d+)\s*$/mu);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  let ownerPid = null;
  for (let attempt = 0; attempt < 50 && ownerPid === null; attempt += 1) {
    ownerPid = await getListenerOwnerPid(port);
    if (ownerPid === null) await sleep(100);
  }
  assert.ok(Number.isInteger(ownerPid) && ownerPid > 0, 'netstat must see the grandchild listener');
  assert.notEqual(ownerPid, child.pid, 'listener must belong to the grandchild, not the direct child');
  let chain = null;
  const verifier = createListenerOwnershipVerifier({
    failureCacheMs: 0,
    queryParentChain: async (pid, options) => {
      chain = await getProcessParentChain(pid, options);
      return chain;
    }
  });
  let ownership = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    ownership = await verifier.verify(ownerPid, child.pid);
    if (ownership.verified) break;
    await sleep(500);
  }
  assert.equal(ownership.verified, true, JSON.stringify(ownership));
  assert.ok(Array.isArray(chain) && chain[0].pid === ownerPid);
  assert.ok(chain.some((entry) => entry.pid === child.pid), 'real parent chain must contain the launched child');
  sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore', windowsHide: true });
  const unrelated = await createListenerOwnershipVerifier({ queryParentChain: async () => chain })
    .verify(ownerPid, sleeper.pid);
  assert.equal(unrelated.verified, false, 'an unrelated process must not own the listener');
});
