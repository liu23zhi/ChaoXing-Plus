import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cxProjectPath = resolve(scriptsDir, '..', 'src', 'projects', 'cx.ts');
const messagePath = resolve(scriptsDir, '..', 'src', 'runtime', 'message.ts');

test('cx registers runtime stop continue and retry controls with the common work results panel', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('workResultsMethods().setRuntimeControls?.({'), true);
  assert.equal(source.includes("stop: () => worker.emit('stop')"), true);
  assert.equal(source.includes("continuate: () => worker.emit('continuate')"), true);
  assert.equal(source.includes('retryQuestion: async (index) =>'), true);
  assert.equal(source.includes("worker.on('done', clearRuntimeControls);"), true);
  assert.equal(source.includes("worker.on('close', clearRuntimeControls);"), true);
});

test('cx isolates single question retry workers from the main result panel refresh callbacks', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('suppressWorkResultsPanelUpdate?: boolean;'), true);
  assert.equal(source.includes('if (!workerOptions.suppressWorkResultsPanelUpdate) {'), true);
  assert.equal(source.includes('const retryWorker = createChapterWorker([root], { suppressWorkResultsPanelUpdate: true });'), true);
  assert.equal(source.includes('const retryWorker = createWorkOrExamWorker([root], { suppressWorkResultsPanelUpdate: true });'), true);
});

test('cx syncs manual-answer state back into the common result entries', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes("import { resolveManualAnswerState } from './cx-manual-state.js';"), true);
  assert.equal(source.includes('function detectManualAnswer('), true);
  assert.equal(source.includes('return resolveManualAnswerState({ root, type, ...options });'), true);
  assert.equal(source.includes('const currentResults = workResultsMethods().getResults?.();'), true);
  assert.equal(source.includes('const previousManual = currentResults?.[currentIndex]?.manual ?? false;'), true);
  assert.equal(source.includes('manual: detectManualAnswer(currentRoot, type, {'), true);
  assert.equal(source.includes('manual: detectManualAnswer(currentRoot, questionType, {'), true);
  assert.equal(source.includes('result: curr'), true);
  assert.equal(source.includes('result: current'), true);
  assert.equal(source.includes('manual: false,'), true);
});

test('cx asks for a 5 second confirmation before auto answering and pauses on cancel', async () => {
  const source = await readFile(cxProjectPath, 'utf8');
  const messageSource = await readFile(messagePath, 'utf8');

  assert.equal(source.includes('async function confirmBeforeAutoAnswer('), true);
  assert.equal(source.includes("timer: 5000"), true);
  assert.equal(source.includes("confirmButtonText: '立即自动答题'"), true);
  assert.equal(source.includes("cancelButtonText: '手动答题'"), true);
  assert.equal(source.includes("worker.emit('stop')"), true);
  assert.equal(source.includes('await confirmBeforeAutoAnswer(worker);'), true);
  assert.equal(source.includes('return result.finish ? result : runRandomChoiceFallback('), false);
  assert.equal(source.includes(': ((await runRandomChoiceFallback('), true);
  assert.equal(source.includes("const handler = async (resolvedType: QuestionTypes, answer: string, option: HTMLElement | undefined) => {"), true);
  assert.equal(source.includes("const saveButton = option.parentElement?.parentElement?.querySelector('[onclick*=saveQuestion]');"), true);
  assert.equal(source.includes('if (saveButton instanceof HTMLElement) {'), true);
  assert.equal(messageSource.includes('defaultConfirmed?: boolean;'), true);
  assert.equal(messageSource.includes('return result.isConfirmed || (defaultConfirmed && result.dismiss === Swal.DismissReason.timer);'), true);
});
