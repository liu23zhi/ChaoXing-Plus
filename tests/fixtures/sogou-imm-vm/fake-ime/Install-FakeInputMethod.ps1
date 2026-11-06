[CmdletBinding()]
param(
    # KLID for the stand-in input method. The "E0" prefix is what makes Windows
    # treat the layout as an IME; the last four hex digits are the language.
    # Empty = derive from the current layout (E0F0 + its last four digits), so an
    # English-only runner gets E0F00409 and a zh-CN machine gets E0F00804. The
    # client compares exactly that suffix against the current layout.
    [string] $Klid = '',

    # Text Windows reports through ImmGetDescriptionW (registry "Layout Text").
    [string] $DisplayName = 'ExamInput',

    # IME module name. Resolved from System32 (x64) / SysWOW64 (x86).
    [string] $ImeFile = 'cxime.ime',

    [string] $LayoutFile = 'kbdus.dll',

    # Probe only. No registry writes, no elevation required.
    [switch] $Verify,

    # With -Verify: load the layout into the current session first (no registry
    # writes). Used by CI to reproduce what a 32-bit client process sees.
    [switch] $Load,

    # Remove the layout, the Preload entry and the copied modules.
    [switch] $Uninstall,

    # Skip the HKCU Preload entry (the layout then disappears at next logon).
    [switch] $NoPreload,

    # Do not make the stand-in the default input language.
    [switch] $NoDefault,

    # Optional: start the exam client after a successful install.
    [string] $ClientPath
)

$ErrorActionPreference = 'Stop'

$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$buildDir = Join-Path $here 'build'
$layoutsRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Keyboard Layouts'
$preloadKey = 'HKCU:\Keyboard Layout\Preload'

