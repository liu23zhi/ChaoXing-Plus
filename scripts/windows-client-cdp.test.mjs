import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

const windowsOnly = process.platform === 'win32' ? undefined : 'Windows PowerShell CDP capture regression';
const cdpScript = resolveTestPath('scripts', 'windows-client-cdp.ps1');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// 1x1 PNG; the helper only checks the signature and derives the IHDR size from the bytes.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function encodeServerFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 65535) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x81;
  return Buffer.concat([header, payload]);
}

function consumeClientFrames(state, chunk, onMessage) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  for (;;) {
    const buffer = state.buffer;
    if (buffer.length < 2) return;
    const opcode = buffer[0] & 0x0f;
    const second = buffer[1];
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length < 4) return;
      length = buffer.readUInt16BE(2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return;
      length = Number(buffer.readBigUInt64BE(2));
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length < headerLength + maskLength + length) return;
    const mask = masked ? buffer.subarray(headerLength, headerLength + 4) : null;
    const start = headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(start, start + length));
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    state.buffer = buffer.subarray(start + length);
    if (opcode === 0x8) { state.closed = true; return; }
    onMessage(payload.toString('utf8'));
  }
}

// Minimal DevTools endpoint: /json/list plus one page WebSocket that answers Page.captureScreenshot.
// The child PowerShell process is spawned asynchronously: spawnSync would block this event loop, so the
// mock could never answer the HTTP/WebSocket requests it is being asked to serve.
async function startMockCdp({ respondWithPng = true, listTargets } = {}) {
  const captured = { methods: [], params: {}, upgrades: 0, expressions: [] };
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const port = server.address().port;
    if (request.url === '/json/list') {
      const targets = listTargets ?? [{
        id: 'page-1',
        type: 'page',
        title: 'mock exam page',
        url: 'https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examlist',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-1`
      }];
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(targets));
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (!key || !String(request.url || '').startsWith('/devtools/page/')) { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    captured.upgrades += 1;
    sockets.add(socket);
    const state = { buffer: Buffer.alloc(0) };
    socket.on('data', (chunk) => {
      consumeClientFrames(state, chunk, (text) => {
        let message;
        try { message = JSON.parse(text); } catch { return; }
        if (!message || message.method === undefined) return;
        captured.methods.push(message.method);
        captured.params[message.method] = message.params ?? {};
        if (message.params && typeof message.params.expression === 'string') captured.expressions.push(message.params.expression);
        if (!respondWithPng) {
          socket.write(encodeServerFrame(JSON.stringify({ id: message.id, error: { code: -32000, message: 'Unable to capture screenshot' } })));
          return;
        }
        socket.write(encodeServerFrame(JSON.stringify({
          id: message.id,
          result: { data: PNG_BYTES.toString('base64') }
        })));
      });
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    captured,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) { try { socket.destroy(); } catch { /* ignore */ } }
      server.close(resolve);
    })
  };
}

function runCapture({ port, outFile, timeoutSeconds = 10 }) {
  const harness = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. '${cdpScript.replace(/'/gu, "''")}'`,
    `$shot = Save-CdpPageScreenshot -Port ${port} -Path '${outFile.replace(/'/gu, "''")}' -TimeoutSeconds ${timeoutSeconds}`,
    "if ($shot) { $shot | ConvertTo-Json -Compress } else { '{\"shot\":null}' }"
  ].join('\n');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', harness],
      { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/u).map((value) => value.trim()).filter((value) => value.startsWith('{')).pop();
      let json = null;
      try { json = line ? JSON.parse(line) : null; } catch { json = null; }
      resolve({ status, stdout, stderr, json });
    });
  });
}

