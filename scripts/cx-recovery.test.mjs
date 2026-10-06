import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const outDir = resolve(process.cwd(), '.tmp-tests-cx-recovery-cjs');
const helperModulePath = resolve(outDir, 'cx-recovery.js');
const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'cx-recovery.ts');
const tscCliPath = resolve(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');

async function loadHelperModule() {
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
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test('visible-content recovery reloads at most three times and reports only after the fourth failure', async () => {
  const mod = await loadHelperModule();
  const storage = createStorage();
  const signature = 'chapter=cur123::job=work-1::url=/knowledge/cards';
  const reloads = [];
  const notices = [];

  for (let failure = 1; failure <= 4; failure += 1) {
    const result = mod.handleVisibleContentRecovery({
      storage,
      signature,
      reload: () => reloads.push(failure),
      notifyFinalFailure: () => notices.push(failure)
    });
    if (failure < 4) {
      assert.equal(result, 'reloading');
    } else {
      assert.equal(result, 'exhausted');
    }
  }

  assert.deepEqual(reloads, [1, 2, 3]);
  assert.deepEqual(notices, [4]);
});

test('visible-content recovery waits three seconds after a pending reload and resets for a new signature', async () => {
  const mod = await loadHelperModule();
  const storage = createStorage();
  const signature = 'chapter=cur123::job=work-1::url=/knowledge/cards';
  const waits = [];

  assert.equal(mod.handleVisibleContentRecovery({
    storage,
    signature,
    reload() {}
  }), 'reloading');

  const resumed = await mod.resumeVisibleContentRecovery({
    storage,
    signature,
    wait: async (ms) => waits.push(ms)
  });
  assert.equal(resumed, true);
  assert.deepEqual(waits, [3000]);

  assert.equal(mod.handleVisibleContentRecovery({
    storage,
    signature: 'chapter=cur999::job=work-2::url=/knowledge/cards',
    reload() {}
  }), 'reloading');
});

test('video route recovery selects an enabled alternate route and stops when none remain', async () => {
  const mod = await loadHelperModule();
  const clicks = [];
  const root = {
    innerText: '视频因格式不支持或者服务器或网络的问题无法加载。',
    querySelectorAll(selector) {
      assert.equal(selector, 'input[type="radio"]');
      return [
        { disabled: true, checked: true, click() { clicks.push('公网1'); } },
        { disabled: false, checked: false, click() { clicks.push('公网2'); } }
      ];
    }
  };

  assert.equal(mod.trySwitchVideoRoute(root), true);
  assert.deepEqual(clicks, ['公网2']);
  assert.equal(mod.isVideoLoadFailure(root), true);
  assert.equal(mod.isVideoLoadFailure({ innerText: '正常播放中' }), false);
});

test('cx wires recovery into the study scanner and media runner', async () => {
  const source = await (await import('node:fs/promises')).readFile(resolve(process.cwd(), 'src', 'projects', 'cx.ts'), 'utf8');

  assert.equal(source.includes("from './cx-recovery.js'"), true);
  assert.equal(source.includes('resumeVisibleContentRecovery'), true);
  assert.equal(source.includes('async function waitForTopWindowLoad()'), true);
  assert.equal(source.includes('await waitForTopWindowLoad();'), true);
  assert.equal(source.includes('function buildVisibleContentRecoverySignature()'), true);
  assert.equal(source.includes('handleVisibleContentRecovery'), true);
  assert.equal(source.includes('trySwitchVideoRoute'), true);
  assert.equal(source.includes("topWindow.location['reload']()"), true);
});
