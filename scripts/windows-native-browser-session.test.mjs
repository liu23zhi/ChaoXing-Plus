import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync, constants as zlib } from 'node:zlib';
import { createTestDirectory } from './test-helpers/temp-directory.mjs';

const nativeExe = process.env.CX_NATIVE_BROWSER_SESSION_EXE;
const nativeAvailable = process.platform === 'win32' && !!nativeExe && existsSync(nativeExe);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), bytes = Buffer.from(entry.bytes ?? '');
    const method = entry.method ?? 8;
    const packed = entry.packed ?? (method === 0 ? bytes : deflateRawSync(bytes, entry.deflate));
    const crc = entry.crc ?? crc32(bytes), expandedSize = entry.expandedSize ?? bytes.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(expandedSize, 22); local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(packed.length, 20); directory.writeUInt32LE(expandedSize, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(entry.externalAttributes ?? 0, 38); directory.writeUInt32LE(offset, 42);
    locals.push(local, name, packed); central.push(directory, name); offset += local.length + name.length + packed.length;
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
}

function varint(value) {
  const result = [];
  do { const part = value & 127; value >>>= 7; result.push(value ? part | 128 : part); } while (value);
  return Buffer.from(result);
}
function field(number, bytes) { return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]); }

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = publicKey.export({ format: 'der', type: 'spki' });
  const idBytes = createHash('sha256').update(key).digest().subarray(0, 16);
  const id = [...idBytes].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
  return {
    id, key,
    package(entries) {
      const archive = zip(entries), signedData = field(1, idBytes), length = Buffer.alloc(4);
      length.writeUInt32LE(signedData.length);
      const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), length, signedData, archive]), privateKey);
      const header = Buffer.concat([field(2, Buffer.concat([field(1, key), field(2, signature)])), field(10000, signedData)]);
      const prefix = Buffer.alloc(12); prefix.write('Cr24'); prefix.writeUInt32LE(3, 4); prefix.writeUInt32LE(header.length, 8);
      return Buffer.concat([prefix, header, archive]);
    }
  };
}

function manifest(extra = {}) {
  return JSON.stringify({ manifest_version: 3, name: 'Native session isolation fixture', version: '1.2.3', permissions: ['storage'], action: { default_popup: 'popup.html' }, ...extra });
}
function entries(extra = []) {
  return [{ name: 'manifest.json', bytes: manifest() }, { name: 'popup.html', bytes: '<!doctype html><title>Session fixture</title>' }, ...extra];
}

