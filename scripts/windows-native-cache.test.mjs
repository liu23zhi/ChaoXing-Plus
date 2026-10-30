import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const executable = process.env.CX_NATIVE_CACHE_EXE;
const hostTests = process.env.CX_NATIVE_CACHE_HOST_EXE;
const nativeTest = (name, run) => test(name, { skip: !executable }, run);

test('compiled native host wires scan cache flags without launching or scanning a client', { skip: !hostTests }, () => {
  const result = spawnSync(hostTests, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ''));
  assert.match(result.stdout, /NATIVE CACHE HOST TESTS PASS/);
});

test('compiled native help and capabilities expose bounded scan caching', { skip: !process.env.CX_NATIVE_HOST_EXE }, () => {
  const run = (...args) => spawnSync(process.env.CX_NATIVE_HOST_EXE, args, {
    encoding: 'utf8', windowsHide: true, timeout: 10000
  });
  const help = run('--help'); assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /--rescan/); assert.match(help.stdout, /--no-scan-cache/);
  const capabilities = run('--capabilities'); assert.equal(capabilities.status, 0, capabilities.stdout + capabilities.stderr);
  assert.equal(JSON.parse(capabilities.stdout).scanCache, true);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-native-cache-'));
  const common = path.join(root, 'common');
  const fixed = path.join(root, 'fixed');
  const cache = path.join(root, 'data', 'chaoxing', 'native-scan-cache-v1.bin');
  await fs.mkdir(common); await fs.mkdir(fixed);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, common, fixed, cache };
}

async function pe(directory, machine = 0x14c) {
  await fs.mkdir(directory, { recursive: true });
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(224, 148);
  bytes.writeUInt16LE(machine === 0x8664 ? 0x20b : 0x10b, 152);
  const file = path.join(directory, 'CXExam.exe');
  await fs.writeFile(file, bytes);
  return file;
}

function scan(f, ...extra) {
  const result = spawnSync(executable, ['--common', f.common, '--fixed', f.fixed, '--cache', f.cache, ...extra], {
    encoding: 'utf8', windowsHide: true, timeout: 15000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ''));
  const lines = result.stdout.trim().split(/\r?\n/u);
  const fields = lines.find((line) => line.startsWith('RESULT\t'))?.split('\t').slice(1).map(Number);
  assert.ok(fields, result.stdout);
  const [count, cacheHit, commonScanned, fallbackScanned, stoppedOnX86, truncated] = fields;
  return { count, cacheHit: Boolean(cacheHit), commonScanned: Boolean(commonScanned), fallbackScanned: Boolean(fallbackScanned), stoppedOnX86: Boolean(stoppedOnX86), truncated: Boolean(truncated), paths: lines.filter((line) => line.startsWith('CAND\t')).map((line) => line.split('\t')[2]) };
}

nativeTest('native common cache reuses complete positive results with fixed-root first-level candidates', async (t) => {
  const f = await fixture(t);
  await pe(path.join(f.common, 'Release'), 0x8664);
  await pe(path.join(f.fixed, 'Exam'));
  await pe(path.join(f.common, 'Release', 'Deep'));
  const first = scan(f);
  assert.equal(first.count, 2); assert.equal(first.cacheHit, false);
  assert.ok((await fs.stat(f.cache)).size > 44);
  const cached = scan(f, '--mode', 'fallback-all');
  assert.equal(cached.cacheHit, true); assert.equal(cached.fallbackScanned, false);
  assert.deepEqual(cached.paths, first.paths);
});

nativeTest('native common x64 cache does not trigger fallback to find a deeper x86', async (t) => {
  const f = await fixture(t);
  await pe(f.common, 0x8664); await pe(path.join(f.fixed, 'Deep', 'Nested'));
  assert.equal(scan(f, '--mode', 'fallback-all').count, 1);
  const cached = scan(f, '--mode', 'fallback-all');
  assert.equal(cached.cacheHit, true); assert.equal(cached.fallbackScanned, false); assert.equal(cached.count, 1);
});

nativeTest('native cache invalidates actual common/fixed scope and OS architecture constraints', async (t) => {
  const f = await fixture(t); await pe(f.common, 0x8664); scan(f);
  assert.equal(scan(f).cacheHit, true);
  const changedCommon = { ...f, common: path.join(f.root, 'another') }; await pe(changedCommon.common);
  assert.equal(scan(changedCommon).cacheHit, false);
  const changedFixed = { ...changedCommon, fixed: path.join(f.root, 'other-fixed') }; await fs.mkdir(changedFixed.fixed);
  assert.equal(scan(changedFixed).cacheHit, false);
  assert.equal(scan(changedFixed, '--force-x86-os').cacheHit, false);
});

nativeTest('native rescan refreshes a positive cache while no-cache/no-disk-write forbid reading or writing it', async (t) => {
  const f = await fixture(t); await pe(f.common); scan(f); const original = await fs.readFile(f.cache);
  await pe(path.join(f.common, 'New'));
  assert.equal(scan(f).count, 1);
  for (const flag of ['--no-cache', '--no-disk-write']) {
    const result = scan(f, flag); assert.equal(result.cacheHit, false); assert.equal(result.count, 2);
    assert.deepEqual(await fs.readFile(f.cache), original);
    const absent = { ...f, cache: path.join(f.root, flag, 'cache.bin') };
    scan(absent, flag); await assert.rejects(fs.access(path.dirname(absent.cache)));
  }
  const refreshed = scan(f, '--rescan'); assert.equal(refreshed.cacheHit, false); assert.equal(refreshed.count, 2);
  assert.equal(scan(f).cacheHit, true); assert.equal(scan(f).count, 2);
});

