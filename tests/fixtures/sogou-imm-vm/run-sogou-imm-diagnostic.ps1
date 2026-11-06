[CmdletBinding()]
param(
    [ValidateRange(0, 3600)]
    [int] $TimeoutSeconds = 180,

    [ValidateRange(1, 30)]
    [int] $PollSeconds = 3,

    [switch] $ProbeOnly
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$installerPath = Join-Path $scriptRoot 'sogou-ime-v16.9.0.5523.exe'
$expectedSha256 = 'B7CD6BD32A522213C4B58F958F9B6349E9F95923ADA64D7EBC8BA7FB879DDBB3'
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$outputRoot = Join-Path $scriptRoot (Join-Path 'results' $runId)
$null = New-Item -ItemType Directory -Path $outputRoot -Force
$logPath = Join-Path $outputRoot 'events.jsonl'
$summaryPath = Join-Path $outputRoot 'summary.json'
$writer = New-Object System.IO.StreamWriter($logPath, $false, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true

function Write-Event {
    param([string] $Name, [hashtable] $Data = @{})
    $entry = [ordered]@{
        timestampUtc = [DateTime]::UtcNow.ToString('o')
        event = $Name
    }
    foreach ($key in $Data.Keys) { $entry[$key] = $Data[$key] }
    $json = $entry | ConvertTo-Json -Compress -Depth 8
    $writer.WriteLine($json)
    Write-Output $json
}

function Initialize-ImmProbe {
    if ('CxSogouVmImmProbe' -as [type]) { return }
    $source = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CxSogouVmImmProbe {
    [DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int count, IntPtr[] layouts);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr LoadKeyboardLayoutW(string klid, uint flags);
    [DllImport("imm32.dll", CharSet = CharSet.Unicode)] public static extern int ImmGetDescriptionW(IntPtr layout, StringBuilder text, int cap);

    public static string Load(string klid) {
        IntPtr layout = LoadKeyboardLayoutW(klid, 0);
        return layout == IntPtr.Zero ? String.Empty : "0x" + layout.ToInt64().ToString("X8");
    }

    public static string[] Describe() {
        int count = GetKeyboardLayoutList(0, null);
        if (count <= 0) return new string[0];
        IntPtr[] layouts = new IntPtr[count];
        int read = GetKeyboardLayoutList(count, layouts);
        List<string> result = new List<string>();
        for (int i = 0; i < read; i++) {
            StringBuilder text = new StringBuilder(512);
            int length = ImmGetDescriptionW(layouts[i], text, text.Capacity);
            string description = length > 0 ? text.ToString() : "<empty>";
            result.Add("0x" + layouts[i].ToInt64().ToString("X8") + "=" + description);
        }
        return result.ToArray();
    }
}
'@
    Add-Type -TypeDefinition $source -ErrorAction Stop
}

function Get-SogouLayouts {
    $root = 'HKLM:\SYSTEM\CurrentControlSet\Control\Keyboard Layouts'
    $allImeLayouts = @()
    $sogouLayouts = @()
    if (-not (Test-Path -LiteralPath $root)) {
        return [pscustomobject]@{ AllImeLayouts = @(); SogouLayouts = @() }
    }
    foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
        $klid = [string]$key.PSChildName
        if ($klid -notmatch '^[0-9a-fA-F]{8}$') { continue }
        $values = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if (-not $values) { continue }
        $imeFile = [string]$values.'IME file'
        if ($imeFile -notmatch '\.ime$') { continue }
        $layout = [pscustomobject]@{
            Klid = $klid.ToUpperInvariant()
            ImeFile = $imeFile
            LayoutText = [string]$values.'Layout Text'
            DisplayName = [string]$values.'Layout Display Name'
        }
        $allImeLayouts += $layout
        if ("$($layout.ImeFile) $($layout.LayoutText) $($layout.DisplayName)" -match 'sogou') {
            $sogouLayouts += $layout
        }
    }
    return [pscustomobject]@{ AllImeLayouts = @($allImeLayouts); SogouLayouts = @($sogouLayouts) }
}

function Get-ProcessTree {
    param([int] $RootProcessId)
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $tracked = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$tracked.Add($RootProcessId)
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $processes) {
            $processId = [int]$process.ProcessId
            $parentId = [int]$process.ParentProcessId
            if ($tracked.Contains($parentId) -and -not $tracked.Contains($processId)) {
                [void]$tracked.Add($processId)
                $changed = $true
            }
        }
    }
    $tree = @($processes | Where-Object { $tracked.Contains([int]$_.ProcessId) } | ForEach-Object {
        [pscustomobject]@{
            ProcessId = [int]$_.ProcessId
            ParentProcessId = [int]$_.ParentProcessId
            Name = [string]$_.Name
            CreationDate = [string]$_.CreationDate
        }
    })
    return [pscustomobject]@{
        Processes = $tree
        RunningDescendants = @($tree | Where-Object { $_.ProcessId -ne $RootProcessId }).Count
    }
}

