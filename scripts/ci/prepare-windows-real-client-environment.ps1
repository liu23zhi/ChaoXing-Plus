# Prepare the interactive desktop that the real exam client expects on the CI runner.
#
# The client refuses to enter an exam unless its environment check passes, and the hosted runner fails
# two items by default:
#   * resolution - the default 1024x768 desktop clips the client's 1200x700 check window;
#   * camera and input method - "no camera detected" and "no supported input method detected".
# This script raises the resolution, registers Microsoft Pinyin/Wubi when the zh-CN payload exists, installs
# Sogou Pinyin (the client's input method check needs a non-empty ImmGetDescriptionW, which TSF-only IMEs do
# not provide) and starts a virtual camera. Every step is bounded and best effort: the injection step still
# reports the real outcome through its screenshots and report, so a failed preparation is visible instead of
# silent - and a hanging Windows component cannot eat the job timeout.
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
  [string] $SogouImeInstaller = '',
  [switch] $SkipSogouInputMethod,
  [switch] $TryDpiScaling,
  [switch] $DryRun
)

$ErrorActionPreference = 'Continue'

# Provides CXInputState (keyboard layout enumeration) for the before/after logs.
$inputHelper = Join-Path (Split-Path $PSScriptRoot -Parent) 'windows-client-input.ps1'
if (Test-Path -LiteralPath $inputHelper) { . $inputHelper }

# Microsoft Pinyin and Microsoft Wubi input method tips (shipped with the zh-CN language).
$script:PinyinTip = '0804:{81D4E9C9-1D3B-41BC-9E6C-4B40BF79E35E}{FA550B04-5AD7-411F-A5AC-CA038EC515D7}'
$script:WubiTip = '0804:{E7EA138E-69F8-11D7-A6EA-00065B844310}{E7EA138F-69F8-11D7-A6EA-00065B844311}'

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

function Get-LanguageCapabilityState {
  try {
    $capability = Get-WindowsCapability -Online -Name 'Language.Basic~~~zh-CN~0.0.1.0' -ErrorAction Stop
    if (-not $capability) { return 'Unknown' }
    return [string]$capability.State
  } catch {
    Write-Step "input: cannot query Language.Basic~~~zh-CN - $($_.Exception.Message)"
    return 'Unknown'
  }
}

function Test-LanguageInstalled {
  return ((Get-LanguageCapabilityState) -eq 'Installed')
}

function Install-ChineseLanguageFiles {
  if ($DryRun) { Write-Step 'input: dry run, language capability untouched'; return $false }
  if (Test-LanguageInstalled) { Write-Step 'input: zh-CN language files already installed'; return $true }
  $state = Get-LanguageCapabilityState
  Write-Step "input: Language.Basic~~~zh-CN state = $state"
  try {
    $zh = @(Get-WindowsCapability -Online | Where-Object { $_.Name -like '*zh-CN*' } |
      Select-Object -First 8 | ForEach-Object { "$($_.Name)=$($_.State)" })
    Write-Step "input: zh-CN capabilities = $(($zh -join ', '))"
  } catch { }
  if ($state -eq 'NotPresent') {
    Write-Step 'input: this image has no zh-CN payload (State=NotPresent); skipping the download instead of waiting for a timeout'
    return $false
  }
  $result = Invoke-Bounded -Label 'input: Add-WindowsCapability Language.Basic~~~zh-CN' -TimeoutSeconds $CapabilityTimeoutSeconds -Action {
    Add-WindowsCapability -Online -Name 'Language.Basic~~~zh-CN~0.0.1.0' -ErrorAction Stop | Out-Null
    'capability added'
  }
  if (Test-LanguageInstalled) { Write-Step 'input: zh-CN language files installed'; return $true }

  # Second attempt through DISM, which reports its own progress and fails faster than the cmdlet.
  $dism = Invoke-Bounded -Label 'input: dism Add-Capability Language.Basic~~~zh-CN' -TimeoutSeconds $CapabilityTimeoutSeconds -Action {
    $output = & dism.exe /Online /Add-Capability /CapabilityName:'Language.Basic~~~zh-CN~0.0.1.0' /Quiet /NoRestart 2>&1
    $code = $LASTEXITCODE
    $output | Select-Object -Last 3
    "dism exit $code"
  }
  if (Test-LanguageInstalled) { Write-Step 'input: zh-CN language files installed (dism)'; return $true }
  Write-Step "input: zh-CN language files still missing (cmdlet timedOut=$($result.TimedOut), dismOk=$($dism.Ok))"
  return $false
}

