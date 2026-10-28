import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executable = process.env.CX_NATIVE_HOST_EXE;
const invoke = (...args) => spawnSync(executable, args, {
  encoding: 'utf8', timeout: 10_000, windowsHide: true
});

test('native DPI compatibility is advertised and documented in help', { skip: !executable }, () => {
  const result = invoke('--capabilities');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).temporaryDpiOverride, true);
  assert.match(invoke('--help').stdout, /--dpi-aware/);
});

test('native dpiAwareness JSON rejects invalid types and values before any launch', { skip: !executable }, () => {
  for (const dpiAwareness of [47, true, null, {}, [], 'per-monitor', 'System']) {
    const result = invoke('--print-effective-config', '--options-json', JSON.stringify({ dpiAwareness }));
    assert.equal(result.status, 2, `invalid DPI mode ${JSON.stringify(dpiAwareness)}: ${result.stdout}`);
    assert.match(result.stdout, /dpiAwareness/);
  }
  for (const dpiAwareness of ['', 'system']) {
    const result = invoke('--print-effective-config', '--options-json', JSON.stringify({ dpiAwareness }));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
});

test('native DPI override cannot silently write registry in no-disk-write or attach mode', { skip: !executable }, () => {
  for (const args of [['--no-disk-write'], ['--attach', '38100']]) {
    const result = invoke('--dpi-aware', ...args, '--print-effective-config');
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /dpi-aware/);
  }
});

test('compiled native DPI transactions preserve registry state and fail closed on conflicts and restore errors', {
  skip: !process.env.CX_NATIVE_DPI_EXE
}, () => {
  const result = spawnSync(process.env.CX_NATIVE_DPI_EXE, [], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NATIVE DPI TESTS PASS/);
});

test('temporary DPI override changes a real test child and restores the next ordinary launch', {
  skip: !process.env.CX_NATIVE_DPI_PROCESS_EXE || !process.env.CX_NATIVE_DPI_CHILD_EXE
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cx-native-dpi-中文 空格-'));
  try {
    const child = join(directory, 'DpiProbe.exe');
    await copyFile(process.env.CX_NATIVE_DPI_CHILD_EXE, child);
    const result = spawnSync(process.env.CX_NATIVE_DPI_PROCESS_EXE, [child], {
      cwd: directory, encoding: 'utf8', timeout: 20_000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /NATIVE DPI PROCESS TESTS PASS/);
    assert.deepEqual(await readdir(directory), ['DpiProbe.exe']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
