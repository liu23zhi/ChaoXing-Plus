import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';
// harness 与桩脚本都交给带 UTF-8 BOM 的写法：仓库路径含中文时，无 BOM 的 .ps1 会被
// Windows PowerShell 5.1 按 ANSI 解码，dot-source 的路径变乱码后直接失败。
import { writePowerShellScript, runPowerShellScript } from './test-helpers/windows-script.mjs';

const windowsOnly = process.platform === 'win32' ? undefined : 'Windows PowerShell cleanup regression';
const source = resolveTestPath('scripts', 'windows-real-client-injection.ps1');

function psQuote(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

// Run the unchanged orchestration script with harmless dependency fixtures. These cases must never
// launch an exam client, change the input language, capture the desktop or restart Explorer.
function runCleanupCase({ early = false, logs = false, artifactFailure = false, shellFailure = false } = {}) {
  const directory = createTestDirectory('real-client-cleanup');
  const runner = path.join(directory, 'runner');
  mkdirSync(runner);
  const script = path.join(directory, 'windows-real-client-injection.ps1');
  copyFileSync(source, script);
  const installer = path.join(directory, 'installer.fixture');
  const host = path.join(directory, 'host.fixture');
  if (!early) writeFileSync(installer, 'fixture only');
  writeFileSync(host, 'must not launch');
  writePowerShellScript(path.join(directory, 'windows-client-entry.ps1'), '');
  writePowerShellScript(path.join(directory, 'windows-client-cdp.ps1'), `
function Get-CdpPageTarget { param([int] $Port, [int] $TimeoutSeconds) return $null }
function Invoke-CdpCommand { param([string] $WebSocketUrl, [string] $ParamsJson, [int] $CommandId, [int] $TimeoutSeconds) return $null }
function Save-CdpPageScreenshot {
  param([int] $Port, [string] $Path, [int] $TimeoutSeconds)
  [IO.File]::WriteAllText((Join-Path $env:RUNNER_TEMP 'cdp-capture.marker'), 'fixture called')
  return $null
}
`);
  writePowerShellScript(path.join(directory, 'windows-client-database.ps1'), `
function Install-ClientDatabase {
  param([string] $ClientDirectory, [string] $Base64)
  if ($env:CX_CLEANUP_LOGS -eq '1') {
    [IO.File]::WriteAllText((Join-Path $ClientDirectory 'debug.log'), 'debug evidence')
    [IO.File]::WriteAllText((Join-Path $ClientDirectory 'input.txt'), 'input evidence')
  }
  throw 'ORIGINAL_INSTALL_FAILURE'
}
`);
  writePowerShellScript(path.join(directory, 'sevenzip-fixture.ps1'), `
$destination = $args[2].Substring(2)
New-Item -ItemType Directory -Path $destination -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $destination 'CXExam.exe'), 'must not launch')
$global:LASTEXITCODE = 0
`);
  writePowerShellScript(path.join(directory, 'windows-client-shell.ps1'), `
function Get-Command {
  [CmdletBinding()] param([string] $Name)
  if ($Name -eq '7z.exe') { return [pscustomobject]@{ Source = (Join-Path $PSScriptRoot 'sevenzip-fixture.ps1') } }
  Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
}
function Repair-ShellDesktop {
  param([switch] $Force)
  [IO.File]::WriteAllText((Join-Path $env:RUNNER_TEMP 'shell-repaired.marker'), 'fixture called')
  if ($env:CX_CLEANUP_SHELL_FAILURE -eq '1') { throw 'SECONDARY_SHELL_FAILURE' }
  return [pscustomobject]@{ Action = 'fixture'; Restarted = $false; Tray = $true; OwnerPid = 0; OldPids = ''; ManualStart = $false; Forced = $Force.IsPresent }
}
`);
  writePowerShellScript(path.join(directory, 'windows-client-diagnostics.ps1'), `
function Get-DesktopEnvironment { return @{ Fixture = $true } }
function Save-DesktopScreenshot {
  param([string] $Path, [int] $ScalePercent)
  if ($env:CX_CLEANUP_ARTIFACT_FAILURE -eq '1' -and $Path.EndsWith('-desktop.png')) { throw 'SECONDARY_ARTIFACT_FAILURE' }
  return $null
}
`);
  writePowerShellScript(path.join(directory, 'windows-client-input.ps1'), `
function Get-InputState { return [pscustomobject]@{ LayoutHandles = @('fixture'); ActiveLayout = 'fixture'; Preload = @{ '1' = 'fixture' } } }
function Compare-InputState { param($Before, $After) return @() }
function Restore-InputState {
  param($State)
  [IO.File]::WriteAllText((Join-Path $env:RUNNER_TEMP 'input-restored.marker'), 'fixture called')
  return @()
}
`);
  const harness = path.join(directory, 'harness.ps1');
  writePowerShellScript(harness, `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -Force
try {
  & ${psQuote(script)} -ClientInstaller ${psQuote(installer)} -InjectMode cdp-port -DatabaseBase64 Zml4dHVyZQ== -NativeHost ${psQuote(host)} -CaseName cleanup
  throw 'EXPECTED_ORIGINAL_FAILURE'
} catch {
  [pscustomobject]@{ Error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`);
  const result = runPowerShellScript(harness, {
    timeout: 30_000,
    env: {
      ...process.env, RUNNER_TEMP: runner,
      CX_CLEANUP_LOGS: logs ? '1' : '0',
      CX_CLEANUP_ARTIFACT_FAILURE: artifactFailure ? '1' : '0',
      CX_CLEANUP_SHELL_FAILURE: shellFailure ? '1' : '0'
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split(/\r?\n/u).findLast((value) => value.startsWith('{'));
  assert.ok(line, `${result.stdout}\n${result.stderr}`);
  return { runner, output: result.stdout, error: JSON.parse(line).Error };
}

function assertFinished(result, expectedError) {
  assert.match(result.error, expectedError, 'cleanup must preserve the original failure');
  assert.ok(existsSync(path.join(result.runner, 'shell-repaired.marker')), 'shell repair must still run');
  assert.ok(existsSync(path.join(result.runner, 'input-restored.marker')), 'input restore must still run');
  assert.equal(existsSync(path.join(result.runner, 'cdp-capture.marker')), false,
    'no CDP endpoint was ever found, so no page capture may be attempted');
  const manifest = path.join(result.runner, 'cx-real-client-cleanup-sha256.txt');
  assert.ok(existsSync(manifest), `artifact manifest must be written after cleanup diagnostics:\n${result.output}`);
  assert.match(readFileSync(manifest, 'utf8'), /^[a-f0-9]{64}  cx-real-client-cleanup-/mu);
  assert.deepEqual(readdirSync(result.runner, { withFileTypes: true }).filter((entry) => entry.isDirectory()), [],
    'the private unpack directory must be removed even after an early failure');
}

test('真实客户端失败时把 stage 与原因写进注解', () => {
  const text = readFileSync(source, 'utf8');
  assert.match(text, /::error::real-client failed case=\$CaseName stage=\$stage message=/u,
    'catch 分支必须发 ::error:: 注解，便于在没有作业日志时定位');
});

test('early validation failure without client logs preserves its error and finishes cleanup', { skip: windowsOnly }, () => {
  const result = runCleanupCase({ early: true });
  assertFinished(result, /Client fixture is missing:/u);
  assert.match(result.output, /client debug\.log not collected/u);
  assert.match(result.output, /client input\.txt not collected/u);
});

test('database failure without debug or input files still writes the manifest and repairs shell', { skip: windowsOnly }, () => {
  assertFinished(runCleanupCase(), /^ORIGINAL_INSTALL_FAILURE$/u);
});

test('debug and input evidence are both copied and included in the final hash manifest', { skip: windowsOnly }, () => {
  const result = runCleanupCase({ logs: true });
  assertFinished(result, /^ORIGINAL_INSTALL_FAILURE$/u);
  const manifest = readFileSync(path.join(result.runner, 'cx-real-client-cleanup-sha256.txt'), 'utf8');
  for (const [suffix, content] of [['client-debug.log', 'debug evidence'], ['client-input.txt', 'input evidence']]) {
    assert.equal(readFileSync(path.join(result.runner, `cx-real-client-cleanup-${suffix}`), 'utf8'), content);
    assert.ok(manifest.includes(`cx-real-client-cleanup-${suffix}`));
  }
  assert.match(result.output, /client debug\.log captured: 14 bytes/u);
  assert.match(result.output, /client input\.txt captured: 14 bytes/u);
});

test('artifact collection failure cannot replace the original error or stop the remaining cleanup', { skip: windowsOnly }, () => {
  assertFinished(runCleanupCase({ early: true, artifactFailure: true }), /Client fixture is missing:/u);
});

test('shell repair failure cannot replace the original error or skip the manifest and private directory cleanup', { skip: windowsOnly }, () => {
  assertFinished(runCleanupCase({ shellFailure: true }), /^ORIGINAL_INSTALL_FAILURE$/u);
});
