import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';
// 生成的 harness 必须带 UTF-8 BOM：仓库路径含中文时，无 BOM 的 .ps1 会被
// Windows PowerShell 5.1 按 ANSI 解码，dot-source 的路径变乱码后直接失败，
// 表现为"拿不到前台窗口"这类下游症状（详见 helpers 注释）。
import { writePowerShellScript, runPowerShellScript } from './test-helpers/windows-script.mjs';

const windowsOnly = process.platform === 'win32' ? undefined : 'Win32 dialog window regression';
const entryScript = process.env.CX_CLIENT_ENTRY_SCRIPT || resolveTestPath('scripts', 'windows-client-entry.ps1');
const fixture = resolveTestPath('tests', 'fixtures', 'real-client', 'check-failed-fullscreen-confirm.png');
const smallFixture = resolveTestPath('tests', 'fixtures', 'real-client', 'check-failed-2-after-click.png');
const windowSource = resolveTestPath('scripts', 'test-helpers', 'client-dialog-fixture.cs');
const quote = (value) => `'${String(value).replace(/'/gu, "''")}'`;

function runDialog(scenario, { reacquire = false } = {}) {
  const directory = createTestDirectory('client-dialog');
  const harness = path.join(directory, 'harness.ps1');
  writePowerShellScript(harness, `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. ${quote(entryScript)}
Add-Type -Path ${quote(windowSource)}
[ClientDialogFixture]::Start(${quote(scenario)})
try {
  # Pixel input is the sanitized real CI frame; window ownership/visibility/enumeration and mouse
  # messages use actual Win32 HWNDs. This avoids dependence on the operator's monitor size or content.
  $script:dialogBitmap = [Drawing.Bitmap]::FromFile(${quote(scenario === 'small' ? smallFixture : fixture)})
  if (${quote(scenario)} -eq 'small') {
    $crop = New-Object Drawing.Rectangle 397, 247, 405, 251
    $small = $script:dialogBitmap.Clone($crop, $script:dialogBitmap.PixelFormat)
    $script:dialogBitmap.Dispose(); $script:dialogBitmap = $small
  }
  function Get-WindowScanBuffer {
    param([IntPtr] $Window, [int] $CropLeft = 0, [int] $CropTop = 0, [int] $CropWidth = 0, [int] $CropHeight = 0)
    if ($Window -ne [ClientDialogFixture]::Dialog) { throw 'Scanner targeted a different window' }
    $bitmap = $script:dialogBitmap
    if ($CropWidth -le 0 -or $CropHeight -le 0) { $CropWidth = $bitmap.Width; $CropHeight = $bitmap.Height }
    $rectangle = New-Object Drawing.Rectangle $CropLeft, $CropTop, $CropWidth, $CropHeight
    $data = $bitmap.LockBits($rectangle, [Drawing.Imaging.ImageLockMode]::ReadOnly, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $buffer = New-Object byte[] ($data.Stride * $CropHeight)
      [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buffer, 0, $buffer.Length)
      return [pscustomobject]@{ Buffer = $buffer; Stride = $data.Stride; Width = $CropWidth; Height = $CropHeight; OffsetX = -$CropLeft; OffsetY = -$CropTop }
    } finally { $bitmap.UnlockBits($data) }
  }
  $diverted = [IntPtr]::Zero
  if ($${reacquire}) {
    [ClientDialogFixture]::EnsureForeground([ClientDialogFixture]::Check)
    $diverted = [CXClientEntry]::GetForegroundWindow()
  }
  # Other browser/native tests share this desktop. Reestablish the scenario after bitmap setup,
  # then independently read the actual foreground immediately before exercising window selection.
  [ClientDialogFixture]::EnsureForeground($(if (${quote(scenario)} -eq 'fullscreen-focus') { [ClientDialogFixture]::Dialog } else { [ClientDialogFixture]::Unknown }))
  $foreground = [CXClientEntry]::GetForegroundWindow()
  $selected = Get-ClientDialogWindow -CheckWindow ([ClientDialogFixture]::Check) -ProcessId $PID
  $accepted = Confirm-ClientExamEntry -Window ([ClientDialogFixture]::Check) -TimeoutSeconds 1 -PollMilliseconds 20 -ProcessId $PID
  [pscustomobject]@{
    selected = $selected.ToInt64(); expected = [ClientDialogFixture]::Dialog.ToInt64()
    foreground = $foreground.ToInt64(); unknown = [ClientDialogFixture]::Unknown.ToInt64()
    diverted = $diverted.ToInt64(); check = [ClientDialogFixture]::Check.ToInt64()
    clicked = $accepted.Clicked; x = $accepted.X; y = $accepted.Y; via = $accepted.Via
    clicks = [ClientDialogFixture]::Clicks; wrongClicks = [ClientDialogFixture]::WrongClicks
    lastX = [ClientDialogFixture]::LastX; lastY = [ClientDialogFixture]::LastY
    remaining = (Get-ClientDialogWindow -CheckWindow ([ClientDialogFixture]::Check) -ProcessId $PID).ToInt64()
  } | ConvertTo-Json -Compress
} finally {
  if ($script:dialogBitmap) { $script:dialogBitmap.Dispose() }
  [ClientDialogFixture]::Stop()
}
`);
  const result = runPowerShellScript(harness, { timeout: 45_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split(/\r?\n/u).findLast((value) => value.startsWith('{'));
  assert.ok(line, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(line);
}

test('fullscreen CI frame selects the real visible overlay and posts the confirm point to its HWND', { skip: windowsOnly }, () => {
  const actual = runDialog('fullscreen-focus');
  assert.equal(actual.selected, actual.expected, 'known visible fullscreen dialog must survive hidden/0x0 duplicates and unknown foreground');
  assert.equal(actual.clicked, true, JSON.stringify(actual));
  assert.equal(actual.wrongClicks, 0, `the background entry button must never receive the confirm click: ${JSON.stringify(actual)}`);
  assert.equal(actual.via, 'dialog-window');
  assert.ok(Math.abs(actual.x - 1030) <= 12 && Math.abs(actual.y - 616) <= 12, JSON.stringify(actual));
  assert.equal(actual.clicks, 1);
  assert.equal(actual.remaining, 0, 'the actual window must close after receiving the posted button messages');
});

test('known overlay is found behind unknown foreground and hidden or degenerate duplicates of its class', { skip: windowsOnly }, () => {
  const actual = runDialog('fullscreen');
  assert.equal(actual.foreground, actual.unknown);
  assert.equal(actual.selected, actual.expected, 'enumeration must consider all windows of a known class');
  assert.equal(actual.clicked, true, JSON.stringify(actual));
  assert.equal(actual.wrongClicks, 0);
  assert.equal(actual.remaining, 0);
});

test('small WebHintUI still scans its own client coordinates and closes after the posted click', { skip: windowsOnly }, () => {
  const actual = runDialog('small');
  assert.equal(actual.selected, actual.expected);
  assert.equal(actual.clicked, true);
  assert.equal(actual.clicks, 1);
  assert.equal(actual.wrongClicks, 0);
  assert.ok(Math.abs(actual.x - 271) <= 12 && Math.abs(actual.y - 201) <= 12, JSON.stringify(actual));
  assert.equal(actual.remaining, 0);
});

test('unknown same-process window is not a confirmation dialog and receives no input', { skip: windowsOnly }, () => {
  const actual = runDialog('none');
  assert.equal(actual.foreground, actual.unknown, 'fixture must put an unknown same-process window in the foreground');
  assert.equal(actual.selected, 0);
  assert.equal(actual.clicked, false);
  assert.equal(actual.clicks, 0);
  assert.equal(actual.remaining, 0);
});

test('dialog fixture reacquires its unknown foreground after another owned window becomes active', { skip: windowsOnly }, () => {
  const actual = runDialog('fullscreen', { reacquire: true });
  assert.equal(actual.diverted, actual.check, 'the fixture must first observe a different real foreground HWND');
  assert.equal(actual.foreground, actual.unknown, 'the requested unknown window must regain actual foreground');
  assert.equal(actual.selected, actual.expected);
  assert.equal(actual.clicked, true);
  assert.equal(actual.wrongClicks, 0);
  assert.equal(actual.remaining, 0);
});
