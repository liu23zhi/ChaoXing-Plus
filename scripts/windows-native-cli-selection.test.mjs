import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const driver = process.env.CX_NATIVE_CLI_SELECTION_EXE;

test('compiled native CLI selection validates the entire input and resolves manual Unicode paths', {
  skip: !driver
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cx-native-cli-中文 空格-'));
  try {
    const installation = join(directory, '安装 中文 空格');
    await mkdir(installation);
    // Read-only PE inspection needs valid headers; this fixture is never executed.
    const pe = Buffer.alloc(512);
    pe.writeUInt16LE(0x5a4d, 0);
    pe.writeUInt32LE(0x80, 0x3c);
    pe.writeUInt32LE(0x4550, 0x80);
    pe.writeUInt16LE(0x014c, 0x84);
    pe.writeUInt16LE(0xe0, 0x94);
    pe.writeUInt16LE(0x10b, 0x98);
    pe.writeUInt16LE(6, 0xc8);
    pe.writeUInt16LE(1, 0xca);
    await writeFile(join(installation, 'CXExam.exe'), pe);
    await mkdir(join(directory, '2026 Exam'));
    await writeFile(join(directory, '2026 Exam', 'CXExam.exe'), pe);
    const result = spawnSync(driver, [installation], {
      cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true
    });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Index\tArchitecture\tVersion\tPath/u);
    assert.ok(result.stdout.includes('1\tx86\t4.1.4.25512\tC:\\First scanned\\CXExam.exe [recommended]'));
    assert.ok(result.stdout.includes('2\tx64\t4.3.0.4\tD:\\Second scanned\\CXExam.exe'));
    assert.doesNotMatch(result.stdout, /^FAIL /mu);
    assert.match(result.stdout, /^NATIVE CLI SELECTION TESTS PASS\r?$/mu);
    for (const regression of [
      'CLI rejects a numeric prefix followed by junk',
      'CLI rejects trailing text after an index',
      'CLI treats a successful zero-byte read as EOF instead of Enter',
      'CLI lower-case q cancels with exit code three',
      'CLI resolves a manual installation directory',
      'CLI accepts a digit-leading relative executable path',
      'CLI trims whitespace and matching quotes around a Unicode path'
    ]) {
      assert.ok(result.stdout.includes(`PASS ${regression}`), `missing compiled regression: ${regression}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
