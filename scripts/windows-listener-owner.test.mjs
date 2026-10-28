import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { getListenerOwnerPid } from '../windows/host/launch.mjs';

const loadParser = async () => (await import('../windows/host/listener-owner.mjs')).parseNetstatListenerOwner;
const row = (local = '127.0.0.1:49321', state = 'LISTENING', pid = '4242', remote = '0.0.0.0:0') =>
  `  TCP    ${local}    ${remote}    ${state}    ${pid}`;
const queryOptions = (execFileImpl) => ({ platform: 'win32', systemRoot: 'C:\\Windows', execFileImpl });

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