function Set-MicrosoftInputMethods {
  $result = Invoke-Bounded -Label 'input: Set-WinUserLanguageList (Pinyin + Wubi)' -TimeoutSeconds 120 -Action {
    $list = New-WinUserLanguageList -Language 'zh-Hans-CN'
    $list[0].InputMethodTips.Clear()
    $list[0].InputMethodTips.Add('0804:{81D4E9C9-1D3B-41BC-9E6C-4B40BF79E35E}{FA550B04-5AD7-411F-A5AC-CA038EC515D7}')
    $list[0].InputMethodTips.Add('0804:{E7EA138E-69F8-11D7-A6EA-00065B844310}{E7EA138F-69F8-11D7-A6EA-00065B844311}')
    Set-WinUserLanguageList -LanguageList $list -Force -ErrorAction Stop
    'language list written'
  }
  return $result.Ok
}

function Add-ChineseInputMethod {
  try {
    $before = @(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag })
    Write-Step "input: languages before = $($before -join ',')"
    $layoutsBefore = @([CXInputState]::LayoutHandles())
    Write-Step "input: layouts before = $($layoutsBefore -join ',')"
  } catch {
    Write-Step "input: cannot read current languages - $($_.Exception.Message)"
  }
  if (-not (Install-ChineseLanguageFiles)) {
    Write-Step 'input: skipping Pinyin/Wubi registration because the zh-CN files are unavailable'
    return
  }
  if ($DryRun) { Write-Step 'input: dry run, language list not modified'; return }
  if (-not (Set-MicrosoftInputMethods)) { Write-Step 'input: language list update failed'; return }
  try {
    $after = @(Get-WinUserLanguageList | ForEach-Object { "$($_.LanguageTag) [$(@($_.InputMethodTips) -join ' ')]" })
    Write-Step "input: languages after = $($after -join ' | ')"
    $layouts = @([CXInputState]::LayoutHandles())
    Write-Step "input: layouts after = $($layouts -join ',')"
  } catch {
    Write-Step "input: verification failed - $($_.Exception.Message)"
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

function Get-RegisteredSogouImmLayouts {
    $root = 'HKLM:\SYSTEM\CurrentControlSet\Control\Keyboard Layouts'
    if (-not (Test-Path -LiteralPath $root)) { return @() }
    $result = @()
    foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
        $klid = [string]$key.PSChildName
        if ($klid -notmatch '^[0-9a-fA-F]{8}$') { continue }
        $values = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
        if (-not $values -or [string]$values.'IME file' -notmatch '\.ime$') { continue }
        $identity = "$($values.'IME file') $($values.'Layout Text') $($values.'Layout Display Name')"
        if ($identity -notmatch 'sogou') { continue }
        $result += $klid.ToUpperInvariant()
    }
    return @($result | Sort-Object -Unique)
}

function Import-ImmInputMethodLayout {
    param([string] $Klid)
    if ($Klid -notmatch '^[0-9a-fA-F]{8}$') { throw 'invalid registered IMM layout identifier' }
    Initialize-ImmInputMethodProbe
    return [CXImmProbe]::Load($Klid)
}

