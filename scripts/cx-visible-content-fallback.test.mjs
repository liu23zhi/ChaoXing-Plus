import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cxPath = resolve(scriptsDir, '..', 'src', 'projects', 'cx.ts');

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

test('cx does not auto-jump when a standard chapter test job is detected but skipped by disabled answer settings', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('自动答题总开关已关闭。${jobName} 即将跳过'), true);
  assert.equal(source.includes('章节测试自动答题功能已被关闭。${jobName} 即将跳过'), true);
  assert.equal(source.includes("if (visibleContentState !== 'empty' && visibleContentState !== 'finished-job' && !currentChapterFinished) {"), true);
  assert.equal(source.includes('页面任务点已完成，即将跳转。'), true);
});

test('cx prefers current chapter completion over visible-content fallback blocking and logs the decision', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("const currentChapterFinished = CXAnalyses.isCurrentChapterFinished();"), true);
  assert.equal(source.includes('学习页面状态诊断'), true);
  assert.equal(source.includes('学习页面状态诊断详情：visibleContentState='), true);
  assert.equal(source.includes('currentChapterFinished='), true);
});

test('cx prefers answertype inputs over generic type inputs when resolving question type in chapter tests', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("const prioritizedSelectors = ['input[id^=\"answertype\"]', 'input[name^=\"answertype\"]', 'input[name^=\"type\"]', 'input[id^=\"type\"]'];"), true);
  assert.equal(source.includes('for (const selector of prioritizedSelectors) {'), true);
  assert.equal(source.includes('const match = root.querySelector<HTMLInputElement>(selector);'), true);
  assert.equal(source.includes('if (match) {'), true);
  assert.equal(source.includes('return match;'), true);
});


test('cx falls back from empty generic type inputs to nearby answertype inputs in chapter tests', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("const currentValue = root.value?.trim() ?? '';"), true);
  assert.equal(source.includes("const isPrioritizedTypeInput = root.matches('input[id^=\"answertype\"],input[name^=\"answertype\"]');"), true);
  assert.equal(source.includes("const scopedRoot = root.closest('.TiMu, .questionLi') ?? root.parentElement ?? root.form ?? root.ownerDocument;"), true);
  assert.equal(source.includes('const prioritizedMatch = scopedRoot.querySelector<HTMLInputElement>(selector);'), true);
  assert.equal(source.includes('if (isPrioritizedTypeInput || currentValue) {'), true);
});

test('cx waits for video attachment or chapter completion before leaving a media task', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('await JobRunner.media(opts, win.document, attachment);'), true);
  assert.equal(source.includes("async media(setting: Pick<StudyOptions, 'playbackRate' | 'volume' | 'muteMedia' | 'videoQuizStrategy' | 'enableAnswer'>, doc: Document, attachment?: Attachment) {"), true);
  assert.equal(source.includes('const finished = await waitForAttachmentComplete(attachment, 15000);'), true);
  assert.equal(source.includes('await waitForCurrentChapterFinished(10000);'), true);
});

test('cx auto-scrolls to the current runnable task before starting it', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('scrollToLearningTask(root);'), true);
  assert.equal(source.includes('function scrollToLearningTask(taskFrame: HTMLIFrameElement) {'), true);
  assert.equal(source.includes("const iframe = topWindow.document.querySelector<HTMLIFrameElement>('#iframe');"), true);
  assert.equal(source.includes("const taskCard = taskFrame.closest<HTMLElement>('.ans-attach-ct');"), true);
  assert.equal(source.includes("taskCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });"), true);
});

test('cx clears the sibling-sub-task switching notice once a runnable task is found', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('function clearTopCenterNotice() {'), true);
  assert.equal(source.includes('clearTopCenterNotice();'), true);
  assert.equal(source.includes("const msg = `即将${workType === 'finished' && opts.restudy ? '重新' : workType === 'not-job' && opts.forceLearn ? '强制' : ''}播放 : ${jobName}`;"), true);
  assert.equal(source.includes("const msg = `正在处理章节测试 : ${jobName}`;"), true);
});

