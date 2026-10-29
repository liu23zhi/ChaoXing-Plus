import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driverPath = process.env.CX_NATIVE_ASSETS_EXE;
const hostPath = process.env.CX_NATIVE_HOST_EXE;
const names = ['windows-bootstrap.js', 'chaoxing-plus.windows.js', 'trampoline.js', 'sweetalert2.min.css'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (executable, args = [], cwd) => spawnSync(executable, args, {
  timeout: 15_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, cwd
});

test('native asset build embeds all resources without a runtime extraction path', async () => {
  const [source, build, template] = await Promise.all([
    fs.readFile(path.join(root, 'windows/native-source/assets.c'), 'utf8'),
    fs.readFile(path.join(root, 'windows/native-source/build.ps1'), 'utf8'),
    fs.readFile(path.join(root, 'windows/native-source/assets.rc.in'), 'utf8')
  ]);
  for (const name of names) assert.ok(source.includes(name), name);
  assert.match(source, /FindResourceW/);
  assert.match(source, /LockResource/);
  assert.doesNotMatch(source, /CREATE_ALWAYS|CREATE_NEW|GENERIC_WRITE|WriteFile/);
  assert.match(build, /assets\.res/);
  for (const token of ['BOOTSTRAP', 'BUNDLE', 'TRAMPOLINE', 'SWAL_STYLE'])
    assert.ok(template.includes(`@${token}@`));
});

test('compiled native assets load safely and match every packaged source byte', { skip: !driverPath || !hostPath }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-assets-中文 空格-'));
  try {
    const driver = path.join(dir, 'asset tests.exe');
    const host = path.join(dir, '超星学习助手.exe');
    await Promise.all([fs.copyFile(driverPath, driver), fs.copyFile(hostPath, host)]);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['asset tests.exe', '超星学习助手.exe'].sort());
    const checks = run(driver, ['--self-test'], dir);
    assert.equal(checks.status, 0, checks.stdout + checks.stderr);
    assert.match(checks.stdout.toString('utf8'), /NATIVE ASSET TESTS PASS/);
    for (const name of names) {
      const assetPath = path.join(root, 'dist-windows', name === 'sweetalert2.min.css' ? 'vendor/sweetalert2.min.css' : name);
      const expected = await fs.readFile(assetPath);
      for (const args of [['--dump', name], ['--dump-from-module', host, name]]) {
        const actual = run(driver, args, dir);
        assert.equal(actual.status, 0, `${args.join(' ')}: ${actual.stdout}\n${actual.stderr}`);
        assert.equal(actual.stdout.length, expected.length, name);
        assert.equal(hash(actual.stdout), hash(expected), name);
      }
    }
    const missing = run(driver, ['--dump', names[0], path.join(dir, 'missing override')], dir);
    assert.equal(missing.status, 3, 'explicit missing override must not fall back to embedded bytes');
    const override = path.join(dir, '外部 资源');
    await fs.mkdir(path.join(override, 'vendor'), { recursive: true });
    for (const name of names) {
      const overrideBytes = Buffer.from(`// local override ${name}\n中文\n`);
      const filename = name === 'sweetalert2.min.css' ? 'vendor/sweetalert2.min.css' : name;
      await fs.writeFile(path.join(override, filename), overrideBytes);
      const actual = run(driver, ['--dump', name, override], dir);
      assert.equal(actual.status, 0, actual.stdout + actual.stderr);
      assert.deepEqual(actual.stdout, overrideBytes);
    }
    await fs.writeFile(path.join(override, names[0]), '');
    assert.equal(run(driver, ['--dump', names[0], override], dir).status, 3, 'empty override is rejected');
    await fs.truncate(path.join(override, names[0]), 8 * 1024 * 1024 + 1);
    assert.equal(run(driver, ['--dump', names[0], override], dir).status, 3, 'oversized override is rejected before loading');
    assert.deepEqual((await fs.readdir(dir)).sort(), ['asset tests.exe', '超星学习助手.exe', '外部 资源'].sort(), 'loading never extracts resources beside the executable');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

