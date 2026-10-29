import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  SCAN_PROGRESS_LABELS,
  buildScanProgressPayload,
  defaultScanProgressScript,
  openScanProgressWindow,
  parseScanProgressUpdate,
  probeScanProgressWindow
} from '../windows/host/scan-progress-window.mjs';

const execFileAsync = promisify(execFile);
const interactiveWindowTest = process.env.CX_TEST_NATIVE_WINDOW === '1';

function createFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => { child.signalCode = 'SIGTERM'; child.emit('exit', null); };
  return child;
}

test('扫描进度窗口脚本保持纯 ASCII 且包含进度/取消控件', async () => {
  const source = await fs.readFile(defaultScanProgressScript, 'utf8');
  assert.match(source, /^[\x20-\x7E\r\n\t]*$/u);
  assert.match(source, /System\.Windows\.Forms/u);
  assert.match(source, /ProgressBar/u);
  assert.match(source, /CancelFile/u);
  assert.match(source, /VISIBILITY_PROBE_HOOK/u);
});

test('构建进度窗口 payload 与状态校验拒绝非法值', () => {
  const payload = buildScanProgressPayload({ title: '标题', detailTemplate: '已检查 {0} 个目录，发现 {1} 个候选。' });
  assert.equal(payload.title, '标题');
  assert.equal(payload.detailTemplate, '已检查 {0} 个目录，发现 {1} 个候选。');
  assert.equal(payload.cancelButtonText, SCAN_PROGRESS_LABELS.cancelButtonText);
  assert.deepEqual(parseScanProgressUpdate({ directoriesVisited: 3, candidatesFound: 1, elapsedMs: 20 }),
    { directoriesVisited: 3, candidatesFound: 1, elapsedMs: 20 });
  for (const invalid of [null, undefined, [], {}, { directoriesVisited: -1, candidatesFound: 0, elapsedMs: 0 },
    { directoriesVisited: 1.5, candidatesFound: 0, elapsedMs: 0 }, { directoriesVisited: 1, candidatesFound: -2, elapsedMs: 0 },
    { directoriesVisited: 1, candidatesFound: 0, elapsedMs: 'fast' }]) {
    assert.equal(parseScanProgressUpdate(invalid), null, JSON.stringify(invalid));
  }
});

test('进度窗口控制器写入状态、感知取消并在关闭时清理临时目录', async () => {
  const child = createFakeChild();
  const spawnImpl = () => { setImmediate(() => child.emit('spawn')); return child; };
  const handle = await openScanProgressWindow({
    platform: 'win32', spawnImpl, pollIntervalMs: 10, closeTimeoutMs: 500, killGraceMs: 200
  });
  assert.equal(handle.status, 'ok');
  assert.equal(await handle.update({ directoriesVisited: 7, candidatesFound: 2, elapsedMs: 50 }), true);
  assert.equal(await handle.update({ directoriesVisited: -1, candidatesFound: 0, elapsedMs: 0 }), false);
  const state = JSON.parse(await fs.readFile(handle.paths.stateFile, 'utf8'));
  assert.deepEqual(state, { directoriesVisited: 7, candidatesFound: 2, elapsedMs: 50 });

  await fs.writeFile(handle.paths.cancelFile, '1', 'utf8');
  assert.equal(await Promise.race([handle.cancelled, new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000))]), true);
  child.emit('exit', 0);
  await handle.close();
  assert.equal(await fs.access(handle.paths.directory).then(() => true, () => false), false);
});

test('进度窗口正常关闭写入 done 状态，spawn 失败时返回不可用', async () => {
  const child = createFakeChild();
  const spawnImpl = () => { setImmediate(() => child.emit('spawn')); return child; };
  const writes = [];
  const fsImpl = {
    ...fs,
    async rm() { /* keep the temp directory so the final state can be asserted */ },
    async writeFile(filePath, ...args) { writes.push(filePath); return fs.writeFile(filePath, ...args); }
  };
  const handle = await openScanProgressWindow({
    platform: 'win32', spawnImpl, fsImpl, pollIntervalMs: 10, closeTimeoutMs: 500, killGraceMs: 200
  });
  assert.equal(handle.status, 'ok');
  assert.equal(await handle.update({ directoriesVisited: 1, candidatesFound: 0, elapsedMs: 5 }), true);
  const closing = handle.close();
  setImmediate(() => child.emit('exit', 0));
  await closing;
  const state = JSON.parse(await fs.readFile(handle.paths.stateFile, 'utf8'));
  assert.deepEqual(state, { done: true, cancelled: false });
  assert.equal(writes.some((filePath) => filePath.includes('state.json')), true);
  await fs.rm(handle.paths.directory, { recursive: true, force: true });

  const failingSpawn = () => {
    const failed = createFakeChild();
    setImmediate(() => failed.emit('error', new Error('spawn powershell.exe ENOENT')));
    return failed;
  };
  const unavailable = await openScanProgressWindow({ platform: 'win32', spawnImpl: failingSpawn });
  assert.equal(unavailable.status, 'unavailable');
  assert.match(unavailable.reason, /spawn/i);
  assert.equal((await openScanProgressWindow({ platform: 'linux' })).status, 'unavailable');
});

test('进度窗口控件探针（真实 PowerShell WinForms）', { skip: process.platform !== 'win32' }, async () => {
  const probe = await probeScanProgressWindow({ timeoutMs: 30000 });
  assert.equal(probe.ok, true, probe.reason);
  assert.equal(probe.hasCancelButton, true);
  assert.equal(probe.hasProgressBar, true);
  assert.equal(probe.hasDetailLabel, true);
});

test('真实进度窗口对操作系统可见（自动取消，不执行扫描）', {
  skip: !interactiveWindowTest || process.platform !== 'win32'
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-scan-progress-visibility-'));
  try {
    const payloadFile = path.join(directory, 'payload.json');
    const stateFile = path.join(directory, 'state.json');
    const cancelFile = path.join(directory, 'cancel.marker');
    await fs.writeFile(payloadFile, `${JSON.stringify(SCAN_PROGRESS_LABELS)}\n`, 'utf8');
    const source = await fs.readFile(defaultScanProgressScript, 'utf8');
    const instrumented = source.replace('    # VISIBILITY_PROBE_HOOK', [
      "    Add-Type -Name WindowProbe -Namespace ProgressTest -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr handle);'",
      '    Write-Output (@{ visible = [ProgressTest.WindowProbe]::IsWindowVisible($form.Handle) } | ConvertTo-Json -Compress)',
      '    Stop-ProgressWindow $false'
    ].join('\n'));
    const scriptPath = path.join(directory, 'visibility.ps1');
    await fs.writeFile(scriptPath, instrumented, 'ascii');
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, '-PayloadFile', payloadFile, '-StateFile', stateFile, '-CancelFile', cancelFile
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const raw = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/u, ''));
    assert.equal(raw.visible, true, 'IsWindowVisible returned false for the scan progress window');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
