# Exercise the actual wrapper on tracked first-party fixtures; never run a build product.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$wrapper = Join-Path $PSScriptRoot 'windows-build-entry.ps1'
$legacyPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$git = (Get-Command git.exe -CommandType Application -TotalCount 1).Source
$root = Join-Path $env:RUNNER_TEMP ("cx-entry-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$fake = Join-Path $root 'fake'
$runs = Join-Path $root 'runs'
$envNames = @('GITHUB_WORKSPACE', 'RUNNER_TEMP', 'GITHUB_STEP_SUMMARY', 'CX_FIXTURE_SCENARIO', 'CX_CI_SKIP_BUILD_PAUSE')
$oldEnv = @{}
foreach ($name in $envNames) { $oldEnv[$name] = [Environment]::GetEnvironmentVariable($name) }
New-Item -ItemType Directory -Path $fake, $runs -Force | Out-Null

function Write-Fixture([string]$Path, [string]$Body) {
    New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force | Out-Null
    [IO.File]::WriteAllText($Path, ($Body -replace '\r\n', [string][char]10) + [char]10)
}

function Assert-Result([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Pause([string]$Mode, [bool]$Stub, [int]$Expected) {
    $tokens = $errors = $null
    $nativeScript = Join-Path $repoRoot 'windows/native-source/build-windows.ps1'
    $ast = [Management.Automation.Language.Parser]::ParseFile($nativeScript, [ref]$tokens, [ref]$errors)
    Assert-Result (-not $errors) 'The checked-in host build script must parse.'
    $body = '$ErrorActionPreference = ''Stop''' + [char]10
    if ($Stub) { $body += 'function pause { Write-Output "PAUSE-DEFAULT" }' + [char]10 }
    $body += $ast.EndBlock.Statements[-1].Extent.Text + [char]10 + 'Write-Output "AFTER-PAUSE"'
    $path = Join-Path $root 'verify-pause.ps1'
    Write-Fixture $path $body
    $env:CX_CI_SKIP_BUILD_PAUSE = $Mode
    $out = & $legacyPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $path 2>&1 | Out-String
    $exit = $LASTEXITCODE
    Write-Host "PowerShell 5.1 pause: mode='$Mode', stub=$Stub, exit=$exit"
    Assert-Result ($exit -eq $Expected) "Pause branch returned $exit instead of $Expected. $out"
    Assert-Result ($out.Contains('AFTER-PAUSE') -eq ($Expected -eq 0)) "Wrong completion marker. $out"
    if ($Stub) {
        Assert-Result ($out.Contains('PAUSE-DEFAULT') -eq ($Mode -ne '1')) "The default prompt changed. $out"
    } elseif ($Expected) {
        Assert-Result ($out -match 'Read-Host') "Expected the actual NonInteractive pause failure. $out"
    }
}

$failures = @()
try {
    try {
        Assert-Pause '1' $false 0
        Assert-Pause '' $false 1
        Assert-Pause '' $true 0
        Assert-Pause '0' $true 0
    } catch {
        $failures += "pause: $_"
    }

    $env:GITHUB_WORKSPACE = $fake
    $env:RUNNER_TEMP = $runs
    $env:GITHUB_STEP_SUMMARY = $null
    Write-Fixture (Join-Path $fake 'package.json') '{"name":"ci-fixture","version":"1.0.0","scripts":{"build:windows":"node -e \"console.log(123)\" --"}}'
    Write-Fixture (Join-Path $fake 'package-lock.json') '{"name":"ci-fixture","lockfileVersion":3,"packages":{}}'
    Write-Fixture (Join-Path $fake 'node_modules/marker.txt') 'fixture input'
    Write-Fixture (Join-Path $fake 'windows/native-source/build-windows.cmd') @'
@echo off
if "%~1"=="--help" exit /b 0
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File windows/native-source/build-windows.ps1
if errorlevel 1 exit /b %ERRORLEVEL%
pause
exit /b 0
'@
    Write-Fixture (Join-Path $fake 'windows/native-source/build-windows.sh') @'
#!/bin/bash
set -e
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File windows/native-source/build-windows.ps1
'@
    Write-Fixture (Join-Path $fake 'windows/native-source/build-windows.ps1') @'
param([string]$OutputDirectory, [switch]$BuildConsole)
if ($env:CX_FIXTURE_SCENARIO -eq 'with-ci-switch' -and $env:CX_CI_SKIP_BUILD_PAUSE -cne '1') { exit 91 }
& ./fixture-build.ps1 native
exit $LASTEXITCODE
'@
    Write-Fixture (Join-Path $fake 'windows/hook-source/build-proxy.ps1') @'
& ./fixture-build.ps1 proxy
exit $LASTEXITCODE
'@
    Write-Fixture (Join-Path $fake 'fixture-build.ps1') @'
param($Kind)
$ErrorActionPreference = 'Stop'
if ($env:CX_FIXTURE_SCENARIO -eq 'exit23') { exit 23 }
if ($env:CX_FIXTURE_SCENARIO -eq 'missing') { exit 0 }
function Make-Output($Name) {
    $path = Join-Path $PWD "windows/native-build/$Name"
    New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent) | Out-Null
    [IO.File]::WriteAllText($path, 'compiled in the fixture')
}
Make-Output 'hook/winmm.dll'
Make-Output 'hook/tests/proxy-test.exe'
if ($Kind -eq 'native') {
    'bin/chaoxing_plus.exe',
    'bin/multi-file/chaoxing_plus.exe',
    'bin/multi-file/chaoxing_plus.com',
    'bin/multi-file/package-to-single/chaoxing_plus.exe',
    'release/single-file/chaoxing_plus.exe',
    'release/multi-file/chaoxing_plus.exe',
    'release/multi-file/chaoxing_plus.com',
    'release/multi-file/package-to-single/chaoxing_plus.exe' | ForEach-Object { Make-Output $_ }
}
if ($env:CX_FIXTURE_SCENARIO -eq 'empty') {
    [IO.File]::WriteAllBytes((Join-Path $PWD 'windows/native-build/hook/winmm.dll'), [byte[]]@())
}
exit 0
'@
    # Seed the fixture repository with stale non-empty tracked output at every expected path.
    $env:CX_FIXTURE_SCENARIO = $null
    Push-Location -LiteralPath $fake
    try {
        & $legacyPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./fixture-build.ps1 native
        Assert-Result ($LASTEXITCODE -eq 0) 'Fixture failed to seed tracked outputs.'
    } finally { Pop-Location }
    & $git -C $fake init -q
    Assert-Result ($LASTEXITCODE -eq 0) 'Fixture git init failed.'
    & $git -C $fake -c core.autocrlf=false add -- package.json package-lock.json fixture-build.ps1 windows
    Assert-Result ($LASTEXITCODE -eq 0) 'Fixture git add failed.'
    & $git -C $fake -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false -c core.hooksPath=NUL commit -qm fixture
    Assert-Result ($LASTEXITCODE -eq 0) 'Fixture git commit failed.'

    foreach ($entry in @('windows/native-source/build-windows.cmd', 'windows/native-source/build-windows.ps1',
            'windows/native-source/build-windows.sh', 'windows/hook-source/build-proxy.ps1')) {
        $cases = [ordered]@{ missing = 1; empty = 1; 'with-ci-switch' = 0; exit23 = 23 }
        foreach ($case in $cases.Keys) {
            $env:CX_FIXTURE_SCENARIO = $case
            $env:CX_CI_SKIP_BUILD_PAUSE = 'inherited-test-value'
            $output = & $wrapper -Entry $entry | Out-String
            $exit = $LASTEXITCODE
            $facts = Get-Content -LiteralPath (Join-Path $runs "windows-build-logs/$(Split-Path $entry -Leaf)/result.txt")
            $phase = $facts | Where-Object { $_ -like 'phase=*' }
            $expected = $cases[$case]
            Write-Host "$entry $case exit=$exit $phase"
            if ($exit -ne $expected -or $facts -notcontains "exit=$expected" -or $env:CX_CI_SKIP_BUILD_PAUSE -ne 'inherited-test-value') {
                $failures += "$entry ($case): expected exit $expected and restoration of caller state; got $exit. $output"
            }
            if ($case -in @('missing', 'empty') -and ($phase -ne 'phase=outputs' -or $facts -notcontains 'native_exit=0')) {
                $failures += "$entry ($case): an exit-0 command must fail at the output verification phase."
            }
        }
    }
    if ($failures) { throw ($failures -join [Environment]::NewLine) }
    Write-Host 'Windows build entry gate checks passed.'
} finally {
    foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $oldEnv[$name]) }
}

# The last fixture deliberately exits 23; report the assertion suite's own success to Actions.
exit 0
