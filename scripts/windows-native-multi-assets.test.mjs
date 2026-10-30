import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const executable = process.env.CX_NATIVE_MULTI_HOST_EXE && resolve(process.env.CX_NATIVE_MULTI_HOST_EXE);
const driver = process.env.CX_NATIVE_MULTI_ASSETS_EXE && resolve(process.env.CX_NATIVE_MULTI_ASSETS_EXE);
const nativeTest = (name, run) => test(name, { skip: process.platform !== 'win32' || !executable }, run);
const sidecars = [
  'assets/windows-bootstrap.js', 'assets/chaoxing-plus.windows.js',
  'assets/trampoline.js', 'assets/vendor/sweetalert2.min.css', 'winmm-proxy.dll'
];

async function snapshot(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, await snapshot(join(directory, entry.name), `${relative}/`));
    else files[relative] = createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex');
  }
  return files;
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'cx-native-multi-\u4e2d\u6587 space-'));
  try {
    const folder = join(directory, 'relocated package');
    const working = join(directory, 'unrelated working directory');
    await cp(dirname(executable), folder, { recursive: true });
    await mkdir(working);
    const host = join(folder, basename(executable));
    const invoke = (...args) => spawnSync(host, args, {
      cwd: working, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024
    });
    await run({ directory, folder, working, host, invoke });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function report(result, expected = 0) {
  assert.equal(result.status, expected, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function resourceTypes(bytes) {
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString('ascii', pe, pe + 4), 'PE\0\0');
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const magic = bytes.readUInt16LE(optional);
  assert.ok(magic === 0x10b || magic === 0x20b);
  const dataDirectory = optional + (magic === 0x10b ? 96 : 112);
  const resourceRva = bytes.readUInt32LE(dataDirectory + 16);
  assert.ok(resourceRva > 0, 'the host must retain its application icon');
  const sections = optional + bytes.readUInt16LE(pe + 20);
  let resourceOffset;
  for (let i = 0; i < sectionCount; ++i) {
    const section = sections + i * 40;
    const rva = bytes.readUInt32LE(section + 12);
    const span = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16));
    if (resourceRva >= rva && resourceRva < rva + span)
      resourceOffset = bytes.readUInt32LE(section + 20) + resourceRva - rva;
  }
  assert.notEqual(resourceOffset, undefined);
  const count = bytes.readUInt16LE(resourceOffset + 12) + bytes.readUInt16LE(resourceOffset + 14);
  return Array.from({ length: count }, (_, i) => bytes.readUInt32LE(resourceOffset + 16 + i * 8));
}

nativeTest('multi-file GUI host uses only sidecars beside its relocated EXE without creating files', async () => {
  await fixture(async ({ directory, folder, invoke }) => {
    const before = await snapshot(directory);
    for (const name of sidecars) assert.ok(before[`relocated package/${name}`], name);
    const value = report(invoke('--self-check', '--no-disk-write'));
    assert.equal(value.success, true);
    assert.deepEqual(value.failures, []);
    assert.deepEqual(value.scope, { discoveryScan: false, launch: false, connect: false, write: false });
    assert.equal(value.checks.find((item) => item.id === 'external-resources')?.status, 'passed');
    for (const name of sidecars.slice(0, 4)) {
      const check = value.checks.find((item) => item.id === basename(name));
      assert.equal(check?.status, 'passed', name);
      assert.match(check.detail, /external|sidecar/i);
    }
    assert.deepEqual(await snapshot(directory), before);
    assert.ok((await readdir(folder)).includes('winmm-proxy.dll'));
  });
});

nativeTest('multi-file GUI host reports external resources and has no JS or proxy RCDATA', async () => {
  await fixture(async ({ host, invoke }) => {
    const capabilities = report(invoke('--capabilities', '--no-disk-write'));
    assert.equal(capabilities.embeddedResources, false);
    assert.equal(capabilities.externalResources, true);
    assert.equal(capabilities.embeddedResourceCount, 0);
    assert.equal(capabilities.resourceCount, 5);
    assert.equal(capabilities.embeddedProxy, false);
    const bytes = await readFile(host);
    const pe = bytes.readUInt32LE(0x3c);
    assert.equal(bytes.readUInt16LE(pe + 24 + 68), 2, 'the primary multi-file entry must use the GUI subsystem');
    const types = resourceTypes(bytes);
    assert.ok(types.includes(3), 'individual icon resources are retained');
    assert.ok(types.includes(14), 'icon group resources are retained');
    assert.equal(types.includes(10), false, 'no RCDATA means no embedded JS/CSS or proxy DLL fallback');
  });
});

nativeTest('each missing multi-file sidecar fails explicitly even when the working directory contains a complete copy', async () => {
  await fixture(async ({ folder, working, invoke }) => {
    for (const name of sidecars) {
      await mkdir(dirname(join(working, name)), { recursive: true });
      await copyFile(join(folder, name), join(working, name));
    }
    for (const name of sidecars) {
      const bytes = await readFile(join(folder, name));
      await rm(join(folder, name));
      try {
        const value = report(invoke('--self-check', '--no-disk-write'), 1);
        assert.equal(value.success, false, name);
        assert.ok(value.failures.includes('external-resources'), name);
        const capabilities = invoke('--capabilities', '--no-disk-write');
        assert.equal(capabilities.status, 2, `${name}: ${capabilities.stdout}\n${capabilities.stderr}`);
        assert.match(capabilities.stdout + capabilities.stderr, /multi-file resource/i);
        assert.ok((capabilities.stdout + capabilities.stderr).includes(basename(name)), name);
        assert.equal((capabilities.stdout + capabilities.stderr).includes(folder), false, 'resource failures omit local paths');
      } finally {
        await writeFile(join(folder, name), bytes);
      }
    }
  });
});

nativeTest('multi-file host rejects empty sidecars and never falls back to the original package', async () => {
  await fixture(async ({ folder, invoke }) => {
    await writeFile(join(folder, sidecars[0]), '');
    const value = report(invoke('--self-check', '--no-disk-write'), 1);
    assert.equal(value.success, false);
    assert.ok(value.failures.includes('external-resources'));
    const result = invoke('--capabilities', '--no-disk-write');
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /empty|size limit/i);
  });
});

test('validated multi-file resources remain available after fixture sidecar deletion and returned copies are independent', {
  skip: process.platform !== 'win32' || !executable || !driver
}, async () => {
  await fixture(async ({ folder, working }) => {
    const relocatedDriver = join(folder, 'multi-assets-tests.exe');
    await copyFile(driver, relocatedDriver);
    const child = spawn(relocatedDriver, [], { cwd: working, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', resume;
    const ready = new Promise((done) => { resume = done; });
    child.stdout.on('data', (bytes) => {
      stdout += bytes.toString('utf8');
      if (stdout.includes('MULTI ASSET CACHE READY\n')) resume(true);
    });
    child.stderr.on('data', (bytes) => { stderr += bytes.toString('utf8'); });
    const complete = new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => { resume(false); done({ status, signal }); });
    });
    const timeout = setTimeout(() => { resume(false); child.kill(); }, 15000);
    try {
      assert.equal(await ready, true, stdout + stderr);
      for (const name of sidecars) await rm(join(folder, name));
      child.stdin.end('1');
      const result = await complete;
      assert.equal(result.status, 0, stdout + stderr);
      assert.equal(result.signal, null);
      assert.equal(stderr, '');
      assert.match(stdout, /MULTI ASSET CACHE TESTS PASS/);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
      await complete;
    }
  });
});
