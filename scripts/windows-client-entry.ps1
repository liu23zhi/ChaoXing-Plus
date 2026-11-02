# Drive the native exam check window so the real client creates its CEF page.
#
# The client stops at a native Duilib window (class ExamCheckUI) and only builds its CEF page after the
# "enter exam" button is pressed. Two things make a blind click unreliable:
#   * the button is hidden while the environment probe is still running (the page shows a progress ring),
#     so a click that arrives too early is dropped;
#   * Duilib lays the controls out for a 1200x700 design surface and clips instead of rescaling.
# So the helper scans the rendered window for the blue button and clicks where it actually is, waits for
# the button to appear at all, and retries until a CEF page exists. The design point stays as a fallback
# for sessions where the screen cannot be captured.
#
# Window messages from a lower integrity process are rejected by UIPI, therefore this helper must run in
# the same integrity context as the client (the GitHub Windows runner and the elevated host both do).
# Dot-sourced by scripts/windows-real-client-injection.ps1; keep this file pure ASCII.

Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue

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
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr handle, ref POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr handle);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr handle, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern int GetDeviceCaps(IntPtr dc, int index);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessageW(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
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

# Pixel scan for the solid blue button. The capture uses System.Drawing from PowerShell and only the raw
# pixels cross into C#, so this type needs no extra assembly references (Add-Type -ReferencedAssemblies
# would replace the default reference set and break the build on PowerShell 7).
Add-Type -TypeDefinition @'
using System;

public class CXExamEntryScan {
    public static bool IsButtonBlue(byte b, byte g, byte r) {
        return b > 180 && r >= 30 && r <= 130 && g >= 90 && g <= 190;
    }

    // Returns {x,y} in client coordinates, or an empty array when no blue button is visible.
    // The check page also draws a blue progress ring and blue percentage text while probing, and the
    // button itself carries white text, so a row is judged by blue coverage + span (not by one solid run)
    // and the block must be button sized and mostly blue.
    public static int[] Scan(byte[] buffer, int stride, int width, int height, int offsetX, int offsetY) {
        int bestRows = 0, bestY0 = 0, bestY1 = 0, bestX0 = 0, bestX1 = 0;
        int currentRows = 0, currentY0 = 0, currentX0 = 0, currentX1 = 0;
        int[] starts = new int[128];
        int[] ends = new int[128];
        for (int y = 0; y < height; y++) {
            int runs = 0, runStart = -1;
            for (int x = 0; x <= width; x++) {
                bool blue = false;
                if (x < width) {
                    int index = y * stride + x * 4;
                    blue = IsButtonBlue(buffer[index], buffer[index + 1], buffer[index + 2]);
                }
                if (blue && runStart < 0) runStart = x;
                if (!blue && runStart >= 0) {
                    if (runs < starts.Length) { starts[runs] = runStart; ends[runs] = x - 1; runs++; }
                    runStart = -1;
                }
            }
            // Merge runs separated by the white button label so the whole button becomes one segment.
            int segmentStart = -1, segmentEnd = -1, segmentBlue = 0, bestStart = -1, bestEnd = -1, bestBlue = 0;
            for (int i = 0; i < runs; i++) {
                if (segmentStart < 0) { segmentStart = starts[i]; segmentEnd = ends[i]; segmentBlue = ends[i] - starts[i] + 1; }
                else if (starts[i] - segmentEnd <= 12) { segmentBlue += ends[i] - starts[i] + 1; segmentEnd = ends[i]; }
                else {
                    if (bestStart < 0 || segmentEnd - segmentStart > bestEnd - bestStart) { bestStart = segmentStart; bestEnd = segmentEnd; bestBlue = segmentBlue; }
                    segmentStart = starts[i]; segmentEnd = ends[i]; segmentBlue = ends[i] - starts[i] + 1;
                }
            }
            if (segmentStart >= 0 && (bestStart < 0 || segmentEnd - segmentStart > bestEnd - bestStart)) { bestStart = segmentStart; bestEnd = segmentEnd; bestBlue = segmentBlue; }
            int span = bestStart < 0 ? 0 : bestEnd - bestStart + 1;
            bool candidate = bestStart >= 0 && span >= 40 && span <= 350 && (long)bestBlue * 100 >= (long)span * 40;
            // A rounded pill (the modal confirm button) narrows by more than 6 px on its first and last
            // rows, so continuity is judged by horizontal overlap instead of start/end alignment.
            int overlap = currentRows > 0 ? Math.Min(bestEnd, currentX1) - Math.Max(bestStart, currentX0) + 1 : 0;
            bool continues = candidate && currentRows > 0 && overlap > 0 && (long)overlap * 100 >= (long)span * 60;
            if (!continues) {
                if (currentRows > bestRows) { bestRows = currentRows; bestY0 = currentY0; bestY1 = y - 1; bestX0 = currentX0; bestX1 = currentX1; }
                currentRows = 0;
                if (candidate) { currentX0 = bestStart; currentX1 = bestEnd; currentY0 = y; currentRows = 1; }
                continue;
            }
            currentRows++;
        }
        if (currentRows > bestRows) { bestRows = currentRows; bestY0 = currentY0; bestY1 = height - 1; bestX0 = currentX0; bestX1 = currentX1; }
        if (bestRows < 15) return new int[0];
        int blockWidth = bestX1 - bestX0 + 1;
        int blockHeight = bestY1 - bestY0 + 1;
        if (blockWidth < 40 || blockWidth > 350 || blockHeight < 15 || blockHeight > 150) return new int[0];
        int sampled = 0, bluePixels = 0;
        for (int sampleY = bestY0; sampleY <= bestY1; sampleY += 2) {
            for (int sampleX = bestX0; sampleX <= bestX1; sampleX += 4) {
                int index = sampleY * stride + sampleX * 4;
                sampled++;
                if (IsButtonBlue(buffer[index], buffer[index + 1], buffer[index + 2])) bluePixels++;
            }
        }
        if (sampled == 0 || bluePixels * 100 < sampled * 50) return new int[0];
        return new int[] { (bestX0 + bestX1) / 2 - offsetX, (bestY0 + bestY1) / 2 - offsetY };
    }
}
'@

# Design position of the button on the 1200x700 layout, used only when the screen cannot be scanned.
function Get-ClientEntryPoint {
    param([int] $Dpi = 96)
    if ($Dpi -lt 96 -or $Dpi -gt 480) { throw "Unsupported window DPI: $Dpi" }
    return [pscustomobject]@{
        X = [int][Math]::Round(412 * $Dpi / 96)
        Y = [int][Math]::Round(78 * $Dpi / 96)
        Dpi = $Dpi
    }
}

# Capture the window (optionally one crop rectangle, in window coordinates) and return raw scan input.
function Get-WindowScanBuffer {
    param(
        [Parameter(Mandatory = $true)] [IntPtr] $Window,
        [int] $CropLeft = 0,
        [int] $CropTop = 0,
        [int] $CropWidth = 0,
        [int] $CropHeight = 0
    )
    $windowRect = New-Object CXClientEntry+RECT
    if (-not [CXClientEntry]::GetWindowRect($Window, [ref]$windowRect)) { return $null }
    $origin = New-Object CXClientEntry+POINT
    $origin.X = 0
    $origin.Y = 0
    if (-not [CXClientEntry]::ClientToScreen($Window, [ref]$origin)) { return $null }
    $width = $windowRect.Right - $windowRect.Left
    $height = $windowRect.Bottom - $windowRect.Top
    if ($width -le 0 -or $height -le 0 -or $width -gt 5000 -or $height -gt 5000) { return $null }
    if ($CropWidth -gt 0 -and $CropHeight -gt 0) {
        $CropLeft = [Math]::Max(0, [Math]::Min($CropLeft, $width - 1))
        $CropTop = [Math]::Max(0, [Math]::Min($CropTop, $height - 1))
        $CropWidth = [Math]::Min($CropWidth, $width - $CropLeft)
        $CropHeight = [Math]::Min($CropHeight, $height - $CropTop)
    } else {
        $CropLeft = 0
        $CropTop = 0
        $CropWidth = $width
        $CropHeight = $height
    }
    $bitmap = $null
    $graphics = $null
    $data = $null
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $bitmap = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($windowRect.Left, $windowRect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
        $rect = New-Object System.Drawing.Rectangle $CropLeft, $CropTop, $CropWidth, $CropHeight
        $data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $buffer = New-Object byte[] ($data.Stride * $CropHeight)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buffer, 0, $buffer.Length)
        return [pscustomobject]@{
            Buffer = $buffer; Stride = $data.Stride; Width = $CropWidth; Height = $CropHeight
            OffsetX = $CropLeft + ($origin.X - $windowRect.Left); OffsetY = $CropTop + ($origin.Y - $windowRect.Top)
        }
    } catch {
        return $null
    } finally {
        if ($data -and $bitmap) { $bitmap.UnlockBits($data) }
        if ($graphics) { $graphics.Dispose() }
        if ($bitmap) { $bitmap.Dispose() }
    }
}

