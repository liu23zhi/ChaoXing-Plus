# Build the winmm proxy DLL (x86). Output: build-windows/hook/winmm.dll
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$source = Join-Path $PSScriptRoot 'winmm-proxy.c'
$def = Join-Path $PSScriptRoot 'winmm-proxy.def'
$out = Join-Path $root 'build-windows/hook'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vsPath = $null
if (Test-Path $vswhere) { $vsPath = & $vswhere -latest -products * -property installationPath }
if (-not $vsPath) { throw 'Visual Studio installation not found' }
$msvc = Get-ChildItem (Join-Path $vsPath 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$cl = Join-Path $msvc.FullName 'bin/Hostx64/x86/cl.exe'
$link = Join-Path $msvc.FullName 'bin/Hostx64/x86/link.exe'
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdkVer = Get-ChildItem (Join-Path $sdkRoot 'Lib') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$sdkLib = Join-Path $sdkVer.FullName 'um/x86'
$sdkInc = Join-Path $sdkRoot ('Include/' + $sdkVer.Name + '/um')
$sdkShared = Join-Path $sdkRoot ('Include/' + $sdkVer.Name + '/shared')
$ucrt = Join-Path $sdkRoot ('Include/' + $sdkVer.Name + '/ucrt')
$obj = Join-Path $out 'winmm-proxy.obj'
& $cl /nologo /c /TC /O1 /GS- /utf-8 /DUNICODE /D_UNICODE ('/I' + (Join-Path $msvc.FullName 'include')) ('/I' + $sdkInc) ('/I' + $sdkShared) ('/I' + $ucrt) ('/Fo' + $obj) $source
if ($LASTEXITCODE -ne 0) { throw 'compile failed' }
& $link /NOLOGO /DLL /NODEFAULTLIB /ENTRY:DllMain /MACHINE:X86 ('/DEF:' + $def) ('/OUT:' + (Join-Path $out 'winmm.dll')) $obj ('/LIBPATH:' + $sdkLib) kernel32.lib
if ($LASTEXITCODE -ne 0) { throw 'link failed' }
Get-Item (Join-Path $out 'winmm.dll') | Select-Object FullName, Length
