import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const executable = process.env.CX_NATIVE_AUDIT_EXE;

async function run(mode = '') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-native-audit-'));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(path.resolve(executable), [], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CX_AUDIT_TEST_DIR: directory, CX_AUDIT_TEST_MODE: mode },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('native audit self-test timed out')); }, 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    const reportFile = path.join(directory, 'reports 中文', 'nested', 'run.json');
    if (!mode) {
      const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
      assert.equal(report.version, '6.2.0');
      assert.equal(report.host, 'native');
      assert.equal(report.mode, 'launch');
      assert.equal(report.durationMs, 123);
      assert.equal(report.clientPid, 456);
      assert.equal(report.port, 9222);
      assert.equal(report.success, true);
      assert.equal(report.ownershipVerified, true);
      assert.equal(report.injectStrategy, 'hybrid');
      assert.equal(report.stopReason, 'duration"\\\n\t\u0001');
      assert.deepEqual(report.totals, { contexts: 7, bootstraps: 6, bundles: 5, errors: 4, reconnects: 3, pageSessions: 2 });
      for (const stamp of [report.startedAt, report.finishedAt]) assert.match(stamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.ok(report.finishedAt >= report.startedAt);
      const attached = JSON.parse(await fs.readFile(path.join(directory, 'relative report', 'attach.json'), 'utf8'));
      assert.equal(attached.mode, 'attach');
      assert.equal(attached.attached, true);
      assert.match(result.stdout, /AUDIT SELF-TEST PASS/);
      assert.doesNotMatch(result.stdout, /FAIL /);
    }
    return result;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('compiled native audit exercises real files, policies, and report JSON', { skip: !executable }, async () => {
  const { stdout } = await run();
  for (const regression of [
    'create nested Unicode log directory',
    'log filenames never overwrite another session',
    'quiet mode still writes the UTF-8 log',
    'log is one UTC UTF-8 line without BOM',
    'noDiskWrite creates no directories or report',
    'disabled logging does not disable independent reports',
    'relative paths resolve from the working directory',
    'write failure disables the file without retrying later events',
    'log open failure returns a usable audit with an error',
    'bad report parent returns a bounded failure',
    'generation failure preserves the previous report',
  ]) assert.ok(stdout.includes(`PASS ${regression}`), `missing audit regression: ${regression}`);
  assert.match(stdout, /Z \[info\] \[after-failure\] safe\n/);
  assert.match(stdout, /Z \[warn\] \[file\] safe\n/);
});

test('compiled native audit quiet mode suppresses only console output', { skip: !executable }, async () => {
  const quiet = await run('quiet');
  assert.equal(quiet.stdout, '');
  const visible = await run('console');
  assert.match(visible.stdout, /^\d{4}-.*Z \[warn\] \[lifecycle\] fixed event\n$/);
});
