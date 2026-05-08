import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const cxProjectPath = resolve(process.cwd(), 'src', 'projects', 'cx.ts');

test('cx registers runtime stop continue and retry controls with the common work results panel', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('workResultsMethods().setRuntimeControls?.({'), true);
  assert.equal(source.includes("stop: () => worker.emit('stop')"), true);
  assert.equal(source.includes("continuate: () => worker.emit('continuate')"), true);
  assert.equal(source.includes('retryQuestion: async (index) =>'), true);
  assert.equal(source.includes("worker.on('done', clearRuntimeControls);"), true);
  assert.equal(source.includes("worker.on('close', clearRuntimeControls);"), true);
});

test('cx syncs manual-answer state back into the common result entries', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes("import { resolveManualAnswerState } from './cx-manual-state.js';"), true);
  assert.equal(source.includes('function detectManualAnswer('), true);
  assert.equal(source.includes('return resolveManualAnswerState({ root, type, ...options });'), true);
  assert.equal(source.includes('const previousManual = workResultsMethods().getResults?.()[currentIndex]?.manual ?? false;'), true);
  assert.equal(source.includes('manual: detectManualAnswer(currentRoot, type, {'), true);
  assert.equal(source.includes('manual: detectManualAnswer(currentRoot, questionType, {'), true);
  assert.equal(source.includes('result: curr'), true);
  assert.equal(source.includes('result: current'), true);
  assert.equal(source.includes('manual: false,'), true);
});
