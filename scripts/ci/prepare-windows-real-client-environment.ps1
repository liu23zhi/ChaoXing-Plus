# Prepare the interactive desktop that the real exam client expects on the CI runner.
#
# The client refuses to enter an exam unless its environment check passes, and the hosted runner fails
# two items by default:
#   * resolution - the default 1024x768 desktop clips the client's 1200x700 check window;
#   * camera and input method - "no camera detected" and "no supported input method detected".
# This script raises the resolution, registers a repository-local stand-in input method (the client needs
# a non-empty ImmGetDescriptionW, which only IME-marked layouts can provide) and starts a virtual camera.
# It never downloads or installs a third-party input method. Every step is bounded and best effort: the
# injection step still reports the real outcome through its screenshots and report, so a failed
# preparation is visible instead of silent - and a hanging Windows component cannot eat the job timeout.
#
# Keep this file pure ASCII.

[CmdletBinding()]
param(
  [int] $MinWidth = 1920,
  [int] $MinHeight = 1080,
  [int] $CapabilityTimeoutSeconds = 180,
  [int] $CameraTimeoutSeconds = 300,
  [int] $DpiScalePercent = 150,
  [switch] $SkipCamera,
  [switch] $SkipInputMethod,
  [switch] $SkipResolution,
  [switch] $TryDpiScaling,
  [switch] $DryRun
)

$ErrorActionPreference = 'Continue'
$script:ImmPreparation = $null

# Provides CXInputState (keyboard layout enumeration) for the before/after logs.
$inputHelper = Join-Path (Split-Path $PSScriptRoot -Parent) 'windows-client-input.ps1'
if (Test-Path -LiteralPath $inputHelper) { . $inputHelper }

function Write-Step([string] $message) {
  Write-Host "[desktop-prep] $message"
}

# Run a script block in a child process and give up after the timeout instead of blocking the job.
function Invoke-Bounded {
  param(
    [Parameter(Mandatory = $true)] [scriptblock] $Action,
    [Parameter(Mandatory = $true)] [string] $Label,
    [int] $TimeoutSeconds = 300
  )
  if ($DryRun) {
    Write-Step "$Label : dry run, skipped"
    return [pscustomobject]@{ Ok = $false; TimedOut = $false; Output = @() }
  }
  Write-Step "$Label : starting (timeout ${TimeoutSeconds}s)"
  $job = Start-Job -ScriptBlock $Action
  try {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $nextHeartbeat = (Get-Date).AddSeconds(15)
    while ($job.State -eq 'Running' -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 3
      if ((Get-Date) -ge $nextHeartbeat) {
        $elapsed = [int]((Get-Date) - ($deadline.AddSeconds(-$TimeoutSeconds))).TotalSeconds
        Write-Step "$Label : still running after ${elapsed}s (state $($job.State))"
        $nextHeartbeat = (Get-Date).AddSeconds(15)
      }
    }
    if ($job.State -eq 'Running') {
      Write-Step "$Label : timed out after ${TimeoutSeconds}s; stopping"
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      return [pscustomobject]@{ Ok = $false; TimedOut = $true; Output = @() }
    }
    $output = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
    $failed = $job.State -ne 'Completed' -or $job.ChildJobs[0].JobStateInfo.Reason -ne $null
    foreach ($line in $output) { Write-Step "$Label : $line" }
    return [pscustomobject]@{ Ok = -not $failed; TimedOut = $false; Output = $output }
  } finally {
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}

function Get-DisplayModes {
  $source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class CXDisplay {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public struct DEVMODE {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra;
        public int dmFields; public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation;
        public int dmDisplayFixedOutput; public short dmColor; public short dmDuplex; public short dmYResolution;
        public short dmTTOption; public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
        public int dmDisplayFlags; public int dmDisplayFrequency;
        public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
        public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Ansi)]
    public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
    [DllImport("user32.dll", CharSet = CharSet.Ansi)]
    public static extern int ChangeDisplaySettings(ref DEVMODE devMode, int flags);

    public static List<int[]> Modes() {
        var list = new List<int[]>();
        DEVMODE mode = new DEVMODE();
        mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        for (int index = 0; EnumDisplaySettings(null, index, ref mode); index++) {
            list.Add(new int[] { mode.dmPelsWidth, mode.dmPelsHeight, mode.dmBitsPerPel, mode.dmDisplayFrequency });
        }
        return list;
    }

    public static int Apply(int width, int height) {
        DEVMODE mode = new DEVMODE();
        mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        int index = 0;
        while (EnumDisplaySettings(null, index, ref mode)) {
            if (mode.dmPelsWidth == width && mode.dmPelsHeight == height) {
                mode.dmFields = 0x80000 | 0x100000;
                return ChangeDisplaySettings(ref mode, 0);
            }
            index++;
        }
        return -1;
    }
}
'@
  Add-Type -TypeDefinition $source -ErrorAction Stop
  return [CXDisplay]::Modes()
}

