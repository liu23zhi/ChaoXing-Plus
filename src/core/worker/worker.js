import { CommonEventEmitter } from '../utils/event.js';
import { sleep } from '../../runtime/dom.js';
import { domSearchAll } from '../utils/dom';
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
        const requestThread = async (index) => {
            let error;
            const result = results[index];
            const ctx = result.ctx || {};
            if (this.isClose === true) {
                this.isRunning = false;
                return;
            }
            if (this.isStop) {
                await waitForContinuate(() => this.isStop);
            }
            ctx.searchInfos = [];
            if (options?.enable_debug) {
                console.groupEnd();
                console.group('开始搜题: ', ctx.elements.title
                    ?.map((t) => t?.innerText)
                    .filter(Boolean)
                    .join(', ')
                    .slice(0, 20));
                console.log('ctx', result.ctx);
            }
            try {
                ctx.searchInfos = (await this.opts.answerer(ctx.elements, ctx)) || [];
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
            result.ctx = ctx;
            result.requested = true;
            result.error = error;
            if (options?.enable_debug) {
                console.log('搜题结果: ', ctx.searchInfos);
            }
            await this.opts.onResultsUpdate?.(results[index], index, results);
        };
        const waitForRequested = async (result) => {
            return new Promise((resolve, reject) => {
                const interval = setInterval(() => {
                    if (result?.requested === true) {
                        clearInterval(interval);
                        clearTimeout(timeout);
                        resolve();
                    }
                }, 200);
                const timeout = setTimeout(() => {
                    clearInterval(interval);
                    reject(new Error('答题超时！'));
                }, (AnswerWrapperHandlerConfig.timeout_seconds + 10) * 1000);
            });
        };
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
                        await waitForContinuate(() => this.isStop);
                    }
                    await waitForRequested(result);
                }
                catch {
                    // ignore timeout here and let resolver produce final error state
                }
                try {
                    if (result.ctx && result.ctx.searchInfos.length !== 0) {
                        if (typeof this.opts.work === 'object') {
                            if (result.ctx.elements.options) {
                                if (result.ctx.type) {
                                    const resolver = createDefaultQuestionResolver(result.ctx)[result.ctx.type];
                                    const handler = this.opts.work.handler;
                                    res = await resolver(result.ctx.searchInfos, result.ctx.elements.options, handler);
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
                            res = await work(result.ctx);
                        }
                    }
                    else {
                        error = '搜索不到答案, 请重新运行, 或者忽略此题。';
                    }
                }
                catch (err) {
                    error = err?.message || String(err);
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
            const locks = [];
            const waitForLock = () => {
                return new Promise((resolve, reject) => {
                    const interval = setInterval(() => {
                        if (locks.length > 0) {
                            const lock = locks.shift();
                            if (lock) {
                                resolve(lock);
                                clearInterval(interval);
                                clearTimeout(timeout);
                            }
                        }
                    }, 100);
                    const timeout = setTimeout(() => {
                        clearInterval(interval);
                        reject(new Error('获取线程锁超时！'));
                    }, 3 * 60 * 1000);
                });
            };
            const requestThreads = [];
            for (let index = 0; index < results.length; index++) {
                requestThreads.push(() => requestThread(index));
            }
            for (let index = 0; index < (this.opts.thread || 1); index++) {
                locks.push(index + 1);
            }
            let requestFinished = 0;
            const promises = [];
            for (let index = 0; index < (this.opts.thread || 1); index++) {
                promises.push(async () => {
                    try {
                        while (requestFinished < results.length && requestThreads.length > 0 && this.isClose === false) {
                            const thread = requestThreads.shift();
                            if (thread) {
                                const lock = await waitForLock();
                                await thread();
                                requestFinished++;
                                locks.push(lock);
                            }
                        }
                    }
                    catch (err) {
                        console.error(err);
                    }
                });
            }
            await Promise.all(promises.map((f) => f()));
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
