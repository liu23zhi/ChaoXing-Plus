import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { spawnWindowsClient } from '../windows/node-source/launch.mjs';

function createHelper() {
  const helper = new EventEmitter();
  helper.stdin = new PassThrough();
  helper.stdout = new PassThrough();
  helper.stderr = new PassThrough();
  helper.killCount = 0;
  helper.kill = () => { helper.killCount += 1; };
  helper.send = (event) => helper.stdout.write(JSON.stringify(event) + '\n');
  return helper;
}

test('ordinary launcher transports arguments as UTF-8 JSON without temporary files', async () => {
  const helper = createHelper();
  let input = '', invocation;
  helper.stdin.on('data', (chunk) => { input += chunk.toString('utf8'); });
  const launch = spawnWindowsClient({
    exePath: 'C:\\Program Files\\\u4e2d\u6587\\CXExam.exe',
    args: ['a b', '"quoted"', '', 'C:\\tail\\'],
    spawnImpl: (...args) => { invocation = args; return helper; }
  });
  assert.equal(invocation[0], 'powershell.exe');
  assert.equal(invocation[1].at(-2), '-File');
  assert.match(invocation[1].at(-1), /launch-client\.ps1$/u);
  assert.equal(invocation[2].windowsHide, true);
  assert.deepEqual(JSON.parse(input), {
    exePath: 'C:\\Program Files\\\u4e2d\u6587\\CXExam.exe',
    arguments: '"a b" "\\"quoted\\"" "" "C:\\tail\\\\"',
    cwd: 'C:\\Program Files\\\u4e2d\u6587'
  });
  const exited = once(launch.child, 'exit');
  helper.send({ kind: 'started', pid: 12345 });
  await launch.started;
  assert.equal(launch.child.pid, 12345);
  helper.send({ kind: 'exit', code: 7 });
  assert.deepEqual(await exited, [7, null]);
  assert.equal(launch.child.exitCode, 7);
  helper.emit('close', 0);
  const source = await readFile(new URL('../windows/node-source/launch-client.ps1', import.meta.url));
  assert.ok(source.every((byte) => byte < 128), 'PowerShell 5.1 helper must remain ASCII');
});

test('ordinary launcher keeps exact Win32 740 distinct from UNKNOWN and other failures', async () => {
  for (const win32Code of [740, 2, 5, 0]) {
    const helper = createHelper();
    const launch = spawnWindowsClient({ exePath: 'CXExam.exe', args: [], spawnImpl: () => helper });
    const rejected = assert.rejects(launch.started, (error) => error.win32Code === win32Code && error.message === 'launch failure');
    helper.send({ kind: 'error', win32Code, message: 'launch failure' });
    helper.emit('close', 1);
    await rejected;
  }
});

test('ordinary launcher closes only its observer after startup and cancellation is idempotent', async () => {
  const helper = createHelper();
  const launch = spawnWindowsClient({ exePath: 'CXExam.exe', args: [], spawnImpl: () => helper });
  helper.send({ kind: 'started', pid: 12345 });
  await launch.started;
  launch.child.disconnect();
  launch.child.disconnect();
  assert.equal(helper.killCount, 1);
  assert.equal(launch.child.exitCode, null, 'disconnect must not report that the actual client exited');
  helper.emit('close', 1);
  const pendingHelper = createHelper();
  const pending = spawnWindowsClient({ exePath: 'CXExam.exe', args: [], spawnImpl: () => pendingHelper });
  const rejected = assert.rejects(pending.started, { code: 'ABORT_ERR' });
  pending.child.disconnect();
  await rejected;
});

test('ordinary launcher times out and releases the helper without retrying a client', async () => {
  const helper = createHelper();
  const launch = spawnWindowsClient({ exePath: 'CXExam.exe', args: [], spawnImpl: () => helper, timeoutMs: 5 });
  await assert.rejects(launch.started, /\u8d85\u65f6/u);
  assert.equal(helper.killCount, 1);
});

test('PowerShell ordinary launch starts benign Node, preserves quoting and observes its exit', {
  skip: process.platform !== 'win32', timeout: 20000
}, async () => {
  const values = ['\u4e2d\u6587', 'a b', '"quoted"', '', 'C:\\tail\\', '$x;`&|'];
  const source = `process.stdout.write('ignored output'); process.stderr.write('ignored error'); if (JSON.stringify(process.argv.slice(1)) !== ${JSON.stringify(JSON.stringify(values))}) process.exitCode = 7;`;
  const launch = spawnWindowsClient({ exePath: process.execPath, args: ['-e', source, ...values] });
  const exited = once(launch.child, 'exit');
  try {
    await launch.started;
    assert.ok(Number.isInteger(launch.child.pid));
    assert.deepEqual(await exited, [0, null]);
  } finally {
    launch.child.disconnect();
  }
});

test('PowerShell ordinary launch returns actual missing-file error without requesting elevation', {
  skip: process.platform !== 'win32', timeout: 20000
}, async () => {
  const launch = spawnWindowsClient({ exePath: 'C:\\__cxplus_nonexistent_directory__\\missing.exe', args: [] });
  try {
    await assert.rejects(launch.started, (error) => [2, 3, 267].includes(error.win32Code));
  } finally {
    launch.child.disconnect();
  }
});

test('ordinary helper launches a visible self-closing GUI without relying on its hidden parent window', {
  skip: process.platform !== 'win32', timeout: 30000
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cxplus-launch-window-'));
  const executable = path.join(directory, 'owned-gui-probe.exe');
  const source = `
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class Probe {
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  [STAThread] public static int Main() {
    using (var form = new Form()) using (var timer = new Timer()) {
      int result = 21;
      form.Text = "CXPLUS owned launch visibility probe";
      form.Width = 360; form.Height = 100;
      timer.Interval = 250;
      timer.Tick += delegate { result = IsWindowVisible(form.Handle) ? 0 : 21; timer.Stop(); form.Close(); };
      timer.Start(); Application.Run(form); return result;
    }
  }
}`;
  const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
  const command = `Add-Type -TypeDefinition ${quote(source)} -OutputAssembly ${quote(executable)} -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms.dll,System.Drawing.dll`;
  let launch;
  try {
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
    launch = spawnWindowsClient({ exePath: executable, args: [] });
    const exited = once(launch.child, 'exit');
    await launch.started;
    assert.deepEqual(await exited, [0, null], 'the actual GUI HWND must be visible');
  } finally {
    if (launch) launch.child.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
