# Capture and restore the Windows input state around a real-client run.
#
# The exam client probes the installed input methods and switches keyboard layouts for its own window.
# After the client is killed the operator can be left with a different input method than before the run,
# so the injection script snapshots the state first and puts it back afterwards:
#   * HKCU\Keyboard Layout\Preload / Substitutes (the installed input methods),
#   * the user language list (Get-WinUserLanguageList / Set-WinUserLanguageList),
#   * the active keyboard layout (ActivateKeyboardLayout).
# Everything is best effort and logged; an unchanged environment produces a no-op restore.
#
# Dot-sourced by scripts/windows-real-client-injection.ps1; keep this file pure ASCII.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class CXInputState {
    [DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int count, [Out] IntPtr[] layouts);
    [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);
    [DllImport("user32.dll")] public static extern IntPtr ActivateKeyboardLayout(IntPtr layout, uint flags);
    [DllImport("user32.dll")] public static extern bool UnloadKeyboardLayout(IntPtr layout);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadKeyboardLayoutW(string klid, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    public static string[] LayoutHandles() {
        int count = GetKeyboardLayoutList(0, null);
        if (count <= 0) return new string[0];
        IntPtr[] layouts = new IntPtr[count];
        int read = GetKeyboardLayoutList(count, layouts);
        string[] result = new string[read > 0 ? read : 0];
        for (int i = 0; i < result.Length; i++) result[i] = "0x" + layouts[i].ToInt64().ToString("X8");
        return result;
    }

    public static string ActiveLayout() {
        return "0x" + GetKeyboardLayout(GetCurrentThreadId()).ToInt64().ToString("X8");
    }

    public static bool Activate(string handle) {
        if (string.IsNullOrEmpty(handle)) return false;
        long value = Convert.ToInt64(handle.Substring(2), 16);
        return ActivateKeyboardLayout(new IntPtr(value), 0) != IntPtr.Zero;
    }

    public static bool Unload(string handle) {
        if (string.IsNullOrEmpty(handle)) return false;
        long value = Convert.ToInt64(handle.Substring(2), 16);
        return UnloadKeyboardLayout(new IntPtr(value));
    }

    // HKL 0x04090409 -> KLID 00000409: the low word identifies the layout.
    public static string KlidFromHkl(string handle) {
        if (string.IsNullOrEmpty(handle)) return string.Empty;
        long value = Convert.ToInt64(handle.Substring(2), 16);
        return (value & 0xFFFF).ToString("X8");
    }

    public static bool Load(string klid) {
        if (string.IsNullOrEmpty(klid)) return false;
        return LoadKeyboardLayoutW(klid, 0) != IntPtr.Zero;
    }
}
'@

function Get-RegistryInputKeys {
    param([string] $Path)
    $result = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Path)) { return $result }
    $item = Get-ItemProperty -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $item) { return $result }
    foreach ($property in $item.PSObject.Properties) {
        if ($property.Name -like 'PS*') { continue }
        $result[$property.Name] = [string]$property.Value
    }
    return $result
}

function Get-InputState {
    $state = [ordered]@{
        Preload = Get-RegistryInputKeys -Path 'HKCU:\Keyboard Layout\Preload'
        Substitutes = Get-RegistryInputKeys -Path 'HKCU:\Keyboard Layout\Substitutes'
        LayoutHandles = @([CXInputState]::LayoutHandles())
        ActiveLayout = [CXInputState]::ActiveLayout()
        Languages = @()
        LanguageEntries = @()
        CurrentLanguage = ''
    }
    try {
        if (Get-Command Get-WinUserLanguageList -ErrorAction SilentlyContinue) {
            $entries = @()
            foreach ($item in Get-WinUserLanguageList) {
                $tips = @($item.InputMethodTips | Sort-Object)
                $entries += [pscustomobject]@{ Tag = [string]$item.LanguageTag; Tips = @($tips) }
                $state.Languages += "$($item.LanguageTag):" + ($tips -join ',')
            }
            $state.LanguageEntries = @($entries)
            if ($state.Languages.Count -gt 0) { $state.CurrentLanguage = [string]$state.Languages[0] }
        }
    } catch { }
    return [pscustomobject]$state
}

