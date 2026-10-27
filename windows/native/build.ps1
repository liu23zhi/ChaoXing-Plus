[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [switch]$SkipAssetCopy
)
$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $scriptRoot '.tmp-native-host' }
$root = Split-Path (Split-Path $scriptRoot -Parent) -Parent
$compiler = Get-ChildItem -Path 'C:\Program Files\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x86\cl.exe' -File |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $compiler) { throw 'MSVC x86 compiler is required.' }
$linker = Join-Path $compiler.DirectoryName 'link.exe'
$toolRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler.FullName)))
$kitRoot = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots').KitsRoot10
$sdk = Get-ChildItem -LiteralPath (Join-Path $kitRoot 'Lib') -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um\x86\kernel32.lib') } |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $sdk) { throw 'Windows SDK x86 import libraries are required.' }
$include = Join-Path $kitRoot ('Include\' + $sdk.Name)
$build = Join-Path $OutputDirectory 'build'
$bin = Join-Path $OutputDirectory 'bin'
New-Item -ItemType Directory -Path $build,$bin -Force | Out-Null
$common = @('/nologo','/c','/TC','/W4','/O1','/GS-','/Gs9999999','/Zl','/utf-8','/DUNICODE','/D_UNICODE','/D_WIN32_WINNT=0x0601','/DWINVER=0x0601',('/I' + (Join-Path $toolRoot 'include')),('/I' + (Join-Path $include 'shared')),('/I' + (Join-Path $include 'um')),('/I' + (Join-Path $include 'ucrt')),('/I' + $scriptRoot))
$sources = @('memory','json','net','process','discovery','options','host')
foreach ($source in $sources) {
    & $compiler.FullName @common ('/Fo' + (Join-Path $build ($source + '.obj'))) (Join-Path $scriptRoot ($source + '.c'))
    if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $source" }
}
$originalPath = $env:Path
try {
    $env:Path = (Join-Path $kitRoot ('bin\' + $sdk.Name + '\x64')) + ';' + $originalPath
    $objects = $sources | ForEach-Object { Join-Path $build ($_ + '.obj') }
    $linkArgs = @('/NOLOGO','/NODEFAULTLIB','/ENTRY:WinMainCRTStartup','/SUBSYSTEM:WINDOWS,6.01','/OSVERSION:6.1','/MACHINE:X86','/DYNAMICBASE','/NXCOMPAT','/SAFESEH','/MANIFEST:EMBED',('/OUT:' + (Join-Path $bin 'chaoxing_plus.exe')),('/LIBPATH:' + (Join-Path $sdk.FullName 'um\x86')))
    & $linker @linkArgs @objects kernel32.lib user32.lib shell32.lib gdi32.lib ws2_32.lib advapi32.lib iphlpapi.lib version.lib
    if ($LASTEXITCODE -ne 0) { throw 'Native host link failed.' }
} finally { $env:Path = $originalPath }
if (-not $SkipAssetCopy) {
    $assetSources = @(
        (Join-Path $root 'windows\bootstrap\windows-bootstrap.js'),
        (Join-Path $root 'dist-windows\chaoxing-plus.windows.js')
    )
    foreach ($asset in $assetSources) {
        if (-not (Test-Path -LiteralPath $asset)) { throw "Missing injection asset: $asset. Run npm run build:windows first." }
        Copy-Item -LiteralPath $asset -Destination $bin -Force
    }
}
$dumpbin = Join-Path $compiler.DirectoryName 'dumpbin.exe'
& $dumpbin /headers /imports (Join-Path $bin 'chaoxing_plus.exe') | Set-Content -LiteralPath (Join-Path $build 'pe-imports.txt') -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw 'PE import audit failed.' }
Get-Item -LiteralPath (Join-Path $bin 'chaoxing_plus.exe') | Select-Object FullName,Length
Get-FileHash -LiteralPath (Join-Path $bin 'chaoxing_plus.exe') -Algorithm SHA256
