# capture guard 事件落盘与 W 汇总（t139）
#
# 背景：Watch-ClientCaptureGuard 在独立 runspace 里跑，它的 Write-Host 不会进主进程
# stdout，所以 CI 日志里看不到任何 capture guard 事件。而抓屏窗口期 W
# （WDA_MONITOR 1 -> 0 -> 1 的时长）正是判断「200ms 轮询够不够」的唯一输入。
#
# 本文件提供：
#   Write-CaptureGuardEvent   —— 每次跳变追加一行 JSONL
#   Get-CaptureGuardEventsPath—— 决定落盘位置（RUNNER_TEMP 优先）
#   Measure-CaptureGuardWindow—— 读 JSONL 算 W 分布（纯函数，可单测）
#
# 三个设计约束（都不是随意选的）：
#
# 1) 用 mono_ms 而不是时间字符串算差。
#    Get-Date 与 Node Date.now 之间实测可差 69ms，跨时钟算差不可靠。
#    [Environment]::TickCount64 是单调时钟，不受 NTP 校时/夏令时影响。
#
# 2) 汇总只读文件，不用函数返回值。
#    scripts/inject-evidence-assertion.test.mjs:162 与
#    scripts/inject-report-verdict.test.mjs:77 都把 Watch-ClientCaptureGuard
#    stub 成 `return $null`；靠返回值传数据会让这两个测试环境拿不到数据。
#    读文件的另一个好处：文件不存在 → available:false，天然区分
#    「没触发」与「触发但没记录」。
#
# 3) 事件按 hwnd 分别配对。
#    一个客户端可能有多个顶层窗口，跨窗口把 on/off 配成一对会算出无意义的 W。

# Get-CaptureGuardEventsPath 返回事件文件路径。
# 优先 RUNNER_TEMP（CI 会被 artifact 收集），退化到 TEMP。
function Get-CaptureGuardEventsPath {
    param(
        [Parameter(Mandatory = $true)] [int] $ProcessId,
        [string] $Directory
    )
    $base = $Directory
    if (-not $base) {
        $base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
    }
    if (-not $base) { return $null }
    return (Join-Path $base ("capture-guard-events-$ProcessId.jsonl"))
}

# Write-CaptureGuardEvent 追加一行事件。
# 绝不抛异常：抓屏守护是 best effort，落盘失败不能影响隐藏面板本身。
function Write-CaptureGuardEvent {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [ValidateSet('on', 'off', 'error', 'stop')] [string] $Event,
        [string] $Hwnd = '',
        [string] $Message = ''
    )
    if (-not $Path) { return }
    try {
        $record = [ordered]@{
            event   = $Event
            hwnd    = $Hwnd
            # at 只供人读，不参与计算（跨时钟算差不可靠）
            at      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            # mono_ms 是唯一参与 W 计算的时间量：单调、不受校时影响
            mono_ms = [Environment]::TickCount64
        }
        if ($Message) { $record.message = $Message }
        $line = ($record | ConvertTo-Json -Compress -Depth 4)
        $dir = Split-Path -Parent $Path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue | Out-Null
        }
        # UTF-8 无 BOM + 追加：JSONL 每行独立，BOM 只会在首行污染 JSON.parse
        Add-Content -LiteralPath $Path -Value $line -Encoding utf8 -ErrorAction Stop
    } catch {
        # 落盘失败只能忽略：上层是 runspace，Write-Warning 也进不了主日志
    }
}

# Read-CaptureGuardEvents 读 JSONL，返回对象数组。
# 坏行（半截写入、非 JSON）跳过并在 Skipped 里计数，不抛异常。
function Read-CaptureGuardEvents {
    param([string] $Path)
    $result = [pscustomobject]@{
        Available = $false
        Lines     = @()
        Skipped   = 0
        Path      = $Path
    }
    if (-not $Path) { return $result }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $result }
    $result.Available = $true
    $parsed = New-Object System.Collections.Generic.List[object]
    foreach ($line in (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue)) {
        if (-not $line -or -not $line.Trim()) { continue }
        try {
            $parsed.Add(($line | ConvertFrom-Json -ErrorAction Stop))
        } catch {
            $result.Skipped++
        }
    }
    $result.Lines = $parsed.ToArray()
    return $result
}

