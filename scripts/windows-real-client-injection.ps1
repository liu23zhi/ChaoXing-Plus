[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $ClientInstaller,
  [Parameter(Mandatory = $true)] [ValidateSet('cdp-port', 'dll-proxy')] [string] $InjectMode,
  [Parameter(Mandatory = $true)] [string] $DatabaseBase64,
  [Parameter(Mandatory = $true)] [string] $NativeHost,
  [Parameter(Mandatory = $true)] [string] $CaseName,
  # Local debugging only: with this switch an environment-blocked run exits 0 after reporting
  # REAL_CLIENT_INJECTION_BLOCKED. CI never passes it - a run without a page session must fail.
  [switch] $AllowEnvironmentBlocked,
  # Panel on every page (host flag --panel-all-pages). CXExam.exe protects its exam window with
  # SetWindowDisplayAffinity(hwnd, WDA_MONITOR) (IG5: 0x44d510 enables, 0x44d550 clears, both on the
  # HWND registered by the exam window init at 0x4d1120), so every GDI screen capture of that window is
  # pure black: manual confirmation has to come from the pages that are not protected yet (login,
  # course, jump). -PanelAllPages:$false restores the exam-only panel.
  [switch] $PanelAllPages = $true
)

$ErrorActionPreference = 'Stop'
$script:snapshotSizes = @{}
. (Join-Path $PSScriptRoot 'windows-client-database.ps1')
. (Join-Path $PSScriptRoot 'windows-client-cdp.ps1')
. (Join-Path $PSScriptRoot 'windows-client-entry.ps1')
. (Join-Path $PSScriptRoot 'windows-client-shell.ps1')
. (Join-Path $PSScriptRoot 'windows-client-diagnostics.ps1')
. (Join-Path $PSScriptRoot 'windows-client-input.ps1')