test('cx checks sibling sub task tabs in sequence and persists progress so it can reach later tabs', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("const CHAPTER_SUBTASK_PROGRESS_PREFIX = 'cx.new.study.subtask-progress.';"), true);
  assert.equal(source.includes('interface ChapterSubTaskProgress {'), true);
  assert.equal(source.includes('runtimeStore.get<ChapterSubTaskProgress>('), true);
  assert.equal(source.includes('for (let offset = 1; offset < tabs.length; offset += 1) {'), true);
  assert.equal(source.includes('const nextIndex = (activeIndex + offset) % tabs.length;'), true);
  assert.equal(source.includes('当前章节仍未完成，正在尝试切换到同章节的其他子任务继续检查。'), true);
});

test('cx pauses only after checking all sibling sub tasks three times without finding runnable work', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('const maxAttempts = tabs.length * 3;'), true);
  assert.equal(source.includes('const attempts = progress.lastActiveTabKey === activeTabKey ? progress.attempts : progress.attempts + 1;'), true);
  assert.equal(source.includes('if (attempts >= maxAttempts) {'), true);
  assert.equal(source.includes('当前章节的所有子任务已连续检查 3 轮，仍未找到可执行任务，脚本已暂停自动切换。'), true);
});

test('cx blocks auto-jump when no visible runnable content is detected but the current chapter is still unfinished', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("function shouldCheckSiblingSubTasksForState(visibleContentState: VisibleContentState): boolean {"), true);
  assert.equal(source.includes("return visibleContentState === 'finished-job' || visibleContentState === 'empty';"), true);
  assert.equal(source.includes("const shouldCheckSiblingSubTasks = !currentChapterFinished && searchedJobs.length === 0 && shouldCheckSiblingSubTasksForState(visibleContentState);"), true);
  assert.equal(source.includes('当前章节仍未完成，但未识别到可执行任务，已取消自动跳转。'), true);
});

test('cx checks sibling sub tasks before showing the final-chapter unfinished warning', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("const shouldCheckSiblingSubTasks = !currentChapterFinished && searchedJobs.length === 0 && shouldCheckSiblingSubTasksForState(visibleContentState);"), true);
  assert.equal(source.includes("if (CXAnalyses.isInFinalChapter() && !shouldCheckSiblingSubTasks) {"), true);
  assert.equal(source.includes('已经抵达最后一个章节！但仍然有任务点未完成，请手动切换至未完成的章节。'), true);
  assert.equal(source.includes('当前章节仍未完成，正在尝试切换到同章节的其他子任务继续检查。'), true);
});

test('cx detects repeated invalid chapter jumps and warns after returning to the same page 3 times', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('const chapterStayCounter = new Map<string, number>();'), true);
  assert.equal(source.includes('const chapterStayState = this.trackChapterStayState();'), true);
  assert.equal(source.includes('const chapterStayState = CXAnalyses.getChapterStayState();'), true);
  assert.equal(source.includes('returnedToSameChapter: chapterStayState.returnedToSameChapter,'), true);
  assert.equal(source.includes('repeatCount: chapterStayState.repeatCount'), true);
  assert.equal(source.includes('await $modal.notice({'), true);
  assert.equal(source.includes("content: '连续 3 次跳转后仍停留在同一页面，自动跳转可能失效，请手动检查课程目录或任务点状态。'"), true);
  assert.equal(source.includes("icon: 'warning'"), true);
});

test('cx cancels delayed auto-jump when the user manually switches to another task point', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('getCurrentChapterStayKey() {'), true);
  assert.equal(source.includes('const jumpGuardKey = CXAnalyses.getCurrentChapterStayKey();'), true);
  assert.equal(source.includes('if (jumpGuardKey && CXAnalyses.getCurrentChapterStayKey() !== jumpGuardKey) {'), true);
  assert.equal(source.includes('检测到你已手动切换任务点，本次自动跳转已取消。'), true);
});

test('cx logs scan iterations and jump guards for delayed auto-jump debugging', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('[Chaoxing Plus]['), true);
  assert.equal(source.includes('课程学习扫描诊断'), true);
  assert.equal(source.includes('课程学习扫描诊断详情：visibleContentState='), true);
  assert.equal(source.includes('自动跳转守卫诊断'), true);
  assert.equal(source.includes('自动跳转取消诊断'), true);
});

