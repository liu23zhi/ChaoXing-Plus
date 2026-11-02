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

function Wait-ClientExamEntry {
    param(
        [Parameter(Mandatory = $true)] [string] $ClientPath,
        [int] $TimeoutSeconds = 120,
        [int] $PollMilliseconds = 500
    )
    $window = [IntPtr]::Zero
    $clientProcess = $null
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        foreach ($candidate in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ClientPath)) -ErrorAction SilentlyContinue)) {
            $path = $null
            try { $path = $candidate.Path } catch { }
            if (-not $path -or -not $path.Equals($ClientPath, [StringComparison]::OrdinalIgnoreCase)) { continue }
            $handle = [CXClientEntry]::Find([uint32]$candidate.Id, 'ExamCheckUI')
            if ($handle -ne [IntPtr]::Zero) { $window = $handle; $clientProcess = $candidate; break }
        }
        if ($window -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
    if ($window -eq [IntPtr]::Zero) {
        return [pscustomobject]@{ Clicked = $false; Reason = 'entry-window-not-found'; Window = 0; ProcessId = 0; Point = $null; Dpi = 0 }
    }

    $layout = Wait-ClientLayoutReady -Window $window -TimeoutSeconds 60
    if (-not $layout.Ready) {
        return [pscustomobject]@{
            Clicked = $false; Reason = "entry-layout-not-ready:$($layout.Width)x$($layout.Height)"
            Window = [int64]$window; ProcessId = $clientProcess.Id; Point = $null; Dpi = 0
        }
    }

    $dpi = [CXClientEntry]::WindowDpi($window)
    $point = Get-ClientEntryPoint -Dpi $dpi
    $lParam = [IntPtr](($point.Y -shl 16) -bor ($point.X -band 0xFFFF))
    [void][CXClientEntry]::PostMessageW($window, 0x0200, [IntPtr]::Zero, $lParam)
    Start-Sleep -Milliseconds 120
    $pressed = [CXClientEntry]::PostMessageW($window, 0x0201, [IntPtr]1, $lParam)
    $pressedError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Start-Sleep -Milliseconds 90
    [void][CXClientEntry]::PostMessageW($window, 0x0202, [IntPtr]::Zero, $lParam)

    return [pscustomobject]@{
        Clicked = $pressed
        Reason = if ($pressed) { 'entry-click-sent' } else { "post-message-failed:$pressedError" }
        Window = [int64]$window
        ProcessId = $clientProcess.Id
        Point = "$($point.X),$($point.Y)"
        Dpi = $dpi
        ClientSize = "$($layout.Width)x$($layout.Height)"
    }
}
