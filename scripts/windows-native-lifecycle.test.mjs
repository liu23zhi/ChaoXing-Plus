import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Compiled native host lifecycle regression: --no-retain-data removes only the
// artifacts this run created, and --delete-config only the explicit --config file.
const hostExe = process.env.CX_NATIVE_HOST_EXE;
const nativeTest = (name, run) => test(name, { skip: !hostExe }, run);

async function unusedPort() {
  const server = createServer((_request, response) => response.end(''));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runHost(args) {
  const result = spawnSync(hostExe, args, {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true
  });
  assert.ifError(result.error);
  return result;
}

async function listFiles(directory) {
  try {
    return await readdir(directory, { recursive: true });
  } catch {
    return [];
  }
}

nativeTest('--no-retain-data 删除本次创建的日志与报告，但保留运行前已有文件', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-native-lifecycle-'));
  try {
    const dataDir = path.join(directory, 'data');
    const reportPath = path.join(directory, 'report.json');
    const logDir = path.join(dataDir, 'chaoxing', 'logs');
    await mkdir(logDir, { recursive: true });
    const preExisting = path.join(logDir, 'windows-host-preexisting.log');
    await writeFile(preExisting, 'keep me\n', 'utf8');
    const port = await unusedPort();
    const result = runHost([
      '--attach', String(port), '--duration', '500', '--debug-timeout', '1000',
      '--data-dir', dataDir, '--diagnostics-dir', path.join(dataDir, 'diagnostics'), '--report', reportPath, '--no-scan-cache', '--diagnose',
      '--no-retain-data', '--quiet'
    ]);
    assert.notEqual(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(reportPath), false, 'run report must be removed');
    assert.equal(existsSync(preExisting), true, 'pre-existing log must be preserved');
    const logs = (await listFiles(logDir)).filter((name) => name.endsWith('.log'));
    assert.deepEqual(logs, ['windows-host-preexisting.log'], 'only this run log is removed');
    const diagnosticsEntries = await listFiles(path.join(dataDir, 'diagnostics'));
    assert.deepEqual(diagnosticsEntries, [],
      'no-retain-data must remove every diagnostics run file including screenshots and the host summary');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

nativeTest('默认保留本次运行的日志与报告', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-native-retain-'));
  try {
    const dataDir = path.join(directory, 'data');
    const reportPath = path.join(directory, 'report.json');
    const port = await unusedPort();
    const result = runHost([
      '--attach', String(port), '--duration', '500', '--debug-timeout', '1000',
      '--data-dir', dataDir, '--diagnostics-dir', path.join(dataDir, 'diagnostics'), '--report', reportPath, '--no-scan-cache', '--diagnose', '--quiet'
    ]);
    assert.notEqual(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(reportPath), true, 'default retention must keep the report');
    const diagnosticsFiles = await listFiles(path.join(dataDir, 'diagnostics'));
    assert.equal(diagnosticsFiles.some((name) => name.endsWith('render-diagnostics-host.json')), true,
      'default retention must keep the host diagnostics summary');
    const logs = (await listFiles(path.join(dataDir, 'chaoxing', 'logs'))).filter((name) => name.endsWith('.log'));
    assert.equal(logs.length >= 1, true, 'default retention must keep this run log');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(typeof report.stopReason, 'string');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

nativeTest('JSON retainData=false 与 CLI --no-retain-data 行为一致', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-native-retain-json-'));
  try {
    const reportPath = path.join(directory, 'report.json');
    const port = await unusedPort();
    const result = runHost([
      '--attach', String(port), '--duration', '500', '--debug-timeout', '1000',
      '--data-dir', path.join(directory, 'data'), '--report', reportPath,
      '--no-scan-cache', '--options-json', '{"retainData":false}', '--quiet'
    ]);
    assert.notEqual(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(reportPath), false, 'JSON retainData=false must clean the report');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

nativeTest('--delete-config 只删除显式 --config 文件并保留其他数据', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-native-delete-config-'));
  try {
    const configPath = path.join(directory, 'chaoxing-plus.json');
    const reportPath = path.join(directory, 'report.json');
    await writeFile(configPath, '{"settings":{"common.settings.extension-enabled":true}}', 'utf8');
    const port = await unusedPort();
    const result = runHost([
      '--attach', String(port), '--duration', '500', '--debug-timeout', '1000',
      '--config', configPath, '--delete-config',
      '--data-dir', path.join(directory, 'data'), '--report', reportPath,
      '--no-scan-cache', '--quiet'
    ]);
    assert.notEqual(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(configPath), false, 'explicit config must be deleted');
    assert.equal(existsSync(reportPath), true, 'default retention keeps the report');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

nativeTest('--delete-config 必须显式 --config 且不能与 --no-disk-write 同用', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-native-delete-config-invalid-'));
  try {
    const withoutConfig = runHost(['--delete-config', '--attach', '1', '--quiet']);
    assert.equal(withoutConfig.status, 2, withoutConfig.stdout + withoutConfig.stderr);
    const configPath = path.join(directory, 'chaoxing-plus.json');
    await writeFile(configPath, '{}', 'utf8');
    const withNoDiskWrite = runHost([
      '--config', configPath, '--delete-config', '--no-disk-write', '--attach', '1', '--quiet'
    ]);
    assert.equal(withNoDiskWrite.status, 2, withNoDiskWrite.stdout + withNoDiskWrite.stderr);
    assert.equal(existsSync(configPath), true, 'rejected requests must not delete the config');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