function Find-ExamEntryButton {
    param([Parameter(Mandatory = $true)] [IntPtr] $Window)
    $scan = Get-WindowScanBuffer -Window $Window
    if (-not $scan) { return [pscustomobject]@{ State = 'unavailable' } }
    try {
        $found = [CXExamEntryScan]::Scan($scan.Buffer, $scan.Stride, $scan.Width, $scan.Height, $scan.OffsetX, $scan.OffsetY)
        if ($null -eq $found -or $found.Length -eq 0) { return [pscustomobject]@{ State = 'absent' } }
        return [pscustomobject]@{ State = 'found'; X = $found[0]; Y = $found[1] }
    } catch {
        return [pscustomobject]@{ State = 'unavailable' }
    }
}

# A failed check ("check failed") still allows entry, but the client first shows
# "some features may be affected, enter anyway?" with a blue confirm button. The dialog is drawn in the same
# window, so the button is located by scanning the dialog band and clicking it.
function Find-ClientConfirmButton {
    param([Parameter(Mandatory = $true)] [IntPtr] $Window)
    $rect = New-Object CXClientEntry+RECT
    if (-not [CXClientEntry]::GetClientRect($Window, [ref]$rect)) { return [pscustomobject]@{ State = 'unavailable' } }
    if ($rect.Right -le 0 -or $rect.Bottom -le 0) { return [pscustomobject]@{ State = 'unavailable' } }
    $cropLeft = [int]($rect.Right * 0.30)
    $cropTop = [int]($rect.Bottom * 0.30)
    $cropWidth = [int]($rect.Right * 0.40)
    $cropHeight = [int]($rect.Bottom * 0.45)
    $scan = Get-WindowScanBuffer -Window $Window -CropLeft $cropLeft -CropTop $cropTop -CropWidth $cropWidth -CropHeight $cropHeight
    if (-not $scan) { return [pscustomobject]@{ State = 'unavailable' } }
    try {
        $found = [CXExamEntryScan]::Scan($scan.Buffer, $scan.Stride, $scan.Width, $scan.Height, $scan.OffsetX, $scan.OffsetY)
        if ($null -eq $found -or $found.Length -eq 0) { return [pscustomobject]@{ State = 'absent' } }
        return [pscustomobject]@{ State = 'found'; X = $found[0]; Y = $found[1] }
    } catch {
        return [pscustomobject]@{ State = 'unavailable' }
    }
}

