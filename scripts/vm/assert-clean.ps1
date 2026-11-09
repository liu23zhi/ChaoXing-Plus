<#
断言虚拟机处于干净状态。

自毁兜底会在两个地方留下痕迹：
  1. HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce 里 cxplus-purge-* 登记项
  2. %TEMP% 下 cx-purge-* 续删工作目录

baseline 阶段要求两者都不存在（快照必须干净）；
teardown 阶段要求自毁已把它们清掉。

只读检查，不删除任何东西：清理是自毁逻辑自己的职责，脚本替它擦屁股会让
「续删没生效」这种真实缺陷被掩盖。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('baseline', 'teardown')]
    [string]$Stage
)

$ErrorActionPreference = 'Stop'

$runOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$valuePrefix = 'cxplus-purge-'
$tempPrefix = 'cx-purge-'
# GitHub runner 提供 RUNNER_TEMP；本地自检时它不存在，回退到 %TEMP%，
# 否则 Join-Path 收到空值会直接抛参数绑定错误。
$tempRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:TEMP } else { $env:RUNNER_TEMP }

function Get-PurgeRunOnceValues {
    if (-not (Test-Path -LiteralPath $runOnceKey)) { return @() }
    $item = Get-ItemProperty -LiteralPath $runOnceKey -ErrorAction SilentlyContinue
    if ($null -eq $item) { return @() }
    return @(
        $item.PSObject.Properties
        | Where-Object { $_.Name -like "$valuePrefix*" }
        | ForEach-Object { $_.Name }
    )
}

function Get-PurgeTempDirs {
    # 排除测试自己用的 cx-purge-tests-*，避免把并行用例的工作目录当成残留。
    return @(
        Get-ChildItem -LiteralPath $env:TEMP -Directory -ErrorAction SilentlyContinue
        | Where-Object { $_.Name -like "$tempPrefix*" -and $_.Name -notlike 'cx-purge-tests-*' }
        | ForEach-Object { $_.FullName }
    )
}

$runOnce = Get-PurgeRunOnceValues
$tempDirs = Get-PurgeTempDirs

Write-Output "阶段: $Stage"
Write-Output "RunOnce 残留: $($runOnce.Count)"
$runOnce | ForEach-Object { Write-Output "  $_" }
Write-Output "临时目录残留: $($tempDirs.Count)"
$tempDirs | ForEach-Object { Write-Output "  $_" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$report = Join-Path $tempRoot "cx-vm-assert-$Stage-$stamp.txt"
@(
    "stage=$Stage"
    "runOnceCount=$($runOnce.Count)"
    "runOnceValues=$($runOnce -join ';')"
    "tempDirCount=$($tempDirs.Count)"
    "tempDirs=$($tempDirs -join ';')"
) | Out-File -FilePath $report -Encoding utf8
Write-Output "报告: $report"

if ($runOnce.Count -gt 0 -or $tempDirs.Count -gt 0) {
    # baseline 有残留 = 快照脏，本轮结论不可信；teardown 有残留 = 自毁没清干净。
    # 两种都必须失败，不能只告警。
    Write-Error "$Stage 阶段发现自毁残留，见上方清单与 $report"
    exit 1
}

Write-Output "$Stage 阶段干净。"
exit 0
