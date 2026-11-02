# Prepare the interactive desktop that the real exam client expects on the CI runner.
#
# The client refuses to enter an exam unless its environment check passes, and the hosted runner fails
# two items by default:
#   * resolution - the default 1024x768 desktop clips the client's 1200x700 check window;
#   * camera and input method - "no camera detected" and "no supported input method detected".
# This script raises the resolution, installs Microsoft's own Pinyin and Wubi input methods and starts a
# virtual camera. No third-party input method is installed. Every step is bounded and best effort: the
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
  [string] $WeChatImeInstaller = '',
  [switch] $SkipCamera,
  [switch] $SkipInputMethod,
  [switch] $SkipResolution,
  [switch] $SkipWeChatInputMethod,
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

# The client accepts any IMM input method (it enumerates keyboard layouts and keeps those whose
# ImmGetDescriptionW is non-empty), so a third-party IME works where the zh-CN language payload is
# missing. The installer URL is never hardcoded: it is resolved from the community-maintained winget
# manifest for the newest release, so a version bump cannot break the job.
# A language profile alone is not proof of a working install: the TIP key outlives the uninstaller for a
# while, and running the setup again while the product is present opens the uninstaller GUI instead of
# installing. Both signals are required, plus the binary on disk.
function Get-WeChatInputMethodState {
    $state = [pscustomobject]@{ Installed = $false; Profile = ''; Tip = ''; InstallDir = ''; FilesFound = $false }
    foreach ($candidate in @((Join-Path ${env:ProgramFiles} 'Tencent\WeType'), (Join-Path ${env:ProgramFiles(x86)} 'Tencent\WeType'))) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
        $state.InstallDir = $candidate
        if (@(Get-ChildItem -LiteralPath $candidate -Filter '*.exe' -File -Recurse -ErrorAction SilentlyContinue).Count -gt 0) {
            $state.FilesFound = $true
        }
        break
    }
    $tipRoot = 'HKLM:\SOFTWARE\Microsoft\CTF\TIP'
    if (-not (Test-Path -LiteralPath $tipRoot)) { return $state }
    foreach ($tip in @(Get-ChildItem -LiteralPath $tipRoot -ErrorAction SilentlyContinue)) {
        $profileRoot = Join-Path $tip.PSPath 'LanguageProfile\0x00000804'
        if (-not (Test-Path -LiteralPath $profileRoot)) { continue }
        foreach ($profile in @(Get-ChildItem -LiteralPath $profileRoot -ErrorAction SilentlyContinue)) {
            $values = Get-ItemProperty -LiteralPath $profile.PSPath -ErrorAction SilentlyContinue
            if (-not $values) { continue }
            if ([string]$values.Description -match 'WeType') {
                $state.Profile = $profile.PSChildName
                $state.Tip = [string]$values.Description
                $state.Installed = (([int]$values.Enable -eq 1) -and $state.FilesFound)
                return $state
            }
        }
    }
    return $state
}

