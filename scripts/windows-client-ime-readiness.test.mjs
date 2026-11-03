import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

const windowsOnly = process.platform === 'win32' ? undefined : 'Windows IMM readiness regression';
const source = resolveTestPath('scripts', 'ci', 'prepare-windows-real-client-environment.ps1');
const registryRoot = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Keyboard Layouts';
const sogouLayout = { klid: 'E0260804', values: { 'IME file': 'SOGOUPY.IME', 'Layout Text': 'Sogou Pinyin' } };
const emptyProbe = ['0x04090409=<empty>', '0x08040804=<empty>'];

function psQuote(value) { return `'${String(value).replace(/'/gu, "''")}'`; }

function runPowerShell(body, shell = 'powershell.exe') {
  const directory = createTestDirectory('ime-readiness');
  const harness = path.join(directory, 'harness.ps1');
  // Import only definitions. Evaluating the preparation script itself would install software,
  // change keyboard layouts, alter screen resolution and start the virtual camera.
  writeFileSync(harness, `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psQuote(source)}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors -join '; ') }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  Invoke-Expression $definition.Extent.Text
}
${body}
`);
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split(/\r?\n/u).findLast(value => value.startsWith('{'));
  assert.ok(line, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(line);
}

function mockReadiness({ registry = [sogouLayout], initial = emptyProbe, loads = {}, dryRun = false } = {}) {
  const data = Buffer.from(JSON.stringify({ registry, initial, loads })).toString('base64');
  return runPowerShell(`
$fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
$script:Probe = @($fixture.initial)
$script:Loaded = @(); $script:Messages = @()
$DryRun = $${dryRun}
function Write-Step([string] $message) { $script:Messages += $message }
function Test-Path {
  [CmdletBinding()] param([string] $LiteralPath)
  if ($LiteralPath -ne ${psQuote(registryRoot)}) { throw "unexpected registry read $LiteralPath" }
  return $true
}
function Get-ChildItem {
  [CmdletBinding()] param([string] $LiteralPath)
  if ($LiteralPath -ne ${psQuote(registryRoot)}) { throw "unexpected registry read $LiteralPath" }
  foreach ($entry in $fixture.registry) { [pscustomobject]@{ PSChildName = $entry.klid; PSPath = $entry.klid } }
}
function Get-ItemProperty {
  [CmdletBinding()] param([string] $LiteralPath)
  return @($fixture.registry | Where-Object { $_.klid -eq $LiteralPath })[0].values
}
function Get-ImmInputMethodProbe { return @($script:Probe) }
function Get-SogouInputState { return [pscustomobject]@{ Installed = $true } }
function Import-ImmInputMethodLayout {
  param([string] $Klid)
  $script:Loaded += $Klid
  $load = $fixture.loads.$Klid
  if ($load -and $load.fail) { throw 'mock native load failed' }
  if ($load -and $load.probe) { $script:Probe = @($load.probe) }
  if ($load) { return [string]$load.handle }
  return ''
}
function Set-ItemProperty { throw 'registry writes are forbidden' }
function New-ItemProperty { throw 'registry writes are forbidden' }
function Set-WinUserLanguageList { throw 'language changes are forbidden' }
function Start-Process { throw 'installers are forbidden' }
$result = Enable-SogouImmInputMethod
$script:SogouImmPreparation = $result
$summary = Get-InputMethodSummary
[pscustomobject]@{ Result = $result; Summary = $summary; Loaded = @($script:Loaded); Messages = @($script:Messages) } | ConvertTo-Json -Depth 9 -Compress
`);
}

function runInstaller({ shell = 'powershell.exe', readyAfter = 0, readyWhenExited = false, probeFailures = 0, lifetimeMilliseconds = 60_000, exitCode = 0, timeoutSeconds = 10, dryRun = false } = {}) {
  const directory = createTestDirectory('ime-installer');
  const sleeper = path.join(directory, 'harmless-installer.ps1');
  const marker = path.join(directory, 'child.pid');
  writeFileSync(sleeper, `
[IO.File]::WriteAllText(${psQuote(marker)}, [string]$PID)
Start-Sleep -Milliseconds ${lifetimeMilliseconds}
exit ${exitCode}
`);
  return runPowerShell(`
$DryRun = $${dryRun}
$script:InstallerProbeCalls = 0
$script:InstallerQuietCalls = @()
$childPidFile = ${psQuote(marker)}
$childExecutable = (Get-Process -Id $PID).Path
$runStarted = Get-Date
function Enable-SogouImmInputMethod {
  param([switch] $Quiet)
  $script:InstallerProbeCalls++
  $script:InstallerQuietCalls += $Quiet.IsPresent
  if ($script:InstallerProbeCalls -le ${probeFailures}) { throw 'transient IMM fixture probe failure' }
  $prepared = ${readyAfter} -gt 0 -and $script:InstallerProbeCalls -ge ${readyAfter}
  if ($${readyWhenExited} -and (Test-Path -LiteralPath $childPidFile)) {
    $fixtureChildId = [int]([IO.File]::ReadAllText($childPidFile))
    $fixtureChild = Get-Process -Id $fixtureChildId -ErrorAction SilentlyContinue
    $prepared = -not $fixtureChild
    if ($fixtureChild) { $fixtureChild.Dispose() }
  }
  $descriptions = if ($prepared) { @('0xE0260804=Sogou Pinyin') } else { @('0x04090409=<empty>') }
  return [pscustomobject]@{ Prepared = [bool]$prepared; ImmDescriptions = $descriptions }
}
$jobsBefore = @(Get-Job | ForEach-Object { $_.Id })
$watch = [Diagnostics.Stopwatch]::StartNew()
try {
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + ${psQuote(sleeper)} + '"'))
  $result = Invoke-SogouInstaller -FilePath $childExecutable -ArgumentList $arguments -Label 'harmless installer fixture' -TimeoutSeconds ${timeoutSeconds}
  $watch.Stop()
  # Start-Process may return before the script writes its marker. Observe only this fixture's PID;
  # never search for or terminate other PowerShell/installer processes.
  $markerDeadline = (Get-Date).AddSeconds(3)
  while (-not $DryRun -and -not (Test-Path -LiteralPath $childPidFile) -and (Get-Date) -lt $markerDeadline) { Start-Sleep -Milliseconds 20 }
  $childId = if (Test-Path -LiteralPath $childPidFile) { [int]([IO.File]::ReadAllText($childPidFile)) } else { 0 }
  $child = if ($childId) { Get-Process -Id $childId -ErrorAction SilentlyContinue } else { $null }
  $alive = $null -ne $child
  if ($child) { $child.Dispose() }
  $newJobs = @(Get-Job | Where-Object { $_.Id -notin $jobsBefore })
  [pscustomobject]@{ Result = $result; ProbeCalls = $script:InstallerProbeCalls; QuietCalls = @($script:InstallerQuietCalls); ChildId = $childId; Alive = $alive; NewJobs = $newJobs.Count; ElapsedMilliseconds = $watch.ElapsedMilliseconds } | ConvertTo-Json -Depth 5 -Compress
} finally {
  if (Test-Path -LiteralPath $childPidFile) {
    $ownedId = [int]([IO.File]::ReadAllText($childPidFile))
    $owned = Get-Process -Id $ownedId -ErrorAction SilentlyContinue
    if ($owned) {
      try {
        if ($owned.StartTime -ge $runStarted -and $owned.Path -eq $childExecutable) {
          $owned.Kill(); [void]$owned.WaitForExit(5000)
        }
      } finally { $owned.Dispose() }
    }
  }
}
`, shell);
}

function assertReadyInstaller(actual) {
  assert.equal(actual.Result.Ok, true);
  assert.equal(actual.Result.TimedOut, false);
  assert.equal(actual.Result.ImmReady, true);
  assert.equal(actual.Result.StillRunning, true);
  assert.equal(actual.Alive, true, 'IMM readiness must return without waiting for or killing the installer');
  assert.ok(actual.ChildId > 0, 'the harmless installer must actually have started');
  assert.equal(actual.NewJobs, 0, 'the readiness loop must stay in the parent process');
  assert.ok(actual.ProbeCalls >= 2);
  assert.ok(actual.QuietCalls.every(Boolean), 'periodic readiness probes must use -Quiet');
  assert.ok(actual.ElapsedMilliseconds < 10_000, 'IMM readiness must be observed before the installer timeout');
}

test('IMM readiness returns success while the real installer fixture is still running without background jobs', { skip: windowsOnly }, () => {
  assertReadyInstaller(runInstaller({ readyAfter: 2 }));
});

test('PowerShell 7 also returns on IMM readiness while its real installer fixture remains alive', { skip: windowsOnly }, (t) => {
  const probe = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000
  });
  if (probe.error?.code === 'ENOENT') { t.skip('PowerShell 7 is unavailable'); return; }
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), '7');
  assertReadyInstaller(runInstaller({ shell: 'pwsh.exe', readyAfter: 2 }));
});

