<#
.SYNOPSIS
    一键跑「真实客户端注入回归」：把已安装目录打包装箱、编码数据库、调用 windows-real-client-injection.ps1、收集产物。

.DESCRIPTION
    为什么需要这个包装脚本（2026-11-13 实测背景）：

    windows-real-client-injection.ps1 的 -ClientInstaller 参数要求**一个可解压的文件**
    （脚本内部第 238 行 `-PathType Leaf` 校验，第 247 行 `7z x` 解压），
    而我们手上的三个真实样本是**已安装目录**，不是安装包。
    直接传目录会在参数校验阶段就失败。

    另外它把产物写到 $env:RUNNER_TEMP（CI 专用变量），本地跑时该变量不存在，
    产物会全部丢失。本脚本负责设置它并归集到 -OutDir。

    ⚠️ 管理员权限是硬前置
    ----------------------
    三个样本的 manifest 全部声明 requireAdministrator：

        4.3.0.4        requireAdministrator=True
        4.1.4.25512    requireAdministrator=True
        4.1.4.25389    requireAdministrator=True

    非管理员会话运行会在 native host 启动后卡在 UAC：
        [elevation] Client requires administrator rights; requesting Windows UAC for the host
        [stop] elevation-requested
        [real-client] exam entry window was not found within 90s
        [real-client] FAILED stage=wait-native-host message=Native host timed out

    根因不是「没有桌面」——实测 Session Name=Console、explorer.exe 在跑、UserInteractive=True。
    而是 consent.exe（UAC 弹窗）在等人工点击，无人值守会话点不了 ⇒ 90 秒超时。
    所以本脚本在**做任何耗时操作之前**先检查权限并直接失败。

    有 UAC 权限的环境怎么跑
    ----------------------
    任选其一：
      1. 以管理员身份启动 PowerShell（推荐）
            右键 PowerShell → 「以管理员身份运行」，再执行本脚本。
        或从非管理员会话自提权：
            Start-Process pwsh -Verb RunAs -ArgumentList '-File','<本脚本>','-SampleRoot','<目录>'
      2. CI runner —— GitHub Actions 的 windows-latest 自带管理员权限，不需要任何额外配置。
      3. 把 ConsentPromptBehaviorAdmin 设为 0（**不推荐**：这等于关闭 UAC 提示，
         任何程序都能静默提权，是真实的安全降级。仅限一次性隔离测试机）。

.PARAMETER SampleRoot
    已安装客户端目录（含 CXExam.exe 与 libcef.dll）。可以是单个目录，也可以是
    「包含多个客户端目录的父目录」——后者会自动展开为批量模式。

.PARAMETER InjectMode
    cdp-port 或 dll-proxy。省略时按目录名/文件特征自动推断：
    含 .themida 段或存在 winmm.dll ⇒ dll-proxy，否则 cdp-port。

.PARAMETER DatabasePath
    测试用 UserExamInfo.db。省略时使用 学习通客户端\db\UserExamInfo.db（若存在）。

.PARAMETER NativeHost
    chaoxing_plus.exe 的路径。省略时依次探测：
      <repo>\windows\native-build\bin\chaoxing_plus.exe
      <repo>\windows\native-build\bin\single-file\chaoxing_plus.exe
    该目录被 .gitignore 排除（.gitignore:7 `windows/native-build/`），
    所以在 worktree 里跑时必须显式指向主检出，或先构建。

.PARAMETER OutDir
    产物输出目录。默认 <repo>\artifacts\real-client-regression\<时间戳>。

.PARAMETER TimeoutSec
    单个样本的墙钟上限（默认 300）。注意 windows-real-client-injection.ps1 内部
    自己有 90s 的 wait-native-host 超时，本参数是外层兜底。