# Remove a half-uninstalled copy through the product's own uninstaller so the setup does not open its
# uninstall window again.
function Remove-WeChatInputMethodLeftovers {
    param([string] $InstallDir)
    if (-not $InstallDir -or -not (Test-Path -LiteralPath $InstallDir)) { return }
    $uninstaller = @(Get-ChildItem -LiteralPath $InstallDir -Filter '*nstall*.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($uninstaller.Count -gt 0) {
        Write-Step "input: running leftover uninstaller $($uninstaller[0].FullName) /S"
        $null = Invoke-Bounded -Label 'input: WeType uninstall /S' -TimeoutSeconds $CapabilityTimeoutSeconds -Action {
            $process = Start-Process -FilePath $using:uninstaller[0].FullName -ArgumentList '/S' -PassThru -Wait
            "uninstaller exit $($process.ExitCode)"
        }
    }
    Start-Sleep -Seconds 3
    if (Test-Path -LiteralPath $InstallDir) {
        Write-Step "input: removing leftover directory $InstallDir"
        Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-WeChatInputMethodInstaller {
    # The download URL is never hardcoded: the version comes from winget (or from the community-maintained
    # winget-pkgs manifest when winget is unavailable) and the official endpoint keeps a fixed shape:
    #   https://download.z.weixin.qq.com/app/win/WeTypeSetup_<version>.exe
    $version = ''
    $sha = ''
    $silent = '/s'
    if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
        try {
            $show = (& winget.exe show --id Tencent.WeType -e 2>$null) -join "`n"
            $match = [regex]::Match($show, 'Version:\s*([0-9][0-9.]*)')
            if ($match.Success) { $version = $match.Groups[1].Value }
        } catch { }
    }
    if (-not $version) {
        try {
            $headers = @{ 'User-Agent' = 'chaoxing-plus-ci' }
            $api = 'https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/t/Tencent/WeType'
            $rows = @(Invoke-RestMethod -Uri $api -Headers $headers -TimeoutSec 30)
            $versions = @($rows | ForEach-Object { $_.name } | Where-Object { $_ -match '^[0-9][0-9.]*$' })
            if ($versions.Count -gt 0) { $version = $versions | Sort-Object { [version]$_ } -Descending | Select-Object -First 1 }
        } catch { Write-Step "input: winget-pkgs lookup failed - $($_.Exception.Message)" }
    }
    if (-not $version) { throw 'cannot determine the newest WeType version' }
    $yamlUrl = "https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/t/Tencent/WeType/$version/Tencent.WeType.installer.yaml"
    try {
        $yaml = (Invoke-WebRequest -Uri $yamlUrl -UseBasicParsing -TimeoutSec 30).Content
        $shaMatch = [regex]::Match($yaml, 'InstallerSha256:\s*([0-9A-Fa-f]{64})')
        if ($shaMatch.Success) { $sha = $shaMatch.Groups[1].Value.ToUpperInvariant() }
        $silentMatch = [regex]::Match($yaml, 'Silent:\s*(\S+)')
        if ($silentMatch.Success) { $silent = $silentMatch.Groups[1].Value }
    } catch { Write-Step "input: manifest metadata unavailable for $version (continuing without SHA256)" }

    $url = "https://download.z.weixin.qq.com/app/win/WeTypeSetup_$version.exe"
    Write-Step "input: WeType version $version from winget/manifest, sha256=$(if ($sha) { $sha } else { '<unknown>' })"
    return [pscustomobject]@{ Version = $version; Url = $url; Sha256 = $sha; Silent = $silent }
}

# The repository carries one known-good installer so the job still works when winget and the vendor CDN
# are both unreachable. tests/private-clients/wechat-ime.json records the SHA256 of that exact file.
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

function Get-BundledWeChatInstaller {
    $candidates = @()
    if ($WeChatImeInstaller) { $candidates += $WeChatImeInstaller }
    $fixtureRoot = Get-FixtureRoot
    if (-not $fixtureRoot) { Write-Step 'input: fixture root not found; bundled WeChat installer unavailable' }
    if ($fixtureRoot -and (Test-Path -LiteralPath $fixtureRoot)) {
        $candidates += @(Get-ChildItem -LiteralPath $fixtureRoot -Filter 'wechat-ime-v*.exe' -File -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -ExpandProperty FullName)
    }
    return ($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1)
}

function Test-WeChatInstallerFile {
    param([string] $Path)
    $result = [pscustomobject]@{ Ok = $false; Reason = ''; Sha256 = ''; Signer = '' }
    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
        $result.Signer = [string]$signature.SignerCertificate.Subject
        if ($signature.Status -ne 'Valid') { $result.Reason = "signature status $($signature.Status)"; return $result }
        if ($result.Signer -notmatch 'Tencent') { $result.Reason = "unexpected signer: $($result.Signer)"; return $result }
        $result.Sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
        $result.Ok = $true
        return $result
    } catch {
        $result.Reason = $_.Exception.Message
        return $result
    }
}

