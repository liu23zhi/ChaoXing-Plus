import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executable = process.env.CX_NATIVE_HOST_EXE;
const invoke = (...args) => spawnSync(executable, args, {
  encoding: 'utf8', timeout: 10_000, windowsHide: true
});
const isUnsupportedDpiShim = (result) => {
  if (result.status !== 8 || typeof result.stdout !== 'string') return false;
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim());
  const last = lines.length - 1;
  return lines[last - 1] === 'DPI_SHIM_UNOBSERVED'
    && lines[last] === 'NATIVE DPI PROCESS TESTS SKIP'
    && !lines.includes('NATIVE DPI PROCESS TESTS PASS')
    && !lines.includes('NATIVE DPI PROCESS TESTS FAIL');
};

test('DPI integration skips only on the dedicated unsupported-shim result', () => {
  assert.equal(isUnsupportedDpiShim({
    status: 8,
    stdout: 'diagnostic\nDPI_SHIM_UNOBSERVED\nNATIVE DPI PROCESS TESTS SKIP\n'
  }), true);
  assert.equal(isUnsupportedDpiShim({ status: 8, stdout: 'NATIVE DPI PROCESS TESTS FAIL\n' }), false);
  assert.equal(isUnsupportedDpiShim({
    status: 8,
    stdout: 'DPI_SHIM_UNOBSERVED trailing text\nNATIVE DPI PROCESS TESTS SKIP\n'
  }), false);
  assert.equal(isUnsupportedDpiShim({
    status: 8,
    stdout: ' DPI_SHIM_UNOBSERVED \nNATIVE DPI PROCESS TESTS SKIP\n'
  }), false);
  assert.equal(isUnsupportedDpiShim({
    status: 8,
    stdout: 'NATIVE DPI PROCESS TESTS SKIP\nDPI_SHIM_UNOBSERVED\n'
  }), false);
  assert.equal(isUnsupportedDpiShim({
    status: 8,
    stdout: 'NATIVE DPI PROCESS TESTS FAIL\nDPI_SHIM_UNOBSERVED\nNATIVE DPI PROCESS TESTS SKIP\n'
  }), false);
  assert.equal(isUnsupportedDpiShim({
    status: 8,
    stdout: 'DPI_SHIM_UNOBSERVED\nNATIVE DPI PROCESS TESTS SKIP\nNATIVE DPI PROCESS TESTS PASS\n'
  }), false);
  assert.equal(isUnsupportedDpiShim({
    status: 1,
    stdout: 'DPI_SHIM_UNOBSERVED\nNATIVE DPI PROCESS TESTS SKIP\n'
  }), false);
  assert.equal(isUnsupportedDpiShim({ status: null, stdout: null }), false);
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
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cx-native-dpi-中文 空格-'));
  try {
    const children = ['DpiBaseline.exe', 'DpiOverride.exe', 'DpiAfterRestore.exe']
      .map((name) => join(directory, name));
    for (const [index, child] of children.entries()) {
      await copyFile(process.env.CX_NATIVE_DPI_CHILD_EXE, child);
      // AppCompat can cache decisions by image identity on hosted Windows runners.
      // Keep each launch target distinct while preserving the same test entry point.
      await appendFile(child, Buffer.from(`CX_DPI_VARIANT_${index}\0`, 'ascii'));
    }
    const result = spawnSync(process.env.CX_NATIVE_DPI_PROCESS_EXE, children, {
      cwd: directory, encoding: 'utf8', timeout: 20_000, windowsHide: true
    });
    if (isUnsupportedDpiShim(result)) {
      t.skip('当前 Windows runner 未观察到瞬时 AppCompat DPI 层；注册表事务与恢复仍已验证');
      return;
    }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /NATIVE DPI PROCESS TESTS PASS/);
    assert.deepEqual(await readdir(directory), children.map((child) => child.split(/[\\/]/u).pop()).sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
