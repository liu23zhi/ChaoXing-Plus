import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rename } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

const execFileAsync = promisify(execFile);
const outDir = createTestDirectory('tiku-search-task-cjs');
const sourcePath = resolveTestPath('src', 'core', 'answer-wrapper', 'task-poller.ts');
const modulePath = resolve(outDir, 'task-poller.cjs');
const tscCliPath = resolveTestPath('scripts', 'test-helpers', 'tsc-compat.mjs');

async function loadModule() {
  await mkdir(outDir, { recursive: true });
  await execFileAsync(process.execPath, [
    tscCliPath,
    sourcePath,
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck'
  ]);
  await rename(resolve(outDir, 'task-poller.js'), modulePath);
  const require = createRequire(import.meta.url);
  delete require.cache[modulePath];
  return require(modulePath);
}

function pollOptions(getStatus, overrides = {}) {
  return {
    statusUrlBase: 'https://adapter.local/api/search/status',
    pollIntervalMs: 0,
    timeoutMs: 10000,
    maxConsecutiveFailures: 3,
    getStatus,
    wait: async () => {},
    ...overrides
  };
}

test('async search polling accepts the adapter succeeded terminal status', async () => {
  const mod = await loadModule();
  const searchResponse = { question: '题目', answer: { answerText: '答案' } };

  const result = await mod.pollTikuAdapterSearchTask(
    { success: true, status: 'running', taskId: 'task-succeeded' },
    pollOptions(async () => ({
      success: true,
      status: 'succeeded',
      taskId: 'task-succeeded',
      result: searchResponse
    }))
  );

  assert.deepEqual(result, searchResponse);
});

test('async search polling ignores waiting states and returns the completed search response', async () => {
  const mod = await loadModule();
  const searchResponse = { question: '题目', answer: { answerText: '答案' } };
  const states = [
    { success: true, status: 'running', taskId: 'task-1' },
    { success: true, status: 'pending', taskId: 'task-1' },
    { success: true, status: 'completed', taskId: 'task-1', result: searchResponse }
  ];
  let calls = 0;

  const result = await mod.pollTikuAdapterSearchTask(
    { success: true, status: 'pending', taskId: 'task-1' },
    pollOptions(async () => states[calls++])
  );

  assert.deepEqual(result, searchResponse);
  assert.equal(calls, 3);
});

test('async search polling stops after three consecutive request failures', async () => {
  const mod = await loadModule();
  let calls = 0;

  await assert.rejects(
    mod.pollTikuAdapterSearchTask(
      { success: true, status: 'pending', taskId: 'task-2' },
      pollOptions(async () => {
        calls++;
        throw new Error('Failed to fetch');
      })
    ),
    /3 consecutive/iu
  );

  assert.equal(calls, 3);
});

test('a waiting response resets the consecutive failure count', async () => {
  const mod = await loadModule();
  const states = [
    new Error('Failed to fetch'),
    { success: true, status: 'running', taskId: 'task-3' },
    new Error('Failed to fetch'),
    new Error('Failed to fetch'),
    { success: true, status: 'completed', taskId: 'task-3', result: { question: 'Q', answer: { answerText: 'A' } } }
  ];
  let calls = 0;

  const result = await mod.pollTikuAdapterSearchTask(
    { success: true, status: 'pending', taskId: 'task-3' },
    pollOptions(async () => {
      const state = states[calls++];
      if (state instanceof Error) throw state;
      return state;
    })
  );

  assert.equal(result.question, 'Q');
  assert.equal(calls, 5);
});

test('an explicit failed task response counts as a failed status query', async () => {
  const mod = await loadModule();
  let calls = 0;

  await assert.rejects(
    mod.pollTikuAdapterSearchTask(
      { success: true, status: 'pending', taskId: 'task-4' },
      pollOptions(async () => {
        calls++;
        return { success: false, status: 'failed', taskId: 'task-4', error: { message: 'search failed' } };
      })
    ),
    /3 consecutive/iu
  );

  assert.equal(calls, 3);
});

test('task polling preserves structured failure code after three consecutive failures', async () => {
  const mod = await loadModule();
  let calls = 0;

  await assert.rejects(
    mod.pollTikuAdapterTask(
      { success: true, status: 'pending', taskId: 'task-balance' },
      pollOptions(async () => {
        calls++;
        return {
          success: false,
          status: 'failed',
          taskId: 'task-balance',
          error: { code: 'INSUFFICIENT_BALANCE', message: 'sensitive backend detail' }
        };
      })
    ),
    (error) => {
      assert.equal(error.code, 'INSUFFICIENT_BALANCE');
      assert.match(error.message, /sensitive backend detail/iu);
      return true;
    }
  );

  assert.equal(calls, 3);
});

test('a waiting response clears retained failure code before later network failures', async () => {
  const mod = await loadModule();
  const states = [
    { success: false, status: 'failed', error: { code: 'INSUFFICIENT_BALANCE', message: 'old balance error' } },
    { success: true, status: 'running' },
    new Error('Failed to fetch'),
    new Error('Failed to fetch'),
    new Error('Failed to fetch')
  ];
  let calls = 0;

  await assert.rejects(
    mod.pollTikuAdapterTask(
      { success: true, status: 'pending', taskId: 'task-reset' },
      pollOptions(async () => {
        const state = states[calls++];
        if (state instanceof Error) throw state;
        return { taskId: 'task-reset', ...state };
      })
    ),
    (error) => {
      assert.equal(error.code, undefined);
      assert.match(error.message, /Failed to fetch/iu);
      assert.doesNotMatch(error.message, /old balance error/iu);
      return true;
    }
  );

  assert.equal(calls, 5);
});

test('async search polling times out at the configured phase deadline', async () => {
  const mod = await loadModule();
  let now = 0;

  await assert.rejects(
    mod.pollTikuAdapterSearchTask(
      { success: true, status: 'running', taskId: 'task-timeout' },
      pollOptions(
        async () => ({ success: true, status: 'running', taskId: 'task-timeout' }),
        {
          timeoutMs: 600000,
          pollIntervalMs: 2500,
          now: () => now,
          wait: async (ms) => { now += ms; }
        }
      )
    ),
    /600 seconds/iu
  );
});

test('async polling bounds the final status request by remaining phase time and rejects late success', async () => {
  const mod = await loadModule();
  let now = 0;
  const requestTimeouts = [];

  await assert.rejects(
    mod.pollTikuAdapterSearchTask(
      { success: true, status: 'running', taskId: 'task-deadline' },
      pollOptions(async (_url, _taskId, timeoutMs) => {
        requestTimeouts.push(timeoutMs);
        now += timeoutMs;
        return { success: true, status: 'succeeded', taskId: 'task-deadline', result: { answer: 'too late' } };
      }, {
        timeoutMs: 10000,
        pollIntervalMs: 9000,
        now: () => now,
        wait: async (ms) => { now += ms; }
      })
    ),
    /10 seconds/iu
  );

  assert.deepEqual(requestTimeouts, [1000]);
  assert.equal(now, 10000);
});
