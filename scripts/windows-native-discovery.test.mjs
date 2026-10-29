import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driverCandidates = [
  process.env.CX_DISCOVERY_TEST_DRIVER,
  path.join(repositoryRoot, '.tmp-native-discovery', 'discovery-testdriver.exe'),
  path.join(repositoryRoot, 'windows', 'native-source', 'discovery-testdriver.exe')
].filter(Boolean);
let driver = '';
for (const candidate of driverCandidates) {
  try {
    await fs.access(candidate);
    driver = candidate;
    break;
  } catch {
    // The native test driver is built by the Windows native build step.
  }
}

const nativeTest = process.platform === 'win32' && driver;

async function runScan(mode, commonRoot, fixedRoot, extra = []) {
  const { stdout, stderr } = await execFileAsync(driver, ['scan', mode, commonRoot, fixedRoot, ...extra], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  assert.equal(stderr, '', `native discovery emitted stderr: ${stderr}`);
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  const header = lines.find((line) => line.startsWith('RESULT\t'));
  assert.ok(header, `missing RESULT line in ${stdout}`);
  const [, count, selected, commonScanned, fallbackScanned, stoppedOnX86, truncated] = header.split('\t');
  const candidates = lines.filter((line) => line.startsWith('CAND\t')).map((line) => {
    const [, machine, candidatePath] = line.split('\t');
    return { machine: Number.parseInt(machine, 16), path: candidatePath };
  });
  return {
    count: Number(count),
    selected: Number(selected),
    commonScanned: commonScanned === '1',
    fallbackScanned: fallbackScanned === '1',
    stoppedOnX86: stoppedOnX86 === '1',
    truncated: truncated === '1',
    candidates
  };
}

async function copyFixture(source, target) {
  await fs.copyFile(source, target);
}

test('native discovery common scan stops at one direct child and prefers x86', { skip: !nativeTest }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-native-common-'));
  const common = path.join(root, 'common');
  const fixed = path.join(root, 'fixed');
  const child = path.join(common, 'Release');
  const deep = path.join(child, 'Nested');
  await fs.mkdir(deep, { recursive: true });
  const x64 = path.join(process.cwd(), 'node_modules', '@typescript', 'typescript-win32-x64', 'lib', 'tsc.exe');
  await copyFixture(x64, path.join(common, 'CXExam.exe'));
  await copyFixture(driver, path.join(child, 'CXExam.exe'));
  await copyFixture(driver, path.join(deep, 'CXExam.exe'));
  try {
    const result = await runScan('fallback-all', common, fixed);
    assert.equal(result.commonScanned, true);
    assert.equal(result.fallbackScanned, false);
    assert.equal(result.count, 2);
    assert.equal(result.candidates[0].machine, 0x014c);
    assert.equal(result.candidates.some((candidate) => candidate.path.endsWith(`${path.sep}Nested${path.sep}CXExam.exe`)), false);
    assert.equal(result.selected, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  t.diagnostic(`driver=${driver}`);
});

test('native discovery fallback stops when first x86 is encountered and keeps first x64 backup', { skip: !nativeTest }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-native-fallback-'));
  const common = path.join(root, 'common');
  const fixed = path.join(root, 'fixed');
  const x64Dir = path.join(fixed, 'A64', 'Nested');
  const x86Dir = path.join(fixed, 'B32', 'Nested');
  await fs.mkdir(common, { recursive: true });
  await fs.mkdir(x64Dir, { recursive: true });
  await fs.mkdir(x86Dir, { recursive: true });
  const x64 = path.join(process.cwd(), 'node_modules', '@typescript', 'typescript-win32-x64', 'lib', 'tsc.exe');
  await copyFixture(x64, path.join(x64Dir, 'CXExam.exe'));
  await copyFixture(driver, path.join(x86Dir, 'CXExam.exe'));
  try {
    const result = await runScan('fallback-all', common, fixed);
    assert.equal(result.commonScanned, true);
    assert.equal(result.fallbackScanned, true);
    assert.equal(result.stoppedOnX86, true);
    assert.deepEqual(result.candidates.map((candidate) => candidate.machine), [0x8664, 0x014c]);
    assert.equal(result.selected, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native discovery all mode ignores common candidates and recursively scans fixed root', { skip: !nativeTest }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-native-all-'));
  const common = path.join(root, 'common');
  const fixed = path.join(root, 'fixed', 'OnlyHere');
  await fs.mkdir(common, { recursive: true });
  await fs.mkdir(fixed, { recursive: true });
  const x64 = path.join(process.cwd(), 'node_modules', '@typescript', 'typescript-win32-x64', 'lib', 'tsc.exe');
  await copyFixture(driver, path.join(common, 'CXExam.exe'));
  await copyFixture(x64, path.join(fixed, 'CXExam.exe'));
  try {
    const result = await runScan('all', common, path.dirname(fixed));
    assert.equal(result.commonScanned, false);
    assert.equal(result.fallbackScanned, true);
    assert.equal(result.count, 1);
    assert.equal(result.candidates[0].machine, 0x8664);
    assert.equal(result.candidates[0].path.endsWith(`${path.sep}fixed${path.sep}OnlyHere${path.sep}CXExam.exe`), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native discovery rejects x64 explicit client only when the OS is forced to x86', { skip: !nativeTest }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-native-arch-'));
  const x64 = path.join(process.cwd(), 'node_modules', '@typescript', 'typescript-win32-x64', 'lib', 'tsc.exe');
  const target = path.join(root, 'CXExam.exe');
  await copyFixture(x64, target);
  try {
    const wow64Result = await runScan('common', root, root, ['--client', target]);
    assert.equal(wow64Result.count, 1, 'an x86 host process on x64 Windows must accept an x64 CXExam');
    assert.equal(wow64Result.candidates[0].machine, 0x8664);
    await assert.rejects(runScan('common', root, root, ['--client', target, '--force-x86-os']), /ERROR/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native discovery common x64 candidate prevents recursive fallback', { skip: !nativeTest }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-native-common64-'));
  const common = path.join(root, 'common');
  const fixed = path.join(root, 'fixed');
  await fs.mkdir(common, { recursive: true });
  await fs.mkdir(path.join(fixed, 'deep', 'nested'), { recursive: true });
  await copyFixture(path.join(repositoryRoot, 'node_modules', '@typescript', 'typescript-win32-x64', 'lib', 'tsc.exe'), path.join(common, 'CXExam.exe'));
  await copyFixture(driver, path.join(fixed, 'deep', 'nested', 'CXExam.exe'));
  try {
    const result = await runScan('fallback-all', common, fixed);
    assert.equal(result.fallbackScanned, false);
    assert.equal(result.count, 1);
    assert.equal(result.candidates[0].machine, 0x8664);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native discovery complete fallback enumeration retains clients after the first x86', { skip: !nativeTest }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-native-enumerate-'));
  const common = path.join(root, 'common');
  const fixed = path.join(root, 'fixed');
  await fs.mkdir(common, { recursive: true });
  for (const name of ['a', 'b', 'c']) {
    const directory = path.join(fixed, name, 'nested');
    await fs.mkdir(directory, { recursive: true });
    await copyFixture(driver, path.join(directory, 'CXExam.exe'));
  }
  try {
    const result = await runScan('fallback-all', common, fixed, ['--enumerate-all']);
    assert.equal(result.count, 3);
    assert.equal(result.stoppedOnX86, false);
    const forcedAll = await runScan('all', common, fixed);
    assert.equal(forcedAll.count, 3);
    assert.equal(forcedAll.stoppedOnX86, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native discovery fallback uses the first encountered x64 when no x86 exists', { skip: !nativeTest }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-native-fallback64-'));
  const common = path.join(root, 'common');
  const fixed = path.join(root, 'fixed');
  await fs.mkdir(common, { recursive: true });
  const source = path.join(repositoryRoot, 'node_modules', '@typescript', 'typescript-win32-x64', 'lib', 'tsc.exe');
  for (const name of ['b', 'a']) {
    const directory = path.join(fixed, name, 'nested');
    await fs.mkdir(directory, { recursive: true });
    await copyFixture(source, path.join(directory, 'CXExam.exe'));
  }
  try {
    const result = await runScan('fallback-all', common, fixed);
    assert.equal(result.fallbackScanned, true);
    assert.equal(result.stoppedOnX86, false);
    assert.equal(result.count, 2);
    assert.equal(result.selected, 0);
    assert.equal(result.candidates[0].path, path.join(fixed, 'a', 'nested', 'CXExam.exe'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native discovery empty roots return no candidate without scanning other disks', { skip: !nativeTest }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-native-empty-'));
  try {
    const result = await runScan('fallback-all', root, root);
    assert.equal(result.count, 0);
    assert.equal(result.commonScanned, true);
    assert.equal(result.fallbackScanned, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native discovery skips directory junctions and excluded system directories', { skip: !nativeTest }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-native-links-'));
  const common = path.join(root, 'common');
  const external = path.join(root, 'external');
  await fs.mkdir(common, { recursive: true });
  await fs.mkdir(external, { recursive: true });
  await fs.mkdir(path.join(common, 'Windows'), { recursive: true });
  await copyFixture(driver, path.join(external, 'CXExam.exe'));
  await copyFixture(driver, path.join(common, 'Windows', 'CXExam.exe'));
  await fs.symlink(external, path.join(common, 'Linked'), 'junction');
  try {
    const result = await runScan('all', common, common);
    assert.equal(result.count, 0);
    const linkedRoot = await runScan('common', path.join(common, 'Linked'), path.join(root, 'missing'));
    assert.equal(linkedRoot.count, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