function Set-DesktopResolution {
  try {
    $modes = Get-DisplayModes
    if (-not $modes -or $modes.Count -eq 0) { Write-Step 'resolution: no modes reported'; return }
    $wanted = $modes | Where-Object { $_[0] -ge $MinWidth -and $_[1] -ge $MinHeight } |
      Sort-Object @{ Expression = { $_[0] * $_[1] } } | Select-Object -First 1
    if (-not $wanted) {
      $wanted = $modes | Sort-Object @{ Expression = { $_[0] * $_[1] } } -Descending | Select-Object -First 1
    }
    $targetWidth = $wanted[0]
    $targetHeight = $wanted[1]
    Write-Step "resolution: ${targetWidth}x${targetHeight} selected from $($modes.Count) modes (min ${MinWidth}x${MinHeight})"
    if ($DryRun) { Write-Step 'resolution: dry run, not applied'; return }
    $result = [CXDisplay]::Apply($targetWidth, $targetHeight)
    Write-Step "resolution: ChangeDisplaySettings returned $result (0 = applied)"
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    try {
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      Write-Step "resolution: active screen now $($bounds.Width)x$($bounds.Height)"
    } catch { }
  } catch {
    Write-Step "resolution: failed - $($_.Exception.Message)"
  }
}

function Get-CameraDevices {
  try {
    return @(Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction SilentlyContinue |
      Where-Object { $_.PNPClass -eq 'Camera' -or $_.PNPClass -eq 'Image' -or $_.Service -eq 'usbvideo' })
  } catch {
    return @()
  }
}

function Add-VirtualCamera {
  try {
    $existing = Get-CameraDevices
    if ($existing.Count -gt 0) {
      Write-Step "camera: already present - $(($existing | ForEach-Object { $_.Name }) -join ', ')"
      return
    }
    if ($DryRun) { Write-Step 'camera: dry run, not installed'; return }
    $choco = Get-Command choco.exe -ErrorAction SilentlyContinue
    if (-not $choco) { Write-Step 'camera: chocolatey not available; virtual camera unavailable'; return }
    $install = Invoke-Bounded -Label 'camera: choco install obs-studio' -TimeoutSeconds $CameraTimeoutSeconds -Action {
      & choco.exe install obs-studio --no-progress -y 2>&1 | Where-Object { $_ -match 'installed|error|fail' } | Select-Object -Last 5
    }
    Write-Step "camera: install completed ok=$($install.Ok) timedOut=$($install.TimedOut)"

    $obs = @(
      (Join-Path ${env:ProgramFiles} 'obs-studio\bin\64bit\obs64.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'obs-studio\bin\64bit\obs64.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $obs) { Write-Step 'camera: OBS executable not found; virtual camera unavailable'; return }

    Write-Step "camera: starting virtual camera via $obs"
    Start-Process -FilePath $obs -ArgumentList '--startvirtualcam', '--minimize-to-tray' -WorkingDirectory (Split-Path $obs -Parent) -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
      $devices = Get-CameraDevices
      if ($devices.Count -gt 0) {
        Write-Step "camera: devices after start = $(($devices | ForEach-Object { $_.Name }) -join ', ')"
        return
      }
      Start-Sleep -Seconds 3
    }
    Write-Step 'camera: no device appeared after starting the virtual camera'
  } catch {
    Write-Step "camera: failed - $($_.Exception.Message)"
  }
}

