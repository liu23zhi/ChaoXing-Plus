# Prepare the interactive desktop that the real exam client expects on the CI runner.
#
# The client refuses to enter an exam unless its environment check passes, and the hosted runner fails
# two items by default:
#   * resolution - the default 1024x768 desktop clips the client's 1200x700 check window;
#   * camera and input method - "no camera detected" and "no supported input method detected".
# This script raises the resolution, installs the Chinese input method and starts a virtual camera.
# Every step is best effort and logged; the injection step still reports the real outcome through its
# screenshots and report, so a failed preparation is visible instead of silent.
#
# Keep this file pure ASCII.

[CmdletBinding()]
param(
  [int] $MinWidth = 1600,
  [int] $MinHeight = 900,
  [switch] $SkipCamera,
  [switch] $SkipInputMethod,
  [switch] $SkipResolution
)

$ErrorActionPreference = 'Continue'

function Write-Step([string] $message) {
  Write-Host "[desktop-prep] $message"
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
    $current = $modes | Group-Object { "$($_[0])x$($_[1])" } | Select-Object -First 1
    Write-Step "resolution: ${($wanted[0])}x$($wanted[1]) selected from $($modes.Count) modes"
    $result = [CXDisplay]::Apply($wanted[0], $wanted[1])
    Write-Step "resolution: ChangeDisplaySettings returned $result (0 = applied)"
    if ($result -ne 0) {
      Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
      Write-Step "resolution: active screen $([System.Windows.Forms.Screen]::PrimaryScreen.Bounds)"
    }
  } catch {
    Write-Step "resolution: failed - $($_.Exception.Message)"
  }
}

function Add-ChineseInputMethod {
  try {
    $installed = @()
    if (Get-Command Get-WinUserLanguageList -ErrorAction SilentlyContinue) {
      $installed = @(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag })
    }
    Write-Step "input: languages before = $($installed -join ',')"
    if ($installed -notcontains 'zh-Hans-CN') {
      if (Get-Command Install-Language -ErrorAction SilentlyContinue) {
        Write-Step 'input: installing language pack zh-CN via Install-Language'
        Install-Language -Language zh-CN -ErrorAction Continue | Out-Null
      } else {
        $capability = Get-WindowsCapability -Online -Name 'Language.Basic~~~zh-CN~0.0.1.0' -ErrorAction SilentlyContinue
        if ($capability -and $capability.State -ne 'Installed') {
          Write-Step 'input: adding capability Language.Basic~~~zh-CN'
          Add-WindowsCapability -Online -Name 'Language.Basic~~~zh-CN~0.0.1.0' -ErrorAction Continue | Out-Null
        }
      }
    }
    if (Get-Command Set-WinUserLanguageList -ErrorAction SilentlyContinue) {
      $list = New-WinUserLanguageList -Language 'zh-Hans-CN'
      Set-WinUserLanguageList -LanguageList $list -Force -ErrorAction Continue
    }
    $after = @()
    if (Get-Command Get-WinUserLanguageList -ErrorAction SilentlyContinue) {
      $after = @(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag })
    }
    Write-Step "input: languages after = $($after -join ',')"
  } catch {
    Write-Step "input: failed - $($_.Exception.Message)"
  }
}

function Add-VirtualCamera {
  try {
    Add-Type -AssemblyName System.Management -ErrorAction Stop
    $existing = @(Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction SilentlyContinue |
      Where-Object { $_.PNPClass -eq 'Camera' -or $_.PNPClass -eq 'Image' -or $_.Service -eq 'usbvideo' })
    if ($existing.Count -gt 0) {
      Write-Step "camera: already present - $(($existing | ForEach-Object { $_.Name }) -join ', ')"
      return
    }
    $choco = Get-Command choco.exe -ErrorAction SilentlyContinue
    if ($choco) {
      Write-Step 'camera: installing OBS Studio (virtual camera driver) with chocolatey'
      & $choco.Source install obs-studio --no-progress -y 2>&1 | ForEach-Object { Write-Step "camera: $_" }
    }
    $obs = @(
      (Join-Path ${env:ProgramFiles} 'obs-studio\bin\64bit\obs64.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'obs-studio\bin\64bit\obs64.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $obs) {
      Write-Step 'camera: OBS executable not found; virtual camera unavailable'
      return
    }
    Write-Step "camera: starting virtual camera via $obs"
    Start-Process -FilePath $obs -ArgumentList '--startvirtualcam', '--minimize-to-tray' -WorkingDirectory (Split-Path $obs -Parent) -WindowStyle Hidden
    Start-Sleep -Seconds 15
    $after = @(Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction SilentlyContinue |
      Where-Object { $_.PNPClass -eq 'Camera' -or $_.PNPClass -eq 'Image' -or $_.Service -eq 'usbvideo' })
    Write-Step "camera: devices after start = $(($after | ForEach-Object { $_.Name }) -join ', ')"
  } catch {
    Write-Step "camera: failed - $($_.Exception.Message)"
  }
}

if (-not $SkipResolution) { Set-DesktopResolution }
if (-not $SkipInputMethod) { Add-ChineseInputMethod }
if (-not $SkipCamera) { Add-VirtualCamera }

try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen
  if ($screen) { Write-Step "desktop: $($screen.Bounds.Width)x$($screen.Bounds.Height) primary=$($screen.Primary)" }
} catch { }
if (Get-Command Get-WinUserLanguageList -ErrorAction SilentlyContinue) {
  Write-Step "input: final languages = $((Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag }) -join ',')"
}
