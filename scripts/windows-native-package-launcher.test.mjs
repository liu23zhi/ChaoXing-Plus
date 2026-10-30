import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'windows', 'native-source', 'package-launcher.c');
const executable = process.env.CX_NATIVE_PACKAGE_LAUNCHER_EXE;
const nativeUnavailable = process.platform !== 'win32' || !executable;

test('portable package launcher keeps a bounded, owned-only extraction contract', async () => {
  const text = await fs.readFile(source, 'utf8');
  assert.match(text, /CXPKG001/);
  assert.match(text, /#define PKG_RESOURCE 201/);
  assert.match(text, /PKG_MAX_FILES 4096/);
  assert.match(text, /PKG_MAX_ARCHIVE/);
  assert.match(text, /MultiByteToWideChar\(CP_UTF8, MB_ERR_INVALID_CHARS/);
  assert.match(text, /FILE_FLAG_OPEN_REPARSE_POINT/);
  assert.match(text, /CREATE_NEW/);
  assert.match(text, /PKG_CLEANUP_ATTEMPTS/);
  assert.match(text, /pkg_delete_owned\(/);
  assert.match(text, /GetFileInformationByHandle/);
  assert.match(text, /WaitForSingleObject\(process\.hProcess, INFINITE\)/);
  assert.match(text, /pkg_argument_tail\(/);
  assert.match(text, /CreateProcessW\(state->child, command/);
  assert.match(text, /AttachConsole\(ATTACH_PARENT_PROCESS\)/);
  assert.doesNotMatch(text, /AllocConsole\s*\(/);
  assert.doesNotMatch(text, /DeleteFileW\([^)]*source/i);
  assert.doesNotMatch(text, /powershell/i);
  assert.doesNotMatch(text, /self.?destruct/i);
});

test('compiled portable package launches the GUI child and removes its private files', {
  skip: nativeUnavailable
}, async () => {
  const original = path.resolve(executable);
  const originalStat = await fs.stat(original);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-package-launcher-test-'));
  try {
    const launcher = path.join(directory, 'portable app.exe');
    const privateTemp = path.join(directory, 'private temp');
    await fs.mkdir(privateTemp);
    await fs.copyFile(original, launcher);
    const run = (...args) => spawnSync(launcher, args, {
      cwd: directory, encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, TEMP: privateTemp, TMP: privateTemp },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    for (const args of [['--version'], ['--help'], ['--version']]) {
      const result = run(...args);
      assert.equal(result.error, undefined, `${args.join(' ')}: ${result.error?.message ?? ''}`);
      assert.equal(result.status, 0, `${args.join(' ')} exited ${result.status}: ${result.stdout}\n${result.stderr}`);
      if (args[0] === '--version') assert.equal(result.stdout.trim(), '6.2.0');
      else assert.match(result.stdout, /--help/);
    }
    await fs.writeFile(path.join(directory, 'config with spaces.json'), JSON.stringify({ answerThreads: 3 }));
    const theme = 'space "quoted" \u4e2d\u6587 trail\\';
    const configuration = run('--print-effective-config', '--config', 'config with spaces.json',
      '--options-json', JSON.stringify({ panelTheme: theme, noDiskWrite: true }));
    assert.equal(configuration.error, undefined, configuration.error?.message);
    assert.equal(configuration.status, 0, `${configuration.stdout}\n${configuration.stderr}`);
    const effective = JSON.parse(configuration.stdout);
    assert.equal(effective['common.settings.windows-answer-threads'], 3, 'relative config must use caller cwd');
    assert.equal(effective['common.settings.windows-panel-theme'], theme, 'JSON quotes, Unicode and trailing slash must survive');
    const rejected = run('--unknown-package-launcher-test-option');
    assert.equal(rejected.error, undefined, rejected.error?.message);
    assert.equal(rejected.status, 2, 'launcher must forward child exit code');
    assert.deepEqual(await fs.readdir(privateTemp), [], 'every invocation must remove its own extracted files');
    assert.equal((await fs.stat(launcher)).size, originalStat.size, 'portable copy must remain present');
    const junction = path.join(directory, 'junction temp');
    await fs.symlink(privateTemp, junction, 'junction');
    const unsafeTemp = spawnSync(launcher, ['--version'], {
      cwd: directory, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...process.env, TEMP: junction, TMP: junction }
    });
    assert.equal(unsafeTemp.error, undefined, unsafeTemp.error?.message);
    assert.equal(unsafeTemp.status, 29, 'reparse temp directory must fail without following its target');
    assert.deepEqual(await fs.readdir(privateTemp), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  const currentStat = await fs.stat(original);
  assert.equal(currentStat.size, originalStat.size, 'launcher source executable must not be removed');
});

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`${shell} receives complete help from the GUI package launcher`, { skip: nativeUnavailable }, async () => {
    const launcher = path.resolve(executable);
    const privateTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-package-shell-test-'));
    try {
      const command = `& '${launcher.replaceAll("'", "''")}' --help`;
      const result = spawnSync(shell, [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')
      ], { encoding: 'utf8', timeout: 60_000, windowsHide: true,
        env: { ...process.env, TEMP: privateTemp, TMP: privateTemp } });
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /--silent-scenario/);
      assert.match(result.stdout, /--answer-retry/);
      assert.match(result.stdout, /--show-inject-reasons/);
      assert.deepEqual(await fs.readdir(privateTemp), []);
    } finally {
      await fs.rm(privateTemp, { recursive: true, force: true });
    }
  });
}

function archiveResource(image) {
  const pe = image.readUInt32LE(0x3c);
  assert.equal(image.toString('ascii', pe, pe + 4), 'PE\u0000\u0000');
  const optional = pe + 24;
  assert.equal(image.readUInt16LE(optional + 68), 2, 'package launcher must use the GUI subsystem');
  const directories = optional + (image.readUInt16LE(optional) === 0x10b ? 96 : 112);
  const sections = optional + image.readUInt16LE(pe + 20);
  function rvaOffset(rva) {
    for (let i = 0; i < image.readUInt16LE(pe + 6); i++) {
      const at = sections + i * 40;
      const start = image.readUInt32LE(at + 12);
      const size = Math.max(image.readUInt32LE(at + 8), image.readUInt32LE(at + 16));
      if (rva >= start && rva < start + size) return image.readUInt32LE(at + 20) + rva - start;
    }
    throw new Error(`unmapped resource RVA ${rva}`);
  }
  const resourceRoot = rvaOffset(image.readUInt32LE(directories + 16));
  function entry(directory, id) {
    const at = resourceRoot + directory;
    const count = image.readUInt16LE(at + 12) + image.readUInt16LE(at + 14);
    for (let i = 0; i < count; i++) {
      const item = at + 16 + i * 8;
      if (id === undefined || image.readUInt32LE(item) === id) return image.readUInt32LE(item + 4);
    }
    throw new Error(`resource ID ${id} missing`);
  }
  const type = entry(0, 10);
  const name = entry(type & 0x7fffffff, 201);
  const language = entry(name & 0x7fffffff);
  assert.equal(language >>> 31, 0, 'resource language must point to data');
  const data = resourceRoot + language;
  const offset = rvaOffset(image.readUInt32LE(data));
  const length = image.readUInt32LE(data + 4);
  assert.ok(offset + length <= image.length);
  assert.equal(image.toString('ascii', offset, offset + 8), 'CXPKG001');
  return { offset, length };
}

test('compiled portable package rejects malformed archives before extracting files', {
  skip: nativeUnavailable
}, async () => {
  const image = await fs.readFile(path.resolve(executable));
  const resource = archiveResource(image);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-package-invalid-test-'));
  const privateTemp = path.join(directory, 'private temp');
  const variants = [
    ['signature', data => { data[0] = 0; }],
    ['file-count', data => { data.writeUInt32LE(4097, 8); }],
    ['traversal', data => { data.write('../', 20, 'ascii'); }],
    ['absolute', data => { data[20] = 47; }],
    ['invalid-utf8', data => { data[20] = 255; }],
    ['nul-path', data => { data[20] = 0; }],
    ['device-path', data => { data.write('NUL.', 20, 'ascii'); }],
    ['trailing-dot', data => { data[20 + data.readUInt32LE(12) - 1] = 46; }],
    ['oversized-file', data => { data.writeUInt32LE(0xffffffff, 16); }],
    ['truncated-path', data => { data.writeUInt32LE(0xffffffff, 12); }],
    ['duplicate', data => {
      data.fill(0);
      data.write('CXPKG001', 0, 'ascii');
      data.writeUInt32LE(2, 8);
      const name = Buffer.from('chaoxing_plus.exe');
      data.writeUInt32LE(name.length, 12);
      name.copy(data, 20);
      const second = 20 + name.length;
      data.writeUInt32LE(name.length, second);
      data.writeUInt32LE(data.length - second - 8 - name.length, second + 4);
      name.copy(data, second + 8);
    }]
  ];
  try {
    await fs.mkdir(privateTemp);
    for (const [name, mutate] of variants) {
      const invalid = Buffer.from(image);
      mutate(invalid.subarray(resource.offset, resource.offset + resource.length));
      const launcher = path.join(directory, `${name}.exe`);
      await fs.writeFile(launcher, invalid);
      const result = spawnSync(launcher, ['--version'], {
        cwd: directory, encoding: 'utf8', timeout: 30_000, windowsHide: true,
        env: { ...process.env, TEMP: privateTemp, TMP: privateTemp }
      });
      assert.equal(result.error, undefined, `${name}: ${result.error?.message ?? ''}`);
      assert.equal(result.status, 11, `${name}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /embedded file archive is invalid/, name);
      assert.deepEqual(await fs.readdir(privateTemp), [], `${name}: invalid archive must not extract files`);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
