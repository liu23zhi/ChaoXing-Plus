[CmdletBinding()]
param(
    # KLID for the control layout that points at a Microsoft-shipped IME.
    [string] $SystemKlid = 'E0F10804',
    [string] $SystemImeFile = 'msctfime.ime',

    # KLID for the stand-in module built by build-cxime.ps1.
    [string] $StandInKlid = 'E0F20804',
    [string] $StandInImeFile = 'cxime.ime',

    [string] $LayoutFile = 'kbdus.dll'
)

# Read-only A/B probe: register a temporary layout for the Microsoft IME and for the stand-in module,
# try to load each one, and print the result. If the system IME also fails, the IME subsystem itself is
# unusable (usually a pending reboot or a missing East Asian language payload); if only the stand-in
# fails, the module is the problem. The temporary keys are removed afterwards.

$ErrorActionPreference = 'Stop'

$signature = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class CxImeLoadProbe
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadKeyboardLayoutW(string klid, uint flags);

    [DllImport("user32.dll")]
    public static extern bool UnloadKeyboardLayout(IntPtr hkl);

    [DllImport("imm32.dll", CharSet = CharSet.Unicode)]
    public static extern int ImmGetDescriptionW(IntPtr hkl, StringBuilder text, int capacity);
}
'@

if (-not ('CxImeLoadProbe' -as [type])) {
    Add-Type -TypeDefinition $signature -ErrorAction Stop
}

function Test-ImeCandidate {
    param([string] $CandidateKlid, [string] $CandidateIme)

    $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Keyboard Layouts\' + $CandidateKlid
    $created = $false
    try {
        if (-not (Test-Path -LiteralPath $key)) {
            $null = New-Item -Path $key -Force
            $created = $true
        }
        $null = New-ItemProperty -LiteralPath $key -Name 'Layout File' -Value $LayoutFile -PropertyType String -Force
        $null = New-ItemProperty -LiteralPath $key -Name 'Layout Text' -Value ('Diag' + $CandidateKlid) -PropertyType String -Force
        $null = New-ItemProperty -LiteralPath $key -Name 'IME file' -Value $CandidateIme -PropertyType String -Force

        $handle = [CxImeLoadProbe]::LoadKeyboardLayoutW($CandidateKlid, 2)
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $text = New-Object System.Text.StringBuilder 260
        $length = [CxImeLoadProbe]::ImmGetDescriptionW([IntPtr]$handle, $text, 260)
        Write-Host ("probe {0} <- {1}: hkl=0x{2:X8} error={3} description-length={4} text='{5}'" -f `
            $CandidateKlid, $CandidateIme, $handle.ToInt64(), $errorCode, $length, $text.ToString())
        if ($handle -ne [IntPtr]::Zero) {
            $null = [CxImeLoadProbe]::UnloadKeyboardLayout($handle)
            return $true
        }
        return $false
    } catch {
        Write-Host ("probe {0} failed: {1}" -f $CandidateKlid, $_.Exception.Message)
        return $false
    } finally {
        if ($created) {
            try { Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction Stop } catch { }
        }
    }
}

$systemLoaded = Test-ImeCandidate -CandidateKlid $SystemKlid -CandidateIme $SystemImeFile
$standInLoaded = Test-ImeCandidate -CandidateKlid $StandInKlid -CandidateIme $StandInImeFile

if (-not $systemLoaded -and -not $standInLoaded) {
    $diagnosis = 'no legacy IME layout can be loaded on this host; the IME subsystem is unavailable'
} elseif ($systemLoaded -and -not $standInLoaded) {
    $diagnosis = 'the system IME loads but the stand-in module does not; inspect cxime.ime'
} else {
    $diagnosis = 'legacy IME layouts load on this host'
}
Write-Host ('diagnosis: ' + $diagnosis)
# Job logs need authentication; annotations are readable, so surface the verdict there too.
Write-Host ('::warning::IME probe: system=' + $systemLoaded + ' stand-in=' + $standInLoaded + '; ' + $diagnosis)

exit 0
