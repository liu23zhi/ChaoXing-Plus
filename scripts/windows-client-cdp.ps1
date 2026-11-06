# Page-internal screenshots through the client's own DevTools endpoint.
#
# The desktop frames from windows-client-diagnostics.ps1 stay as they are: they prove what the desktop
# really shows. They are also the only way to see that the exam window is black - CXExam.exe marks it
# with SetWindowDisplayAffinity(hwnd, WDA_MONITOR) while initialising the exam window (IG5: 0x44d510
# enables, 0x44d550 clears), so every GDI capture of that window reads back as pure black pixels.
#
# Page.captureScreenshot is served by the page renderer inside the client, so it never goes through the
# DWM capture path that the display affinity blocks. It is therefore the only readable evidence after
# the exam window appears - and it also contains the injected panel, which the black window frame cannot
# show. Both artifacts are kept side by side.
#
# Dot-sourced by scripts/windows-real-client-injection.ps1; keep this file pure ASCII.

# The first page target whose URL is a real web page; CEF keeps about:blank/devtools targets around.
function Get-CdpPageTarget {
    param(
        [Parameter(Mandatory = $true)] [int] $Port,
        [int] $TimeoutSeconds = 3
    )
    if ($Port -le 0 -or $Port -gt 65535) { return $null }
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/list" -UseBasicParsing -TimeoutSec $TimeoutSeconds
        $targets = @($response.Content | ConvertFrom-Json)
    } catch {
        return $null
    }
    $pages = @($targets | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl })
    if ($pages.Count -eq 0) { return $null }
    $web = @($pages | Where-Object { $_.url -match '^https?://' })
    if ($web.Count -gt 0) { return $web[0] }
    return $pages[0]
}

# Runs one CDP command over a short-lived WebSocket and returns the raw reply JSON, or $null.
function Invoke-CdpCommand {
    param(
        [Parameter(Mandatory = $true)] [string] $WebSocketUrl,
        [Parameter(Mandatory = $true)] [string] $ParamsJson,
        [int] $CommandId = 1,
        [int] $TimeoutSeconds = 15
    )
    $socket = $null
    $cancel = $null
    try {
        $socket = New-Object System.Net.WebSockets.ClientWebSocket
        $cancel = New-Object System.Threading.CancellationTokenSource
        $cancel.CancelAfter([Math]::Max(1000, $TimeoutSeconds * 1000))
        # [void] matters: the task results would otherwise be emitted into the pipeline and turn the
        # function's return value into an array that no caller can read.
        [void]$socket.ConnectAsync([Uri]$WebSocketUrl, $cancel.Token).GetAwaiter().GetResult()
        $payload = [Text.Encoding]::UTF8.GetBytes($ParamsJson)
        [void]$socket.SendAsync([System.ArraySegment[byte]]::new($payload), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel.Token).GetAwaiter().GetResult()
        $buffer = New-Object byte[] 65536
        $segment = [System.ArraySegment[byte]]::new($buffer)
        $text = New-Object System.Text.StringBuilder
        $deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSeconds))
        while ((Get-Date) -lt $deadline) {
            $result = $socket.ReceiveAsync($segment, $cancel.Token).GetAwaiter().GetResult()
            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
            if ($result.Count -gt 0) { [void]$text.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)) }
            if (-not $result.EndOfMessage) { continue }
            $message = $text.ToString()
            [void]$text.Clear()
            $parsed = $null
            try { $parsed = $message | ConvertFrom-Json } catch { continue }
            # The page may push Runtime/Network events before the reply; only the matching id counts.
            if ($parsed -and $parsed.id -eq $CommandId) { return $parsed }
        }
        return $null
    } catch {
        return $null
    } finally {
        if ($socket) { try { $socket.Dispose() } catch { } }
        if ($cancel) { try { $cancel.Dispose() } catch { } }
    }
}