test('a zero installer exit without IMM keeps probing until timeout rather than reporting readiness', { skip: windowsOnly }, () => {
  const actual = runInstaller({ lifetimeMilliseconds: 100, timeoutSeconds: 3 });
  assert.equal(actual.Result.Ok, false);
  assert.equal(actual.Result.TimedOut, true);
  assert.equal(actual.Result.ImmReady, false);
  assert.equal(actual.Result.StillRunning, false);
  assert.equal(actual.Result.ExitCode, 0);
  assert.equal(actual.Alive, false);
  assert.equal(actual.NewJobs, 0);
});

test('an installer failure without IMM cannot be reported as success', { skip: windowsOnly }, () => {
  const actual = runInstaller({ lifetimeMilliseconds: 100, exitCode: 7 });
  assert.equal(actual.Result.Ok, false);
  assert.equal(actual.Result.TimedOut, false);
  assert.equal(actual.Result.ImmReady, false);
  assert.equal(actual.Result.StillRunning, false);
  assert.equal(actual.Result.ExitCode, 7);
  assert.equal(actual.NewJobs, 0);
});

test('the final IMM probe can observe readiness reached as the installer exits', { skip: windowsOnly }, () => {
  const actual = runInstaller({ lifetimeMilliseconds: 100, readyWhenExited: true });
  assert.equal(actual.Result.Ok, true);
  assert.equal(actual.Result.TimedOut, false);
  assert.equal(actual.Result.ImmReady, true);
  assert.equal(actual.Result.StillRunning, false);
  assert.equal(actual.Alive, false);
  assert.equal(actual.NewJobs, 0);
  assert.ok(actual.ProbeCalls > 0);
});

