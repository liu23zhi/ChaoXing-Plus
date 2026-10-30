import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const executable = process.env.CX_NATIVE_MULTI_HOST_EXE && path.resolve(process.env.CX_NATIVE_MULTI_HOST_EXE);
const runtimeFiles = [
  'assets/windows-bootstrap.js', 'assets/chaoxing-plus.windows.js',
  'assets/trampoline.js', 'assets/vendor/sweetalert2.min.css', 'winmm-proxy.dll'
];

async function snapshot(directory, prefix = '') {
  const result = {};
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = `${prefix}${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result[`${relative}/`] = 'directory';
      Object.assign(result, await snapshot(absolute, `${relative}/`));
    } else {
      result[relative] = createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
    }
  }
  return result;
}

test('multi-file rejects deletion options before help, self-check or staged boot can change any files', {
  skip: process.platform !== 'win32' || !executable
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'cx-multi-restrictions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const packageDirectory = path.join(directory, 'package');
  const working = path.join(directory, 'working');
  const data = path.join(directory, 'data');
  await fs.mkdir(packageDirectory);
  await fs.mkdir(working);
  const host = path.join(packageDirectory, 'chaoxing_plus.exe');
  await fs.copyFile(executable, host);
  for (const relative of runtimeFiles) {
    const target = path.join(packageDirectory, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(path.dirname(executable), relative), target);
  }
  for (const relative of [
    'chaoxing/native-scan-cache-v1.bin', 'chaoxing/logs/windows-host-owned-fixture.log',
    'chaoxing/logs/unrelated.txt', 'config.json'
  ]) {
    const target = path.join(data, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `preserve ${relative}\n`);
  }
  const before = await snapshot(directory);
  for (const args of [
    ['--wipe-owned-files-on-start', '--help'],
    ['--wipe-owned-files-on-start', '--self-check'],
    ['--staged-boot', '--help'],
    ['--staged-boot', '--self-check'],
    ['--stage-boot', '--help'],
    ['--delete-suspend', '--help'],
    ['--silent-scenario', '--help'],
    ['--self-destruct-key', 'Ctrl+Shift+D', '--help'],
    ['--self-destruct-on-fullscreen-exit', '--help']
  ]) {
    const result = spawnSync(host, [...args, '--data-dir', data, '--no-log'], {
      cwd: working, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024
    });
    assert.equal(result.error, undefined, `${args.join(' ')}: ${result.error?.message ?? ''}`);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}\n${result.stderr}`);
    const silent = args.some((value) => ['--staged-boot', '--stage-boot', '--silent-scenario'].includes(value));
    if (silent) assert.equal(result.stdout + result.stderr, '', 'silent options still suppress diagnostics');
    else assert.match(result.stdout + result.stderr, /multi-file builds do not support/i, args.join(' '));
    assert.deepEqual(await snapshot(directory), before, `${args.join(' ')} must reject before any file change`);
  }
});