# -- Artifact filename map (user requirement 2026-11-11: artifact filenames in Chinese) --
#
# Why [char]0xNNNN instead of literal Chinese:
#   scripts/windows-build-script.test.mjs hard-asserts that every .ps1 in this directory
#   stays PURE ASCII (Chinese is decoded as ANSI by Windows PowerShell 5.1 and garbles).
#   Building names from code points satisfies the ASCII rule and still yields Chinese
#   filenames. Verified on both pwsh 7 and Windows PowerShell 5.1.
#
# Only the ARTIFACT filenames change; the real paths the script and host read/write
# (report.json / native-host.stdout.log / debug.log / input.txt ...) stay as-is,
# because renaming those would break the host contract. What gets localized is the
# Copy-Item destination name.
#
# The `cx-real-client-<CaseName>-` prefix stays ASCII on purpose: CaseName is
# version+index, so keeping it makes cross-run comparison and sorting trivial.
$script:zh = @{
  'imageCdp'     = -join ([char]0x622A, [char]0x56FE, [char]0x9875)                                                  # jietuye
  'imageDesktop' = -join ([char]0x684C, [char]0x9762, [char]0x622A, [char]0x56FE)                                    # zhuomian jietu
  'imageStart'   = -join ([char]0x542F, [char]0x52A8, [char]0x622A, [char]0x56FE)                                    # qidong jietu
  'imageBefore'  = -join ([char]0x70B9, [char]0x51FB, [char]0x524D, [char]0x622A, [char]0x56FE)                      # dianjiqian jietu
  'imageAfter'   = -join ([char]0x70B9, [char]0x51FB, [char]0x540E, [char]0x622A, [char]0x56FE)                      # dianjihou jietu
  'imageConfirm' = -join ([char]0x786E, [char]0x8BA4, [char]0x5F39, [char]0x7A97, [char]0x622A, [char]0x56FE)        # queren tanchuang jietu
  'report'       = -join ([char]0x6CE8, [char]0x5165, [char]0x62A5, [char]0x544A)                                    # zhuru baogao
  'entry'        = -join ([char]0x5165, [char]0x53E3, [char]0x8BB0, [char]0x5F55)                                    # rukou jilu
  'environment'  = -join ([char]0x73AF, [char]0x5883, [char]0x4FE1, [char]0x606F)                                    # huanjing xinxi
  'hostOut'      = -join ([char]0x5BBF, [char]0x4E3B, [char]0x6807, [char]0x51C6, [char]0x8F93, [char]0x51FA)        # suzhu biaozhun shuchu
  'hostErr'      = -join ([char]0x5BBF, [char]0x4E3B, [char]0x6807, [char]0x51C6, [char]0x9519, [char]0x8BEF)        # suzhu biaozhun cuowu
  'clientDebug'  = -join ([char]0x5BA2, [char]0x6237, [char]0x7AEF, [char]0x8C03, [char]0x8BD5, [char]0x65E5, [char]0x5FD7)   # kehuduan tiaoshi rizhi
  'clientInput'  = -join ([char]0x5BA2, [char]0x6237, [char]0x7AEF, [char]0x8F93, [char]0x5165, [char]0x8BB0, [char]0x5F55)   # kehuduan shuru jilu
  'inputBefore'  = -join ([char]0x8F93, [char]0x5165, [char]0x524D, [char]0x72B6, [char]0x6001)                      # shuruqian zhuangtai
  'inputAfter'   = -join ([char]0x8F93, [char]0x5165, [char]0x540E, [char]0x72B6, [char]0x6001)                      # shuruhou zhuangtai
  'sha256'       = -join ([char]0x6821, [char]0x9A8C, [char]0x548C)                                                  # jiaoyanhe
  'prepSummary'  = -join ([char]0x51C6, [char]0x5907, [char]0x6458, [char]0x8981)                                    # zhunbei zhaiyao
}
$tempRoot = Join-Path $env:RUNNER_TEMP ("cx-real-client-" + [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $tempRoot 'package'
$reportPath = Join-Path $tempRoot 'report.json'
$stdoutPath = Join-Path $tempRoot 'native-host.stdout.log'
$stderrPath = Join-Path $tempRoot 'native-host.stderr.log'
$hostProcess = $null
$clientPath = ''
$clientDirectory = ''
$inputState = $null
$entry = $null
$report = $null
$runStarted = Get-Date
$base64 = ''
$stage = 'initialize'
# Script-scope so the cleanup path can still capture the page while the client is alive.
$script:cdpPort = 0
$script:cdpPrefix = ''
$script:captureGuard = $null
$script:captureGuardHandle = $null
# Set only when the report says the bundle never proved itself in the page; printed again at the very
# end so the warning survives the PASS line and the cleanup noise.
$script:injectVerifiedWarning = ''

function Find-SevenZip {
  foreach ($name in @('7z.exe', '7zz.exe')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
  }
  foreach ($path in @(
    (Join-Path ${env:ProgramFiles} '7-Zip\7z.exe'),
    (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe')
  )) {
    if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) { return $path }
  }
  throw '7-Zip is required to unpack the private NSIS client fixture'
}

function Stop-OwnedProcess([System.Diagnostics.Process] $process) {
  if (-not $process) { return }
  try {
    if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit(10000) | Out-Null }
  } catch { }
}

# Cleanup must not depend on the host's own exit path: the client can survive when the host is killed,
# when the entry click never produced a page, or when the host handed off to an elevated instance.
function Stop-ClientProcess([string] $ClientPath) {
  if (-not $ClientPath) { return }
  $stopped = 0
  foreach ($candidate in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ClientPath)) -ErrorAction SilentlyContinue)) {
    try {
      $actual = $candidate.Path
      if (-not $actual -or -not $actual.Equals($ClientPath, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $candidate.Kill($true)
      $candidate.WaitForExit(10000) | Out-Null
      ++$stopped
    } catch {
      Write-Host "[real-client] unable to stop client pid=$($candidate.Id): $($_.Exception.Message)"
    }
  }
  Write-Host "[real-client] stopped $stopped leftover client process(es)"
}

# A host that handed off to an elevated instance is not our child handle anymore; stop it by image path
# but only if it started during this run, so a host the operator started by hand is left alone.
function Stop-StartedHost([string] $HostPath, [datetime] $StartedAt) {
  if (-not $HostPath) { return }
  $stopped = 0
  foreach ($candidate in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($HostPath)) -ErrorAction SilentlyContinue)) {
    try {
      if ($candidate.StartTime -lt $StartedAt) { continue }
      $actual = $candidate.Path
      if (-not $actual -or -not $actual.Equals($HostPath, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $candidate.Kill($true)
      $candidate.WaitForExit(10000) | Out-Null
      ++$stopped
    } catch { }
  }
  if ($stopped -gt 0) { Write-Host "[real-client] stopped $stopped leftover host process(es)" }
}

function Save-RunArtifacts {
    param([string] $CaseName)
    $target = $env:RUNNER_TEMP
    if (-not $target -or -not (Test-Path -LiteralPath $target -PathType Container)) { return }
    foreach ($entry in @(@{ Source = $reportPath; Name = ($script:zh['report'] + '.json') }, @{ Source = $stdoutPath; Name = ($script:zh['hostOut'] + '.log') }, @{ Source = $stderrPath; Name = ($script:zh['hostErr'] + '.log') })) {
        if (-not (Test-Path -LiteralPath $entry.Source -PathType Leaf)) { continue }
        try { Copy-Item -LiteralPath $entry.Source -Destination (Join-Path $target "cx-real-client-$CaseName-$($entry.Name)") -Force } catch { }
    }
    if ($clientDirectory) {
        foreach ($item in @(@{ Source = 'debug.log'; Suffix = ($script:zh['clientDebug'] + '.log') }, @{ Source = 'input.txt'; Suffix = ($script:zh['clientInput'] + '.txt') })) {
            $saved = Join-Path $target "cx-real-client-$CaseName-$($item.Suffix)"
            $live = Join-Path $clientDirectory $item.Source
            $liveSize = 0
            if (Test-Path -LiteralPath $live -PathType Leaf) { $liveSize = (Get-Item -LiteralPath $live).Length }
            # Keep the snapshot taken while the client was alive: the host truncates these files on stop.
            if ($liveSize -gt 0 -or -not (Test-Path -LiteralPath $saved)) {
                if (Test-Path -LiteralPath $live -PathType Leaf) {
                    try { Copy-Item -LiteralPath $live -Destination $saved -Force } catch { }
                }
            }
        }
    }
    [void](Save-DesktopScreenshot -Path (Join-Path $target ("cx-real-client-$CaseName-" + $script:zh['imageDesktop'] + ".png")) -ScalePercent 100)
}

# The host truncates the client's debug.log during its own shutdown, so the only way to keep it is to
# snapshot while the client is still running (and again whenever it grows).
# The client writes debug.log (CEF messages) and input.txt (the input methods it enumerated) next to its
# exe, and the host truncates both on shutdown, so they are copied while the client is still alive.
function Update-ClientDebugSnapshot {
    param([string] $CaseName)
    $target = $env:RUNNER_TEMP
    if (-not $target -or -not $clientDirectory) { return }
    foreach ($item in @(@{ Source = 'debug.log'; Suffix = ($script:zh['clientDebug'] + '.log') }, @{ Source = 'input.txt'; Suffix = ($script:zh['clientInput'] + '.txt') })) {
        try {
            $source = Join-Path $clientDirectory $item.Source
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
            $info = Get-Item -LiteralPath $source
            if ($info.Length -le 0) { continue }
            $key = "last-$($item.Suffix)"
            if ($script:snapshotSizes[$key] -eq $info.Length) { continue }
            Copy-Item -LiteralPath $source -Destination (Join-Path $target "cx-real-client-$CaseName-$($item.Suffix)") -Force
            $script:snapshotSizes[$key] = $info.Length
            Write-Host "[real-client] $($item.Source) snapshot at $($info.Length) bytes"
        } catch { }
    }
}

# Hash manifest written last: every artifact of this case can be verified byte for byte after download.
function Save-ArtifactManifest {
    param([string] $CaseName)
    $target = $env:RUNNER_TEMP
    if (-not $target -or -not (Test-Path -LiteralPath $target -PathType Container)) { return }
    try {
        $lines = foreach ($file in @(Get-ChildItem -LiteralPath $target -File -Filter "cx-real-client-$CaseName-*" | Sort-Object Name)) {
            if ($file.Name -like ("*-" + $script:zh['sha256'] + ".txt")) { continue }
            $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            "$hash  $($file.Name)"
        }
        if ($lines) { [IO.File]::WriteAllLines((Join-Path $target ("cx-real-client-$CaseName-" + $script:zh['sha256'] + ".txt")), @($lines)) }
    } catch {
        Write-Host "[real-client] artifact manifest failed: $($_.Exception.Message)"
    }
}

function Write-HostDiagnostics {
  foreach ($entry in @(@{ Label = 'stdout'; Path = $stdoutPath }, @{ Label = 'stderr'; Path = $stderrPath })) {
    if (-not (Test-Path -LiteralPath $entry.Path -PathType Leaf)) { continue }
    try {
      $text = [IO.File]::ReadAllText($entry.Path)
      foreach ($sensitiveValue in @($DatabaseBase64, $base64)) {
        if (-not [string]::IsNullOrEmpty($sensitiveValue)) { $text = $text.Replace($sensitiveValue, '[masked]') }
      }
      if ($text.Length -gt 12000) { $text = $text.Substring($text.Length - 12000) }
      Write-Host "----- native host $($entry.Label) (last 12000 characters max) -----"
      if ([string]::IsNullOrWhiteSpace($text)) { Write-Host '<empty>' } else { Write-Host $text }
    } catch {
      Write-Host "Unable to read native host $($entry.Label): $($_.Exception.Message)"
    }
  }
}

try {
  Write-Host "[real-client] case=$CaseName mode=$InjectMode stage=validate-inputs"
  if ($env:RUNNER_TEMP -and (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    $environmentPath = Join-Path $env:RUNNER_TEMP ("cx-real-client-$CaseName-" + $script:zh['environment'] + ".json")
    try { (Get-DesktopEnvironment) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $environmentPath -Encoding utf8 } catch { }
    [void](Save-DesktopScreenshot -Path (Join-Path $env:RUNNER_TEMP ("cx-real-client-$CaseName-" + $script:zh['imageStart'] + ".png")) -ScalePercent 100)
  }
  $inputState = Get-InputState
  if ($env:RUNNER_TEMP) {
    try { $inputState | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP ("cx-real-client-$CaseName-" + $script:zh['inputBefore'] + ".json")) -Encoding utf8 } catch { }
  }
  Write-Host "[real-client] input before: layouts=$((@($inputState.LayoutHandles)) -join ',') active=$($inputState.ActiveLayout) preload=$((($inputState.Preload.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' '))"
  if (-not (Test-Path -LiteralPath $ClientInstaller -PathType Leaf)) { throw "Client fixture is missing: $ClientInstaller" }
  if (-not (Test-Path -LiteralPath $NativeHost -PathType Leaf)) { throw "Native host is missing: $NativeHost" }
  New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null

  $stage = 'find-7zip'
  $sevenZip = Find-SevenZip
  Write-Host "[real-client] stage=$stage executable=$sevenZip"

  $stage = 'extract-client'
  & $sevenZip x $ClientInstaller ("-o" + $packageRoot) '-y' '-bd' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to unpack client fixture (7z exit $LASTEXITCODE)" }

  $clients = @(Get-ChildItem -LiteralPath $packageRoot -Filter 'CXExam.exe' -Recurse -File)
  if ($clients.Count -ne 1) { throw "Expected exactly one CXExam.exe after unpacking, found $($clients.Count)" }
  $client = $clients[0]
  $clientDirectory = $client.DirectoryName
  $clientPath = $client.FullName
  Write-Host "[real-client] extracted client=$($client.FullName) bytes=$($client.Length)"

  $stage = 'install-database'
  $base64 = ($DatabaseBase64 -replace '\s', '')
  $database = Install-ClientDatabase -ClientDirectory $clientDirectory -Base64 $base64
  Write-Host "[real-client] database file matched=$($database.Path) bytes=$($database.Bytes) sqlite=$($database.Sqlite)"

  $arguments = @(
    '--inject-mode', $InjectMode,
    '--client', $client.FullName,
    '--report', $reportPath,
    '--duration', '180000',
    '--no-log',
    '--stop-client-on-exit'
  )
  # Mount the panel on non-exam pages too: the host evaluates window.__CX_WIN_PANEL_ALL_PAGES__ = true
  # after each bootstrap, and that is the only evidence a human can see - the exam window itself is
  # WDA_MONITOR protected and captures as pure black.
  if ($PanelAllPages) { $arguments += '--panel-all-pages' }
  # The client writes debug.log and the host truncates it on shutdown, which can happen before the entry
  # phase even starts (a rejected database makes the client exit in seconds). Watch it from the moment the
  # host starts, in a background job, so the content survives the truncation.
  $stage = 'start-native-host'
  Write-Host "[real-client] stage=$stage host=$NativeHost client=$($client.FullName)"
  $maskedArguments = @($arguments | ForEach-Object { if ($_ -is [string] -and $_.Length -gt 40) { $_.Substring(0, 12) + '...(' + $_.Length + ' chars)' } else { $_ } })
  Write-Host "[real-client] host arguments: $($maskedArguments -join ' ')"
  Write-Host "[real-client] panelAllPages=$([bool]$PanelAllPages) (panel on non-exam pages for manual confirmation)"
  $hostProcess = Start-Process -FilePath $NativeHost -ArgumentList $arguments -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  Write-Host "[real-client] native host started pid=$($hostProcess.Id)"
  $debugCase = $CaseName
  $debugHeartbeat = { Update-ClientDebugSnapshot -CaseName $debugCase }.GetNewClosure()

  # The client parks on its native check window and only builds the CEF page after the button is
  # pressed; without this click the host has no page to inject and the report stays at pageSessions=0.
  $stage = 'enter-exam'
  $entryPrefix = if ($env:RUNNER_TEMP) { Join-Path $env:RUNNER_TEMP "cx-real-client-$CaseName" } else { "" }
  $script:cdpPrefix = $entryPrefix
  $entry = Wait-ClientExamEntry -ClientPath $client.FullName -TimeoutSeconds 90 -ScreenshotPrefix $entryPrefix -Heartbeat $debugHeartbeat
  if ($entry.Reason -eq 'entry-window-not-found') {
    Write-Host '[real-client] exam entry window was not found within 90s; continuing to collect the report'
  } else {
    Write-Host "[real-client] exam entry window=$($entry.Window) pid=$($entry.ProcessId) point=$($entry.Point) dpi=$($entry.Dpi) client=$($entry.ClientSize) attempts=$($entry.Attempts) pages=$($entry.PageTargets) clicked=$($entry.Clicked) reason=$($entry.Reason) windows=$([CXClientEntry]::WindowClasses([uint32]$entry.ProcessId))"
  }

  # The desktop frames that Wait-ClientExamEntry wrote stay as they are (frame 4 is the black one);
  # this is the page-internal copy of the same moment, taken through the client's own DevTools endpoint.
  $script:cdpPort = if ($entry.PSObject.Properties['ProcessId']) { Get-ClientCdpPort -ProcessId ([int]$entry.ProcessId) } else { 0 }
  if ($script:cdpPort -gt 0 -and $entryPrefix) {
    $entryShot = Save-CdpPageScreenshot -Port $script:cdpPort -Path ("$entryPrefix-" + $script:zh['imageCdp'] + ".png") -TimeoutSeconds 15
    if ($entryShot) {
      Write-Host "[real-client] cdp page screenshot bytes=$($entryShot.Bytes) size=$($entryShot.Width)x$($entryShot.Height) url=$($entryShot.Url)"
    } else {
      Write-Host "[real-client] cdp page screenshot unavailable (port=$($script:cdpPort)); desktop frames are still saved"
    }
  } else {
    Write-Host '[real-client] no cdp endpoint yet; only desktop frames were captured so far'
  }

  # Proctoring capture guard: while the client photographs the desktop for the server it drops its own
  # WDA_MONITOR, so an open panel would land in that upload. The watcher runs as an in-process runspace
  # (no extra process to be enumerated) and hides the panel through DevTools until the window is
  # protected again. Best effort, never fatal.
  if ($script:cdpPort -gt 0 -and $entry.PSObject.Properties['ProcessId'] -and [int]$entry.ProcessId -gt 0) {
    $guardProject = $PSScriptRoot
    $guardPid = [int]$entry.ProcessId
    $guardPort = $script:cdpPort
    try {
      $script:captureGuard = [PowerShell]::Create()
      [void]$script:captureGuard.AddScript(@'
param($root, $clientPid, $port)
. (Join-Path $root 'windows-client-entry.ps1')
. (Join-Path $root 'windows-client-cdp.ps1')
Watch-ClientCaptureGuard -ProcessId $clientPid -Port $port -TimeoutSeconds 290
'@).AddArgument($guardProject).AddArgument($guardPid).AddArgument($guardPort)
      $script:captureGuardHandle = $script:captureGuard.BeginInvoke()
      Write-Host "[real-client] capture guard watching pid=$guardPid port=$guardPort"
    } catch {
      Write-Host "[real-client] capture guard unavailable: $($_.Exception.Message)"
    }
  }

  # Version matrix evidence: record the display affinity of every client top-level window at entry
  # (1 = WDA_MONITOR, so window captures are black) and whether hook.txt exists (the client writes it
  # when its WH_KEYBOARD_LL install fails, which disables both the swallowed keys and the key log).
  $affinitySnapshot = ''
  $hookLog = ''
  if ($entry.PSObject.Properties['ProcessId'] -and [int]$entry.ProcessId -gt 0) {
    try {
      $affinityMap = Get-ClientWindowAffinity -ProcessId ([int]$entry.ProcessId)
      $affinitySnapshot = (@($affinityMap.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ';')
    } catch { }
  }
  if ($clientDirectory -and (Test-Path -LiteralPath (Join-Path $clientDirectory 'hook.txt'))) { $hookLog = 'hook.txt' }
  if ($affinitySnapshot) { Write-Host "[real-client] window affinity: $affinitySnapshot" }
  if ($hookLog) { Write-Host '[real-client] client wrote hook.txt: its keyboard hook failed to install' }

  if ($env:RUNNER_TEMP) {
    try {
      [pscustomobject]@{
        reason = $entry.Reason
        attempts = $entry.Attempts
        point = $entry.Point
        target = $entry.Target
        dpi = $entry.Dpi
        clientSize = $entry.ClientSize
        pages = $entry.PageTargets
        clicked = $entry.Clicked
        confirmed = $entry.Confirmed
        windows = $(if ($entry.PSObject.Properties['Windows']) { $entry.Windows } else { '' })
        confirm = $(if ($entry.PSObject.Properties['ConfirmVia']) { $entry.ConfirmVia } else { '' })
        windowAffinity = $affinitySnapshot
        keyboardHookLog = $hookLog
        capturedAt = (Get-Date).ToString('o')
      } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP ("cx-real-client-$CaseName-" + $script:zh['entry'] + ".json")) -Encoding UTF8
    } catch { }
  }
  if ($entry.PageTargets -lt 1) {
    # Without a CEF page the host cannot inject anything; close the client now so the run ends with a
    # complete report instead of holding the client open for the whole duration.
    Write-Host '[real-client] no CEF page appeared after the entry attempts; closing the client before the report'
    Start-Sleep -Seconds 15
    Stop-ClientProcess $clientPath
  }

  Update-ClientDebugSnapshot -CaseName $CaseName

  $stage = 'wait-native-host'
  $hostDeadline = (Get-Date).AddSeconds(300)
  while (-not $hostProcess.HasExited -and (Get-Date) -lt $hostDeadline) {
    Update-ClientDebugSnapshot -CaseName $CaseName
    Start-Sleep -Seconds 5
  }
  Update-ClientDebugSnapshot -CaseName $CaseName
  if (-not $hostProcess.HasExited) {
    Stop-OwnedProcess $hostProcess
    throw "Native host timed out for $CaseName"
  }
  Write-Host "[real-client] native host exited code=$($hostProcess.ExitCode)"

  $stage = 'read-report'
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw "Native host did not write a report for $CaseName (exit $($hostProcess.ExitCode))"
  }
  $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  Write-Host "[real-client] report success=$($report.success) ownershipVerified=$($report.ownershipVerified) pageSessions=$($report.totals.pageSessions) bootstraps=$($report.totals.bootstraps) bundles=$($report.totals.bundles) stopReason=$($report.stopReason)"

  $stage = 'validate-report'
  $blockedByEnvironment = $false
  if (-not $report.success) {
    $windowClasses = [string]$entry.Windows
    $hintShown = $windowClasses -match 'ExamCheckHintUI'
    $noPage = [int]$report.totals.pageSessions -lt 1
    if ($hintShown -and $noPage) {
      # The client never left its check window, so nothing was injected. This is a failure: the job must
      # not look green when no page session exists.
      $blockedByEnvironment = $true
      $message = "REAL_CLIENT_INJECTION_BLOCKED $CaseName reason=environment-check client=$($entry.ClientSize) pages=$($entry.PageTargets)"
      Write-Host "[real-client] client refused to enter the exam: its environment check failed (camera / input method); windows=$windowClasses"
      Write-Host $message
      Write-Host "::error::$message"
      if (-not $AllowEnvironmentBlocked) { throw "$message (no page session, nothing was injected)" }
    } else {
      throw "Injection report is not successful for $CaseName"
    }
  }
  if ($blockedByEnvironment) {
    Write-HostDiagnostics
    Write-Host "REAL_CLIENT_INJECTION_BLOCKED $CaseName (no injection attempted: the client never left its check window)"
    return
  }
  if (-not $report.ownershipVerified) { throw "Client ownership was not verified for $CaseName" }
  if ([int]$report.totals.pageSessions -lt 1) { throw "No page session was injected for ${CaseName}: entry reason=$($entry.Reason) attempts=$($entry.Attempts) pageTargets=$($entry.PageTargets) client=$($entry.ClientSize) windows=$($entry.Windows)" }
  if ([int]$report.totals.bootstraps -lt 1) { throw "No bootstrap was injected for $CaseName" }
  if ([int]$report.totals.bundles -lt 1) { throw "No bundle was injected for $CaseName" }
  # The run ends either when the duration elapses or when the client is closed/killed first; both
  # leave a complete report, so the counters above are what actually prove the injection.
  if ($report.stopReason -notin @('duration', 'client-exit')) { throw "Unexpected stop reason for ${CaseName}: $($report.stopReason)" }
  # The counters above prove the host and the CDP transport worked; they stay green even when the page
  # never ran the bundle. injectEvidence is the only part of the report that proves the bundle really
  # landed in the page main world: bundleInPage comes from the main-world sentinel
  # (host-session.inc:186-202) and verified is endpointReady && bundleInPage &&
  # (!proxyHookRequired || proxyHook) (audit.c:264-271).
  # Grading is deliberately split into three tiers, because a known-bad baseline must not be confused
  # with a regression:
  #   injectEvidence absent or a missing evidence field -> red   (the report contract changed)
  #   bundleSentinelRejected = true                    -> red   (the page explicitly said no)
  #   reason = proxy-carrier-absent                    -> red   (the carrier DLL never ran at all)
  #   endpointReady + bundleInPage = false             -> red   (the chain ran and the bundle still
  #                                                              never landed: this is the case that
  #                                                              "only a working feature can be true"
  #                                                              guards)
  #   verified = false on its own                      -> yellow warning + injectVerifiedSummary
  # The red tier for "chain ran, bundle did not land" is what makes this matrix meaningful: without it
  # a report with pageSessions>=1 / bootstraps>=1 / bundles>=1 and bundleInPage=false passes, which is
  # exactly the state all six client cases were in on 2026-11-10. The yellow tier only covers the
  # genuinely-ambiguous window (endpoint up, bootstrap not yet acknowledged) so that resting-bad
  # baselines do not drown out new regressions.
  $evidence = $report.injectEvidence
  if (-not $evidence) {
    throw "Injection report has no injectEvidence object for ${CaseName}: the injection contract changed"
  }
  foreach ($evidenceField in @('bundleInPage', 'verified', 'reason', 'bundleSentinelRejected')) {
    if (-not $evidence.PSObject.Properties[$evidenceField]) {
      throw "Injection report injectEvidence is missing '$evidenceField' for ${CaseName}: the injection contract changed"
    }
  }
  # The chain "really ran" only when the CDP endpoint answered AND the bootstrap reached the page.
  # pageSessions is deliberately NOT part of this: a page session only proves the WebSocket
  # connected; when the bootstrap never arrives it is still >= 1, and that case means the chain
  # never came up rather than that the bundle failed to land.
  $chainRan = [bool]$evidence.endpointReady -and [int]$report.totals.bootstraps -ge 1
  $bundleLanded = [bool]$evidence.bundleInPage
  $verifiedTrue = if ([bool]$evidence.verified) { 1 } else { 0 }
  $verifiedFalse = 1 - $verifiedTrue
  $injectSummary = [ordered]@{
    total                  = 1
    verifiedTrue           = $verifiedTrue
    verifiedFalse          = $verifiedFalse
    bundleInPage           = $bundleLanded
    bundleSentinelRejected = [bool]$evidence.bundleSentinelRejected
    reason                 = [string]$evidence.reason
    chainRan               = $chainRan
    strictFailures         = @()
  }
  if ([bool]$evidence.bundleSentinelRejected) { $injectSummary.strictFailures = @('bundle-sentinel-rejected') }
  # A carrier that should have been loaded wrote no log at all: the proxy never executed, so nothing
  # downstream of it can be trusted. host.c h_proxy_hook_state returns ABSENT for this and only this case.
  if ([string]$evidence.reason -eq 'proxy-carrier-absent') { $injectSummary.strictFailures += 'proxy-carrier-absent' }
  # The decisive tier: the transport and the bootstrap both worked, yet the page never proved the bundle
  # ran. A page that accepted the command but did not execute the bundle is a failure, not a warning.
  if ($chainRan -and -not $bundleLanded -and -not [bool]$evidence.bundleSentinelRejected) {
    $injectSummary.strictFailures += 'bundle-not-in-page'
  }
  # The report is the artifact CI uploads, so the summary must travel with it on pass and on failure.
  try {
    $report | Add-Member -NotePropertyName 'injectVerifiedSummary' -NotePropertyValue ([pscustomobject]$injectSummary) -Force
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Write-Host "[real-client] unable to record injectVerifiedSummary in the report: $($_.Exception.Message)"
  }
  Write-Host "[real-client] injectEvidence bundleInPage=$($evidence.bundleInPage) verified=$($evidence.verified) sentinelRejected=$($evidence.bundleSentinelRejected) reason=$($evidence.reason) chainRan=$chainRan injectVerifiedSummary verifiedFalse=$verifiedFalse/$($injectSummary.total) strictFailures=$($injectSummary.strictFailures -join ',')"
  if ($verifiedFalse -gt 0) {
    $script:injectVerifiedWarning = "INJECT_BUNDLE_UNVERIFIED case=$CaseName verifiedFalse=$verifiedFalse/$($injectSummary.total) bundleInPage=$($evidence.bundleInPage) bundleSentinelRejected=$($evidence.bundleSentinelRejected) reason=$($evidence.reason): the CDP chain worked but the page never proved the bundle ran"
    Write-Host "::warning::$($script:injectVerifiedWarning)"
  }
  # Explicit rejection is not "could not tell": the page answered false or threw, which means the bundle
  # was accepted by the transport and did not run. host-session.inc:186-202 keeps that distinction.
  if ([bool]$evidence.bundleSentinelRejected) {
    throw "The page rejected the injected bundle for ${CaseName}: injectEvidence.bundleSentinelRejected=true reason=$($evidence.reason) (the main-world sentinel answered with an explicit false or threw)"
  }
  # Carrier never loaded: the client imports the proxy DLL and the DLL is on disk, so no log at all means
  # the DLL was never executed (blocked, renamed or failed to load). Nothing downstream can be trusted.
  if ([string]$evidence.reason -eq 'proxy-carrier-absent') {
    throw "The proxy carrier DLL never ran for ${CaseName}: injectEvidence.reason=proxy-carrier-absent (the client imports the carrier and the DLL is installed, but the proxy wrote no log, so it was never loaded)"
  }
  # The decisive tier. `verified` alone cannot carry this: it also folds in proxyHook, so a dll-proxy run
  # with a fine hook but an unlanded bundle would still read verified=false for the wrong reason. Testing
  # the two transport counters plus bundleInPage directly is what isolates "chain ran, bundle did not".
  if ($chainRan -and -not $bundleLanded) {
    throw "The page never proved the injected bundle ran for ${CaseName}: endpointReady=$($evidence.endpointReady) pageSessions=$($report.totals.pageSessions) bootstraps=$($report.totals.bootstraps) bundles=$($report.totals.bundles) bundleInPage=$($evidence.bundleInPage) reason=$($evidence.reason) (the CDP chain and the bootstrap acknowledged, but the main-world sentinel never became true)"
  }
  Write-HostDiagnostics
  Write-Host "REAL_CLIENT_INJECTION_PASS $CaseName mode=$InjectMode"
} catch {
  Write-Host "[real-client] FAILED case=$CaseName stage=$stage type=$($_.Exception.GetType().FullName) message=$($_.Exception.Message)"
  # Annotations are readable without job logs, so surface the failing stage and message there too.
  Write-Host ("::error::real-client failed case=$CaseName stage=$stage message=" + $_.Exception.Message)
  try { Save-RunArtifacts -CaseName $CaseName } catch {
    Write-Host "[real-client] artifact collection failed: $($_.Exception.Message)"
  }
  if (-not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) { Write-Host "[real-client] stack=$($_.ScriptStackTrace)" }
  Write-HostDiagnostics
  throw
} finally {
  # Always keep the evidence bundle (screenshots, environment, report, host logs) for CI upload.
  try { Save-RunArtifacts -CaseName $CaseName } catch {
    Write-Host "[real-client] artifact collection failed: $($_.Exception.Message)"
  }
  # Last page-internal frame before the client is killed: this one holds the injected panel, which the
  # WDA_MONITOR protected desktop frame can never show. Best effort - a missing client just skips it.
  try {
    if ($script:cdpPort -gt 0 -and $script:cdpPrefix) {
      $finalShot = Save-CdpPageScreenshot -Port $script:cdpPort -Path ("$($script:cdpPrefix)-" + $script:zh['imageFinal'] + ".png") -TimeoutSeconds 10
      if ($finalShot) {
        Write-Host "[real-client] cdp final screenshot bytes=$($finalShot.Bytes) size=$($finalShot.Width)x$($finalShot.Height) url=$($finalShot.Url)"
      }
    }
  } catch {
    Write-Host "[real-client] cdp final screenshot failed: $($_.Exception.Message)"
  }
  if ($script:captureGuard) {
    $guardEvents = $null
    try {
      if ($script:captureGuardHandle -and $script:captureGuardHandle.IsCompleted) {
        $guardEvents = $script:captureGuard.EndInvoke($script:captureGuardHandle)
      }
    } catch { }
    try { $script:captureGuard.Stop() } catch { }
    try { $script:captureGuard.Dispose() } catch { }
    if ($null -ne $guardEvents) { Write-Host "[real-client] capture guard events=$guardEvents" }
    $script:captureGuard = $null
    $script:captureGuardHandle = $null
  }
  Stop-ClientProcess $clientPath
  Stop-OwnedProcess $hostProcess
  Stop-StartedHost $NativeHost $runStarted
  # The client switches keyboard layouts for its own window; put the operator's input state back.
  try {
    $inputAfter = Get-InputState
    $inputChanges = Compare-InputState -Before $inputState -After $inputAfter
    $restoredInput = Restore-InputState -State $inputState
    if ($env:RUNNER_TEMP) {
      try { $inputAfter | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $env:RUNNER_TEMP ("cx-real-client-$CaseName-" + $script:zh['inputAfter'] + ".json")) -Encoding utf8 } catch { }
    }
    Write-Host "[real-client] input changed=$($inputChanges -join ',') restored=$($restoredInput -join ',') active=$($inputAfter.ActiveLayout)"
  } catch {
    Write-Host "[real-client] input restore failed: $($_.Exception.Message)"
  }
  # Use the same fixed artifact paths as the live snapshot collector. An early failure may never have
  # created either file, and reporting missing evidence must not interrupt the remaining cleanup.
  foreach ($item in @(@{ Source = 'debug.log'; Suffix = ($script:zh['clientDebug'] + '.log') }, @{ Source = 'input.txt'; Suffix = ($script:zh['clientInput'] + '.txt') })) {
    try {
      $snapshot = if ($env:RUNNER_TEMP) { Join-Path $env:RUNNER_TEMP "cx-real-client-$CaseName-$($item.Suffix)" } else { '' }
      if ($snapshot -and (Test-Path -LiteralPath $snapshot -PathType Leaf)) {
        Write-Host "[real-client] client $($item.Source) captured: $((Get-Item -LiteralPath $snapshot).Length) bytes"
      } else {
        Write-Host "[real-client] client $($item.Source) not collected (client never wrote it or it was empty)"
      }
    } catch {
      Write-Host "[real-client] client $($item.Source) snapshot status unavailable: $($_.Exception.Message)"
    }
  }
  # Closing the client can leave Explorer alive without its taskbar; restore the shell before returning.
  try {
    $shell = Repair-ShellDesktop -Force
    Write-Host "[real-client] shell repair action=$($shell.Action) restarted=$($shell.Restarted) tray=$($shell.Tray) owner=$($shell.OwnerPid) old=$($shell.OldPids) manualStart=$($shell.ManualStart) forced=$($shell.Forced)"
  } catch {
    Write-Host "[real-client] shell repair failed: $($_.Exception.Message)"
  }
  Write-Host "[real-client] summary case=$CaseName stage=$stage stopReason=$($report.stopReason) success=$($report.success) pages=$($report.totals.pageSessions) bootstraps=$($report.totals.bootstraps) bundles=$($report.totals.bundles) errors=$($report.totals.errors) probe=$($report.endpointProbe.lastReason)/$($report.endpointProbe.attempts) entry=$($entry.Reason) affinity=$affinitySnapshot hook=$hookLog"
  # Repeated at the end of the run so the yellow state cannot hide between the PASS line and cleanup.
  if ($script:injectVerifiedWarning) { Write-Host "[real-client] WARNING $($script:injectVerifiedWarning)" }
  Save-ArtifactManifest -CaseName $CaseName
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