# The client decides "input method detected" from ImmGetDescriptionW, so the same value is logged here: an
# empty description for every layout means the check will fail no matter how many IMEs are installed.
function Initialize-ImmInputMethodProbe {
    if ('CXImmProbe' -as [type]) { return }
    $source = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class CXImmProbe {
    [DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int count, IntPtr[] layouts);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr LoadKeyboardLayoutW(string klid, uint flags);
    [DllImport("imm32.dll", CharSet = CharSet.Unicode)] public static extern int ImmGetDescriptionW(IntPtr layout, StringBuilder text, int cap);

    public static string Load(string klid) {
        IntPtr layout = LoadKeyboardLayoutW(klid, 0);
        return layout == IntPtr.Zero ? string.Empty : "0x" + layout.ToInt64().ToString("X8");
    }

    public static string[] Describe() {
        int count = GetKeyboardLayoutList(0, null);
        if (count <= 0) return new string[0];
        IntPtr[] layouts = new IntPtr[count];
        int read = GetKeyboardLayoutList(count, layouts);
        List<string> result = new List<string>();
        for (int i = 0; i < read; i++) {
            StringBuilder text = new StringBuilder(512);
            int length = ImmGetDescriptionW(layouts[i], text, 512);
            string description = length > 0 ? text.ToString() : "<empty>";
            result.Add("0x" + layouts[i].ToInt64().ToString("X8") + "=" + description);
        }
        return result.ToArray();
    }
}
'@
    Add-Type -TypeDefinition $source -ErrorAction Stop
}

function Get-ImmInputMethodProbe {
    try {
        Initialize-ImmInputMethodProbe
        return @([CXImmProbe]::Describe())
    } catch {
        return @("probe-failed: $($_.Exception.Message)")
    }
}

function Test-ImmInputMethodReady {
    param([string[]] $Descriptions, [string] $Handle = '')
    foreach ($line in @($Descriptions)) {
        if ($line -notmatch '^(0x[0-9a-fA-F]{8,16})=(.+)$') { continue }
        if ($Handle -and $Matches[1] -ne $Handle) { continue }
        $description = $Matches[2].Trim()
        if ($description -and $description -ne '<empty>') { return $true }
    }
    return $false
}

# The client only accepts input methods whose ImmGetDescriptionW is non-empty (IG5: FUN_004a6b30 keeps
# only layouts with a description). Windows answers that call only for IME-marked layouts (KLID E0xxxxxx)
# whose IME module loads, so TSF-only IMEs and plain keyboard layouts never qualify. The repository ships a
# stand-in IME (tools/fake-ime): no third-party installer, no download, no network.
function Get-StandInImeRoot {
    $starts = @($PSScriptRoot, $env:GITHUB_WORKSPACE, (Get-Location).Path)
    foreach ($start in $starts) {
        if (-not $start) { continue }
        $probe = $start
        while ($probe) {
            $candidate = Join-Path $probe 'tools/fake-ime'
            if (Test-Path -LiteralPath (Join-Path $candidate 'Install-FakeInputMethod.ps1')) { return $candidate }
            $parent = Split-Path $probe -Parent
            if (-not $parent -or $parent -eq $probe) { break }
            $probe = $parent
        }
    }
    return ''
}

function Build-StandInImeModule {
    param([Parameter(Mandatory = $true)] [string] $Root)
    $builder = Join-Path $Root 'build-cxime.ps1'
    if (-not (Test-Path -LiteralPath $builder)) { return $false }
    $result = Invoke-Bounded -Label 'input: build stand-in IME module' -TimeoutSeconds 300 -Action {
        & $builder *>&1 | Select-Object -Last 5
    }
    return [bool]$result.Ok
}