test('a running installer without IMM returns an explicit timeout and creates no jobs', { skip: windowsOnly }, () => {
  const actual = runInstaller({ timeoutSeconds: 1 });
  assert.equal(actual.Result.Ok, false);
  assert.equal(actual.Result.TimedOut, true);
  assert.equal(actual.Result.ImmReady, false);
  assert.equal(actual.Result.StillRunning, true);
  assert.equal(actual.NewJobs, 0);
});

test('installer dry run starts no child process or jobs and performs no IMM preparation', { skip: windowsOnly }, () => {
  const actual = runInstaller({ dryRun: true, readyAfter: 1 });
  assert.equal(actual.Result.Ok, false);
  assert.equal(actual.Result.TimedOut, false);
  assert.equal(actual.Result.ImmReady, false);
  assert.equal(actual.Result.StillRunning, false);
  assert.equal(actual.ChildId, 0);
  assert.equal(actual.Alive, false);
  assert.equal(actual.NewJobs, 0);
  assert.equal(actual.ProbeCalls, 0);
});

test('a transient IMM probe exception does not prevent a later ready result while the installer lives', { skip: windowsOnly }, () => {
  const actual = runInstaller({ readyAfter: 2, probeFailures: 1 });
  assert.equal(actual.Result.Ok, true);
  assert.equal(actual.Result.TimedOut, false);
  assert.equal(actual.Result.ImmReady, true);
  assert.equal(actual.Result.StillRunning, true);
  assert.equal(actual.Alive, true);
  assert.equal(actual.NewJobs, 0);
  assert.ok(actual.ProbeCalls >= 2);
});

