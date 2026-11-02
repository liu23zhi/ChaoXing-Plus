# Capture the desktop environment and screenshots so a failing real-client run can be diagnosed.
#
# The injection job only sees log lines. When the client never leaves its check window we need to know
# whether there is an interactive desktop at all (session, window station, monitors, DPI, remote session)
# and what the screen actually shows. Everything here is best effort: on a headless or service session
# the screenshot simply fails and the environment report records why.
#
# Dot-sourced by scripts/windows-real-client-injection.ps1; keep this file pure ASCII.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class CXClientDiag {
    [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder info, int length, out int needed);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr handle);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr handle, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr dc, int index);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    static string ObjectName(IntPtr handle) {
        if (handle == IntPtr.Zero) return "";
        StringBuilder name = new StringBuilder(256);
        int needed;
        return GetUserObjectInformationW(handle, 2, name, 256, out needed) ? name.ToString() : "";
    }

    public static string WindowStationName() { return ObjectName(GetProcessWindowStation()); }
    public static string DesktopName() { return ObjectName(GetThreadDesktop(GetCurrentThreadId())); }
    public static int VirtualScreenX() { return GetSystemMetrics(76); }
    public static int VirtualScreenY() { return GetSystemMetrics(77); }
    public static int VirtualScreenWidth() { return GetSystemMetrics(78); }
    public static int VirtualScreenHeight() { return GetSystemMetrics(79); }
    public static bool RemoteSession() { return GetSystemMetrics(4096) != 0; }

    public static int SystemDpi() {
        IntPtr dc = GetDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) return 0;
        int dpi = GetDeviceCaps(dc, 88);
        ReleaseDC(IntPtr.Zero, dc);
        return dpi;
    }
}
'@

function Get-DesktopEnvironment {
    $monitors = @()
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
            $monitors += [pscustomobject]@{
                DeviceName = $screen.DeviceName
                Primary = $screen.Primary
                X = $screen.Bounds.X
                Y = $screen.Bounds.Y
                Width = $screen.Bounds.Width
                Height = $screen.Bounds.Height
            }
        }
    } catch { }
    return [pscustomobject]@{
        CapturedAt = (Get-Date).ToString('o')
        SessionId = (Get-Process -Id $PID).SessionId
        UserInteractive = [Environment]::UserInteractive
        WindowStation = [CXClientDiag]::WindowStationName()
        Desktop = [CXClientDiag]::DesktopName()
        RemoteSession = [CXClientDiag]::RemoteSession()
        SystemDpi = [CXClientDiag]::SystemDpi()
        VirtualScreen = [pscustomobject]@{
            X = [CXClientDiag]::VirtualScreenX()
            Y = [CXClientDiag]::VirtualScreenY()
            Width = [CXClientDiag]::VirtualScreenWidth()
            Height = [CXClientDiag]::VirtualScreenHeight()
        }
        Monitors = $monitors
        Elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        OsVersion = [Environment]::OSVersion.VersionString
    }
}

# Capture one window instead of the whole desktop: the check page text stays readable even on a small
# runner desktop, and the resulting artifact is focused on what the client actually shows.
function Save-WindowScreenshot {
    param(
        [Parameter(Mandatory = $true)] [IntPtr] $Window,
        [Parameter(Mandatory = $true)] [string] $Path
    )
    try {
        $rect = New-Object CXClientDiag+RECT
        if (-not [CXClientDiag]::GetWindowRect($Window, [ref]$rect)) { return $null }
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top
        if ($width -le 0 -or $height -le 0 -or $width -gt 5000 -or $height -gt 5000) { return $null }
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $bitmap = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
        return [pscustomobject]@{ Path = $Path; Width = $width; Height = $height; Bytes = (Get-Item -LiteralPath $Path).Length }
    } catch {
        return $null
    }
}

function Save-DesktopScreenshot {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [int] $ScalePercent = 100
    )
    try {
        Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction Stop
        $x = [CXClientDiag]::VirtualScreenX()
        $y = [CXClientDiag]::VirtualScreenY()
        $width = [CXClientDiag]::VirtualScreenWidth()
        $height = [CXClientDiag]::VirtualScreenHeight()
        if ($width -le 0 -or $height -le 0) { return $null }
        if ($ScalePercent -lt 10) { $ScalePercent = 10 }
        if ($ScalePercent -gt 100) { $ScalePercent = 100 }
        $full = New-Object System.Drawing.Bitmap $width, $height
        $fullGraphics = [System.Drawing.Graphics]::FromImage($full)
        $fullGraphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $width, $height))
        $targetWidth = [int][Math]::Max(1, [Math]::Round($width * $ScalePercent / 100))
        $targetHeight = [int][Math]::Max(1, [Math]::Round($height * $ScalePercent / 100))
        $scaled = New-Object System.Drawing.Bitmap $targetWidth, $targetHeight
        $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaled)
        $scaledGraphics.DrawImage($full, 0, 0, $targetWidth, $targetHeight)
        $scaled.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        $scaledGraphics.Dispose(); $scaled.Dispose()
        $fullGraphics.Dispose(); $full.Dispose()
        return [pscustomobject]@{ Path = $Path; Width = $targetWidth; Height = $targetHeight; Bytes = (Get-Item -LiteralPath $Path).Length }
    } catch {
        return $null
    }
}
