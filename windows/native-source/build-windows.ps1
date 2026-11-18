[CmdletBinding()]
param(
    [string]$OutputDirectory,
    # 构建目标选择器：'tests' 会编译所有测试 EXE，'host' 跳过它们。
    # ci.yml 目前调用 -BuildTests；两者等价。
    [ValidateSet('host', 'tests')]
    [string]$Target = 'host',
    [switch]$SkipAssetCopy,
    [switch]$BuildTests,
    [switch]$SkipProxy,
    [switch]$BuildConsole = $true,
    # 跳过本地依赖的自动补全（npm ci / 资源重建）。
    [switch]$SkipDependencySetup
)
$ErrorActionPreference = 'Stop'
# -Target tests 是 -BuildTests 的别名，为兼容现有调用方保留
# （package.json 的 build:native 和 scripts/vm/*.ps1 使用 -BuildTests）。
if ($Target -eq 'tests') { $BuildTests = $true }
$scriptRoot = $PSScriptRoot
# 编译脚本与原生源码位于同一目录。
$sourceRoot = $scriptRoot
$root = Split-Path (Split-Path $scriptRoot -Parent) -Parent

# --- 依赖检测与补全 -----------------------------------------
# 本地可逆的缺失会自动补全。系统级工具链
# （MSVC、Windows SDK）只做精确检测并给出安装命令；
# 绝不静默安装，因为那会改动共享的系统环境。
function Write-Dep { param([string]$Message) Write-Host ('[build-windows] ' + $Message) }
function Test-OnPath { param([string]$Name) return [bool](Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue) }
function Add-NodeToPath {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'node.exe') -PathType Leaf)) {
            $env:Path = $candidate + ';' + $env:Path
            Write-Dep ('已加入 PATH：' + $candidate)
            return $true
        }
    }
    return $false
}

# 1) Node.js / npm —— package-multi-payload.mjs 和资源构建需要。
if (-not (Test-OnPath 'node')) { [void](Add-NodeToPath) }
if (-not (Test-OnPath 'node')) {
    throw '缺少 node.exe。请安装 Node.js 22+：winget install OpenJS.NodeJS.LTS'
}
if (-not (Test-OnPath 'npm')) {
    throw '缺少 npm.cmd（随 Node.js 提供）。请重新安装 Node.js 22+。'
}
$nodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($LASTEXITCODE -ne 0 -or $nodeMajor -lt 22) {
    throw ('需要 Node.js 22+，当前为 ' + $nodeMajor + '。升级命令：winget install OpenJS.NodeJS.LTS')
}

# 2) npm 依赖包 —— 缺失或不完整时用 npm ci 补全。
if (-not $SkipDependencySetup) {
    $lockMarker = Join-Path $root 'node_modules\.package-lock.json'
    if (-not (Test-Path -LiteralPath $lockMarker -PathType Leaf)) {
        Write-Dep 'node_modules 缺失或不完整，正在执行 npm ci（用 -SkipDependencySetup 可禁用）...'
        Push-Location -LiteralPath $root
        try {
            & npm ci
            if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败。' }
        } finally { Pop-Location }
    }
}

# 3) 注入资源 —— 缺失时自动重建，使本脚本可独立运行。
$assetProbe = Join-Path $root 'dist-windows\windows-bootstrap.js'
if (-not (Test-Path -LiteralPath $assetProbe -PathType Leaf)) {
    if ($SkipDependencySetup) { throw "缺少注入资源：$assetProbe（请先运行 npm run build:windows）。" }
    Write-Dep '注入资源缺失，正在运行 npm run build:windows...'
    Push-Location -LiteralPath $root
    try {
        & npm run build:windows -- --release
        if ($LASTEXITCODE -ne 0) { throw 'npm run build:windows 失败。' }
    } finally { Pop-Location }
}

