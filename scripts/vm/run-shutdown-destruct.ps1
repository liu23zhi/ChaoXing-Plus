<#
在虚拟机内驱动自毁兜底的两个阶段。

Stage shutdown：验证关机流程内的同步自毁
  - 建一个待删文件
  - 让 purge 模块登记它（真实 HKCU RunOnce，不重定向到测试子键）
  - 触发关机（真实 shutdown）
  - 因为进程会被关机杀掉，本阶段只负责「登记 + 发起关机」，断言在开机后的 Stage resume

Stage resume：验证开机续删与强制关机保障
  - 断言 shutdown 阶段登记的文件已被删除
  - 断言 RunOnce 登记已自行撤销
  - 单独验证 MOVEFILE_DELAY_UNTIL_REBOOT 项在重启后消失

两个阶段都由 purge-tests.exe 的分阶段驱动执行（环境变量
CX_PURGE_TEST_STAGE / CX_PURGE_TEST_TARGET），脚本负责过程断言与证据落盘。

注意：本脚本只由 .github/workflows/ci.yml 在一次性虚拟机上调用
（2026-11-10：原 ci-vm.yml 已整体并入 ci.yml）。不要在开发机上跑 shutdown。
-NoShutdown 只做「登记 + 断言」，仍会真的写 HKCU RunOnce，跑完请按报告里的
登记名清理（shutdown 阶段失败时登记不会被撤销）。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('shutdown', 'resume')]
    [string]$Stage,

    # 跳过真实关机，只做登记与断言。用于在没有 VM 的环境里做语法自检。
    [switch]$NoShutdown,

    # 在 resume 阶段之前，把 shutdown 阶段登记的真实 RunOnce command 串
    # **按注册表里存的原文**执行一次，模拟「登录时 Windows 执行 RunOnce」。
    #
    # 为什么需要一个单独的开关：$NoShutdown 只是「不关机」，
    # 它证明的是「登记正确」；而开机续删真正要证的是
    # 「RunOnce 里那条命令串被 Windows 执行后，脚本删掉了目标、并撤销了登记」。
    # 在本机/托管 Windows runner 上跑不了真重启，但可以执行**存储的那条命令串**
    # ——这正是 Windows 登录时做的事（`reg query` 拿到什么就执行什么）。
    # 覆盖不到的只有「登录会话真去读 RunOnce 这个动作」，不是命令串本身。
    [switch]$ReplayRunOnce
)

$ErrorActionPreference = 'Stop'

$purgeExe = $env:CX_NATIVE_PURGE_EXE
$hostExe = $env:CX_NATIVE_HOST_EXE
$runOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$valuePrefix = 'cxplus-purge-'
# GitHub runner 提供 RUNNER_TEMP；本地 -NoShutdown 自检时它不存在，回退到 %TEMP%
# 才能真的跑通（之前 Join-Path 收到空值会直接抛参数绑定错误）。
$tempRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { $env:TEMP } else { $env:RUNNER_TEMP }
$workRoot = Join-Path $tempRoot 'cx-purge-vm-work'

