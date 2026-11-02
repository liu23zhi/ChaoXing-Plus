import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

const inputScript = resolveTestPath('scripts', 'windows-client-input.ps1');
const injectionScript = resolveTestPath('scripts', 'windows-real-client-injection.ps1');
const preparationScript = resolveTestPath('scripts', 'ci', 'prepare-windows-real-client-environment.ps1');
const windowsOnly = process.platform === 'win32' ? undefined : '仅在 Windows 上检查输入法状态';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

test('输入法状态可采集，且未变化时恢复是空操作', { skip: windowsOnly }, () => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(inputScript)}`,
    '$before = Get-InputState',
    'Start-Sleep -Milliseconds 200',
    '$after = Get-InputState',
    '$diff = Compare-InputState -Before $before -After $after',
    '$restored = Restore-InputState -State $before',
    '@{ before = $before; diff = @($diff); restored = @($restored) } | ConvertTo-Json -Compress -Depth 6'
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
  assert.ok(line, `脚本必须输出输入法状态: ${result.stdout}${result.stderr}`);
  const json = JSON.parse(line);
  assert.ok(Array.isArray(json.before.LayoutHandles) && json.before.LayoutHandles.length >= 1,
    '必须能列出已加载的键盘布局');
  assert.match(json.before.ActiveLayout, /^0x[0-9A-F]{8}$/u, '必须记录当前激活布局句柄');
  assert.deepEqual(json.diff, [], '同一状态连续采集不应出现差异');
  assert.deepEqual(json.restored, [], '状态未变化时恢复必须是空操作');
});

test('注入脚本在运行前后快照并恢复输入法', async () => {
  const script = await readFile(injectionScript, 'utf8');
  assert.match(script, /\.\s*\(Join-Path \$PSScriptRoot 'windows-client-input\.ps1'\)/u, '注入脚本必须 dot-source 输入法助手');
  assert.match(script, /\$inputState = Get-InputState/u, '启动客户端前必须快照输入法状态');
  assert.match(script, /cx-real-client-\$CaseName-input-before\.json/u, '必须落盘输入法快照');
  assert.match(script, /Restore-InputState -State \$inputState/u, '结束后必须恢复输入法');
  assert.match(script, /input changed=\$\(\$inputChanges -join ','\) restored=\$\(\$restoredInput -join ','\)/u,
    '必须记录输入法是否被改动以及恢复结果');
  assert.match(script, /Save-RunArtifacts -CaseName \$CaseName/u, '成功与失败都要保留现场');
  // 客户端导入 LoadKeyboardLayoutW/UnloadKeyboardLayout 并在退出时留下自载布局，恢复必须卸载多余布局。
  assert.match(readFileSync(inputScript, 'utf8'), /Unload/u, '恢复时需要卸载客户端自载的布局');
});

test('CI 桌面环境准备脚本可在无副作用模式下运行', () => {
  const bytes = readFileSync(preparationScript);
  for (const byte of bytes) assert.equal(byte <= 0x7f, true, 'prepare-windows-real-client-environment.ps1 必须保持纯 ASCII');
  const result = spawnSync('pwsh', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', preparationScript, '-SkipResolution', '-SkipInputMethod', '-SkipCamera'
  ], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[desktop-prep\]/u, '必须输出准备日志');
  assert.doesNotMatch(result.stdout, /camera: installing/u, '跳过开关不得真的安装摄像头驱动');
});