# Fallback click: press the confirm button on the "still enter the exam?" dialog so the client proceeds to its
# CEF page even when one check item failed.
function Confirm-ClientExamEntry {
    param(
        [Parameter(Mandatory = $true)] [IntPtr] $Window,
        [int] $TimeoutSeconds = 8,
        [int] $PollMilliseconds = 400,
        [string] $ScreenshotPrefix = ''
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $button = Find-ClientConfirmButton -Window $Window
        if ($button.State -eq 'found') {
            Save-EntryFrame -Prefix $ScreenshotPrefix -Name '3-confirm-dialog' -Window $Window
            $lParam = [IntPtr](($button.Y -shl 16) -bor ($button.X -band 0xFFFF))
            [void][CXClientEntry]::PostMessageW($Window, 0x0200, [IntPtr]::Zero, $lParam)
            Start-Sleep -Milliseconds 120
            [void][CXClientEntry]::PostMessageW($Window, 0x0201, [IntPtr]1, $lParam)
            Start-Sleep -Milliseconds 90
            [void][CXClientEntry]::PostMessageW($Window, 0x0202, [IntPtr]::Zero, $lParam)
            Start-Sleep -Seconds 2
            Save-EntryFrame -Prefix $ScreenshotPrefix -Name '4-after-confirm' -Window $Window
            return [pscustomobject]@{ Clicked = $true; X = $button.X; Y = $button.Y; Via = 'scan' }
        }
        if ($button.State -eq 'unavailable') { break }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
    # Last resort: the confirm button carries focus, so Enter accepts the dialog as well. This covers a
    # dialog drawn with a different palette that the blue scan cannot find.
    Save-EntryFrame -Prefix $ScreenshotPrefix -Name '3-confirm-keyboard' -Window $Window
    [void][CXClientEntry]::PostMessageW($Window, 0x0100, [IntPtr]0x0D, [IntPtr]0)
    Start-Sleep -Milliseconds 80
    [void][CXClientEntry]::PostMessageW($Window, 0x0101, [IntPtr]0x0D, [IntPtr]0)
    Start-Sleep -Seconds 2
    $after = Find-ClientConfirmButton -Window $Window
    if ($after.State -eq 'absent') { return [pscustomobject]@{ Clicked = $true; X = 0; Y = 0; Via = 'keyboard' } }
    return [pscustomobject]@{ Clicked = $false; X = 0; Y = 0 }
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
    param([Parameter(Mandatory = $true)] [int] $ProcessId)
    try {
        $connection = Get-NetTCPConnection -State Listen -OwningProcess $ProcessId -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $connection) { return -1 }
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($connection.LocalPort)/json/list" -UseBasicParsing -TimeoutSec 3
        return @($response.Content | ConvertFrom-Json).Count
    } catch {
        return -1
    }
}

