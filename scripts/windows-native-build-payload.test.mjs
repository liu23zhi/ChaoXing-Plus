import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagePayload, runtimeFiles } from '../windows/native-source/package-multi-payload.mjs';

const script = fileURLToPath(new URL('../windows/native-source/package-multi-payload.mjs', import.meta.url));
const expectedFiles = [
  'chaoxing_plus.exe', 'chaoxing_plus.com',
  'assets/windows-bootstrap.js', 'assets/chaoxing-plus.windows.js',
  'assets/trampoline.js', 'assets/vendor/sweetalert2.min.css', 'winmm-proxy.dll'
];

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'cx-build-payload-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, 'runtime');
  const files = new Map();
  for (const [index, relative] of expectedFiles.entries()) {
    const bytes = Buffer.concat([
      Buffer.from(`payload ${index} ${relative}\n`, 'utf8'),
      Buffer.from([0, 255, 128, index, 13, 10, 34, 92])
    ]);
    files.set(relative, bytes);
    await fs.mkdir(path.dirname(path.join(runtime, relative)), { recursive: true });
    await fs.writeFile(path.join(runtime, relative), bytes);
  }
  return { directory, runtime, files, output: path.join(directory, 'build', 'payload.bin') };
}

function decodePayload(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('ascii'), 'CXPKG001');
  const count = bytes.readUInt32LE(8);
  const entries = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    assert.ok(offset + 8 <= bytes.length, `entry ${index} header is in bounds`);
    const nameLength = bytes.readUInt32LE(offset);
    const dataLength = bytes.readUInt32LE(offset + 4);
    offset += 8;
    assert.ok(nameLength > 0 && dataLength > 0);
    assert.ok(offset + nameLength + dataLength <= bytes.length, `entry ${index} data is in bounds`);
    const name = bytes.subarray(offset, offset + nameLength).toString('utf8');
    offset += nameLength;
    const data = bytes.subarray(offset, offset + dataLength);
    offset += dataLength;
    entries.push({ name, data });
  }
  assert.equal(offset, bytes.length, 'the payload has no trailing unparsed bytes');
  return entries;
}

test('native build payload has the fixed launcher wire format and preserves every runtime byte', async (t) => {
  const value = await fixture(t);
  assert.deepEqual(runtimeFiles, expectedFiles, 'the package is an explicit runtime allowlist');
  await packagePayload(value.runtime, value.output);
  const bytes = await fs.readFile(value.output);
  const entries = decodePayload(bytes);
  assert.deepEqual(entries.map(({ name }) => name), expectedFiles);
  for (const { name, data } of entries) assert.deepEqual(data, value.files.get(name), name);
  assert.equal(bytes.length, 12 + expectedFiles.reduce((total, name) =>
    total + 8 + Buffer.byteLength(name, 'utf8') + value.files.get(name).length, 0));
  const second = path.join(value.directory, 'second.bin');
  await packagePayload(value.runtime, second);
  assert.deepEqual(await fs.readFile(second), bytes, 'identical inputs produce identical payload bytes');
});

test('native build payload excludes the extraction wrapper, nested payloads and unrelated build files', async (t) => {
  const value = await fixture(t);
  const extras = [
    'package-to-single/chaoxing_plus.exe', 'package-to-single/assets/nested.bin',
    'release-info.json', 'SHA256SUMS.txt', 'debug-tests.exe'
  ];
  for (const relative of extras) {
    await fs.mkdir(path.dirname(path.join(value.runtime, relative)), { recursive: true });
    await fs.writeFile(path.join(value.runtime, relative), `never embed ${relative}`);
  }
  await packagePayload(value.runtime, value.output);
  const entries = decodePayload(await fs.readFile(value.output));
  assert.deepEqual(entries.map(({ name }) => name), expectedFiles);
  assert.equal(entries.some(({ name }) => name.startsWith('package-to-single/')), false);
  await packagePayload(value.runtime, path.join(value.runtime, 'package-to-single', 'payload.bin'));
  assert.deepEqual(decodePayload(await fs.readFile(path.join(value.runtime, 'package-to-single', 'payload.bin')))
    .map(({ name }) => name), expectedFiles, 'an output under the wrapper directory never includes itself');
});

test('native build payload rejects every missing runtime file before replacing an existing output', async (t) => {
  const value = await fixture(t);
  await fs.mkdir(path.dirname(value.output), { recursive: true });
  await fs.writeFile(value.output, 'previous valid output');
  for (const relative of expectedFiles) {
    await fs.rm(path.join(value.runtime, relative));
    await assert.rejects(packagePayload(value.runtime, value.output), { code: 'ENOENT' }, relative);
    assert.equal(await fs.readFile(value.output, 'utf8'), 'previous valid output', relative);
    await fs.writeFile(path.join(value.runtime, relative), value.files.get(relative));
  }
});

test('native build payload rejects empty and non-file runtime entries without creating an archive', async (t) => {
  const value = await fixture(t);
  const target = path.join(value.runtime, 'chaoxing_plus.com');
  await fs.writeFile(target, '');
  await assert.rejects(packagePayload(value.runtime, value.output), /Invalid payload file: chaoxing_plus\.com/);
  await assert.rejects(fs.access(value.output), { code: 'ENOENT' });
  await fs.rm(target);
  await fs.mkdir(target);
  await assert.rejects(packagePayload(value.runtime, value.output), /Invalid payload file: chaoxing_plus\.com/);
  await assert.rejects(fs.access(value.output), { code: 'ENOENT' });
});

test('native build payload refuses linked resource directories', async (t) => {
  const value = await fixture(t);
  const assets = path.join(value.runtime, 'assets');
  const external = path.join(value.directory, 'external-assets');
  await fs.rename(assets, external);
  await fs.symlink(external, assets, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(packagePayload(value.runtime, value.output), /Payload links are not allowed: assets\/windows-bootstrap\.js/);
  assert.deepEqual(await fs.readFile(path.join(external, 'windows-bootstrap.js')),
    value.files.get('assets/windows-bootstrap.js'), 'linked input targets are unchanged');
  await assert.rejects(fs.access(value.output), { code: 'ENOENT' });
});

test('native build payload refuses linked runtime files', async (t) => {
  const value = await fixture(t);
  const target = path.join(value.runtime, 'chaoxing_plus.com');
  const external = path.join(value.directory, 'external-helper.com');
  await fs.rename(target, external);
  try {
    await fs.symlink(external, target, 'file');
  } catch (error) {
    if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Windows file symlinks require Developer Mode or symbolic-link privilege');
      return;
    }
    throw error;
  }
  await assert.rejects(packagePayload(value.runtime, value.output), /Payload links are not allowed: chaoxing_plus\.com/);
  assert.deepEqual(await fs.readFile(external), value.files.get('chaoxing_plus.com'));
  await assert.rejects(fs.access(value.output), { code: 'ENOENT' });
});

test('native build payload CLI writes the same archive and rejects an incomplete invocation', async (t) => {
  const value = await fixture(t);
  const result = spawnSync(process.execPath, [script, value.runtime, value.output], {
    encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const entries = decodePayload(await fs.readFile(value.output));
  for (const { name, data } of entries) assert.deepEqual(data, value.files.get(name));
  const invalid = spawnSync(process.execPath, [script, value.runtime], {
    encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Usage: package-multi-payload\.mjs/);
});
