<#
在虚拟机内驱动自毁兜底的两个阶段。

Stage shutdown：验证关机流程内的同步自毁
  - 建一个待删目录与文件
  - 让 purge 模块登记它们
  - 触发关机（真实 shutdown）
  - 因为进程会被关机杀掉，本阶段只负责「登记 + 发起关机」，断言在开机后的 Stage resume

Stage resume：验证开机续删与强制关机保障
  - 断言 shutdown 阶段登记的文件已被删除
  - 断言 RunOnce 登记已自行撤销
  - 单独验证 MOVEFILE_DELAY_UNTIL_REBOOT 项在重启后消失

注意：本脚本只由 ci-vm.yml 在一次性虚拟机上调用。不要在开发机上跑 shutdown。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('shutdown', 'resume')]
    [string]$Stage,

    # 跳过真实关机，只做登记与断言。用于在没有 VM 的环境里做语法与逻辑自检。
    [switch]$NoShutdown
)

$ErrorActionPreference = 'Stop'

$purgeExe = $env:CX_NATIVE_PURGE_EXE
$hostExe = $env:CX_NATIVE_HOST_EXE
$runOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$valuePrefix = 'cxplus-purge-'
$workRoot = Join-Path $env:RUNNER_TEMP 'cx-purge-vm-work'

function Write-StageReport {
    param([string]$Name, [string[]]$Lines)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $path = Join-Path $env:RUNNER_TEMP "cx-purge-$Name-$stamp.log"
    $Lines | Out-File -FilePath $path -Encoding utf8
    Write-Output "报告: $path"
    return $path
}

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

switch ($Stage) {
    'shutdown' {
        if (-not (Test-Path -LiteralPath $purgeExe)) {
            throw "缺少 purge 测试产物: $purgeExe（先跑 windows/native-source/build-windows.ps1 -Target tests）"
        }
        New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
        $target = Join-Path $workRoot 'shutdown-target.txt'
        Set-Content -LiteralPath $target -Value 'shutdown-destruct-target' -Encoding utf8

        # purge-tests 自带「登记 + 关机」用例入口；用环境变量把目标路径传进去，
        # 避免在 CI 里重新实现一遍登记逻辑。
        $env:CX_PURGE_TEST_TARGET = $target
        $env:CX_PURGE_TEST_STAGE = 'shutdown'
        & $purgeExe
        $exitCode = $LASTEXITCODE
        Write-StageReport -Name 'shutdown' -Lines @(
            "stage=shutdown"
            "purgeExe=$purgeExe"
            "target=$target"
            "exitCode=$exitCode"
            "runOnce=$(Get-PurgeRunOnceValues -join ';')"
        ) | Out-Null

        if ($exitCode -ne 0) { throw "purge 关机阶段退出码 $exitCode" }
        if (-not (Test-Path -LiteralPath $target)) { throw "关机阶段未建立待删目标: $target" }

        $registered = Get-PurgeRunOnceValues
        if ($registered.Count -eq 0) { throw '关机阶段没有登记 RunOnce 续删项' }
        Write-Output "已登记续删项: $($registered -join ', ')"

        if ($NoShutdown) {
            Write-Output '已跳过真实关机（-NoShutdown）。'
            exit 0
        }

        # 真实关机。VM 重启后由 Stage resume 断言结果。
        # /f 强制关闭应用，/t 0 立即执行：CI 里没有用户交互的机会。
        Write-Output '发起关机…'
        & shutdown.exe /s /f /t 0
        # 关机流程通常在本行返回前就切断；走到这里说明关机被拒绝。
        throw '关机请求未被接受，环境不支持关机自毁验证'
    }

    'resume' {
        $problems = [System.Collections.Generic.List[string]]::new()

        if (Test-Path -LiteralPath $workRoot) {
            $leftover = @(Get-ChildItem -LiteralPath $workRoot -File -ErrorAction SilentlyContinue)
            if ($leftover.Count -gt 0) {
                $problems.Add("待删文件仍存在: $($leftover.Name -join ', ')")
            }
        }

        $registered = Get-PurgeRunOnceValues
        if ($registered.Count -gt 0) {
            $problems.Add("RunOnce 登记未撤销: $($registered -join ', ')")
        }

        # 强制关机保障：MOVEFILE_DELAY_UNTIL_REBOOT 的项由系统在启动时删除，
        # 这里只能确认「重启后不再有该登记」——即 PendingFileRenameOperations 无本产品项。
        $pendingKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager'
        $pending = @()
        if (Test-Path -LiteralPath $pendingKey) {
            $item = Get-ItemProperty -LiteralPath $pendingKey -ErrorAction SilentlyContinue
            if ($null -ne $item -and $null -ne $item.PendingFileRenameOperations) {
                $pending = @($item.PendingFileRenameOperations | Where-Object { $_ -like '*cx-purge*' })
            }
        }
        if ($pending.Count -gt 0) {
            $problems.Add("重启后仍有延迟删除登记: $($pending -join ', ')")
        }

        Write-StageReport -Name 'resume' -Lines @(
            "stage=resume"
            "problems=$($problems.Count)"
            "runOnce=$($registered -join ';')"
            "pending=$($pending -join ';')"
        ) | Out-Null

        if ($problems.Count -gt 0) {
            $problems | ForEach-Object { Write-Error $_ }
            exit 1
        }
        Write-Output '开机续删与强制关机保障验证通过。'
        exit 0
    }
}
