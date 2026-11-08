import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 多文件版（外置资源）保留发布原件：EXE、assets、winmm-proxy.dll 都是发布文件，
// 删除后无法再次启动。因此多文件只支持"只清理运行痕迹"的自毁，并继续拒绝 stage-boot。
const executable = process.env.CX_NATIVE_MULTI_HOST_EXE && path.resolve(process.env.CX_NATIVE_MULTI_HOST_EXE);
const runtimeFiles = [
  'assets/windows-bootstrap.js', 'assets/chaoxing-plus.windows.js',
  'assets/trampoline.js', 'assets/vendor/sweetalert2.min.css', 'winmm-proxy.dll'
];

async function snapshot(directory, prefix = '') {
  const result = {};
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = `${prefix}${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result[`${relative}/`] = 'directory';
      Object.assign(result, await snapshot(absolute, `${relative}/`));
    } else {
      result[relative] = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
    }
  }
  return result;
}

async function makePackage(directory) {
  const packageDirectory = path.join(directory, 'package');
  const working = path.join(directory, 'working');
  const data = path.join(directory, 'data');
  await fs.mkdir(packageDirectory);
  await fs.mkdir(working);
  const host = path.join(packageDirectory, 'chaoxing_plus.exe');
  await fs.copyFile(executable, host);
  for (const relative of runtimeFiles) {
    const target = path.join(packageDirectory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(path.dirname(executable), relative), target);
  }
  for (const relative of [
    'chaoxing/native-scan-cache-v1.bin', 'chaoxing/logs/windows-host-owned-fixture.log',
    'chaoxing/logs/unrelated.txt', 'config.json'
  ]) {
    const target = path.join(data, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `preserve ${relative}\n`);
  }
  return { packageDirectory, working, data, host };
}

test('multi-file still rejects staged boot before help or self-check can change any files', {
  skip: process.platform !== 'win32' || !executable
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'cx-multi-restrictions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { working, data, host } = await makePackage(directory);
  const before = await snapshot(directory);
  for (const args of [
    ['--staged-boot', '--help'],
    ['--staged-boot', '--self-check'],
    ['--stage-boot', '--help']
  ]) {
    const result = spawnSync(host, [...args, '--data-dir', data, '--no-log'], {
      cwd: working, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024
    });
    assert.equal(result.error, undefined, `${args.join(' ')}: ${result.error?.message ?? ''}`);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
    // --staged-boot / --stage-boot 都进入静默路径，按既有约定不输出任何诊断。
    const silent = args.some((value) => value === '--staged-boot' || value === '--stage-boot');
    if (silent) assert.equal(result.stdout + result.stderr, '', 'staged boot still suppresses diagnostics');
    else assert.match(result.stdout + result.stderr, /multi-file builds do not support/i, args.join(' '));
    assert.deepEqual(await snapshot(directory), before, `${args.join(' ')} must reject before any file change`);
  }
});

test('multi-file accepts self-destruct options and preserves every release file', {
  skip: process.platform !== 'win32' || !executable
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'cx-multi-traces-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { working, data, host } = await makePackage(directory);
  const releaseBefore = await snapshot(path.join(directory, 'package'));
  for (const args of [
    ['--self-destruct-key', 'Ctrl+Shift+D', '--version'],
    ['--self-destruct-on-fullscreen-exit', '--version'],
    ['--silent-scenario', '--version'],
    ['--delete-suspend', '--version']
  ]) {
    const result = spawnSync(host, [...args, '--data-dir', data, '--no-log'], {
      cwd: working, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024
    });
    assert.equal(result.error, undefined, `${args.join(' ')}: ${result.error?.message ?? ''}`);
    assert.equal(result.status, 0, `${args.join(' ')} must be accepted now: ${result.stdout}\n${result.stderr}`);
  }
  assert.deepEqual(await snapshot(path.join(directory, 'package')), releaseBefore,
    'multi-file self-destruct must never delete or rename release files');
});

test('multi-file self-check reports trace-only self-destruct capability', {
  skip: process.platform !== 'win32' || !executable
}, async (t) => {  const directory = await fs.mkdtemp(path.join(tmpdir(), 'cx-multi-caps-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { working, data, host } = await makePackage(directory);
  const result = spawnSync(host, ['--capabilities', '--data-dir', data, '--no-log'], {
    cwd: working, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const capabilities = JSON.parse(result.stdout);
  assert.equal(capabilities.selfDestruct, true, 'multi-file now supports self-destruct');
  assert.equal(capabilities.selfDestructOnShutdown, true, 'multi-file gets the shutdown trigger too');
  assert.equal(capabilities.selfDestructBootResume, true, 'multi-file gets the boot-resume journal too');
  assert.equal(capabilities.selfDestructPendingDelete, true, 'multi-file gets the reboot delete leg too');
  assert.equal(capabilities.selfDestructReleaseFiles, false, 'multi-file must never delete release files');
  assert.equal(capabilities.traceOnlyCleanup, true, 'multi-file cleanup is trace-only');
  assert.equal(capabilities.deleteSuspend, false, 'delete-suspend still means deleting program files');
  assert.deepEqual(await snapshot(path.join(directory, 'package')).then((files) => Object.keys(files).sort()),
    ['assets/', 'assets/chaoxing-plus.windows.js', 'assets/trampoline.js', 'assets/vendor/',
      'assets/vendor/sweetalert2.min.css', 'assets/windows-bootstrap.js',
      'chaoxing_plus.exe', 'winmm-proxy.dll'],
    'capability probing must not change the package');
});

test('multi-file real self-destruct run removes traces and keeps every release file', {
  skip: process.platform !== 'win32' || !executable
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'cx-multi-e2e-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { working, data, host } = await makePackage(directory);
  const packageDirectory = path.join(directory, 'package');
  const releaseBefore = await snapshot(packageDirectory);
  // 只收集 <data-dir>\chaoxing 下登记的宿主数据；report 是本轮创建的另一个痕迹。
  const traceLog = path.join(data, 'chaoxing', 'logs', 'windows-host-owned-fixture.log');
  const traceCache = path.join(data, 'chaoxing', 'native-scan-cache-v1.bin');
  const reportPath = path.join(directory, 'report.json');
  assert.equal(existsSync(traceLog), true, 'the fixture trace must exist before the run');
  assert.equal(existsSync(traceCache), true, 'the fixture cache must exist before the run');

  const child = spawn(host, [
    '--silent-scenario', '--silent-client', path.join(working, 'CXExam.exe'),
    '--data-dir', data, '--report', reportPath, '--wipe-owned-files-on-start',
    '--no-panel', '--debug-timeout', '1000', '--duration', '2500',
    '--no-elevate', '--quiet'
  ], { cwd: working, stdio: 'ignore', windowsHide: true });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 90000);
    child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
  });
  assert.notEqual(code, 'timeout', 'multi-file silent scenario must not hang');

  assert.deepEqual(await snapshot(packageDirectory), releaseBefore,
    'multi-file self-destruct must not delete or rename a single release file');
  assert.equal(existsSync(path.join(packageDirectory, 'chaoxing_plus.exe')), true,
    'the multi-file EXE must survive its own self-destruct');
  assert.equal(existsSync(path.join(packageDirectory, 'assets', 'windows-bootstrap.js')), true,
    'sidecar assets must survive');
  assert.equal(existsSync(path.join(packageDirectory, 'winmm-proxy.dll')), true,
    'the proxy sidecar must survive');
  assert.equal(existsSync(traceLog), false, 'registered host data traces must be removed');
  assert.equal(existsSync(traceCache), false, 'the registered scan cache is a trace and must be removed');
  assert.equal(existsSync(reportPath), false, 'the run report is a trace and must be removed');
});
