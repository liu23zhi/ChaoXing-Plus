#requires -Version 7.2
# Windows x86 checks for owned components only. No launcher build or test discovery.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false  # Propagate the original exit code below.
if (-not $IsWindows) { throw 'The owned native contracts require a Windows runner.' }

function Invoke-Checked([string]$Stage, [string]$Program, [string[]]$Arguments) {
    Write-Host "[$Stage]"
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        $code = $LASTEXITCODE
        [Console]::Error.WriteLine("[$Stage] exited with code $code")
        exit $code
    }
}

$repo = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '../..')).FullName
$src = Join-Path $repo 'windows/native-source'
$receiver = (Get-Item -LiteralPath (Join-Path $repo 'scripts/owned-exam-log-receiver.mjs')).FullName
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not $vs) { throw 'Visual Studio with the MSVC x86/x64 tools and Windows SDK is required.' }
& (Join-Path $vs 'Common7/Tools/Launch-VsDevShell.ps1') -VsInstallationPath $vs -Arch x86 -HostArch amd64 -SkipAutomaticLocation
if ($env:VSCMD_ARG_TGT_ARCH -ne 'x86') { throw 'Failed to initialize MSVC for x86.' }
$cl = (Get-Command cl.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

function Build-OwnedFixture([string]$Name, [string[]]$Units) {
    $sources = @($Units | ForEach-Object { (Get-Item -LiteralPath (Join-Path $src $_)).FullName })
    $flags = @('/nologo', '/TC', '/utf-8', '/O1', '/Gy', '/MT', "/Fe:$Name.exe")
    Invoke-Checked "compile $Name (x86)" $cl ($flags + $sources + @(
        '/link', '/INCREMENTAL:NO', '/OPT:REF', '/MACHINE:X86', 'user32.lib', 'gdi32.lib'
    ))
}

$tempRoot = (Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName.TrimEnd('\')
$name = 'cx-owned-native-' + [Guid]::NewGuid().ToString('N')
$scratch = New-Item -ItemType Directory -Path (Join-Path $tempRoot $name)
$previousDirectory = [Environment]::CurrentDirectory
$passed = $false
Push-Location -LiteralPath $scratch.FullName
try {
    Build-OwnedFixture 'owned-quota' @('tests/owned-device-quota-tests.c', 'device-quota.c', 'config-store.c', 'json.c')
    Invoke-Checked 'device quota' (Join-Path $scratch.FullName 'owned-quota.exe') @()

    Build-OwnedFixture 'owned-authority' @('tests/owned-script-authority-tests.c')
    Invoke-Checked 'authorization callback stub' (Join-Path $scratch.FullName 'owned-authority.exe') @()

    Build-OwnedFixture 'owned-receipt' @('tests/owned-exam-log-tests.c', 'adapter-account.c', 'json.c')
    Invoke-Checked 'WinHTTP loopback receiver' $node @($receiver, (Join-Path $scratch.FullName 'owned-receipt.exe'))
    $passed = $true
} finally {
    Pop-Location
    [Environment]::CurrentDirectory = $previousDirectory
    try {
        $actual = Get-Item -LiteralPath $scratch.FullName
        if ($actual.Parent.FullName -ne $tempRoot -or $actual.Name -ne $name -or
            ($actual.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to remove an unexpected scratch directory: $($actual.FullName)"
        }
        for ($attempt = 1; ; $attempt++) {
            try { Remove-Item -LiteralPath $actual.FullName -Recurse -Force; break }
            catch [IO.IOException] {
                if ($attempt -eq 5) { throw }
                Start-Sleep -Milliseconds 200
            }
        }
    } catch {
        if ($passed) { throw }
        # A cleanup error must not replace the failed compiler/fixture's status.
        [Console]::Error.WriteLine("Scratch cleanup: $_")
    }
}
Write-Host 'PASS: all three owned native contracts ran on Windows x86.'
