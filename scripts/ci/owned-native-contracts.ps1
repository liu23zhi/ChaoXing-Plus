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

function Build-OwnedFixture([string]$Name, [string[]]$Units, [string[]]$ExtraLink = @(), [string[]]$ExtraCompile = @()) {
    $sources = @($Units | ForEach-Object { (Get-Item -LiteralPath (Join-Path $src $_)).FullName })
    $flags = @('/nologo', '/TC', '/utf-8', '/DUNICODE', '/D_UNICODE', '/O1', '/Gy', '/MT', "/Fe:$Name.exe")
    Invoke-Checked "compile $Name (x86)" $cl ($flags + $ExtraCompile + $sources + @(
        '/link', '/INCREMENTAL:NO', '/OPT:REF', '/MACHINE:X86', 'user32.lib', 'gdi32.lib'
    ) + $ExtraLink)
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

    Build-OwnedFixture 'owned-device-admission' @('tests/owned-device-admission-tests.c', 'device-quota.c', 'config-store.c', 'json.c')
    $admission = Join-Path $scratch.FullName 'owned-device-admission.exe'
    Invoke-Checked 'ordinary host current candidate consent' $admission @('--consent-gate')
    Invoke-Checked 'ordinary host admission receipt contract' $admission @()
    Invoke-Checked 'ordinary host admission lost receipt before exit' $admission @('--stage-exit')
    Invoke-Checked 'ordinary host admission cold recovery' $admission @('--reopen')

    Build-OwnedFixture 'ordinary-result-only' @('tests/ordinary-channel-tests.c') @('shell32.lib', 'advapi32.lib')
    Invoke-Checked 'ordinary result-only Win32 runtime' (Join-Path $scratch.FullName 'ordinary-result-only.exe') @()

    Build-OwnedFixture 'ordinary-receipts' @('tests/ordinary-receipts-tests.c', 'memory.c', 'json.c') @(
        '/NODEFAULTLIB', '/SUBSYSTEM:CONSOLE', '/ENTRY:OrdinaryReceiptsTestMain', 'kernel32.lib', 'advapi32.lib'
    ) @('/GS-', '/Gs9999999', '/Zl')
    Invoke-Checked 'ordinary native diagnostic cold replay' (Join-Path $scratch.FullName 'ordinary-receipts.exe') @()

    if ($env:GITHUB_ACTIONS -ceq 'true') {
        if ($env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
            throw 'Real ordinary browser contracts require the disposable hosted Windows runner.'
        }
        Push-Location -LiteralPath $repo
        $oldCwd = [Environment]::CurrentDirectory
        try {
            [Environment]::CurrentDirectory = $repo
            Invoke-Checked 'build the distinct signed-package input variant' $node @('build.mjs', '--ordinary-native')
        } finally {
            [Environment]::CurrentDirectory = $oldCwd
            Pop-Location
        }

        Build-OwnedFixture 'ordinary-browser' @('tests/ordinary-browser-tests.c', 'browser-extension.c', 'json.c') @(
            'shell32.lib', 'advapi32.lib'
        )
        Push-Location -LiteralPath $repo
        try {
            [Environment]::CurrentDirectory = $repo
            Invoke-Checked 'real ordinary Chrome and Edge result-only native channel' $node @(
                'scripts/ci/ordinary-native-browser.mjs', (Join-Path $scratch.FullName 'ordinary-browser.exe')
            )
        } finally {
            [Environment]::CurrentDirectory = $oldCwd
            Pop-Location
        }
    }

    Build-OwnedFixture 'owned-authority' @('tests/owned-script-authority-tests.c')
    Invoke-Checked 'authorization callback stub' (Join-Path $scratch.FullName 'owned-authority.exe') @()

    Build-OwnedFixture 'owned-receipt' @('tests/owned-exam-log-tests.c', 'adapter-account.c', 'json.c')
    Invoke-Checked 'WinHTTP loopback receiver' $node @($receiver, (Join-Path $scratch.FullName 'owned-receipt.exe'))

    Build-OwnedFixture 'silent-entry-tests' @(
        'tests/silent-entry-tests.c', 'net.c', 'process.c', 'discovery.c', 'options.c', 'assets.c',
        'selection.c', 'session.c', 'audit.c', 'config-store.c', 'diagnostics.c', 'elevation.c',
        'dpi.c', 'silent.c', 'purge.c', 'wipe.c', 'browser-extension.c', 'browser-session.c',
        'adapter-account.c', 'account-window.c', 'device-quota.c', 'script-lease.c', 'json.c', 'memory.c'
    ) @('/SUBSYSTEM:WINDOWS', '/ENTRY:SilentEntryTestMain', 'kernel32.lib', 'shell32.lib', 'comdlg32.lib', 'ws2_32.lib',
        'advapi32.lib', 'iphlpapi.lib', 'version.lib')
    $previousSilentEntry = $env:CX_NATIVE_SILENT_ENTRY_EXE
    try {
        $env:CX_NATIVE_SILENT_ENTRY_EXE = Join-Path $scratch.FullName 'silent-entry-tests.exe'
        Push-Location -LiteralPath $repo
        try { Invoke-Checked 'real silent CMD and actual HWND lifecycle' $node @('--test', 'scripts/windows-native-silent-entry.test.mjs') }
        finally { Pop-Location }
    } finally { $env:CX_NATIVE_SILENT_ENTRY_EXE = $previousSilentEntry }
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
Write-Host 'PASS: owned native contracts and real silent-entry lifecycle ran on Windows x86.'
