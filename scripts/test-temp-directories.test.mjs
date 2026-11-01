import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const helperUrl = new URL('./test-helpers/temp-directory.mjs', import.meta.url).href;
const prelude = `
  import test, { after } from 'node:test';
  import assert from 'node:assert/strict';
  import { writeFileSync, existsSync } from 'node:fs';
  import { join } from 'node:path';
  import { createTestDirectory } from ${JSON.stringify(helperUrl)};
  const directory = createTestDirectory('lifecycle-probe');
  writeFileSync(join(directory, 'fixture.txt'), 'temporary');
  console.log('DIRECTORY:' + JSON.stringify(directory));
`;

function directoryFrom(stdout) {
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith('DIRECTORY:'));
  assert.ok(line, stdout);
  return JSON.parse(line.slice('DIRECTORY:'.length));
}

async function runFixture(t, code, options = {}) {
  let result;
  try {
    result = { ...(await execFileAsync(process.execPath, ['--input-type=module', '--eval', prelude + code], {
      cwd: root, timeout: 15000, env: { ...process.env, CX_TEST_KEEP_TEMP: '0' }, ...options
    })), code: 0 };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    result = error;
  }
  const directory = directoryFrom(result.stdout);
  assert.equal(dirname(directory), resolve(root));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return result;
}

for (const [name, code, exitCode] of [
  ['successful tests', `test('fixture', () => assert.ok(existsSync(directory)));`, 0],
  ['failed tests', `test('fixture', () => assert.fail('expected fixture failure'));`, 1],
  ['top-level exceptions', `throw new Error('expected fixture exception');`, null],
  ['explicit process exit', `process.exit(7);`, 7]
]) {
  test(`temporary directories are removed after ${name}`, async (t) => {
    const result = await runFixture(t, code);
    if (exitCode === null) {
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /expected fixture exception/);
    } else {
      assert.equal(result.code, exitCode, result.stderr || result.stdout);
    }
    await assert.rejects(access(directoryFrom(result.stdout)), { code: 'ENOENT' });
  });
}

test('temporary output stays inside the repository when the caller changes cwd', async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), 'cx-test-cwd-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = await runFixture(t, `test('fixture', () => {});`, { cwd });
  assert.equal(result.code, 0, result.stderr);
  const directory = directoryFrom(result.stdout);
  assert.equal(dirname(directory), resolve(root));
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('multiple directories share one exit handler and invalid labels cannot escape the repository', async (t) => {
  const result = await runFixture(t, `
    const listeners = process.listenerCount('exit');
    const directories = Array.from({ length: 20 }, () => createTestDirectory('lifecycle-probe'));
    test('fixture', () => {
      assert.equal(new Set(directories).size, 20);
      assert.equal(process.listenerCount('exit'), listeners);
      for (const label of ['', '..', '../outside', 'nested/path', 'nested' + String.fromCharCode(92) + 'path']) {
        assert.throws(() => createTestDirectory(label), /label/i);
      }
    });
    after(() => assert.ok(directories.every((path) => !existsSync(path))));
  `);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /MaxListenersExceededWarning/);
});

test('temporary diagnostics are retained only when explicitly requested', async (t) => {
  const result = await runFixture(t, `test('fixture', () => {});`, {
    env: { ...process.env, CX_TEST_KEEP_TEMP: '1' }
  });
  assert.equal(result.code, 0, result.stderr);
  const directory = directoryFrom(result.stdout);
  await access(resolve(directory, 'fixture.txt'));
  assert.match(result.stderr, /Preserving test directory/);
});

test('one process finishing cannot delete another process temporary output', { timeout: 30000 }, async (t) => {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', prelude + `
    for await (const chunk of process.stdin) break;
    test('fixture', () => assert.ok(existsSync(directory)));
  `], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], signal: t.signal,
    env: { ...process.env, CX_TEST_KEEP_TEMP: '0' } });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  });
  const output = await new Promise((resolve, reject) => {
    let buffer = '';
    child.once('error', reject);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) resolve(buffer);
    });
    child.stdout.once('end', () => resolve(buffer));
  });
  const directory = directoryFrom(output);
  assert.equal(dirname(directory), resolve(root));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const other = await runFixture(t, `test('fixture', () => assert.ok(existsSync(directory)));`);
  assert.equal(other.code, 0, other.stderr);
  assert.notEqual(directory, directoryFrom(other.stdout));
  await access(directory);
  await assert.rejects(access(directoryFrom(other.stdout)), { code: 'ENOENT' });
  child.stdin.end('finish');
  assert.equal((await exited)[0], 0);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});
