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
$hostProcess = $null

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

try {
  if (-not (Test-Path -LiteralPath $ClientInstaller -PathType Leaf)) { throw "Client fixture is missing: $ClientInstaller" }
  if (-not (Test-Path -LiteralPath $NativeHost -PathType Leaf)) { throw "Native host is missing: $NativeHost" }
  New-Item -ItemType Directory -Path $packageRoot, $databaseRoot -Force | Out-Null

  $sevenZip = Find-SevenZip
  & $sevenZip x $ClientInstaller ("-o" + $packageRoot) '-y' '-bd' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to unpack client fixture (7z exit $LASTEXITCODE)" }

  $clients = @(Get-ChildItem -LiteralPath $packageRoot -Filter 'CXExam.exe' -Recurse -File)
  if ($clients.Count -ne 1) { throw "Expected exactly one CXExam.exe after unpacking, found $($clients.Count)" }
  $client = $clients[0]
  $clientDirectory = $client.DirectoryName

  $base64 = ($DatabaseBase64 -replace '\s', '')
  if ([string]::IsNullOrWhiteSpace($base64)) { throw 'Database variable is empty' }
  [IO.File]::WriteAllBytes($databaseZip, [Convert]::FromBase64String($base64))
  Expand-Archive -LiteralPath $databaseZip -DestinationPath $databaseRoot -Force
  $databases = @(Get-ChildItem -LiteralPath $databaseRoot -Filter 'UserExamInfo.db' -Recurse -File)
  if ($databases.Count -ne 1) { throw "Expected exactly one UserExamInfo.db in database archive, found $($databases.Count)" }
  if ($databases[0].Length -le 0) { throw 'Decoded UserExamInfo.db is empty' }
  Copy-Item -LiteralPath $databases[0].FullName -Destination (Join-Path $clientDirectory 'UserExamInfo.db') -Force

  $arguments = @(
    '--inject-mode', $InjectMode,
    '--client', $client.FullName,
    '--report', $reportPath,
    '--duration', '30000',
    '--no-log',
    '--no-diagnose',
    '--stop-client-on-exit',
    '--quiet'
  )
  $hostProcess = Start-Process -FilePath $NativeHost -ArgumentList $arguments -PassThru -WindowStyle Hidden
  if (-not $hostProcess.WaitForExit(60000)) {
    Stop-OwnedProcess $hostProcess
    throw "Native host timed out for $CaseName"
  }
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw "Native host did not write a report for $CaseName (exit $($hostProcess.ExitCode))"
  }
  $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  if (-not $report.success) { throw "Injection report is not successful for $CaseName" }
  if (-not $report.ownershipVerified) { throw "Client ownership was not verified for $CaseName" }
  if ([int]$report.pageSessions -lt 1) { throw "No page session was injected for $CaseName" }
  if ([int]$report.bootstraps -lt 1) { throw "No bootstrap was injected for $CaseName" }
  if ([int]$report.bundles -lt 1) { throw "No bundle was injected for $CaseName" }
  if ($report.stopReason -ne 'duration') { throw "Unexpected stop reason for ${CaseName}: $($report.stopReason)" }
  Write-Host "REAL_CLIENT_INJECTION_PASS $CaseName mode=$InjectMode"
} finally {
  Stop-OwnedProcess $hostProcess
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