function Get-InstallSignals {
    $uninstallEntries = @()
    foreach ($root in @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            $values = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            if (-not $values) { continue }
            $identity = "$($values.DisplayName) $($values.InstallLocation) $($values.UninstallString)"
            if ($identity -match 'sogou') {
                $uninstallEntries += [pscustomobject]@{
                    Key = [string]$key.PSChildName
                    DisplayName = [string]$values.DisplayName
                    DisplayVersion = [string]$values.DisplayVersion
                    InstallLocation = [string]$values.InstallLocation
                }
            }
        }
    }
    $installDirs = @()
    foreach ($candidate in @(
        (Join-Path ${env:ProgramFiles(x86)} 'SogouInput'),
        (Join-Path $env:ProgramFiles 'SogouInput'),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'SogouInput' } else { '' })
    )) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) { $installDirs += $candidate }
    }
    return [pscustomobject]@{ UninstallEntries = $uninstallEntries; InstallDirectories = $installDirs }
}

$process = $null
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
$exitCode = $null
$result = 'TIMEOUT_IMM_NOT_READY'
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)

try {
    Write-Event 'start' @{
        ComputerName = $env:COMPUTERNAME
        WindowsVersion = [Environment]::OSVersion.VersionString
        PowerShellVersion = $PSVersionTable.PSVersion.ToString()
        Is64BitProcess = [Environment]::Is64BitProcess
        IsAdministrator = $isAdmin
        ProbeOnly = [bool]$ProbeOnly
        TimeoutSeconds = $TimeoutSeconds
        PollSeconds = $PollSeconds
        InstallerPath = $installerPath
    }

    Initialize-ImmProbe
    if (-not $ProbeOnly) {
        if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
            throw "Installer not found: $installerPath"
        }
        $actualSha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToUpperInvariant()
        Write-Event 'installer-verified' @{ Sha256 = $actualSha256; ExpectedSha256 = $expectedSha256; Match = ($actualSha256 -eq $expectedSha256) }
        if ($actualSha256 -ne $expectedSha256) { throw 'Bundled installer SHA256 mismatch; refusing to run it.' }
        $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
        Write-Event 'installer-signature' @{
            Status = [string]$signature.Status
            Signer = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { '' }
        }
        if ($signature.Status -ne 'Valid' -or [string]$signature.SignerCertificate.Subject -notmatch 'Sogou') {
            throw 'Installer Authenticode signature is invalid or is not from Sogou; refusing to run it.'
        }
        $process = Start-Process -FilePath $installerPath -ArgumentList @('/S') -PassThru -ErrorAction Stop
        Write-Event 'installer-started' @{ ProcessId = $process.Id; Arguments = '/S' }
    } else {
        Write-Event 'probe-only' @{ Note = 'No installer was started.' }
    }

    $sampleIndex = 0
    while ($true) {
        $sampleIndex++
        if ($process -and $null -eq $exitCode) {
            $process.Refresh()
            if ($process.HasExited) {
                $process.WaitForExit()
                $exitCode = $process.ExitCode
                Write-Event 'installer-exited' @{ ProcessId = $process.Id; ExitCode = $exitCode; ElapsedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1) }
            }
        }

        $layoutState = Get-SogouLayouts
        $loadAttempts = @()
        foreach ($layout in $layoutState.SogouLayouts) {
            try {
                $handle = [string][CxSogouVmImmProbe]::Load($layout.Klid)
                $loadAttempts += [pscustomobject]@{ Klid = $layout.Klid; Handle = $handle; Error = '' }
            } catch {
                $loadAttempts += [pscustomobject]@{ Klid = $layout.Klid; Handle = ''; Error = $_.Exception.Message }
            }
        }
        $descriptions = @([CxSogouVmImmProbe]::Describe())
        $readyDescriptions = @($descriptions | Where-Object { $_ -match '^0x[0-9a-fA-F]{8,16}=(.+)$' -and $Matches[1].Trim() -ne '<empty>' })
        $sogouReady = $false
        foreach ($attempt in $loadAttempts) {
            if (-not $attempt.Handle -or -not $attempt.Handle.EndsWith($attempt.Klid, [StringComparison]::OrdinalIgnoreCase)) { continue }
            foreach ($description in $descriptions) {
                if ($description -match ('^' + [regex]::Escape($attempt.Handle) + '=(.+)$') -and $Matches[1].Trim() -ne '<empty>') {
                    $sogouReady = $true
                }
            }
        }

        $tree = [pscustomobject]@{ Processes = @(); RunningDescendants = 0 }
        $rootRunning = $false
        if ($process) {
            try { $process.Refresh(); $rootRunning = -not $process.HasExited } catch { }
            try { $tree = Get-ProcessTree -RootProcessId $process.Id }
            catch { Write-Event 'process-tree-error' @{ Error = $_.Exception.Message } }
        }
        $signals = Get-InstallSignals
        $sample = [pscustomobject]@{
            Index = $sampleIndex
            ElapsedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
            InstallerProcessId = if ($process) { $process.Id } else { $null }
            InstallerRunning = $rootRunning
            InstallerExitCode = $exitCode
            RunningDescendantCount = $tree.RunningDescendants
            ProcessTree = $tree.Processes
            SogouLayouts = $layoutState.SogouLayouts
            AllImeLayouts = $layoutState.AllImeLayouts
            LoadAttempts = $loadAttempts
            ImmDescriptions = $descriptions
            AnyImmDescriptionReady = ($readyDescriptions.Count -gt 0)
            SogouImmReady = $sogouReady
            UninstallEntries = $signals.UninstallEntries
            InstallDirectories = $signals.InstallDirectories
        }
        Write-Event 'sample' @{ Data = $sample }

        if ($readyDescriptions.Count -gt 0) {
            $result = if ($sogouReady) { 'SOGOU_IMM_READY' } else { 'OTHER_IMM_DESCRIPTION_READY' }
            break
        }
        if ($stopwatch.Elapsed.TotalSeconds -ge $TimeoutSeconds) { break }
        $remaining = $TimeoutSeconds - $stopwatch.Elapsed.TotalSeconds
        Start-Sleep -Milliseconds ([int][math]::Max(1, [math]::Min($PollSeconds * 1000, $remaining * 1000)))
    }

    if ($result -eq 'TIMEOUT_IMM_NOT_READY') {
        if ($process -and $null -ne $exitCode) {
            $finalTree = Get-ProcessTree -RootProcessId $process.Id
            $result = if ($finalTree.RunningDescendants -gt 0) { 'INSTALLER_EXITED_CHILDREN_STILL_RUNNING_IMM_NOT_READY' } else { 'INSTALLER_EXITED_IMM_NOT_READY' }
        } elseif ($process) {
            $result = 'TIMEOUT_INSTALLER_STILL_RUNNING_IMM_NOT_READY'
        } else {
            $result = 'PROBE_TIMEOUT_IMM_NOT_READY'
        }
    }
    Write-Event 'result' @{ Result = $result; InstallerExitCode = $exitCode; ElapsedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1) }
} catch {
    $result = 'HARNESS_ERROR'
    Write-Event 'error' @{ Message = $_.Exception.Message; ScriptStackTrace = $_.ScriptStackTrace }
    throw
} finally {
    $stopwatch.Stop()
    if ($process) { $process.Dispose() }
    $writer.Dispose()
    $summary = [ordered]@{
        Result = $result
        InstallerExitCode = $exitCode
        ElapsedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
        ComputerName = $env:COMPUTERNAME
        IsAdministrator = $isAdmin
        EventsFile = $logPath
    }
    $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
    Write-Output ("RESULT={0}" -f $result)
    Write-Output ("SUMMARY={0}" -f $summaryPath)
    Write-Output ("EVENTS={0}" -f $logPath)
}
