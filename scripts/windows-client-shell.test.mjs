import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

const shellScript = resolveTestPath('scripts', 'windows-client-shell.ps1');
const injectionScript = resolveTestPath('scripts', 'windows-real-client-injection.ps1');
const windowsOnly = process.platform === 'win32' ? undefined : '仅在 Windows 上执行资源管理器恢复脚本';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

test('资源管理器状态判定覆盖健康、需要重启与非交互会话', { skip: windowsOnly }, () => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(shellScript)}`,
    '$cases = @('
      + " (Get-ShellRepairAction -ShellProcessRunning $true  -TrayWindowPresent $true  -TrayOwnerAlive $true  -UserInteractive $true),"
      + " (Get-ShellRepairAction -ShellProcessRunning $true  -TrayWindowPresent $true  -TrayOwnerAlive $false -UserInteractive $true),"
      + " (Get-ShellRepairAction -ShellProcessRunning $true  -TrayWindowPresent $false -TrayOwnerAlive $false -UserInteractive $true),"
      + " (Get-ShellRepairAction -ShellProcessRunning $false -TrayWindowPresent $false -TrayOwnerAlive $false -UserInteractive $true),"
      + " (Get-ShellRepairAction -ShellProcessRunning $true  -TrayWindowPresent $false -TrayOwnerAlive $false -UserInteractive $false))",
    '$live = Repair-ShellDesktop -WhatIf',
    '$forced = Repair-ShellDesktop -Force -WhatIf',
    '@{ cases = @($cases); live = $live; forced = $forced } | ConvertTo-Json -Compress -Depth 4'
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
  const line = String(result.stdout)
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.startsWith('{'))
    .pop();
  assert.ok(line, `脚本必须输出判定结果: ${result.stdout}${result.stderr}`);
  const json = JSON.parse(line);
  assert.deepEqual(json.cases, ['healthy', 'restart', 'restart', 'skip', 'skip'],
    '任务栏属于存活 explorer 才算健康；任务栏丢失或属主进程已死都要重启；无 shell 或非交互会话一律跳过');
  assert.ok(['healthy', 'skip', 'restart'].includes(json.live.Action), `-WhatIf 只做判定，实际: ${json.live.Action}`);
  assert.equal(json.live.Restarted, false, '-WhatIf 不得真的重启资源管理器');
  assert.ok(['restart', 'skip'].includes(json.forced.Action), '-Force 必须把健康状态也视为需要重启');
  assert.equal(json.forced.Restarted, false, '-WhatIf 不得真的重启');
  assert.equal(json.forced.Forced, true);
});

test('客户端关闭后注入脚本会恢复资源管理器', async () => {
  const script = await readFile(injectionScript, 'utf8');
  assert.match(script, /\.\s*\(Join-Path \$PSScriptRoot 'windows-client-shell\.ps1'\)/u,
    '注入脚本必须 dot-source 资源管理器恢复助手');
  assert.match(script, /Repair-ShellDesktop -Force/u, '跑过客户端后必须强制重启资源管理器（客户端会留下桌面钩子）');
  assert.match(script, /shell repair action=/u, '恢复结果必须写进日志');

  const shell = readFileSync(shellScript);
  for (const byte of shell) assert.equal(byte <= 0x7f, true, 'windows-client-shell.ps1 必须保持纯 ASCII');
  assert.match(shell.toString('utf8'), /Shell_TrayWnd/u, '必须用 Shell_TrayWnd 判断任务栏是否真的存在');
});