# Registers a local IMM layout (KLID E0F00804) bound to the stand-in IME module and loads it into this
# session. Everything is read back through the client's own criterion before it is reported as prepared.
function Install-StandInInputMethod {
    $state = [pscustomobject]@{ Prepared = $false; Reason = ''; Root = ''; Module = ''; Output = @(); ImmDescriptions = @() }
    $script:ImmPreparation = $state
    $state.ImmDescriptions = @(Get-ImmInputMethodProbe)
    if (Test-ImmInputMethodReady -Descriptions $state.ImmDescriptions) {
        $state.Prepared = $true
        $state.Reason = 'already-ready'
        Write-Step 'input: an IMM description is already readable; stand-in input method not needed'
        return $state
    }
    if ($DryRun) {
        $state.Reason = 'dry-run'
        Write-Step 'input: dry run, stand-in input method not installed'
        return $state
    }
    $root = Get-StandInImeRoot
    if (-not $root) {
        $state.Reason = 'stand-in-fixture-missing'
        Write-Step 'input: fake-ime fixture not found; cannot prepare an input method'
        return $state
    }
    $state.Root = $root
    # Nothing prebuilt is shipped: the module is compiled from the repository in the CI job/step.
    $module = Join-Path $root 'build\cxime32.dll'
    if (-not (Test-Path -LiteralPath $module)) {
        if (-not (Build-StandInImeModule -Root $root)) {
            $state.Reason = 'stand-in-build-failed'
            Write-Step 'input: stand-in IME module could not be built; no IMM description will be readable'
            return $state
        }
    }
    $state.Module = $module
    $installer = Join-Path $root 'Install-FakeInputMethod.ps1'
    # -NoDefault keeps the real client's own input language untouched: the client only needs an IME layout
    # with a readable description, and changing the default input language would alter the run's inputs.
    $output = & $installer -DisplayName 'StandInInput' -NoDefault *>&1
    $code = $LASTEXITCODE
    $state.Output = @($output | ForEach-Object { [string]$_ })
    foreach ($line in $state.Output) { Write-Step "input: $line" }
    $state.ImmDescriptions = @(Get-ImmInputMethodProbe)
    foreach ($line in $state.ImmDescriptions) { Write-Step "input: imm $line" }
    if ($code -eq 3) {
        # English-only images reject legacy IMM layouts outright; that is a host limitation, not a prep bug.
        $state.Reason = 'stand-in-host-unavailable'
    } elseif ($code -ne 0) {
        $state.Reason = 'stand-in-install-failed'
    } elseif (Test-ImmInputMethodReady -Descriptions $state.ImmDescriptions) {
        $state.Prepared = $true
        $state.Reason = 'stand-in-installed'
    } else {
        $state.Reason = 'stand-in-installed-but-not-ready'
    }
    Write-Step "input: prepared=$($state.Prepared) reason=$($state.Reason) root='$($state.Root)'"
    return $state
}

function Get-InputMethodSummary {
    $descriptions = @(Get-ImmInputMethodProbe)
    $layouts = @()
    try { $layouts = @([CXInputState]::LayoutHandles()) } catch { }
    $languages = @()
    try { $languages = @(Get-WinUserLanguageList | ForEach-Object { [string](@($_.LanguageTag)[0]) }) } catch { }
    return [pscustomobject]@{
        Layouts = $layouts
        ImmDescriptions = $descriptions
        Languages = $languages
        Prepared = (Test-ImmInputMethodReady -Descriptions $descriptions)
        ImmPreparation = $script:ImmPreparation
    }
}

