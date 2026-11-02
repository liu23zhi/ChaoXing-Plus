import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';
const entryScript = resolveTestPath('scripts', 'windows-client-entry.ps1');
const injectionScript = resolveTestPath('scripts', 'windows-real-client-injection.ps1');
const fixtureBefore = resolveTestPath('tests', 'fixtures', 'real-client', 'check-failed-1-before-click.png');
const fixtureAfter = resolveTestPath('tests', 'fixtures', 'real-client', 'check-failed-2-after-click.png');
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
    '@{ points = @($points); invalid = $invalid; missing = @{ Clicked = $entry.Clicked; Reason = $entry.Reason; ProcessId = $entry.ProcessId; Attempts = $entry.Attempts } } | ConvertTo-Json -Compress -Depth 4'
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
  assert.equal(json.missing.Clicked, false);
  assert.equal(json.missing.Reason, 'entry-window-not-found');
  assert.equal(json.missing.ProcessId, 0);
  assert.equal(json.missing.Attempts, 0);
});

test('注入脚本在报告校验前自动点击进入考试，并接受客户端提前退出', async () => {
  const script = await readFile(injectionScript, 'utf8');
  assert.match(script, /\.\s*\(Join-Path \$PSScriptRoot 'windows-client-entry\.ps1'\)/u, '注入脚本必须 dot-source 进入考试助手');
  assert.match(script, /Wait-ClientExamEntry -ClientPath \$client\.FullName/u, '注入脚本必须在宿主启动后点击进入考试');
  assert.match(script, /\$stage = 'enter-exam'/u, '进入考试必须是可报告的独立阶段');
  assert.match(script, /'--duration', '180000'/u, '运行时必须给检查窗口、点击重试与页面加载留出足够时间');
  assert.match(script, /\$report\.stopReason -notin @\('duration', 'client-exit'\)/u,
    '客户端被关闭或杀掉后仍应接受完整报告');
  assert.match(script, /entry reason=\$\(\$entry\.Reason\) attempts=\$\(\$entry\.Attempts\) pageTargets=\$\(\$entry\.PageTargets\)/u,
    'pageSessions 为 0 时必须报告点击重试次数与页面数');
  assert.match(script, /windows=\$\(\[CXClientEntry\]::WindowClasses/u,
    '进入考试日志必须带上客户端窗口类列表，用于区分点击失败与被客户端自检拦截');
  assert.match(script, /Save-RunArtifacts -CaseName \$CaseName/u,
    '成功与失败都必须保留截图/报告/宿主日志供 CI 上传');
  assert.doesNotMatch(script, /stopReason -ne 'duration'/u, '不得再要求客户端必须自然跑到时长结束');
});

test('客户端自检拦截时默认失败，BLOCKED 只能显式豁免', async () => {
  const script = await readFile(injectionScript, 'utf8');
  assert.match(script, /\[switch\] \$AllowEnvironmentBlocked/u, '保留本地调试开关');
  assert.match(script, /if \(-not \$AllowEnvironmentBlocked\) \{ throw "\$message/u,
    '默认必须抛错：没有页面会话就是失败，不能显示成功');
  assert.match(script, /::error::\$message/u, '必须输出 GitHub 错误注解');
  assert.match(script, /REAL_CLIENT_INJECTION_BLOCKED/u, '被客户端自检拦截时要打印 BLOCKED 结论');
  assert.match(script, /\$hintShown = \$windowClasses -match 'ExamCheckHintUI'/u,
    '必须用 ExamCheckHintUI 判定是自检拦截，而不是注入失败');
  assert.match(script, /\[int\]\$report\.totals\.pageSessions -lt 1/u, '只有在完全没有页面时才算环境阻塞');
  assert.match(script, /if \(\$blockedByEnvironment\) \{/u, '环境阻塞必须跳过后续注入计数校验');
  assert.doesNotMatch(script, /AllowEnvironmentBlocked[^\n]*\n[^\n]*throw "Injection report is not successful/u,
    '开关不得把真正的注入失败也当成阻塞');
});

test('注入脚本无论成功失败都关闭客户端与残留宿主', async () => {
  const script = await readFile(injectionScript, 'utf8');
  assert.match(script, /function Stop-ClientProcess/u, '必须有按路径兜底关闭客户端的清理函数');
  assert.match(script, /Stop-ClientProcess \$clientPath/u, 'finally 必须关闭本次解包出的客户端');
  assert.match(script, /no CEF page appeared after the entry attempts/u,
    '没有 CEF 页面时不能把客户端挂到时长结束，必须先关掉再取报告');
  assert.match(script, /Stop-StartedHost \$NativeHost \$runStarted/u,
    '提权交接后的宿主不是子进程句柄，必须按启动时间兜底关闭');
});

test('进入考试助手保持纯 ASCII 且不发送重复点击', () => {
  const bytes = readFileSync(entryScript);
  for (const byte of bytes) assert.equal(byte <= 0x7f, true, 'windows-client-entry.ps1 必须保持纯 ASCII');
  const text = bytes.toString('utf8');
  assert.equal((text.match(/PostMessageW\(\$window, 0x0201/gu) ?? []).length, 1, '只允许发送一次按下消息，避免打开多个页面');
  assert.doesNotMatch(text, /mouse_event|SetCursorPos|SendInput/u, '不得使用会被 UIPI 或 DPI 影响的整屏输入');
  assert.match(text, /Wait-ClientLayoutReady/u, '必须等 Duilib 布局完成再点击，否则会点到 137x36 的初始窗口');
  assert.match(text, /GetDpiForWindow/u, '按钮坐标必须按窗口 DPI 换算，不能按客户区比例');
  assert.match(text, /Get-ClientPageTargetCount/u, '点击后必须用 CDP 页面数确认真的进入了考试');
  assert.match(text, /Find-ExamEntryButton/u, '必须按渲染结果定位按钮，而不是写死坐标');
  assert.match(text, /CXExamEntryScan/u, '必须有像素扫描实现');
  assert.equal((text.match(/1-before-click/gu) ?? []).length, 1, '点击前必须留一帧（按钮已出现）');
  assert.match(text, /2-after-click/u, '点击后、关闭前必须留一帧');
  assert.match(text, /entry-button-never-visible/u, '按钮始终没出现时要与点击无效区分开');
  assert.match(text, /entry-page-detected/u, '必须区分"页面已出现"和"点了但没反应"');
  assert.match(text, /-Attempts 6|Attempts = 6/u, '检查页探测期间点击会被丢弃，必须允许重试');
  assert.doesNotMatch(text, /0\.34333|0\.11143/u, '不得再用客户区比例推算按钮坐标');
});

test('圆角弹窗按钮可被扫描命中，普通页面不会误判', () => {
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$entry = '` + entryScript.replace(/'/g, "''") + String.raw`'
$text = Get-Content -LiteralPath $entry -Raw
$start = $text.IndexOf('public class CXExamEntryScan')
$begin = $text.LastIndexOf("@'", $start) + 2
$end = $text.IndexOf("'@", $start)
Add-Type -TypeDefinition $text.Substring($begin, $end - $begin)

function Scan-Bitmap($bmp) {
  $rect = New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $buffer = New-Object byte[] ($data.Stride * $bmp.Height)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buffer, 0, $buffer.Length)
  $found = [CXExamEntryScan]::Scan($buffer, $data.Stride, $bmp.Width, $bmp.Height, 0, 0)
  $bmp.UnlockBits($data)
  return $found
}

# 1) 圆角蓝色确定按钮（模拟客户端弹窗），位于裁剪带内
$bmp = New-Object System.Drawing.Bitmap 480, 315
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 102, 150, 255))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 16
$rect = New-Object System.Drawing.Rectangle 250, 230, 122, 33
$d = $radius * 2
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
$path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
$path.CloseFigure()
$g.FillPath($brush, $path)
$g.Dispose()
$hit = Scan-Bitmap $bmp
$bmp.Dispose()
if ($hit.Length -eq 0) { 'PILL=absent' } else { "PILL=found $($hit[0]),$($hit[1])" }

# 2) 纯白页面不得命中
$blank = New-Object System.Drawing.Bitmap 480, 315
$g2 = [System.Drawing.Graphics]::FromImage($blank)
$g2.Clear([System.Drawing.Color]::White)
$g2.Dispose()
$miss = Scan-Bitmap $blank
$blank.Dispose()
if ($miss.Length -eq 0) { 'BLANK=absent' } else { "BLANK=found $($miss[0]),$($miss[1])" }
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', harness],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  const pill = /PILL=(absent|found \d+,\d+)/u.exec(result.stdout);
  assert.ok(pill, `扫描器必须输出结果: ${result.stdout}${result.stderr}`);
  assert.notEqual(pill[1], 'absent', '圆角蓝色按钮必须被识别');
  const [x, y] = pill[1].replace('found ', '').split(',').map(Number);
  assert.ok(Math.abs(x - 311) <= 6, `按钮 X 应接近 311，实际 ${x}`);
  assert.ok(Math.abs(y - 246) <= 6, `按钮 Y 应接近 246，实际 ${y}`);
  assert.match(result.stdout, /BLANK=absent/u, '空白页面不得误判出按钮');
});
test('检测未通过时点掉确认弹窗再等页面', async () => {
  const script = await readFile(entryScript, 'utf8');
  assert.match(script, /function Find-ClientConfirmButton/u, '必须能在弹窗区域定位确认按钮');
  assert.match(script, /function Confirm-ClientExamEntry/u, '必须提供确认弹窗的兜底点击');
  assert.match(script, /entry-page-detected-after-confirm/u, '确认后出现页面要有独立原因');
  assert.match(script, /3-confirm-dialog/u, '点确认前必须留帧');
  assert.match(script, /4-after-confirm/u, '点确认后必须留帧');
  assert.match(script, /CropLeft \$cropLeft -CropTop \$cropTop/u, '确认按钮扫描必须限制在弹窗区域');
  assert.match(script, /overlap \* 100 >= \(long\)span \* 60/u, '圆角按钮需要按重叠判定连续性');
  assert.match(script, /Via = 'keyboard'/u, '扫描找不到按钮时必须有键盘兜底');
  assert.match(script, /function Get-ClientDialogWindow/u, '弹窗是独立窗口，必须先定位它');
  assert.match(script, /'ExamCheckHintUI', '#32770'/u, '必须按客户端弹窗类名查找');
  assert.match(script, /function Invoke-WindowClick/u, '点击必须发到目标窗口自身');
  assert.match(script, /dialog-window/u, '确认点击必须走弹窗窗口（检查窗口收不到）');
  assert.match(script, /\$stillOpen = \(Get-ClientDialogWindow/u, '点完必须确认弹窗真的消失');
  assert.match(script, /confirm dialog handled clicked=/u, '必须记录弹窗处理结果');
  assert.match(script, /if \(\$dialog -eq \[IntPtr\]::Zero\) \{ return \[pscustomobject\]@\{ Clicked = \$false; X = 0; Y = 0; Via = 'none' \} \}/u,
    '没有弹窗窗口时不得扫描检查页（会把摄像头的运行按钮当成确定）');
  assert.match(script, /if \(\$width -lt 200 -or \$height -lt 100\) \{ continue \}/u,
    '必须排除客户端自带的 0x0 #32770 帮助窗口');
  assert.match(script, /if \(\$dialogWindow -ne \[IntPtr\]::Zero\) \{/u, '主循环只在检测到弹窗时才处理弹窗');
  const confirmBody = script.slice(script.indexOf('function Confirm-ClientExamEntry'));
  assert.ok(confirmBody.indexOf('Get-ClientDialogWindow') < confirmBody.indexOf('Find-ClientConfirmButton'),
    '必须先定位弹窗窗口再扫描按钮');
});
test('真实 CI 帧：检测未通过弹窗的确定按钮能被定位', () => {
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$entry = '` + entryScript.replace(/'/g, "''") + String.raw`'
$text = Get-Content -LiteralPath $entry -Raw
$start = $text.IndexOf('public class CXExamEntryScan')
$begin = $text.LastIndexOf("@'", $start) + 2
$end = $text.IndexOf("'@", $start)
Add-Type -TypeDefinition $text.Substring($begin, $end - $begin)

function Scan-Crop([string]$Path, [double]$left, [double]$top, [double]$width, [double]$height) {
  $bmp = [System.Drawing.Bitmap]::FromFile($Path)
  $cropLeft = [int]($bmp.Width * $left); $cropTop = [int]($bmp.Height * $top)
  $cropWidth = [int]($bmp.Width * $width); $cropHeight = [int]($bmp.Height * $height)
  $rect = New-Object System.Drawing.Rectangle $cropLeft, $cropTop, $cropWidth, $cropHeight
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $buffer = New-Object byte[] ($data.Stride * $cropHeight)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buffer, 0, $buffer.Length)
  $found = [CXExamEntryScan]::Scan($buffer, $data.Stride, $cropWidth, $cropHeight, 0, 0)
  $bmp.UnlockBits($data)
  $bmp.Dispose()
  if ($found.Length -eq 0) { return 'absent' }
  return "$($found[0] + $cropLeft),$($found[1] + $cropTop)"
}

# 与 Find-ClientConfirmButton 一致的裁剪带：30%..70% 宽、30%..75% 高
"BEFORE_CONFIRM=$(Scan-Crop '` + fixtureBefore.replace(/'/g, "''") + String.raw`' 0.30 0.30 0.40 0.45)"
"AFTER_CONFIRM=$(Scan-Crop '` + fixtureAfter.replace(/'/g, "''") + String.raw`' 0.30 0.30 0.40 0.45)"
"BEFORE_ENTRY=$(Scan-Crop '` + fixtureBefore.replace(/'/g, "''") + String.raw`' 0.0 0.0 1.0 1.0)"
"AFTER_ENTRY=$(Scan-Crop '` + fixtureAfter.replace(/'/g, "''") + String.raw`' 0.0 0.0 1.0 1.0)"
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', harness],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  const pick = (name) => {
    const match = new RegExp(`${name}=([^\\r\\n]+)`, 'u').exec(result.stdout);
    assert.ok(match, `缺少 ${name}: ${result.stdout}${result.stderr}`);
    return match[1].trim();
  };
  assert.equal(pick('BEFORE_CONFIRM'), 'absent', '未点进入考试时不得出现确认按钮');
  const after = pick('AFTER_CONFIRM');
  assert.notEqual(after, 'absent', '检测未通过的确认弹窗必须能被识别');
  const [confirmX, confirmY] = after.split(',').map(Number);
  assert.ok(Math.abs(confirmX - 668) <= 12, `确定按钮 X 应接近 668，实际 ${confirmX}`);
  assert.ok(Math.abs(confirmY - 448) <= 12, `确定按钮 Y 应接近 448，实际 ${confirmY}`);
  const [entryX, entryY] = pick('BEFORE_ENTRY').split(',').map(Number);
  assert.ok(Math.abs(entryX - 601) <= 20 && Math.abs(entryY - 78) <= 20, `进入考试按钮位置异常: ${entryX},${entryY}`);
});

test('按弹窗窗口自身坐标也能定位确定按钮', () => {
  // CI 帧里弹窗是独立窗口：只截到弹窗时，用宽裁剪带（2%..98% x / 10%..95% y）必须仍能命中。
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$entry = '` + entryScript.replace(/'/g, "''") + String.raw`'
$text = Get-Content -LiteralPath $entry -Raw
$start = $text.IndexOf('public class CXExamEntryScan')
$begin = $text.LastIndexOf("@'", $start) + 2
$end = $text.IndexOf("'@", $start)
Add-Type -TypeDefinition $text.Substring($begin, $end - $begin)

$full = [System.Drawing.Bitmap]::FromFile('` + fixtureAfter.replace(/'/g, "''") + String.raw`')
# 弹窗在整帧中的位置（按帧内容测量）：留 2px 余量
$rect = New-Object System.Drawing.Rectangle 397, 247, 405, 251
$dialog = $full.Clone($rect, $full.PixelFormat)
$cropLeft = [int]($dialog.Width * 0.02); $cropTop = [int]($dialog.Height * 0.10)
$cropWidth = [int]($dialog.Width * 0.96); $cropHeight = [int]($dialog.Height * 0.85)
$scanRect = New-Object System.Drawing.Rectangle $cropLeft, $cropTop, $cropWidth, $cropHeight
$data = $dialog.LockBits($scanRect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$buffer = New-Object byte[] ($data.Stride * $cropHeight)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buffer, 0, $buffer.Length)
$found = [CXExamEntryScan]::Scan($buffer, $data.Stride, $cropWidth, $cropHeight, 0, 0)
$dialog.UnlockBits($data)
$dialog.Dispose(); $full.Dispose()
if ($found.Length -eq 0) { 'DIALOG=absent' } else { "DIALOG=$($found[0] + $cropLeft + $rect.X),$($found[1] + $cropTop + $rect.Y)" }
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', harness],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  const match = /DIALOG=([^\r\n]+)/u.exec(result.stdout);
  assert.ok(match, `缺少 DIALOG 结果: ${result.stdout}${result.stderr}`);
  assert.notEqual(match[1].trim(), 'absent', '弹窗窗口内必须能定位确定按钮');
  const [x, y] = match[1].trim().split(',').map(Number);
  assert.ok(Math.abs(x - 668) <= 12 && Math.abs(y - 448) <= 12, `弹窗内确定按钮位置异常: ${x},${y}`);
});
test('裁剪扫描的命中点换算回客户区坐标（不允许负值）', () => {
  // CI 现场曾出现 point=-50,30：Scan 返回的偏差被重复减去。这里直接验证换算公式。
  const harness = String.raw`
$entry = '` + entryScript.replace(/'/g, "''") + String.raw`'
$text = Get-Content -LiteralPath $entry -Raw
 =  -split '\\r?\\n'
# 只取 Get-WindowScanBuffer 里 OffsetX/OffsetY 的两处表达式，避免加载整个脚本
$offsets = $lines | Where-Object { $_ -match 'OffsetX = |OffsetY = ' }
$offsets | ForEach-Object { $_.Trim() }
# 复刻换算：client = cropCenter + cropLeft - captionDelta
function Convert-Point($x, $y, $cropLeft, $cropTop, $captionX, $captionY) {
  return "$($x - ($captionX - $cropLeft)),$($y - ($captionY - $cropTop))"
}
"FULL=$((Convert-Point 611 78 0 0 0 0))"
"CROP=$((Convert-Point 310 240 360 210 0 0))"
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', harness],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  const source = readFileSync(entryScript, 'utf8');
  assert.match(source, /OffsetX = \(\$origin\.X - \$windowRect\.Left\) - \$CropLeft/u,
    '偏移量必须减去裁剪原点（Scan 内部会再减一次，等价于加回去）');
  assert.match(source, /OffsetY = \(\$origin\.Y - \$windowRect\.Top\) - \$CropTop/u, '纵向同理');
  assert.match(result.stdout, /FULL=611,78/u, '整窗扫描的换算不能改变原有结果');
  assert.match(result.stdout, /CROP=670,450/u, '裁剪扫描必须换算回客户区正坐标');
});