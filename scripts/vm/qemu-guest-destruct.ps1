<#
在 QEMU 的 Windows 客机内驱动「关机自毁 / 开机续删」两阶段。

这条脚本只在客机内运行（由 .github/workflows/ci-qemu-destruct.yml 通过 SSH 调用）。
宿主（托管 Ubuntu runner）**不能**跑两阶段：Linux 的 pwsh 没有 Registry provider，
run-shutdown-destruct.ps1 里的 HKCU:\...\RunOnce 会直接抛错。工作流里有一道
显式探测（PWSH_HKCU_PROVIDER=absent）把这条约束钉住。

为什么要这层薄包装，而不是让工作流直接调 run-shutdown-destruct.ps1：
  1. 复核「登记用的目标路径与断言用的目标路径是同一个」——两阶段之间隔着一次重启，
     路径漂移会让断言永远通过（删了个不存在的文件也算「已删」）。
  2. 把每个阶段的结论落盘成客机内的证据文件，重启后仍可取回（覆盖层不销毁）。
  3. 把两阶段的退出码聚合成一个明确的 PASS/FAIL 结论，宿主只看一个退出码。

两阶段语义（与真关机路径完全一致，唯一差别是谁触发重启）：
  -Phase register  等价于 `run-shutdown-destruct.ps1 -Stage shutdown -NoShutdown`
                   建待删目标 + 让 purge 模块登记真实 HKCU RunOnce，不执行 shutdown.exe
                   （真关机会让 QEMU 进程退出；user-mode 网络没有 ACPI 上电接口，
                   客机不会自己再上电，所以重启由宿主侧经 SSH 发起）
  -Phase replay    等价于 `run-shutdown-destruct.ps1 -Stage resume`
                   断言目标已删 + RunOnce 登记已自行撤销 + 无延迟删除残留

注意：`run-shutdown-destruct.ps1` 没有 `-ReplayRunOnce` 参数（本仓库全文 0 命中）。
「重放」就是重启后再跑一次 -Stage resume，不要写成不存在的开关。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('register', 'replay')]
    [string]$Phase,

    # purge-tests.exe 在客机里的绝对路径。
    # 必须显式传参而不是靠环境变量：工作流里 `env:` 设的是**宿主（Ubuntu）**进程的
    # 环境变量，不会穿过 SSH 边界进入客机。之前那种「在 workflow 里写
    # CX_NATIVE_PURGE_EXE 就以为客机拿得到」的做法是错的，客机侧会永远读到空值。
    [Parameter(Mandatory = $true)]
    [string]$PurgeExe
)

$ErrorActionPreference = 'Stop'

# 把入参提升成环境变量：run-shutdown-destruct.ps1 只认 $env:CX_NATIVE_PURGE_EXE，
# 这样两阶段脚本本身不需要为「从 SSH 传参」这一场景改造。
$env:CX_NATIVE_PURGE_EXE = $PurgeExe

$vmScript = Join-Path $PSScriptRoot 'run-shutdown-destruct.ps1'
if (-not (Test-Path -LiteralPath $vmScript)) {
    throw "缺少两阶段脚本: $vmScript"
}

$evidenceRoot = if ([string]::IsNullOrWhiteSpace($env:CX_GUEST_EVIDENCE)) { 'C:\cx\evidence' } else { $env:CX_GUEST_EVIDENCE }
New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null

# 固定 RUNNER_TEMP：run-shutdown-destruct.ps1 用它算自己的 workRoot，本脚本也要用
# 同一个根去核对待删目标。不钉死的话，客机里若恰好设了 RUNNER_TEMP，两边的
# workRoot 会不同 → 「目标不存在」的断言指向了另一个路径 → 假通过。
$tempRoot = if ([string]::IsNullOrWhiteSpace($env:CX_GUEST_TEMP)) { 'C:\cx\temp' } else { $env:CX_GUEST_TEMP }
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$env:RUNNER_TEMP = $tempRoot

# 两个阶段共用的固定路径：登记与断言必须指向同一个文件，
# 否则「文件不存在」这个断言在路径漂移时会假通过。
$workRoot = Join-Path $tempRoot 'cx-purge-vm-work'
$target = Join-Path $workRoot 'shutdown-target.txt'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$evidenceFile = Join-Path $evidenceRoot "cx-guest-destruct-$Phase-$stamp.txt"
$lines = [System.Collections.Generic.List[string]]::new()
$problems = [System.Collections.Generic.List[string]]::new()

function Add-Line {
    param([string]$Text)
    $lines.Add($Text)
    Write-Output $Text
}

function Save-Evidence {
    $lines | Out-File -FilePath $evidenceFile -Encoding utf8
    Write-Output "客机证据: $evidenceFile"
}

function Get-PurgeRunOnceValues {
    $runOnceKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
    if (-not (Test-Path -LiteralPath $runOnceKey)) { return @() }
    $item = Get-ItemProperty -LiteralPath $runOnceKey -ErrorAction SilentlyContinue
    if ($null -eq $item) { return @() }
    return @(
        $item.PSObject.Properties
        | Where-Object { $_.Name -like 'cxplus-purge-*' }
        | ForEach-Object { $_.Name }
    )
}

