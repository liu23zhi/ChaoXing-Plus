[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $ClientInstaller,
  [Parameter(Mandatory = $true)] [ValidateSet('cdp-port', 'dll-proxy')] [string] $InjectMode,
  [Parameter(Mandatory = $true)] [string] $DatabaseBase64,
  [Parameter(Mandatory = $true)] [string] $NativeHost,
  [Parameter(Mandatory = $true)] [string] $CaseName
)

$ErrorActionPreference = 'Stop'
$tempRoot = Join-Path $env:RUNNER_TEMP ("cx-real-client-" + [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $tempRoot 'package'
$databaseRoot = Join-Path $tempRoot 'database'
$databaseZip = Join-Path $tempRoot 'database.zip'
$reportPath = Join-Path $tempRoot 'report.json'
$stdoutPath = Join-Path $tempRoot 'native-host.stdout.log'
$stderrPath = Join-Path $tempRoot 'native-host.stderr.log'
$hostProcess = $null
$base64 = ''
$stage = 'initialize'

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
  if (-not (Test-Path -LiteralPath $ClientInstaller -PathType Leaf)) { throw "Client fixture is missing: $ClientInstaller" }
  if (-not (Test-Path -LiteralPath $NativeHost -PathType Leaf)) { throw "Native host is missing: $NativeHost" }
  New-Item -ItemType Directory -Path $packageRoot, $databaseRoot -Force | Out-Null

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
  Write-Host "[real-client] extracted client=$($client.FullName) bytes=$($client.Length)"

  $stage = 'decode-database'
  $base64 = ($DatabaseBase64 -replace '\s', '')
  if ([string]::IsNullOrWhiteSpace($base64)) { throw 'Database variable is empty' }
  [IO.File]::WriteAllBytes($databaseZip, [Convert]::FromBase64String($base64))
  Write-Host "[real-client] database archive decoded bytes=$((Get-Item -LiteralPath $databaseZip).Length)"

  $stage = 'extract-database'
  Expand-Archive -LiteralPath $databaseZip -DestinationPath $databaseRoot -Force
  $databases = @(Get-ChildItem -LiteralPath $databaseRoot -Filter 'UserExamInfo.db' -Recurse -File)
  if ($databases.Count -ne 1) { throw "Expected exactly one UserExamInfo.db in database archive, found $($databases.Count)" }
  if ($databases[0].Length -le 0) { throw 'Decoded UserExamInfo.db is empty' }
  Write-Host "[real-client] database file matched=$($databases[0].FullName) bytes=$($databases[0].Length)"

  $stage = 'install-database'
  Copy-Item -LiteralPath $databases[0].FullName -Destination (Join-Path $clientDirectory 'UserExamInfo.db') -Force
  Write-Host "[real-client] database copied into client directory"

  $arguments = @(
    '--inject-mode', $InjectMode,
    '--client', $client.FullName,
    '--report', $reportPath,
    '--duration', '30000',
    '--no-log',
    '--no-diagnose',
    '--stop-client-on-exit'
  )
  $stage = 'start-native-host'
  Write-Host "[real-client] stage=$stage host=$NativeHost client=$($client.FullName)"
  $hostProcess = Start-Process -FilePath $NativeHost -ArgumentList $arguments -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  Write-Host "[real-client] native host started pid=$($hostProcess.Id)"

  $stage = 'wait-native-host'
  if (-not $hostProcess.WaitForExit(60000)) {
    Stop-OwnedProcess $hostProcess
    throw "Native host timed out for $CaseName"
  }
  Write-Host "[real-client] native host exited code=$($hostProcess.ExitCode)"

  $stage = 'read-report'
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw "Native host did not write a report for $CaseName (exit $($hostProcess.ExitCode))"
  }
  $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  Write-Host "[real-client] report success=$($report.success) ownershipVerified=$($report.ownershipVerified) pageSessions=$($report.pageSessions) bootstraps=$($report.bootstraps) bundles=$($report.bundles) stopReason=$($report.stopReason)"

  $stage = 'validate-report'
  if (-not $report.success) { throw "Injection report is not successful for $CaseName" }
  if (-not $report.ownershipVerified) { throw "Client ownership was not verified for $CaseName" }
  if ([int]$report.pageSessions -lt 1) { throw "No page session was injected for $CaseName" }
  if ([int]$report.bootstraps -lt 1) { throw "No bootstrap was injected for $CaseName" }
  if ([int]$report.bundles -lt 1) { throw "No bundle was injected for $CaseName" }
  if ($report.stopReason -ne 'duration') { throw "Unexpected stop reason for ${CaseName}: $($report.stopReason)" }
  Write-HostDiagnostics
  Write-Host "REAL_CLIENT_INJECTION_PASS $CaseName mode=$InjectMode"
} catch {
  Write-Host "[real-client] FAILED case=$CaseName stage=$stage type=$($_.Exception.GetType().FullName) message=$($_.Exception.Message)"
  if (-not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) { Write-Host "[real-client] stack=$($_.ScriptStackTrace)" }
  Write-HostDiagnostics
  throw
} finally {
  Stop-OwnedProcess $hostProcess
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
