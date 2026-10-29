import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const executable = process.env.CX_NATIVE_SELECTION_EXE;

test('compiled native client selection builds its real hidden controls', { skip: !executable }, () => {
  const result = spawnSync(executable, [], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
  assert.match(result.stdout, /full disk scan remains available/);
  for (const expected of [
    /hidden full-scan progress window thread starts/,
    /progress window binds discovery progress\/cancel hooks/,
    /ending the progress window normally is not a cancellation/,
    /the auto-cancel timer reports cancellation/,
    /discovery reports visited directory progress/,
    /the cancel callback reports a cancelled full scan/,
    /selection layout uses the active DPI scale/,
    /the high-DPI progress window scales its width from 96 DPI metrics/
  ]) {
    assert.match(result.stdout, expected);
  }
  assert.doesNotMatch(result.stdout, /^FAIL /mu);
});

test('native full-scan progress window is visible and cancellable', {
  skip: !executable || process.env.CX_TEST_NATIVE_WINDOW !== '1'
}, () => {
  const result = spawnSync(executable, ['--scan-progress'], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /the progress window is visible to the operating system/);
  assert.match(result.stdout, /clicking cancel reports a progress-window cancellation/);
  assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
  assert.doesNotMatch(result.stdout, /^FAIL /mu);
});

test('native full scan button returns a scan request without selecting or launching a client', {
  skip: !executable || process.env.CX_TEST_NATIVE_WINDOW !== '1'
}, () => {
  const result = spawnSync(executable, ['--request-scan-all'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, CXPLUS_NATIVE_SELECTION_AUTO_CLOSE_MS: '3000' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /the full scan button requests scanning without selecting or launching a client/);
  assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
});

test('native client selection displays and cancels without launching a client', {
  skip: !executable || process.env.CX_TEST_NATIVE_WINDOW !== '1'
}, () => {
  const result = spawnSync(executable, ['--show-cancel'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, CXPLUS_NATIVE_SELECTION_AUTO_CLOSE_MS: '200' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /closing the actual window cancels without a selected client/);
  assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
});

test('native client selection returns a validated Unicode client path after choosing its row', {
  skip: !executable || process.env.CX_TEST_NATIVE_WINDOW !== '1'
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-native-select-中文 空格-'));
  try {
    const client = path.join(directory, 'CXExam.exe');
    await fs.copyFile(executable, client);
    const result = spawnSync(executable, ['--choose', client], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, CXPLUS_NATIVE_SELECTION_AUTO_CLOSE_MS: '3000' }
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /choosing a row returns its validated Unicode PE path/);
    assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native selection and progress windows scale their layout at a configured high DPI', {
  skip: !executable
}, () => {
  const result = spawnSync(executable, [], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, CXPLUS_NATIVE_UI_DPI: '144' }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /selection layout uses the active DPI scale/);
  assert.match(result.stdout, /the high-DPI progress window scales its width from 96 DPI metrics/);
  assert.match(result.stdout, /NATIVE SELECTION TESTS PASS/);
  assert.doesNotMatch(result.stdout, /^FAIL /mu);
});