test('cx prefixes detailed diagnostics with Chaoxing Plus tag and sequence number', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("const prefix = `[Chaoxing Plus][${nextDebugSequence()}] ${label}`;"), true);
  assert.equal(source.includes('function nextDebugSequence() {'), true);
  assert.equal(source.includes("String(debugSequence).padStart(4, '0')"), true);
});

test('cx attaches correlation ids to diagnostics so scan, chapter, and job logs can be grouped', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('correlationId?: string'), true);
  assert.equal(source.includes('chapterStayKey='), true);
  assert.equal(source.includes('targetJobId='), true);
  assert.equal(source.includes('jobName='), true);
});

test('cx keeps a top-window debug throttle store so repeated cards reloads do not flood diagnostics', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("const debugLogThrottleKey = '__chaoxing_plus_debug_log_throttle__';"), true);
  assert.equal(source.includes('type DebugLogThrottleStoreOwner = Window & Record<string, unknown>;'), true);
  assert.equal(source.includes('function getDebugLogThrottleStore() {'), true);
  assert.equal(source.includes('const ownerWindow = (window.top ?? window) as DebugLogThrottleStoreOwner;'), true);
  assert.equal(source.includes('ownerWindow[debugLogThrottleKey] = nextStore;'), true);
  assert.equal(source.includes('function shouldSkipThrottledDebugLog(throttleKey: string, throttleMs = 1500) {'), true);
  assert.equal(source.includes('const now = Date.now();'), true);
  assert.equal(source.includes('if (typeof lastTriggeredAt === \'number\' && now - lastTriggeredAt < throttleMs) {'), true);
});

test('cx throttles repetitive study and job diagnostics while preserving state-change logs', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('throttleKey?: string;'), true);
  assert.equal(source.includes('throttleMs?: number;'), true);
  assert.equal(source.includes("if (level === 'info' && meta?.throttleKey && shouldSkipThrottledDebugLog(meta.throttleKey, meta.throttleMs)) {"), true);
  assert.equal(source.includes("throttleKey: `study-scan:${scanCorrelationId}:${visibleContentState}:${result.visibleContentState}:${String(Boolean(result.job))}:${String(searching)}`"), true);
  assert.equal(source.includes("throttleKey: `chapter-candidate:${jobCorrelationId}`"), true);
  assert.equal(source.includes("throttleKey: `chapter-status:${jobCorrelationId}:${workType}:${String(chapterStatusComplete)}:${String(alreadySearched)}`"), true);
  assert.equal(source.includes("throttleKey: `job-search:${jobCorrelationId}:${visibleContentState}:${workType}:${String(alreadySearched)}`"), true);
  assert.equal(source.includes("throttleKey: `job-skip:${jobCorrelationId}:already-searched`"), true);
  assert.equal(source.includes("throttleKey: `job-skip:${jobCorrelationId}:no-runnable-handler`"), true);
});

test('cx logs task-search candidate state before deciding whether a visible frame can run or block jumping', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('任务点搜索诊断'), true);
  assert.equal(source.includes('任务点搜索诊断详情：frameSrc='), true);
  assert.equal(source.includes('任务点已处理跳过诊断'), true);
  assert.equal(source.includes('hasFunc: false'), true);
});

test('cx chapter test fallback runs when TiMu is visible without a standard job attachment', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('enableVisibleQuestionFallback'), true);
  assert.equal(source.includes("visibleContentState === 'visible-nonjob' || visibleContentState === 'visible-unmapped'"), true);
  assert.equal(source.includes('await JobRunner.chapter(root, opts.workOptions);'), true);
  assert.equal(source.includes('正在尝试兜底处理当前可见题目'), true);
});

test('cx treats chapter tests marked complete in the frame DOM as finished jobs for auto-jump', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("if (chapterStatusComplete) {"), true);
  assert.equal(source.includes("return { visibleContentState: 'finished-job' };"), true);
});

test('cx repeated chapter scans preserve completion state and log chapter status diagnostics', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('alreadySearched'), true);
  assert.equal(source.includes('chapterStatusComplete'), true);
  assert.equal(source.includes('statusClass'), true);
  assert.equal(source.includes('章节测试状态诊断'), true);
  assert.equal(source.includes('章节测试状态诊断详情：jobName='), true);
  assert.equal(source.includes('attachmentPassed='), true);
});

