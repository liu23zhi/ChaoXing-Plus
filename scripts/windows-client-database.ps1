# Install the private exam database that the real-client injection job needs.
#
# Payload contract: a repository variable named Examination_Client_Database_* holds the Base64
# text of the raw UserExamInfo.db file. The payload is decoded and written unchanged into the
# directory that already contains CXExam.exe. No archive format is accepted or unpacked.
#
# Dot-sourced by scripts/windows-real-client-injection.ps1; keep this file pure ASCII because
# Windows PowerShell 5.1 decodes BOM-less scripts with the ANSI code page.

$script:ClientDatabaseSqliteMagic = [byte[]](0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33)

function ConvertTo-ClientDatabaseBytes {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Base64
    )
    $compact = $Base64 -replace '\s', ''
    if ([string]::IsNullOrEmpty($compact)) { throw 'Database Base64 payload is empty' }
    if (($compact.Length % 4) -ne 0 -or $compact -notmatch '^[A-Za-z0-9+/]+={0,2}$') {
        throw 'Database Base64 payload is not valid Base64 text'
    }
    try {
        $decoded = [Convert]::FromBase64String($compact)
    } catch {
        throw "Database Base64 payload cannot be decoded: $($_.Exception.Message)"
    }
    if ($decoded.Length -eq 0) { throw 'Decoded UserExamInfo.db is empty' }
    return ,$decoded
}

function Test-SqliteDatabaseFile {
    param(
        [Parameter(Mandatory = $true)][byte[]] $Bytes
    )
    if ($Bytes.Length -lt $script:ClientDatabaseSqliteMagic.Length) { return $false }
    for ($index = 0; $index -lt $script:ClientDatabaseSqliteMagic.Length; $index++) {
        if ($Bytes[$index] -ne $script:ClientDatabaseSqliteMagic[$index]) { return $false }
    }
    return $true
}

function Install-ClientDatabase {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string] $ClientDirectory,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string] $Base64
    )
    if (-not (Test-Path -LiteralPath $ClientDirectory -PathType Container)) {
        throw "Client directory is missing: $ClientDirectory"
    }
    $clientPath = Join-Path $ClientDirectory 'CXExam.exe'
    if (-not (Test-Path -LiteralPath $clientPath -PathType Leaf)) {
        throw "Client directory has no CXExam.exe: $ClientDirectory"
    }
    $bytes = ConvertTo-ClientDatabaseBytes -Base64 $Base64
    $databasePath = Join-Path $ClientDirectory 'UserExamInfo.db'
    [IO.File]::WriteAllBytes($databasePath, $bytes)
    $written = (Get-Item -LiteralPath $databasePath).Length
    if ($written -ne $bytes.Length) {
        throw "UserExamInfo.db holds $written of $($bytes.Length) bytes after writing"
    }
    $signature = 'unknown'
    if (Test-SqliteDatabaseFile -Bytes $bytes) { $signature = 'SQLite' }
    Write-Host "[real-client] UserExamInfo.db written directly beside CXExam.exe bytes=$written"
    if ($signature -ne 'SQLite') {
        # The shipping payload is not plaintext SQLite; report the shape without blocking the write.
        Write-Host '[real-client] database header is not plaintext SQLite; payload is written verbatim'
    }
    return [pscustomobject]@{
        Path = $databasePath
        Bytes = $written
        ClientPath = $clientPath
        Sqlite = ($signature -eq 'SQLite')
    }
}
