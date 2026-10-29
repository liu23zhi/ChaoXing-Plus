// Phase-two design prototype; stage-one CLI/JSON requests remain explicitly disabled.
import path from 'node:path';
import { promises as fs } from 'node:fs';

const FAILURE_POLICIES = new Set(['retry', 'background', 'ignore', 'abort']);
const MAX_RETRIES = 20;
const MAX_RUNTIME_INTERVAL_MS = 24 * 60 * 60 * 1000;

function normalizeOwnedFiles(value) {
  if (!Array.isArray(value)) throw new TypeError('ownedFiles 必须是绝对文件路径数组');
  const unique = new Map();
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !candidate.trim() || !path.isAbsolute(candidate)) {
      throw new TypeError('ownedFiles 只能包含非空绝对文件路径');
    }
    const filePath = path.resolve(candidate);
    const basename = path.win32.basename(filePath).replace(/[ .]+$/gu, '').toLowerCase();
    if (/^cxexam\.exe(?:$|[:.])/u.test(basename) || /^cxexam~\d+(?:\.|$)/u.test(basename)) {
      throw new Error('禁止登记 CXExam.exe 清理目标');
    }
    const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
    unique.set(key, filePath);
  }
  return [...unique.values()];
}

function validateOptions(options) {
  const failurePolicy = options.failurePolicy || 'retry';
  if (!FAILURE_POLICIES.has(failurePolicy)) {
    throw new TypeError(`failurePolicy 必须是 ${[...FAILURE_POLICIES].join('|')}`);
  }

  const retries = options.retries === undefined ? 5 : options.retries;
  if (!Number.isInteger(retries) || retries < 1 || retries > MAX_RETRIES) {
    throw new RangeError(`retries 必须是 1 到 ${MAX_RETRIES} 之间的整数`);
  }

  const retryDelayMs = options.retryDelayMs === undefined ? 200 : options.retryDelayMs;
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 50 || retryDelayMs > 5000) {
    throw new RangeError('retryDelayMs 必须是 50 到 5000 之间的整数');
  }

  const runtimeRetry = options.runtimeRetry === undefined ? true : options.runtimeRetry;
  if (typeof runtimeRetry !== 'boolean') throw new TypeError('runtimeRetry 必须是布尔值');

  const runtimeIntervalMs = options.runtimeIntervalMs === undefined ? 30000 : options.runtimeIntervalMs;
  if (!Number.isInteger(runtimeIntervalMs) || runtimeIntervalMs < 1 || runtimeIntervalMs > MAX_RUNTIME_INTERVAL_MS) {
    throw new RangeError(`runtimeIntervalMs 必须是 1 到 ${MAX_RUNTIME_INTERVAL_MS} 之间的整数`);
  }

  if (options.onEvent !== undefined && typeof options.onEvent !== 'function') {
    throw new TypeError('onEvent 必须是函数');
  }

  return { failurePolicy, retries, retryDelayMs, runtimeRetry, runtimeIntervalMs };
}

export class WipeAbortedError extends Error {
  constructor(summary) {
    super('启动清理失败，按 abort 策略中止');
    this.name = 'WipeAbortedError';
    this.summary = summary;
  }
}

