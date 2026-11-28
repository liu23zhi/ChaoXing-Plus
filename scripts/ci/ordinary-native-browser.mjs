// Never touches the normal profile or actual service. Use standard installed Chrome/Edge.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { signer } from '../test-helpers/signed-crx-fixture.mjs';

const executable = process.argv[2];
assert.ok(process.argv[3] === '--isolated-local' ||
  (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows'
    && process.env.RUNNER_ENVIRONMENT === 'github-hosted'),
  'requires a disposable runner or an explicit isolated local fixture run');
assert.ok(process.platform === 'win32' && executable && existsSync(executable), 'an owned Windows x86 fixture is required');
const root = await mkdtemp(path.join(os.tmpdir(), 'cx-ordinary-signed-test-'));
async function entries(dir, prefix = '') {
  const all = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + e.name, file = path.join(dir, e.name);
    if (e.isDirectory()) all.push(...await entries(file, name + '/'));
    else if (e.isFile()) all.push({ name, bytes: await readFile(file) });
  }
  return all;
}

try {
  const source = signer(), variant = await entries('dist-native-ordinary');
  const manifest = JSON.parse(variant.find(e => e.name === 'manifest.json').bytes);
  assert.deepEqual(manifest.permissions, ['storage', 'nativeMessaging']);
  // Local extension-only route: load the real worker and bridge, but no background UI probes.
  variant.find(e => e.name === 'extension-agreement.html').bytes = '<!doctype html><title>Owned native message contract</title>';
  const native = path.join(root, 'native.crx'), old = path.join(root, 'old.crx');
  await writeFile(native, source.package(variant));
  await writeFile(old, source.package([
    { name: 'manifest.json', bytes: JSON.stringify({ manifest_version: 3, version: manifest.version,
      name: 'legacy owned fixture', permissions: ['storage'] }) }
  ]));
  for (const [kind, candidates] of [
    ['chrome', [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe')]],
    ['edge', [path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe')]]
  ]) {
    const browser = candidates.find(existsSync);
    assert.ok(browser, 'missing standard installed ' + kind);
    const output = spawnSync(executable, [browser, native, old, source.id, kind, randomUUID(), manifest.version],
      { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'], timeout: 110_000 });
    assert.ifError(output.error);
    assert.equal(output.status, 0, kind + ' actual ordinary browser result-only channel');
    console.log('PASS ' + kind + ': signed native build + result-only channel + no registry/profile residue');
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
