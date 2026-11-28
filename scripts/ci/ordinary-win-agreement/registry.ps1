[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Register', 'Unregister')][string]$Action,
    [Parameter(Mandatory)][ValidatePattern('^org\.cxplus\.t04_[0-9a-f]{32}$')][string]$Name,
    [Parameter(Mandatory)][string]$Manifest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'Native messaging registration is only available in ephemeral hosted Windows CI.'
}

$Manifest = [IO.Path]::GetFullPath($Manifest)
$temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$native = [IO.Path]::GetDirectoryName($Manifest)
$fixture = [IO.Path]::GetDirectoryName($native)
if ([IO.Path]::GetFileName($Manifest) -cne 'native-host.json' -or [IO.Path]::GetFileName($native) -cne 'native' -or
    [IO.Path]::GetFileName($fixture) -cnotmatch '^cx-t04-owned-[a-zA-Z0-9]+$' -or
    [IO.Path]::GetDirectoryName($fixture) -ine $temp -or -not [IO.File]::Exists($Manifest)) {
    throw 'Unexpected owned native-messaging manifest path.'
}
foreach ($path in @($fixture, $native, $Manifest)) {
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Unexpected reparse point in the owned fixture.'
    }
}

$ancestors = @('Software', 'Software\Google', 'Software\Google\Chrome', 'Software\Google\Chrome\NativeMessagingHosts')
$leafPath = $ancestors[-1] + '\' + $Name
$receipt = [IO.Path]::Combine($native, 'registry-parents.json')
$hkcu = [Microsoft.Win32.RegistryHive]::CurrentUser
$narrow = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hkcu, [Microsoft.Win32.RegistryView]::Registry32)
$wide = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hkcu, [Microsoft.Win32.RegistryView]::Registry64)

function Test-Key($View, [string]$Path) {
    $handle = $View.OpenSubKey($Path)
    if ($null -eq $handle) { return $false }
    $handle.Dispose()
    return $true
}

function Remove-Owned([string[]]$Parents, [bool]$PermitEmptyLeaf) {
    foreach ($parent in $Parents) {
        if ($parent -cnotin $ancestors) { throw 'Unexpected owned registry parent.' }
    }
    $leaf = $narrow.OpenSubKey($leafPath)
    if ($null -ne $leaf) {
        try {
            $names = @($leaf.GetValueNames())
            $exact = $names.Count -eq 1 -and $names[0] -ceq '' -and $leaf.GetValue('') -ceq $Manifest
            if ($leaf.SubKeyCount -ne 0 -or -not ($exact -or ($PermitEmptyLeaf -and $names.Count -eq 0))) {
                throw 'Refusing to remove a changed registry key.'
            }
        } finally { $leaf.Dispose() }
        $narrow.DeleteSubKey($leafPath, $true)
    }
    if ((Test-Key $narrow $leafPath) -or (Test-Key $wide $leafPath)) { throw 'Owned registry key remains.' }
    for ($i = $ancestors.Length - 1; $i -ge 0; $i--) {
        $parent = $ancestors[$i]
        if ($parent -cnotin $Parents) { continue }
        $handle = $narrow.OpenSubKey($parent)
        if ($null -eq $handle) { continue }
        try { $empty = $handle.SubKeyCount -eq 0 -and $handle.ValueCount -eq 0 }
        finally { $handle.Dispose() }
        if ($empty) { $narrow.DeleteSubKey($parent, $true) }
    }
}

try {
    if ($Action -ceq 'Unregister') {
        if ([IO.File]::Exists($receipt)) {
            if ((Get-Item -LiteralPath $receipt).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Unexpected registry receipt reparse point.'
            }
            # Windows PowerShell 5.1 already returns the JSON array as one object.
            # Re-wrapping its pipeline output nests it and breaks parent validation.
            [string[]]$created = ([IO.File]::ReadAllText($receipt) | ConvertFrom-Json)
            Remove-Owned $created $true
            [IO.File]::Delete($receipt)
        } elseif ((Test-Key $narrow $leafPath) -or (Test-Key $wide $leafPath)) {
            throw 'Unexpected owned registry key without a cleanup receipt.'
        }
        Write-Output 'removed'
    } else {
        if ([IO.File]::Exists($receipt) -or (Test-Key $narrow $leafPath) -or (Test-Key $wide $leafPath)) {
            throw 'Temporary native host name or receipt already exists.'
        }
        $created = @($ancestors | Where-Object { -not (Test-Key $narrow $_) })
        # Record parent ownership before touching the registry, so a killed
        # registration process can still be cleaned up by the caller.
        [IO.File]::WriteAllText($receipt, (ConvertTo-Json -InputObject $created -Compress))
        try {
            $leaf = $narrow.CreateSubKey($leafPath)
            try {
                $leaf.SetValue('', $Manifest, [Microsoft.Win32.RegistryValueKind]::String)
                if ($leaf.GetValue('') -cne $Manifest) { throw 'Native host registration did not round trip.' }
            } finally { $leaf.Dispose() }
        } catch {
            Remove-Owned $created $true
            [IO.File]::Delete($receipt)
            throw
        }
        Write-Output 'registered'
    }
} finally {
    $wide.Dispose()
    $narrow.Dispose()
}
