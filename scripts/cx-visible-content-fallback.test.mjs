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


test('cx chapter test fallback runs when TiMu is visible without a standard job attachment', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('enableVisibleQuestionFallback'), true);
  assert.equal(source.includes("visibleContentState === 'visible-nonjob' || visibleContentState === 'visible-unmapped'"), true);
  assert.equal(source.includes('await JobRunner.chapter(root, opts.workOptions);'), true);
  assert.equal(source.includes('正在尝试兜底处理当前可见题目'), true);
});


test('cx chapter runner reads chapter questions as a collection instead of collapsing a single query result to an empty array', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("const { TiMu } = domSearchAll({ TiMu: '.TiMu' }, frameDocument);"), true);
  assert.equal(source.includes("const roots = Array.isArray(TiMu) ? (TiMu as HTMLElement[]) : [];"), false);
  assert.equal(source.includes('未找到章节测试题目，已跳过。'), true);
});

test('cx chapter diagnostics log outer and inner iframe evidence before skipping', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('章节测试候选 iframe 诊断'), true);
  assert.equal(source.includes('frameDataJobid'), true);
  assert.equal(source.includes('frameData_jobid'), true);
  assert.equal(source.includes('directChapterTest'), true);
  assert.equal(source.includes('nestedIframeCount'), true);
  assert.equal(source.includes('章节测试候选 iframe 诊断详情：src='), true);
  assert.equal(source.includes('章节测试框架诊断'), true);
  assert.equal(source.includes('directTiMuCount'), true);
  assert.equal(source.includes('nestedWorkIframeCount'), true);
  assert.equal(source.includes('章节测试框架诊断详情：src='), true);
  assert.equal(source.includes('innerFrameExists'), true);
  assert.equal(source.includes('innerTiMuCount'), true);
  assert.equal(source.includes('章节测试未命中题目详情：innerFrameExists='), true);
});