# Tell the page to hide its panel while the client photographs the screen.
#
# CXExam.exe disables its own WDA_MONITOR right before it grabs the desktop with GetDC(NULL) and
# uploads the BMP (server command "GetScreenImage"), so an open panel would end up in that evidence.
# The bootstrap side implements the actual hiding (window.__CX_WIN_APPLY_CAPTURE_GUARD__); this only
# flips the flag over the existing DevTools endpoint. Best effort: a page without the hook is a no-op.
function Set-CdpCaptureGuard {
    param(
        [Parameter(Mandatory = $true)] [int] $Port,
        [Parameter(Mandatory = $true)] [bool] $Hidden,
        [int] $TimeoutSeconds = 5
    )
    $target = Get-CdpPageTarget -Port $Port -TimeoutSeconds ([Math]::Max(1, [Math]::Min(5, $TimeoutSeconds)))
    if (-not $target) { return $false }
    $flag = if ($Hidden) { 'true' } else { 'false' }
    # Quoting is delegated to ConvertTo-Json so the expression survives any page quoting rules.
    $expression = "window.__CX_WIN_CAPTURE_GUARD__=$flag;if(typeof window.__CX_WIN_APPLY_CAPTURE_GUARD__==='function'){window.__CX_WIN_APPLY_CAPTURE_GUARD__();}"
    $request = '{"id":1,"method":"Runtime.evaluate","params":{"expression":' + (ConvertTo-Json $expression -Compress) + ',"returnByValue":true}}'
    $reply = Invoke-CdpCommand -WebSocketUrl ([string]$target.webSocketDebuggerUrl) -ParamsJson $request -CommandId 1 -TimeoutSeconds $TimeoutSeconds
    if (-not $reply -or -not $reply.result) { return $false }
    return $true
}

# Capture the page into Path. Returns $null when no page target or no pixels are available, so callers
# treat it as best-effort exactly like the desktop screenshots.
function Save-CdpPageScreenshot {
    param(
        [Parameter(Mandatory = $true)] [int] $Port,
        [Parameter(Mandatory = $true)] [string] $Path,
        [int] $TimeoutSeconds = 15
    )
    if (-not $Path) { return $null }
    $target = Get-CdpPageTarget -Port $Port -TimeoutSeconds ([Math]::Max(1, [Math]::Min(5, $TimeoutSeconds)))
    if (-not $target) { return $null }
    $request = '{"id":1,"method":"Page.captureScreenshot","params":{"format":"png","fromSurface":true,"captureBeyondViewport":false}}'
    $reply = Invoke-CdpCommand -WebSocketUrl ([string]$target.webSocketDebuggerUrl) -ParamsJson $request -CommandId 1 -TimeoutSeconds $TimeoutSeconds
    if (-not $reply -or -not $reply.result -or -not $reply.result.data) { return $null }
    try {
        $bytes = [Convert]::FromBase64String([string]$reply.result.data)
    } catch {
        return $null
    }
    # Reject anything that is not a PNG: a captured frame that cannot be opened is worse than no frame.
    if ($bytes.Length -lt 24) { return $null }
    if ($bytes[0] -ne 0x89 -or $bytes[1] -ne 0x50 -or $bytes[2] -ne 0x4E -or $bytes[3] -ne 0x47) { return $null }
    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory -PathType Container)) {
        try { New-Item -ItemType Directory -Path $directory -Force | Out-Null } catch { return $null }
    }
    try { [IO.File]::WriteAllBytes($Path, $bytes) } catch { return $null }
    $width = ([int]$bytes[16] -shl 24) -bor ([int]$bytes[17] -shl 16) -bor ([int]$bytes[18] -shl 8) -bor [int]$bytes[19]
    $height = ([int]$bytes[20] -shl 24) -bor ([int]$bytes[21] -shl 16) -bor ([int]$bytes[22] -shl 8) -bor [int]$bytes[23]
    return [pscustomobject]@{
        Path = $Path
        Bytes = $bytes.Length
        Width = $width
        Height = $height
        Url = [string]$target.url
        TargetId = [string]$target.id
    }
}