.PARAMETER PackMode
    如何把已安装目录变成 -ClientInstaller 需要的那个文件：
      zip（默认）—— 7z a -tzip 打包，行为与 CI 一致（CI 也是解压 zip）
      dir2zip     —— 同 zip，别名保留以便阅读
      copy        —— 直接拷到临时目录再打 zip（更慢，但绕开长路径/符号链接问题）

.EXAMPLE
    # 管理员 PowerShell 里跑单个样本
    .\scripts\run-real-client-regression.ps1 `
        -SampleRoot 'C:\Users\Zelly\Desktop\河南应用技术职业学院 考试客户端_V4.1.4.25512(2023.06.09)'

.EXAMPLE
    # 批量跑三个样本（父目录下所有子目录）
    .\scripts\run-real-client-regression.ps1 `
        -SampleRoot 'C:\Users\Zelly\Desktop' `
        -OutDir 'C:\temp\regression-out'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $SampleRoot,
    [ValidateSet('cdp-port', 'dll-proxy')] [string] $InjectMode = '',
    [string] $DatabasePath = '',
    [string] $NativeHost = '',
    [string] $OutDir = '',
    [int] $TimeoutSec = 300,
    [ValidateSet('zip', 'dir2zip', 'copy')] [string] $PackMode = 'zip',
    # 仅用于本地诊断：透传给下游脚本，让「环境受阻」的用例退出码为 0 而不是失败。
    # CI 绝不打开它（那会让「注入没成功」变成假绿）。
    [switch] $AllowEnvironmentBlocked
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# ① 管理员前置检查 —— 必须放在最前面，且先于任何耗时操作
# ---------------------------------------------------------------------------
# 为什么这条是本次任务的核心价值：
#   实测时不知道这个限制，跑了多轮、每轮白等 90 秒，日志里只看到
#   "Native host timed out"，看起来像注入逻辑坏了，实际是 UAC 无人点击。
#   提前失败能把诊断时间从「90s × N 轮」压到 0。
function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw ("本脚本必须以管理员身份运行（三个样本均 requireAdministrator）。" +
            "当前会话非管理员（$($identity.Name)），会卡在 UAC 弹窗直到超时。" +
            "请以管理员身份启动 PowerShell，或从 CI（windows-latest 自带管理员）运行。")
    }
}
Assert-Administrator

# ---------------------------------------------------------------------------
# ② 路径解析
# ---------------------------------------------------------------------------
$scriptDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptDir
$downstream = Join-Path $scriptDir 'windows-real-client-injection.ps1'
if (-not (Test-Path -LiteralPath $downstream -PathType Leaf)) {
    throw "找不到注入脚本：$downstream"
}

function Resolve-SevenZip {
    foreach ($candidate in @(
            (Join-Path ${env:ProgramFiles} '7-Zip\7z.exe'),
            (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe'),
            '7z.exe'
        )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    $cmd = Get-Command '7z.exe' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw "找不到 7z.exe（需要 7-Zip 来打包样本目录）。"
}
$sevenZip = Resolve-SevenZip

function Resolve-NativeHost {
    param([string] $explicit)
    if ($explicit) {
        if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) { throw "NativeHost 不存在：$explicit" }
        return (Resolve-Path -LiteralPath $explicit).Path
    }
    # native-build 被 .gitignore 排除，worktree 里通常没有；退回到主检出。
    $candidates = @(
        (Join-Path $repoRoot 'windows\native-build\bin\chaoxing_plus.exe'),
        (Join-Path $repoRoot 'windows\native-build\bin\single-file\chaoxing_plus.exe'),
        (Join-Path $repoRoot 'windows\native-build\bin\multi-file\package-to-single\chaoxing_plus.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    throw ("找不到 NativeHost（chaoxing_plus.exe）。请先构建：" +
        "`windows\native-build`，或用 -NativeHost 显式指定。")
}

function Resolve-Database {
    param([string] $explicit)
    if ($explicit) {
        if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) { throw "DatabasePath 不存在：$explicit" }
        return (Resolve-Path -LiteralPath $explicit).Path
    }
    foreach ($candidate in @(
            'C:\Users\Zelly\Desktop\学习通客户端\db\UserExamInfo.db',
            (Join-Path $repoRoot 'tests\fixtures\real-client\UserExamInfo.db')
        )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    throw "找不到测试数据库（UserExamInfo.db）。请用 -DatabasePath 指定。"
}

$nativeHostPath = Resolve-NativeHost -explicit $NativeHost
$databasePath = Resolve-Database -explicit $DatabasePath

if (-not $OutDir) {
    $OutDir = Join-Path $repoRoot ('artifacts\real-client-regression\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
if (-not (Test-Path -LiteralPath $OutDir -PathType Container)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

# ---------------------------------------------------------------------------
# ③ 展开样本列表
# ---------------------------------------------------------------------------
function Test-IsClientDirectory {
    param([string] $path)
    return (Test-Path -LiteralPath (Join-Path $path 'CXExam.exe') -PathType Leaf)
}

$samples = @()
if (Test-IsClientDirectory -path $SampleRoot) {
    $samples = @((Resolve-Path -LiteralPath $SampleRoot).Path)
} else {
    # 父目录模式：扫描直接子目录，只收含 CXExam.exe 的
    $samples = @(Get-ChildItem -LiteralPath $SampleRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-IsClientDirectory -path $_.FullName } |
        ForEach-Object { $_.FullName })
}
if ($samples.Count -eq 0) {
    throw "在 $SampleRoot 下没有找到含 CXExam.exe 的客户端目录（也不要直接传 CXExam.exe 所在的上级路径之外的位置）。"
}
Write-Host "[runner] 发现 $($samples.Count) 个客户端样本："
foreach ($s in $samples) { Write-Host "  - $s" }

# ---------------------------------------------------------------------------
# ④ 注入方式推断
# ---------------------------------------------------------------------------
# 依据（t129 IG5 实测）：
#   4.3.0.4 是 Themida 加壳，宿主 EXE 的 remote-debugging-port 字符串被加密（0 命中），
#   外部命令行传不进去 ⇒ 只能靠 winmm.dll 在 DllMain 里改写 PEB 命令行（dll-proxy）。
#   4.1.4 两代未加壳，remote-debugging-port 可从外部传入 ⇒ cdp-port。
function Resolve-InjectMode {
    param([string] $clientDir)
    $winmm = Join-Path $clientDir 'winmm.dll'
    if (Test-Path -LiteralPath $winmm -PathType Leaf) { return 'dll-proxy' }
    $cef = Join-Path $clientDir 'libcef.dll'
    if (Test-Path -LiteralPath $cef -PathType Leaf) {
        # 粗判：Themida 特征段名出现在 PE 段表里
        $bytes = [IO.File]::ReadAllBytes((Join-Path $clientDir 'CXExam.exe'))
        $needle = [Text.Encoding]::ASCII.GetBytes('.themida')
        for ($i = 0; $i -le $bytes.Length - $needle.Length; $i++) {
            if ($bytes[$i] -eq $needle[0]) {
                $hit = $true
                for ($j = 1; $j -lt $needle.Length; $j++) {
                    if ($bytes[$i + $j] -ne $needle[$j]) { $hit = $false; break }
                }
                if ($hit) { return 'dll-proxy' }
            }
        }
    }
    return 'cdp-port'
}

# ---------------------------------------------------------------------------
# ⑤ 把已安装目录变成 ClientInstaller 需要的那个文件
# ---------------------------------------------------------------------------
# 为什么用 zip 而不是直接拷目录：
#   下游脚本第 238 行强制 `-PathType Leaf`，目录根本进不去。
#   zip 也是 CI 的既有形态（CI 传的就是 zip），保持一致能减少「本地能跑 CI 跑不了」的分歧。
function New-ClientArchive {
    param([string] $clientDir, [string] $workRoot, [string] $tag)
    $leaf = Split-Path -Leaf $clientDir
    $safeTag = ($tag -replace '[^\w\-]', '_')
    $archive = Join-Path $workRoot ("client-$safeTag.zip")

    if ($PackMode -eq 'copy') {
        # 先拷到临时目录再打包：绕开源目录里的长路径/符号链接，代价是多一次 IO。
        $staging = Join-Path $workRoot ("staging-$safeTag")
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
        New-Item -ItemType Directory -Path $staging -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $clientDir '*') -Destination $staging -Recurse -Force
        & $sevenZip a -tzip $archive (Join-Path $staging '*') -y -bd | Out-Null
    } else {
        # 直接在源目录里打包（默认）。7z 会递归整个目录，且不会修改源目录内容。
        & $sevenZip a -tzip $archive (Join-Path $clientDir '*') -y -bd | Out-Null
    }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        throw "打包失败（7z exit $LASTEXITCODE）：$clientDir"
    }
    Write-Host ("[runner] packed {0} -> {1} ({2:N0} B)" -f $leaf, (Split-Path -Leaf $archive), (Get-Item -LiteralPath $archive).Length)
    return $archive
}

# ---------------------------------------------------------------------------
# ⑥ 逐个样本执行
# ---------------------------------------------------------------------------
$databaseBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($databasePath))
Write-Host ("[runner] database={0} ({1:N0} B -> {2:N0} base64 chars)" -f $databasePath, (Get-Item -LiteralPath $databasePath).Length, $databaseBase64.Length)
Write-Host "[runner] nativeHost=$nativeHostPath"
Write-Host "[runner] outDir=$OutDir"

$summary = @()
$index = 0
foreach ($sample in $samples) {
    $index++
    $leaf = Split-Path -Leaf $sample
    $mode = if ($InjectMode) { $InjectMode } else { Resolve-InjectMode -clientDir $sample }
    # CaseName 只用作产物文件名前缀。规则（v2，2026-11-13 第二轮修正）：
    #   - 纯中文目录名折叠后可能变成空串或只剩版本号，多个同版本样本会撞名；
    #   - 因此 slug 之后再拼 6 位路径哈希做区分，保证唯一且可读。
    #   演变历史：v1 用 `[^\w\-]` 把中文全变 `_`（产物形如 case1-_____V4_1_4_25512___），
    #             已改成折叠成 '-'；v2 补哈希避免同名。
    $slug = ($leaf -replace '[^A-Za-z0-9.\-]+', '-') -replace '-{2,}', '-'
    $slug = $slug.Trim('-', '.')
    if (-not $slug) { $slug = 'sample' }
    $fp = (Get-FileHash -LiteralPath (Join-Path $sample 'CXExam.exe') -Algorithm SHA256).Hash.Substring(0, 6).ToLower()
    $caseName = "case$index-$slug-$fp"

    Write-Host ''
    Write-Host "===== [$index/$($samples.Count)] $leaf (mode=$mode) ====="

    $workRoot = Join-Path $env:TEMP ('cx-regression-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workRoot -Force | Out-Null

    $row = [ordered]@{
        Case          = $caseName
        Sample        = $leaf
        InjectMode    = $mode
        ExitCode      = $null
        Success       = $false
        EndpointReady = $null
        BundleInPage  = $null
        Verified      = $null
        Reason        = ''
        ReportPath    = ''
    }

    try {
        $archive = New-ClientArchive -clientDir $sample -workRoot $workRoot -tag $caseName

        # 下游脚本把产物写到 $env:RUNNER_TEMP；本地没有这个变量，必须自己设。
        # 让每个 case 有独立子目录，避免三个样本的产物互相覆盖。
        $artifactDir = Join-Path $OutDir $caseName
        New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
        $previousRunnerTemp = $env:RUNNER_TEMP
        $env:RUNNER_TEMP = $artifactDir

        try {
            $argumentList = @{
                ClientInstaller = $archive
                InjectMode      = $mode
                DatabaseBase64  = $databaseBase64
                NativeHost      = $nativeHostPath
                CaseName        = $caseName
            }
            if ($AllowEnvironmentBlocked) { $argumentList['AllowEnvironmentBlocked'] = $true }

            $job = Start-Job -ScriptBlock {
                param($script, $args_)
                & $script @args_ *>&1
            } -ArgumentList $downstream, $argumentList 2>$null

            if (-not $job) {
                # Start-Job 不可用时退化为直接调用（保留原始退出码语义）。
                $global:LASTEXITCODE = 0
                & $downstream @argumentList
                $row.ExitCode = $LASTEXITCODE
            } else {
                if (Wait-Job -Job $job -Timeout $TimeoutSec) {
                    Receive-Job -Job $job | ForEach-Object { Write-Host $_ }
                    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
                    $row.ExitCode = 0
                } else {
                    Stop-Job -Job $job -ErrorAction SilentlyContinue
                    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
                    Write-Host "[runner] 超时（${TimeoutSec}s），已终止 $leaf"
                    $row.ExitCode = 124
                }
            }
        } finally {
            $env:RUNNER_TEMP = $previousRunnerTemp
        }

        # 读 report.json 提取三个关键字段
        $candidate = Get-ChildItem -LiteralPath $artifactDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '报告|report' } | Select-Object -First 1
        if ($candidate) {
            $row.ReportPath = $candidate.FullName
            try {
                $report = Get-Content -LiteralPath $candidate.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
                $row.Success = [bool]$report.success
                foreach ($key in @('endpointReady', 'bundleInPage', 'verified', 'reason')) {
                    if ($report.injectEvidence -and $report.injectEvidence.PSObject.Properties[$key]) {
                        $row[($key.Substring(0,1).ToUpper() + $key.Substring(1))] = $report.injectEvidence.$key
                    }
                }
                if (-not $row.Reason -and $report.PSObject.Properties['stopReason']) { $row.Reason = [string]$report.stopReason }
            } catch {
                Write-Host "[runner] 报告解析失败：$($_.Exception.Message)"
            }
        } else {
            Write-Host "[runner] 未找到 report.json（产物目录：$artifactDir）"
        }
    } catch {
        Write-Host "[runner] $leaf 失败：$($_.Exception.Message)"
        if (-not $row.Reason) { $row.Reason = $_.Exception.Message }
    } finally {
        Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    $summary += [pscustomobject]$row
}

# ---------------------------------------------------------------------------
# ⑦ 汇总表
# ---------------------------------------------------------------------------
$summaryPath = Join-Path $OutDir 'summary.json'
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

Write-Host ''
Write-Host '===== 汇总 ====='
$summary | Format-Table Case, Sample, InjectMode, Success, EndpointReady, BundleInPage, Verified, ExitCode -AutoSize | Out-String -Width 220 | Write-Host
Write-Host "[runner] summary -> $summaryPath"

# 收尾判定必须在**三个**分支上都正确，否则就是假绿：
#   1. summary 为空  —— 一个样本都没跑（前面 throw 已挡住大部分，但异常路径可能留下空表）。
#                      此时「全部 0 个通过」是错误的成功信号，必须 exit 1。
#   2. 有失败样本     —— exit 1。
#   3. 全部成功且非空 —— 才 exit 0。
# v1 曾漏掉第 1 支：`0/0 通过 → 全部 0 个样本通过 → exit 0`，正是「假绿」形态。
if ($summary.Count -eq 0) {
    Write-Host "[runner] 没有任何样本被执行（summary 为空）—— 不得当作通过"
    exit 1
}
$failed = @($summary | Where-Object { -not $_.Success })
if ($failed.Count -gt 0) {
    Write-Host "[runner] $($failed.Count)/$($summary.Count) 个样本未通过"
    exit 1
}
Write-Host "[runner] 全部 $($summary.Count) 个样本通过"
exit 0
