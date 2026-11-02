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

// Duilib clips its 1200x700 design layout instead of rescaling it, so the button keeps (412,78) and only
// the window DPI changes it: 150% DPI (the local client) lands on (618,117).
const expectedPoints = ['412,78', '618,117', '824,156'];

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
    '$points = foreach ($dpi in @(96, 144, 192)) { $point = Get-ClientEntryPoint -Dpi $dpi; "$($point.X),$($point.Y)" }',
    "try { Get-ClientEntryPoint -Dpi 10 | Out-Null; $invalid = 'NO_ERROR' } catch { $invalid = $_.Exception.Message }",
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

test('进入考试按钮坐标按窗口 DPI 换算，与当前客户区尺寸无关', { skip: windowsOnly }, () => {
  const { result, json } = results();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(json.points, expectedPoints,
    '按钮坐标必须按 96/144/192 DPI 换算，与实测的 (412,78) / (618,117) 一致');
  assert.match(json.invalid, /Unsupported window DPI/u, '非法 DPI 必须失败关闭');
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
  assert.match(text, /Wait-ClientLayoutReady/u, '必须等 Duilib 布局完成再点击，否则会点到 137x36 的初始窗口');
  assert.match(text, /GetDpiForWindow/u, '按钮坐标必须按窗口 DPI 换算，不能按客户区比例');
  assert.doesNotMatch(text, /0\.34333|0\.11143/u, '不得再用客户区比例推算按钮坐标');
});