Add-Line "phase=$Phase"
Add-Line "host=$env:COMPUTERNAME"
Add-Line "user=$env:USERNAME"
Add-Line "pwsh=$($PSVersionTable.PSVersion)"
Add-Line "vmScript=$vmScript"
Add-Line "workRoot=$workRoot"
Add-Line "target=$target"
Add-Line "purgeExe=$env:CX_NATIVE_PURGE_EXE"
Add-Line "purgeExeExists=$(Test-Path -LiteralPath $env:CX_NATIVE_PURGE_EXE)"
Add-Line "bootTime=$((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('yyyyMMdd-HHmmss'))"

if (-not (Test-Path -LiteralPath $env:CX_NATIVE_PURGE_EXE)) {
    # 客机镜像里必须预置 purge-tests.exe。缺它说明镜像没按约定准备，
    # 属于配置问题而不是被测逻辑的缺陷 —— 但要失败，否则「跑过了」是假的。
    $problems.Add("客机缺少 purge 测试产物: $env:CX_NATIVE_PURGE_EXE（镜像需预置 build-windows.ps1 -BuildTests 的产物）")
}

switch ($Phase) {
    'register' {
        # 阶段一：登记。委托给既有的两阶段脚本，-NoShutdown 只做「登记 + 断言」。
        New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
        # 先清场：上一轮残留会让「登记成功」看起来像真的发生过一次新登记。
        $stale = Get-PurgeRunOnceValues
        if ($stale.Count -gt 0) {
            Add-Line "staleRunOnceBefore=$($stale -join ';')"
            # 只报告不清理：清理是自毁逻辑自己的职责，替它擦屁股会掩盖真实缺陷。
            $problems.Add("登记前已存在 cxplus-purge-* 登记项：$($stale -join ', ')")
        }
        if (Test-Path -LiteralPath $target) {
            Add-Line 'staleTargetBefore=yes'
            $problems.Add("登记前待删目标已存在：$target（本轮无法区分新旧登记）")
        }

        if ($problems.Count -eq 0) {
            $global:LASTEXITCODE = 0
            & $vmScript -Stage shutdown -NoShutdown
            $code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
            Add-Line "innerExitCode=$code"
            if ($code -ne 0) { $problems.Add("run-shutdown-destruct.ps1 -Stage shutdown -NoShutdown 退出码 $code") }
        }

        $registered = Get-PurgeRunOnceValues
        Add-Line "registeredAfter=$($registered -join ';')"
        Add-Line "targetExistsAfter=$(Test-Path -LiteralPath $target)"
        if ($registered.Count -eq 0) { $problems.Add('登记阶段结束后 HKCU RunOnce 里没有 cxplus-purge-* 项') }
        if (-not (Test-Path -LiteralPath $target)) { $problems.Add("登记阶段结束后待删目标不存在：$target") }

        # 显式写一份「登记了哪些项」，重启后 replay 阶段用来交叉核对。
        @(
            "registeredAfter=$($registered -join ';')"
            "target=$target"
            "stamp=$stamp"
        ) | Out-File -FilePath (Join-Path $evidenceRoot 'cx-guest-registration.txt') -Encoding utf8
    }

    'replay' {
        # 阶段二：重启后的重放断言。
        $registrationFile = Join-Path $evidenceRoot 'cx-guest-registration.txt'
        if (Test-Path -LiteralPath $registrationFile) {
            Add-Line 'registrationEvidence:'
            foreach ($line in @(Get-Content -LiteralPath $registrationFile -Encoding utf8)) { Add-Line "  $line" }
            $recordedTarget = @(
                Get-Content -LiteralPath $registrationFile -Encoding utf8
                | Where-Object { $_ -like 'target=*' }
                | ForEach-Object { $_.Substring(7).Trim() }
            )
            if ($recordedTarget.Count -gt 0 -and $recordedTarget[0] -ne $target) {
                $problems.Add("登记阶段的目标路径 ($($recordedTarget[0])) 与重放阶段 ($target) 不一致")
            }
        } else {
            Add-Line "registrationEvidence=missing"
            $problems.Add("缺少登记阶段证据：$registrationFile（register 阶段未成功落盘）")
        }

        if ($problems.Count -eq 0) {
            $global:LASTEXITCODE = 0
            & $vmScript -Stage resume
            $code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
            Add-Line "innerExitCode=$code"
            if ($code -ne 0) { $problems.Add("run-shutdown-destruct.ps1 -Stage resume 退出码 $code") }
        }

        # 独立复核（不依赖 purge-tests 的自述）：目标必须真的没了。
        Add-Line "targetExistsAfter=$(Test-Path -LiteralPath $target)"
        if (Test-Path -LiteralPath $target) { $problems.Add("待删目标仍存在：$target") }

        $registered = Get-PurgeRunOnceValues
        Add-Line "registeredAfter=$($registered -join ';')"
        if ($registered.Count -gt 0) { $problems.Add("RunOnce 登记未撤销：$($registered -join ', ')") }
    }
}

Add-Line "problems=$($problems.Count)"
$problems | ForEach-Object { Add-Line "problem: $_" }
Save-Evidence

if ($problems.Count -gt 0) {
    # $ErrorActionPreference='Stop' 下第一个 Write-Error 会终止，剩下的问题会被吞：
    # 先把全部问题打到输出，再用一条 Write-Error 定退出码。
    $problems | ForEach-Object { Write-Output "问题: $_" }
    Write-Error "$Phase 阶段发现 $($problems.Count) 个问题，见上方清单与 $evidenceFile"
    exit 1
}

Write-Output "$Phase 阶段通过。"
exit 0