function Compare-InputState {
    param($Before, $After)
    $changes = @()
    foreach ($name in @('Preload', 'Substitutes')) {
        # Note: PowerShell is case-insensitive, so these must not be called $before/$after - that would
        # overwrite the $Before/$After parameters and silently disable the checks below.
        $leftSide = $Before.$name
        $rightSide = $After.$name
        $beforeKeys = @($leftSide.Keys | Sort-Object)
        $afterKeys = @($rightSide.Keys | Sort-Object)
        if (($beforeKeys -join ',') -ne ($afterKeys -join ',')) { $changes += "$name-keys"; continue }
        foreach ($key in $beforeKeys) {
            if ([string]$leftSide[$key] -ne [string]$rightSide[$key]) { $changes += "$name[$key]" }
        }
    }
    if ((([string[]]$Before.LayoutHandles) -join ',') -ne (([string[]]$After.LayoutHandles) -join ',')) { $changes += 'layouts' }
    if ((([string[]]$Before.Languages) -join ',') -ne (([string[]]$After.Languages) -join ',')) { $changes += 'languages' }
    if ($Before.ActiveLayout -ne $After.ActiveLayout) { $changes += 'active-layout' }
    return @($changes)
}

function Restore-InputState {
    param(
        [Parameter(Mandatory = $true)] $State
    )
    $restored = @()

    # Languages first: Set-WinUserLanguageList rewrites HKCU\Keyboard Layout\Preload from scratch, so the
    # registry snapshot has to be written back afterwards or the restore is silently reverted.
    try {
        $entries = @($State.LanguageEntries)
        if ($entries.Count -gt 0 -and (Get-Command Set-WinUserLanguageList -ErrorAction SilentlyContinue)) {
            $now = @(Get-WinUserLanguageList | ForEach-Object { $tips = @($_.InputMethodTips | Sort-Object); "$($_.LanguageTag):" + ($tips -join ',') })
            if (($now -join ',') -ne ((([string[]]$State.Languages)) -join ',')) {
                # New-WinUserLanguageList only accepts one language per call on this build; passing an
                # array silently yields an empty list, and an empty list clears every language.
                $list = New-Object 'System.Collections.Generic.List[Microsoft.InternationalSettings.Commands.WinUserLanguage]'
                foreach ($entry in $entries) {
                    $single = New-WinUserLanguageList -Language $entry.Tag
                    if (-not $single -or $single.Count -eq 0) { continue }
                    $item = $single[0]
                    if (@($entry.Tips).Count -gt 0) {
                        $item.InputMethodTips.Clear()
                        foreach ($tip in @($entry.Tips)) { $item.InputMethodTips.Add([string]$tip) }
                    }
                    $list.Add($item)
                }
                if ($list.Count -eq 0) { throw 'rebuilt language list is empty; refusing to clear the configured languages' }
                Set-WinUserLanguageList -LanguageList $list -Force -ErrorAction Stop
                $restored += 'languages'
            }
        }
    } catch {
        Write-Host "[real-client] input restore failed for languages: $($_.Exception.Message)"
    }

    foreach ($name in @('Preload', 'Substitutes')) {
        $path = "HKCU:\Keyboard Layout\$name"
        $wanted = $State.$name
        $wantedKeys = @($wanted.Keys | Sort-Object)
        $current = Get-RegistryInputKeys -Path $path
        $currentKeys = @($current.Keys | Sort-Object)
        $dirty = ($wantedKeys -join ',') -ne ($currentKeys -join ',')
        if (-not $dirty) {
            foreach ($key in $wantedKeys) { if ([string]$wanted[$key] -ne [string]$current[$key]) { $dirty = $true; break } }
        }
        if (-not $dirty) { continue }
        try {
            if (-not (Test-Path -LiteralPath $path)) { New-Item -Path $path -Force | Out-Null }
            foreach ($key in @($current.Keys)) { if ($wantedKeys -notcontains $key) { Remove-ItemProperty -LiteralPath $path -Name $key -ErrorAction SilentlyContinue } }
            foreach ($key in $wantedKeys) { Set-ItemProperty -LiteralPath $path -Name $key -Value $wanted[$key] -ErrorAction Stop }
            $restored += $name
        } catch {
            Write-Host "[real-client] input restore failed for ${name}: $($_.Exception.Message)"
        }
    }

    try {
        if ($State.ActiveLayout -and ([CXInputState]::ActiveLayout() -ne $State.ActiveLayout)) {
            if ([CXInputState]::Activate($State.ActiveLayout)) { $restored += 'active-layout' }
        }
    } catch { }

    # The client can load a layout of its own (LoadKeyboardLayout) and leave it behind when killed, and
    # restoring the language list can drop a layout that was loaded before the run. Put both right.
    try {
        $keep = @([string[]]$State.LayoutHandles)
        $current = @([CXInputState]::LayoutHandles())
        foreach ($handle in $current) {
            if ($keep -contains $handle) { continue }
            if ([CXInputState]::Unload($handle)) { $restored += "unloaded:$handle" }
        }
        $present = @([CXInputState]::LayoutHandles())
        foreach ($handle in $keep) {
            if ($present -contains $handle) { continue }
            $klid = [CXInputState]::KlidFromHkl($handle)
            if ([CXInputState]::Load($klid)) { $restored += "loaded:$handle" }
        }
    } catch { }
    return @($restored)
}