# Get-CaptureGuardWindowStats 把事件序列算成 W 分布。
#
# 配对规则：同一 hwnd 上，'on' 之后的第一条 'off' 与之配对；中间若又出现 'on'（状态机
# 不该产生，但坏数据可能），以前一条 on 作废、用新的。
# 未配对的 on（奇数个事件）不计入 W，但单独用 unpairedOn 报告，不静默丢弃。
#
# 分位数用 nearest-rank（P95 取第 ceil(0.95*n) 个），与 scripts/wda-poll-window.test.mjs
# 里的理论曲线口径一致。
function Get-CaptureGuardWindowStats {
    param([object[]] $Events)

    $durations = New-Object System.Collections.Generic.List[double]
    $openAt = @{}
    $unpairedOn = 0
    $errorCount = 0

    foreach ($ev in @($Events)) {
        if (-not $ev) { continue }
        $kind = [string]$ev.event
        if ($kind -eq 'error') { $errorCount++; continue }
        if ($kind -ne 'on' -and $kind -ne 'off') { continue }

        $hwnd = [string]$ev.hwnd
        $mono = 0.0
        try { $mono = [double]$ev.mono_ms } catch { continue }
        if ($mono -le 0) { continue }

        if ($kind -eq 'on') {
            if ($openAt.ContainsKey($hwnd)) { $unpairedOn++ }   # 前一条 on 再没等到 off
            $openAt[$hwnd] = $mono
        } else {
            if (-not $openAt.ContainsKey($hwnd)) { continue }  # 没有对应 on 的孤立 off
            $start = [double]$openAt[$hwnd]
            $openAt.Remove($hwnd)
            $w = $mono - $start
            # 负值只可能来自坏数据（mono_ms 非单调）。丢弃并计数，绝不让它进分布。
            if ($w -ge 0) { $durations.Add($w) }
        }
    }
    $unpairedOn += $openAt.Count

    $sorted = @($durations | Sort-Object)
    $count = $sorted.Count

    $stats = [ordered]@{
        events        = $count          # 配成对的窗口数 = 可用的 W 样本数
        rawEventCount = @($Events | Where-Object { $_ -and ([string]$_.event -eq 'on' -or [string]$_.event -eq 'off') }).Count
        unpairedOn    = $unpairedOn
        errorCount    = $errorCount
        wMinMs        = $null
        wMaxMs        = $null
        wP50Ms        = $null
        wP95Ms        = $null
    }
    if ($count -gt 0) {
        $stats.wMinMs = [double]$sorted[0]
        $stats.wMaxMs = [double]$sorted[$count - 1]
        $stats.wP50Ms = [double](Get-PercentileValue -SortedValues $sorted -Percentile 0.50)
        $stats.wP95Ms = [double](Get-PercentileValue -SortedValues $sorted -Percentile 0.95)
    }
    return [pscustomobject]$stats
}

# Get-PercentileValue nearest-rank 分位数。
# 索引 = ceil(p * n) - 1，夹到 [0, n-1]。
# 用 -1 是因为 rank 从 1 数起而数组从 0 数起；漏掉这个 -1 是 P95 最常见的一处偏移。
function Get-PercentileValue {
    param(
        [Parameter(Mandatory = $true)] [object[]] $SortedValues,
        [Parameter(Mandatory = $true)] [double] $Percentile
    )
    $n = $SortedValues.Count
    if ($n -eq 0) { return $null }
    $rank = [int][Math]::Ceiling($Percentile * $n)
    if ($rank -lt 1) { $rank = 1 }
    if ($rank -gt $n) { $rank = $n }
    return $SortedValues[$rank - 1]
}