# Installation is independent from IMM readiness. Load only actual Sogou registrations, then enumerate
# again: Windows can return the default HKL or ignore loading from a process without keyboard focus.
# No registry values, default input language or keyboard API results are fabricated here.
function Enable-SogouImmInputMethod {
    param([switch] $Quiet)
    $state = [pscustomobject]@{ Prepared = $false; Reason = ''; Candidates = @(); Attempts = @(); ImmDescriptions = @(Get-ImmInputMethodProbe) }
    if (Test-ImmInputMethodReady -Descriptions $state.ImmDescriptions) {
        $state.Prepared = $true
        $state.Reason = 'already-ready'
        return $state
    }
    try { $state.Candidates = @(Get-RegisteredSogouImmLayouts) }
    catch {
        $state.Reason = 'registry-probe-failed'
        if (-not $Quiet) { Write-Step "input: prepared=false reason=$($state.Reason) error=$($_.Exception.Message)" }
        return $state
    }
    if ($DryRun) { $state.Reason = 'dry-run' }
    elseif (-not $state.Candidates.Count) { $state.Reason = 'no-registered-sogou-imm-layout' }
    else {
        $state.Reason = 'registered-sogou-imm-not-ready'
        foreach ($klid in $state.Candidates) {
            $attempt = [pscustomobject]@{ Klid = $klid; Handle = ''; Ready = $false; Error = '' }
            try {
                $attempt.Handle = [string](Import-ImmInputMethodLayout -Klid $klid)
                $state.ImmDescriptions = @(Get-ImmInputMethodProbe)
                # A fallback to a default layout is not evidence that this registered IME loaded.
                if ($attempt.Handle -match '^0x[0-9a-fA-F]{8,16}$' -and $attempt.Handle.EndsWith($klid, [StringComparison]::OrdinalIgnoreCase)) {
                    $attempt.Ready = Test-ImmInputMethodReady -Descriptions $state.ImmDescriptions -Handle $attempt.Handle
                }
            } catch { $attempt.Error = $_.Exception.Message }
            $state.Attempts += $attempt
            if (-not $Quiet -or $attempt.Ready) { Write-Step "input: IMM load klid=$klid handle='$($attempt.Handle)' ready=$($attempt.Ready) error='$($attempt.Error)'" }
            if ($attempt.Ready) { $state.Prepared = $true; $state.Reason = 'registered-sogou-imm-loaded'; break }
        }
    }
    if (-not $Quiet -or $state.Prepared) { Write-Step "input: prepared=$($state.Prepared) reason=$($state.Reason) registeredSogouLayouts=$($state.Candidates -join ',')" }
    return $state
}

# Sogou setup can keep running after its IMM layer is usable. Poll in this process so that loading and
# describing the layout use the same keyboard layout list. Do not put the installer in a PowerShell job:
# disposing a still-running job can stop its wait/children, while we only need to stop waiting here.
function Invoke-SogouInstaller {
    param(
        [Parameter(Mandatory = $true)] [string] $FilePath,
        [Parameter(Mandatory = $true)] [string[]] $ArgumentList,
        [Parameter(Mandatory = $true)] [string] $Label,
        [int] $TimeoutSeconds = 180
    )
    if ($DryRun) {
        Write-Step "$Label : dry run, skipped"
        return [pscustomobject]@{ Ok = $false; TimedOut = $false; ImmReady = $false; StillRunning = $false; ExitCode = $null }
    }
    Write-Step "$Label : starting (IMM timeout ${TimeoutSeconds}s)"
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -PassThru -WindowStyle Hidden -ErrorAction Stop
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $nextHeartbeat = 15
    $exitCode = $null
    try {
        while ($true) {
            try {
                $script:SogouImmPreparation = Enable-SogouImmInputMethod -Quiet
                if ($script:SogouImmPreparation.Prepared) {
                    # Installer state is diagnostic only once IMM is ready.
                    $running = $null
                    try { $process.Refresh(); $running = -not $process.HasExited } catch { }
                    Write-Step "$Label : IMM ready; continuing without waiting for installer exit (pid=$($process.Id) running=$running)"
                    foreach ($line in @($script:SogouImmPreparation.ImmDescriptions)) { Write-Step "input: imm after install $line" }
                    return [pscustomobject]@{ Ok = $true; TimedOut = $false; ImmReady = $true; StillRunning = $running; ExitCode = $exitCode }
                }
            } catch { Write-Step "$Label : IMM probe failed - $($_.Exception.Message)" }
            $process.Refresh()
            if ($process.HasExited -and $null -eq $exitCode) {
                $process.WaitForExit()
                $exitCode = $process.ExitCode
                Write-Step "$Label : installer exit $exitCode (IMM not ready)"
                # Installer exit cannot establish IMM readiness; stop polling rather than waiting on a dead process.
                return [pscustomobject]@{ Ok = $false; TimedOut = $false; ImmReady = $false; StillRunning = $false; ExitCode = $exitCode }
            }
            if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                $running = -not $process.HasExited
                Write-Step "$Label : IMM not ready after ${TimeoutSeconds}s (pid=$($process.Id) running=$running); stopped waiting, installer left untouched"
                return [pscustomobject]@{ Ok = $false; TimedOut = $true; ImmReady = $false; StillRunning = $running; ExitCode = $exitCode }
            }
            if ($watch.Elapsed.TotalSeconds -ge $nextHeartbeat) {
                Write-Step "$Label : IMM not ready after $([int]$watch.Elapsed.TotalSeconds)s (pid=$($process.Id) running=$(-not $process.HasExited))"
                $nextHeartbeat = $watch.Elapsed.TotalSeconds + 15
            }
            $remainingMs = [Math]::Ceiling(($TimeoutSeconds - $watch.Elapsed.TotalSeconds) * 1000)
            Start-Sleep -Milliseconds ([int][Math]::Max(1, [Math]::Min(3000, $remainingMs)))
        }
    } finally {
        $watch.Stop()
        $process.Dispose()
    }
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
        Sogou = (Get-SogouInputState)
        Prepared = (Test-ImmInputMethodReady -Descriptions $descriptions)
        ImmPreparation = $script:SogouImmPreparation
    }
}

