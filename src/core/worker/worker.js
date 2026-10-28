import { CommonEventEmitter } from '../utils/event.js';
import { sleep } from '../../runtime/dom.js';
import { domSearchAll } from '../utils/dom';
import { resolveWorkerThreadCount } from './interface';
import { createDefaultQuestionResolver } from './question.resolver';
import { defaultWorkTypeResolver } from './utils';
import { AnswerWrapperHandlerConfig } from '../answer-wrapper';
export class OCSWorker extends CommonEventEmitter {
    constructor(opts) {
        super();
        this.isRunning = false;
        this.isClose = false;
        this.isStop = false;
        this.totalQuestionCount = 0;
        this.opts = opts;
    }
    async doWork(options) {
        try {
            return await this.runWork(options);
        }
        finally {
            this.isRunning = false;
            this.emit('settled');
        }
    }
    async runWork(options) {
        this.emit('start');
        this.isRunning = true;
        const closeController = new AbortController();
        this.once('close', () => {
            this.isClose = true;
            closeController.abort();
        });
        this.on('stop', () => {
            this.isStop = true;
        });
        this.on('continuate', () => {
            this.isStop = false;
        });
        const waitForTask = (task, timeoutMs) => new Promise((resolve, reject) => {
            const signal = closeController.signal;
            if (this.isClose || signal.aborted) {
                reject(new Error('答题已关闭。'));
                return;
            }
            let timeout;
            const cleanup = () => {
                signal.removeEventListener('abort', onClose);
                if (timeout !== undefined)
                    clearTimeout(timeout);
            };
            const onClose = () => {
                cleanup();
                reject(new Error('答题已关闭。'));
            };
            signal.addEventListener('abort', onClose, { once: true });
            if (timeoutMs !== undefined) {
                timeout = setTimeout(() => {
                    cleanup();
                    reject(new Error('答题超时！'));
                }, timeoutMs);
            }
            Promise.resolve().then(() => {
                if (this.isClose || signal.aborted)
                    throw new Error('答题已关闭。');
                return task();
            }).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
        });
        const waitForWorkerContinue = () => waitForTask(() => waitForContinuate(() => this.isStop && !this.isClose));
        const questionRoots = typeof this.opts.root === 'string' ? Array.from(document.querySelectorAll(this.opts.root)) : this.opts.root;
        this.totalQuestionCount += questionRoots.length;
        if (options?.enable_debug) {
            console.debug('开始答题', this);
            console.debug('题目数量: ', questionRoots.length);
            console.debug('父节点列表: ', questionRoots);
        }
        const results = [];
        if (questionRoots.length === 0) {
            throw new Error('未找到任何题目，答题结束。');
        }
        for (const questionRoot of questionRoots) {
            const ctx = {
                searchInfos: [],
                root: questionRoot,
                elements: domSearchAll(this.opts.elements, questionRoot),
                type: undefined,
                waitForContinue: waitForWorkerContinue,
                answerSeparators: this.opts.answerSeparators,
                answerMatchMode: this.opts.answerMatchMode || 'similar'
            };
            await this.opts.onElementSearched?.(ctx.elements, questionRoot);
            ctx.elements.title = ctx.elements.title?.filter(Boolean);
            ctx.elements.options = ctx.elements.options?.filter(Boolean);
            if (typeof this.opts.work === 'object') {
                ctx.type =
                    this.opts.work.type === undefined
                        ? defaultWorkTypeResolver(ctx)
                        : typeof this.opts.work.type === 'string'
                            ? this.opts.work.type
                            : this.opts.work.type(ctx);
            }
            results.push({
                requested: false,
                resolved: false,
                ctx: ctx
            });
        }
        if (options?.enable_debug) {
            console.debug('上下文已初始化: ', results);
        }
        await this.opts.onResultsInitialized?.(results);
        const requestCompleted = [];
        const requestCompletions = results.map((_result, index) => new Promise((resolve) => {
            requestCompleted[index] = resolve;
        }));
        const requestThread = async (index) => {
            let error;
            const result = results[index];
            const ctx = result.ctx || {};
            if (this.isClose === true) {
                this.isRunning = false;
                return;
            }
            ctx.searchInfos = [];
            try {
                if (this.isStop)
                    await waitForWorkerContinue();
                if (this.opts.beforeSearch) {
                    await waitForTask(() => this.opts.beforeSearch(ctx, closeController.signal));
                }
                if (this.isStop)
                    await waitForWorkerContinue();
                if (this.isClose)
                    return;
                result.searching = true;
                await waitForTask(() => this.opts.onResultsUpdate?.(result, index, results));
                if (options?.enable_debug) {
                    console.groupEnd();
                    console.group('开始搜题: ', ctx.elements.title
                        ?.map((t) => t?.innerText)
                        .filter(Boolean)
                        .join(', ')
                        .slice(0, 20));
                    console.log('ctx', result.ctx);
                }
                // Queuing and manual authorization must not consume the search deadline.
                // Race the answerer itself so a late response cannot replace a timeout.
                ctx.searchInfos = (await waitForTask(() => this.opts.answerer(ctx.elements, ctx), (AnswerWrapperHandlerConfig.timeout_seconds + 10) * 1000)) || [];
                ctx.searchInfos.forEach((info) => {
                    info.results = info.results.map((ans) => {
                        ans.answer = ans.answer ? ans.answer.trim() : '';
                        return ans;
                    });
                });
            }
            catch (err) {
                error = String(err);
            }
            if (this.isClose)
                return;
            result.ctx = ctx;
            result.searching = false;
            result.requested = true;
            result.error = error;
            requestCompleted[index]();
            if (options?.enable_debug) {
                console.log('搜题结果: ', ctx.searchInfos);
            }
            await this.opts.onResultsUpdate?.(results[index], index, results);
        };
        const waitForRequested = (index) => waitForTask(() => requestCompletions[index]);
        const resolverThread = async () => {
            for (let index = 0; index < results.length; index++) {
                const result = results[index];
                let error;
                let res;
                if (this.isClose === true) {
                    this.isRunning = false;
                    return;
                }
                try {
                    if (this.isStop) {
                        await waitForWorkerContinue();
                    }
                    await waitForRequested(index);
                    // A balance error can stop the worker while the search request is in
                    // flight. Re-check immediately after it completes so the resolver
                    // cannot apply an answer before the user explicitly resumes.
                    if (this.isStop) {
                        await waitForWorkerContinue();
                    }
                }
                catch {
                    if (this.isClose)
                        return;
                }
                if (this.isClose)
                    return;
                try {
                    if (this.isStop) {
                        await waitForWorkerContinue();
                    }
                    if (this.isClose)
                        return;
                    const ctx = result.ctx;
                    if (ctx && ctx.searchInfos.length !== 0) {
                        if (typeof this.opts.work === 'object') {
                            if (ctx.elements.options) {
                                if (ctx.type) {
                                    const resolver = createDefaultQuestionResolver(ctx)[ctx.type];
                                    const handler = this.opts.work.handler;
                                    res = await waitForTask(() => resolver(ctx.searchInfos, ctx.elements.options, handler));
                                }
                                else {
                                    error = '题目类型解析失败, 请自行提供解析器, 或者忽略此题。';
                                }
                            }
                            else {
                                error = 'elements.options 为空 ! 使用默认处理器, 必须提供题目选项的选择器。';
                            }
                        }
                        else {
                            const work = this.opts.work;
                            res = await waitForTask(() => work(ctx));
                        }
                    }
                    else {
                        error = result.error ?? '搜索不到答案, 请重新运行, 或者忽略此题。';
                    }
                }
                catch (err) {
                    error = err?.message || String(err);
                }
                if (this.isClose)
                    return;
                if (this.isStop)
                    await waitForWorkerContinue().catch(() => { });
                if (this.isClose)
                    return;
                if (!error && res && res.finish === false) {
                    error = result.ctx?.searchInfos
                        ?.map((info) => info.error)
                        .find((message) => Boolean(message));
                }
                result.error = error;
                result.result = res || { finish: false };
                result.resolved = true;
                if (options?.enable_debug) {
                    console.log('答题完成: ', result.ctx?.elements.title
                        ?.map((t) => t?.innerText)
                        .join(', ')
                        .slice(0, 20), result);
                }
                await this.opts.onResultsUpdate?.(result, index, results);
            }
        };
        const requestThreadHandler = async () => {
            const threadCount = resolveWorkerThreadCount(this.opts.thread);
            let nextIndex = 0;
            await Promise.all(Array.from({ length: threadCount }, async () => {
                while (nextIndex < results.length && !this.isClose) {
                    const index = nextIndex++;
                    await requestThread(index);
                }
            }));
        };
        const resolvedResults = await Promise.all([resolverThread(), requestThreadHandler()]);
        this.isRunning = false;
        this.emit('done');
        return results ?? resolvedResults;
    }
    uploadHandler(options) {
        const { results, type, callback } = options;
        if (type !== 'nomove') {
            let finished = 0;
            for (const result of results) {
                if (result.result?.finish) {
                    finished++;
                }
            }
            const rate = results.length === 0 ? 0 : (finished / results.length) * 100;
            if (type === 'force') {
                return callback(rate, true);
            }
            else {
                return callback(rate, type === 'save' ? false : rate >= parseFloat(type.toString()));
            }
        }
        return undefined;
    }
}
export class CustomOCSWorker extends CommonEventEmitter {
    constructor(opts) {
        super();
        this.isRunning = false;
        this.isClose = false;
        this.isStop = false;
        this.opts = opts;
    }
    async doWork(options) {
        this.emit('start');
        this.isRunning = true;
        this.once('close', () => {
            this.isClose = true;
        });
        this.on('stop', () => {
            this.isStop = true;
        });
        this.on('continuate', () => {
            this.isStop = false;
        });
        const questions = await this.opts.questions?.();
        if (options?.enable_debug) {
            console.debug('开始答题', this);
            console.debug('题目数量: ', questions.length);
        }
        const results = [];
        for (let index = 0; index < questions.length; index++) {
            if (this.isClose === true) {
                this.isRunning = false;
                return;
            }
            if (this.isStop) {
                await waitForContinuate(() => this.isStop);
            }
            const question = questions[index];
            results[index] = {
                question: question.text,
                requested: false,
                resolved: false,
                searchInfos: [],
                type: question.type,
                finish: false,
                error: ''
            };
            try {
                const infos = await this.opts.answerer(question.text);
                results[index].searchInfos = infos.map((i) => ({
                    name: i.name,
                    homepage: i.homepage,
                    results: i.results.map((r) => [r.question, r.answer, r.extra_data || {}]),
                    error: i.error
                }));
                results[index].requested = true;
                this.opts.onResultsUpdate?.(results[index], index, results);
                try {
                    const resolved = await this.opts.resolver(infos);
                    results[index].finish = resolved.finish;
                    results[index].error = resolved.error;
                    results[index].resolved = true;
                }
                catch (err) {
                    results[index].finish = false;
                    results[index].error = err instanceof Error ? err.message : String(err);
                    results[index].resolved = true;
                }
                this.opts.onResultsUpdate?.(results[index], index, results);
            }
            catch (err) {
                results[index].requested = true;
                results[index].resolved = false;
                results[index].finish = true;
                results[index].error = err instanceof Error ? err.message : String(err);
                this.opts.onResultsUpdate?.(results[index], index, results);
            }
            await sleep(this.opts.period);
        }
        this.isRunning = false;
        this.emit('done');
        return results;
    }
}
async function waitForContinuate(isStopping) {
    if (isStopping()) {
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                if (isStopping() === false) {
                    clearInterval(interval);
                    resolve();
                }
            }, 200);
        });
    }
}