function Save-EntryFrame {
    param([string] $Prefix, [string] $Name, [int] $ScalePercent = 100, [IntPtr] $Window = [IntPtr]::Zero)
    if (-not $Prefix) { return }
    # Prefer a window capture: readable text even on a small runner desktop.
    if ($Window -ne [IntPtr]::Zero -and (Get-Command Save-WindowScreenshot -ErrorAction SilentlyContinue)) {
        $shot = Save-WindowScreenshot -Window $Window -Path "$Prefix-$Name.png"
        if ($shot) { return }
    }
    if (Get-Command Save-DesktopScreenshot -ErrorAction SilentlyContinue) {
        [void](Save-DesktopScreenshot -Path "$Prefix-$Name.png" -ScalePercent $ScalePercent)
    }
}

# Click the button as soon as it is actually on screen, prove that a CEF page appeared, and retry until it
# does or the window disappears. Frames are captured right before the first click and right after each click.
function Wait-ClientExamEntry {
    param(
        [Parameter(Mandatory = $true)] [string] $ClientPath,
        [int] $TimeoutSeconds = 120,
        [int] $PollMilliseconds = 500,
        [int] $Attempts = 6,
        [int] $SettleSeconds = 10,
        [string] $ScreenshotPrefix = ''
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $attempt = 0
    $window = [IntPtr]::Zero
    $clientProcess = $null
    $point = $null
    $dpi = 0
    $size = ''
    $target = ''
    $preClickSaved = $false
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
                Point = $point; Dpi = $dpi; Attempts = $attempt; ClientSize = $size; PageTargets = $pages; Target = $target
            }
        }

        $layout = Wait-ClientLayoutReady -Window $window -TimeoutSeconds 60
        if (-not $layout.Ready) {
            Start-Sleep -Milliseconds $PollMilliseconds
            continue
        }
        $size = "$($layout.Width)x$($layout.Height)"
        $dpi = [CXClientEntry]::WindowDpi($window)

        $button = Find-ExamEntryButton -Window $window
        if ($button.State -eq 'absent') {
            # Still probing the environment: the button is not rendered yet, a click would be lost.
            Start-Sleep -Milliseconds 1500
            continue
        }
        if ($button.State -eq 'found') {
            $clickX = $button.X
            $clickY = $button.Y
            $target = 'button-scan'
        } else {
            $design = Get-ClientEntryPoint -Dpi $dpi
            $clickX = $design.X
            $clickY = $design.Y
            $target = 'design-point'
        }
        $point = "$clickX,$clickY"
        # Frame 1: the button is on screen and still untouched. Raise the window first so the capture is
        # not a crop of whatever happens to be on top.
        if (-not $preClickSaved) {
            [void][CXClientEntry]::SetForegroundWindow($window)
            Start-Sleep -Milliseconds 300
            Save-EntryFrame -Prefix $ScreenshotPrefix -Name '1-before-click' -Window $window
            $preClickSaved = $true
        }

        $lParam = [IntPtr](($clickY -shl 16) -bor ($clickX -band 0xFFFF))
        [void][CXClientEntry]::PostMessageW($window, 0x0200, [IntPtr]::Zero, $lParam)
        Start-Sleep -Milliseconds 120
        [void][CXClientEntry]::PostMessageW($window, 0x0201, [IntPtr]1, $lParam)
        Start-Sleep -Milliseconds 90
        [void][CXClientEntry]::PostMessageW($window, 0x0202, [IntPtr]::Zero, $lParam)
        $attempt++

        Start-Sleep -Seconds $SettleSeconds
        # Frame 2: right after the click, before the client is closed.
        if ($attempt -eq 1) {
            # Key frame: full resolution so the check result / login page is readable.
            Save-EntryFrame -Prefix $ScreenshotPrefix -Name '2-after-click' -ScalePercent 100 -Window $window
        } else {
            # Follow-up attempts are usually identical; keep them small.
            Save-EntryFrame -Prefix $ScreenshotPrefix -Name "2-after-click-$attempt" -ScalePercent 50
        }
        $pages = Get-ClientPageTargetCount -ProcessId $clientProcess.Id
        if ($pages -gt 0) {
            return [pscustomobject]@{
                Clicked = $true; Reason = 'entry-page-detected'; Window = [int64]$window; ProcessId = $clientProcess.Id
                Point = $point; Dpi = $dpi; Attempts = $attempt; ClientSize = $size; PageTargets = $pages; Target = $target
                Confirmed = $false
            }
        }

        # A failed check adds one more step: a confirm dialog. Press it and wait for the
        # page instead of clicking the entry button again (dimmed behind the dialog, the click would be lost).
        if ($attempt -ge 1) {
            $confirm = Confirm-ClientExamEntry -Window $window -TimeoutSeconds 8 -ScreenshotPrefix $ScreenshotPrefix
            if ($confirm.Clicked) {
                Write-Host "[real-client] confirm dialog accepted via=$($confirm.Via) point=$($confirm.X),$($confirm.Y)"
                $confirmDeadline = (Get-Date).AddSeconds(20)
                while ((Get-Date) -lt $confirmDeadline) {
                    $pages = Get-ClientPageTargetCount -ProcessId $clientProcess.Id
                    if ($pages -gt 0) {
                        return [pscustomobject]@{
                            Clicked = $true; Reason = 'entry-page-detected-after-confirm'; Window = [int64]$window
                            ProcessId = $clientProcess.Id; Point = "$($confirm.X),$($confirm.Y)"; Dpi = $dpi
                            Attempts = $attempt; ClientSize = $size; PageTargets = $pages; Target = 'confirm-scan'
                            Confirmed = $true
                        }
                    }
                    if ([CXClientEntry]::Find([uint32]$clientProcess.Id, 'ExamCheckUI') -eq [IntPtr]::Zero) { break }
                    Start-Sleep -Milliseconds 700
                }
            }
        }
    }

    if (-not $clientProcess) {
        return [pscustomobject]@{ Clicked = $false; Reason = 'entry-window-not-found'; Window = 0; ProcessId = 0; Point = $null; Dpi = 0; Attempts = 0; ClientSize = ''; PageTargets = 0; Target = '' }
    }
    $finalReason = if ($attempt -eq 0) { 'entry-button-never-visible' } else { 'entry-page-missing' }
    return [pscustomobject]@{
        Clicked = ($attempt -gt 0); Reason = $finalReason; Window = [int64]$window; ProcessId = $clientProcess.Id
        Point = $point; Dpi = $dpi; Attempts = $attempt; ClientSize = $size
        PageTargets = (Get-ClientPageTargetCount -ProcessId $clientProcess.Id)
        Target = $target
        Windows = [CXClientEntry]::WindowClasses([uint32]$clientProcess.Id)
    }
}