export function createWipeController(options = {}, dependencies = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('清理器选项必须是对象');
  }
  const ownedFiles = normalizeOwnedFiles(options.ownedFiles || []);
  const settings = validateOptions(options);
  const unlink = dependencies.unlink || ((filePath) => fs.unlink(filePath));
  const delay = dependencies.delay || ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
  const schedule = dependencies.setTimeout || setTimeout;
  const cancel = dependencies.clearTimeout || clearTimeout;
  if (typeof unlink !== 'function' || typeof delay !== 'function' || typeof schedule !== 'function' || typeof cancel !== 'function') {
    throw new TypeError('清理器依赖必须是函数');
  }

  const deleted = new Set();
  const pending = new Set();
  const failures = new Map();
  const backgroundAttempts = new Map();
  let started = false;
  let closed = false;
  let timer = null;
  let activePass = null;
  let lastStatus = 'idle';

  const summary = (status) => ({
    status,
    deleted: [...deleted],
    pending: [...pending],
    failures: [...failures.entries()].map(([filePath, error]) => ({ path: filePath, error }))
  });

  const startPass = (run) => {
    const pass = run().finally(() => {
      if (activePass === pass) activePass = null;
    });
    activePass = pass;
    void pass;
  };

  const emit = (type, detail = {}) => {
    if (typeof options.onEvent !== 'function') return;
    try {
      const result = options.onEvent({ type, ...detail });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Logging and observers must not change cleanup behavior.
    }
  };

  const tryUnlink = async (filePath, attempt, phase) => {
    if (closed) return false;
    try {
      await unlink(filePath);
      deleted.add(filePath);
      pending.delete(filePath);
      failures.delete(filePath);
      emit('deleted', { path: filePath, attempt, phase });
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        deleted.add(filePath);
        pending.delete(filePath);
        failures.delete(filePath);
        emit('deleted', { path: filePath, attempt, phase, alreadyMissing: true });
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      failures.set(filePath, message);
      pending.add(filePath);
      emit('failure', { path: filePath, attempt, phase, error: message });
      return false;
    }
  };

  const runRuntimePass = async () => {
    timer = null;
    if (closed || pending.size === 0) return;
    for (const filePath of [...pending]) await tryUnlink(filePath, 1, 'runtime');
    if (closed) return;
    if (pending.size === 0) {
      lastStatus = 'complete';
      emit('complete', { summary: summary(lastStatus) });
      return;
    }
    scheduleRuntimePass();
  };

  const runBackgroundPass = async () => {
    if (closed || pending.size === 0) return;
    for (const filePath of [...pending]) {
      if (closed) return;
      const nextAttempt = (backgroundAttempts.get(filePath) || 1) + 1;
      backgroundAttempts.set(filePath, nextAttempt);
      await tryUnlink(filePath, nextAttempt, 'background');
    }
    if (closed) return;
    if (pending.size === 0) {
      lastStatus = 'complete';
      emit('complete', { summary: summary(lastStatus) });
      return;
    }
    scheduleBackgroundPass();
  };

  const scheduleBackgroundPass = () => {
    if (closed || timer || pending.size === 0) return;
    timer = schedule(() => {
      timer = null;
      startPass(runBackgroundPass);
    }, settings.retryDelayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  const scheduleRuntimePass = () => {
    if (closed || timer || pending.size === 0 || !settings.runtimeRetry) return;
    timer = schedule(() => {
      timer = null;
      startPass(runRuntimePass);
    }, settings.runtimeIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  return {
    async start() {
      if (started) throw new Error('清理器只能启动一次');
      started = true;
      emit('start', { files: [...ownedFiles] });

      for (const filePath of ownedFiles) {
        const maxAttempts = settings.failurePolicy === 'retry' ? settings.retries : 1;
        let succeeded = false;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          succeeded = await tryUnlink(filePath, attempt, 'startup');
          if (succeeded) break;
          if (settings.failurePolicy === 'abort') {
            const result = summary('aborted');
            emit('aborted', { summary: result });
            throw new WipeAbortedError(result);
          }
          if (attempt < maxAttempts) await delay(settings.retryDelayMs);
        }
        if (!succeeded && settings.failurePolicy === 'background') backgroundAttempts.set(filePath, 1);
        if (!succeeded && settings.failurePolicy === 'ignore') pending.delete(filePath);
      }

      const hasIgnoredFailure = settings.failurePolicy === 'ignore' && failures.size > 0;
      if (pending.size > 0 && settings.failurePolicy === 'background') {
        scheduleBackgroundPass();
        lastStatus = 'retrying';
        const result = summary(lastStatus);
        emit('pending', { summary: result });
        return result;
      }
      if (pending.size > 0 && settings.runtimeRetry && settings.failurePolicy === 'retry') {
        scheduleRuntimePass();
        lastStatus = 'retrying';
        const result = summary(lastStatus);
        emit('pending', { summary: result });
        return result;
      }
      lastStatus = hasIgnoredFailure ? 'ignored' : pending.size ? 'failed' : 'complete';
      const result = summary(lastStatus);
      emit(result.status === 'complete' ? 'complete' : 'finished', { summary: result });
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) cancel(timer);
      timer = null;
      if (pending.size > 0) lastStatus = 'closed';
      if (activePass) await activePass;
    },
    getSummary() {
      return summary(lastStatus);
    }
  };
}
