import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const host = process.env.CX_NATIVE_HOST_EXE;

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test('native wipe removes only registered host artifacts', { skip: !host }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cx-native-wipe-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const data = path.join(root, 'data');
  const owned = path.join(data, 'chaoxing');
  const diagnostics = path.join(owned, 'diagnostics', '20260101T010203004Z-123-0');
  await mkdir(path.join(owned, 'logs'), { recursive: true });
  await mkdir(diagnostics, { recursive: true });
  const files = {
    cache: path.join(owned, 'native-scan-cache-v1.bin'),
    log: path.join(owned, 'logs', 'windows-host-1-2.log'),
    diagnostic: path.join(diagnostics, 'render-diagnostics.json'),
    client: path.join(owned, 'CXExam.exe'),
    external: path.join(root, 'external.json')
  };
  for (const [key, target] of Object.entries(files)) await writeFile(target, key === 'diagnostic' || key === 'external' ? '{}' : key);
  const result = spawnSync(host, [
    '--wipe-owned-files-on-start', '--data-dir', data,
    '--config', files.external, '--client-index', '2147483647', '--no-disk-write'
  ], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(await exists(files.cache), false, 'scan cache must be removed');
  assert.equal(await exists(files.log), false, 'host log must be removed');
  assert.equal(await exists(files.diagnostic), false, 'diagnostic artifact must be removed');
  assert.equal(await exists(files.client), true, 'CXExam must never be removed');
  assert.equal(await exists(files.external), true, 'external --config must never be removed');
});

test('native wipe tuning without the main switch exits 2', { skip: !host }, () => {
  const result = spawnSync(host, ['--wipe-retries', '3', '--version'], {
    encoding: 'utf8', timeout: 20000, windowsHide: true
  });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /wipe-\* tuning requires --wipe-owned-files-on-start/u);
});

test('delete-suspend requires the trusted release layout', { skip: !host }, () => {
  const result = spawnSync(host, ['--delete-suspend', '--client-index', '1', '--no-disk-write'], {
    encoding: 'utf8', timeout: 20000, windowsHide: true
  });
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /delete-suspend requires the release layout/u);
});

test('native wipe also removes the selected client debug.log without touching CXExam', { skip: !host }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'cx-client-debuglog-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const client = path.join(root, 'CXExam.exe');
  await copyFile(host, client);
  await writeFile(path.join(root, 'debug.log'), 'log');
  const result = spawnSync(host, [
    '--client', client, '--wipe-owned-files-on-start', '--attach', '1',
    '--debug-timeout', '1000', '--no-disk-write', '--quiet'
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(await exists(path.join(root, 'debug.log')), false, 'client debug.log must be removed');
  assert.equal(await exists(client), true, 'CXExam must never be removed');
  assert.notEqual(result.status, 0);
});
