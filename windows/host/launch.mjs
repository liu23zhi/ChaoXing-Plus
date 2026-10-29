import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { validateLaunchPort } from './options.mjs';
export { createListenerOwnershipVerifier, getListenerOwnerPid, getProcessParentChain, parseProcessParentChain } from './listener-owner.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_PORT_CANDIDATES = [9333, 9334, 9335, 9444, 9555, 9666, 9777, 9888, 9222, 9229, 18080, 18081];

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeUrl(url, maxLength = 300) {
  if (typeof url !== 'string' || !url) return '';
  const raw = url.split('?')[0].split('#')[0];
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return raw.length > maxLength ? `${raw.slice(0, maxLength)}…` : raw;
    }
    const sanitized = `${parsed.origin}${parsed.pathname}`;
    return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}…` : sanitized;
  } catch {
    return raw.slice(0, maxLength);
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function runPowerShell(command, { timeoutMs = 15000 } = {}) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  return String(stdout || '').trim();
}

export async function isElevated() {
  try {
    const output = await runPowerShell(
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    );
    return /^true$/i.test(output);
  } catch {
    return false;
  }
}

// 静默启动脚本通过 --hide-console 传入 Hidden：UAC 提升后的 Node 控制台不再显示。
// 默认仍是 Normal，保留普通交互启动可见的注入日志窗口。
const ELEVATED_WINDOW_STYLES = new Set(['Normal', 'Hidden', 'Minimized']);

// 无论当前进程是首次启动还是 UAC 提升后的实例，都把自己附着的控制台窗口隐藏。
// 作为 --hide-console 的兜底：即使 ShellExecuteEx 的 -WindowStyle 在 RunAs 场景
// 未被系统采纳，Node 也主动调用 Win32 ShowWindow(SW_HIDE) 消除持续可见的窗口。
export async function hideConsoleWindow() {
  if (process.platform !== 'win32') return false;
  const command = [
    'Add-Type -Name HiddenConsole -Namespace Win32 -MemberDefinition '
      + '\'[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'
      + ' [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();\';',
    '$handle = [Win32.HiddenConsole]::GetConsoleWindow();',
    'if ($handle -eq [IntPtr]::Zero) { [Console]::Out.Write("no-console") }',
    'else { [Console]::Out.Write(([Win32.HiddenConsole]::ShowWindow($handle, 0)).ToString().ToLowerInvariant()) }'
  ].join(' ');
  try {
    const output = await runPowerShell(command, { timeoutMs: 8000 });
    return output === 'true';
  } catch {
    return false;
  }
}

export function buildElevatedRelaunchCommand({
  scriptPath,
  args,
  cwd,
  selectedClientPath,
  windowStyle = 'Normal',
  nodeExecutable = process.execPath
}) {
  if (!ELEVATED_WINDOW_STYLES.has(windowStyle)) {
    throw new Error(`不支持的提权重启窗口样式：${windowStyle}`);
  }
  if (selectedClientPath) {
    const selectionValues = new Set(['--client', '--client-index', '--scan-mode']);
    const selectionFlags = new Set(['--client-first', '--scan-clients', '--select-client', '--list-clients', '--rescan', '--no-scan-cache', '--scan-all', '--no-scan-all', '--elevated']);
    const resumed = [];
    for (let index = 0; index < args.length; index += 1) {
      if (selectionValues.has(args[index])) index += 1;
      else if (!selectionFlags.has(args[index])) resumed.push(args[index]);
    }
    // Carry the actual selection across UAC instead of reopening the selector or reapplying its index.
    args = [...resumed, '--client', selectedClientPath];
  }
  // Start-Process joins array items without Win32 quoting, losing JSON and paths.
  const quoteArgument = (value) => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  const argumentList = [scriptPath, ...args, '--elevated'].map(quoteArgument).join(' ');
  return [
    `Start-Process -FilePath ${psQuote(nodeExecutable)}`,
    `-ArgumentList ${psQuote(argumentList)}`,
    `-WorkingDirectory ${psQuote(cwd)}`,
    `-Verb RunAs -WindowStyle ${windowStyle}`
  ].join(' ');
}

export async function relaunchElevated(options) {
  const command = buildElevatedRelaunchCommand(options);
  await runPowerShell(command, { timeoutMs: 20000 });
}

export function parsePeMachine(buffer) {
  if (!buffer || buffer.length < 0x40) return null;
  if (buffer.readUInt16LE(0) !== 0x5a4d) return null;
  const offset = buffer.readUInt32LE(0x3c);
  if (offset + 24 > buffer.length) return null;
  if (buffer.readUInt32LE(offset) !== 0x00004550) return null;
  return buffer.readUInt16LE(offset + 4);
}

export async function readPeMachine(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parsePeMachine(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function describeMachine(machine) {
  if (machine === 0x014c) return 'x86';
  if (machine === 0x8664) return 'x64';
  if (machine === 0xaa64) return 'arm64';
  return machine == null ? 'unknown' : `0x${machine.toString(16)}`;
}

export function isSupportedClientMachine(machine, {
  platform = process.platform,
  arch = process.arch,
  env = process.env
} = {}) {
  if (machine === 0x014c) return true;
  if (machine !== 0x8664 || platform !== 'win32') return false;
  const windowsArchitecture = `${env.PROCESSOR_ARCHITEW6432 || ''} ${env.PROCESSOR_ARCHITECTURE || ''}`;
  return arch === 'x64' || arch === 'arm64' || /\b(?:AMD64|ARM64)\b/iu.test(windowsArchitecture);
}

export async function listProcessIdsByName(imageName) {
  const baseName = String(imageName || '').replace(/\.exe$/i, '');
  if (!baseName) return [];
  try {
    const output = await runPowerShell(
      `@(Get-Process -Name ${psQuote(baseName)} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) -join ','`
    );
    return output.split(',').map((item) => Number.parseInt(item.trim(), 10)).filter((value) => Number.isInteger(value));
  } catch {
    return [];
  }
}

export function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => {
      resolve({ ok: false, code: error && error.code ? error.code : 'UNKNOWN', message: error ? error.message : 'unknown' });
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve({ ok: true }));
    });
  });
}

export async function chooseBindablePort(candidates = DEFAULT_PORT_CANDIDATES) {
  const rejected = [];
  for (const candidate of candidates) {
    const result = await canBindPort(candidate);
    if (result.ok) return { port: candidate, rejected };
    rejected.push({ port: candidate, code: result.code, message: result.message });
  }
  return { port: 0, rejected };
}

export async function waitForDebugEndpoint(port, { timeoutMs = 30000, child = null, fetchJson } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (child && child.exitCode !== null) {
      throw new Error(`客户端在调试端点就绪前退出（exitCode=${child.exitCode}）`);
    }
    try {
      const version = await fetchJson(port, '/json/version', { timeoutMs: 1500 });
      return version;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`等待 127.0.0.1:${port} 调试端点超时：${lastError ? lastError.message : 'unknown'}`);
}

export function spawnClient({ exePath, port, logger = () => {}, platform = process.platform, spawnImpl = spawn }) {
  port = validateLaunchPort(port);
  if (port === 0) throw new Error('启动客户端前必须先选择实际调试端口，不能使用自动端口 0');
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1'
  ];
  logger(`[launch] 启动客户端：${exePath}`);
  logger(`[launch] 调试参数：${args.join(' ')}`);
  if (platform === 'win32') return spawnWindowsClient({ exePath, args, spawnImpl });
  const child = spawnImpl(exePath, args, {
    cwd: path.dirname(exePath),
    stdio: 'ignore',
    windowsHide: false,
    detached: false
  });
  return { child, args };
}

export function spawnWindowsClient({ exePath, args, spawnImpl = spawn, timeoutMs = 20000 }) {
  const helper = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./launch-client.ps1', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  let pending = '', stderr = '', ready = false, completed = false, disconnected = false;
  let resolveStarted, rejectStarted;
  const started = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  const decoder = new StringDecoder('utf8');
  const fail = (error) => {
    if (completed || disconnected) return;
    completed = true;
    clearTimeout(timer);
    if (ready) queueMicrotask(() => child.emit('error', error));
    else rejectStarted(error);
  };
  const timer = setTimeout(() => {
    fail(new Error('等待客户端普通启动结果超时'));
    helper.kill();
  }, timeoutMs);
  child.disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    clearTimeout(timer);
    if (!ready && !completed) rejectStarted(Object.assign(new Error('客户端普通启动已取消'), { code: 'ABORT_ERR' }));
    helper.kill(); // Closing the observer must not terminate the client it created.
  };
  helper.on('error', fail);
  helper.stdin.on('error', () => {});
  helper.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += String(chunk); });
  helper.stdout.on('data', (chunk) => {
    pending += decoder.write(chunk);
    if (pending.length > 65536) { fail(new Error('客户端启动响应过大')); helper.kill(); return; }
    for (let newline; (newline = pending.indexOf('\n')) >= 0;) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line || completed || disconnected) continue;
      let event;
      try { event = JSON.parse(line); } catch { fail(new Error('客户端启动响应不是合法 JSON')); helper.kill(); return; }
      if (event.kind === 'started' && !ready && Number.isInteger(event.pid) && event.pid > 0) {
        ready = true;
        child.pid = event.pid;
        clearTimeout(timer);
        resolveStarted();
      } else if (event.kind === 'error') {
        fail(Object.assign(new Error(String(event.message || '客户端普通启动失败')), { win32Code: event.win32Code }));
      } else if (event.kind === 'exit' && ready && Number.isInteger(event.code)) {
        completed = true;
        child.exitCode = event.code;
        child.emit('exit', event.code, null);
      } else {
        fail(new Error('客户端启动响应状态无效'));
        helper.kill();
      }
    }
  });
  helper.on('close', (code) => {
    if (!completed && !disconnected) fail(new Error(`客户端启动观察器异常结束（${code}）：${stderr.trim()}`));
  });
  const quoteArgument = (value) => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  helper.stdin.end(JSON.stringify({ exePath, arguments: args.map(quoteArgument).join(' '), cwd: path.dirname(exePath) }), 'utf8');
  return { child, args, started };
}

export async function killProcessTree(pid, logger = () => {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    logger(`[launch] 已结束客户端进程树 pid=${pid}`);
    return true;
  } catch (error) {
    logger(`[launch] 结束客户端失败 pid=${pid}：${error.message}`);
    return false;
  }
}

const APP_COMPAT_LAYERS_KEY = 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers';

/**
 * 临时给指定 exe 加 Windows “HIGHDPIAWARE” 兼容层（等价于 exe 属性 → 兼容性 → 高 DPI 缩放替代）。
 * 该设置只影响进程启动时读取，因此可以在 CreateProcess 后立即恢复原值，不持久修改系统设置。
 * 返回原值（没有则为 null），供 restoreDpiAwarenessOverride 使用。
 */
export async function setDpiAwarenessOverride(exePath, logger = () => {}) {
  const name = psQuote(exePath);
  const key = psQuote(APP_COMPAT_LAYERS_KEY);
  const command = [
    `$key = ${key}`,
    'if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }',
    `$previous = (Get-ItemProperty -LiteralPath $key -Name ${name} -ErrorAction SilentlyContinue).${name}`,
    `New-ItemProperty -LiteralPath $key -Name ${name} -Value '~ HIGHDPIAWARE' -PropertyType String -Force | Out-Null`,
    'if ($previous) { Write-Output $previous }'
  ].join('; ');
  try {
    const output = await runPowerShell(command);
    logger(`[launch] 已临时写入 HIGHDPIAWARE 兼容层（原值=${output || '无'}）`);
    return output || null;
  } catch (error) {
    logger(`[launch] 写入 HIGHDPIAWARE 兼容层失败：${error.message}`);
    return undefined;
  }
}

export async function restoreDpiAwarenessOverride(exePath, previousValue, logger = () => {}) {
  const name = psQuote(exePath);
  const key = psQuote(APP_COMPAT_LAYERS_KEY);
  const command = previousValue
    ? `Set-ItemProperty -LiteralPath ${key} -Name ${name} -Value ${psQuote(previousValue)} -Force`
    : `Remove-ItemProperty -LiteralPath ${key} -Name ${name} -ErrorAction SilentlyContinue`;
  try {
    await runPowerShell(command);
    logger('[launch] 已恢复 HIGHDPIAWARE 兼容层注册表原值');
    return true;
  } catch (error) {
    logger(`[launch] 恢复兼容层注册表失败（请手动检查 ${APP_COMPAT_LAYERS_KEY}）：${error.message}`);
    return false;
  }
}
