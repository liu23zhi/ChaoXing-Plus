import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const helper = process.env.CX_NATIVE_CONSOLE_HELPER_EXE;
const host = process.env.CX_NATIVE_MULTI_HOST_EXE;
const fixture = process.env.CX_NATIVE_CONSOLE_HELPER_FIXTURE_EXE;
const enabled = process.platform === 'win32' && Boolean(helper && host);
const run = (file, args, options = {}) => spawnSync(file, args, {
  encoding: 'utf8', timeout: 15_000, windowsHide: true, ...options
});

async function withPair(child, action) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-console-helper-'));
  try {
    const binaries = path.join(directory, '\u4e2d\u6587 helper directory');
    const working = path.join(directory, 'separate working directory');
    await fs.mkdir(binaries);
    await fs.mkdir(working);
    const launcher = path.join(binaries, 'chaoxing_plus.com');
    const executable = path.join(binaries, 'chaoxing_plus.exe');
    await fs.copyFile(helper, launcher);
    if (child) await fs.copyFile(child, executable);
    await action({ directory, binaries, working, launcher, executable });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function assertSuccess(result) {
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function normalizeLines(value) {
  return value.replace(/\r\n/gu, '\n');
}

test('native console helper is a Console PE beside a GUI host', { skip: !enabled }, async () => {
  for (const [file, expected] of [[helper, 3], [host, 2]]) {
    const image = await fs.readFile(file);
    const pe = image.readUInt32LE(0x3c);
    assert.equal(image.toString('ascii', pe, pe + 4), 'PE\0\0');
    assert.equal(image.readUInt16LE(pe + 24 + 68), expected, file);
  }
});

test('native console helper forwards version, full Unicode help and unknown-option exit code', {
  skip: !enabled
}, async () => {
  await withPair(host, ({ launcher, executable, working }) => {
    for (const args of [['--version'], ['--help'], ['--not-an-option=']]) {
      const direct = run(executable, args, { cwd: working });
      const forwarded = run(launcher, args, { cwd: working });
      assert.equal(forwarded.error, undefined, String(forwarded.error));
      assert.equal(forwarded.status, args[0] === '--not-an-option=' ? 2 : 0, forwarded.stderr);
      assert.equal(forwarded.status, direct.status);
      assert.equal(forwarded.stdout, direct.stdout, args.join(' '));
      assert.equal(forwarded.stderr, direct.stderr, args.join(' '));
      if (args[0] === '--version') assert.equal(forwarded.stdout.trim(), '6.2.0');
      if (args[0] === '--help') {
        assert.match(forwarded.stdout, /\u8d85\u661f\u5b66\u4e60\u52a9\u624b Windows/u);
        assert.match(forwarded.stdout, /--silent-scenario/u);
      }
    }
  });
});

test('native console helper reports a missing sibling without searching the working directory', {
  skip: !enabled
}, async () => {
  await withPair(null, async ({ launcher, working }) => {
    await fs.copyFile(host, path.join(working, 'chaoxing_plus.exe'));
    const result = run(launcher, ['--version'], { cwd: working });
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /chaoxing_plus\.exe/u);
  });
});

test('native console helper preserves the raw tail, working directory and all redirected standard streams', {
  skip: !enabled || !fixture
}, async () => {
  await withPair(fixture, ({ launcher, executable, working }) => {
    const rawTail = '  ""\t--json={"text":"\u4e2d\u6587 value"} "embedded\\\"quote" "C:\\tail\\\\" &|<>^%$();';
    const input = Buffer.from('stdin \u4e2d\u6587\0bytes\r\n', 'utf8');
    const result = run(launcher, [rawTail], {
      cwd: working,
      argv0: `"${launcher}"`,
      windowsVerbatimArguments: true,
      encoding: null,
      input
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 37, result.stderr?.toString('utf8'));
    const prefix = Buffer.from(`COMMAND_LINE="${executable}" ${rawTail}\nCWD=${working}\nINPUT=`, 'utf8');
    assert.deepEqual(result.stdout, Buffer.concat([prefix, input]));
    assert.equal(result.stderr.toString('utf8'), 'stderr \u4e2d\u6587\n');
  });
});

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  for (const invocation of ['.\\chaoxing_plus', '.\\chaoxing_plus.com']) {
    test(`${shell} waits for ${invocation} before printing the following marker`, {
      skip: !enabled
    }, async () => {
      await withPair(host, ({ launcher, binaries }) => {
        const expected = run(launcher, ['--help'], { cwd: binaries });
        assertSuccess(expected);
        const marker = 'CX_CONSOLE_HELPER_AFTER_HELP';
        const source = [
          '$ErrorActionPreference = "Stop"',
          '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
          `$resolved = (Get-Command '${invocation}' -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source`,
          'if ([IO.Path]::GetExtension($resolved) -ne ".com") { throw "extensionless invocation did not select .com" }',
          `& '${invocation}' --help`,
          '$childExit = $LASTEXITCODE',
          `[Console]::WriteLine('${marker}')`,
          'exit $childExit'
        ].join('\n');
        const result = run(shell, [
          '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')
        ], {
          cwd: binaries,
          env: { ...process.env, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
          timeout: 60_000
        });
        assertSuccess(result);
        const output = normalizeLines(result.stdout);
        assert.equal(output, `${normalizeLines(expected.stdout)}${marker}\n`, `${shell}: ${result.stderr}`);
      });
    });
  }
}
