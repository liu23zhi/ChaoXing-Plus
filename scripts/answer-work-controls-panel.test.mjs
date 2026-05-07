import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const commonPath = resolve(process.cwd(), 'src', 'projects', 'common.ts');

test('common work results panel renders pause continue and retry controls', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const pauseButton = createElement('button', { text: isPaused ? '继续答题' : '暂停答题' });"), true);
  assert.equal(source.includes("const retryButton = createElement('button', { text: result.retrying ? '正在重答...' : '重答本题' });"), true);
  assert.equal(source.includes('setRuntimeControls(controls: WorkResultsRuntimeControls)'), true);
  assert.equal(source.includes('clearRuntimeControls()'), true);
  assert.equal(source.includes('patchResult(index: number, patch: Partial<SimplifyWorkResult>)'), true);
});

test('common work results panel uses the shared tone helper for number and question views', async () => {
  const source = await readFile(commonPath, 'utf8');

  assert.equal(source.includes("const tone = resolveWorkResultTone(result, index === state.workResults.currentResultIndex);"), true);
  assert.equal(source.includes("if (tone === 'manual')"), true);
  assert.equal(source.includes("if (tone === 'danger')"), true);
  assert.equal(source.includes("item.style.borderLeft = index === state.workResults.currentResultIndex ? '4px solid #2563eb' : '4px solid transparent';"), true);
  assert.equal(source.includes('formatWorkResultStatus(result)'), true);
});
