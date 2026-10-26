import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

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

export async function relaunchElevated({ scriptPath, args, cwd }) {
  const nodeExecutable = process.execPath;
  const argumentList = [scriptPath, ...args, '--elevated'].map(psQuote).join(',');
  const command = [
    `Start-Process -FilePath ${psQuote(nodeExecutable)}`,
    `-ArgumentList @(${argumentList})`,
    `-WorkingDirectory ${psQuote(cwd)}`,
    '-Verb RunAs -WindowStyle Normal'
  ].join(' ');
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

export async function getListenerOwnerPid(port) {
  try {
    const output = await runPowerShell(
      `$conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($conn) { $conn.OwningProcess } else { '' }`
    );
    const pid = Number.parseInt(output, 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
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

export function spawnClient({ exePath, port, logger = () => {} }) {
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1'
  ];
  logger(`[launch] 启动客户端：${exePath}`);
  logger(`[launch] 调试参数：${args.join(' ')}`);
  const child = spawn(exePath, args, {
    cwd: path.dirname(exePath),
    stdio: 'ignore',
    windowsHide: false,
    detached: false
  });
  return { child, args };
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
