import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executable = process.env.CX_NATIVE_HOST_EXE;

test('compiled native host advertises standard UAC and documents the opt-out', {
  skip: !executable
}, () => {
  const invoke = (...args) => spawnSync(executable, args, {
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  const capabilities = invoke('--capabilities');
  assert.equal(capabilities.status, 0, capabilities.stdout + capabilities.stderr);
  assert.equal(JSON.parse(capabilities.stdout).standardUac, true);
  const help = invoke('--help');
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /--no-elevate/);
});

test('compiled UAC tests exercise quoting, token checks and shell handoff without requesting real UAC', {
  skip: !process.env.CX_NATIVE_ELEVATION_EXE
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cx-native-uac-中文 空格-'));
  try {
    const result = spawnSync(process.env.CX_NATIVE_ELEVATION_EXE, [], {
      cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /NATIVE ELEVATION TESTS PASS/);
    assert.deepEqual(await readdir(directory), [], 'shell test must not write files');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native internal resume cannot be used for read-only actions or without its restart marker', {
  skip: !executable
}, () => {
  for (const args of [
    ['--self-check'], ['--help'], ['--capabilities'], ['--print-effective-config'],
    ['--list-clients'], ['--attach', '38100'], [],
    ['--elevated', '--self-check'], ['--elevated', '--help'],
    ['--elevated', '--capabilities'], ['--elevated', '--print-effective-config'],
    ['--elevated', '--list-clients'], ['--elevated', '--attach', '38100']
  ]) {
    const result = spawnSync(executable, [
      ...args, '--elevated-client', 'C:\\fixture\\CXExam.exe', '--no-disk-write'
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /internal elevated client requires/);
  }
});

test('compiled host transfers a 740 launch after cleanup and keeps the selected client without a second selection', {
  skip: !process.env.CX_NATIVE_ELEVATION_HOST_EXE
}, () => {
  const result = spawnSync(process.env.CX_NATIVE_ELEVATION_HOST_EXE, [], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NATIVE ELEVATION HOST TESTS PASS/);
});
