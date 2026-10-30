import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildPowerShellScriptArgs } from './embedded-scripts.mjs';

// 全盘扫描期间的独立 WinForms 进度窗口。扫描仍由 Node 宿主执行，窗口只做展示与
// 取消标记，因此不会把递归文件遍历放进 PowerShell 进程；脚本保持纯 ASCII。
export const defaultScanProgressScript = fileURLToPath(new URL('./scan-progress-window.ps1', import.meta.url));
export const SCAN_PROGRESS_LABELS = {
  title: '超星学习助手 - 全盘扫描',
  message: '正在全盘扫描固定磁盘根目录以查找 CXExam.exe，请稍候…',
  detailTemplate: '已检查 {0} 个目录，发现 {1} 个候选。',
  cancelButtonText: '取消扫描',
  fontName: 'Microsoft YaHei UI'
};
const execFileAsync = promisify(execFile);

function normalizeLabels(labels = {}) {
  const merged = { ...SCAN_PROGRESS_LABELS, ...(labels || {}) };
  return {
    title: String(merged.title || SCAN_PROGRESS_LABELS.title),
    message: String(merged.message || SCAN_PROGRESS_LABELS.message),
    detailTemplate: String(merged.detailTemplate || SCAN_PROGRESS_LABELS.detailTemplate),
    cancelButtonText: String(merged.cancelButtonText || SCAN_PROGRESS_LABELS.cancelButtonText),
    fontName: String(merged.fontName || SCAN_PROGRESS_LABELS.fontName)
  };
}

export function buildScanProgressPayload(labels = {}) {
  return {
    ...normalizeLabels(labels),
    iconPath: globalThis.__CX_NODE_SEA__ ? process.execPath
      : fileURLToPath(new URL('../share-file/assets/app-icon.ico', import.meta.url))
  };
}

export function parseScanProgressUpdate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const directoriesVisited = raw.directoriesVisited;
  const candidatesFound = raw.candidatesFound;
  const elapsedMs = raw.elapsedMs;
  if (!Number.isInteger(directoriesVisited) || directoriesVisited < 0) return null;
  if (!Number.isInteger(candidatesFound) || candidatesFound < 0) return null;
  if (!Number.isInteger(elapsedMs) || elapsedMs < 0) return null;
  return { directoriesVisited, candidatesFound, elapsedMs };
}