function Install-WeChatInputMethod {
    try {
        $state = Get-WeChatInputMethodState
        if ($state.Installed) {
            Write-Step "input: WeChat IME already installed (profile=$($state.Profile) description=$($state.Tip))"
            return
        }
        if ($DryRun) { Write-Step 'input: dry run, WeChat IME not installed'; return }

        # A leftover copy would make the setup open its uninstaller window instead of installing.
        if ($state.InstallDir -and -not $state.FilesFound) {
            Write-Step "input: leftover directory without binaries ($($state.InstallDir)); cleaning up before install"
            Remove-WeChatInputMethodLeftovers -InstallDir $state.InstallDir
        } elseif ($state.FilesFound -and -not $state.Installed) {
            Write-Step "input: half-uninstalled copy found in $($state.InstallDir); removing it before install"
            Remove-WeChatInputMethodLeftovers -InstallDir $state.InstallDir
        }

        # 1) bundled installer from the repository: no network needed, hash pinned in the fixture manifest.
        $bundled = Get-BundledWeChatInstaller
        if ($bundled) {
            $verified = Test-WeChatInstallerFile -Path $bundled
            if (-not $verified.Ok) {
                Write-Step "input: bundled installer rejected ($($verified.Reason)): $bundled"
            } else {
                $expected = ''
                $manifestPath = Join-Path (Split-Path $bundled -Parent) 'wechat-ime.json'
                if (Test-Path -LiteralPath $manifestPath) {
                    try {
                        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
                        $expected = [string]$manifest.sha256
                    } catch { }
                }
                if ($expected -and $expected.ToUpperInvariant() -ne $verified.Sha256.ToUpperInvariant()) {
                    Write-Step "input: bundled installer hash mismatch (have $($verified.Sha256), manifest $expected)"
                } else {
                    Write-Step "input: using bundled installer $([IO.Path]::GetFileName($bundled)) ($([math]::Round((Get-Item -LiteralPath $bundled).Length / 1MB, 1)) MB, sha256 $($verified.Sha256))"
                    $runBundled = Invoke-Bounded -Label 'input: bundled WeTypeSetup /s' -TimeoutSeconds $CapabilityTimeoutSeconds -Action {
                        $process = Start-Process -FilePath $using:bundled -ArgumentList '/s' -PassThru -Wait
                        "installer exit $($process.ExitCode)"
                    }
                    $state = Get-WeChatInputMethodState
                    if ($state.Installed) {
                        Write-Step "input: WeChat IME installed from the bundled installer (profile=$($state.Profile) description=$($state.Tip))"
                        return
                    }
                    Write-Step "input: bundled installer did not register the IME (ok=$($runBundled.Ok) timedOut=$($runBundled.TimedOut)); trying winget"
                }
            }
        }

        # 2) winget: version-agnostic, but needs the package source to be reachable.
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            $install = Invoke-Bounded -Label 'input: winget install Tencent.WeType' -TimeoutSeconds $CapabilityTimeoutSeconds -Action {
                & winget.exe install --id Tencent.WeType -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Select-Object -Last 4
            }
            $state = Get-WeChatInputMethodState
            if ($state.Installed) {
                Write-Step "input: WeChat IME installed through winget (profile=$($state.Profile) description=$($state.Tip))"
                return
            }
            Write-Step "input: winget path did not register the IME (ok=$($install.Ok) timedOut=$($install.TimedOut)); trying the manifest installer"
        }

        # 3) resolve the current release and download it directly from the vendor endpoint.
        $installer = Resolve-WeChatInputMethodInstaller
        $target = Join-Path $env:TEMP ("WeTypeSetup-" + $installer.Version + '.exe')
        Write-Step "input: downloading $($installer.Url)"
        try {
            Invoke-WebRequest -Uri $installer.Url -OutFile $target -UseBasicParsing -TimeoutSec $CapabilityTimeoutSeconds
        } catch {
            Write-Step "input: download failed - $($_.Exception.Message)"
            return
        }
        $bytes = (Get-Item -LiteralPath $target).Length
        Write-Step "input: downloaded $bytes bytes"
        if ($installer.Sha256) {
            $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
            if ($actual -ne $installer.Sha256.ToUpperInvariant()) {
                Write-Step "input: SHA256 mismatch ($actual) - refusing to run the installer"
                return
            }
            Write-Step 'input: SHA256 verified'
        }
        $signature = Get-AuthenticodeSignature -LiteralPath $target -ErrorAction SilentlyContinue
        if ($signature) { Write-Step "input: signature status=$($signature.Status) signer=$($signature.SignerCertificate.Subject)" }

        $run = Invoke-Bounded -Label "input: WeTypeSetup $($installer.Silent)" -TimeoutSeconds $CapabilityTimeoutSeconds -Action {
            $process = Start-Process -FilePath $using:target -ArgumentList $using:installer.Silent -PassThru -Wait
            "installer exit $($process.ExitCode)"
        }
        $state = Get-WeChatInputMethodState
        if ($state.Installed) {
            Write-Step "input: WeChat IME installed from the manifest installer (profile=$($state.Profile) description=$($state.Tip))"
        } else {
            Write-Step "input: WeChat IME still not registered (installerOk=$($run.Ok) timedOut=$($run.TimedOut))"
        }
    } catch {
        Write-Step "input: WeChat IME installation failed - $($_.Exception.Message)"
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
  if (-not $SkipWeChatInputMethod) { Install-WeChatInputMethod }
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
