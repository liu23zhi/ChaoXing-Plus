[CmdletBinding()]
param([switch] $RequireBrowsers)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$bin = Join-Path $root 'windows\native-build\bin'

function Get-CommandPath([string] $name) {
  $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  return $null
}

function Resolve-Browser([string[]] $candidates) {
  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

function Set-CiEnvironment([string] $name, [string] $value) {
  if ([string]::IsNullOrWhiteSpace($env:GITHUB_ENV)) { return }
  "$name=$value" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}

$executables = [ordered]@{
  CX_DISCOVERY_TEST_DRIVER = 'discovery-cache-driver.exe'
  CX_NATIVE_SILENT_EXE = 'silent-tests.exe'
  CX_NATIVE_HOST_EXE = 'chaoxing_plus.exe'
  CX_NATIVE_INJECTION_EXE = 'injection-tests.exe'
  CX_NATIVE_ASSETS_EXE = 'assets-tests.exe'
  CX_NATIVE_OPTIONS_EXE = 'options-tests.exe'
  CX_NATIVE_SESSION_EXE = 'session-tests.exe'
  CX_NATIVE_SELECTION_EXE = 'selection-tests.exe'
  CX_NATIVE_TRANSPORT_EXE = 'transport-tests.exe'
  CX_NATIVE_AUDIT_EXE = 'audit-tests.exe'
  CX_NATIVE_CONFIG_EXE = 'config-store-tests.exe'
  CX_NATIVE_CACHE_EXE = 'discovery-cache-driver.exe'
  CX_NATIVE_CACHE_HOST_EXE = 'discovery-cache-host-tests.exe'
  CX_NATIVE_CLI_SELECTION_EXE = 'cli-selection-tests.exe'
  CX_NATIVE_ELEVATION_EXE = 'elevation-tests.exe'
  CX_NATIVE_ELEVATION_HOST_EXE = 'elevation-host-tests.exe'
  CX_NATIVE_DPI_EXE = 'dpi-tests.exe'
  CX_NATIVE_DPI_PROCESS_EXE = 'dpi-process-tests.exe'
  CX_NATIVE_DPI_CHILD_EXE = 'dpi-child.exe'
  CX_NATIVE_PROCESS_CHECK_EXE = 'process-check-tests.exe'
  CX_NATIVE_PROCESS_FIXTURE_EXE = 'process-fixture.exe'
  CX_NATIVE_DIAGNOSTICS_EXE = 'diagnostics-tests.exe'
  CX_NATIVE_HOME_EXE = 'home-tests.exe'
  CX_NATIVE_EXTENSION_CACHE_EXE = 'extension-cache-tests.exe'
  CX_NATIVE_ADAPTER_EXE = 'adapter-account-tests.exe'
  CX_NATIVE_ACCOUNT_WINDOW_EXE = 'account-window-tests.exe'
  CX_NATIVE_BROWSER_SESSION_EXE = 'browser-session-tests.exe'
  CX_NATIVE_MULTI_HOST_EXE = 'multi-file\chaoxing_plus.exe'
  CX_NATIVE_CONSOLE_HELPER_EXE = 'multi-file\chaoxing_plus.com'
  CX_NATIVE_PACKAGE_LAUNCHER_EXE = 'multi-file\package-to-single\chaoxing_plus.exe'
  CX_NATIVE_MULTI_ASSETS_EXE = 'multi-assets-tests.exe'
  CX_NATIVE_CONSOLE_HELPER_FIXTURE_EXE = 'console-helper-fixture.exe'
}

foreach ($entry in $executables.GetEnumerator()) {
  $path = Join-Path $bin $entry.Value
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing native test artifact: $path" }
  Set-CiEnvironment $entry.Key (Resolve-Path -LiteralPath $path).Path
}
Set-CiEnvironment 'CX_BROWSER_DEPENDENCIES' $root

$programFiles = [Environment]::GetEnvironmentVariable('ProgramFiles')
$programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
$edge = Resolve-Browser @(
  $env:CX_BROWSER_EDGE_PATH,
  (Get-CommandPath 'msedge.exe'),
  $(if ($programFilesX86) { Join-Path $programFilesX86 'Microsoft\Edge\Application\msedge.exe' }),
  $(if ($programFiles) { Join-Path $programFiles 'Microsoft\Edge\Application\msedge.exe' }),
  $(if ($localAppData) { Join-Path $localAppData 'Microsoft\Edge\Application\msedge.exe' })
)
$chrome = Resolve-Browser @(
  $env:CX_BROWSER_CHROME_PATH,
  (Get-CommandPath 'chrome.exe'),
  $(if ($programFilesX86) { Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe' }),
  $(if ($programFiles) { Join-Path $programFiles 'Google\Chrome\Application\chrome.exe' }),
  $(if ($localAppData) { Join-Path $localAppData 'Google\Chrome\Application\chrome.exe' })
)
if ($RequireBrowsers -and -not $edge) { throw 'Microsoft Edge is required but was not found' }
if ($RequireBrowsers -and -not $chrome) { throw 'Google Chrome is required but was not found' }
if ($edge) {
  Set-CiEnvironment 'CX_BROWSER_EDGE_PATH' $edge
  Set-CiEnvironment 'CI_EDGE_PATH' $edge
  Write-Host "Edge: $edge"
}
if ($chrome) {
  Set-CiEnvironment 'CX_BROWSER_CHROME_PATH' $chrome
  Set-CiEnvironment 'CX_BROWSER_EXECUTABLE' $chrome
  Set-CiEnvironment 'CI_CHROME_PATH' $chrome
  Write-Host "Chrome: $chrome"
}
