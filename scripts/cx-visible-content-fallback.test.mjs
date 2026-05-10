import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const cxPath = resolve(process.cwd(), 'src', 'projects', 'cx.ts');

test('cx study exposes visible-content fallback states and avoids treating visible questions as completed', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("type VisibleContentState = 'standard-job' | 'finished-job' | 'visible-nonjob' | 'visible-unmapped' | 'empty'"), true);
  assert.equal(source.includes('visibleContentState !== \'empty\''), true);
  assert.equal(source.includes('检测到页面存在可处理内容，但当前未识别为标准任务点。'), true);
  assert.equal(source.includes('页面任务点已完成，即将跳转。'), true);
});

test('cx study merges visible-content states instead of keeping the first non-empty state', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('function mergeVisibleContentState('), true);
  assert.equal(source.includes('visibleContentState = mergeVisibleContentState(visibleContentState, result.visibleContentState);'), true);
});