# 原生构建产物输出到 <repo>/windows/native-build：bin 存放调试/测试
# 程序，release 存放两个可发布的原生变体。-OutputDirectory 可覆盖该路径。
# 原生发布包只附加运行时文件和校验和，绝不含文档或 ZIP。
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path (Split-Path $scriptRoot -Parent) 'native-build' }
# 4) MSVC x86 工具链 —— 先探测默认安装目录，再用 vswhere，
#    以覆盖安装在非默认盘的 Visual Studio。
$compiler = Get-ChildItem -Path 'C:\Program Files\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x86\cl.exe' -File -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $compiler) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        Write-Dep '默认路径未找到 MSVC，正在用 vswhere 探测...'
        $vsPath = @(& $vswhere -latest -products * -property installationPath | Select-Object -First 1)[0]
        if ($vsPath) {
            $compiler = Get-ChildItem -Path (Join-Path $vsPath 'VC\Tools\MSVC\*\bin\Hostx64\x86\cl.exe') -File -ErrorAction SilentlyContinue |
                Sort-Object FullName -Descending | Select-Object -First 1
        }
    }
}
if (-not $compiler) {
    throw '缺少 MSVC x86 编译器。请安装生成工具：winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
}
$linker = Join-Path $compiler.DirectoryName 'link.exe'
if (-not (Test-Path -LiteralPath $linker -PathType Leaf)) { throw "未找到链接器：$linker" }
$toolRoot = Split-Path (Split-Path (Split-Path (Split-Path $compiler.FullName)))
# cl.exe 和 dumpbin.exe 都从 PATH 解析 mspdbcore.dll。VS 将其放在
# Common7\IDE 及各主机对应的 VC\bin 目录；此处一次性注入，
# 使编译步骤和后续的 PE 审计都能找到它。$originalPath 在
# 此之后捕获，因此 try/finally 恢复时会保留这些条目。
$vsRootDir = Split-Path (Split-Path (Split-Path (Split-Path $toolRoot -Parent) -Parent) -Parent) -Parent
$pdbDirs = @(Get-ChildItem -Path (Join-Path $vsRootDir 'Common7\IDE'), (Join-Path $toolRoot 'bin\Hostx64\x64'), (Join-Path $toolRoot 'bin\Hostx86\x86') -Filter 'mspdbcore.dll' -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty DirectoryName -Unique)
if ($pdbDirs.Count -gt 0) { $env:Path = (($pdbDirs) -join ';') + ';' + $env:Path }
$kitRoot = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -ErrorAction SilentlyContinue).KitsRoot10
if (-not $kitRoot) { throw '未找到 Windows 10/11 SDK。请通过 Visual Studio Installer > 单个组件 安装。' }
$sdk = Get-ChildItem -LiteralPath (Join-Path $kitRoot 'Lib') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'um\x86\kernel32.lib') } |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $sdk) { throw '缺少 Windows SDK x86 导入库。请通过 Visual Studio Installer > 单个组件 安装 Windows 11 SDK。' }
$include = Join-Path $kitRoot ('Include\' + $sdk.Name)
$resourceCompiler = Join-Path $kitRoot ('bin\' + $sdk.Name + '\x64\rc.exe')
if (-not (Test-Path -LiteralPath $resourceCompiler)) { throw '缺少 Windows SDK 资源编译器（rc.exe）。' }
$build = Join-Path $OutputDirectory 'build'
$bin = Join-Path $OutputDirectory 'bin'
New-Item -ItemType Directory -Path $build,$bin -Force | Out-Null
# 单文件宿主内嵌资源；多文件 GUI 读取旁车文件。
$proxyScript = Join-Path $root 'windows\hook-source\build-proxy.ps1'
$hookDir = Join-Path $root 'windows\native-build\hook'
$proxyDll = Join-Path $hookDir 'winmm.dll'
if (-not (Test-Path -LiteralPath $proxyDll -PathType Leaf)) {
    if ($SkipProxy) { throw "缺少内嵌代理 DLL：$proxyDll（请运行 windows\hook-source\build-proxy.ps1 或去掉 -SkipProxy）。" }
    if (-not (Test-Path -LiteralPath $proxyScript)) { throw "缺少代理构建脚本：$proxyScript" }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $proxyScript | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $proxyDll -PathType Leaf)) { throw '代理 DLL 构建失败。' }
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
    if (-not (Test-Path -LiteralPath $entry.Value -PathType Leaf)) { throw "缺少注入资源：$($entry.Value)。请先运行 npm run build:windows。" }
    $resourcePath = (Resolve-Path -LiteralPath $entry.Value).Path.Replace('\', '\\')
    $resourceSource = $resourceSource.Replace('@' + $entry.Key + '@', $resourcePath)
}
$iconSource = Join-Path $root 'windows\share-file\assets\app-icon.ico'
if (-not (Test-Path -LiteralPath $iconSource -PathType Leaf)) { throw "缺少应用图标：$iconSource" }
$iconResourcePath = (Resolve-Path -LiteralPath $iconSource).Path.Replace('\', '\\')
$resourceSource = $resourceSource.Replace('@APP_ICON@', $iconResourcePath)
$resourceFile = Join-Path $build 'assets.rc'
$resourceObject = Join-Path $build 'assets.res'
$resourceSource | Set-Content -LiteralPath $resourceFile -Encoding Unicode
& $resourceCompiler /nologo ('/i' + $sourceRoot) ('/fo' + $resourceObject) $resourceFile
if ($LASTEXITCODE -ne 0) { throw '原生资源编译失败。' }
$multiResourceFile = Join-Path $build 'multi-assets.rc'
$multiResourceObject = Join-Path $build 'multi-assets.res'
$multiResourceSource = (Get-Content -LiteralPath (Join-Path $sourceRoot 'multi-assets.rc.in') -Raw -Encoding UTF8).Replace('@APP_ICON@', $iconResourcePath)
$multiResourceSource | Set-Content -LiteralPath $multiResourceFile -Encoding Unicode
& $resourceCompiler /nologo ('/i' + $sourceRoot) ('/fo' + $multiResourceObject) $multiResourceFile
if ($LASTEXITCODE -ne 0) { throw '多文件图标编译失败。' }
$common = @('/nologo','/c','/TC','/W4','/O1','/GS-','/Gs9999999','/Zl','/utf-8','/DUNICODE','/D_UNICODE','/D_WIN32_WINNT=0x0601','/DWINVER=0x0601',('/I' + (Join-Path $toolRoot 'include')),('/I' + (Join-Path $include 'shared')),('/I' + (Join-Path $include 'um')),('/I' + (Join-Path $include 'ucrt')),('/I' + $sourceRoot))
$sources = @('memory','json','net','process','discovery','options','assets','selection','session','audit','config-store','device-quota','diagnostics','elevation','dpi','silent','purge','wipe','browser-extension','browser-session','adapter-account','account-window','home','host')
foreach ($source in $sources) {
    & $compiler.FullName @common ('/Fo' + (Join-Path $build ($source + '.obj'))) (Join-Path $sourceRoot ($source + '.c'))
    if ($LASTEXITCODE -ne 0) { throw "编译失败：$source" }
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
    if ($LASTEXITCODE -ne 0) { throw '原生宿主链接失败。' }
    if ($BuildConsole) {
        New-Item -ItemType Directory -Path $multiBin,(Split-Path $packageLauncher -Parent) -Force | Out-Null
        & $compiler.FullName @common /DCX_MULTI_FILE_BUILD ('/Fo' + (Join-Path $build 'assets-multi.obj')) (Join-Path $sourceRoot 'assets.c')
        if ($LASTEXITCODE -ne 0) { throw '多文件资源加载器编译失败。' }
        $multiObjects = $sources | ForEach-Object { if ($_ -eq 'assets') { Join-Path $build 'assets-multi.obj' } else { Join-Path $build ($_ + '.obj') } }
        $baseLinkArgs = $linkArgs | Where-Object { $_ -notlike '/OUT:*' }
        & $linker @baseLinkArgs ('/OUT:' + $multiHostExe) @multiObjects $multiResourceObject kernel32.lib user32.lib shell32.lib gdi32.lib comdlg32.lib ws2_32.lib advapi32.lib iphlpapi.lib version.lib
        if ($LASTEXITCODE -ne 0) { throw '多文件 GUI 链接失败。' }
        & $compiler.FullName @common ('/Fo' + (Join-Path $build 'console-launcher.obj')) (Join-Path $sourceRoot 'console-launcher.c')
        if ($LASTEXITCODE -ne 0) { throw '控制台助手编译失败。' }
        $helperLinkArgs = $baseLinkArgs | Where-Object { $_ -notlike '/ENTRY:*' -and $_ -notlike '/SUBSYSTEM:*' }
        & $linker @helperLinkArgs /ENTRY:ConsoleLauncherMain /SUBSYSTEM:CONSOLE,6.01 ('/OUT:' + $consoleHelper) (Join-Path $build 'console-launcher.obj') $multiResourceObject kernel32.lib
        if ($LASTEXITCODE -ne 0) { throw '控制台助手链接失败。' }
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
        if ($LASTEXITCODE -ne 0) { throw '多文件载荷打包失败。' }
        $packageResourceFile = Join-Path $build 'package-payload.rc'
        $packageResourceObject = Join-Path $build 'package-payload.res'
        $packageResource = $multiResourceSource + "`r`n201 RCDATA `"" + (Resolve-Path -LiteralPath $payload).Path.Replace('\', '\\') + "`"`r`n"
        $packageResource | Set-Content -LiteralPath $packageResourceFile -Encoding Unicode
        & $resourceCompiler /nologo ('/i' + $sourceRoot) ('/fo' + $packageResourceObject) $packageResourceFile
        if ($LASTEXITCODE -ne 0) { throw '包资源编译失败。' }
        & $compiler.FullName @common ('/Fo' + (Join-Path $build 'package-launcher.obj')) (Join-Path $sourceRoot 'package-launcher.c')
        if ($LASTEXITCODE -ne 0) { throw '包启动器编译失败。' }
        $packageLinkArgs = $baseLinkArgs | Where-Object { $_ -notlike '/ENTRY:*' }
        & $linker @packageLinkArgs /ENTRY:PackageLauncherMain ('/OUT:' + $packageLauncher) (Join-Path $build 'package-launcher.obj') (Join-Path $build 'memory.obj') $packageResourceObject kernel32.lib
        if ($LASTEXITCODE -ne 0) { throw '包启动器链接失败。' }
    }
    $obsoleteConsole = Join-Path $bin 'chaoxing_plus_console.exe'
    if (Test-Path -LiteralPath $obsoleteConsole -PathType Leaf) { Remove-Item -LiteralPath $obsoleteConsole -Force }
    if ($BuildTests) {
        $testObject = Join-Path $build 'injection-tests.obj'
        & $compiler.FullName @common ('/Fo' + $testObject) (Join-Path $sourceRoot 'tests\injection-tests.c')
        if ($LASTEXITCODE -ne 0) { throw '原生注入测试编译失败。' }
        $homeObjects = @('browser-extension','browser-session','adapter-account','account-window','home','device-quota')
        $testObjects = @('memory','json','process','discovery','options','assets','selection','session','audit','config-store','device-quota','diagnostics','elevation','dpi','silent','purge','wipe') + $homeObjects | ForEach-Object { Join-Path $build ($_ + '.obj') }
        $testArgs = $linkArgs | Where-Object { $_ -notlike '/OUT:*' -and $_ -notlike '/ENTRY:*' -and $_ -notlike '/MANIFESTINPUT:*' }
        & $linker @testArgs /ENTRY:InjectionTestMain ('/OUT:' + (Join-Path $bin 'injection-tests.exe')) @testObjects $testObject $resourceObject kernel32.lib user32.lib shell32.lib gdi32.lib comdlg32.lib ws2_32.lib advapi32.lib iphlpapi.lib version.lib
        if ($LASTEXITCODE -ne 0) { throw '原生注入测试链接失败。' }
        foreach ($test in @(
            @{ Name = 'console-helper-fixture'; Entry = 'ConsoleHelperFixtureMain'; Objects = @(); Resources = @() },
            @{ Name = 'browser-session-tests'; Entry = 'BrowserSessionTestMain'; Objects = @('memory','json','browser-extension','browser-session'); Resources = @() },
            @{ Name = 'adapter-account-tests'; Entry = 'WinMainCRTStartup'; Objects = @('memory','json','adapter-account'); Resources = @() },
            @{ Name = 'extension-cache-tests'; Entry = 'ExtensionCacheTestMain'; Objects = @('memory','json','adapter-account'); Resources = @() },
            @{ Name = 'account-window-tests'; Entry = 'WinMainCRTStartup'; Objects = @('memory','json','adapter-account','account-window'); Resources = @($resourceObject); Manifest = 'host.manifest' },
            @{ Name = 'home-tests'; Entry = 'HomeTestMain'; Objects = @('memory','json','options','config-store','device-quota','adapter-account'); Resources = @($resourceObject) },
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
            if ($LASTEXITCODE -ne 0) { throw "原生测试编译失败：$($test.Name)" }
            $moduleNames = @($test.Objects)
            if ($test.Name -in @('discovery-cache-host-tests','elevation-host-tests','cli-selection-tests')) { $moduleNames += $homeObjects }
            $testObjects = @($moduleNames | ForEach-Object { Join-Path $build ($_ + '.obj') })
            $testResources = $test.Resources
            $testManifest = @()
            if ($test.ContainsKey('Manifest')) { $testManifest = @('/MANIFESTINPUT:' + (Join-Path $sourceRoot $test.Manifest)) }
            $extraLibs = @()
            if ($test.ContainsKey('ExtraLibs')) { $extraLibs = @($test.ExtraLibs) }
            & $linker @testArgs @testManifest ('/ENTRY:' + $test.Entry) ('/OUT:' + (Join-Path $bin ($test.Name + '.exe'))) @testObjects $testObject @testResources kernel32.lib user32.lib gdi32.lib comdlg32.lib shell32.lib ws2_32.lib advapi32.lib iphlpapi.lib version.lib @extraLibs
            if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $bin ($test.Name + '.exe')) -PathType Leaf)) { throw "原生测试链接失败或输出缺失：$($test.Name)" }
        }
        if ($BuildConsole) {
            $multiTestObject = Join-Path $build 'multi-assets-tests.obj'
            & $compiler.FullName @common ('/Fo' + $multiTestObject) (Join-Path $sourceRoot 'tests\multi-assets-tests.c')
            if ($LASTEXITCODE -ne 0) { throw '多文件资源测试编译失败。' }
            & $linker @testArgs /ENTRY:MultiAssetTestMain ('/OUT:' + (Join-Path $bin 'multi-assets-tests.exe')) (Join-Path $build 'memory.obj') (Join-Path $build 'assets-multi.obj') $multiTestObject kernel32.lib user32.lib
            if ($LASTEXITCODE -ne 0) { throw '多文件资源测试链接失败。' }
        }
    }
} finally { $env:Path = $originalPath }
# 为兼容现有调用方保留；必需的多文件旁车文件不可跳过。
if ($SkipAssetCopy) { Write-Verbose 'SkipAssetCopy 不会省略必需的多文件资源。' }
$dumpbin = Join-Path $compiler.DirectoryName 'dumpbin.exe'
& $dumpbin /headers /imports $hostExe | Set-Content -LiteralPath (Join-Path $build 'pe-imports.txt') -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw 'PE 导入审计失败。' }
if ($BuildConsole) {
    & $dumpbin /headers /imports $consoleHelper | Set-Content -LiteralPath (Join-Path $build 'pe-imports-console.txt') -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'PE 控制台导入审计失败。' }
    & $dumpbin /headers /imports $multiHostExe | Set-Content -LiteralPath (Join-Path $build 'pe-imports-multi.txt') -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'PE 多文件导入审计失败。' }
    & $dumpbin /headers /imports $packageLauncher | Set-Content -LiteralPath (Join-Path $build 'pe-imports-package.txt') -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'PE 包导入审计失败。' }
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
    # 只删除已知的构建产物；不碰无关文件和测试 EXE。
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
# 使用系统自带的 certutil 计算哈希，避免依赖 PowerShell 模块自动加载。
# 本脚本以 UTF-8 with BOM 保存，以正确解析中文文案。
& certutil.exe -hashfile $hostExe SHA256
if ($LASTEXITCODE -ne 0) { throw 'SHA256 输出失败。' }









