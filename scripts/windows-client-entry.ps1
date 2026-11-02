# Drive the native exam check window so the real client creates its CEF page.
#
# The client stops at a native Duilib window (class ExamCheckUI, "check passed / enter exam") and only
# builds its CEF page after that button is pressed. Nothing on the client command line selects the exam
# (the binary carries no custom switches), so the injection job has to click the button itself.
#
# Duilib lays the controls out for a 1200x700 design surface and clips (it does not rescale) when the
# window is smaller, so the button keeps its design position (412,78) scaled by the window DPI. Deriving
# the point from the current client size instead lands ~50px away on smaller windows and the click is lost.
#
# Window messages from a lower integrity process are rejected by UIPI, therefore this helper must run
# in the same integrity context as the client (the GitHub Windows runner and the elevated host both do).
# Dot-sourced by scripts/windows-real-client-injection.ps1; keep this file pure ASCII.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class CXClientEntry {
    public delegate bool EnumProc(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr handle, StringBuilder name, int cap);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr handle);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr handle, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr dc, int index);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessageW(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate uint DpiForWindow(IntPtr handle);

    public static IntPtr Find(uint processId, string className) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((handle, parameter) => {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner != processId) return true;
            StringBuilder name = new StringBuilder(128);
            GetClassNameW(handle, name, 128);
            if (name.ToString() == className) { found = handle; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string WindowClasses(uint processId) {
        StringBuilder names = new StringBuilder();
        EnumWindows((handle, parameter) => {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner != processId) return true;
            StringBuilder name = new StringBuilder(128);
            GetClassNameW(handle, name, 128);
            string value = name.ToString();
            if (value.Length == 0) return true;
            if (names.Length > 0) names.Append('|');
            names.Append(value);
            return true;
        }, IntPtr.Zero);
        return names.ToString();
    }

    public static int WindowDpi(IntPtr handle) {
        IntPtr user32 = LoadLibraryW("user32.dll");
        if (user32 != IntPtr.Zero) {
            IntPtr address = GetProcAddress(user32, "GetDpiForWindow");
            if (address != IntPtr.Zero) {
                DpiForWindow probe = (DpiForWindow)Marshal.GetDelegateForFunctionPointer(address, typeof(DpiForWindow));
                uint value = probe(handle);
                if (value >= 96) return (int)value;
            }
        }
        IntPtr dc = GetDC(handle);
        if (dc != IntPtr.Zero) {
            int value = GetDeviceCaps(dc, 88);
            ReleaseDC(handle, dc);
            if (value >= 96) return value;
        }
        return 96;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibraryW(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
}
'@

# Design position of the "enter exam" button on the 1200x700 layout, in device pixels for the given DPI.
function Get-ClientEntryPoint {
    param(
        [int] $Dpi = 96
    )
    if ($Dpi -lt 96 -or $Dpi -gt 480) { throw "Unsupported window DPI: $Dpi" }
    return [pscustomobject]@{
        X = [int][Math]::Round(412 * $Dpi / 96)
        Y = [int][Math]::Round(78 * $Dpi / 96)
        Dpi = $Dpi
    }
}

# The window is created before Duilib lays it out; a click at that moment lands on a 137x36 client area.
function Wait-ClientLayoutReady {
    param(
        [Parameter(Mandatory = $true)] [IntPtr] $Window,
        [int] $TimeoutSeconds = 60,
        [int] $PollMilliseconds = 400
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $previous = ''
    while ((Get-Date) -lt $deadline) {
        $rect = New-Object CXClientEntry+RECT
        if ([CXClientEntry]::GetClientRect($Window, [ref]$rect)) {
            $size = "$($rect.Right)x$($rect.Bottom)"
            if ($rect.Right -ge 600 -and $rect.Bottom -ge 400 -and $size -eq $previous) {
                return [pscustomobject]@{ Ready = $true; Width = $rect.Right; Height = $rect.Bottom }
            }
            $previous = $size
        }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
    return [pscustomobject]@{ Ready = $false; Width = 0; Height = 0 }
}

function Get-ClientPageTargetCount {
    param(
        [Parameter(Mandatory = $true)] [int] $ProcessId
    )
    try {
        $connection = Get-NetTCPConnection -State Listen -OwningProcess $ProcessId -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $connection) { return -1 }
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($connection.LocalPort)/json/list" -UseBasicParsing -TimeoutSec 3
        return @($response.Content | ConvertFrom-Json).Count
    } catch {
        return -1
    }
}

# The check page needs a few seconds of environment probing before the button reacts, and a click that
# arrives while it is still probing is simply dropped. Click, then prove that a CEF page appeared, and
# retry until the page shows up or the window disappears.
function Wait-ClientExamEntry {
    param(
        [Parameter(Mandatory = $true)] [string] $ClientPath,
        [int] $TimeoutSeconds = 120,
        [int] $PollMilliseconds = 500,
        [int] $Attempts = 6,
        [int] $SettleSeconds = 10
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $attempt = 0
    $window = [IntPtr]::Zero
    $clientProcess = $null
    $point = $null
    $dpi = 0
    $size = ''
    while ($attempt -lt $Attempts -and (Get-Date) -lt $deadline) {
        if (-not $clientProcess) {
            foreach ($candidate in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ClientPath)) -ErrorAction SilentlyContinue)) {
                $path = $null
                try { $path = $candidate.Path } catch { }
                if (-not $path -or -not $path.Equals($ClientPath, [StringComparison]::OrdinalIgnoreCase)) { continue }
                $handle = [CXClientEntry]::Find([uint32]$candidate.Id, 'ExamCheckUI')
                if ($handle -ne [IntPtr]::Zero) { $window = $handle; $clientProcess = $candidate; break }
            }
            if (-not $clientProcess) { Start-Sleep -Milliseconds $PollMilliseconds; continue }
        }

        $window = [CXClientEntry]::Find([uint32]$clientProcess.Id, 'ExamCheckUI')
        if ($window -eq [IntPtr]::Zero) {
            $pages = Get-ClientPageTargetCount -ProcessId $clientProcess.Id
            return [pscustomobject]@{
                Clicked = $true; Reason = 'entry-window-closed'; Window = 0; ProcessId = $clientProcess.Id
                Point = $point; Dpi = $dpi; Attempts = $attempt; ClientSize = $size; PageTargets = $pages
            }
        }

        $layout = Wait-ClientLayoutReady -Window $window -TimeoutSeconds 60
        if (-not $layout.Ready) {
            Start-Sleep -Milliseconds $PollMilliseconds
            continue
        }
        $size = "$($layout.Width)x$($layout.Height)"
        $dpi = [CXClientEntry]::WindowDpi($window)
        $entry = Get-ClientEntryPoint -Dpi $dpi
        $point = "$($entry.X),$($entry.Y)"
        $lParam = [IntPtr](($entry.Y -shl 16) -bor ($entry.X -band 0xFFFF))
        [void][CXClientEntry]::PostMessageW($window, 0x0200, [IntPtr]::Zero, $lParam)
        Start-Sleep -Milliseconds 120
        [void][CXClientEntry]::PostMessageW($window, 0x0201, [IntPtr]1, $lParam)
        Start-Sleep -Milliseconds 90
        [void][CXClientEntry]::PostMessageW($window, 0x0202, [IntPtr]::Zero, $lParam)
        $attempt++

        Start-Sleep -Seconds $SettleSeconds
        $pages = Get-ClientPageTargetCount -ProcessId $clientProcess.Id
        if ($pages -gt 0) {
            return [pscustomobject]@{
                Clicked = $true; Reason = 'entry-page-detected'; Window = [int64]$window; ProcessId = $clientProcess.Id
                Point = $point; Dpi = $dpi; Attempts = $attempt; ClientSize = $size; PageTargets = $pages
            }
        }
    }

    if (-not $clientProcess) {
        return [pscustomobject]@{ Clicked = $false; Reason = 'entry-window-not-found'; Window = 0; ProcessId = 0; Point = $null; Dpi = 0; Attempts = 0; ClientSize = ''; PageTargets = 0 }
    }
    return [pscustomobject]@{
        Clicked = $true; Reason = 'entry-page-missing'; Window = [int64]$window; ProcessId = $clientProcess.Id
        Point = $point; Dpi = $dpi; Attempts = $attempt; ClientSize = $size
        PageTargets = (Get-ClientPageTargetCount -ProcessId $clientProcess.Id)
        Windows = [CXClientEntry]::WindowClasses([uint32]$clientProcess.Id)
    }
}