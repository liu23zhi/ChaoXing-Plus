import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const executable = process.env.CX_NATIVE_HOST_EXE;

test('native host advertises startup checks for existing clients', { skip: !executable }, () => {
  const result = spawnSync(executable, ['--capabilities'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).existingClientCheck, true);
});

test('compiled process checks distinguish an empty snapshot from enumeration failure', {
  skip: !process.env.CX_NATIVE_PROCESS_CHECK_EXE
}, () => {
  const result = spawnSync(process.env.CX_NATIVE_PROCESS_CHECK_EXE, [], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NATIVE PROCESS CHECK TESTS PASS/);
  for (const name of [
    'listener probe classifies absent IPv4 and IPv6 listeners',
    'listener probe classifies IPv4 table query failure',
    'listener probe classifies IPv6 table query failure',
    'listener probe classifies wildcard binding without permitting it',
    'listener probe classifies IPv6-only binding without permitting it',
    'listener probe classifies dual-stack binding without permitting it',
    'listener probe classifies unregistered root identity',
    'legacy listener ownership wrapper preserves rejection',
    'owned process tree rejects incomplete enumeration before trusting identities'
  ]) assert.ok(result.stdout.includes(`PASS ${name}`), result.stdout);
});

test('native host refuses a running test client without stopping it or applying DPI', {
  skip: !executable || !process.env.CX_NATIVE_PROCESS_FIXTURE_EXE
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cx-existing-client-中文 空格-'));
  let child;
  try {
    const client = join(directory, 'CXExam.exe');
    await copyFile(process.env.CX_NATIVE_PROCESS_FIXTURE_EXE, client);
    child = spawn(client, [], { cwd: directory, windowsHide: true, stdio: 'ignore' });
    await once(child, 'spawn');
    const result = spawnSync(executable, [
      '--client', client, '--dpi-aware', '--no-elevate', '--no-log', '--quiet', '--report', 'report.json'
    ], { cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout + result.stderr, '');
    const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    assert.equal(report.stopReason, 'client-already-running');
    assert.equal(report.clientPid, 0);
    assert.equal(report.success, false);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.doesNotThrow(() => process.kill(child.pid, 0), 'existing test process must remain alive');
    const check = spawnSync(executable, ['--self-check', '--client', client, '--quiet'], {
      cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true
    });
    assert.equal(check.status, 0, check.stdout + check.stderr);
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
