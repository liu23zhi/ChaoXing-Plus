import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

const hostExe = process.env.CX_NATIVE_HOST_EXE ? resolve(process.env.CX_NATIVE_HOST_EXE) : resolve('build-windows/bin/chaoxing_plus.exe');
const cdpServer = resolve('build-windows/bin/cdp-server.exe');

function ready() {
  return existsSync(hostExe) && existsSync(cdpServer);
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolvePromise(true); });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolvePromise(false);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

test('--attach 连接外部拉起的客户端（不经启动、不校验归属）', { skip: process.platform !== 'win32' || !ready() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cx-attach-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(cdpServer, [], { env: { ...process.env, CX_INJECT_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
  try {
    const listening = await waitForPort(port, 8000);
    assert.equal(listening, true, '假 CDP 端点未能监听');
    const reportPath = join(dir, 'report.json');
    const result = spawnSync(hostExe, [
      '--attach', String(port),
      '--client', cdpServer,
      '--report', reportPath,
      '--no-elevate', '--no-log', '--no-diagnose',
      '--debug-timeout', '6000', '--duration', '7000'
    ], { encoding: 'utf8', timeout: 120000 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.mode, 'attach', output);
    assert.equal(report.attached, true, output);
    assert.equal(report.ownershipVerified, false, output);
    assert.ok(report.totals.pageSessions >= 1, output);
    assert.equal(report.stopReason, 'duration', output);
  } finally {
    server.kill();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
