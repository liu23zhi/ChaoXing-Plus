[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [switch]$SkipAssetCopy,
    [switch]$BuildTests
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
$resourceCompiler = Join-Path $kitRoot ('bin\' + $sdk.Name + '\x64\rc.exe')
if (-not (Test-Path -LiteralPath $resourceCompiler)) { throw 'Windows SDK resource compiler is required.' }
$build = Join-Path $OutputDirectory 'build'
$bin = Join-Path $OutputDirectory 'bin'
New-Item -ItemType Directory -Path $build,$bin -Force | Out-Null
$assetSources = [ordered]@{
    BOOTSTRAP = Join-Path $root 'dist-windows\windows-bootstrap.js'
    BUNDLE = Join-Path $root 'dist-windows\chaoxing-plus.windows.js'
    TRAMPOLINE = Join-Path $root 'dist-windows\trampoline.js'
    SWAL_STYLE = Join-Path $root 'dist-windows\vendor\sweetalert2.min.css'
}
$resourceSource = Get-Content -LiteralPath (Join-Path $scriptRoot 'assets.rc.in') -Raw -Encoding UTF8
foreach ($entry in $assetSources.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) { throw "Missing injection asset: $($entry.Value). Run npm run build:windows first." }
    $resourcePath = (Resolve-Path -LiteralPath $entry.Value).Path.Replace('\', '\\')
    $resourceSource = $resourceSource.Replace('@' + $entry.Key + '@', $resourcePath)
}
$resourceFile = Join-Path $build 'assets.rc'
$resourceObject = Join-Path $build 'assets.res'
$resourceSource | Set-Content -LiteralPath $resourceFile -Encoding Unicode
& $resourceCompiler /nologo ('/i' + $scriptRoot) ('/fo' + $resourceObject) $resourceFile
if ($LASTEXITCODE -ne 0) { throw 'Native resource compilation failed.' }
$common = @('/nologo','/c','/TC','/W4','/O1','/GS-','/Gs9999999','/Zl','/utf-8','/DUNICODE','/D_UNICODE','/D_WIN32_WINNT=0x0601','/DWINVER=0x0601',('/I' + (Join-Path $toolRoot 'include')),('/I' + (Join-Path $include 'shared')),('/I' + (Join-Path $include 'um')),('/I' + (Join-Path $include 'ucrt')),('/I' + $scriptRoot))
$sources = @('memory','json','net','process','discovery','options','assets','host')
foreach ($source in $sources) {
    & $compiler.FullName @common ('/Fo' + (Join-Path $build ($source + '.obj'))) (Join-Path $scriptRoot ($source + '.c'))
    if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $source" }
}
$originalPath = $env:Path
try {
    $env:Path = (Join-Path $kitRoot ('bin\' + $sdk.Name + '\x64')) + ';' + $originalPath
    $objects = $sources | ForEach-Object { Join-Path $build ($_ + '.obj') }
    $linkArgs = @('/NOLOGO','/NODEFAULTLIB','/ENTRY:WinMainCRTStartup','/SUBSYSTEM:WINDOWS,6.01','/OSVERSION:6.1','/MACHINE:X86','/DYNAMICBASE','/NXCOMPAT','/SAFESEH','/MANIFEST:EMBED',('/OUT:' + (Join-Path $bin 'chaoxing_plus.exe')),('/LIBPATH:' + (Join-Path $sdk.FullName 'um\x86')))
    & $linker @linkArgs @objects $resourceObject kernel32.lib user32.lib shell32.lib gdi32.lib ws2_32.lib advapi32.lib iphlpapi.lib version.lib
    if ($LASTEXITCODE -ne 0) { throw 'Native host link failed.' }
    if ($BuildTests) {
        $testObject = Join-Path $build 'injection-tests.obj'
        & $compiler.FullName @common ('/Fo' + $testObject) (Join-Path $scriptRoot 'tests\injection-tests.c')
        if ($LASTEXITCODE -ne 0) { throw 'Native injection test compilation failed.' }
        $testObjects = @('memory','json','process','discovery','options','assets') | ForEach-Object { Join-Path $build ($_ + '.obj') }
        $testArgs = $linkArgs | Where-Object { $_ -notlike '/OUT:*' -and $_ -notlike '/ENTRY:*' }
        & $linker @testArgs /ENTRY:InjectionTestMain ('/OUT:' + (Join-Path $bin 'injection-tests.exe')) @testObjects $testObject $resourceObject kernel32.lib user32.lib shell32.lib gdi32.lib ws2_32.lib advapi32.lib iphlpapi.lib version.lib
        if ($LASTEXITCODE -ne 0) { throw 'Native injection test link failed.' }
        foreach ($test in @(
            @{ Name = 'assets-tests'; Entry = 'AssetTestMain'; Objects = @('memory','assets'); Resources = @($resourceObject) },
            @{ Name = 'options-tests'; Entry = 'WinMainCRTStartup'; Objects = @('memory','json','options'); Resources = @() },
            @{ Name = 'json-tests'; Entry = 'WinMainCRTStartup'; Objects = @('memory','json'); Resources = @() }
        )) {
            $testObject = Join-Path $build ($test.Name + '.obj')
            & $compiler.FullName @common ('/Fo' + $testObject) (Join-Path $scriptRoot ('tests\' + $test.Name + '.c'))
            if ($LASTEXITCODE -ne 0) { throw "Native test compilation failed: $($test.Name)" }
            $testObjects = $test.Objects | ForEach-Object { Join-Path $build ($_ + '.obj') }
            $testResources = $test.Resources
            & $linker @testArgs ('/ENTRY:' + $test.Entry) ('/OUT:' + (Join-Path $bin ($test.Name + '.exe'))) @testObjects $testObject @testResources kernel32.lib shell32.lib
            if ($LASTEXITCODE -ne 0) { throw "Native test link failed: $($test.Name)" }
        }
    }
} finally { $env:Path = $originalPath }
# Kept for existing build callers; resources are always embedded, never copied beside the EXE.
if ($SkipAssetCopy) { Write-Verbose 'SkipAssetCopy is retained for compatibility; no external assets are produced.' }
$dumpbin = Join-Path $compiler.DirectoryName 'dumpbin.exe'
& $dumpbin /headers /imports (Join-Path $bin 'chaoxing_plus.exe') | Set-Content -LiteralPath (Join-Path $build 'pe-imports.txt') -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw 'PE import audit failed.' }
Get-Item -LiteralPath (Join-Path $bin 'chaoxing_plus.exe') | Select-Object FullName,Length
Get-FileHash -LiteralPath (Join-Path $bin 'chaoxing_plus.exe') -Algorithm SHA256