async function writeJsonAtomic(fsImpl, filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await fsImpl.writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
    await fsImpl.rename(temporary, filePath);
  } catch (error) {
    try { await fsImpl.rm(temporary, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

async function pathExists(fsImpl, target) {
  try {
    await fsImpl.lstat(target);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

// 打开进度窗口。返回 handle.update/close/cancelled；不可用时返回
// {status:'unavailable', reason}，调用方继续无界面的扫描。
export async function openScanProgressWindow({
  labels = {},
  autoCancelMs = 0,
  scriptPath = defaultScanProgressScript,
  platform = process.platform,
  spawnImpl = spawn,
  fsImpl = fs,
  tmpRoot = os.tmpdir(),
  pollIntervalMs = 200,
  closeTimeoutMs = 4000,
  killGraceMs = 1500
} = {}) {
  if (platform !== 'win32') return { status: 'unavailable', reason: 'not-windows' };
  let directory = '';
  try {
    directory = await fsImpl.mkdtemp(path.join(tmpRoot, 'cx-scan-progress-'));
  } catch (error) {
    return { status: 'unavailable', reason: `progress-temp-failed: ${error.message}` };
  }
  const payloadFile = path.join(directory, 'payload.json');
  const stateFile = path.join(directory, 'state.json');
  const cancelFile = path.join(directory, 'cancel.marker');
  const cleanup = async () => {
    try { await fsImpl.rm(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  try {
    await fsImpl.writeFile(payloadFile, `${JSON.stringify(buildScanProgressPayload(labels))}\n`, 'utf8');
  } catch (error) {
    await cleanup();
    return { status: 'unavailable', reason: `progress-payload-failed: ${error.message}` };
  }
  const args = [
    '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
    ...buildPowerShellScriptArgs('scan-progress-window.ps1', scriptPath, {
      defaultScriptPath: defaultScanProgressScript,
      parameters: [
        ['PayloadFile', payloadFile],
        ['StateFile', stateFile],
        ['CancelFile', cancelFile],
        ['AutoCancelMs', Number.isInteger(autoCancelMs) && autoCancelMs > 0 ? autoCancelMs : undefined]
      ]
    })
  ];

  let child;
  try {
    child = spawnImpl('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    await cleanup();
    return { status: 'unavailable', reason: `progress-spawn-failed: ${error.message}` };
  }
  let stderr = '';
  try {
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });
  } catch { /* ignore stderr capture failures */ }

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code) => resolve({ code }));
    child.once('error', (error) => resolve({ error }));
  });
  const spawned = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    child.once('spawn', () => finish(true));
    child.once('error', () => finish(false));
    setTimeout(() => finish(child.pid !== undefined), 1500).unref?.();
  });
  if (!spawned) {
    await cleanup();
    return { status: 'unavailable', reason: `progress-spawn-failed: ${stderr.trim() || 'spawn-error'}` };
  }

  let closed = false;
  let cancelledByUser = false;
  let resolveCancelled;
  const cancelledPromise = new Promise((resolve) => { resolveCancelled = resolve; });
  const markCancelled = () => {
    if (cancelledByUser) return;
    cancelledByUser = true;
    resolveCancelled(true);
  };
  let pollTimer = null;
  const checkCancel = async () => {
    if (closed || cancelledByUser) return;
    if (await pathExists(fsImpl, cancelFile)) markCancelled();
  };
  pollTimer = setInterval(() => { void checkCancel(); }, Math.max(20, pollIntervalMs));
  pollTimer.unref?.();

  const exitResult = exitPromise.then((value) => {
    if (!cancelledByUser && !closed) resolveCancelled(false);
    return value;
  });

  return {
    status: 'ok',
    paths: { directory, payloadFile, stateFile, cancelFile },
    get cancelledByUser() { return cancelledByUser; },
    cancelled: cancelledPromise,
    async update(progress) {
      if (closed) return false;
      const parsed = parseScanProgressUpdate(progress);
      if (!parsed) return false;
      try {
        await writeJsonAtomic(fsImpl, stateFile, parsed);
        return true;
      } catch {
        return false;
      }
    },
    async close({ cancelled = false } = {}) {
      if (closed) return;
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (cancelled) markCancelled();
      try {
        await writeJsonAtomic(fsImpl, stateFile, { done: true, cancelled });
      } catch { /* ignore; the window also closes on process termination */ }
      await Promise.race([exitResult, sleep(closeTimeoutMs)]);
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch { /* ignore */ }
        await Promise.race([exitResult, sleep(killGraceMs)]);
      }
      if (cancelledByUser) resolveCancelled(true);
      await cleanup();
    }
  };
}

// 自检用：只构建进度窗口控件，不显示窗口、不阻塞。
export async function probeScanProgressWindow({
  scriptPath = defaultScanProgressScript,
  platform = process.platform,
  timeoutMs = 30000,
  execFileImpl = execFileAsync,
  tmpRoot = os.tmpdir()
} = {}) {
  if (platform !== 'win32') return { ok: false, reason: 'not-windows' };
  let directory = '';
  try {
    directory = await fs.mkdtemp(path.join(tmpRoot, 'cx-scan-progress-probe-'));
  } catch (error) {
    return { ok: false, reason: `probe-temp-failed: ${error.message}` };
  }
  try {
    const payloadFile = path.join(directory, 'payload.json');
    await fs.writeFile(payloadFile, `${JSON.stringify(buildScanProgressPayload())}\n`, 'utf8');
    const result = await execFileImpl('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      ...buildPowerShellScriptArgs('scan-progress-window.ps1', scriptPath, {
        defaultScriptPath: defaultScanProgressScript,
        parameters: [
          ['PayloadFile', payloadFile],
          ['StateFile', path.join(directory, 'state.json')],
          ['CancelFile', path.join(directory, 'cancel.marker')],
          ['Probe', true]
        ]
      })
    ], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
    const raw = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/u, ''));
    return {
      ok: raw.probe === true && raw.winformsOk === true,
      reason: raw.winformsOk === true ? '' : (raw.error || 'winforms-probe-failed'),
      hasCancelButton: raw.hasCancelButton === true,
      hasProgressBar: raw.hasProgressBar === true,
      hasDetailLabel: raw.hasDetailLabel === true,
      iconApplied: raw.iconApplied === true
    };
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : String(error) };
  } finally {
    try { await fs.rm(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