$signature = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CxImeProbe
{
    [DllImport("user32.dll")]
    public static extern int GetKeyboardLayoutList(int count, IntPtr[] layouts);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadKeyboardLayoutW(string klid, uint flags);

    [DllImport("user32.dll")]
    public static extern bool UnloadKeyboardLayout(IntPtr hkl);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SystemParametersInfoW(uint action, uint param, ref IntPtr data, uint winIni);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetKeyboardLayoutNameW(StringBuilder name);

    [DllImport("imm32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr ImmInstallIMEW(string imeFileName, string layoutText);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);

    [DllImport("imm32.dll", CharSet = CharSet.Unicode)]
    public static extern int ImmGetDescriptionW(IntPtr hkl, StringBuilder text, int capacity);

    public static string[] Rows()
    {
        int count = GetKeyboardLayoutList(0, null);
        if (count <= 0) return new string[0];
        IntPtr[] list = new IntPtr[count];
        int read = GetKeyboardLayoutList(count, list);
        List<string> rows = new List<string>();
        for (int i = 0; i < read; i++)
        {
            StringBuilder text = new StringBuilder(1024);
            int length = ImmGetDescriptionW(list[i], text, text.Capacity);
            long hkl = list[i].ToInt64() & 0xFFFFFFFFL;
            rows.Add(string.Format("{0:X8}|{1}|{2}", hkl, length, length > 0 ? text.ToString() : "<empty>"));
        }
        return rows.ToArray();
    }

    public static long LoadLayout(string klid, out int error)
    {
        IntPtr hkl = LoadKeyboardLayoutW(klid, 0);
        error = Marshal.GetLastWin32Error();
        return hkl.ToInt64() & 0xFFFFFFFFL;
    }

    public static long LoadLayoutWithFlags(string klid, uint flags, out int error)
    {
        IntPtr hkl = LoadKeyboardLayoutW(klid, flags);
        error = Marshal.GetLastWin32Error();
        return hkl.ToInt64() & 0xFFFFFFFFL;
    }

    public static bool UnloadLayout(long hkl)
    {
        return UnloadKeyboardLayout(new IntPtr(hkl));
    }

    public static bool SetDefault(long hkl)
    {
        IntPtr value = new IntPtr(hkl);
        // SPI_SETDEFAULTINPUTLANG = 0x005A, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE = 3
        return SystemParametersInfoW(0x005A, 0, ref value, 3);
    }

    public static long GetDefaultLayout()
    {
        IntPtr value = IntPtr.Zero;
        // SPI_GETDEFAULTINPUTLANG = 0x0059
        if (!SystemParametersInfoW(0x0059, 0, ref value, 0)) return 0;
        return value.ToInt64() & 0xFFFFFFFFL;
    }
}
'@

if (-not ('CxImeProbe' -as [type])) {
    Add-Type -TypeDefinition $signature -ErrorAction Stop
}

# Derive the KLID from the system default input language when the caller did not pass one: the client
# compares the last four hex digits of the layout name against its own current layout, so the suffix has
# to follow the machine (E0F00409 on an English-only runner, E0F00804 on zh-CN).
if (-not $Klid) {
    $suffix = ''
    $defaultLayout = [CxImeProbe]::GetDefaultLayout()
    if ($defaultLayout -ne 0) { $suffix = ('{0:X8}' -f $defaultLayout).Substring(4) }
    if (-not $suffix) {
        $current = New-Object System.Text.StringBuilder 32
        if (-not [CxImeProbe]::GetKeyboardLayoutNameW($current)) {
            throw 'cannot determine the current input language; pass -Klid E0F0xxxx explicitly.'
        }
        $name = $current.ToString()
        if ($name.Length -lt 4) { throw "unexpected keyboard layout name: '$name'" }
        $suffix = $name.Substring($name.Length - 4)
    }
    $Klid = 'E0F0' + $suffix
    Write-Host ("klid derived from default input language: {0}" -f $Klid)
}
$layoutKey = Join-Path $layoutsRoot $Klid
$backupPath = Join-Path $env:TEMP ("cx-fake-ime-{0}.json" -f $Klid.ToLowerInvariant())

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-LayoutRows {
    return @([CxImeProbe]::Rows())
}

function Get-LanguageFromKlid([string] $value) {
    if ($value.Length -lt 4) { return '' }
    return $value.Substring($value.Length - 4).ToLowerInvariant()
}

# True when some loaded layout is IME-marked (high nibble E), belongs to the
# requested language and reports a non-empty description - exactly what
# CXExam.exe requires.
function Test-ImeReady {
    param([string] $ExpectedKlid)

    $language = Get-LanguageFromKlid $ExpectedKlid
    $ready = @()
    foreach ($row in Get-LayoutRows) {
        $parts = $row.Split('|')
        $hkl = $parts[0]
        $length = [int]$parts[1]
        $description = $parts[2]
        if ($length -le 0) { continue }
        if (($hkl.Substring(0, 1).ToUpperInvariant()) -ne 'E') { continue }
        $hklLanguage = $hkl.Substring(4, 4).ToLowerInvariant()
        if ($language -and $hklLanguage -ne $language) { continue }
        $ready += $row
    }
    return @($ready)
}

function Show-Layouts {
    Write-Host 'GetKeyboardLayoutList / ImmGetDescriptionW:'
    foreach ($row in Get-LayoutRows) {
        $parts = $row.Split('|')
        Write-Host ("  HKL 0x{0}  length={1}  description={2}" -f $parts[0], $parts[1], $parts[2])
    }
    if ((Get-LayoutRows).Count -eq 0) {
        Write-Host '  <no layouts>'
    }
}

function Save-Backup {
    $state = [ordered]@{
        klid = $Klid
        createdAt = (Get-Date).ToString('o')
        keyExisted = (Test-Path -LiteralPath $layoutKey)
        keyValues = @{}
        preload = @{}
        modules = @()
    }
    if ($state.keyExisted) {
        $properties = Get-ItemProperty -LiteralPath $layoutKey
        foreach ($name in $properties.PSObject.Properties.Name) {
            if ($name -like 'PS*') { continue }
            $state.keyValues[$name] = [string]$properties.$name
        }
    }
    if (Test-Path -LiteralPath $preloadKey) {
        $preload = Get-ItemProperty -LiteralPath $preloadKey
        foreach ($name in $preload.PSObject.Properties.Name) {
            if ($name -like 'PS*') { continue }
            $state.preload[$name] = [string]$preload.$name
        }
    }
    foreach ($candidate in @(
        (Join-Path $env:WINDIR ("SysWOW64\" + $ImeFile)),
        (Join-Path $env:WINDIR ("System32\" + $ImeFile))
    )) {
        if (Test-Path -LiteralPath $candidate) { $state.modules += $candidate }
    }
    $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $backupPath -Encoding UTF8
    Write-Host ("backup: {0}" -f $backupPath)
}

function Install-Modules {
    $sources = @()
    # Modules are compiled in CI (build-cxime.ps1); nothing prebuilt is shipped in the repository.
    $cxime32 = Join-Path $buildDir 'cxime32.dll'
    $cxime64 = Join-Path $buildDir 'cxime64.dll'
    if ((Split-Path -Leaf $ImeFile) -eq 'cxime.ime') {
        if (Test-Path -LiteralPath $cxime32) { $sources += @{ Path = $cxime32; Target = (Join-Path $env:WINDIR ("SysWOW64\" + $ImeFile)) } }
        if (Test-Path -LiteralPath $cxime64) { $sources += @{ Path = $cxime64; Target = (Join-Path $env:WINDIR ("System32\" + $ImeFile)) } }
        if ($sources.Count -eq 0) {
            throw "No cxime modules in $buildDir. Run build-cxime.ps1 first, or pass -ImeFile <existing IME module>."
        }
    }
    foreach ($item in $sources) {
        Copy-Item -LiteralPath $item.Path -Destination $item.Target -Force
        Write-Host ("installed module: {0} (from {1})" -f $item.Target, $item.Path)
        # 1813 happens when the copy lost its VERSIONINFO; log it so a failing run explains itself.
        $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($item.Target)
        Write-Host ("  module version: description='{0}' product='{1}' file='{2}'" -f $version.FileDescription, $version.ProductName, $version.FileVersion)
    }
}

function New-LayoutKey {
    if (-not (Test-Path -LiteralPath $layoutsRoot)) {
        throw "Missing registry root: $layoutsRoot"
    }
    if (Test-Path -LiteralPath $layoutKey) {
        Write-Host ("layout key exists, updating: {0}" -f $layoutKey)
    } else {
        $null = New-Item -Path $layoutKey -Force
    }
    $null = New-ItemProperty -LiteralPath $layoutKey -Name 'Layout File' -Value $LayoutFile -PropertyType String -Force
    $null = New-ItemProperty -LiteralPath $layoutKey -Name 'Layout Text' -Value $DisplayName -PropertyType String -Force
    $null = New-ItemProperty -LiteralPath $layoutKey -Name 'IME file' -Value $ImeFile -PropertyType String -Force
    Write-Host ("layout registered: {0} (Layout Text={1}, IME file={2})" -f $Klid, $DisplayName, $ImeFile)
}

function Add-PreloadEntry {
    if (-not (Test-Path -LiteralPath $preloadKey)) {
        $null = New-Item -Path $preloadKey -Force
    }
    $preload = Get-ItemProperty -LiteralPath $preloadKey
    $indices = @()
    foreach ($name in $preload.PSObject.Properties.Name) {
        if ($name -match '^\d+$') { $indices += [int]$name }
    }
    foreach ($name in $indices) {
        if ([string]$preload.$name -eq $Klid.ToLowerInvariant()) {
            Write-Host ("preload entry already present: {0}={1}" -f $name, $Klid.ToLowerInvariant())
            return
        }
    }
    $next = 1
    if ($indices.Count -gt 0) { $next = ($indices | Measure-Object -Maximum).Maximum + 1 }
    $null = New-ItemProperty -LiteralPath $preloadKey -Name ([string]$next) -Value $Klid.ToLowerInvariant() -PropertyType String -Force
    Write-Host ("preload entry added: {0}={1}" -f $next, $Klid.ToLowerInvariant())
}

function Get-StandInLayoutKeys {
    # ImmInstallIMEW picks its own vendor digits, so uninstall has to find the keys by IME file name
    # instead of trusting the derived KLID.
    $keys = @()
    if (-not (Test-Path -LiteralPath $layoutsRoot)) { return $keys }
    foreach ($key in @(Get-ChildItem -LiteralPath $layoutsRoot -ErrorAction SilentlyContinue)) {
        $values = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if (-not $values) { continue }
        if (([string]$values.'IME file') -ieq $ImeFile) { $keys += [string]$key.PSChildName }
    }
    return $keys
}

function Remove-PreloadEntry {
    $targets = @($Klid.ToLowerInvariant())
    foreach ($extra in @(Get-StandInLayoutKeys)) { $targets += $extra.ToLowerInvariant() }
    if (-not (Test-Path -LiteralPath $preloadKey)) { return }
    $preload = Get-ItemProperty -LiteralPath $preloadKey
    foreach ($name in $preload.PSObject.Properties.Name) {
        if ($name -notmatch '^\d+$') { continue }
        if ($targets -contains ([string]$preload.$name).ToLowerInvariant()) {
            Remove-ItemProperty -LiteralPath $preloadKey -Name $name -Force
            Write-Host ("preload entry removed: {0}={1}" -f $name, $preload.$name)
        }
    }
}

function Invoke-Uninstall {
    Write-Host ("context: user={0} admin={1}" -f [Security.Principal.WindowsIdentity]::GetCurrent().Name, (Test-Admin))
    if (-not (Test-Admin)) {
        Write-Host 'uninstall needs an elevated PowerShell (writes HKLM and System32).'
        exit 2
    }
    Write-Host '== removing stand-in input method =='
    try {
        $errorCode = 0
        $handle = [CxImeProbe]::LoadLayout($Klid, [ref]$errorCode)
        if ($handle -ne 0) { $null = [CxImeProbe]::UnloadLayout($handle) }
    } catch {
        Write-Host ("unload skipped: {0}" -f $_.Exception.Message)
    }
    try { Remove-PreloadEntry } catch { Write-Host ("preload cleanup skipped: {0}" -f $_.Exception.Message) }
    $layoutKeys = @(Get-StandInLayoutKeys)
    if ($layoutKeys.Count -eq 0) { $layoutKeys = @($Klid) }
    foreach ($installedKlid in $layoutKeys) {
        $installedKey = Join-Path $layoutsRoot $installedKlid
        try {
            if (Test-Path -LiteralPath $installedKey) {
                Remove-Item -LiteralPath $installedKey -Recurse -Force -ErrorAction Stop
                Write-Host ("layout key removed: {0}" -f $installedKey)
            } else {
                Write-Host ("layout key absent: {0}" -f $installedKey)
            }
        } catch {
            Write-Host ("layout key removal failed: {0}" -f $_.Exception.Message)
        }
    }
    foreach ($candidate in @(
        (Join-Path $env:WINDIR ("SysWOW64\" + $ImeFile)),
        (Join-Path $env:WINDIR ("System32\" + $ImeFile))
    )) {
        try {
            if ((Test-Path -LiteralPath $candidate) -and ((Split-Path -Leaf $ImeFile) -eq 'cxime.ime')) {
                Remove-Item -LiteralPath $candidate -Force -ErrorAction Stop
                Write-Host ("module removed: {0}" -f $candidate)
            }
        } catch {
            Write-Host ("module removal skipped: {0}" -f $_.Exception.Message)
        }
    }
    Show-Layouts
    exit 0
}

function Invoke-Verify {
    if ($Load) {
        $loadError = 0
        $loaded = [CxImeProbe]::LoadLayout($Klid, [ref]$loadError)
        if ($loaded -eq 0) {
            Write-Host ("LoadKeyboardLayoutW({0}) failed (error {1})" -f $Klid, $loadError)
        } else {
            Write-Host ("layout loaded in this process: 0x{0:X8}" -f $loaded)
        }
    }
    Write-Host ("== probe (klid {0}, language 0x{1}) ==" -f $Klid, (Get-LanguageFromKlid $Klid))
    Show-Layouts
    $ready = @(Test-ImeReady -ExpectedKlid $Klid)
    if ($ready.Count -gt 0) {
        Write-Host 'RESULT=IME_READY'
        foreach ($row in $ready) { Write-Host ("  {0}" -f $row) }
        return 0
    }
    Write-Host 'RESULT=IME_NOT_READY'
    Write-Host 'CXExam.exe reads the same list; with no IME-marked layout and a non-empty'
    Write-Host 'description it shows "no supported input method" and fails the check.'
    return 1
}

Write-Host ("context: user={0} admin={1} ps={2} here='{3}'" -f [Security.Principal.WindowsIdentity]::GetCurrent().Name, (Test-Admin), $PSVersionTable.PSVersion, $here)

if ($Verify) {
    $code = Invoke-Verify
    exit $code
}

if ($Uninstall) {
    Invoke-Uninstall
}

# ---- install ----
if (-not (Test-Admin)) {
    Write-Host 'install needs an elevated PowerShell (writes HKLM and System32).'
    Write-Host 'Re-run this script from an Administrator window.'
    exit 2
}

Write-Host '== installing stand-in input method =='
Save-Backup
Install-Modules

# Legacy IMM layouts only load for languages that support IMEs. English-only runners reject both
# ImmInstallIMEW and LoadKeyboardLayout (error 0), so activate the built-in zh-CN layout first when the
# host can load it; then the stand-in is installed for 0804 instead of 0409.
$baseError = 0
$baseHkl = [CxImeProbe]::LoadLayoutWithFlags('00000804', 1, [ref]$baseError)   # KLF_ACTIVATE
if ($baseHkl -ne 0) {
    $Klid = 'E0F00804'
    $layoutKey = Join-Path $layoutsRoot $Klid
    Write-Host ("activated built-in zh-CN layout 0x{0:X8}; installing the stand-in for 0804" -f $baseHkl)
} else {
    Write-Host ("could not activate 00000804 (error {0}); keeping the current language {1}" -f $baseError, $Klid)
}

# Prefer the documented install path: ImmInstallIMEW writes every value Windows itself expects
# ("Layout Id", the layout text, an E0xx KLID) and returns the resulting HKL. Writing the key by hand
# left the layout unloadable (1813 / error 0).
$installedHkl = [IntPtr]::Zero
try {
    # ImmInstallIMEW wants a path that resolves from the system directory; pass the full path we copied to.
    $systemIme = Join-Path $env:WINDIR ("System32\" + $ImeFile)
    if (-not (Test-Path -LiteralPath $systemIme)) { $systemIme = $ImeFile }
    $installedHkl = [CxImeProbe]::ImmInstallIMEW($systemIme, $DisplayName)
} catch {
    Write-Host ("ImmInstallIMEW threw: {0}" -f $_.Exception.Message)
}
if ($installedHkl -ne [IntPtr]::Zero) {
    $Klid = ('{0:X8}' -f ($installedHkl.ToInt64() -band 0xFFFFFFFF))
    $layoutKey = Join-Path $layoutsRoot $Klid
    Write-Host ("ImmInstallIMEW installed '{0}' as KLID {1} (HKL 0x{2})" -f $DisplayName, $Klid, $Klid)
    # Show what Windows wrote, so a later failure points at the actual values instead of guesses.
    try {
        $created = Get-ItemProperty -LiteralPath $layoutKey -ErrorAction Stop
        foreach ($name in @('Layout File', 'Layout Text', 'Layout Id', 'Layout Display Name', 'IME file')) {
            if ($created.PSObject.Properties.Name -contains $name) {
                Write-Host ("  key {0} = {1}" -f $name, $created.$name)
            }
        }
    } catch {
        Write-Host ("  key read failed: {0}" -f $_.Exception.Message)
    }
} else {
    $installError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $installMessage = (New-Object System.ComponentModel.Win32Exception($installError)).Message
    Write-Host ("ImmInstallIMEW failed (error {0}: {1}); falling back to manual registration" -f $installError, $installMessage)
    New-LayoutKey
}
if (-not $NoPreload) { Add-PreloadEntry }

$errorCode = 0
$hkl = [CxImeProbe]::LoadLayout($Klid, [ref]$errorCode)
if ($hkl -eq 0) {
    $message = (New-Object System.ComponentModel.Win32Exception($errorCode)).Message
    Write-Host ("LoadKeyboardLayoutW failed for {0} (error {1}: {2})" -f $Klid, $errorCode, $message)
    if ($errorCode -eq 1813) {
        Write-Host 'error 1813 = the IME module has no VERSIONINFO resource; rebuild it with cxime.rc (build-cxime.ps1 does this).'
    } elseif ($errorCode -eq 1419) {
        Write-Host 'error 1419 = the layout registry entry is not readable yet.'
    }
    # KLF_SUBSTITUTE_OK (0x2) can succeed where the plain load fails on some builds.
    $hkl = [CxImeProbe]::LoadLayoutWithFlags($Klid, 2, [ref]$errorCode)
    if ($hkl -ne 0) { Write-Host ("layout loaded with KLF_SUBSTITUTE_OK: 0x{0:X8}" -f $hkl) }
}
if ($hkl -eq 0) {
    # Last resort: ask the shell to switch input language; Windows then loads the layout itself.
    $klidValue = [IntPtr][Convert]::ToInt64($Klid, 16)
    $null = [CxImeProbe]::PostMessageW([IntPtr]0xFFFF, 0x0050, [IntPtr]::Zero, $klidValue)
    Start-Sleep -Milliseconds 500
    $appeared = @([CxImeProbe]::Rows() | Where-Object { $_ -match ('^' + $Klid + '\|') })
    if ($appeared.Count -gt 0) {
        Write-Host ("layout appeared after WM_INPUTLANGCHANGEREQUEST: {0}" -f $appeared[0])
        $hkl = [Convert]::ToInt64($Klid, 16)
    }
}
if ($hkl -eq 0) {
    Write-Host 'Registry entry is present; the layout may only appear after the next logon.'
} else {
    Write-Host ("layout loaded: 0x{0:X8}" -f $hkl)
    if (-not $NoDefault) {
        if ([CxImeProbe]::SetDefault($hkl)) {
            Write-Host 'default input language set to the stand-in layout'
        } else {
            Write-Host 'setting the default input language failed; continuing'
        }
    }
}

Write-Host ''
$ready = Invoke-Verify
if ($ready -ne 0) {
    Write-Host ''
    Write-Host 'The layout is registered but Windows still reports an empty description.'
    Write-Host 'Check that the IME module exists in SysWOW64 (x86 client) and that the'
    Write-Host 'module exports the Ime* entry points.'
    if ($hkl -eq 0 -and $installedHkl -eq [IntPtr]::Zero) {
        # English-only hosts reject legacy IMM layouts outright (both APIs return NULL with error 0);
        # report it as "this host cannot host an IMM layout" instead of a tool bug.
        Write-Host '::warning::this host cannot host a legacy IMM layout (no IME-capable language); skipping readiness'
        exit 3
    }
    exit 1
}

Write-Host ''
Write-Host 'Start (or restart) the exam client so it enumerates the new layout:'
if ($ClientPath) {
    if (Test-Path -LiteralPath $ClientPath) {
        Start-Process -FilePath $ClientPath
        Write-Host ("launched: {0}" -f $ClientPath)
    } else {
        Write-Host ("client path not found: {0}" -f $ClientPath)
    }
} else {
    Write-Host '  -ClientPath "C:\path\to\CXExam.exe"'
}
exit 0
