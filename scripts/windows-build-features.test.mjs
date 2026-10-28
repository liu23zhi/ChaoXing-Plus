import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWindowsBuildFeatures } from './windows-build-features.mjs';

async function fixture(t, value) {
  const root = await mkdtemp(join(tmpdir(), 'cx-build-features-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'windows'));
  if (value !== undefined) await writeFile(join(root, 'windows', 'local-features.json'), value, 'utf8');
  return root;
}

test('Windows injection log defaults to false without an ignored local configuration', async (t) => {
  assert.deepEqual(await readWindowsBuildFeatures({ root: await fixture(t) }), { injectionLog: false });
});

test('Windows local injection log accepts only boolean true or false', async (t) => {
  for (const injectionLog of [true, false]) {
    const root = await fixture(t, JSON.stringify({ injectionLog }));
    assert.deepEqual(await readWindowsBuildFeatures({ root }), { injectionLog });
  }
  for (const text of ['{"injectionLog":"true"}', '{"injectionLog":1}', '[]', 'null', '{']) {
    await assert.rejects(readWindowsBuildFeatures({ root: await fixture(t, text) }), /local-features\.json/);
  }
});

test('release builds disable injection logs even with a true or invalid local configuration', async (t) => {
  for (const text of ['{"injectionLog":true}', 'invalid']) {
    assert.deepEqual(await readWindowsBuildFeatures({ root: await fixture(t, text), release: true }), { injectionLog: false });
  }
});

test('local Windows feature configuration is excluded from Git and extension builds disable its UI', async () => {
  const ignore = await readFile('.gitignore', 'utf8');
  assert.ok(ignore.split(/\r?\n/).includes('/windows/local-features.json'));
  const build = await readFile('build.mjs', 'utf8');
  assert.match(build, /__CXPLUS_WINDOWS_INJECTION_LOG__:\s*'false'/);
});
