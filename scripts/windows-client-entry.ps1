# Drive the native exam check window so the real client creates its CEF page.
#
# The client stops at a native Duilib window (class ExamCheckUI, "check passed / enter exam") and only
# builds its CEF page after that button is pressed. Nothing on the client command line selects the exam
# (the binary carries no custom switches), so the injection job has to click the button itself.
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
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessageW(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    public struct RECT { public int Left, Top, Right, Bottom; }

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
}
'@

# The button sits at 34.3% width, 11.1% height of the client area: 1200x700 -> (412,78),
# 1800x1050 at 150% DPI -> (618,117). Deriving it from the client size keeps it DPI independent.
function Get-ClientEntryPoint {
    param(
        [Parameter(Mandatory = $true)] [int] $Width,
        [Parameter(Mandatory = $true)] [int] $Height
    )
    if ($Width -le 0 -or $Height -le 0) { throw "Client area must be positive: ${Width}x${Height}" }
    return [pscustomobject]@{
        X = [int][Math]::Round($Width * 0.34333)
        Y = [int][Math]::Round($Height * 0.11143)
    }
}

function Wait-ClientExamEntry {
    param(
        [Parameter(Mandatory = $true)] [string] $ClientPath,
        [int] $TimeoutSeconds = 90,
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
        return [pscustomobject]@{ Clicked = $false; Reason = 'entry-window-not-found'; Window = 0; ProcessId = 0; Point = $null }
    }

    $rect = New-Object CXClientEntry+RECT
    [void][CXClientEntry]::GetClientRect($window, [ref]$rect)
    $point = Get-ClientEntryPoint -Width $rect.Right -Height $rect.Bottom
    $lParam = [IntPtr](($point.Y -shl 16) -bor ($point.X -band 0xFFFF))
    [void][CXClientEntry]::PostMessageW($window, 0x0200, [IntPtr]::Zero, $lParam)
    Start-Sleep -Milliseconds 120
    $pressed = [CXClientEntry]::PostMessageW($window, 0x0201, [IntPtr]1, $lParam)
    $pressedError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Start-Sleep -Milliseconds 90
    [void][CXClientEntry]::PostMessageW($window, 0x0202, [IntPtr]::Zero, $lParam)

    $result = [pscustomobject]@{
        Clicked = $pressed
        Reason = if ($pressed) { 'entry-click-sent' } else { "post-message-failed:$pressedError" }
        Window = [int64]$window
        ProcessId = $clientProcess.Id
        Point = "$($point.X),$($point.Y)"
    }
    return $result
}
