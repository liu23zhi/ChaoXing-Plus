[CmdletBinding()]
param(
    [ValidateRange(1, 600)]
    [int] $TimeoutSeconds = 30,

    [ValidateRange(1, 30)]
    [int] $PollSeconds = 3
)

# Read-only IMM probe for the exam client's "input method" item.
#
# CXExam.exe keeps only layouts whose ImmGetDescriptionW is non-empty (IG5: FUN_004a2780), and Windows
# only answers for IME-marked layouts (KLID starting with E0) whose IME module loads. This script never
# installs anything: it reports the exact list the client reads, so an empty result is a real negative.
# See README.md in this directory for the usage and fake-ime/ for the stand-in input method.

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
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
    if ('CxImmProbeFixture' -as [type]) { return }
    $source = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CxImmProbeFixture {
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

    public static string[] RegisteredImeLayouts() {
        List<string> result = new List<string>();
        Microsoft.Win32.RegistryKey root = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(
            @"SYSTEM\CurrentControlSet\Control\Keyboard Layouts");
        if (root == null) return result.ToArray();
        foreach (string name in root.GetSubKeyNames()) {
            if (name.Length != 8) continue;
            Microsoft.Win32.RegistryKey key = root.OpenSubKey(name);
            if (key == null) continue;
            string imeFile = key.GetValue("IME file") as string;
            string layoutText = key.GetValue("Layout Text") as string;
            if (!String.IsNullOrEmpty(imeFile)) {
                result.Add(name.ToUpperInvariant() + "|" + imeFile + "|" + (layoutText ?? ""));
            }
            key.Close();
        }
        root.Close();
        return result.ToArray();
    }
}
'@
    Add-Type -TypeDefinition $source -ErrorAction Stop
}

function Get-ReadyRows {
    param([string[]] $Descriptions)
    return @($Descriptions | Where-Object { $_ -match '^0x[0-9a-fA-F]{8,16}=(.+)$' -and $Matches[1].Trim() -ne '<empty>' })
}

$stopwatch = [Diagnostics.Stopwatch]::StartNew()
$result = 'PROBE_TIMEOUT_IMM_NOT_READY'

try {
    Write-Event 'start' @{
        ComputerName = $env:COMPUTERNAME
        WindowsVersion = [Environment]::OSVersion.VersionString
        PowerShellVersion = $PSVersionTable.PSVersion.ToString()
        Is64BitProcess = [Environment]::Is64BitProcess
        TimeoutSeconds = $TimeoutSeconds
        PollSeconds = $PollSeconds
    }

    Initialize-ImmProbe
    $sampleIndex = 0
    while ($true) {
        $sampleIndex++
        $descriptions = @([CxImmProbeFixture]::Describe())
        $ready = @(Get-ReadyRows -Descriptions $descriptions)
        $registered = @([CxImmProbeFixture]::RegisteredImeLayouts())
        Write-Event 'sample' @{
            Data = [pscustomobject]@{
                Index = $sampleIndex
                ElapsedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
                ImmDescriptions = $descriptions
                ReadyDescriptions = $ready
                RegisteredImeLayouts = $registered
                Is64BitProcess = [Environment]::Is64BitProcess
            }
        }
        if ($ready.Count -gt 0) {
            $result = 'IMM_READY'
            break
        }
        if ($stopwatch.Elapsed.TotalSeconds -ge $TimeoutSeconds) { break }
        $remaining = $TimeoutSeconds - $stopwatch.Elapsed.TotalSeconds
        Start-Sleep -Milliseconds ([int][math]::Max(1, [math]::Min($PollSeconds * 1000, $remaining * 1000)))
    }
    Write-Event 'result' @{ Result = $result; ElapsedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1) }
} catch {
    $result = 'HARNESS_ERROR'
    Write-Event 'error' @{ Message = $_.Exception.Message; ScriptStackTrace = $_.ScriptStackTrace }
    throw
} finally {
    $stopwatch.Stop()
    $writer.Dispose()
    $summary = [ordered]@{
        Result = $result
        ElapsedSeconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
        ComputerName = $env:COMPUTERNAME
        EventsFile = $logPath
    }
    $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
    Write-Output ("RESULT={0}" -f $result)
    Write-Output ("SUMMARY={0}" -f $summaryPath)
    Write-Output ("EVENTS={0}" -f $logPath)
}