test('CDP 页内截图写入 PNG，并与桌面截图并存（不替换）', { skip: windowsOnly }, async (t) => {
  const server = await startMockCdp();
  t.after(() => server.close());
  const directory = createTestDirectory('client-cdp');
  const desktop = path.join(directory, 'cx-real-client-case-4-after-confirm.png');
  const cdp = path.join(directory, 'cx-real-client-case-4-after-confirm-cdp.png');
  writeFileSync(desktop, Buffer.from('desktop frame with black pixels'));
  const { status, stdout, stderr, json } = await runCapture({ port: server.port, outFile: cdp });
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  assert.ok(json && json.Path, `CDP 截图必须成功: ${stdout}${stderr}`);
  assert.equal(readFileSync(desktop, 'utf8'), 'desktop frame with black pixels',
    '桌面截图必须原样保留，CDP 截图不能覆盖它');
  assert.deepEqual(readFileSync(cdp), PNG_BYTES, 'CDP 返回的 data 必须按 PNG 原样写盘');
  assert.equal(json.Bytes, PNG_BYTES.length);
  assert.equal(json.Width, 1);
  assert.equal(json.Height, 1);
  assert.match(json.Url, /exam-ans/u, '必须记录实际截图的目标 URL');
  assert.deepEqual(server.captured.methods, ['Page.captureScreenshot']);
  assert.equal(server.captured.params['Page.captureScreenshot'].format, 'png');
  assert.equal(server.captured.params['Page.captureScreenshot'].fromSurface, true);
});

test('CDP 端点缺失或报错时返回空值且不留下半截文件', { skip: windowsOnly }, async (t) => {
  const directory = createTestDirectory('client-cdp-fail');
  const missing = path.join(directory, 'missing-cdp.png');
  const closed = await runCapture({ port: 1, outFile: missing, timeoutSeconds: 2 });
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(closed.json.shot, null, '没有端点时必须返回 null，而不是伪造截图');
  assert.equal(existsSync(missing), false);

  const server = await startMockCdp({ respondWithPng: false });
  t.after(() => server.close());
  const errored = path.join(directory, 'errored-cdp.png');
  const failed = await runCapture({ port: server.port, outFile: errored });
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(failed.json.shot, null, 'CDP error 回复必须视为失败');
  assert.equal(existsSync(errored), false, '失败时不得留下不可打开的截图');
  assert.deepEqual(server.captured.methods, ['Page.captureScreenshot']);
});

test('抓屏窗口期通过 CDP 隐藏并恢复页面面板', { skip: windowsOnly }, async (t) => {
  const server = await startMockCdp();
  t.after(() => server.close());
  const harness = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. '${cdpScript.replace(/'/gu, "''")}'`,
    `$on = Set-CdpCaptureGuard -Port ${server.port} -Hidden $true`,
    `$off = Set-CdpCaptureGuard -Port ${server.port} -Hidden $false`,
    "@{ on = $on; off = $off } | ConvertTo-Json -Compress"
  ].join('\n');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', harness], { windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(status, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /"on"\s*:\s*true/u, `隐藏调用必须成功: ${stdout}${stderr}`);
  assert.match(stdout, /"off"\s*:\s*true/u, `恢复调用必须成功: ${stdout}${stderr}`);
  assert.equal(server.captured.expressions.length, 2);
  assert.match(server.captured.expressions[0], /__CX_WIN_CAPTURE_GUARD__=true/u);
  assert.match(server.captured.expressions[0], /__CX_WIN_APPLY_CAPTURE_GUARD__\(\)/u,
    '必须调用 bootstrap 的隐藏函数，只改全局变量不会隐藏已挂载的面板');
  assert.match(server.captured.expressions[1], /__CX_WIN_CAPTURE_GUARD__=false/u);
});

test('没有 page 目标时不去连接 WebSocket', { skip: windowsOnly }, async (t) => {
  const server = await startMockCdp({ listTargets: [{ id: 'browser', type: 'browser', url: 'devtools://browser' }] });
  t.after(() => server.close());
  const directory = createTestDirectory('client-cdp-notarget');
  const out = path.join(directory, 'no-target-cdp.png');
  const { status, stderr, json } = await runCapture({ port: server.port, outFile: out });
  assert.equal(status, 0, stderr);
  assert.equal(json.shot, null);
  assert.equal(existsSync(out), false);
  assert.equal(server.captured.upgrades, 0, '没有 page 目标时不得发起 WebSocket 升级');
});
