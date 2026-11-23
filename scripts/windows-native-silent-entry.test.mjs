import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = process.env.CX_NATIVE_SILENT_ENTRY_EXE || resolve('windows/native-build/bin/silent-entry-tests.exe');

test('real silent-debug CMD creates no exam-test HWND before or after client-exit, missing client or launch failure', {
  skip: process.platform !== 'win32' || (!process.env.CX_NATIVE_SILENT_ENTRY_EXE && !existsSync(executable)), timeout: 20000
}, async (t) => {
  assert.ok(existsSync(executable), `configured silent-entry fixture is missing: ${executable}`);
  const directory = await mkdtemp(join(tmpdir(), 'cx-silent-entry-'));
  try {
    const launcher = join(directory, 'start-windows-silent-debug.cmd');
    await copyFile(resolve('windows/native-scripts/start-windows-silent-debug.cmd'), launcher);
    await copyFile(executable, join(directory, 'chaoxing_plus.exe'));
    for (const scenario of ['client-exit', 'no-client', 'launch-failure']) {
      const output = join(directory, `${scenario}.json`);
      const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}""`], {
        cwd: directory, encoding: 'utf8', timeout: 5000, windowsHide: true, windowsVerbatimArguments: true,
        env: { ...process.env, CXPLUS_NO_PAUSE: '1', CX_SILENT_ENTRY_RESULT: output, CX_SILENT_ENTRY_SCENARIO: scenario }
      });
      assert.ifError(result.error);
      const logs = await readFile(output + '.log', 'utf8').catch(() => '(no fixture log)');
      assert.equal(result.status, 0, result.stdout + result.stderr + '\n' + logs);
      const observed = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(observed.windowsCreated, 0, `${scenario}: actual native home HWND must never be created: ${JSON.stringify(observed)}`);
      assert.equal(observed.windowShows, 0, `${scenario}: actual native home must never be shown`);
      assert.equal(observed.scans, 1, `${scenario}: only one launch flow`);
      assert.equal(observed.launches, scenario === 'no-client' ? 0 : 1, `${scenario}: never retry client startup`);
      if (scenario === 'client-exit') {
        assert.equal(observed.stopReason, 'client-exit');
        assert.equal(observed.targetLists, 1, 'fixture reaches the real post-endpoint client-exit path');
        assert.match(await readFile(output + '.log', 'utf8'), /\[error\] \[stop\] client-exit/u);
      }
      assert.equal(observed.hostExit, 1, `${scenario}: original failed result is preserved`);
      assert.equal(observed.consoleAllocations, 0, `${scenario}: redirected debug launch must not allocate another terminal`);
      t.diagnostic(`${scenario}: ${JSON.stringify(observed)}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
