[CmdletBinding()]
param(
    [string] $OutDir,
    [switch] $x86Only
)

$ErrorActionPreference = 'Stop'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $OutDir) { $OutDir = Join-Path $here 'build' }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
Write-Host ("build: pwsh {0}, script '{1}', output '{2}'" -f $PSVersionTable.PSVersion, $here, $OutDir)

# Any Visual Studio layout (2019/2022/2026, Community..BuildTools, x86 or x64 install root) is acceptable:
# vswhere is the supported probe, the directory scan is the fallback when the installer store is missing.
function Find-VcVars {
    $candidates = @()
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        try {
            $roots = @(& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null)
            foreach ($root in $roots) {
                if (-not $root) { continue }
                $candidates += Join-Path $root 'VC\Auxiliary\Build\vcvarsall.bat'
            }
        } catch {
            Write-Host "build: vswhere failed - $($_.Exception.Message)"
        }
    } else {
        Write-Host "build: vswhere not found at $vswhere"
    }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $base -or -not (Test-Path -LiteralPath $base)) { continue }
        $visualStudio = Join-Path $base 'Microsoft Visual Studio'
        if (-not (Test-Path -LiteralPath $visualStudio)) { continue }
        $candidates += @(Get-ChildItem -LiteralPath $visualStudio -Directory -ErrorAction SilentlyContinue |
            ForEach-Object {
                Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue |
                    ForEach-Object { Join-Path $_.FullName 'VC\Auxiliary\Build\vcvarsall.bat' }
            })
    }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        Write-Host "build: candidate $candidate"
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw 'vcvarsall.bat not found (checked vswhere and both Program Files roots); install the MSVC C++ build tools or build cxime.c manually.'
}

$vcvars = Find-VcVars
Write-Host "vcvarsall: $vcvars"

$source = Join-Path $here 'cxime.c'
$defFile = Join-Path $here 'cxime.def'
$resourceFile = Join-Path $here 'cxime.rc'
if (-not (Test-Path -LiteralPath $source)) { throw "Missing source: $source" }
if (-not (Test-Path -LiteralPath $defFile)) { throw "Missing def: $defFile" }
if (-not (Test-Path -LiteralPath $resourceFile)) { throw "Missing resource: $resourceFile" }

function Build-One {
    param([string] $Arch, [string] $OutputName)
    $target = Join-Path $OutDir $OutputName
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    $res = Join-Path $OutDir ("cxime-" + $Arch + ".res")
    $bat = Join-Path $env:TEMP ("cxime-build-" + $Arch + "-" + [guid]::NewGuid().ToString('N') + ".bat")
    $lines = @(
        '@echo off',
        ('call "' + $vcvars + '" ' + $Arch + ' >nul'),
        'if errorlevel 1 exit /b 1',
        ('cd /d "' + $here + '"'),
        # The version resource is required: without it LoadKeyboardLayoutW fails with 1813.
        ('rc /nologo /fo "' + $res + '" "cxime.rc"'),
        'if errorlevel 1 exit /b 1',
        ('cl /nologo /LD /O1 /W3 /DUNICODE /D_UNICODE "cxime.c" "' + $res + '" /Fo:"' + $OutDir + '\\" /link /DEF:"cxime.def" /OUT:"' + $target + '" user32.lib'),
        'if errorlevel 1 exit /b 1',
        'exit /b 0'
    )
    Set-Content -LiteralPath $bat -Value $lines -Encoding ASCII
    try {
        $output = & $env:ComSpec /c $bat 2>&1
        $exitCode = $LASTEXITCODE
        $output | ForEach-Object { Write-Host $_ }
        if ($exitCode -ne 0) { throw "cl failed for $Arch (exit $exitCode)" }
    } finally {
        Remove-Item -LiteralPath $bat -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $target)) { throw "Build produced no output: $target" }
    $size = (Get-Item -LiteralPath $target).Length
    Write-Host ("built {0} ({1} bytes)" -f $target, $size)
}

Build-One -Arch 'x86' -OutputName 'cxime32.dll'
if (-not $x86Only) { Build-One -Arch 'x64' -OutputName 'cxime64.dll' }

foreach ($built in @(Get-ChildItem -LiteralPath $OutDir -Filter 'cxime*.dll' -File)) {
    Write-Host ("{0} ({1} bytes)" -f $built.FullName, $built.Length)
}
Write-Host 'Check exports with: dumpbin /exports build\cxime32.dll  (run inside a vcvars shell)'
Write-Host 'Expected: ImeInquire, ImeConfigure, ImeDestroy, ImeEscape, ImeSelect, ImeSetActiveContext,'
Write-Host '          ImeProcessKey, ImeToAsciiEx, NotifyIME, ImeRegisterWord, ImeUnregisterWord,'
Write-Host '          ImeEnumRegisterWord, ImeSetCompositionString, ImeConversionList,'
Write-Host '          ImeGetRegisterWordStyle, ImeGetImeMenuItems'

