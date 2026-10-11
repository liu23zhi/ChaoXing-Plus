import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const outDir = resolve(process.cwd(), '.tmp-tests-high-playback-rate-cjs');
const helperModulePath = resolve(outDir, 'high-playback-rate-warning.js');
const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'high-playback-rate-warning.ts');
const tscCliPath = resolve(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');

let helperModulePromise;

async function loadHelperModule() {
  helperModulePromise ??= (async () => {
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, 'package.json'), '{"type":"commonjs"}\n');
    await execFileAsync(process.execPath, [
      tscCliPath,
      helperSourcePath,
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
    const require = createRequire(import.meta.url);
    delete require.cache[helperModulePath];
    return require(helperModulePath);
  })();

  return helperModulePromise;
}

test('high playback rate warning keeps the agreed copy and buttons', async () => {
  const mod = await loadHelperModule();

  assert.equal(
    mod.HIGH_PLAYBACK_RATE_WARNING_CONTENT,
    '当前倍速已达到或超过 2 倍。超星存在较强风控，高倍速可能导致进度清空、回退或学习异常，请谨慎使用。'
  );
  assert.equal(mod.HIGH_PLAYBACK_RATE_WARNING_CONFIRM_TEXT, '继续使用');
  assert.equal(mod.HIGH_PLAYBACK_RATE_WARNING_CANCEL_TEXT, '降到 1 倍');
  assert.deepEqual(mod.buildHighPlaybackRateWarningPrompt(), {
    content: mod.HIGH_PLAYBACK_RATE_WARNING_CONTENT,
    confirmButtonText: '继续使用',
    cancelButtonText: '降到 1 倍',
    defaultConfirmed: true
  });
});

test('rates below 2x never prompt', async () => {
  const mod = await loadHelperModule();
  const state = mod.createHighPlaybackRateWarningState();
  const restoredRates = [];
  let confirmCalls = 0;
  const handlers = {
    confirm: async () => {
      confirmCalls += 1;
      return false;
    },
    restorePlaybackRate: (rate) => {
      restoredRates.push(rate);
    }
  };

  for (const value of [1, 1.5, '1.75', 0, undefined, null, '', 'abc', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(await mod.warnOnHighPlaybackRate(state, value, handlers), 'skipped');
  }

  assert.equal(confirmCalls, 0);
  assert.deepEqual(restoredRates, []);
  assert.equal(mod.shouldWarnHighPlaybackRate(state, 2), true);
});

test('choosing 降到 1 倍 restores the rate and keeps prompting on later high rates', async () => {
  const mod = await loadHelperModule();
  const state = mod.createHighPlaybackRateWarningState();
  const prompts = [];
  const restoredRates = [];
  const handlers = {
    confirm: async (prompt) => {
      prompts.push(prompt);
      return false;
    },
    restorePlaybackRate: (rate) => {
      restoredRates.push(rate);
    }
  };

  assert.equal(await mod.warnOnHighPlaybackRate(state, 2, handlers), 'restored');
  assert.equal(state.acknowledged, false);

  // 降到 1 倍之后，后续再次调高倍速仍然要提示。
  assert.equal(await mod.warnOnHighPlaybackRate(state, 2.5, handlers), 'restored');
  assert.equal(await mod.warnOnHighPlaybackRate(state, '3', handlers), 'restored');

  assert.equal(prompts.length, 3);
  assert.deepEqual(restoredRates, [1, 1, 1]);
  assert.equal(prompts[0].content, mod.HIGH_PLAYBACK_RATE_WARNING_CONTENT);
  assert.equal(prompts[0].confirmButtonText, '继续使用');
  assert.equal(prompts[0].cancelButtonText, '降到 1 倍');
});

test('only choosing 继续使用 stops later prompts on the current page', async () => {
  const mod = await loadHelperModule();
  const state = mod.createHighPlaybackRateWarningState();
  let confirmCalls = 0;
  let restoreCalls = 0;
  const handlers = {
    confirm: async () => {
      confirmCalls += 1;
      return true;
    },
    restorePlaybackRate: () => {
      restoreCalls += 1;
    }
  };

  assert.equal(await mod.warnOnHighPlaybackRate(state, 2, handlers), 'acknowledged');
  assert.equal(state.acknowledged, true);
  assert.equal(await mod.warnOnHighPlaybackRate(state, 4, handlers), 'skipped');
  assert.equal(await mod.warnOnHighPlaybackRate(state, 8, handlers), 'skipped');
  assert.equal(confirmCalls, 1);
  assert.equal(restoreCalls, 0);
});

test('an open prompt is not stacked twice', async () => {
  const mod = await loadHelperModule();
  const state = mod.createHighPlaybackRateWarningState();
  let resolveConfirm;
  let confirmCalls = 0;
  const pendingConfirm = new Promise((resolve) => {
    resolveConfirm = resolve;
  });
  const restoredRates = [];

  const firstPrompt = mod.warnOnHighPlaybackRate(state, 2, {
    confirm: () => {
      confirmCalls += 1;
      return pendingConfirm;
    },
    restorePlaybackRate: (rate) => restoredRates.push(rate)
  });

  assert.equal(
    await mod.warnOnHighPlaybackRate(state, 3, {
      confirm: async () => {
        confirmCalls += 1;
        return false;
      },
      restorePlaybackRate: () => {}
    }),
    'deduped'
  );
  assert.equal(confirmCalls, 1);

  resolveConfirm(false);
  assert.equal(await firstPrompt, 'restored');
  assert.deepEqual(restoredRates, [1]);
  assert.equal(state.pending, false);
});

test('a failing prompt does not lock the warning for the page', async () => {
  const mod = await loadHelperModule();
  const state = mod.createHighPlaybackRateWarningState();

  assert.equal(
    await mod.warnOnHighPlaybackRate(state, 2, {
      confirm: async () => {
        throw new Error('swal unavailable');
      },
      restorePlaybackRate: () => {}
    }),
    'failed'
  );
  assert.equal(state.pending, false);
  assert.equal(state.acknowledged, false);

  assert.equal(
    await mod.warnOnHighPlaybackRate(state, 2, {
      confirm: async () => false,
      restorePlaybackRate: () => {}
    }),
    'restored'
  );
});

test('common wires the warning state machine instead of latching a flag before the prompt', async () => {
  const source = (await readFile(resolve(process.cwd(), 'src', 'projects', 'common.ts'), 'utf8')).replace(/\r\n/g, '\n');

  assert.equal(source.includes("import {\n  createHighPlaybackRateWarningState,\n  warnOnHighPlaybackRate\n} from './high-playback-rate-warning.js';"), true);
  assert.equal(source.includes('const highPlaybackRateWarningState = createHighPlaybackRateWarningState();'), true);
  assert.equal(source.includes('void warnOnHighPlaybackRate(highPlaybackRateWarningState, value, {'), true);
  assert.equal(source.includes("restorePlaybackRate: (rate) => setStudySettingValueInternal(script, 'playbackRate', rate, { warn: false })"), true);
  assert.equal(source.includes('hasWarnedHighPlaybackRateInCurrentPage'), false);
});