function run(args, timeout = 45_000, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nativeExe, args, { windowsHide: true, env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`native browser session test timed out: ${stdout}${stderr}`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('native browser startup allows a cold first response beyond the normal command timeout', { skip: !nativeAvailable, timeout: 50_000 }, async () => {
  const directory = createTestDirectory('browser-cold-start'), source = signer(), packageFile = path.join(directory, 'fixture.crx');
  await writeFile(packageFile, source.package(entries()));
  const result = await run([nativeExe, packageFile, '--expected-id', source.id, '--startup-probe'], 45_000, {
    CX_BROWSER_SESSION_FIXTURE_ID: source.id, CX_BROWSER_SESSION_FIXTURE_DELAY_MS: '16000'
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /PASS delayed-startup cleaned/);
});

test('native browser startup keeps a total deadline and names the failed command', { skip: !nativeAvailable, timeout: 50_000 }, async () => {
  const directory = createTestDirectory('browser-start-deadline'), source = signer(), packageFile = path.join(directory, 'fixture.crx');
  await writeFile(packageFile, source.package(entries()));
  const started = Date.now();
  const result = await run([nativeExe, packageFile, '--expected-id', source.id, '--startup-probe'], 45_000, {
    CX_BROWSER_SESSION_FIXTURE_ID: source.id, CX_BROWSER_SESSION_FIXTURE_DELAY_MS: '60000'
  });
  const elapsed = Date.now() - started;
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Browser\.getVersion/);
  // The fixture stalls for 60s, the harness itself times out at 45s, so anything under 45s proves the
  // 30s startup deadline fired instead of waiting for the fixture; leave headroom for a loaded runner.
  assert.ok(elapsed >= 30_000 && elapsed < 45_000, `startup must expire once: ${elapsed}ms`);
});

test('native CRX verifier authenticates the full package without writing files', { skip: !nativeAvailable, timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-crx-verify-'));
  const source = signer(), packageFile = path.join(directory, 'fixture.crx');
  try {
    const valid = source.package(entries());
    await writeFile(packageFile, valid);
    assert.deepEqual(await run([source.id, packageFile, '--verify']), { code: 0, stdout: 'VERIFIED\n', stderr: '' });
    const wrong = await run(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', packageFile, '--verify']);
    assert.equal(wrong.code, 1); assert.match(wrong.stdout, /REJECTED/);
    const tampered = Buffer.from(valid); tampered[tampered.length - 1] ^= 1;
    await writeFile(packageFile, tampered);
    const rejected = await run([source.id, packageFile, '--verify']);
    assert.equal(rejected.code, 1); assert.match(rejected.stdout, /REJECTED/);
    assert.deepEqual(await readdir(directory), ['fixture.crx'], 'memory verification must not extract any file');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native signed CRX extraction supports stored, fixed, dynamic and uncompressed DEFLATE blocks', { skip: !nativeAvailable, timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-crx-extract-')), source = signer();
  const packageFile = path.join(directory, 'fixture.crx'), output = path.join(directory, 'unpacked');
  const text = Buffer.from(Array.from({ length: 4096 }, (_, index) => `content ${index % 31} ${'variable'.repeat(index % 7)}\n`).join(''));
  const samples = [
    { name: 'stored.txt', bytes: text, method: 0 },
    { name: 'fixed.txt', bytes: text, deflate: { strategy: zlib.Z_FIXED } },
    { name: 'dynamic.txt', bytes: text },
    { name: 'block.txt', bytes: text, deflate: { level: 0 } }
  ];
  assert.equal((deflateRawSync(text)[0] >> 1) & 3, 2, 'fixture must exercise dynamic Huffman codes');
  try {
    await writeFile(packageFile, source.package(entries(samples)));
    const result = await run([output, packageFile, '--extract']);
    assert.equal(result.code, 0, result.stdout + result.stderr); assert.match(result.stdout, new RegExp(`EXTRACTED ${source.id}`));
    for (const sample of samples) assert.deepEqual(await readFile(path.join(output, sample.name)), text);
    const loadedManifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
    assert.equal(loadedManifest.key, source.key.toString('base64'), 'the verified key must preserve the store identity after unpacking');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('native verifier rejects signed unsafe archives, decompression bombs and invalid manifests', { skip: !nativeAvailable, timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-crx-reject-')), source = signer(), packageFile = path.join(directory, 'fixture.crx');
  const cases = new Map();
  for (const name of ['../escaped.txt', 'a\\..\\escaped.txt', '/absolute.txt', 'C:relative.txt', 'a:stream', 'AUX.txt', 'dir. /entry', '../']) cases.set(`path ${name}`, entries([{ name }]));
  cases.set('case duplicate', entries([{ name: 'POPUP.HTML', bytes: 'duplicate' }]));
  cases.set('separator duplicate', entries([{ name: 'a/b', bytes: 'one' }, { name: 'a\\b', bytes: 'two' }]));
  cases.set('file directory conflict', entries([{ name: 'a', bytes: 'file' }, { name: 'a/b', bytes: 'child' }]));
  cases.set('reverse file directory conflict', entries([{ name: 'a/b', bytes: 'child' }, { name: 'a', bytes: 'file' }]));
  cases.set('symlink', entries([{ name: 'link', externalAttributes: 0xa1ff0000 }]));
  cases.set('single expanded limit', entries([{ name: 'bomb', expandedSize: 16 * 1024 * 1024 + 1 }]));
  cases.set('aggregate expanded limit', entries(Array.from({ length: 5 }, (_, index) => ({ name: `bomb${index}`, expandedSize: 16 * 1024 * 1024 }))));
  cases.set('entry count limit', entries(Array.from({ length: 512 }, (_, index) => ({ name: `extra${index}` }))));
  cases.set('CRC mismatch', entries([{ name: 'crc', bytes: 'content', crc: 0 }]));
  cases.set('bad DEFLATE', entries([{ name: 'bad', packed: Buffer.from([7]), expandedSize: 1 }]));
  cases.set('missing manifest', [{ name: 'popup.html', bytes: '<title>missing</title>' }]);
  cases.set('MV2', [{ name: 'manifest.json', bytes: manifest({ manifest_version: 2 }) }]);
  cases.set('invalid version', [{ name: 'manifest.json', bytes: manifest({ version: '../1' }) }]);
  cases.set('zero version', [{ name: 'manifest.json', bytes: manifest({ version: '0.0.0' }) }]);
  cases.set('NUL version', [{ name: 'manifest.json', bytes: manifest({ version: '1\0suffix' }) }]);
  cases.set('invalid JSON', [{ name: 'manifest.json', bytes: '{' }]);
  cases.set('conflicting identity key', [{ name: 'manifest.json', bytes: manifest({ key: 'AAAA' }) }]);
  cases.set('duplicate JSON identity', [{ name: 'manifest.json', bytes: `${manifest().slice(0, -1)},"key":"${source.key.toString('base64')}","key":"AAAA"}` }]);
  try {
    for (const [name, archiveEntries] of cases) {
      await writeFile(packageFile, source.package(archiveEntries));
      const result = await run([source.id, packageFile, '--verify']);
      assert.equal(result.code, 1, `${name}: ${result.stdout}${result.stderr}`); assert.match(result.stdout, /REJECTED/, name);
    }
    assert.deepEqual(await readdir(directory), ['fixture.crx']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const browserCandidates = [
  ['Chrome', process.env.CX_BROWSER_CHROME_PATH, path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')],
  ['Edge', process.env.CX_BROWSER_EDGE_PATH, path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
];

for (const [name, ...candidates] of browserCandidates) {
  const browser = process.platform === 'win32' ? candidates.find(candidate => candidate && existsSync(candidate)) : undefined;
  test(`native ${name} loads a real signed extension with two isolated profiles and cleans both`, { skip: !nativeAvailable || !browser, timeout: 120_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-browser-session-test-')), source = signer(), packageFile = path.join(directory, 'fixture.crx');
    try {
      await writeFile(packageFile, source.package(entries()));
      const result = await run([browser, packageFile, '--expected-id', source.id], 90_000);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`STARTED id=${source.id} profile=`));
      assert.match(result.stdout, /PASS loaded-extension settings-injected two-isolated-profiles both-cleaned/);
      const profiles = [...result.stdout.matchAll(/(?:STARTED id=\w+|SECOND) profile=([^\r\n]+)/g)].map(match => match[1]);
      assert.equal(profiles.length, 2); assert.notEqual(profiles[0], profiles[1]);
      for (const profile of profiles) { assert.equal(existsSync(profile), false); assert.equal(existsSync(path.dirname(profile)), false); }
      const wrong = await run([browser, packageFile, '--wrong-id']);
      assert.equal(wrong.code, 1); assert.doesNotMatch(wrong.stdout, /STARTED/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test(`native ${name} cleans its session after the last visible window closes`, { skip: !nativeAvailable || !browser || process.env.CX_TEST_NATIVE_WINDOW !== '1', timeout: 120_000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-browser-window-test-')), source = signer(), packageFile = path.join(directory, 'fixture.crx');
    try {
      await writeFile(packageFile, source.package(entries()));
      const result = await run([browser, packageFile, '--expected-id', source.id, '--window-close'], 90_000);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /PASS last-window-close cleaned/);
      assert.match(result.stdout, /PASS loaded-extension settings-injected two-isolated-profiles both-cleaned/);
      const profiles = [...result.stdout.matchAll(/(?:STARTED id=\w+|SECOND) profile=([^\r\n]+)/g)].map(match => match[1]);
      assert.equal(profiles.length, 2);
      for (const profile of profiles) assert.equal(existsSync(path.dirname(profile)), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
