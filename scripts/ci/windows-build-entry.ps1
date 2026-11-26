# Run exactly one existing entry in a fresh, tracked-source-only Windows copy.
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet(
        'windows/native-source/build-windows.cmd',
        'windows/native-source/build-windows.ps1',
        'windows/native-source/build-windows.sh',
        'windows/hook-source/build-proxy.ps1'
    )]
    [string]$Entry
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$id = Split-Path $Entry -Leaf
$logs = Join-Path $env:RUNNER_TEMP "windows-build-logs/$id"
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$log = Join-Path $logs 'build.log'
Set-Content -LiteralPath $log -Value "entry=$Entry"
$phase = 'environment'
$exitCode = 1
$status = 'failed'
$script:nativeExit = $null

function Write-Log([string]$Line) {
    $Line | Tee-Object -FilePath $log -Append
}

function Invoke-Logged([string]$Exe, [string[]]$Arguments) {
    $script:nativeExit = $null
    Write-Log "command: $Exe $($Arguments -join ' ')"
    & $Exe @Arguments 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -FilePath $log -Append
    $script:nativeExit = $LASTEXITCODE
    Write-Log "exit=$script:nativeExit"
    if ($script:nativeExit -ne 0) {
        throw "Command exited $script:nativeExit ($phase): $Exe"
    }
}

try {
    if (-not $IsWindows) { throw 'The build validation requires PowerShell 7 on Windows.' }
    Write-Log "runner=$env:ImageOS image=$env:ImageVersion os=$([Environment]::OSVersion.VersionString) pwsh=$($PSVersionTable.PSVersion)"
    $git = (Get-Command git.exe -CommandType Application -TotalCount 1).Source
    $cmd = Join-Path $env:SystemRoot 'System32/cmd.exe'
    $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    foreach ($name in @('node.exe', 'npm.cmd')) {
        $tool = Get-Command $name -CommandType Application -TotalCount 1 -ErrorAction SilentlyContinue
        try {
            if (-not $tool) { throw "$name not found on PATH." }
            Invoke-Logged $tool.Source @('--version')
            if ($name -eq 'npm.cmd') { $npm = $tool.Source }
        } catch {
            if ($id -ne 'build-proxy.ps1') { throw }
            Write-Log "Diagnostic only (the proxy entry does not need $name): $_"
            $script:nativeExit = $null
        }
    }
    $nativeCompiler = Get-ChildItem -Path 'C:\Program Files\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x86\cl.exe' -File -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($nativeCompiler) {
        Write-Log "native MSVC x86 (build-windows.ps1 search): $($nativeCompiler.FullName)"
    } else {
        Write-Log "MSVC x86 not found in the location searched by build-windows.ps1."
    }
    $vswhere = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio/Installer/vswhere.exe'
    try {
        if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'vswhere.exe not found.' }
        Invoke-Logged $vswhere @('-latest', '-products', '*', '-property', 'installationPath')
    } catch {
        Write-Log "Visual Studio inventory diagnostic: $_"
        $script:nativeExit = $null
    }

    $repo = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
    $phase = 'staging'
    $scratch = Join-Path $env:RUNNER_TEMP ("cx-" + [guid]::NewGuid().ToString("N").Substring(0, 10))
    New-Item -ItemType Directory -Path $scratch | Out-Null
    $archive = Join-Path $scratch 'source.zip'
    $source = Join-Path $scratch 'src'
    Write-Log "scratch=$source"
    Invoke-Logged $git @('-C', $repo, 'archive', '--format=zip', "--output=$archive", 'HEAD', '--', '.', ':(exclude)tests/private-clients')
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $source)
    $lockfile = Join-Path $source 'package-lock.json'
    Write-Log "package-lock sha256=$((Get-FileHash -LiteralPath $lockfile).Hash)"
    $entryTemp = Join-Path $scratch 'tmp'
    New-Item -ItemType Directory -Path $entryTemp | Out-Null
    $previousTemp = $env:TEMP
    $previousTmp = $env:TMP
    Push-Location -LiteralPath $source
    try {
        $env:TEMP = $env:TMP = $entryTemp
        $phase = 'syntax'
        if ($id.EndsWith('.ps1')) {
            $tokens = $parseErrors = $null
            $null = [Management.Automation.Language.Parser]::ParseFile((Join-Path $source $Entry), [ref]$tokens, [ref]$parseErrors)
            if ($parseErrors) { throw ($parseErrors.Message -join '; ') }
            Write-Log 'PowerShell parser: OK'
        } elseif ($id -eq 'build-windows.cmd') {
            # cmd has no parse-only mode: parse/dispatch its existing help branch instead.
            Invoke-Logged $cmd @('/d', '/c', 'call windows\native-source\build-windows.cmd --help < NUL')
        } else {
            $phase = 'environment'
            # Do not resolve System32\bash.exe: that WSL entry would fall back to cmd.
            $bash = Join-Path (Split-Path (Split-Path $git)) 'bin/bash.exe'
            if (-not (Test-Path -LiteralPath $bash -PathType Leaf)) { throw 'Git for Windows Bash not found.' }
            Invoke-Logged $bash @('--noprofile', '--norc', '-c', 'uname -s | grep -E "^(MINGW|MSYS)"')
            $phase = 'syntax'
            Invoke-Logged $bash @('--noprofile', '--norc', '-n', $Entry)
        }

        if ($id -ne 'build-proxy.ps1') {
            $phase = 'environment'
            $modules = Join-Path $repo 'node_modules'
            if (-not (Test-Path -LiteralPath $modules -PathType Container)) {
                throw 'Locked node_modules are missing; the preceding npm ci must succeed.'
            }
            $phase = 'staging'
            Copy-Item -LiteralPath $modules -Destination $source -Recurse -Force
        }

        if ($id -eq 'build-windows.ps1') {
            $phase = 'assets'
            Invoke-Logged $npm @('run', 'build:windows', '--', '--release')
        }

        $phase = 'build'
        switch ($id) {
            'build-windows.cmd' {
                # Keep script behavior (including its package self-checks); feed EOF to pause.
                Invoke-Logged $cmd @('/d', '/c', 'call windows\native-source\build-windows.cmd < NUL')
            }
            'build-windows.sh' {
                Invoke-Logged $bash @('--noprofile', '--norc', $Entry)
            }
            'build-windows.ps1' {
                Invoke-Logged $powershell @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                    '-File', $Entry, '-OutputDirectory', 'windows/native-build', '-BuildConsole')
            }
            'build-proxy.ps1' {
                Invoke-Logged $powershell @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Entry)
            }
        }
    } finally {
        $env:TEMP = $previousTemp
        $env:TMP = $previousTmp
        Pop-Location
    }
    $status = 'success'
    $exitCode = 0
} catch {
    if ($null -ne $script:nativeExit -and $script:nativeExit -ne 0) { $exitCode = $script:nativeExit }
    if ($phase -eq 'environment') { $status = 'environment-error' }
    Write-Log ($_.ToString())
} finally {
    "entry=$Entry", "status=$status", "phase=$phase", "native_exit=$script:nativeExit", "exit=$exitCode" |
        Set-Content -LiteralPath (Join-Path $logs 'result.txt')
    if ($env:GITHUB_STEP_SUMMARY) {
        Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value ('- ' + $Entry + ': ' + "$status (phase=$phase, exit=$exitCode)")
    }
}
exit $exitCode
