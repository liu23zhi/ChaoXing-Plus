import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const outDir = resolve(process.cwd(), '.tmp-tests-cx-retry-cache-cjs');
const helperModulePath = resolve(outDir, 'cx-retry-cache.js');
const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'cx-retry-cache.ts');
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

test('automatic retry keeps cache enabled when the search timed out', async () => {
  const mod = await loadHelperModule();

  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    error: '题库请求超时，可能是题库问题，或者请检查网络或者重试。'
  }), undefined);
  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    ctx: {
      searchInfos: [{ error: 'request timeout' }]
    }
  }), undefined);
});

test('automatic retry keeps cache enabled when no answer is displayed', async () => {
  const mod = await loadHelperModule();

  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    result: { finish: false },
    ctx: {
      searchInfos: [{ results: [] }]
    }
  }), undefined);
});

test('automatic retry skips cache only when an answer was returned but did not match', async () => {
  const mod = await loadHelperModule();

  assert.equal(mod.shouldSkipCacheForAutomaticRetry({
    result: { finish: false },
    ctx: {
      searchInfos: [{
        results: [{ answer: '错误答案' }]
      }]
    }
  }), true);
});
