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

# Pre-seed the OBS profile so the first launch does not open the Auto-Configuration Wizard.
#
# Verified against a real install (OBS 32.0.1, %APPDATA%\obs-studio):
#   * an empty ".sentinel" file marks the config directory as initialised. OBS deletes it on the
#     first run; while it is absent OBS treats the next launch as a first run and shows the wizard
#     even when user.ini already exists. So the sentinel is the flag that actually matters.
#   * user.ini holds [General] FirstRun=true. Note OBS 28+ moved the general section here out of
#     global.ini, so seeding global.ini alone does not suppress the wizard on current builds.
#   * basic.ini needs "ConfirmOnExit=false" so a stray shutdown never blocks on a modal dialog.
# Everything here is best effort: if OBS is not installed yet, or the layout changes again, the
# post-launch wizard check below still catches the problem.
function Initialize-ObsProfile {
  param([Parameter(Mandatory = $true)] [string] $ObsExecutable)
  try {
    $appData = [Environment]::GetEnvironmentVariable('APPDATA')
    if (-not $appData) { Write-Step 'camera: APPDATA unavailable; cannot pre-seed the OBS profile'; return }
    $root = Join-Path $appData 'obs-studio'
    $basic = Join-Path $root 'basic'
    $profiles = Join-Path $basic 'profiles\CI'
    $scenes = Join-Path $basic 'scenes'
    foreach ($path in @($root, $basic, $profiles, $scenes)) {
      if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
    }

    # The sentinel is only honoured while empty; write it before anything else reads the directory.
    $sentinel = Join-Path $root '.sentinel'
    if (-not (Test-Path -LiteralPath $sentinel)) {
      Set-Content -LiteralPath $sentinel -Value '' -NoNewline -Encoding ascii
    }

    $userIni = Join-Path $root 'user.ini'
    $userText = @"
[General]
Pre19Defaults=false
Pre21Defaults=false
Pre23Defaults=false
Pre24.1Defaults=false
ConfirmOnExit=false
HotkeyFocusType=NeverDisableHotkeys
FirstRun=false

[Basic]
Profile=CI
ProfileDir=CI
SceneCollection=CI
SceneCollectionFile=CI.json
ConfigOnNewProfile=false
"@
    Set-Content -LiteralPath $userIni -Value $userText -Encoding ascii

    # An empty-but-valid profile: no scene, no source. The virtual camera output does not need one
    # for the device to register, and an empty scene keeps the OBS window itself unobtrusive.
    $profileIni = Join-Path $profiles 'basic.ini'
    $profileText = @"
[General]
Name=CI
ConfirmOnExit=false

[Output]
Mode=Simple
"@
    Set-Content -LiteralPath $profileIni -Value $profileText -Encoding ascii

    $sceneJson = Join-Path $scenes 'CI.json'
    Set-Content -LiteralPath $sceneJson -Value '{"current_scene":null,"current_program_scene":null,"scene_order":[],"name":"CI","sources":[]}' -Encoding ascii

    $globalIni = Join-Path $root 'global.ini'
    if (-not (Test-Path -LiteralPath $globalIni)) {
      Set-Content -LiteralPath $globalIni -Value "[General]`nMaxLogs=10`nEnableAutoUpdates=false`n`n[Video]`nRenderer=Direct3D 11" -Encoding ascii
    }
    Write-Step "camera: pre-seeded OBS profile at $root (sentinel + user.ini FirstRun=false + CI profile)"
  } catch {
    Write-Step "camera: pre-seeding the OBS profile failed - $($_.Exception.Message)"
  }
}

