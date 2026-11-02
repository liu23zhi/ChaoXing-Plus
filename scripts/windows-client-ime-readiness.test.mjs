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

function runPowerShell(body) {
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
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
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
