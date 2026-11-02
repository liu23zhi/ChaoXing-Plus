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
        CurrentLanguage = ''
    }
    try {
        if (Get-Command Get-WinUserLanguageList -ErrorAction SilentlyContinue) {
            $state.Languages = @(Get-WinUserLanguageList | ForEach-Object { $tips = @($_.InputMethodTips | Sort-Object); "$($_.LanguageTag):" + ($tips -join ",") })
            if ($state.Languages.Count -gt 0) { $state.CurrentLanguage = [string]$state.Languages[0] }
        }
    } catch { }
    return [pscustomobject]$state
}

function Compare-InputState {
    param($Before, $After)
    $changes = @()
    foreach ($name in @('Preload', 'Substitutes')) {
        $before = $Before.$name
        $after = $After.$name
        $beforeKeys = @($before.Keys | Sort-Object)
        $afterKeys = @($after.Keys | Sort-Object)
        if (($beforeKeys -join ',') -ne ($afterKeys -join ',')) { $changes += "$name-keys"; continue }
        foreach ($key in $beforeKeys) {
            if ([string]$before[$key] -ne [string]$after[$key]) { $changes += "$name[$key]" }
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
        if ($State.Languages.Count -gt 0 -and (Get-Command Set-WinUserLanguageList -ErrorAction SilentlyContinue)) {
            $now = @(Get-WinUserLanguageList | ForEach-Object { $tips = @($_.InputMethodTips | Sort-Object); "$($_.LanguageTag):" + ($tips -join ",") })
            if (($now -join ',') -ne ((([string[]]$State.Languages)) -join ',')) {
                $list = New-WinUserLanguageList -Language ($State.Languages[0].Split(':')[0])
                Set-WinUserLanguageList -LanguageList $list -Force -ErrorAction Stop
                $restored += 'languages'
            }
        }
    } catch {
        Write-Host "[real-client] input restore failed for languages: $($_.Exception.Message)"
    }
    try {
        if ($State.ActiveLayout -and ([CXInputState]::ActiveLayout() -ne $State.ActiveLayout)) {
            if ([CXInputState]::Activate($State.ActiveLayout)) { $restored += 'active-layout' }
        }
    } catch { }
    # The client can load a layout of its own (LoadKeyboardLayout) and leave it behind when killed.
    try {
        $keep = @([string[]]$State.LayoutHandles)
        foreach ($handle in @([CXInputState]::LayoutHandles())) {
            if ($keep -contains $handle) { continue }
            if ([CXInputState]::Unload($handle)) { $restored += "unloaded:$handle" }
        }
    } catch { }
    return @($restored)
}