# The client only accepts input methods whose ImmGetDescriptionW is non-empty (IG5: FUN_004a6b30 drops
# layouts with an empty description). TSF-only IMEs, including Microsoft Pinyin, do not provide one, so
# such a machine still fails the check. Sogou's registered IMM layer must be loaded and verified; an
# installation directory or uninstall entry alone does not mean the client can enumerate an IME.
# No version is hardcoded: winget installs it, and the fallback derives the official URL from the
# community-maintained winget manifest (nullsoft installer, silent switch /S).
# $PSScriptRoot is empty when a function is re-used through Invoke-Expression or an interactive session,
# so walk up from every plausible starting point until tests/private-clients is found.
function Get-FixtureRoot {
    $starts = @()
    if ($PSScriptRoot) { $starts += $PSScriptRoot }
    if ($MyInvocation.MyCommand.Path) { $starts += (Split-Path $MyInvocation.MyCommand.Path -Parent) }
    if ($env:GITHUB_WORKSPACE) { $starts += $env:GITHUB_WORKSPACE }
    $starts += (Get-Location).Path
    foreach ($start in $starts) {
        $probe = $start
        while ($probe) {
            $candidate = Join-Path $probe 'tests/private-clients'
            if (Test-Path -LiteralPath $candidate -PathType Container) { return $candidate }
            $parent = Split-Path $probe -Parent
            if (-not $parent -or $parent -eq $probe) { break }
            $probe = $parent
        }
    }
    return ''
}

# The repository carries one known-good installer so the job still works when winget and the vendor CDN are
# both unreachable. tests/private-clients/sogou-ime.json records the SHA256 of that exact file.
function Get-BundledSogouInstaller {
    $candidates = @()
    if ($SogouImeInstaller) { $candidates += $SogouImeInstaller }
    $fixtureRoot = Get-FixtureRoot
    if (-not $fixtureRoot) { Write-Step 'input: fixture root not found; bundled Sogou installer unavailable' }
    if ($fixtureRoot -and (Test-Path -LiteralPath $fixtureRoot)) {
        $candidates += @(Get-ChildItem -LiteralPath $fixtureRoot -Filter 'sogou-ime-v*.exe' -File -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -ExpandProperty FullName)
    }
    return ($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1)
}

function Test-SogouInstallerFile {
    param([string] $Path)
    $result = [pscustomobject]@{ Ok = $false; Reason = ''; Sha256 = ''; Signer = '' }
    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
        $result.Signer = [string]$signature.SignerCertificate.Subject
        if ($signature.Status -ne 'Valid') { $result.Reason = "signature status $($signature.Status)"; return $result }
        if ($result.Signer -notmatch 'Sogou') { $result.Reason = "unexpected signer: $($result.Signer)"; return $result }
        $result.Sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
        $result.Ok = $true
        return $result
    } catch {
        $result.Reason = $_.Exception.Message
        return $result
    }
}

