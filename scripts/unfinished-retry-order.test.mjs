import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

const execFileAsync = promisify(execFile);
const outDir = createTestDirectory('retry-order');
const sourcePath = resolveTestPath('src', 'core', 'worker', 'unfinished-retry.ts');
const modulePath = resolve(outDir, 'unfinished-retry.cjs');
const tscCliPath = resolveTestPath('scripts', 'test-helpers', 'tsc-compat.mjs');

async function loadModule() {
  await mkdir(outDir, { recursive: true });
  await execFileAsync(process.execPath, [
    tscCliPath, sourcePath, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2022', '--moduleResolution', 'node', '--skipLibCheck'
  ]);
  await rename(resolve(outDir, 'unfinished-retry.js'), modulePath);
  const require = createRequire(import.meta.url);
  delete require.cache[modulePath];
  return require(modulePath);
}

test('unfinished results retry in source order while all pages advance', async () => {
  const { retryUnfinishedResultsInOrder } = await loadModule();
  const results = [
    { question: 'Q1', finish: false },
    { question: 'Q2', finish: true },
    { question: 'Q3', finish: false }
  ];
  const events = [];

  const retried = await retryUnfinishedResultsInOrder(
    results,
    async (index, result) => {
      events.push(`retry:${index}`);
      return { ...result, finish: true };
    },
    async (index) => { events.push(`advance:${index}`); }
  );

  assert.deepEqual(events, ['retry:0', 'advance:0', 'advance:1', 'retry:2']);
  assert.deepEqual(retried.map(({ finish }) => finish), [true, true, true]);
  assert.deepEqual(results.map(({ finish }) => finish), [false, true, false]);
});

test('already finished and empty result sets do not invoke retries', async () => {
  const { retryUnfinishedResultsInOrder } = await loadModule();
  let calls = 0;

  assert.deepEqual(await retryUnfinishedResultsInOrder([{ finish: true }], async () => { calls++; return { finish: true }; }), [{ finish: true }]);
  assert.deepEqual(await retryUnfinishedResultsInOrder([], async () => { calls++; return { finish: true }; }), []);
  assert.equal(calls, 0);
});

test('unfinished retries stop before advancing while paused and resume in order when allowed', async () => {
  const { retryUnfinishedResultsInOrder } = await loadModule();
  const results = [
    { question: 'Q1', finish: false },
    { question: 'Q2', finish: false }
  ];
  const events = [];
  let shouldContinue = true;

  const pausedResults = await retryUnfinishedResultsInOrder(
    results,
    async (index, result) => {
      events.push(`retry:${index}`);
      shouldContinue = false;
      return { ...result, finish: true };
    },
    async (index) => { events.push(`advance:${index}`); },
    (result) => result.finish,
    () => shouldContinue
  );

  assert.deepEqual(events, ['retry:0']);
  assert.deepEqual(pausedResults.map(({ finish }) => finish), [true, false]);

  shouldContinue = true;
  const resumedResults = await retryUnfinishedResultsInOrder(
    pausedResults,
    async (index, result) => {
      events.push(`resume:${index}`);
      return { ...result, finish: true };
    },
    async (index) => { events.push(`advance-resume:${index}`); },
    (result) => result.finish,
    () => shouldContinue
  );

  assert.deepEqual(events, ['retry:0', 'advance-resume:0', 'resume:1']);
  assert.deepEqual(resumedResults.map(({ finish }) => finish), [true, true]);
});
