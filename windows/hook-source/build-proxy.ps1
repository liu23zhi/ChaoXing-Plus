param([string]$Target = 'winmm')
# Build the <Target> proxy DLL (x86) with full export forwarding.
# The client ships ~50 winmm imports across libcef/Flash/pdf modules, so every
# system export gets a stub that jumps to the real function loaded from System32.
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$out = Join-Path $root 'build-windows/hook'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path $vswhere)) { throw 'vswhere not found' }
$vsPath = & $vswhere -latest -products * -property installationPath
if (-not $vsPath) { throw 'Visual Studio installation not found' }
$msvc = Get-ChildItem (Join-Path $vsPath 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$cl = Join-Path $msvc.FullName 'bin/Hostx64/x86/cl.exe'
$link = Join-Path $msvc.FullName 'bin/Hostx64/x86/link.exe'
$dumpbin = Join-Path $msvc.FullName 'bin/Hostx64/x86/dumpbin.exe'
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10'
$sdkVer = Get-ChildItem (Join-Path $sdkRoot 'Lib') -Directory | Sort-Object Name -Descending | Select-Object -First 1
$sdkLib = Join-Path $sdkVer.FullName 'um/x86'
$sdkInc = Join-Path $sdkRoot ('Include/' + $sdkVer.Name + '/um')
$sdkShared = Join-Path $sdkRoot ('Include/' + $sdkVer.Name + '/shared')
$ucrt = Join-Path $sdkRoot ('Include/' + $sdkVer.Name + '/ucrt')
$msvcInc = Join-Path $msvc.FullName 'include'
$systemWinmm = Join-Path $env:WINDIR ('System32/' + $Target + '.dll')

$exportText = & $dumpbin /exports $systemWinmm 2>&1 | Out-String
$names = @()
foreach ($m in [regex]::Matches($exportText, '(?m)^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)\s*$')) {
  $names += $m.Groups[1].Value
}
$names = @($names | Sort-Object -Unique)
if ($names.Count -lt 2) { throw ('unexpected ' + $Target + ' export count: ' + $names.Count) }

# Generated stub source: one naked jump per export through a table filled in DllMain.
$stubLines = New-Object System.Collections.Generic.List[string]
$stubLines.Add('#include <windows.h>')
$stubLines.Add('')
$stubLines.Add('FARPROC g_winmm_table[' + $names.Count + '];')
$stubLines.Add('const char *g_winmm_names[' + $names.Count + '] = {')
for ($i = 0; $i -lt $names.Count; ++$i) {
  $stubLines.Add('    "' + $names[$i] + '",')
}
$stubLines.Add('};')
$stubLines.Add('')
$stubLines.Add('int g_winmm_count = ' + $names.Count + ';')
$stubLines.Add('int __cdecl winmm_missing(void) { return 0; }')
$stubLines.Add('')
for ($i = 0; $i -lt $names.Count; ++$i) {
  $stubLines.Add('__declspec(naked) void winmm_stub_' + $i + '(void) { __asm { jmp dword ptr [g_winmm_table + ' + ($i * 4) + '] } }')
}
Set-Content -LiteralPath (Join-Path $out ($Target + '-stubs.c')) -Value $stubLines -Encoding ascii

$defLines = New-Object System.Collections.Generic.List[string]
$defLines.Add('LIBRARY ' + $Target)
$defLines.Add('EXPORTS')
for ($i = 0; $i -lt $names.Count; ++$i) {
  $defLines.Add('    ' + $names[$i] + '=winmm_stub_' + $i)
}
$defPath = Join-Path $out ($Target + '-proxy.generated.def')
Set-Content -LiteralPath $defPath -Value $defLines -Encoding ascii
Write-Output ('forwarded exports: ' + $names.Count)

$includes = @(('/I' + $msvcInc), ('/I' + $sdkInc), ('/I' + $sdkShared), ('/I' + $ucrt))
$proxyObj = Join-Path $out ($Target + '-proxy.obj')
$stubObj = Join-Path $out ($Target + '-stubs.obj')
& $cl /nologo /c /TC /O1 /GS- /utf-8 /DUNICODE /D_UNICODE ('/DCX_PROXY_TARGET_DLL=L\"' + $Target + '.dll\"') @includes ('/Fo' + $proxyObj) (Join-Path $PSScriptRoot 'winmm-proxy.c')
if ($LASTEXITCODE -ne 0) { throw 'compile proxy failed' }
& $cl /nologo /c /TC /O1 /GS- /utf-8 @includes ('/Fo' + $stubObj) (Join-Path $out ($Target + '-stubs.c'))
if ($LASTEXITCODE -ne 0) { throw 'compile stubs failed' }
$dll = Join-Path $out ($Target + '.dll')
& $link /NOLOGO /DLL /NODEFAULTLIB /ENTRY:DllMain /MACHINE:X86 ('/DEF:' + $defPath) ('/OUT:' + $dll) $proxyObj $stubObj ('/LIBPATH:' + $sdkLib) kernel32.lib
if ($LASTEXITCODE -ne 0) { throw 'link failed' }
Get-Item $dll | Select-Object FullName, Length
# Self test exe: loads the proxy and checks exports, jump table and log file.
New-Item -ItemType Directory -Force -Path (Join-Path $out 'tests') | Out-Null
$testObj = Join-Path $out 'tests/proxy-test.obj'
& $cl /nologo /c /TC /O1 /GS- /Gs9999999 /utf-8 @includes ('/Fo' + $testObj) (Join-Path $PSScriptRoot 'tests/proxy-test.c')
if ($LASTEXITCODE -ne 0) { throw 'compile test failed' }
$testExe = Join-Path $out 'tests/proxy-test.exe'
& $link /NOLOGO /NODEFAULTLIB /SUBSYSTEM:CONSOLE /ENTRY:ProxyTestMain /MACHINE:X86 ('/OUT:' + $testExe) $testObj ('/LIBPATH:' + $sdkLib) kernel32.lib
if ($LASTEXITCODE -ne 0) { throw 'link test failed' }
Get-Item $testExe | Select-Object FullName, Length







