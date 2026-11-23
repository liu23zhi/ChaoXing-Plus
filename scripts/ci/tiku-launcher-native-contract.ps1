#requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$TiKuHelperRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if (-not $IsWindows) { throw 'This contract executes the Windows native parser.' }
$pinned = '724b497a03ad6b8d27377cd437e440007de70341'
$repo = (Get-Item -LiteralPath (Join-Path $PSScriptRoot '../..')).FullName
$service = (Get-Item -LiteralPath $TiKuHelperRoot).FullName
$head = & git -C $service rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head.Trim() -ne $pinned) { throw 'The TiKuHelper checkout must be the CI-pinned revision.' }

function Invoke-Checked([string]$Stage, [string]$Program, [string[]]$Arguments) {
    Write-Host "[$Stage]"
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Stage failed (exit $LASTEXITCODE)." }
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $vs) { throw 'MSVC x86 and Windows SDK are required.' }
& (Join-Path $vs 'Common7/Tools/Launch-VsDevShell.ps1') -VsInstallationPath $vs -Arch x86 -HostArch amd64 -SkipAutomaticLocation
if ($env:VSCMD_ARG_TGT_ARCH -ne 'x86') { throw 'Failed to initialize MSVC x86.' }

$tempRoot = (Get-Item -LiteralPath ([IO.Path]::GetTempPath())).FullName.TrimEnd('\')
$name = 'cx-tiku-launcher-' + [Guid]::NewGuid().ToString('N')
$scratch = New-Item -ItemType Directory -Path (Join-Path $tempRoot $name)
$oldOutput = $env:CX_TIKU_LAUNCHER_OUTPUT
$oldGoEnv = $env:GOENV
$oldGoWork = $env:GOWORK
$pass = $false
Push-Location -LiteralPath $scratch.FullName
try {
    $archive = Join-Path $scratch.FullName 'service.tar'
    Invoke-Checked 'archive tracked service sources' git @('-C', $service, 'archive', '--format=tar', '-o', $archive, $pinned,
        'go.mod', 'go.sum', 'configs/config.go', 'internal', 'pkg')
    Invoke-Checked 'extract isolated service' tar @('-xf', $archive, '-C', $scratch.FullName)
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'tiku-launcher.fixture.go') -Destination (Join-Path $scratch.FullName 'internal/controller/chaoxing_launcher_external_test.go')
    $env:CX_TIKU_LAUNCHER_OUTPUT = $scratch.FullName
    $env:GOENV = 'off'
    $env:GOWORK = 'off'
    # Parse the JSON event stream so no-match/skipped Go tests cannot pass this gate.
    $events = & go test -json -mod=readonly -count=1 -timeout=2m -run '^TestChaoXingGeneratedPS1Contract$' ./internal/controller
    if ($LASTEXITCODE -ne 0) { $events | Write-Host; throw 'The actual TiKuHelper PS1 generation contract failed.' }
    $events = @($events | ForEach-Object { $_ | ConvertFrom-Json })
    foreach ($test in @('TestChaoXingGeneratedPS1Contract/legacy', 'TestChaoXingGeneratedPS1Contract/escrow', 'TestChaoXingGeneratedPS1Contract')) {
        if (-not ($events | Where-Object { $_.Action -eq 'pass' -and $_.PSObject.Properties['Test'] -and $_.Test -eq $test })) {
            throw "The required generator test did not run and pass: $test"
        }
    }

    $src = Join-Path $repo 'windows/native-source'
    # Link the host's real dependencies. The fixture calls only startup parsing;
    # no host main, UI, browser, download or external-client entry is invoked.
    $units = @('tests/tiku-launcher-contract-tests.c', 'json.c', 'net.c', 'process.c', 'discovery.c', 'options.c',
        'assets.c', 'selection.c', 'session.c', 'audit.c', 'config-store.c', 'device-quota.c', 'diagnostics.c',
        'elevation.c', 'dpi.c', 'silent.c', 'purge.c', 'wipe.c', 'browser-extension.c', 'browser-session.c',
        'adapter-account.c', 'account-window.c', 'script-lease.c', 'home.c') | ForEach-Object { Join-Path $src $_ }
    Invoke-Checked 'compile real native bootstrap and URL parser (x86)' cl.exe (@('/nologo', '/TC', '/utf-8', '/DUNICODE', '/D_UNICODE', '/O1', '/Gy', '/MT', '/Fe:tiku-launcher-contract.exe') + $units + @(
        '/link', '/INCREMENTAL:NO', '/OPT:REF', '/MACHINE:X86', 'user32.lib', 'gdi32.lib', 'shell32.lib',
        'comdlg32.lib', 'ws2_32.lib', 'advapi32.lib', 'iphlpapi.lib', 'version.lib'
    ))
    foreach ($mode in @('legacy', 'escrow')) {
        $ps1 = Get-Content -LiteralPath (Join-Path $scratch.FullName "$mode.ps1") -Raw -Encoding UTF8
        $expected = Get-Content -LiteralPath (Join-Path $scratch.FullName "$mode.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        $parseTokens = $null
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($ps1, [ref]$parseTokens, [ref]$parseErrors)
        if ($parseErrors.Count) { throw 'Generated PS1 has PowerShell parse errors.' }
        $assignments = @($ast.FindAll({ param($node)
            $node -is [Management.Automation.Language.AssignmentStatementAst] -and
            $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
            $node.Left.VariablePath.UserPath -eq 'env:CXPLUS_SCRIPT_BOOTSTRAP_B64'
        }, $true))
        if ($assignments.Count -ne 1) { throw 'Actual PS1 must assign one bootstrap environment value.' }
        # Evaluate only the literal assignment value. Never execute generated PS1,
        # download a binary, launch a client, or trust executable test input.
        $literal = @($assignments[0].Right.FindAll({ param($node)
            $node -is [Management.Automation.Language.StringConstantExpressionAst]
        }, $true))
        if ($literal.Count -ne 1) { throw 'Bootstrap must contain one literal Base64 string.' }
        $bootstrap = $literal[0].Value
        if ($assignments[0].Right.Extent.Text.Trim() -ne "'$bootstrap'") { throw 'Dynamic bootstrap expressions are not permitted.' }
        $null = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($bootstrap)) | ConvertFrom-Json
        $env:CXPLUS_SCRIPT_BOOTSTRAP_B64 = $bootstrap
        $env:CX_EXPECTED_ACTIVATION = $expected.activation
        $env:CX_EXPECTED_ORIGIN = $expected.origin
        $env:CX_EXPECTED_SESSION = $expected.sessionURL
        $env:CX_EXPECTED_COMMAND = $expected.command
        $env:CX_EXPECTED_COMMAND_URL = $expected.commandURL
        $env:CX_EXPECTED_MANAGED = $expected.managed.ToString().ToLowerInvariant()
        Invoke-Checked "$mode PS1 -> actual native consumer" (Join-Path $scratch.FullName 'tiku-launcher-contract.exe') @()
    }
    $pass = $true
} finally {
    foreach ($key in @('CXPLUS_SCRIPT_BOOTSTRAP_B64', 'CX_EXPECTED_ACTIVATION', 'CX_EXPECTED_ORIGIN', 'CX_EXPECTED_SESSION', 'CX_EXPECTED_COMMAND', 'CX_EXPECTED_COMMAND_URL', 'CX_EXPECTED_MANAGED')) {
        [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    $env:CX_TIKU_LAUNCHER_OUTPUT = $oldOutput
    $env:GOENV = $oldGoEnv
    $env:GOWORK = $oldGoWork
    Pop-Location
    try {
        $actual = Get-Item -LiteralPath $scratch.FullName
        if ($actual.Parent.FullName -ne $tempRoot -or $actual.Name -ne $name -or ($actual.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Refusing to remove an unexpected temporary directory.'
        }
        Remove-Item -LiteralPath $actual.FullName -Recurse -Force
    } catch {
        if ($pass) { throw }
        [Console]::Error.WriteLine("Scratch cleanup: $_")
    }
}
Write-Host 'PASS: real TiKuHelper PS1 -> ChaoXing native bootstrap, authorization preservation and URL/PowerShell extraction.'
