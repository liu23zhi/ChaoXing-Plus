import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

const diagnosticsScript = resolveTestPath('scripts', 'windows-client-diagnostics.ps1');
const injectionScript = resolveTestPath('scripts', 'windows-real-client-injection.ps1');
const windowsOnly = process.platform === 'win32' ? undefined : '仅在 Windows 上采集桌面环境';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

test('桌面环境与截图能被采集，坐标与缩放可用', { skip: windowsOnly }, () => {
  const directory = createTestDirectory('client-diagnostics');
  const shot = path.join(directory, 'desktop.png');
  const scaled = path.join(directory, 'desktop-50.png');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(diagnosticsScript)}`,
    '$environment = Get-DesktopEnvironment',
    `$full = Save-DesktopScreenshot -Path ${psQuote(shot)} -ScalePercent 100`,
    `$half = Save-DesktopScreenshot -Path ${psQuote(scaled)} -ScalePercent 50`,
    '@{ environment = $environment; full = $full; half = $half } | ConvertTo-Json -Compress -Depth 5'
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
  assert.ok(line, `脚本必须输出采集结果: ${result.stdout}${result.stderr}`);
  const json = JSON.parse(line);

  assert.ok(json.environment.SessionId >= 0, '必须记录会话 ID');
  assert.ok(json.environment.WindowStation, '必须记录窗口站名（区分交互式 / 服务会话）');
  assert.ok(json.environment.Desktop, '必须记录桌面名');
  assert.equal(typeof json.environment.RemoteSession, 'boolean', '必须记录是否远程会话');
  assert.ok(Array.isArray(json.environment.Monitors) && json.environment.Monitors.length >= 1, '必须记录显示器列表');
  assert.ok(json.environment.VirtualScreen.Width > 0 && json.environment.VirtualScreen.Height > 0, '必须记录虚拟屏幕尺寸');

  // 无桌面会话（服务 / 无头 runner）时截图为空，这是允许的；有桌面时必须真的写出文件。
  if (json.environment.UserInteractive && json.environment.VirtualScreen.Width > 0) {
    assert.ok(json.full, '交互式桌面必须能截图');
    assert.equal(json.full.Width, json.environment.VirtualScreen.Width, '整幅截图宽度必须等于虚拟屏幕宽度');
    assert.ok(readFileSync(shot).length > 0);
    assert.equal(json.half.Width, Math.max(1, Math.round(json.full.Width / 2)), '50% 缩放必须生效');
    assert.equal(json.half.Height, Math.max(1, Math.round(json.full.Height / 2)), '50% 缩放必须同时缩放高度');
    assert.ok(readFileSync(scaled).length > 0);
    // 文件体积不能作为缩放证据：纯色桌面缩放后可能更大（PNG 无损压缩对均匀色块更有效）。
    // 像素尺寸才是可靠判据，体积只在排除极端情况时做上限检查。
    assert.ok(readFileSync(scaled).length < readFileSync(shot).length * 4, '缩放后的文件体积不应远超原图');
  }
});

test('注入脚本在关键节点落盘环境与截图', async () => {
  const script = await readFile(injectionScript, 'utf8');
  assert.match(script, /\.\s*\(Join-Path \$PSScriptRoot 'windows-client-diagnostics\.ps1'\)/u,
    '注入脚本必须 dot-source 桌面诊断助手');
  assert.match(script, /cx-real-client-\$CaseName-environment\.json/u, '启动时必须写出桌面环境快照');
  assert.match(script, /cx-real-client-\$CaseName-start\.png/u, '启动时必须截一张起始画面');
  assert.match(script, /Wait-ClientExamEntry -ClientPath \$client\.FullName -TimeoutSeconds 90 -ScreenshotPrefix \$entryPrefix/u,
    '每次点击尝试都要留下截图');
  assert.match(script, /Save-DesktopScreenshot -Path \(Join-Path \$target "cx-real-client-\$CaseName-desktop\.png"\)/u,
    '失败时必须保存最终桌面截图');

  const bytes = readFileSync(diagnosticsScript);
  for (const byte of bytes) assert.equal(byte <= 0x7f, true, 'windows-client-diagnostics.ps1 必须保持纯 ASCII');
});
