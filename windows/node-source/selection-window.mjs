import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { buildPowerShellScriptArgs } from './embedded-scripts.mjs';

export const defaultSelectionWindowScript = fileURLToPath(new URL('./selection-window.ps1', import.meta.url));
export const WINDOW_TIMEOUT_MS = 5 * 60 * 1000;

function runPowerShell(command, args, { input, timeout, maxBuffer, windowsHide }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false, stdoutBytes = 0, stderrBytes = 0;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('selection-window-timeout')); }, timeout);
    child.on('error', finish);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      stdout += stdoutDecoder.write(chunk);
      if (stdoutBytes > maxBuffer) { child.kill(); finish(new Error('selection-window-output-too-large')); }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      stderr += stderrDecoder.write(chunk);
      if (stderrBytes > maxBuffer) { child.kill(); finish(new Error('selection-window-error-too-large')); }
    });
    child.on('close', (code) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      finish(code === 0 ? null : new Error(stderr.trim() || `selection-window-exit-${code}`));
    });
    child.stdin.end(input, 'utf8');
  });
}

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
  if (value.action === 'scan-all') return { status: 'scan-all' };
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
  hint: '请选择客户端或手动浏览。未找到时可点击“全盘扫描”；扫描完成后重新显示候选列表。',
  selectButtonText: '使用所选客户端',
  browseButtonText: '手动浏览…',
  scanAllButtonText: '全盘扫描…',
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
  notice = '',
  probe = false,
  autoCloseMs = 0,
  labels = WINDOW_LABELS,
  timeoutMs = WINDOW_TIMEOUT_MS,
  scriptPath = defaultSelectionWindowScript,
  preferredIndex = 0,
  execFileImpl = runPowerShell
}) {
  try {
    const payload = {
      title: title || labels.title,
      hint: notice ? `${notice}\n${labels.hint}` : labels.hint,
      selectButtonText: labels.selectButtonText,
      browseButtonText: labels.browseButtonText,
      scanAllButtonText: labels.scanAllButtonText,
      cancelButtonText: labels.cancelButtonText,
      fontName: labels.fontName,
      iconPath: globalThis.__CX_NODE_SEA__ ? process.execPath
        : fileURLToPath(new URL('../share-file/assets/app-icon.ico', import.meta.url)),
      messages: labels.messages,
      preferredIndex,
      candidates: (candidates || []).map((candidate, index) => ({
        path: String(candidate?.path || ''),
        machine: String(candidate?.machine || 'unknown'),
        display: `[ ${index + 1} ] ${String(candidate?.path || '')}（${String(candidate?.machine || 'unknown')}）`
      }))
    };
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      ...buildPowerShellScriptArgs('selection-window.ps1', scriptPath, {
        defaultScriptPath: defaultSelectionWindowScript,
        parameters: [
          ['Probe', probe],
          ['AutoCloseMs', Number.isInteger(autoCloseMs) && autoCloseMs > 0 ? autoCloseMs : undefined]
        ]
      })
    ];
    const result = await execFileImpl('powershell.exe', args, {
      input: JSON.stringify(payload), windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024
    });
    return { status: 'ok', raw: JSON.parse(String(result.stdout || '').replace(/^\uFEFF/u, '')) };
  } catch (error) {
    return { status: 'unavailable', reason: error && error.message ? error.message : String(error) };
  }
}

// 显示原生客户端选择窗口；scan-all 由宿主执行扫描后重新打开窗口。
export async function showClientSelectionWindow(options = {}) {
  if (!isNativeSelectionWindowSupported()) {
    return { status: 'unavailable', reason: 'not-windows' };
  }
  if (!Array.isArray(options.candidates)) {
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
    candidateCount: Number.isInteger(raw.candidateCount) ? raw.candidateCount : 0,
    iconApplied: raw.iconApplied === true
  };
}
