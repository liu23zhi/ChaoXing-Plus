[CmdletBinding()]
param(
    [string] $OutDir,
    [switch] $x86Only
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) { $OutDir = Join-Path $here 'build' }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

function Find-VcVars {
    $candidates = @()
    foreach ($edition in @('Community', 'Professional', 'Enterprise', 'BuildTools')) {
        foreach ($year in @('2022', '2019')) {
            $candidates += Join-Path $env:ProgramFiles "Microsoft Visual Studio\$year\$edition\VC\Auxiliary\Build\vcvarsall.bat"
            $candidates += Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\$year\$edition\VC\Auxiliary\Build\vcvarsall.bat"
        }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    throw 'vcvarsall.bat not found; install the MSVC C++ build tools or build cxime.c manually.'
}

$vcvars = Find-VcVars
Write-Host "vcvarsall: $vcvars"

$source = Join-Path $here 'cxime.c'
$defFile = Join-Path $here 'cxime.def'
if (-not (Test-Path -LiteralPath $source)) { throw "Missing source: $source" }
if (-not (Test-Path -LiteralPath $defFile)) { throw "Missing def: $defFile" }

function Build-One {
    param([string] $Arch, [string] $OutputName)
    $target = Join-Path $OutDir $OutputName
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
    $bat = Join-Path $env:TEMP ("cxime-build-" + $Arch + "-" + [guid]::NewGuid().ToString('N') + ".bat")
    $lines = @(
        '@echo off',
        ('call "' + $vcvars + '" ' + $Arch + ' >nul'),
        'if errorlevel 1 exit /b 1',
        ('cd /d "' + $here + '"'),
        ('cl /nologo /LD /O1 /W3 /DUNICODE /D_UNICODE "cxime.c" /Fo:"' + $OutDir + '\\" /link /DEF:"cxime.def" /OUT:"' + $target + '" user32.lib'),
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

