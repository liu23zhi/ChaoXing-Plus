import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cxProjectPath = resolve(scriptsDir, '..', 'src', 'projects', 'cx.ts');
const messagePath = resolve(scriptsDir, '..', 'src', 'runtime', 'message.ts');
const commonProjectPath = resolve(scriptsDir, '..', 'src', 'projects', 'common.ts');
const workerInterfacePath = resolve(scriptsDir, '..', 'src', 'core', 'worker', 'interface.ts');
const workerPath = resolve(scriptsDir, '..', 'src', 'core', 'worker', 'worker.ts');

test('cx registers runtime stop continue and retry controls with the common work results panel', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('workResultsMethods().setRuntimeControls?.({'), true);
  assert.equal(source.includes("stop: () => worker.emit('stop')"), true);
  assert.equal(source.includes('continuate: () => {'), true);
  assert.equal(source.includes("worker.emit('continuate')"), true);
  assert.equal(source.includes('if (tikuAdapterBalanceRecoveryState.paused)'), true);
  assert.equal(source.includes('void requestTikuAdapterBalanceRecovery();'), true);
  assert.equal(source.includes('workResultsMethods().refresh?.();'), true);
  assert.equal(source.includes('retryQuestion: async (index) =>'), true);
  assert.equal(source.includes('canRetryQuestion: (index) => Boolean(roots[index]) && !taskBusy && !uploadInProgress && !tikuAdapterBalanceRecoveryState.paused'), true);
  assert.equal(source.includes('canRetryQuestion: (index) =>'), true);
  assert.equal(source.match(/if \(!\(await allowTikuAdapterRetryAfterBalanceRecovery\(\)\)\)/g)?.length, 3);
  assert.equal(source.includes("worker.on('done', clearRuntimeControls);"), false);
  assert.equal(source.includes("worker.on('close', clearRuntimeControls);"), true);
  assert.equal(source.includes('})().finally(clearRuntimeControls);'), false);
});

test('search defaults to four concurrent workers across shared and Chaoxing entry points', async () => {
  const [commonSource, cxSource, workerInterfaceSource, workerSource] = await Promise.all([
    readFile(commonProjectPath, 'utf8'),
    readFile(cxProjectPath, 'utf8'),
    readFile(workerInterfacePath, 'utf8'),
    readFile(workerPath, 'utf8')
  ]);

  assert.equal(workerInterfaceSource.includes('export const DEFAULT_WORKER_THREAD_COUNT = 4;'), true);
  assert.equal(workerInterfaceSource.includes('export function resolveWorkerThreadCount(thread: number | undefined): number'), true);
  assert.equal(commonSource.includes('thread: DEFAULT_WORKER_THREAD_COUNT,'), true);
  assert.equal(cxSource.includes('thread: DEFAULT_WORKER_THREAD_COUNT,'), true);
  assert.equal(cxSource.includes('thread: thread ?? DEFAULT_WORKER_THREAD_COUNT,'), true);
  assert.equal(workerSource.includes('const threadCount = resolveWorkerThreadCount(this.opts.thread);'), true);
  assert.equal(cxSource.includes("thread: 1 }),"), false);
});

test('cx isolates single question retry workers from the main result panel refresh callbacks', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('suppressWorkResultsPanelUpdate?: boolean;'), true);
  assert.equal(source.includes('if (!workerOptions.suppressWorkResultsPanelUpdate) {'), true);
  assert.match(source, /const retryWorker = createChapterWorker\(\[root\], \{\s*suppressWorkResultsPanelUpdate: true,\s*skipCache: shouldSkipCacheForManualRetry\(workResultsMethods\(\)\.getResults\?\.\(\)\?\.\[index\]\)/);
  assert.match(source, /const retryWorker = createWorkOrExamWorker\(\[root\], \{\s*suppressWorkResultsPanelUpdate: true,\s*skipCache: shouldSkipCacheForManualRetry\(workResultsMethods\(\)\.getResults\?\.\(\)\?\.\[index\]\)/);
});

test('cx retries unfinished question roots before uploading instead of refreshing the whole page', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('async function retryUnfinishedChapterQuestions('), true);
  assert.equal(source.includes('async function retryUnfinishedWorkOrExamQuestions('), true);
  assert.equal(source.includes('const retryableResults = await retryUnfinishedChapterQuestions(results);'), true);
  assert.equal(source.includes('const retryableResults = await retryUnfinishedWorkOrExamQuestions(results);'), true);
  assert.equal(source.includes('if (retried?.result?.finish) {'), true);
  assert.equal(source.includes("logDebug('info', '动作节点诊断：未完成单题自动重试'"), true);
  assert.equal(source.includes('location.reload()'), false);
});