function installerChain({ immReady = false, stillRunning = false } = {}) {
  const directory = createTestDirectory('ime-installer-chain');
  const bundled = path.join(directory, 'sogou.fixture');
  writeFileSync(bundled, 'harmless bundled installer fixture');
  return runPowerShell(`
$DryRun = $false
$CapabilityTimeoutSeconds = 3
$script:InstallerCalls = @(); $script:WingetLookups = 0; $script:ManifestLookups = 0; $script:Downloads = 0
function Enable-SogouImmInputMethod { param([switch] $Quiet) return [pscustomobject]@{ Prepared = $false; ImmDescriptions = @('0x04090409=<empty>') } }
function Get-SogouInputState { return [pscustomobject]@{ Installed = $false; Version = ''; InstallDir = ''; Source = 'fixture' } }
function Get-BundledSogouInstaller { return ${psQuote(bundled)} }
function Test-SogouInstallerFile { param([string] $Path) return [pscustomobject]@{ Ok = $true; Reason = ''; Sha256 = 'fixture' } }
function Invoke-SogouInstaller {
  param([string] $FilePath, [string[]] $ArgumentList, [string] $Label, [int] $TimeoutSeconds)
  $script:InstallerCalls += $FilePath
  return [pscustomobject]@{ Ok = $${immReady}; TimedOut = $${stillRunning && !immReady}; ImmReady = $${immReady}; StillRunning = $${stillRunning}; ExitCode = $null }
}
function Get-Command {
  [CmdletBinding()] param([string] $Name)
  if ($Name -eq 'winget.exe') { $script:WingetLookups++; return [pscustomobject]@{ Source = 'winget.fixture' } }
  throw "unexpected command lookup $Name"
}
function Resolve-SogouInputInstaller {
  $script:ManifestLookups++
  return [pscustomobject]@{ Version = 'fixture'; Url = 'https://fixture.invalid/never-download'; Sha256 = ''; Silent = '/S' }
}
function Invoke-WebRequest { $script:Downloads++; throw 'network is forbidden in the installer chain fixture' }
function Start-Process { throw 'real installers are forbidden in the installer chain fixture' }
Install-SogouInputMethod
[pscustomobject]@{ InstallerCalls = @($script:InstallerCalls); WingetLookups = $script:WingetLookups; ManifestLookups = $script:ManifestLookups; Downloads = $script:Downloads } | ConvertTo-Json -Depth 4 -Compress
`);
}

test('a bundled installer reaching IMM readiness ends the chain even when installed-software detection stays false', { skip: windowsOnly }, () => {
  const actual = installerChain({ immReady: true, stillRunning: true });
  assert.equal(actual.InstallerCalls.length, 1);
  assert.match(actual.InstallerCalls[0], /sogou\.fixture$/u);
  assert.equal(actual.WingetLookups, 0);
  assert.equal(actual.ManifestLookups, 0);
  assert.equal(actual.Downloads, 0);
});

test('a still-running bundled installer timeout cannot start winget or a downloaded installer in parallel', { skip: windowsOnly }, () => {
  const actual = installerChain({ stillRunning: true });
  assert.equal(actual.InstallerCalls.length, 1);
  assert.match(actual.InstallerCalls[0], /sogou\.fixture$/u);
  assert.equal(actual.WingetLookups, 0);
  assert.equal(actual.ManifestLookups, 0);
  assert.equal(actual.Downloads, 0);
});

test('registered Sogou IMM layout is loaded by its actual KLID and verified through its enumerated description', { skip: windowsOnly }, () => {
  const result = mockReadiness({ loads: { E0260804: { handle: '0xFFFFFFFFE0260804', probe: [...emptyProbe, '0xFFFFFFFFE0260804=Sogou Pinyin'] } } });
  assert.deepEqual(result.Loaded, ['E0260804']);
  assert.equal(result.Result.Prepared, true);
  assert.equal(result.Summary.Prepared, true);
  assert.equal(result.Result.Reason, 'registered-sogou-imm-loaded');
  assert.equal(result.Summary.ImmPreparation.Attempts[0].Klid, 'E0260804');
});

