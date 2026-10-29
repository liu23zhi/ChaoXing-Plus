import { promises as fs } from 'node:fs';
import path from 'node:path';

// 程序/数据清理：仅删除发布包登记的程序负载与宿主数据，绝不触碰 CXExam。
// 源码仓库或没有 SHA256SUMS.txt 的布局只允许模拟，避免误删工作区。

const HASH_LINE = /^[a-fA-F0-9]{64}\s+\*?(.+)$/u;
const CLIENT_NAME = /^cxexam(?:\.exe|~\d+(?:\.|$))/iu;

function normalizeRelative(value) {
  const text = String(value || '').replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (!text || text.startsWith('/') || /^[a-zA-Z]:/u.test(text) || text.split('/').includes('..')) return '';
  return text;
}

function isClientBasename(value) {
  return CLIENT_NAME.test(path.win32.basename(String(value || '')));
}

// 自带 Node 运行时（runtime\node.exe）不属于"程序痕迹"：它正在执行本进程，
// 删除必然失败，也不该被反复重试；CXExam 同理永不触碰。
function isRuntimePath(value) {
  const normalized = String(value || '').replace(/\\/gu, '/').toLowerCase();
  return /(?:^|\/)runtime\/node\.exe$/u.test(normalized);
}

function isProtectedPath(value) {
  return isClientBasename(value) || isRuntimePath(value);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function walkFiles(root) {
  const result = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) result.push(...await walkFiles(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

export async function listProgramFiles(appRoot) {
  const root = path.resolve(appRoot);
  const sums = await readText(path.join(root, 'SHA256SUMS.txt'));
  if (!sums) return { root, releaseLayout: false, files: [] };
  const files = new Set();
  for (const line of sums.split(/\r?\n/u)) {
    const match = line.trim().match(HASH_LINE);
    if (!match) continue;
    const relative = normalizeRelative(match[1]);
    if (!relative) continue;
    const absolute = path.resolve(root, relative);
    if (!isInside(root, absolute)) continue;
    if (isProtectedPath(absolute)) continue;
    files.add(absolute);
  }
  // SHA 自身、release-info 和校验器也属于发布痕迹；缺失时补入。
  for (const name of ['SHA256SUMS.txt', 'release-info.json', 'verify-release.mjs']) {
    const absolute = path.join(root, name);
    try {
      const stat = await fs.lstat(absolute);
      if (stat.isFile() && !isProtectedPath(absolute)) files.add(absolute);
    } catch {
      // ignore
    }
  }
  return { root, releaseLayout: files.size > 0, files: [...files] };
}

export async function listHostDataFiles(appRoot, dataDirectory) {
  const root = path.resolve(appRoot);
  const dataRoot = path.resolve(dataDirectory);
  if (!isInside(root, dataRoot) && path.resolve(root) !== dataRoot) return [];
  const files = await walkFiles(dataRoot);
  return files.filter((filePath) => !isProtectedPath(filePath)).sort();
}

export function createProgramCleanupController({
  appRoot,
  dataDirectory,
  simulate = false,
  retries = 5,
  retryDelayMs = 200,
  runtimeRetryMs = 5000,
  logger = () => {},
  fsImpl = fs,
  schedule = setTimeout,
  cancel = clearTimeout
} = {}) {
  if (!appRoot) throw new TypeError('程序清理需要 appRoot');
  let files = [];
  let started = false;
  let closed = false;
  let timer = null;
  let activePass = null;
  const deleted = new Set();
  const pending = new Set();
  const failures = new Map();

  const emit = (type, detail = {}) => {
    try { logger({ type, ...detail }); } catch { /* observers cannot break cleanup */ }
  };
  const summary = (status = 'idle') => ({
    status,
    simulate,
    total: files.length,
    deleted: [...deleted],
    pending: [...pending],
    failures: [...failures.entries()].map(([filePath, error]) => ({ path: filePath, error }))
  });

  async function unlinkOne(filePath, attempt, phase) {
    if (closed) return false;
    try {
      if (!simulate) {
        await fsImpl.rm(filePath, { force: true, maxRetries: 0 });
      }
      deleted.add(filePath);
      pending.delete(filePath);
      failures.delete(filePath);
      emit('deleted', { path: filePath, attempt, phase, simulate });
      return true;
    } catch (error) {
      const code = error && error.code;
      if (code === 'ENOENT') {
        deleted.add(filePath);
        pending.delete(filePath);
        failures.delete(filePath);
        emit('deleted', { path: filePath, attempt, phase, alreadyMissing: true, simulate });
        return true;
      }
      failures.set(filePath, error && error.message ? error.message : String(error));
      pending.add(filePath);
      emit('failure', { path: filePath, attempt, phase, error: failures.get(filePath), simulate });
      return false;
    }
  }

  async function runPass(phase) {
    if (closed) return summary('closed');
    for (const filePath of files) {
      if (closed) break;
      if (deleted.has(filePath)) continue;
      let succeeded = false;
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        succeeded = await unlinkOne(filePath, attempt, phase);
        if (succeeded) break;
        if (attempt < retries) await new Promise((resolve) => schedule(resolve, retryDelayMs));
      }
    }
    const status = pending.size === 0 ? 'complete' : 'retrying';
    emit('pass', { status, summary: summary(status) });
    return summary(status);
  }

  function scheduleRuntimeRetry() {
    if (closed || timer || pending.size === 0) return;
    timer = schedule(async () => {
      timer = null;
      if (closed || pending.size === 0) return;
      activePass = runRuntime();
      await activePass;
    }, runtimeRetryMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function runRuntime() {
    for (const filePath of [...pending]) {
      if (closed) return;
      await unlinkOne(filePath, 1, 'runtime');
    }
    if (pending.size === 0) emit('pass', { status: 'complete', summary: summary('complete') });
    else scheduleRuntimeRetry();
  }

  return {
    get summary() { return summary(started ? 'started' : 'idle'); },
    async start() {
      if (started) throw new Error('程序清理只能启动一次');
      started = true;
      const program = await listProgramFiles(appRoot);
      const data = await listHostDataFiles(appRoot, dataDirectory);
      // 程序文件先删，宿主数据后删；模拟模式只记录计划。
      files = [...new Set([...program.files, ...data])].filter((filePath) => !isProtectedPath(filePath));
      emit('start', {
        simulate,
        releaseLayout: program.releaseLayout,
        programCount: program.files.length,
        dataCount: data.length,
        files: files.slice()
      });
      if (!program.releaseLayout && !simulate) {
        // 源码仓库或非发布布局：绝不删除程序文件，只允许模拟计划；
        // 调用方通过 summary.releaseLayout=false 判断并提示。
        files = data.slice();
        emit('untrusted-layout', { appRoot });
      }
      const result = await runPass('startup');
      if (result.pending > 0 || pending.size > 0) scheduleRuntimeRetry();
      return result;
    },
    async finalPass() {
      if (!started || closed) return summary(closed ? 'closed' : 'idle');
      if (timer) { cancel(timer); timer = null; }
      const result = await runPass('final');
      if (pending.size === 0) emit('complete', { summary: result });
      return result;
    },
    async close() {
      closed = true;
      if (timer) cancel(timer);
      timer = null;
      if (activePass) await activePass.catch(() => {});
      return summary('closed');
    },
    getSummary: () => summary(started ? 'started' : 'idle')
  };
}

