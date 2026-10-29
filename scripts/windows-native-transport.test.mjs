import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = path.join(root, 'windows', 'native');

async function runHostHttpDeadline({ delayVersion = 0, delayList = 0, trickleVersion = false, args }) {
  const requests = [];
  const timers = new Set();
  const started = performance.now();
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, at: performance.now() - started });
    const body = JSON.stringify(request.url === '/json/version' ? { Browser: 'Chrome/75.0.3770.100' } : []);
    if (trickleVersion && request.url === '/json/version') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.flushHeaders();
      let sent = 0;
      const timer = setInterval(() => {
        if (response.destroyed || sent === body.length) {
          clearInterval(timer); timers.delete(timer);
          if (!response.destroyed) response.end();
        } else response.write(body[sent++]);
      }, 100);
      timers.add(timer);
      return;
    }
    const send = () => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    };
    const delay = request.url === '/json/version' ? delayVersion : delayList;
    if (!delay) send();
    else {
      const timer = setTimeout(() => { timers.delete(timer); send(); }, delay);
      timers.add(timer);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let child;
  try {
    const result = await new Promise((resolve, reject) => {
      child = spawn(path.resolve(process.env.CX_NATIVE_HOST_EXE), [
        '--attach', String(server.address().port), ...args,
        '--no-disk-write', '--no-log', '--no-diagnose', '--quiet'
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('native HTTP deadline test timed out')); }, 8000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr, elapsed: performance.now() - started });
      });
    });
    return { ...result, requests };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function runHostUpgradeDeadline({ trickleUpgrade = false }) {
  const started = performance.now();
  const sockets = new Set();
  const timers = new Set();
  let upgradeAt;
  const server = http.createServer((request, response) => {
    const body = JSON.stringify(request.url === '/json/version'
      ? { Browser: 'Chrome/75.0.3770.100' }
      : [{ id: 'upgrade-fixture', type: 'page', url: 'https://example.test/',
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/upgrade-fixture` }]);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket) => {
    upgradeAt = performance.now() - started;
    const accept = createHash('sha1').update(request.headers['sec-websocket-key']
      + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const response = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`;
    if (trickleUpgrade) {
      let sent = 0;
      const timer = setInterval(() => {
        if (socket.destroyed || sent === response.length) {
          clearInterval(timer); timers.delete(timer);
        } else socket.write(response[sent++]);
      }, 100);
      timers.add(timer);
    } else {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!socket.destroyed) socket.write(response);
      }, 1700);
      timers.add(timer);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let child;
  try {
    return await new Promise((resolve, reject) => {
      child = spawn(path.resolve(process.env.CX_NATIVE_HOST_EXE), [
        '--attach', String(server.address().port), '--debug-timeout', '5000', '--duration', '1000',
        '--no-disk-write', '--no-log', '--no-diagnose', '--quiet'
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('native Upgrade deadline test timed out')); }, 8000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr, upgradeAt, elapsed: performance.now() - started });
      });
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

async function read(name) {
  return fs.readFile(path.join(nativeRoot, name), 'utf8');
}

test('native transport sources expose the no-CRT interfaces', async () => {
  const [jsonHeader, jsonSource, netHeader, netSource, processHeader, processSource, memorySource] =
    await Promise.all(['json.h', 'json.c', 'net.h', 'net.c', 'process.h', 'process.c', 'memory.c'].map(read));

  for (const name of ['json.h', 'json.c', 'net.h', 'net.c', 'process.h', 'process.c', 'memory.c']) {
    assert.ok((await fs.stat(path.join(nativeRoot, name))).isFile(), name);
  }
  for (const source of [jsonSource, netSource, processSource, memorySource]) {
    assert.doesNotMatch(source, /#\s*include\s*[<"](stdio|stdlib|string|wchar)\.h[>"]/i);
    assert.doesNotMatch(source, /#\s*pragma\s+comment\s*\(\s*lib\s*:/i);
  }
  assert.match(jsonHeader, /int\s+jparse\s*\(/);
  assert.match(jsonHeader, /BOOL\s+jwstr\s*\(/);
  assert.match(netHeader, /BOOL\s+net_http_get\s*\(/);
  assert.match(netHeader, /BOOL\s+net_http_get_timeout\s*\(/);
  assert.match(netHeader, /NET_WS\s*\*\s*net_ws_open_timeout\s*\(/);
  assert.match(netHeader, /int\s+net_ws_read\s*\(/);
  assert.match(netHeader, /int\s+net_ws_read_timeout\s*\(/);
  assert.match(processHeader, /BOOL\s+proc_launch\s*\(/);
  assert.match(processHeader, /BOOL\s+proc_pe\s*\(/);
  assert.match(memorySource, /void\s*\*\s*__cdecl\s+memcpy\s*\(/);
  assert.match(netSource, /#define\s+BODY_LIMIT\s+\(8UL\s*\*\s*1024UL\s*\*\s*1024UL\)/);
  assert.match(netSource, /127\.0\.0\.1/);
  assert.match(netSource, /Rejected non-loopback or mismatched WebSocket URL/);
  assert.doesNotMatch(netSource, /HTTP body exceeds 1 MiB/);
});

test('native JSON driver source covers Unicode, nesting and malformed input', async () => {
  const source = await fs.readFile(path.join(nativeRoot, 'tests', 'json-tests.c'), 'utf8');
  assert.match(source, /decode Unicode escape/);
  assert.match(source, /nested next traversal/);
  assert.match(source, /reject trueX/);
  assert.match(source, /token capacity exhaustion/);
});

test('compiled native transport self-test', { skip: !process.env.CX_NATIVE_TRANSPORT_EXE }, async () => {
  const executable = path.resolve(process.env.CX_NATIVE_TRANSPORT_EXE);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--protocol-self-test'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('native transport self-test timed out'));
    }, 15000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /(?:TRANSPORT|PROTOCOL)[-_ ]?SELF[-_ ]?TEST[ :]+(?:OK|PASS)/i);
  for (const regression of [
    'zero Upgrade timeout performs no connection',
    'zero timeout never waits for an empty socket',
    'partial header resumes on the next read',
    'continuation completes a preserved fragmented message',
    'continuous control frames respect the total deadline',
    'zero timeout yields after a bounded control-frame batch'
  ]) {
    assert.ok(result.stdout.includes(`PASS ${regression}`), `missing transport regression: ${regression}`);
  }
});

test('native endpoint deadline includes a slow HTTP version response', { skip: !process.env.CX_NATIVE_HOST_EXE }, async () => {
  const result = await runHostHttpDeadline({
    delayVersion: 2500, args: ['--debug-timeout', '1000', '--duration', '5000']
  });
  assert.equal(result.code, 1, JSON.stringify(result));
  const version = result.requests.find(request => request.path === '/json/version');
  assert.ok(version, JSON.stringify(result));
  assert.ok(result.elapsed - version.at < 2000, JSON.stringify(result));
  assert.equal(result.requests.some(request => request.path === '/json/list'), false, JSON.stringify(result));
  assert.equal(result.stdout + result.stderr, '');
});

test('native run deadline includes a slow HTTP target-list response', { skip: !process.env.CX_NATIVE_HOST_EXE }, async () => {
  const result = await runHostHttpDeadline({
    delayList: 2500, args: ['--debug-timeout', '5000', '--duration', '1000']
  });
  assert.equal(result.code, 1, JSON.stringify(result));
  const list = result.requests.find(request => request.path === '/json/list');
  assert.ok(list, JSON.stringify(result));
  assert.ok(result.elapsed - list.at < 2000, JSON.stringify(result));
  assert.equal(result.stdout + result.stderr, '');
});

test('native endpoint deadline does not restart for HTTP response chunks', { skip: !process.env.CX_NATIVE_HOST_EXE }, async () => {
  const result = await runHostHttpDeadline({
    trickleVersion: true, args: ['--debug-timeout', '1000', '--duration', '5000']
  });
  assert.equal(result.code, 1, JSON.stringify(result));
  const version = result.requests.find(request => request.path === '/json/version');
  assert.ok(version, JSON.stringify(result));
  assert.ok(result.elapsed - version.at < 2000, JSON.stringify(result));
  assert.equal(result.requests.some(request => request.path === '/json/list'), false, JSON.stringify(result));
  assert.equal(result.stdout + result.stderr, '');
});

for (const trickleUpgrade of [false, true]) {
  test(`native run deadline includes ${trickleUpgrade ? 'trickled' : 'slow'} WebSocket Upgrade`, {
    skip: !process.env.CX_NATIVE_HOST_EXE
  }, async () => {
    const result = await runHostUpgradeDeadline({ trickleUpgrade });
    assert.equal(result.code, 1, JSON.stringify(result));
    assert.equal(typeof result.upgradeAt, 'number', JSON.stringify(result));
    assert.ok(result.elapsed - result.upgradeAt < 2000, JSON.stringify(result));
    assert.equal(result.stdout + result.stderr, '');
  });
}