function Write-StageReport {
    param([string]$Name, [string[]]$Lines)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $path = Join-Path $tempRoot "cx-purge-$Name-$stamp.log"
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

# 原生测试产物是 GUI 子系统（与宿主同源编译）：直接 `& $exe` 不会等待，
# $LASTEXITCODE 也拿不到。必须显式等待并重定向输出。
function Invoke-PurgeTest {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][hashtable]$Environment
    )
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outFile = Join-Path $tempRoot "cx-purge-invoke-$stamp.out"
    $errFile = Join-Path $tempRoot "cx-purge-invoke-$stamp.err"
    foreach ($name in $Environment.Keys) { Set-Item -Path "Env:$name" -Value $Environment[$name] }
    try {
        $process = Start-Process -FilePath $Exe -Wait -PassThru -NoNewWindow `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    } finally {
        foreach ($name in $Environment.Keys) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue }
    }
    $text = @()
    foreach ($file in @($outFile, $errFile)) {
        if (Test-Path -LiteralPath $file) {
            $text += @(Get-Content -LiteralPath $file -Encoding utf8 -ErrorAction SilentlyContinue)
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        }
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = @($text) }
}

switch ($Stage) {
    'shutdown' {
        if (-not (Test-Path -LiteralPath $purgeExe)) {
            throw "缺少 purge 测试产物: $purgeExe（先跑 windows/native-source/build-windows.ps1 -BuildTests）"
        }
        New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
        $target = Join-Path $workRoot 'shutdown-target.txt'
        Set-Content -LiteralPath $target -Value 'shutdown-destruct-target' -Encoding utf8

        # purge-tests 自带分阶段驱动（CX_PURGE_TEST_STAGE / CX_PURGE_TEST_TARGET）；
        # 这两个阶段写真实 HKCU RunOnce，不重定向到测试子键。
        $run = Invoke-PurgeTest -Exe (Resolve-Path -LiteralPath $purgeExe).Path -Environment @{
            CX_PURGE_TEST_TARGET = $target
            CX_PURGE_TEST_STAGE  = 'shutdown'
        }
        $exitCode = $run.ExitCode
        $output = $run.Output
        $output | Write-Output
        $registered = Get-PurgeRunOnceValues
        Write-StageReport -Name 'shutdown' -Lines @(
            "stage=shutdown"
            "purgeExe=$purgeExe"
            "target=$target"
            "exitCode=$exitCode"
            "runOnce=$($registered -join ';')"
            "purgeOutput=$($output -join ' | ')"
        ) | Out-Null

        if ($exitCode -ne 0) {
            # 失败时把残留登记名直接打出来：真实 RunOnce 不会自己撤销，必须人工清掉。
            if ($registered.Count -gt 0) {
                Write-Warning "本次留下的 RunOnce 登记（未撤销）：$($registered -join ', ')"
            }
            throw "purge 关机阶段退出码 $exitCode"
        }
        if (-not (Test-Path -LiteralPath $target)) { throw "关机阶段未建立待删目标: $target" }

        if ($registered.Count -eq 0) { throw '关机阶段没有登记 RunOnce 续删项' }
        $reported = @($output | Where-Object { "$_" -like 'registered=*' } | ForEach-Object { "$_".Substring(11).Trim() })
        if ($reported.Count -gt 0 -and $reported[0] -notin $registered) {
            throw "purge-tests 报告的登记项 $($reported[0]) 不在真实 RunOnce 里（登记被重定向了？）"
        }
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

        # -ReplayRunOnce：先按注册表里存的原文执行那条 RunOnce 命令串，
        # 再交给 purge-tests 的 resume 阶段做原生断言。
        #
        # 顺序不能反：resume 断言的正是「RunOnce 执行之后」的状态。
        # 执行前后各记录一次登记名，用来区分三种情况：
        #   执行前就没有 → 用户没跑 shutdown 阶段，属调用顺序错误
        #   执行后有残留 → 续删逻辑没删净（真缺陷）
        #   执行后清空   → 期望行为
        if ($ReplayRunOnce) {
            $beforeReplay = @(Get-PurgeRunOnceValues)
            if ($beforeReplay.Count -eq 0) {
                throw 'RunOnce 里没有 cxplus-purge-* 登记，无法重放（先跑 -Stage shutdown）'
            }
            Write-Output "重放前登记项: $($beforeReplay -join ', ')"
            foreach ($name in $beforeReplay) {
                $command = (Get-ItemProperty -LiteralPath $runOnceKey -Name $name -ErrorAction Stop).$name
                if ([string]::IsNullOrWhiteSpace($command)) { throw "RunOnce 项 $name 的值为空" }
                Write-Output "重放 RunOnce 命令串 [$name]: $command"
                # 与 Windows 登录时一致：把存下来的命令行原样交给 shell 执行。
                # 不能用 Start-Process 拆参数 —— 那条串本身就是一个完整命令行，
                # 里面已经有成对引号，拆开就变味了。
                $shell = $env:ComSpec
                if ([string]::IsNullOrWhiteSpace($shell)) { $shell = 'cmd.exe' }
                & $shell /c $command | Out-Null
                $launchCode = $LASTEXITCODE
                Write-Output "重放退出码: $launchCode"
                # 续删脚本是独立进程，命令串返回时它可能还在收尾。
                # 最多等 60 s（与 purge-tests 内部的 wait_gone_file 同量级）。
                $waited = 0
                while ($waited -lt 60000 -and (@(Get-PurgeRunOnceValues).Count -gt 0)) {
                    Start-Sleep -Milliseconds 200
                    $waited += 200
                }
                Write-Output "重放后等待: ${waited}ms"
            }
            $afterReplay = @(Get-PurgeRunOnceValues)
            Write-Output "重放后登记项: $(if ($afterReplay.Count -eq 0) { '(无)' } else { $afterReplay -join ', ' })"
            if ($afterReplay.Count -gt 0) {
                $problems.Add("重放 RunOnce 后登记仍在: $($afterReplay -join ', ')")
            }
        }

        # purge-tests 的 resume 阶段做原生断言：目标已删 + 真实 RunOnce 登记已撤销。
        # 目标路径必须与 shutdown 阶段一致，缺了它 C 侧会拒绝执行。
        if (-not (Test-Path -LiteralPath $purgeExe)) {
            # -BuildTests 与 -Target tests 等价（后者在 build-windows.ps1 里只是把开关置真）；
            # 这里统一用 -BuildTests，与 ci.yml 里自毁作业的实际调用保持一致。
            throw "缺少 purge 测试产物: $purgeExe（先跑 windows/native-source/build-windows.ps1 -BuildTests）"
        }
        $target = Join-Path $workRoot 'shutdown-target.txt'
        $run = Invoke-PurgeTest -Exe (Resolve-Path -LiteralPath $purgeExe).Path -Environment @{
            CX_PURGE_TEST_TARGET = $target
            CX_PURGE_TEST_STAGE  = 'resume'
        }
        $exitCode = $run.ExitCode
        $output = $run.Output
        $output | Write-Output
        if ($exitCode -ne 0) {
            $problems.Add("purge-tests resume 阶段退出码 $exitCode")
        }

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
            # $ErrorActionPreference='Stop' 下第一个 Write-Error 就会终止，剩下的问题会被吞掉：
            # 先逐条输出全部问题，再用一条 Write-Error 定退出码。
            $problems | ForEach-Object { Write-Output "问题: $_" }
            Write-Error "resume 阶段发现 $($problems.Count) 个问题，见上方清单与报告"
            exit 1
        }
        Write-Output '开机续删与强制关机保障验证通过。'
        exit 0
    }
}
