# Print (and optionally verify) the WeChat IME installer that the CI preparation step would use.
#
#   pwsh -File scripts/ci/verify-wetype-resolver.ps1
#   pwsh -File scripts/ci/verify-wetype-resolver.ps1 -NoWinget   # exercise the manifest branch
#   pwsh -File scripts/ci/verify-wetype-resolver.ps1 -Download   # also download and check the SHA256
#
# Keep this file pure ASCII.

[CmdletBinding()]
param(
  [switch] $NoWinget,
  [switch] $Download
)

$ErrorActionPreference = 'Stop'
$preparation = Join-Path $PSScriptRoot 'prepare-windows-real-client-environment.ps1'
$lines = Get-Content -LiteralPath $preparation
$bodyLine = (Select-String -LiteralPath $preparation -Pattern '^if \(-not \$SkipResolution\) \{ Set-DesktopResolution \}' |
  Select-Object -First 1).LineNumber
if (-not $bodyLine) { throw 'cannot locate the main body of prepare-windows-real-client-environment.ps1' }
# Only the definitions: everything above the main body.
Invoke-Expression ($lines[0..($bodyLine - 2)] -join "`n")

if ($NoWinget) {
  $env:PATH = ($env:PATH -split ';' | Where-Object { $_ -and $_ -notlike '*WindowsApps*' }) -join ';'
}

Write-Host "winget available = $([bool](Get-Command winget.exe -ErrorAction SilentlyContinue))"
$state = Get-WeChatInputMethodState
Write-Host "installed        = $($state.Installed) (dir='$($state.InstallDir)' binaries=$($state.FilesFound))"
$bundled = Get-BundledWeChatInstaller
Write-Host "bundled installer= $(if ($bundled) { $bundled } else { '<none>' })"

$installer = Resolve-WeChatInputMethodInstaller
Write-Host "resolved version = $($installer.Version)"
Write-Host "resolved url     = $($installer.Url)"
Write-Host "silent switch    = $($installer.Silent)"
Write-Host "manifest sha256  = $(if ($installer.Sha256) { $installer.Sha256 } else { '<none>' })"

try {
  $head = Invoke-WebRequest -Uri $installer.Url -Method Head -UseBasicParsing -TimeoutSec 30
  $length = [int64]($head.Headers['Content-Length'] | Select-Object -First 1)
  Write-Host "HEAD             = $($head.StatusCode) $([math]::Round($length / 1MB, 2)) MB"
} catch {
  Write-Host "HEAD             = failed: $($_.Exception.Message)"
}

if ($Download) {
  $target = Join-Path $env:TEMP ('WeTypeSetup-' + $installer.Version + '.exe')
  if (-not (Test-Path -LiteralPath $target)) {
    Invoke-WebRequest -Uri $installer.Url -OutFile $target -UseBasicParsing -TimeoutSec 900
  }
  $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  $signature = Get-AuthenticodeSignature -LiteralPath $target
  Write-Host "downloaded       = $([math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 2)) MB -> $target"
  Write-Host "sha256           = $actual"
  Write-Host "sha256 matches   = $($installer.Sha256 -and $actual -eq $installer.Sha256.ToUpperInvariant())"
  Write-Host "signature        = $($signature.Status) / $($signature.SignerCertificate.Subject.Split(',')[0])"
}
