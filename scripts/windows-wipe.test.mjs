import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWipeController, WipeAbortedError } from '../windows/node-source/wipe.mjs';

async function withTempDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-wipe-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('only unlinks explicitly registered files and never recursively deletes a directory', async () => {
  await withTempDirectory(async (directory) => {
    const ownedFile = path.join(directory, 'owned.log');
    const nestedDirectory = path.join(directory, 'nested');
    const nestedFile = path.join(nestedDirectory, 'keep.txt');
    await fs.writeFile(ownedFile, 'owned');
    await fs.mkdir(nestedDirectory);
    await fs.writeFile(nestedFile, 'keep');

    const controller = createWipeController({
      ownedFiles: [ownedFile, nestedDirectory],
      failurePolicy: 'ignore',
      runtimeRetry: false
    });
    const result = await controller.start();

    assert.equal(result.deleted.includes(path.resolve(ownedFile)), true);
    assert.equal(result.failures.some(({ path: failedPath }) => failedPath === path.resolve(nestedDirectory)), true);
    await assert.rejects(fs.access(ownedFile), { code: 'ENOENT' });
    assert.equal(await fs.readFile(nestedFile, 'utf8'), 'keep');
    await controller.close();
  });
});

test('rejects CXExam.exe as a registered wipe target', () => {
  for (const name of [
    'CXExam.exe', 'CXExam.exe.', 'CXExam.exe ', 'CXExam.exe::$DATA',
    'CXExam~1.exe', 'CXExam~12.EXE.'
  ]) {
    assert.throws(
      () => createWipeController({ ownedFiles: [path.join(os.tmpdir(), name)] }),
      /CXExam/i
    );
  }
});

test('rejects Windows CXExam aliases with trailing dots or spaces', () => {
  const candidates = [
    path.join(os.tmpdir(), 'CXExam.exe.'),
    path.join(os.tmpdir(), 'CXExam.exe '),
    path.join(os.tmpdir(), 'cxexam~1.exe.'),
    path.join(os.tmpdir(), 'CXExam.exe::$DATA')
  ];
  for (const candidate of candidates) {
    assert.throws(() => createWipeController({ ownedFiles: [candidate] }), /禁止登记 CXExam/u);
  }
});

test('retry design caps startup attempts at the configured total', async () => {
  let attempts = 0;
  let delays = 0;
  const controller = createWipeController({
    ownedFiles: [path.join(os.tmpdir(), 'registered-host-file.log')],
    failurePolicy: 'retry',
    retries: 2,
    retryDelayMs: 50,
    runtimeRetry: false
  }, {
    unlink: async () => {
      attempts += 1;
      throw new Error('locked');
    },
    delay: async () => { delays += 1; }
  });

  const result = await controller.start();

  assert.equal(attempts, 2);
  assert.equal(delays, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.pending.length, 1);
  await controller.close();
});

test('default cleanup design continues after five failures and schedules runtime retry', async () => {
  let attempts = 0;
  const delays = [];
  const timers = [];
  const controller = createWipeController({
    ownedFiles: [path.join(os.tmpdir(), 'registered-default-host-file.log')]
  }, {
    unlink: async () => { attempts += 1; throw new Error('locked'); },
    delay: async (milliseconds) => { delays.push(milliseconds); },
    setTimeout(callback, delayMs) {
      const timer = { callback, delayMs, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cancelled = true; }
  });
  const result = await controller.start();
  assert.equal(attempts, 5);
  assert.deepEqual(delays, [200, 200, 200, 200]);
  assert.equal(result.status, 'retrying');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 30_000);
  await controller.close();
  assert.equal(timers[0].cancelled, true);
});

test('close waits for an in-flight runtime retry before returning', async () => {
  let attempts = 0;
  let notifyRuntimeAttempt;
  const runtimeAttempt = new Promise((resolve) => { notifyRuntimeAttempt = resolve; });
  let finishRuntimeAttempt;
  const timers = [];
  const controller = createWipeController({
    ownedFiles: [path.join(os.tmpdir(), 'registered-runtime-close-file.log')],
    failurePolicy: 'retry',
    retries: 1,
    retryDelayMs: 50,
    runtimeRetry: true,
    runtimeIntervalMs: 5
  }, {
    unlink: async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('locked');
      notifyRuntimeAttempt();
      await new Promise((resolve) => { finishRuntimeAttempt = resolve; });
    },
    setTimeout(callback, delayMs) {
      const timer = { callback, delayMs, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cancelled = true; }
  });

  assert.equal((await controller.start()).status, 'retrying');
  assert.equal(attempts, 1);
  assert.equal(timers.length, 1);
  timers.shift().callback();
  await runtimeAttempt;
  let closeFinished = false;
  const closing = controller.close().then(() => { closeFinished = true; });
  assert.equal(closeFinished, false);
  finishRuntimeAttempt();
  await closing;
  assert.equal(closeFinished, true);
  assert.equal(attempts, 2);
});