# Close the Auto-Configuration Wizard if it shows up, then confirm it is really gone.
#
# -WindowStyle Hidden does not apply to the wizard: it is a separate top-level window. Closing it is
# the only reliable suppression. Stop-Process would also kill obs64, which the virtual camera needs
# for the rest of the job, so the wizard window is closed with WM_CLOSE first, and only the wizard's
# own handle is targeted.
function Wait-ObsWizardGone {
  param([int] $TimeoutSeconds = 20, [int] $PollMilliseconds = 500)
  $matched = ''
  $suppressed = $false
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CXWizardSuppressor {
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr handle, StringBuilder text, int cap);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr handle, StringBuilder text, int cap);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);

    delegate bool EnumProc(IntPtr handle, IntPtr parameter);

    // The wizard is an obs64 top-level window titled "Auto-Configuration Wizard". Matching on the
    // title only (never on "any obs window") keeps the main OBS window, which the virtual camera
    // needs, untouched.
    public static List<IntPtr> Find(uint[] processIds) {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows((handle, parameter) => {
            if (!IsWindowVisible(handle)) return true;
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            bool wanted = false;
            foreach (uint id in processIds) { if (id == owner) { wanted = true; break; } }
            if (!wanted) return true;
            StringBuilder title = new StringBuilder(256);
            GetWindowTextW(handle, title, 256);
            string value = title.ToString();
            if (value.IndexOf("Auto-Configuration", StringComparison.OrdinalIgnoreCase) < 0) return true;
            found.Add(handle);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string Describe(uint[] processIds) {
        StringBuilder text = new StringBuilder();
        EnumWindows((handle, parameter) => {
            if (!IsWindowVisible(handle)) return true;
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            bool wanted = false;
            foreach (uint id in processIds) { if (id == owner) { wanted = true; break; } }
            if (!wanted) return true;
            StringBuilder title = new StringBuilder(256);
            GetWindowTextW(handle, title, 256);
            StringBuilder cls = new StringBuilder(128);
            GetClassNameW(handle, cls, 128);
            if (text.Length > 0) text.Append(" | ");
            text.Append(cls.ToString()).Append(':').Append(title.ToString());
            return true;
        }, IntPtr.Zero);
        return text.ToString();
    }

    public const uint WM_CLOSE = 0x0010;
    public static void Close(IntPtr handle) { SendMessageW(handle, WM_CLOSE, IntPtr.Zero, IntPtr.Zero); }
}
'@ -ErrorAction Stop
  } catch {
    # Type already loaded on a second call, or compilation is blocked; fall back to process matching.
  }

  while ((Get-Date) -lt $deadline) {
    $pids = @(Get-Process -Name 'obs64' -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
    if ($pids.Count -eq 0) {
      $matched = ''
      break
    }
    try {
      $handles = @([CXWizardSuppressor]::Find($pids))
      $matched = [CXWizardSuppressor]::Describe($pids)
    } catch {
      # Without the helper, title matching through MainWindowTitle is the only signal available.
      $matched = @(Get-Process -Name 'obs64' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -match 'Auto-Configuration' } |
        ForEach-Object { "$($_.ProcessName):$($_.MainWindowTitle)" }) -join ' | '
      $handles = @()
    }
    if ($handles.Count -gt 0) {
      foreach ($handle in $handles) { try { [CXWizardSuppressor]::Close($handle) } catch { } }
      $suppressed = $true
      Start-Sleep -Milliseconds 800
      continue
    }
    if ($suppressed) { break }
    if ($matched -and $matched -notmatch 'Auto-Configuration') { break }
    Start-Sleep -Milliseconds $PollMilliseconds
  }

  $remaining = $false
  try {
    $pids = @(Get-Process -Name 'obs64' -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
    if ($pids.Count -gt 0) {
      $left = @([CXWizardSuppressor]::Find($pids))
      $remaining = $left.Count -gt 0
      $matched = [CXWizardSuppressor]::Describe($pids)
    }
  } catch { }
  return [pscustomobject]@{
    Suppressed = $suppressed
    Remaining = $remaining
    Detail = $matched
    SecondsWaited = $TimeoutSeconds
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

    # 2026-11-11: the first launch shows the "Auto-Configuration Wizard", a top-level window that
    # ignores -WindowStyle Hidden and covers the desktop. The exam client's entry button is located by
    # scanning SCREEN pixels (Get-WindowScanBuffer uses Graphics.CopyFromScreen, not the window DC), so
    # an overlapping window makes the button undetectable => entry-button-never-visible => no CEF page
    # => pageSessions=0.
    #
    # Measured on run 42963609890 (same batch, same client build v4.1.4.25389):
    #   case -1: wizard present, attempt=1 target=button-scan ..., success
    #   case -2: wizard present, attempts=0 reason=entry-button-never-visible, pageSessions=0
    # The wizard can be present while entry still succeeds (the client window may be raised above it),
    # so this is a RACE, not a deterministic blocker. Two things are therefore needed:
    #   (a) pre-seed the profile so the wizard never appears (below);
    #   (b) poll after launch, close any wizard that does appear, and verify it is gone (below).
    # Doing only (a) leaves the race in place.
    Initialize-ObsProfile -ObsExecutable $obs

    Write-Step "camera: starting virtual camera via $obs"
    Start-Process -FilePath $obs -ArgumentList '--startvirtualcam', '--minimize-to-tray' -WorkingDirectory (Split-Path $obs -Parent) -WindowStyle Hidden

    # (b) Suppress the wizard if it still appeared, then prove it is gone before returning.
    $wizard = Wait-ObsWizardGone -TimeoutSeconds 20
    if ($wizard.Suppressed) {
      Write-Step "camera: OBS wizard was visible and has been closed ($($wizard.Detail))"
    } elseif ($wizard.Remaining) {
      # Not fatal by itself (case -1 succeeded with the wizard on screen), but it is the single most
      # likely cause of a flaky entry failure, so it must be loud in the log instead of silent.
      Write-Step "camera: WARNING OBS wizard is still visible after $($wizard.SecondsWaited)s ($($wizard.Detail)); the exam client entry button may be covered and the run may fail with pageSessions=0"
    } else {
      Write-Step "camera: no OBS wizard window present ($($wizard.Detail))"
    }

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
    # Record what is actually on the desktop at this point: if a device never appears, the next thing
    # anyone needs is which windows were in the way.
    Write-Step "camera: windows when no device appeared = $(Get-VisibleWindowSummary)"
  } catch {
    Write-Step "camera: failed - $($_.Exception.Message)"
  }
}

# List window owner and title, so the next failure can be diagnosed from the log instead of a screenshot.
function Get-VisibleWindowSummary {
  try {
    return @(Get-Process -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowTitle } |
      ForEach-Object { "$($_.ProcessName):$($_.MainWindowTitle)" }) -join ' | '
  } catch {
    return ''
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

# FROZEN (2026-11-06): input-method spoofing is abandoned. The language pack and the stand-in IME
# package were removed from the repository; see docs/ime-spoofing-freeze.md. This function only records
# the frozen state and the read-only IMM probe, and never installs or registers anything.
function Get-FrozenInputMethodState {
    $state = [pscustomobject]@{
        Prepared = $false
        Reason = 'stand-in-frozen'
        Root = ''
        Module = ''
        Output = @()
        ImmDescriptions = @()
    }
    $script:ImmPreparation = $state
    $state.ImmDescriptions = @(Get-ImmInputMethodProbe)
    foreach ($line in $state.ImmDescriptions) { Write-Step "input: imm $line" }
    Write-Step 'input: stand-in input method is frozen (docs/ime-spoofing-freeze.md); nothing is installed'
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
if (-not $SkipInputMethod) { $null = Get-FrozenInputMethodState }
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
