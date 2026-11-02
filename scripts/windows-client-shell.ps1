# Restore the Windows shell after the exam client exits.
#
# The client runs desktop-level checks and hooks; after it is closed Explorer can be left in a half dead
# state: a stale explorer.exe still owns the taskbar (or the taskbar is gone entirely), so the operator
# has to restart Explorer by hand. Restarting only works when every explorer.exe is gone and the taskbar
# comes back owned by a NEW explorer process - killing a subset or trusting a stale Shell_TrayWnd keeps
# the broken desktop. Everything here is a no-op when the shell is healthy or there is no shell at all.
#
# Dot-sourced by scripts/windows-real-client-injection.ps1; keep this file pure ASCII.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class CXShellRepair {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string className, string windowName);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    public static uint TrayOwner() {
        IntPtr tray = FindWindowW("Shell_TrayWnd", null);
        if (tray == IntPtr.Zero) return 0;
        uint owner;
        GetWindowThreadProcessId(tray, out owner);
        return owner;
    }
}
'@

function Get-ShellState {
    $explorer = @(Get-Process -Name explorer -ErrorAction SilentlyContinue)
    $trayOwner = [CXShellRepair]::TrayOwner()
    $ownerAlive = $false
    if ($trayOwner -ne 0) {
        foreach ($process in $explorer) { if ($process.Id -eq $trayOwner) { $ownerAlive = $true; break } }
    }
    return [pscustomobject]@{
        Pids = @($explorer | Select-Object -ExpandProperty Id)
        TrayOwner = $trayOwner
        Tray = ($trayOwner -ne 0)
        OwnerAlive = $ownerAlive
    }
}

function Test-ShellTrayWindow {
    return ([CXShellRepair]::TrayOwner() -ne 0)
}

# Pure decision helper so the matrix can be tested without touching a live desktop.
function Get-ShellRepairAction {
    param(
        [bool] $ShellProcessRunning,
        [bool] $TrayWindowPresent,
        [bool] $TrayOwnerAlive,
        [bool] $UserInteractive
    )
    if (-not $UserInteractive -or -not $ShellProcessRunning) { return 'skip' }
    if ($TrayWindowPresent -and $TrayOwnerAlive) { return 'healthy' }
    return 'restart'
}

function Repair-ShellDesktop {
    param(
        [int] $TimeoutSeconds = 30,
        [int] $GraceSeconds = 10,
        # The client leaves desktop hooks behind even when the taskbar still looks fine, so callers that
        # ran the client ask for a restart unconditionally; a missing shell is still left alone.
        [switch] $Force,
        [switch] $WhatIf
    )
    $state = Get-ShellState
    $action = Get-ShellRepairAction -ShellProcessRunning ($state.Pids.Count -gt 0) -TrayWindowPresent $state.Tray `
        -TrayOwnerAlive $state.OwnerAlive -UserInteractive ([Environment]::UserInteractive)
    if ($Force -and $action -eq 'healthy') { $action = 'restart' }
    $base = [pscustomobject]@{
        Action = $action; Restarted = $false; Tray = $state.Tray; OwnerPid = $state.TrayOwner
        OldPids = ($state.Pids -join ','); ManualStart = $false; Forced = [bool]$Force
    }
    if ($action -eq 'skip') { return $base }
    if ($WhatIf) { return $base }

    foreach ($processId in $state.Pids) {
        try { Stop-Process -Id $processId -Force -ErrorAction Stop } catch { }
    }

    # A restart only counts when the taskbar belongs to an explorer process that did not exist before.
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $grace = (Get-Date).AddSeconds($GraceSeconds)
    $manualStart = $false
    while ((Get-Date) -lt $deadline) {
        $now = Get-ShellState
        $fresh = @($now.Pids | Where-Object { $state.Pids -notcontains $_ })
        if ($now.Tray -and $now.OwnerAlive -and $fresh.Count -gt 0) {
            return [pscustomobject]@{
                Action = 'restart'; Restarted = $true; Tray = $true; OwnerPid = $now.TrayOwner
                OldPids = ($state.Pids -join ','); ManualStart = $manualStart; Forced = [bool]$Force
            }
        }
        if (-not $manualStart -and (Get-Date) -ge $grace) {
            try { Start-Process -FilePath 'explorer.exe' | Out-Null } catch { }
            $manualStart = $true
        }
        Start-Sleep -Milliseconds 500
    }
    $now = Get-ShellState
    return [pscustomobject]@{
        Action = 'restart'; Restarted = $false; Tray = $now.Tray; OwnerPid = $now.TrayOwner
        OldPids = ($state.Pids -join ','); ManualStart = $manualStart; Forced = [bool]$Force
    }
}