test('installed software and TSF-only or malformed registrations cannot establish IMM readiness', { skip: windowsOnly }, () => {
  const result = mockReadiness({ registry: [
    { klid: '00000804', values: { 'Layout Text': 'Sogou TSF' } },
    { klid: 'bad-key', values: sogouLayout.values },
    { klid: 'E0230804', values: { 'IME file': 'sogou-tsf.dll', 'Layout Text': 'Sogou TSF' } },
    { klid: 'E0220804', values: { 'IME file': 'other.ime', 'Layout Text': 'Other Pinyin' } }
  ] });
  assert.deepEqual(result.Loaded, []);
  assert.equal(result.Summary.Sogou.Installed, true);
  assert.equal(result.Result.Prepared, false);
  assert.equal(result.Summary.Prepared, false);
  assert.equal(result.Result.Reason, 'no-registered-sogou-imm-layout');
});

test('a nonzero native load result with an empty IMM description remains unprepared', { skip: windowsOnly }, () => {
  const result = mockReadiness({ loads: { E0260804: { handle: '0xE0260804', probe: [...emptyProbe, '0xE0260804=<empty>'] } } });
  assert.equal(result.Result.Prepared, false);
  assert.equal(result.Summary.Prepared, false);
  assert.equal(result.Result.Reason, 'registered-sogou-imm-not-ready');
});

test('a native fallback to a different layout cannot be reported as a successful Sogou load', { skip: windowsOnly }, () => {
  const result = mockReadiness({ loads: { E0260804: { handle: '0x04090409', probe: emptyProbe } } });
  assert.equal(result.Result.Prepared, false);
  assert.equal(result.Summary.Prepared, false);
});

test('layout loading failures remain diagnostic and allow the next registered Sogou layout to be checked', { skip: windowsOnly }, () => {
  const second = { klid: 'E0270804', values: sogouLayout.values };
  const result = mockReadiness({ registry: [sogouLayout, second], loads: {
    E0260804: { fail: true },
    E0270804: { handle: '0xE0270804', probe: [...emptyProbe, '0xE0270804=Sogou Pinyin'] }
  } });
  assert.deepEqual(result.Loaded, ['E0260804', 'E0270804']);
  assert.equal(result.Result.Prepared, true);
  assert.ok(result.Messages.some(value => value.includes('mock native load failed')));
});

test('dry run never loads a layout and reports the actual unprepared state', { skip: windowsOnly }, () => {
  const result = mockReadiness({ dryRun: true });
  assert.deepEqual(result.Loaded, []);
  assert.equal(result.Result.Prepared, false);
  assert.equal(result.Summary.Prepared, false);
  assert.equal(result.Result.Reason, 'dry-run');
});

test('already loaded nonempty IMM descriptions are ready without another layout load', { skip: windowsOnly }, () => {
  const result = mockReadiness({ initial: [...emptyProbe, '0xE0260804=Sogou Pinyin'] });
  assert.deepEqual(result.Loaded, []);
  assert.equal(result.Result.Prepared, true);
  assert.equal(result.Summary.Prepared, true);
  assert.equal(result.Result.Reason, 'already-ready');
});

test('real IMM probe enumerates descriptions without loading layouts or changing the desktop', { skip: windowsOnly }, () => {
  const result = runPowerShell(`
function Import-ImmInputMethodLayout { throw 'read-only probe must not load a keyboard layout' }
function Start-Process { throw 'read-only probe must not run an installer' }
$before = @(Get-ImmInputMethodProbe)
$after = @(Get-ImmInputMethodProbe)
[pscustomobject]@{ Before = $before; After = $after } | ConvertTo-Json -Depth 5 -Compress
`);
  assert.deepEqual(result.After, result.Before);
  for (const line of result.Before) assert.match(line, /^0x[0-9a-f]{8,16}=.+$/iu);
  assert.ok(result.Before.length > 0, 'interactive Windows must expose at least one keyboard layout');
});
