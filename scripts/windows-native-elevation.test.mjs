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
  assert.equal(JSON.parse(capabilities.stdout).elevateOnStart, true);
  const help = invoke('--help');
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /--no-elevate/);
  assert.match(help.stdout, /--elevate-on-start/);
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
    assert.match(result.stdout, /early restart argv roundtrip preserves every argument without an elevated-client marker/);
    assert.match(result.stdout, /early runas hands off without preselecting a client/);
    assert.deepEqual(await readdir(directory), [], 'shell test must not write files');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native internal resume cannot be used for read-only actions or without its restart marker', {
  skip: !executable
}, () => {
  for (const args of [
    ['--self-check'], ['--version'], ['--help'], ['--capabilities'], ['--print-effective-config'],
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
  assert.match(result.stdout, /PASS no-argument entry scans only common directories and opens GUI despite configured client path or CLI mode/);
  assert.match(result.stdout, /PASS no-argument common scan overrides a configured recursive scan mode/);
  assert.match(result.stdout, /PASS no-argument GUI cancellation cannot launch the recommended configured client/);
  assert.match(result.stdout, /PASS any user argument preserves configured direct-client selection semantics/);
  assert.match(result.stdout, /PASS no-argument GUI selection hands off its chosen path while preserving an empty original argv/);
  assert.match(result.stdout, /PASS GUI full scan requests an uncached recursive scan and reopens refreshed selection before launch/);
  assert.match(result.stdout, /PASS cancelling refreshed full scan selection never launches a client/);
  assert.match(result.stdout, /PASS failed requested full scan stops before any client launch/);
  for (const regression of [
    'early elevation hands off before scanning GUI audit or launch and preserves standalone GUI policy',
    'early UAC cancellation exits three without scanning or writing a parent report',
    'configured early elevation preserves a truly empty argument list and GUI policy',
    'already elevated standalone startup continues with common scan and GUI without another UAC',
    'verified early restart retains common scan and GUI instead of silently choosing a client',
    'a forged early restart marker cannot replace the administrator token',
    'unknown early elevation token fails before scanning or launching',
    'conflicting early elevation flags fail before inspecting the token',
    'read-only and explicit attach actions never request early elevation'
  ]) assert.ok(result.stdout.includes(`PASS ${regression}`), regression);
});