test('cx only treats already processed completed chapter jobs as finished for auto-jump', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("if (alreadySearched) {"), true);
  assert.equal(source.includes("reason: 'already-searched'"), true);
  assert.equal(source.includes("return { visibleContentState: chapterStatusComplete ? 'finished-job' : visibleContentState }"), true);
  assert.equal(source.includes("chapterStatusComplete || isVisibleQuestionFallbackState(visibleContentState) ? 'finished-job' : visibleContentState"), false);
  assert.equal(source.includes('检测到页面存在可处理内容，但当前未识别为标准任务点。'), true);
});

test('cx patches result panel with inferred work type when answer search type is unknown', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('const inferredType = currentRoot ? resolveQuestionTypeForWork(currentRoot, {'), true);
  assert.equal(source.includes('type: normalizeResultQuestionType(inferredType) ?? normalizeResultQuestionType(type) ?? curr.ctx?.type ?? previousType ?? undefined,'), true);
  assert.equal(source.includes('manual: detectManualAnswer(currentRoot, type, {'), true);
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

test('cx chapter test does not auto-submit when finished rate is zero and uploadable is false', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('async callback(finishedRate, uploadable) {'), true);
  assert.equal(source.includes("const shouldSubmit = upload === 'submit' && uploadable;"), true);
  assert.equal(source.includes("const uploadMsg = `完成率 ${finishedRate.toFixed(2)}% : 3秒后将自动${shouldSubmit ? '提交' : '保存'}`;"), true);
  assert.equal(source.includes('(frameWindow as Record<string, any>).noSubmit?.();'), true);
});

test('cx chapter answerer can append ai fallback results and random fallback handling', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('enableRandomFallbackAnswer'), true);
  assert.equal(source.includes('enableAIFallbackAnswer'), true);
  assert.equal(source.includes('requestTikuAdapterAIFallback'), true);
  assert.equal(source.includes('随机作答'), true);
});

test('cx keeps task scanning compatible with verbose diagnostics and resolves job ids from frame data or iframe attributes', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes("const prefix = `[Chaoxing Plus][${nextDebugSequence()}] ${label}`;"), true);
  assert.equal(source.includes("const targetJobId = frameData.jobid || frameData._jobid || root.getAttribute('jobid') || root.getAttribute('_jobid');"), true);
  assert.equal(source.includes('await JobRunner.media(opts, win.document, attachment);'), true);
});

test('cx logs action nodes for media, answering, submit, and next-step transitions with correlation ids', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('动作节点诊断：开始媒体任务'), true);
  assert.equal(source.includes('动作节点诊断：开始章节答题'), true);
  assert.equal(source.includes('动作节点诊断：答题结果已生成'), true);
  assert.equal(source.includes('动作节点诊断：准备提交或保存'), true);
  assert.equal(source.includes('动作节点诊断：执行提交'), true);
  assert.equal(source.includes('动作节点诊断：执行保存'), true);
  assert.equal(source.includes('动作节点诊断：准备自动跳转'), true);
  assert.equal(source.includes('动作节点诊断：执行下一章跳转'), true);
  assert.equal(source.includes('动作节点诊断：开始作业/考试答题'), true);
  assert.equal(source.includes('动作节点诊断：作业/考试答题完成'), true);
  assert.equal(source.includes('动作节点诊断：开始逐题切换答题'), true);
  assert.equal(source.includes('动作节点诊断：执行下一题切换'), true);
  assert.equal(source.includes('动作节点诊断：开始单题重答'), true);
  assert.equal(source.includes('动作节点诊断：单题重答完成'), true);
});

test('cx uses synthetic click dispatch for answering and next-question switching instead of raw click only', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('function triggerSyntheticClick('), true);
  assert.equal(source.includes("element.dispatchEvent(new MouseEvent('mousedown', sharedEventInit));"), true);
  assert.equal(source.includes("element.dispatchEvent(new MouseEvent('mouseup', sharedEventInit));"), true);
  assert.equal(source.includes("element.dispatchEvent(new MouseEvent('click', sharedEventInit));"), true);
  assert.equal(source.includes('triggerSyntheticClick(next);'), true);
});

