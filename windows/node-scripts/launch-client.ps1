# Keep this script ASCII; paths and arguments arrive as UTF-8 JSON on stdin.
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

function Write-LaunchEvent {
  param([hashtable]$Payload)
  [Console]::Out.WriteLine(($Payload | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = [string]$payload.exePath
  $info.Arguments = [string]$payload.arguments
  $info.WorkingDirectory = [string]$payload.cwd
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
  $client = New-Object System.Diagnostics.Process
  $client.StartInfo = $info
  [void]$client.Start()
  $client.BeginOutputReadLine()
  $client.BeginErrorReadLine()
  Write-LaunchEvent @{ kind = 'started'; pid = $client.Id }
  $client.WaitForExit()
  Write-LaunchEvent @{ kind = 'exit'; code = $client.ExitCode }
  $client.Dispose()
  exit 0
} catch {
  $failure = $_.Exception.GetBaseException()
  $nativeCode = 0
  if ($failure -is [System.ComponentModel.Win32Exception]) { $nativeCode = $failure.NativeErrorCode }
  Write-LaunchEvent @{ kind = 'error'; win32Code = $nativeCode; message = $failure.Message }
  exit 1
}