# The installer may register itself with a Chinese display name, so a DisplayName-only match would miss it
# and the job would reinstall every run. Three independent signals are checked instead: the uninstall entry
# (name, install location or uninstall command containing "sogou"), the legacy IMM keyboard-layout key, and
# the install directory.
function Get-SogouInputState {
    $state = [pscustomobject]@{ Installed = $false; InstallDir = ''; Version = ''; Source = '' }
    foreach ($root in @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            $values = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            if (-not $values) { continue }
            $haystack = "$($values.DisplayName) $($values.InstallLocation) $($values.UninstallString)"
            if ($haystack -notmatch 'sogou') { continue }
            $state.Installed = $true
            $state.Version = [string]$values.DisplayVersion
            $state.InstallDir = [string]$values.InstallLocation
            $state.Source = 'uninstall-entry'
            return $state
        }
    }
    $layouts = 'HKLM:\SYSTEM\CurrentControlSet\Control\Keyboard Layouts'
    if (Test-Path -LiteralPath $layouts) {
        foreach ($key in @(Get-ChildItem -LiteralPath $layouts -ErrorAction SilentlyContinue)) {
            $values = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            if (-not $values) { continue }
            $haystack = "$($values.'IME file') $($values.'Layout Text') $($values.'Layout Display Name')"
            if ($haystack -notmatch 'sogou') { continue }
            $state.Installed = $true
            $state.Source = 'imm-layout'
            return $state
        }
    }
    foreach ($candidate in @(
        (Join-Path ${env:ProgramFiles(x86)} 'SogouInput'),
        (Join-Path ${env:ProgramFiles} 'SogouInput'),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'SogouInput' } else { '' })
    )) {
        if (-not $candidate) { continue }
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            $state.Installed = $true
            $state.InstallDir = $candidate
            $state.Source = 'install-dir'
            break
        }
    }
    return $state
}

function Resolve-SogouInputInstaller {
    $version = ''
    $sha = ''
    if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
        try {
            $show = (& winget.exe show --id Sogou.SogouInput -e 2>$null) -join "`n"
            $match = [regex]::Match($show, 'Version:\s*([0-9][0-9.]*)')
            if ($match.Success) { $version = $match.Groups[1].Value }
        } catch { }
    }
    if (-not $version) {
        try {
            $headers = @{ 'User-Agent' = 'chaoxing-plus-ci' }
            $api = 'https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/s/Sogou/SogouInput'
            $rows = @(Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 30)
            $versions = @($rows | ForEach-Object { $_.name } | Where-Object { $_ -match '^[0-9][0-9.]*$' })
            if ($versions.Count -gt 0) { $version = $versions | Sort-Object { [version]$_ } -Descending | Select-Object -First 1 }
        } catch { Write-Step "input: sogou manifest lookup failed - $($_.Exception.Message)" }
    }
    if (-not $version) { throw 'cannot determine the newest Sogou Pinyin version' }
    $yamlUrl = "https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/s/Sogou/SogouInput/$version/Sogou.SogouInput.installer.yaml"
    try {
        $yaml = (Invoke-WebRequest -Uri $yamlUrl -UseBasicParsing -TimeoutSec 30).Content
        $shaMatch = [regex]::Match($yaml, 'InstallerSha256:\s*([0-9A-Fa-f]{64})')
        if ($shaMatch.Success) { $sha = $shaMatch.Groups[1].Value.ToUpperInvariant() }
    } catch { Write-Step "input: sogou manifest metadata unavailable for $version (continuing without SHA256)" }
    # The vendor endpoint keeps a stable shape, so only the version has to be resolved.
    $url = "https://ime.gtimg.com/pc/build/_sogou_pinyin_$($version)_0.exe"
    Write-Step "input: Sogou Pinyin version $version, sha256=$(if ($sha) { $sha } else { '<unknown>' })"
    return [pscustomobject]@{ Version = $version; Url = $url; Sha256 = $sha; Silent = '/S' }
}