test('cx uses the configured unfinished-answer retry count with a default of three', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('const defaultUnfinishedQuestionRetryAttempts = 3;'), true);
  assert.equal(source.includes("getWindowsRuntimeSetting('answer-retry', defaultUnfinishedQuestionRetryAttempts)"), true);
  assert.equal(source.includes('return Math.max(0, Math.min(20, configured));'), true);
  assert.equal(source.includes('async function retryUnfinishedChapterQuestionAtIndex('), true);
  assert.equal(source.includes('async function retryUnfinishedWorkOrExamQuestionAtIndex('), true);
  assert.equal(source.includes('const maxAttempts = getUnfinishedQuestionRetryAttempts();'), true);
  assert.equal(source.includes('for (let attempt = 1; attempt <= maxAttempts; attempt++) {'), true);
  assert.equal(source.includes('attempt,'), true);
  assert.equal(source.includes('maxAttempts,'), true);
  assert.equal(source.includes('if (retried?.result?.finish) {'), true);
  assert.equal(source.includes('break;'), true);
});

test('cx keeps cache modes separate and only forces a fresh answer for mismatches', async () => {
  const source = await readFile(cxProjectPath, 'utf8');

  assert.equal(source.includes('shouldSkipCacheForAutomaticRetry'), true);
  assert.equal(source.includes('skipCache: shouldSkipCacheForAutomaticRetry(latestResult)'), true);
  assert.equal(source.includes('shouldSkipCacheForManualRetry(workResultsMethods().getResults?.()?.[index])'), true);
  assert.equal(source.includes('skipCache: Boolean(workerOptions.skipCache)'), true);
  assert.equal(source.split("searchInCaches(title, provider, deepThinking ? 'deep' : 'normal')").length - 1, 2);
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
  assert.equal(source.includes("getWindowsRuntimeSetting('answer-countdown', 5)"), true);
  assert.equal(source.includes("timer: countdown > 0 ? countdown * 1000 : undefined"), true);
  assert.equal(source.includes('defaultConfirmed: countdown > 0'), true);
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

test('Windows no-auto-submit prevents both chapter and work/exam submit actions', async () => {
  const source = await readFile(cxProjectPath, 'utf8');
  const chapterStart = source.indexOf('const effectiveUpload = !autoSubmitEnabled && upload === \'submit\' ? \'save\' : upload;');
  const chapterEnd = source.indexOf('async function findWorkOrExamRuntimeWindow', chapterStart);
  const chapterFlow = source.slice(chapterStart, chapterEnd);

  assert.equal(source.includes("getWindowsRuntimeSetting<boolean>('auto-submit', true) !== false"), true);
  assert.equal(source.includes('const shouldSubmit = autoSubmitEnabled && upload === \'submit\' && uploadable;'), true);
  assert.match(source, /const shouldAllowSubmitForPage = upload === 'submit'\s+&& autoSubmitEnabled/);
  assert.match(source, /if \(shouldSubmit\) \{\s+await submitWorkOrExamPage\(type\);/);
  assert.match(chapterFlow, /if \(autoSubmitEnabled\) \{[\s\S]*?btnBlueSubmit\?\.\(\);[\s\S]*?\} else \{[\s\S]*?noSubmit\?\.\(\);/);
});
