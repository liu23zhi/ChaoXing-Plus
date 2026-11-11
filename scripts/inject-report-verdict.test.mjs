// PR 可跑的注入判据层：拿真实宿主形状的 report.json 驱动**真实的判据脚本**，断言判定结果。
//
// ── 这个文件为什么存在 ─────────────────────────────────────────────────────
// 判据改动（t72：bundle 没落地从黄改红、新增 proxy-carrier-absent）原本只有
// `windows-real-client` 能验到，而那个 job 带 `github.event_name != 'pull_request'`
// （ci.yml:551，真客户端要 Windows runner + 私有安装包），PR 上根本不跑。
// 于是「改了怎么算注入成功」这件事在合并前无法被 CI 验证。这一层把它补上。
//
// ── 为什么不在这里复刻判据逻辑 ─────────────────────────────────────────────
// 复刻一份等于「自己实现一遍再测自己对不对」：脚本改了、复刻没改，测试照样绿。
// 所以这里**把真实的 scripts/windows-real-client-injection.ps1 整个跑起来**——
// 依赖脚本（客户端交互/截图/DB/输入法）全部 stub 掉，只保留编排与断言，
// 由 stub 的 Start-Process 把 fixture 里的 report.json 写进本次运行的私有目录。
//
// ── fixture 从哪来 ────────────────────────────────────────────────────────
// tests/fixtures/inject-report/*.json 由 scripts/ci/make-inject-report-fixtures.mjs 生成，
// 字段顺序与 reasonCounts 的 8 个键取自 audit.c 的序列化代码 + 一份真实宿主产物，
// 不是手搓。每个 fixture 只改这条判据关心的字段。
//
// ── 跑在哪 ────────────────────────────────────────────────────────────────
// windows-unit job 用 `Get-ChildItem scripts -Filter '*.test.mjs'` 自动收集，PR 上会跑。
// 不需要改 ci.yml；本文件不发起真实注入，也不需要私有客户端。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';
import { writePowerShellScript, runPowerShellScript } from './test-helpers/windows-script.mjs';

// 2026-11-11: artifact filename localized to Chinese (user request). Built from the same
// code points as scripts/windows-real-client-injection.ps1 so the two sides cannot drift.
const ARTIFACT_REPORT_SUFFIX = String.fromCharCode(0x6CE8, 0x5165, 0x62A5, 0x544A) + '.json';


const windowsOnly = process.platform === 'win32' ? undefined : 'injection verdict fixture layer';
const verdictScript = resolveTestPath('scripts', 'windows-real-client-injection.ps1');
const fixtureDir = resolveTestPath('tests', 'fixtures', 'inject-report');
const CASE_NAME = 'inject';

