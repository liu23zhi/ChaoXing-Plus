param(
  [int]$ClientPid = 0,
  [string]$ProcessName = 'CXExam',
  [string]$ScreenshotPath = ''
)
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CxRenderProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int maxCount);
}
"@

$result = [ordered]@{
  collectedAt = (Get-Date).ToString('o')
  appliedDpi = $null
  systemDpi = $null
  scale = $null
  screen = $null
  monitors = @()
  windows = @()
  clientProcesses = @()
  windowScreenshot = $null
  errors = @()
}

try {
  $result.appliedDpi = (Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name AppliedDPI -ErrorAction Stop).AppliedDPI
} catch {
  # AppliedDPI is missing on some Windows builds; fall back to GetDpiForSystem and do not count it as an error
}
try {
  [CxRenderProbe]::SetProcessDPIAware() | Out-Null
  $result.systemDpi = [CxRenderProbe]::GetDpiForSystem()
  if ($result.appliedDpi -eq $null) { $result.appliedDpi = $result.systemDpi }
  if ($result.systemDpi -gt 0) { $result.scale = [math]::Round($result.systemDpi / 96.0, 3) }
} catch {
  $result.errors += ('systemDpi: ' + $_.Exception.Message)
  try {
    $logPixels = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\FontDPI' -Name LogPixels -ErrorAction Stop).LogPixels
    $result.systemDpi = $logPixels
    if ($result.appliedDpi -eq $null) { $result.appliedDpi = $logPixels }
  } catch {
    $result.errors += ('logPixels: ' + $_.Exception.Message)
  }
}

try {
  [CxRenderProbe]::SetProcessDPIAware() | Out-Null
  $primary = [System.Windows.Forms.Screen]::PrimaryScreen
  $result.screen = [ordered]@{
    bounds = [ordered]@{ x = $primary.Bounds.X; y = $primary.Bounds.Y; width = $primary.Bounds.Width; height = $primary.Bounds.Height }
    workingArea = [ordered]@{ width = $primary.WorkingArea.Width; height = $primary.WorkingArea.Height }
  }
  $result.monitors = @(Get-CimInstance Win32_DesktopMonitor | ForEach-Object {
    [ordered]@{ deviceId = $_.DeviceID; screenWidth = $_.ScreenWidth; screenHeight = $_.ScreenHeight }
  })
} catch {
  $result.errors += ('screen: ' + $_.Exception.Message)
}

try {
  $result.clientProcesses = @(Get-CimInstance Win32_Process -Filter "Name='CXExam.exe'" | ForEach-Object {
    [ordered]@{
      processId = $_.ProcessId
      parentProcessId = $_.ParentProcessId
      executablePath = $_.ExecutablePath
      commandLine = $_.CommandLine
    }
  })
} catch {
  $result.errors += ('processes: ' + $_.Exception.Message)
}

# Find the client main window: prefer the target PID, then any visible CXExam window (CEF main window may live in a child process).
$candidates = @()
if ($ClientPid -gt 0) {
  $direct = Get-Process -Id $ClientPid
  if ($direct -and $direct.MainWindowHandle -ne [IntPtr]::Zero) {
    $candidates += [pscustomobject]@{ processId = $ClientPid; handle = $direct.MainWindowHandle }
  }
}
if ($candidates.Count -eq 0) {
  Get-Process -Name $ProcessName | ForEach-Object {
    if ($_.MainWindowHandle -ne [IntPtr]::Zero) {
      $candidates += [pscustomobject]@{ processId = $_.Id; handle = $_.MainWindowHandle }
    }
  }
}

$best = $null
foreach ($candidate in $candidates) {
  $rect = New-Object CxRenderProbe+RECT
  if (-not [CxRenderProbe]::GetWindowRect($candidate.handle, [ref]$rect)) { continue }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { continue }
  $nameBuilder = New-Object System.Text.StringBuilder 256
  [CxRenderProbe]::GetClassName($candidate.handle, $nameBuilder, 256) | Out-Null
  $windowDpi = 0
  try { $windowDpi = [CxRenderProbe]::GetDpiForWindow($candidate.handle) } catch {}
  $entry = [ordered]@{
    processId = $candidate.processId
    title = (Get-Process -Id $candidate.processId).MainWindowTitle
    className = $nameBuilder.ToString()
    visible = [CxRenderProbe]::IsWindowVisible($candidate.handle)
    rect = [ordered]@{ left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom; width = $width; height = $height }
    windowDpi = $windowDpi
    dpiAware = ($windowDpi -ge 96 -and $windowDpi -ne 96)
  }
  $entry.area = $width * $height
  $result.windows += $entry
  if (-not $best -or ($width * $height) -gt ($best.width * $best.height)) {
    $best = [pscustomobject]@{ width = $width; height = $height; rect = $rect; processId = $candidate.processId }
  }
}

if ($result.windows.Count -gt 1) {
  $result.windows = @($result.windows | Sort-Object -Property area -Descending)
}
if ($best -and $ScreenshotPath) {
  try {
    $directory = Split-Path -Parent $ScreenshotPath
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $bitmap = New-Object System.Drawing.Bitmap $best.width, $best.height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($best.rect.Left, $best.rect.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()
    $result.windowScreenshot = $ScreenshotPath
  } catch {
    $result.errors += ('screenshot: ' + $_.Exception.Message)
  }
}

$result | ConvertTo-Json -Depth 8
