import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

const entryScript = resolveTestPath('scripts', 'windows-client-entry.ps1');
const injectionScript = resolveTestPath('scripts', 'windows-real-client-injection.ps1');
const windowsOnly = process.platform === 'win32' ? undefined : '仅在 Windows 上执行原生窗口辅助脚本';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Coordinates measured against the real client: 1200x700 client area -> (412,78); at 150% DPI the
// window is 1800x1050 and the same logical point lands on (618,117).
const expectedPoints = [
  { width: 1200, height: 700, point: '412,78' },
  { width: 1800, height: 1050, point: '618,117' },
  { width: 2400, height: 1400, point: '824,156' }
];

let pendingResults;

// A single PowerShell process covers every probe: the unit job also runs real Chromium suites at
// concurrency 2, so one spawn per assertion only adds scheduling noise.
function results() {
  if (pendingResults) return pendingResults;
  const missing = resolveTestPath('.tmp-tests-not-a-client', 'CXExam.exe');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(entryScript)}`,
    '$points = foreach ($size in @(@(1200, 700), @(1800, 1050), @(2400, 1400))) {'
      + ' $point = Get-ClientEntryPoint -Width $size[0] -Height $size[1]; "$($point.X),$($point.Y)" }',
    "try { Get-ClientEntryPoint -Width 0 -Height 700 | Out-Null; $invalid = 'NO_ERROR' } catch { $invalid = $_.Exception.Message }",
    `$entry = Wait-ClientExamEntry -ClientPath ${psQuote(missing)} -TimeoutSeconds 1 -PollMilliseconds 200`,
    '@{ points = @($points); invalid = $invalid; missing = @{ Clicked = $entry.Clicked; Reason = $entry.Reason; ProcessId = $entry.ProcessId } } | ConvertTo-Json -Compress -Depth 4'
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  const line = String(result.stdout)
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.startsWith('{'))
    .pop();
  assert.ok(line, `脚本必须输出探针结果: ${result.stdout}${result.stderr}`);
  pendingResults = { result, json: JSON.parse(line) };
  return pendingResults;
}

test('进入考试按钮坐标由客户区尺寸换算，与 DPI 无关', { skip: windowsOnly }, () => {
  const { result, json } = results();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json.points, expectedPoints.map((item) => item.point),
    '按钮坐标必须与实测的 1200x700 / 1800x1050 / 2400x1400 换算结果一致');
  assert.match(json.invalid, /Client area must be positive/u, '非法尺寸必须失败关闭');
});

test('找不到客户端检查窗口时返回明确原因，不误报点击成功', { skip: windowsOnly }, () => {
  const { json } = results();
  assert.deepEqual(json.missing, { Clicked: false, Reason: 'entry-window-not-found', ProcessId: 0 });
});

test('注入脚本在报告校验前自动点击进入考试，并接受客户端提前退出', async () => {
  const script = await readFile(injectionScript, 'utf8');
  assert.match(script, /\.\s*\(Join-Path \$PSScriptRoot 'windows-client-entry\.ps1'\)/u, '注入脚本必须 dot-source 进入考试助手');
  assert.match(script, /Wait-ClientExamEntry -ClientPath \$client\.FullName/u, '注入脚本必须在宿主启动后点击进入考试');
  assert.match(script, /\$stage = 'enter-exam'/u, '进入考试必须是可报告的独立阶段');
  assert.match(script, /'--duration', '120000'/u, '运行时必须给检查窗口和页面加载留出足够时间');
  assert.match(script, /\$report\.stopReason -notin @\('duration', 'client-exit'\)/u,
    '客户端被关闭或杀掉后仍应接受完整报告');
  assert.match(script, /entry click=\$\(\$entry\.Reason\)/u, 'pageSessions 为 0 时必须报告进入考试点击结果');
  assert.doesNotMatch(script, /stopReason -ne 'duration'/u, '不得再要求客户端必须自然跑到时长结束');
});

test('进入考试助手保持纯 ASCII 且不发送重复点击', () => {
  const bytes = readFileSync(entryScript);
  for (const byte of bytes) assert.equal(byte <= 0x7f, true, 'windows-client-entry.ps1 必须保持纯 ASCII');
  const text = bytes.toString('utf8');
  assert.equal((text.match(/PostMessageW\(\$window, 0x0201/gu) ?? []).length, 1, '只允许发送一次按下消息，避免打开多个页面');
  assert.doesNotMatch(text, /mouse_event|SetCursorPos|SendInput/u, '不得使用会被 UIPI 或 DPI 影响的整屏输入');
});