test('close waits for a background retry already in flight', async () => {
  let attempts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const timers = [];
  const controller = createWipeController({
    ownedFiles: [path.join(os.tmpdir(), 'registered-background-close-file.log')],
    failurePolicy: 'background',
    retries: 1,
    retryDelayMs: 50
  }, {
    unlink: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('locked');
      await gate;
    },
    setTimeout(callback, delayMs) {
      const timer = { callback, delayMs, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cancelled = true; }
  });

  assert.equal((await controller.start()).status, 'retrying');
  timers.shift().callback();
  await new Promise((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = controller.close().then(() => { closed = true; });
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
  assert.equal(attempts, 2);
});

test('background retries until success regardless of retry limits and runtimeRetry', async () => {
  let attempts = 0;
  const phases = [];
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  const controller = createWipeController({
    ownedFiles: [path.join(os.tmpdir(), 'registered-background-file.log')],
    failurePolicy: 'background',
    retries: 1,
    retryDelayMs: 50,
    runtimeRetry: false,
    runtimeIntervalMs: 5000,
    onEvent(event) {
      if (event.phase) phases.push(event.phase);
      if (event.type === 'complete') resolveFinished(event.summary);
    }
  }, {
    unlink: async () => {
      attempts += 1;
      if (attempts < 5) throw new Error('locked');
    }
  });

  const initial = await controller.start();
  assert.equal(initial.status, 'retrying');
  assert.equal(attempts, 1);

  let timeout;
  const final = await Promise.race([
    finished,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('runtime retry timed out')), 1000); })
  ]).finally(() => clearTimeout(timeout));
  assert.equal(final.status, 'complete');
  assert.equal(attempts, 5);
  assert.deepEqual(phases, ['startup', 'background', 'background', 'background', 'background']);
  await controller.close();
});

test('background retries continue until close when every unlink attempt fails', async () => {
  let attempts = 0;
  let resolveRepeatedFailure;
  const repeatedFailure = new Promise((resolve) => { resolveRepeatedFailure = resolve; });
  const controller = createWipeController({
    ownedFiles: [path.join(os.tmpdir(), 'registered-background-failed-file.log')],
    failurePolicy: 'background',
    retries: 1,
    retryDelayMs: 50,
    runtimeRetry: false,
    onEvent(event) {
      if (event.type === 'failure' && event.phase === 'background' && event.attempt >= 5) {
        resolveRepeatedFailure();
      }
    }
  }, {
    unlink: async () => {
      attempts += 1;
      throw new Error('locked');
    }
  });

  const initial = await controller.start();
  assert.equal(initial.status, 'retrying');
  assert.equal(attempts, 1);
  let timeout;
  await Promise.race([
    repeatedFailure,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('background retry timed out')), 1000); })
  ]).finally(() => clearTimeout(timeout));
  const attemptsAtClose = attempts;
  assert.ok(attemptsAtClose >= 5);
  await controller.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(attempts, attemptsAtClose);
  assert.equal(controller.getSummary().status, 'closed');
});

test('background success emits complete after a finite retry', async () => {
  let attempts = 0;
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  const controller = createWipeController({
    ownedFiles: [path.join(os.tmpdir(), 'registered-background-success-file.log')],
    failurePolicy: 'background',
    retries: 2,
    retryDelayMs: 50,
    runtimeRetry: false,
    onEvent(event) {
      if (event.type === 'complete') resolveFinished(event.summary);
    }
  }, {
    unlink: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('locked');
    }
  });

  const initial = await controller.start();
  assert.equal(initial.status, 'retrying');
  let timeout;
  const result = await Promise.race([
    finished,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('background retry timed out')), 1000); })
  ]).finally(() => clearTimeout(timeout));
  assert.equal(attempts, 2);
  assert.equal(result.status, 'complete');
  await controller.close();
});

test('ignore records a failure without retrying, while abort rejects with the failure summary', async () => {
  const ignoredTarget = path.join(os.tmpdir(), 'registered-ignore-file.log');
  let ignoredAttempts = 0;
  const ignored = createWipeController({
    ownedFiles: [ignoredTarget],
    failurePolicy: 'ignore',
    retries: 5,
    runtimeRetry: true,
    runtimeIntervalMs: 5
  }, {
    unlink: async () => {
      ignoredAttempts += 1;
      throw new Error('locked');
    }
  });

  const ignoredResult = await ignored.start();
  assert.equal(ignoredResult.status, 'ignored');
  assert.equal(ignoredAttempts, 1);
  await ignored.close();

  const aborted = createWipeController({
    ownedFiles: [path.join(os.tmpdir(), 'registered-abort-file.log')],
    failurePolicy: 'abort',
    retries: 5,
    runtimeRetry: false
  }, { unlink: async () => { throw new Error('locked'); } });

  await assert.rejects(aborted.start(), (error) => {
    assert.equal(error instanceof WipeAbortedError, true);
    assert.equal(error.summary.status, 'aborted');
    assert.equal(error.summary.failures.length, 1);
    return true;
  });
  await aborted.close();
});