function Install-SogouInputMethod {
    try {
        $script:SogouImmPreparation = Enable-SogouImmInputMethod -Quiet
        if ($script:SogouImmPreparation.Prepared) {
            Write-Step 'input: IMM already ready; no Sogou installation needed'
            return
        }
        $state = Get-SogouInputState
        if ($state.Installed) {
            Write-Step "input: Sogou Pinyin already installed (version=$($state.Version) dir=$($state.InstallDir) source=$($state.Source))"
            return
        }
        if ($DryRun) { Write-Step 'input: dry run, Sogou Pinyin not installed'; return }

        # 1) bundled installer from the repository: no network needed, hash pinned in the fixture manifest.
        $bundled = Get-BundledSogouInstaller
        if ($bundled) {
            $verified = Test-SogouInstallerFile -Path $bundled
            if (-not $verified.Ok) {
                Write-Step "input: bundled Sogou installer rejected ($($verified.Reason)): $bundled"
            } else {
                $expected = ''
                $manifestPath = Join-Path (Split-Path $bundled -Parent) 'sogou-ime.json'
                if (Test-Path -LiteralPath $manifestPath) {
                    try {
                        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
                        $expected = [string]$manifest.sha256
                    } catch { }
                }
                if ($expected -and $expected.ToUpperInvariant() -ne $verified.Sha256.ToUpperInvariant()) {
                    Write-Step "input: bundled Sogou installer hash mismatch (have $($verified.Sha256), manifest $expected)"
                } else {
                    Write-Step "input: using bundled Sogou installer $([IO.Path]::GetFileName($bundled)) ($([math]::Round((Get-Item -LiteralPath $bundled).Length / 1MB, 1)) MB, sha256 $($verified.Sha256))"
                    $runBundled = Invoke-SogouInstaller -FilePath $bundled -ArgumentList '/S' -Label 'input: bundled Sogou setup /S' -TimeoutSeconds $CapabilityTimeoutSeconds
                    if ($runBundled.ImmReady) { return }
                    $state = Get-SogouInputState
                    if ($state.Installed) {
                        Write-Step "input: Sogou Pinyin installed from the bundled installer (version=$($state.Version))"
                        foreach ($line in @(Get-ImmInputMethodProbe)) { Write-Step "input: imm after install $line" }
                        return
                    }
                    if ($runBundled.StillRunning) {
                        Write-Step 'input: bundled installer still running without IMM; skipping additional installers'
                        return
                    }
                    Write-Step "input: bundled installer did not install Sogou Pinyin (ok=$($runBundled.Ok) timedOut=$($runBundled.TimedOut)); trying winget"
                }
            }
        }

        # 2) winget: version-agnostic, but needs the package source to be reachable.
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            $install = Invoke-SogouInstaller -FilePath $winget.Source -ArgumentList @('install', '--id', 'Sogou.SogouInput', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity') -Label 'input: winget install Sogou.SogouInput' -TimeoutSeconds $CapabilityTimeoutSeconds
            if ($install.ImmReady) { return }
            $state = Get-SogouInputState
            if ($state.Installed) {
                Write-Step "input: Sogou Pinyin installed through winget (version=$($state.Version))"
                return
            }
            if ($install.StillRunning) {
                Write-Step 'input: winget still running without IMM; skipping the manifest installer'
                return
            }
            Write-Step "input: winget path did not install Sogou Pinyin (ok=$($install.Ok) timedOut=$($install.TimedOut)); trying the manifest installer"
        }

        # 3) resolve the current release and download it directly from the vendor endpoint.
        $installer = Resolve-SogouInputInstaller
        $target = Join-Path $env:TEMP ("sogou_pinyin_" + $installer.Version + '.exe')
        Write-Step "input: downloading $($installer.Url)"
        try {
            Invoke-WebRequest -Uri $installer.Url -OutFile $target -UseBasicParsing -TimeoutSec $CapabilityTimeoutSeconds
        } catch {
            Write-Step "input: download failed - $($_.Exception.Message)"
            return
        }
        if ($installer.Sha256) {
            $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
            if ($actual -ne $installer.Sha256) {
                Write-Step "input: SHA256 mismatch ($actual) - refusing to run the installer"
                return
            }
            Write-Step 'input: SHA256 verified'
        }
        $signature = Get-AuthenticodeSignature -LiteralPath $target -ErrorAction SilentlyContinue
        if ($signature) { Write-Step "input: signature status=$($signature.Status) signer=$($signature.SignerCertificate.Subject)" }

        $run = Invoke-SogouInstaller -FilePath $target -ArgumentList $installer.Silent -Label 'input: sogou setup /S' -TimeoutSeconds $CapabilityTimeoutSeconds
        if ($run.ImmReady) { return }
        $state = Get-SogouInputState
        if ($state.Installed) {
            Write-Step "input: Sogou Pinyin installed from the manifest installer (version=$($state.Version))"
        } else {
            Write-Step "input: Sogou Pinyin still not installed (installerOk=$($run.Ok) timedOut=$($run.TimedOut))"
        }
    } catch {
        Write-Step "input: Sogou Pinyin installation failed - $($_.Exception.Message)"
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
if (-not $SkipInputMethod) {
  Add-ChineseInputMethod
  if (-not $SkipSogouInputMethod) {
    Install-SogouInputMethod
    if (-not $script:SogouImmPreparation.Prepared) { $script:SogouImmPreparation = Enable-SogouImmInputMethod }
  }
}
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
  Write-Step "input: sogou installed=$($summary.Sogou.Installed) version='$($summary.Sogou.Version)' source='$($summary.Sogou.Source)'"
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
      sogou = $summary.Sogou
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
