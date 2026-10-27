import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const defaultSelectionWindowScript = fileURLToPath(new URL('./selection-window.ps1', import.meta.url));
export const WINDOW_TIMEOUT_MS = 5 * 60 * 1000;

export function isNativeSelectionWindowSupported(platform = process.platform) {
  return platform === 'win32';
}

export function parseSelectionWindowResult(text) {
  let value;
  try {
    value = JSON.parse(String(text || '').replace(/^\uFEFF/u, ''));
  } catch {
    return { status: 'unavailable', reason: 'invalid-result-json' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'unavailable', reason: 'invalid-result-shape' };
  }
  if (value.error) {
    return { status: 'unavailable', reason: String(value.error) };
  }
  if (value.cancelled === true) {
    return { status: 'cancelled', autoClosed: value.autoClosed === true };
  }
  if (typeof value.path !== 'string' || !value.path.trim()) {
    return { status: 'unavailable', reason: 'missing-selected-path' };
  }
  return {
    status: 'selected',
    path: value.path.trim(),
    index: Number.isInteger(value.index) ? value.index : 0,
    manual: value.manual === true
  };
}

const WINDOW_LABELS = {
  title: '超星学习助手 - 选择考试客户端',
  hint: '请选择要启动的 CXExam.exe 客户端；也可以点击“手动浏览”指定其他位置的 CXExam.exe。',
  selectButtonText: '使用所选客户端',
  browseButtonText: '手动浏览…',
  cancelButtonText: '取消',
  fontName: 'Microsoft YaHei UI',
  messages: {
    chooseFirst: '请先选择一个客户端，或点击“手动浏览”指定 CXExam.exe。',
    mustBeCxExam: '文件名必须是 CXExam.exe。',
    dialogTitle: '选择 CXExam.exe',
    filterPrimary: 'CXExam.exe|CXExam.exe',
    filterAll: '可执行文件 (*.exe)|*.exe'
  }
};

async function invokeSelectionWindow({
  candidates,
  title,
  probe = false,
  autoCloseMs = 0,
  labels = WINDOW_LABELS,
  timeoutMs = WINDOW_TIMEOUT_MS,
  scriptPath = defaultSelectionWindowScript,
  execFileImpl = execFileAsync,
  fsImpl = fs
}) {
  const directory = await fsImpl.mkdtemp(path.join(os.tmpdir(), 'cxplus-selection-'));
  const inputPath = path.join(directory, 'input.json');
  const outputPath = path.join(directory, 'output.json');
  try {
    const payload = {
      title: title || labels.title,
      hint: labels.hint,
      selectButtonText: labels.selectButtonText,
      browseButtonText: labels.browseButtonText,
      cancelButtonText: labels.cancelButtonText,
      fontName: labels.fontName,
      messages: labels.messages,
      candidates: (candidates || []).map((candidate, index) => ({
        path: String(candidate?.path || ''),
        machine: String(candidate?.machine || 'unknown'),
        display: `[ ${index + 1} ] ${String(candidate?.path || '')}（${String(candidate?.machine || 'unknown')}）`
      }))
    };
    await fsImpl.writeFile(inputPath, JSON.stringify(payload), 'utf8');
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-InputPath', inputPath,
      '-OutputPath', outputPath
    ];
    if (probe) args.push('-Probe');
    if (Number.isInteger(autoCloseMs) && autoCloseMs > 0) args.push('-AutoCloseMs', String(autoCloseMs));
    await execFileImpl('powershell.exe', args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    let text = '';
    try {
      text = await fsImpl.readFile(outputPath, 'utf8');
    } catch {
      return { status: 'unavailable', reason: 'missing-output-file' };
    }
    return { status: 'ok', raw: JSON.parse(String(text).replace(/^\uFEFF/u, '')) };
  } catch (error) {
    return { status: 'unavailable', reason: error && error.message ? error.message : String(error) };
  } finally {
    await fsImpl.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

// 显示原生客户端选择窗口；返回 { status: 'selected'|'cancelled'|'unavailable', ... }。
export async function showClientSelectionWindow(options = {}) {
  if (!isNativeSelectionWindowSupported()) {
    return { status: 'unavailable', reason: 'not-windows' };
  }
  if (!Array.isArray(options.candidates) || options.candidates.length === 0) {
    return { status: 'unavailable', reason: 'no-candidates' };
  }
  const invoked = await invokeSelectionWindow({ ...options, probe: false });
  if (invoked.status !== 'ok') return invoked;
  const parsed = parseSelectionWindowResult(JSON.stringify(invoked.raw));
  return parsed;
}

// 自检用：只构建 WinForms 窗口控件，不显示窗口、不阻塞。
export async function probeClientSelectionWindow(options = {}) {
  if (!isNativeSelectionWindowSupported()) {
    return { ok: false, reason: 'not-windows' };
  }
  const invoked = await invokeSelectionWindow({
    ...options,
    candidates: options.candidates || [{ path: 'C:\\Probe\\CXExam.exe', machine: 'x86' }],
    probe: true,
    timeoutMs: options.timeoutMs || 30000
  });
  if (invoked.status !== 'ok') return { ok: false, reason: invoked.reason };
  const raw = invoked.raw || {};
  return {
    ok: raw.probe === true && raw.winformsOk === true,
    reason: raw.winformsOk === true ? '' : 'winforms-probe-failed',
    candidateCount: Number.isInteger(raw.candidateCount) ? raw.candidateCount : 0
  };
}