# The client draws its check window at the 1200x700 design size scaled by the system DPI: 96 DPI gives a
# 1200x700 window, 150% gives 1800x1050 (what a local high-DPI machine shows). Raising LogPixels only
# reaches newly started processes after a new sign-in, so this is opt-in and always verified afterwards.
function Set-SystemDpiScaling {
  $desktop = 'HKCU:\Control Panel\Desktop'
  $wanted = [int][Math]::Round(96 * $DpiScalePercent / 100)
  try {
    $current = (Get-ItemProperty -LiteralPath $desktop -Name LogPixels -ErrorAction SilentlyContinue).LogPixels
    Write-Step "dpi: LogPixels before = $current (wanted $wanted for $DpiScalePercent percent)"
    if ($DryRun) { Write-Step 'dpi: dry run, not changed'; return }
    Set-ItemProperty -LiteralPath $desktop -Name 'LogPixels' -Value $wanted -Type DWord
    Set-ItemProperty -LiteralPath $desktop -Name 'Win8DpiScaling' -Value 1 -Type DWord
    foreach ($process in @(Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
      try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch { }
    }
    Start-Sleep -Seconds 5
  } catch {
    Write-Step "dpi: change failed - $($_.Exception.Message)"
    return
  }
  $probe = @'
using System;
using System.Runtime.InteropServices;
public class CXDpiProbe {
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr handle);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr handle, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr dc, int index);
    public static int SystemDpi() {
        IntPtr dc = GetDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) return 0;
        int value = GetDeviceCaps(dc, 88);
        ReleaseDC(IntPtr.Zero, dc);
        return value;
    }
}
'@
  try {
    Add-Type -TypeDefinition $probe -ErrorAction SilentlyContinue
    $effective = [CXDpiProbe]::SystemDpi()
    Write-Step "dpi: effective SystemDpi after change = $effective (target $wanted needs a new sign-in)"
  } catch {
    Write-Step "dpi: probe failed - $($_.Exception.Message)"
  }
}

if (-not $SkipResolution) { Set-DesktopResolution }
if ($TryDpiScaling) { Set-SystemDpiScaling }
if (-not $SkipInputMethod) { $null = Install-StandInInputMethod }
if (-not $SkipCamera) { Add-VirtualCamera }

try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen
  if ($screen) { Write-Step "desktop: $($screen.Bounds.Width)x$($screen.Bounds.Height) primary=$($screen.Primary)" }
} catch { }
if (Get-Command Get-WinUserLanguageList -ErrorAction SilentlyContinue) {
  Write-Step "input: final languages = $((Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag }) -join ',')"
}

# Everything the next diagnosis needs, both on the console and as an artifact: the client's own acceptance
# rule is ImmGetDescriptionW, so its value per layout is the single most useful line here.
try {
  $summary = Get-InputMethodSummary
  foreach ($line in @($summary.ImmDescriptions)) { Write-Step "input: imm $line" }
  Write-Step "input: layouts = $(@($summary.Layouts) -join ',')"
  Write-Step "input: stand-in root='$($summary.ImmPreparation.Root)' reason='$($summary.ImmPreparation.Reason)'"
  Write-Step "input: prepared=$($summary.Prepared) (requires an enumerated non-empty IMM description)"
  if ($env:RUNNER_TEMP) {
    $screenSize = ''
    try {
      Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
      $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      if ($bounds) { $screenSize = "$($bounds.Width)x$($bounds.Height)" }
    } catch { }
    $payload = [pscustomobject]@{
      capturedAt = (Get-Date).ToString('o')
      screen = $screenSize
      layouts = @($summary.Layouts)
      immDescriptions = @($summary.ImmDescriptions)
      languages = @($summary.Languages)
      standIn = $summary.ImmPreparation
      prepared = [bool]$summary.Prepared
      immPreparation = $summary.ImmPreparation
      dryRun = [bool]$DryRun
    }
    $summaryPath = Join-Path $env:RUNNER_TEMP 'cx-real-client-prep-summary.json'
    $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
    Write-Step "summary: $summaryPath"
  }
} catch {
  Write-Step "summary: failed - $($_.Exception.Message)"
}