/** 读一份 fixture 报告。fixture 是文件而不是内联对象，才能保证 CI 与本地测的是同一份数据。 */
function loadFixture(name) {
  const file = path.join(fixtureDir, name);
  assert.ok(existsSync(file), `fixture 缺失：${name}（先跑 node scripts/ci/make-inject-report-fixtures.mjs）`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function psQuote(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

// 依赖脚本全部顶掉：不启动客户端、不抓屏、不改输入法、不重启 Explorer。
// 每个 stub 必须提供真实脚本会调用的**全部**函数，否则 dot-source 后调用处报错，
// 掩盖真正的判据失败原因。
const STUBS = [
  [
    'windows-client-database.ps1',
    `
function Install-ClientDatabase {
  param([string] $ClientDirectory, [string] $Base64)
  return [pscustomobject]@{ Path = (Join-Path $ClientDirectory 'UserExamInfo.db'); Bytes = 1; Sqlite = $true }
}
`
  ],
  [
    'windows-client-entry.ps1',
    `
function Wait-ClientExamEntry {
  param([string] $ClientPath, [int] $TimeoutSeconds, [string] $ScreenshotPrefix, $Heartbeat)
  return [pscustomobject]@{
    Reason = 'entry-window-not-found'; Window = ''; ProcessId = 0; Point = ''; Dpi = 0
    ClientSize = ''; Attempts = 0; PageTargets = 1; Clicked = $false; Target = ''
    Confirmed = $false; Windows = ''; ConfirmVia = ''
  }
}
function Get-ClientCdpPort { param([int] $ProcessId) return 0 }
function Get-ClientWindowAffinity { param([int] $ProcessId) return @{} }
function Watch-ClientCaptureGuard { param([int] $ProcessId, [int] $Port, [int] $TimeoutSeconds) return $null }
`
  ],
  [
    'windows-client-cdp.ps1',
    `
function Get-CdpPageTarget { param([int] $Port, [int] $TimeoutSeconds) return $null }
function Invoke-CdpCommand { param([string] $WebSocketUrl, [string] $ParamsJson, [int] $CommandId, [int] $TimeoutSeconds) return $null }
function Save-CdpPageScreenshot { param([int] $Port, [string] $Path, [int] $TimeoutSeconds) return $null }
`
  ],
  [
    'windows-client-diagnostics.ps1',
    `
function Get-DesktopEnvironment { return @{ Fixture = $true } }
function Save-DesktopScreenshot { param([string] $Path, [int] $ScalePercent) return $null }
`
  ],
  [
    'windows-client-input.ps1',
    `
function Get-InputState { return [pscustomobject]@{ LayoutHandles = @('fixture'); ActiveLayout = 'fixture'; Preload = @{ '1' = 'fixture' } } }
function Compare-InputState { param($Before, $After) return @() }
function Restore-InputState { param($State) return @() }
`
  ],
  [
    'sevenzip-fixture.ps1',
    `
$destination = $args[2].Substring(2)
New-Item -ItemType Directory -Path $destination -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $destination 'CXExam.exe'), 'fixture only')
$global:LASTEXITCODE = 0
`
  ]
];

// 宿主进程顶成"启动即退出"的真实进程：不启动客户端，只把 fixture 报告写进本次运行的私有目录
// （就是 -RedirectStandardOutput 的父目录），于是脚本读到的是这份报告。
// 必须返回真实的 System.Diagnostics.Process —— 脚本的 finally 会把它传给
// Stop-OwnedProcess([System.Diagnostics.Process])，PSCustomObject 过不了参数类型转换。
const START_PROCESS_STUB = `
function Start-Process {
  [CmdletBinding()]
  param(
    [string] $FilePath,
    [object] $ArgumentList,
    [switch] $PassThru,
    [string] $WindowStyle,
    [string] $RedirectStandardOutput,
    [string] $RedirectStandardError
  )
  $folder = Split-Path -Parent $RedirectStandardOutput
  [IO.File]::WriteAllText((Join-Path $folder 'report.json'), $env:CX_INJECT_REPORT_JSON, (New-Object System.Text.UTF8Encoding($false)))
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $env:SystemRoot 'System32\\cmd.exe'
  $info.Arguments = '/c exit 0'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($info)
  [void]$process.WaitForExit(30000)
  return $process
}
`;

const SHELL_STUB = `
function Get-Command {
  [CmdletBinding()] param([string] $Name)
  if ($Name -eq '7z.exe') { return [pscustomobject]@{ Source = (Join-Path $PSScriptRoot 'sevenzip-fixture.ps1') } }
  Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
}
function Repair-ShellDesktop {
  param([switch] $Force)
  return [pscustomobject]@{ Action = 'fixture'; Restarted = $false; Tray = $true; OwnerPid = 0; OldPids = ''; ManualStart = $false; Forced = $Force.IsPresent }
}
${START_PROCESS_STUB}
`;

/**
 * 把一份 fixture 报告喂给真实判据脚本跑到底，返回判定结果。
 * verdict 是从**脚本自己的输出**里读出来的，不是我们另算一遍：
 *   pass  —— 脚本打印了 REAL_CLIENT_INJECTION_PASS
 *   red   —— 脚本抛错（Error 非空）
 *   yellow—— 通过但带 INJECT_BUNDLE_UNVERIFIED 告警
 */
function runVerdict(fixtureName) {
  const report = loadFixture(fixtureName);
  const directory = createTestDirectory('inject-verdict');
  const runner = path.join(directory, 'runner');
  mkdirSync(runner);
  const script = path.join(directory, 'windows-real-client-injection.ps1');
  copyFileSync(verdictScript, script);
  const installer = path.join(directory, 'installer.fixture');
  writeFileSync(installer, 'fixture only');
  const hostFixture = path.join(directory, 'host.fixture');
  writeFileSync(hostFixture, 'must not launch');
  for (const [name, content] of STUBS) writePowerShellScript(path.join(directory, name), content);
  writePowerShellScript(path.join(directory, 'windows-client-shell.ps1'), SHELL_STUB);

  const harness = path.join(directory, 'harness.ps1');
  writePowerShellScript(harness, `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -Force
try {
  & ${psQuote(script)} -ClientInstaller ${psQuote(installer)} -InjectMode cdp-port -DatabaseBase64 Zml4dHVyZQ== -NativeHost ${psQuote(hostFixture)} -CaseName ${psQuote(CASE_NAME)}
  [pscustomobject]@{ Error = '' } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ Error = $_.Exception.Message } | ConvertTo-Json -Compress
}
`);

  const result = runPowerShellScript(harness, {
    timeout: 120_000,
    env: { ...process.env, RUNNER_TEMP: runner, CX_INJECT_REPORT_JSON: JSON.stringify(report) }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split(/\r?\n/u).findLast((value) => value.startsWith('{'));
  assert.ok(line, `harness 必须报出脚本结果:\n${result.stdout}\n${result.stderr}`);
  const error = JSON.parse(line).Error;
  const artifactPath = path.join(runner, `cx-real-client-${CASE_NAME}-${ARTIFACT_REPORT_SUFFIX}`);
  const output = result.stdout;
  const passed = /REAL_CLIENT_INJECTION_PASS/u.test(output) && !error;
  const warned = /INJECT_BUNDLE_UNVERIFIED/u.test(output);
  return {
    fixture: fixtureName,
    verdict: !passed ? 'red' : warned ? 'yellow' : 'green',
    error,
    output,
    // CI 上传的就是这份 artifact；断言判定结果时必须看它，而不是只看局部变量。
    summary: existsSync(artifactPath) ? JSON.parse(readFileSync(artifactPath, 'utf8')).injectVerifiedSummary : null
  };
}

// ---------------------------------------------------------------------------
// 每个 fixture 一条用例。断言的是**判定结果**（绿/黄/红）与 strictFailures，
// 不是源码里的字符串 —— 脚本改坏了这里必红。
// ---------------------------------------------------------------------------

test('bundle-in-page-true：判定为绿，无告警，summary 记录 verifiedTrue', { skip: windowsOnly }, () => {
  const r = runVerdict('bundle-in-page-true.json');
  assert.equal(r.verdict, 'green', `应为绿:\n${r.output}`);
  assert.equal(r.summary.verifiedTrue, 1);
  assert.equal(r.summary.bundleInPage, true);
  assert.equal(r.summary.chainRan, true);
  assert.deepEqual(r.summary.strictFailures, []);
});

test('bundle-in-page-false-chain-ran：链路通了但 bundle 没落地 → 红', { skip: windowsOnly }, () => {
  // 这是 t72 的核心修正：以前只记黄，等于承认「从未注入成功」还发绿灯。
  const r = runVerdict('bundle-in-page-false-chain-ran.json');
  assert.equal(r.verdict, 'red', `必须判红:\n${r.output}`);
  assert.match(r.error, /never proved the injected bundle ran/u);
  assert.equal(r.summary.chainRan, true, '链路确实跑过，这正是判红的依据');
  assert.equal(r.summary.bundleInPage, false);
  assert.deepEqual(r.summary.strictFailures, ['bundle-not-in-page']);
});

test('bundle-unverified-chain-not-ran：链路没起来 → 黄（不判红）', { skip: windowsOnly }, () => {
  // 与上一条的区别就在 chainRan：环境没起来不该算注入回归，否则新回归会被满屏红淹没。
  const r = runVerdict('bundle-unverified-chain-not-ran.json');
  assert.equal(r.verdict, 'yellow', `应记黄:\n${r.output}`);
  assert.equal(r.summary.chainRan, false);
  assert.deepEqual(r.summary.strictFailures, [], '链路没起来不列入 strictFailures');
});

test('carrier-absent：载体 DLL 该加载却零日志 → 红', { skip: windowsOnly }, () => {
  const r = runVerdict('carrier-absent.json');
  assert.equal(r.verdict, 'red', `必须判红:\n${r.output}`);
  assert.match(r.error, /proxy carrier DLL never ran/u);
  assert.ok(
    r.summary.strictFailures.includes('proxy-carrier-absent'),
    `根因必须被记录: ${JSON.stringify(r.summary.strictFailures)}`
  );
});

test('sentinel-rejected：页面明确否定 → 红', { skip: windowsOnly }, () => {
  const r = runVerdict('sentinel-rejected.json');
  assert.equal(r.verdict, 'red', `必须判红:\n${r.output}`);
  assert.match(r.error, /page rejected the injected bundle/u);
  assert.ok(r.summary.strictFailures.includes('bundle-sentinel-rejected'));
});

test('evidence-missing：报告契约被改坏 → 红（不静默放过）', { skip: windowsOnly }, () => {
  const r = runVerdict('evidence-missing.json');
  assert.equal(r.verdict, 'red', `必须判红:\n${r.output}`);
  assert.match(r.error, /has no injectEvidence object/u);
});

// ---------------------------------------------------------------------------
// 判据分级必须真的分层：同一份「bundle 没落地」在 chainRan 不同时结论必须不同。
// 这条是防「把所有 bundle=false 一刀切判红」——那会让环境问题也算注入回归。
// ---------------------------------------------------------------------------
test('同一 bundleInPage=false 在 chainRan 不同时分别判红与判黄（分级真的生效）', { skip: windowsOnly }, () => {
  const red = runVerdict('bundle-in-page-false-chain-ran.json');
  const yellow = runVerdict('bundle-unverified-chain-not-ran.json');
  assert.equal(red.summary.bundleInPage, false);
  assert.equal(yellow.summary.bundleInPage, false);
  assert.equal(red.verdict, 'red');
  assert.equal(yellow.verdict, 'yellow');
  assert.notEqual(red.verdict, yellow.verdict, '分级必须真的分层，不能一刀切');
});

// fixture 自身必须与宿主真实形状一致，否则测的是想象中的 JSON。
test('fixture 保持真实 report.json 的形状（字段与 reasonCounts 键集合）', () => {
  const report = loadFixture('bundle-in-page-true.json');
  // audit.c:287-303 的序列化顺序即真实字段集合。
  for (const field of [
    'version', 'host', 'startedAt', 'finishedAt', 'mode', 'durationMs', 'clientPid', 'port',
    'attached', 'ownershipVerified', 'success', 'executionMode', 'injectStrategy', 'stopReason',
    'injectMode', 'commandLineInjected', 'injectEvidence', 'endpointProbe', 'totals'
  ]) {
    assert.ok(field in report, `fixture 缺少真实字段 '${field}'`);
  }
  for (const field of ['endpointReady', 'proxyHook', 'proxyHookRequired', 'bundleInPage',
    'bundleSentinelRejected', 'verified', 'reason']) {
    assert.ok(field in report.injectEvidence, `injectEvidence 缺少真实字段 '${field}'`);
  }
  for (const field of ['contexts', 'bootstraps', 'bundles', 'errors', 'reconnects', 'pageSessions']) {
    assert.ok(field in report.totals, `totals 缺少真实字段 '${field}'`);
  }
  // reasonCounts 的 8 个键来自 CX_ENDPOINT_REASON 枚举；缺键会让判据读到 undefined 静默当 false。
  const expectedReasons = [
    'no-listener', 'listener-not-owned', 'listener-query-failed', 'listener-binding-rejected',
    'http-failed', 'invalid-version', 'browser-mismatch', 'ready'
  ];
  assert.deepEqual(Object.keys(report.endpointProbe.reasonCounts).sort(), [...expectedReasons].sort());
});