nativeTest('native explicit/all scans and recursive or empty results never create or consume a common cache', async (t) => {
  const f = await fixture(t); const client = await pe(f.common); scan(f); const original = await fs.readFile(f.cache);
  for (const args of [['--client', client], ['--mode', 'all']]) {
    assert.equal(scan(f, ...args).cacheHit, false); assert.deepEqual(await fs.readFile(f.cache), original);
  }
  await fs.rm(client); await fs.rm(f.cache); await pe(path.join(f.fixed, 'Deep', 'Nested'));
  const recursive = scan(f, '--mode', 'fallback-all');
  assert.equal(recursive.fallbackScanned, true); assert.equal(recursive.stoppedOnX86, true);
  await assert.rejects(fs.access(f.cache));
  await fs.rm(f.fixed, { recursive: true }); await fs.mkdir(f.fixed);
  assert.equal(scan(f).count, 0); await assert.rejects(fs.access(f.cache));
});

nativeTest('native cache rejects expiry, future timestamps, format/depth changes, malformed and over-limit files', async (t) => {
  const f = await fixture(t); await pe(f.common); scan(f); const original = await fs.readFile(f.cache);
  const mutations = [
    (b) => b.writeBigUInt64LE(0n, 36),
    (b) => b.writeBigUInt64LE(0xffffffffffffffffn, 36),
    (b) => b.writeUInt32LE(99, 4),
    (b) => b.writeUInt32LE(2, 8),
    (b) => b.writeUInt32LE(0xffffffff, 12),
    (b) => b.writeUInt32LE(1025, 28),
    (b) => b.writeUInt32LE(129, 20),
    (b) => b.fill(0, 0, 4)
  ];
  for (const mutate of mutations) {
    const invalid = Buffer.from(original); mutate(invalid); await fs.writeFile(f.cache, invalid);
    assert.equal(scan(f).cacheHit, false);
  }
  for (const invalid of [original.subarray(0, 12), Buffer.concat([original, Buffer.from('trailing')]), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
    await fs.writeFile(f.cache, invalid); assert.equal(scan(f).cacheHit, false);
  }
});

nativeTest('native cache revalidates PE, changed fingerprints, replacements and deleted candidates', async (t) => {
  const f = await fixture(t); const client = await pe(f.common); scan(f);
  await fs.appendFile(client, 'changed'); assert.equal(scan(f).cacheHit, false);
  await fs.rm(client); await pe(f.common, 0x8664); assert.equal(scan(f).cacheHit, false);
  await fs.writeFile(client, Buffer.alloc(512)); assert.equal(scan(f).count, 0); assert.equal(scan(f).cacheHit, false);
  await fs.rm(client); assert.equal(scan(f).count, 0);
});

nativeTest('native cache rejects candidates outside scope and junction-replaced parent directories', async (t) => {
  const f = await fixture(t); const release = path.join(f.common, 'Release'); await pe(release); scan(f);
  const bytes = await fs.readFile(f.cache);
  const outside = path.join(f.root, 'extern', 'Release'); await fs.mkdir(path.dirname(outside));
  await fs.rename(release, outside);
  await fs.symlink(outside, release, 'junction');
  assert.equal(scan(f).cacheHit, false); assert.equal(scan(f).count, 0);
  await fs.rm(release); await fs.rename(outside, release); scan(f, '--rescan');
  const forged = Buffer.from(bytes); const needle = Buffer.from(f.common, 'utf16le');
  const candidate = forged.lastIndexOf(needle);
  assert.ok(candidate > 44); Buffer.from(path.join(f.root, 'extern'), 'utf16le').copy(forged, candidate);
  await fs.writeFile(f.cache, forged); assert.equal(scan(f).cacheHit, false);
});

nativeTest('native cache limits and replacement failures remain nonfatal and leave no owned temporary files', async (t) => {
  const f = await fixture(t); await pe(f.common);
  assert.equal(scan(f, '--many-roots').count, 1); await assert.rejects(fs.access(f.cache));
  scan(f); const original = await fs.readFile(f.cache);
  await fs.chmod(f.cache, 0o444);
  try {
    const result = scan(f, '--rescan'); assert.equal(result.count, 1); assert.equal(result.cacheHit, false);
    assert.deepEqual(await fs.readFile(f.cache), original);
    assert.deepEqual(await fs.readdir(path.dirname(f.cache)), [path.basename(f.cache)]);
  } finally { await fs.chmod(f.cache, 0o666); }
});

nativeTest('native cache cannot bypass skipped system directory names with an in-scope file fingerprint', async (t) => {
  const f = await fixture(t);
  const release = path.join(f.fixed, 'Release');
  await pe(release); scan(f);
  const original = await fs.readFile(f.cache);
  await fs.rename(release, path.join(f.fixed, 'Windows'));
  const needle = Buffer.from(path.join(release, 'CXExam.exe'), 'utf16le');
  const replacement = Buffer.from(path.join(f.fixed, 'Windows', 'CXExam.exe'), 'utf16le');
  assert.equal(needle.length, replacement.length);
  const offset = original.indexOf(needle); assert.ok(offset > 44);
  replacement.copy(original, offset); await fs.writeFile(f.cache, original);
  const result = scan(f);
  assert.equal(result.cacheHit, false); assert.equal(result.count, 0);
});
