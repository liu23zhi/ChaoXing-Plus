[CmdletBinding()]
param(
    [string]$OutputDirectory,
    # Build target selector: 'tests' also compiles every test EXE, 'host' skips them.
    # ci-vm.yml currently calls -BuildTests; the two are equivalent.
    [ValidateSet('host', 'tests')]
    [string]$Target = 'host',
    [switch]$SkipAssetCopy,
    [switch]$BuildTests,
    [switch]$SkipProxy,
    [switch]$BuildConsole = $true
)
$ErrorActionPreference = 'Stop'
# -Target tests is an alias for -BuildTests, kept for existing callers
# (package.json build:native and scripts/vm/*.ps1 use -BuildTests).
if ($Target -eq 'tests') { $BuildTests = $true }
$scriptRoot = $PSScriptRoot
# The compile script and native sources share the same directory.
$sourceRoot = $scriptRoot
$root = Split-Path (Split-Path $scriptRoot -Parent) -Parent
# Native build output goes to <repo>/windows/native-build: bin keeps debug/test
# executables, release contains the two distributable native variants. -OutputDirectory overrides it.
# Native release packaging adds runtime files and checksums, never docs or ZIP.
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path (Split-Path $scriptRoot -Parent) 'native-build' }
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
# The single-file host embeds resources; the multi-file GUI reads sidecars.
$proxyScript = Join-Path $root 'windows\hook-source\build-proxy.ps1'
$hookDir = Join-Path $root 'windows\native-build\hook'
$proxyDll = Join-Path $hookDir 'winmm.dll'
if (-not (Test-Path -LiteralPath $proxyDll -PathType Leaf)) {
    if ($SkipProxy) { throw "Embedded proxy DLL is missing: $proxyDll (run windows\hook-source\build-proxy.ps1 or drop -SkipProxy)." }
    if (-not (Test-Path -LiteralPath $proxyScript)) { throw "Proxy build script is missing: $proxyScript" }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $proxyScript | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $proxyDll -PathType Leaf)) { throw 'Proxy DLL build failed.' }
}
$assetSources = [ordered]@{
    BOOTSTRAP = Join-Path $root 'dist-windows\windows-bootstrap.js'
    BUNDLE = Join-Path $root 'dist-windows\chaoxing-plus.windows.js'
    TRAMPOLINE = Join-Path $root 'dist-windows\trampoline.js'
    SWAL_STYLE = Join-Path $root 'dist-windows\vendor\sweetalert2.min.css'
    PROXY_WINMM = $proxyDll
}
$resourceSource = Get-Content -LiteralPath (Join-Path $sourceRoot 'assets.rc.in') -Raw -Encoding UTF8
foreach ($entry in $assetSources.GetEnumerator()) {
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) { throw "Missing injection asset: $($entry.Value). Run npm run build:windows first." }
    $resourcePath = (Resolve-Path -LiteralPath $entry.Value).Path.Replace('\', '\\')
    $resourceSource = $resourceSource.Replace('@' + $entry.Key + '@', $resourcePath)
}
$iconSource = Join-Path $root 'windows\share-file\assets\app-icon.ico'
if (-not (Test-Path -LiteralPath $iconSource -PathType Leaf)) { throw "Missing application icon: $iconSource" }
$iconResourcePath = (Resolve-Path -LiteralPath $iconSource).Path.Replace('\', '\\')
$resourceSource = $resourceSource.Replace('@APP_ICON@', $iconResourcePath)
$resourceFile = Join-Path $build 'assets.rc'
$resourceObject = Join-Path $build 'assets.res'
$resourceSource | Set-Content -LiteralPath $resourceFile -Encoding Unicode
& $resourceCompiler /nologo ('/i' + $sourceRoot) ('/fo' + $resourceObject) $resourceFile
if ($LASTEXITCODE -ne 0) { throw 'Native resource compilation failed.' }
$multiResourceFile = Join-Path $build 'multi-assets.rc'
$multiResourceObject = Join-Path $build 'multi-assets.res'
$multiResourceSource = (Get-Content -LiteralPath (Join-Path $sourceRoot 'multi-assets.rc.in') -Raw -Encoding UTF8).Replace('@APP_ICON@', $iconResourcePath)
$multiResourceSource | Set-Content -LiteralPath $multiResourceFile -Encoding Unicode
& $resourceCompiler /nologo ('/i' + $sourceRoot) ('/fo' + $multiResourceObject) $multiResourceFile
if ($LASTEXITCODE -ne 0) { throw 'Multi-file icon compilation failed.' }
$common = @('/nologo','/c','/TC','/W4','/O1','/GS-','/Gs9999999','/Zl','/utf-8','/DUNICODE','/D_UNICODE','/D_WIN32_WINNT=0x0601','/DWINVER=0x0601',('/I' + (Join-Path $toolRoot 'include')),('/I' + (Join-Path $include 'shared')),('/I' + (Join-Path $include 'um')),('/I' + (Join-Path $include 'ucrt')),('/I' + $sourceRoot))
$sources = @('memory','json','net','process','discovery','options','assets','selection','session','audit','config-store','diagnostics','elevation','dpi','silent','purge','wipe','browser-extension','browser-session','adapter-account','account-window','home','host')
foreach ($source in $sources) {
    & $compiler.FullName @common ('/Fo' + (Join-Path $build ($source + '.obj'))) (Join-Path $sourceRoot ($source + '.c'))
    if ($LASTEXITCODE -ne 0) { throw "Compilation failed: $source" }
}
$originalPath = $env:Path
try {
    $env:Path = (Join-Path $kitRoot ('bin\' + $sdk.Name + '\x64')) + ';' + $originalPath
    $objects = $sources | ForEach-Object { Join-Path $build ($_ + '.obj') }
    $hostExe = Join-Path $bin 'chaoxing_plus.exe'
    $multiBin = Join-Path $bin 'multi-file'
    $multiHostExe = Join-Path $multiBin 'chaoxing_plus.exe'
    $consoleHelper = Join-Path $multiBin 'chaoxing_plus.com'
    $packageLauncher = Join-Path $multiBin 'package-to-single\chaoxing_plus.exe'
    $linkArgs = @('/NOLOGO','/NODEFAULTLIB','/ENTRY:WinMainCRTStartup','/SUBSYSTEM:WINDOWS,6.01','/OSVERSION:6.1','/MACHINE:X86','/DYNAMICBASE','/NXCOMPAT','/SAFESEH','/MANIFEST:EMBED',('/MANIFESTINPUT:' + (Join-Path $sourceRoot 'host.manifest')),('/OUT:' + $hostExe),('/LIBPATH:' + (Join-Path $sdk.FullName 'um\x86')))
    & $linker @linkArgs @objects $resourceObject kernel32.lib user32.lib shell32.lib gdi32.lib comdlg32.lib ws2_32.lib advapi32.lib iphlpapi.lib version.lib
    if ($LASTEXITCODE -ne 0) { throw 'Native host link failed.' }
    if ($BuildConsole) {
        New-Item -ItemType Directory -Path $multiBin,(Split-Path $packageLauncher -Parent) -Force | Out-Null
        & $compiler.FullName @common /DCX_MULTI_FILE_BUILD ('/Fo' + (Join-Path $build 'assets-multi.obj')) (Join-Path $sourceRoot 'assets.c')
        if ($LASTEXITCODE -ne 0) { throw 'Multi-file resource loader compilation failed.' }
        $multiObjects = $sources | ForEach-Object { if ($_ -eq 'assets') { Join-Path $build 'assets-multi.obj' } else { Join-Path $build ($_ + '.obj') } }
        $baseLinkArgs = $linkArgs | Where-Object { $_ -notlike '/OUT:*' }
        & $linker @baseLinkArgs ('/OUT:' + $multiHostExe) @multiObjects $multiResourceObject kernel32.lib user32.lib shell32.lib gdi32.lib comdlg32.lib ws2_32.lib advapi32.lib iphlpapi.lib version.lib
        if ($LASTEXITCODE -ne 0) { throw 'Multi-file GUI link failed.' }
        & $compiler.FullName @common ('/Fo' + (Join-Path $build 'console-launcher.obj')) (Join-Path $sourceRoot 'console-launcher.c')
        if ($LASTEXITCODE -ne 0) { throw 'Console helper compilation failed.' }
        $helperLinkArgs = $baseLinkArgs | Where-Object { $_ -notlike '/ENTRY:*' -and $_ -notlike '/SUBSYSTEM:*' }
        & $linker @helperLinkArgs /ENTRY:ConsoleLauncherMain /SUBSYSTEM:CONSOLE,6.01 ('/OUT:' + $consoleHelper) (Join-Path $build 'console-launcher.obj') $multiResourceObject kernel32.lib
        if ($LASTEXITCODE -ne 0) { throw 'Console helper link failed.' }
        $sidecars = [ordered]@{
            BOOTSTRAP = 'assets\windows-bootstrap.js'
            BUNDLE = 'assets\chaoxing-plus.windows.js'
            TRAMPOLINE = 'assets\trampoline.js'
            SWAL_STYLE = 'assets\vendor\sweetalert2.min.css'
            PROXY_WINMM = 'winmm-proxy.dll'
        }
        foreach ($entry in $sidecars.GetEnumerator()) {
            $destination = Join-Path $multiBin $entry.Value
            New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
            Copy-Item -LiteralPath $assetSources[$entry.Key] -Destination $destination -Force
        }
        $payload = Join-Path $build 'multi-payload.bin'
        & node (Join-Path $sourceRoot 'package-multi-payload.mjs') $multiBin $payload
        if ($LASTEXITCODE -ne 0) { throw 'Multi-file payload packaging failed.' }
        $packageResourceFile = Join-Path $build 'package-payload.rc'
        $packageResourceObject = Join-Path $build 'package-payload.res'
        $packageResource = $multiResourceSource + "`r`n201 RCDATA `"" + (Resolve-Path -LiteralPath $payload).Path.Replace('\', '\\') + "`"`r`n"
        $packageResource | Set-Content -LiteralPath $packageResourceFile -Encoding Unicode
        & $resourceCompiler /nologo ('/i' + $sourceRoot) ('/fo' + $packageResourceObject) $packageResourceFile
        if ($LASTEXITCODE -ne 0) { throw 'Package resource compilation failed.' }
        & $compiler.FullName @common ('/Fo' + (Join-Path $build 'package-launcher.obj')) (Join-Path $sourceRoot 'package-launcher.c')
        if ($LASTEXITCODE -ne 0) { throw 'Package launcher compilation failed.' }
        $packageLinkArgs = $baseLinkArgs | Where-Object { $_ -notlike '/ENTRY:*' }
        & $linker @packageLinkArgs /ENTRY:PackageLauncherMain ('/OUT:' + $packageLauncher) (Join-Path $build 'package-launcher.obj') (Join-Path $build 'memory.obj') $packageResourceObject kernel32.lib
        if ($LASTEXITCODE -ne 0) { throw 'Package launcher link failed.' }
    }
    $obsoleteConsole = Join-Path $bin 'chaoxing_plus_console.exe'
    if (Test-Path -LiteralPath $obsoleteConsole -PathType Leaf) { Remove-Item -LiteralPath $obsoleteConsole -Force }
    if ($BuildTests) {
        $testObject = Join-Path $build 'injection-tests.obj'
        & $compiler.FullName @common ('/Fo' + $testObject) (Join-Path $sourceRoot 'tests\injection-tests.c')
        if ($LASTEXITCODE -ne 0) { throw 'Native injection test compilation failed.' }
        $homeObjects = @('browser-extension','browser-session','adapter-account','account-window','home')
        $testObjects = @('memory','json','process','discovery','options','assets','selection','session','audit','config-store','diagnostics','elevation','dpi','silent','purge','wipe') + $homeObjects | ForEach-Object { Join-Path $build ($_ + '.obj') }
        $testArgs = $linkArgs | Where-Object { $_ -notlike '/OUT:*' -and $_ -notlike '/ENTRY:*' -and $_ -notlike '/MANIFESTINPUT:*' }
        & $linker @testArgs /ENTRY:InjectionTestMain ('/OUT:' + (Join-Path $bin 'injection-tests.exe')) @testObjects $testObject $resourceObject kernel32.lib user32.lib shell32.lib gdi32.lib comdlg32.lib ws2_32.lib advapi32.lib iphlpapi.lib version.lib
        if ($LASTEXITCODE -ne 0) { throw 'Native injection test link failed.' }
        foreach ($test in @(
            @{ Name = 'console-helper-fixture'; Entry = 'ConsoleHelperFixtureMain'; Objects = @(); Resources = @() },
            @{ Name = 'browser-session-tests'; Entry = 'BrowserSessionTestMain'; Objects = @('memory','json','browser-extension','browser-session'); Resources = @() },
            @{ Name = 'adapter-account-tests'; Entry = 'WinMainCRTStartup'; Objects = @('memory','json','adapter-account'); Resources = @() },
            @{ Name = 'extension-cache-tests'; Entry = 'ExtensionCacheTestMain'; Objects = @('memory','json','adapter-account'); Resources = @() },
            @{ Name = 'account-window-tests'; Entry = 'WinMainCRTStartup'; Objects = @('memory','json','adapter-account','account-window'); Resources = @($resourceObject); Manifest = 'host.manifest' },
            @{ Name = 'home-tests'; Entry = 'HomeTestMain'; Objects = @('memory','json','options','config-store','adapter-account'); Resources = @($resourceObject) },
            @{ Name = 'assets-tests'; Entry = 'AssetTestMain'; Objects = @('memory','assets'); Resources = @($resourceObject) },
            @{ Name = 'options-tests'; Entry = 'WinMainCRTStartup'; Objects = @('memory','json','options','config-store'); Resources = @() },
            @{ Name = 'discovery-cache-driver'; Entry = 'DiscoveryCacheDriverMain'; Objects = @('memory','process','discovery'); Resources = @() },
            @{ Name = 'discovery-cache-host-tests'; Entry = 'DiscoveryCacheHostTestMain'; Objects = @('memory','json','net','process','discovery','options','assets','selection','session','audit','config-store','diagnostics','elevation','dpi','silent','purge','wipe'); Resources = @($resourceObject) },
            @{ Name = 'json-tests'; Entry = 'WinMainCRTStartup'; Objects = @('memory','json'); Resources = @() },
            @{ Name = 'session-tests'; Entry = 'SessionTestMain'; Objects = @('memory','json','session'); Resources = @() },
            @{ Name = 'selection-tests'; Entry = 'SelectionTestMain'; Objects = @('memory','process','discovery','selection','assets'); Resources = @($resourceObject) },
            @{ Name = 'transport-tests'; Entry = 'TransportTestMain'; Objects = @('memory'); Resources = @() },
  @{ Name = 'cdp-echo'; Entry = 'CdpEchoMain'; Objects = @('memory'); Resources = @() },
  @{ Name = 'env-probe'; Entry = 'EnvProbeMain'; Objects = @('memory'); Resources = @() },
  @{ Name = 'cdp-server'; Entry = 'CdpServerMain'; Objects = @('memory'); Resources = @() },
            @{ Name = 'audit-tests'; Entry = 'AuditTestMain'; Objects = @('memory','audit'); Resources = @() },
            @{ Name = 'config-store-tests'; Entry = 'ConfigStoreTestMain'; Objects = @('memory','json','config-store'); Resources = @() },
            @{ Name = 'diagnostics-tests'; Entry = 'DiagnosticsTestMain'; Objects = @('memory','json','options','config-store','diagnostics'); Resources = @() },
            @{ Name = 'elevation-tests'; Entry = 'ElevationTestMain'; Objects = @('memory'); Resources = @() },
            @{ Name = 'elevation-host-tests'; Entry = 'ElevationHostTestMain'; Objects = @('memory','json','net','process','discovery','options','assets','selection','session','audit','config-store','diagnostics','elevation','dpi','silent','purge','wipe'); Resources = @($resourceObject) },
            @{ Name = 'dpi-tests'; Entry = 'DpiTestMain'; Objects = @('memory'); Resources = @() },
            @{ Name = 'dpi-child'; Entry = 'DpiChildMain'; Objects = @('memory'); Resources = @(); Manifest = 'tests\dpi-child.manifest' },
            @{ Name = 'dpi-process-tests'; Entry = 'DpiProcessTestMain'; Objects = @('memory','process','dpi'); Resources = @() },
            @{ Name = 'process-check-tests'; Entry = 'ProcessCheckTestMain'; Objects = @('memory'); Resources = @() },
            @{ Name = 'process-fixture'; Entry = 'ProcessFixtureMain'; Objects = @('memory'); Resources = @() },
            @{ Name = 'carrier-fixture'; Entry = 'CarrierFixtureMain'; Objects = @(); Resources = @(); ExtraLibs = @('winmm.lib') },
            @{ Name = 'cli-selection-tests'; Entry = 'CliSelectionTestMain'; Objects = @('memory','json','net','process','discovery','options','assets','selection','session','audit','config-store','diagnostics','elevation','dpi','silent','purge','wipe'); Resources = @($resourceObject) },
            @{ Name = 'silent-tests'; Entry = 'SilentTestMain'; Objects = @('memory','silent'); Resources = @() },
            @{ Name = 'purge-tests'; Entry = 'PurgeTestMain'; Objects = @('memory','purge'); Resources = @() }
        )) {
            $testObject = Join-Path $build ($test.Name + '.obj')
            & $compiler.FullName @common ('/Fo' + $testObject) (Join-Path $sourceRoot ('tests\' + $test.Name + '.c'))
            if ($LASTEXITCODE -ne 0) { throw "Native test compilation failed: $($test.Name)" }
            $moduleNames = @($test.Objects)
            if ($test.Name -in @('discovery-cache-host-tests','elevation-host-tests','cli-selection-tests')) { $moduleNames += $homeObjects }
            $testObjects = @($moduleNames | ForEach-Object { Join-Path $build ($_ + '.obj') })
            $testResources = $test.Resources
            $testManifest = @()
            if ($test.ContainsKey('Manifest')) { $testManifest = @('/MANIFESTINPUT:' + (Join-Path $sourceRoot $test.Manifest)) }
            $extraLibs = @()
            if ($test.ContainsKey('ExtraLibs')) { $extraLibs = @($test.ExtraLibs) }
            & $linker @testArgs @testManifest ('/ENTRY:' + $test.Entry) ('/OUT:' + (Join-Path $bin ($test.Name + '.exe'))) @testObjects $testObject @testResources kernel32.lib user32.lib gdi32.lib comdlg32.lib shell32.lib ws2_32.lib advapi32.lib iphlpapi.lib version.lib @extraLibs
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $bin ($test.Name + '.exe')) -PathType Leaf)) { throw "Native test link failed or output is missing: $($test.Name)" }
        }
        if ($BuildConsole) {
            $multiTestObject = Join-Path $build 'multi-assets-tests.obj'
            & $compiler.FullName @common ('/Fo' + $multiTestObject) (Join-Path $sourceRoot 'tests\multi-assets-tests.c')
            if ($LASTEXITCODE -ne 0) { throw 'Multi-file asset test compilation failed.' }
            & $linker @testArgs /ENTRY:MultiAssetTestMain ('/OUT:' + (Join-Path $bin 'multi-assets-tests.exe')) (Join-Path $build 'memory.obj') (Join-Path $build 'assets-multi.obj') $multiTestObject kernel32.lib user32.lib
            if ($LASTEXITCODE -ne 0) { throw 'Multi-file asset test link failed.' }
        }
    }
} finally { $env:Path = $originalPath }
# Kept for existing callers; required multi-file sidecars cannot be skipped.
if ($SkipAssetCopy) { Write-Verbose 'SkipAssetCopy does not omit required multi-file resources.' }
$dumpbin = Join-Path $compiler.DirectoryName 'dumpbin.exe'
& $dumpbin /headers /imports $hostExe | Set-Content -LiteralPath (Join-Path $build 'pe-imports.txt') -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw 'PE import audit failed.' }
if ($BuildConsole) {
    & $dumpbin /headers /imports $consoleHelper | Set-Content -LiteralPath (Join-Path $build 'pe-imports-console.txt') -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'PE console import audit failed.' }
    & $dumpbin /headers /imports $multiHostExe | Set-Content -LiteralPath (Join-Path $build 'pe-imports-multi.txt') -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'PE multi-file import audit failed.' }
    & $dumpbin /headers /imports $packageLauncher | Set-Content -LiteralPath (Join-Path $build 'pe-imports-package.txt') -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'PE package import audit failed.' }
}
$release = Join-Path $OutputDirectory 'release'
$singleFileRelease = Join-Path $release 'single-file'
$multiFileRelease = Join-Path $release 'multi-file'
$multiFiles = @('chaoxing_plus.exe','chaoxing_plus.com','assets\windows-bootstrap.js','assets\chaoxing-plus.windows.js','assets\trampoline.js','assets\vendor\sweetalert2.min.css','winmm-proxy.dll','package-to-single\chaoxing_plus.exe')
New-Item -ItemType Directory -Path $singleFileRelease -Force | Out-Null
$legacyReleaseExe = Join-Path $release 'chaoxing_plus.exe'
if (Test-Path -LiteralPath $legacyReleaseExe -PathType Leaf) {
    Remove-Item -LiteralPath $legacyReleaseExe -Force
}
$singleFileExe = Join-Path $singleFileRelease 'chaoxing_plus.exe'
Copy-Item -LiteralPath $hostExe -Destination $singleFileExe -Force
$releaseOutputs = @($hostExe, $singleFileExe)
if ($BuildConsole) {
    New-Item -ItemType Directory -Path $multiFileRelease -Force | Out-Null
    foreach ($relative in $multiFiles) {
        $destination = Join-Path $multiFileRelease $relative
        New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $multiBin $relative) -Destination $destination -Force
    }
    $releaseOutputs += @((Join-Path $multiFileRelease 'chaoxing_plus.exe'), (Join-Path $multiFileRelease 'chaoxing_plus.com'), (Join-Path $multiFileRelease 'package-to-single\chaoxing_plus.exe'))
} else {
    # Remove only known build outputs; leave unrelated files and test EXEs alone.
    foreach ($directory in @($multiBin, $multiFileRelease)) {
        foreach ($relative in $multiFiles) {
            $obsolete = Join-Path $directory $relative
            if (Test-Path -LiteralPath $obsolete -PathType Leaf) { Remove-Item -LiteralPath $obsolete -Force }
        }
    }
}
$staleConsoleExe = Join-Path $multiFileRelease 'chaoxing_plus_console.exe'
if (Test-Path -LiteralPath $staleConsoleExe -PathType Leaf) { Remove-Item -LiteralPath $staleConsoleExe -Force }
Get-Item -LiteralPath $releaseOutputs | Select-Object FullName,Length
# Use the system certutil binary for the hash: this .ps1 must stay ASCII-only
# and build must not depend on PowerShell module auto-loading.
& certutil.exe -hashfile $hostExe SHA256
if ($LASTEXITCODE -ne 0) { throw 'SHA256 output failed.' }