test('cx chapter answering uses the current question type input directly instead of falling back to the whole frame', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('const typeInput = elements.type[0] as HTMLInputElement | undefined;'), true);
  assert.equal(source.includes('const questionType = typeInput ? getQuestionType(parseInt(typeInput.value, 10)) : undefined;'), true);
  assert.equal(source.includes('const type = typeInput ? getQuestionType(parseInt(typeInput.value, 10)) : undefined;'), true);
  assert.equal(source.includes('章节测试单题结果诊断'), true);
});

test('cx retries chapter answers with AI fallback when submit popup says the score is below passing', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('function detectChapterRetakePrompt() {'), true);
  assert.equal(source.includes("const popup = topWindow.document.querySelector<HTMLElement>('#workpop');"), true);
  assert.equal(source.includes("const popupContent = topWindow.document.querySelector<HTMLElement>('#popcontent')?.textContent?.trim() ?? '';"), true);
  assert.equal(source.includes("popupContent.includes('未达到及格线')"), true);
  assert.equal(source.includes("popupContent.includes('请重做')"), true);
  assert.equal(source.includes('const retakeRequired = detectChapterRetakePrompt();'), true);
  assert.equal(source.includes('const aiRetryWorker = createChapterWorker(roots, { forceAIFallbackOnly: true, skipCache: true });'), true);
  assert.equal(source.includes('const retryResults = await aiRetryWorker.doWork();'), true);
  assert.equal(source.includes('正在使用 AI 兜底答案尝试二次改答'), true);
});

test('cx defers chapter cache writes until submit succeeds without a retake prompt', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('onCacheableResult?: (result: SimplifyWorkResult) => void;'), true);
  assert.equal(source.includes('const cacheableResults: SimplifyWorkResult[] = [];'), true);
  assert.equal(source.includes('workerOptions.onCacheableResult?.(currentSimplified);'), true);
  assert.equal(source.includes('appsMethods().addQuestionCacheFromWorkResult?.(cacheableResults);'), true);
  assert.equal(source.includes('appsMethods().addQuestionCacheFromWorkResult?.(simplified.filter((_, index) => index === res.indexOf(curr)));'), false);
});

test('cx preserves previously detected question types when later result patches cannot infer them', async () => {
  const source = await readFile(cxPath, 'utf8');

  assert.equal(source.includes('const currentResults = workResultsMethods().getResults?.();'), true);
  assert.equal(source.includes('const previousType = currentResults?.[currentIndex]?.type;'), true);
  assert.equal(source.includes('type: normalizeResultQuestionType(inferredType) ?? normalizeResultQuestionType(type) ?? curr.ctx?.type ?? previousType ?? undefined,'), true);
  assert.equal(source.includes('type: normalizeResultQuestionType(inferredType) ?? normalizeResultQuestionType(questionType) ?? current.ctx?.type ?? previousType ?? undefined,'), true);
});

test('common preserves previously detected question types when incoming simplified results omit type', async () => {
  const commonSource = await readFile(resolve(scriptsDir, '..', 'src', 'projects', 'common.ts'), 'utf8');

  assert.equal(commonSource.includes('type: item.type ?? state.workResults.results[index]?.type,'), true);
});

test('common formats question types with Chinese labels in the result panel', async () => {
  const commonSource = await readFile(resolve(scriptsDir, '..', 'src', 'projects', 'common.ts'), 'utf8');
  const statusSource = await readFile(resolve(scriptsDir, '..', 'src', 'projects', 'work-results-status.ts'), 'utf8');

  assert.equal(statusSource.includes("single: '单选'"), true);
  assert.equal(statusSource.includes("multiple: '多选'"), true);
  assert.equal(statusSource.includes("judgement: '判断'"), true);
  assert.equal(statusSource.includes("completion: '填空'"), true);
  assert.equal(commonSource.includes('formatQuestionTypeLabel(result.type)'), true);
  assert.equal(commonSource.includes("text: result.type ? `题型：${formatQuestionTypeLabel(result.type)}` : '题型：未识别'"), true);
});

