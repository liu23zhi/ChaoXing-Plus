// 注入矩阵的判据必须真的含 injectEvidence，否则「bundle 没落地」永远不会让 CI 变红。
//
// 背景（2026-11-10 实测，不是推测）：真实客户端矩阵 6/6 全绿，但 6 份 report.json 里
// injectEvidence.bundleInPage 与 verified 都是 false、reason 全是 bundle-unverified ——
// 判据脚本当时只断 success / ownershipVerified / pageSessions / bootstraps / bundles /
// stopReason，全文没有一处读 injectEvidence，于是「bundle 从未落地」这件事对 CI 完全不可见。
//
// 这里用合成的 report.json 驱动**未改动的真实脚本**
// scripts/windows-real-client-injection.ps1 跑到底（宿主、7z、客户端交互全部用 stub 顶掉），
// 因此测的是判据本身的真实行为，而不是源码里的字符串：
//   1 verified=true                                      -> 通过，无告警
//   2 verified=false 且 bundleSentinelRejected=false      -> 黄色警告 + injectVerifiedSummary，仍通过
//      （当前 6/6 就是这个状态，直接判红会让整条矩阵立刻全红，且分不清「原本就没成功」与「新增回归」）
//   3 bundleSentinelRejected=true                        -> 判红（页面明确否定，是真失败，不是无法判定）
//   4 报告里没有 injectEvidence                          -> 判红（报告契约被改坏）
//   5 injectEvidence 缺 bundleInPage/verified/reason/
//     bundleSentinelRejected 任一个                      -> 判红（报告契约被改坏）
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';
// 仓库路径可能含中文（.../学习通客户端/...）：无 BOM 的 .ps1 会被 Windows PowerShell 5.1
// 按 ANSI 解码，dot-source 路径变乱码后直接失败。所有 .ps1 都必须经这个带 BOM 的写法生成。
import { writePowerShellScript, runPowerShellScript } from './test-helpers/windows-script.mjs';

// 2026-11-11: artifact filename localized to Chinese (user request). Built from the same
// code points as scripts/windows-real-client-injection.ps1 so the two sides cannot drift.
const ARTIFACT_REPORT_SUFFIX = String.fromCharCode(0x6CE8, 0x5165, 0x62A5, 0x544A) + '.json';


const windowsOnly = process.platform === 'win32' ? undefined : 'Windows PowerShell injection assertion regression';
const source = resolveTestPath('scripts', 'windows-real-client-injection.ps1');
const CASE_NAME = 'inject';

function psQuote(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

// 一份宿主真实会写出的报告骨架：除了 injectEvidence，其余字段只用来让脚本走到断言区。
// totals 可被覆盖：分级逻辑要看 bootstraps，测黄级时需要把它压成 0。
function buildReport(injectEvidence, totals = {}) {
  const report = {
    version: '0.1.0',
    host: 'native',
    startedAt: '2026-11-10T00:00:00.000Z',
    finishedAt: '2026-11-10T00:01:00.000Z',
    mode: 'launch',
    durationMs: 180000,
    clientPid: 4321,
    port: 51000,
    attached: false,
    ownershipVerified: true,
    success: true,
    executionMode: 'normal',
    injectStrategy: 'cdp-port',
    stopReason: 'duration',
    injectMode: 'cdp-port',
    commandLineInjected: true,
    endpointProbe: {
      attempts: 2,
      elapsedMs: 40,
      listenerSeen: true,
      ownershipVerified: true,
      versionResponseReceived: true,
      lastReason: 'ready',
      reasonCounts: { ready: 2 }
    },
    totals: { contexts: 1, bootstraps: 1, bundles: 1, pageSessions: 1, errors: 0, ...totals }
  };
  if (injectEvidence !== undefined) report.injectEvidence = injectEvidence;
  return report;
}

const verifiedEvidence = {
  endpointReady: true,
  proxyHook: true,
  proxyHookRequired: false,
  bundleInPage: true,
  bundleSentinelRejected: false,
  verified: true,
  reason: 'verified'
};

// 当前 6/6 的真实形态：链路跑通（endpointReady=true，页面/引导/业务 bundle 都有计数），
// 但页面从未证明 bundle 跑起来了。
//
// ⚠️ 分级在这一态上做了修正（t72）：这一态以前只记黄色，理由是「直接判红会让整条矩阵立刻全红」。
// 但它是**链路通了而 bundle 没落地**——正是「只有功能真生效才可能为 true」的判据该抓的东西。
// 留黄色等于承认「6/6 从未注入成功」却仍然发绿灯，与用户「确保能完整注入」的要求相反。
// 现在这一态判红（strictFailures 含 bundle-not-in-page），裸 verified=false 仍只是黄色。
const unverifiedEvidence = {
  endpointReady: true,
  proxyHook: true,
  proxyHookRequired: false,
  bundleInPage: false,
  bundleSentinelRejected: false,
  verified: false,
  reason: 'bundle-unverified'
};

// 真正只该记黄的一态：CDP 端点没就绪，且页面/引导/业务 bundle 一个都没成。
// 这是"链路根本没起来"（客户端没进考试页、端口没开）—— 与"链路通了但 bundle 没落地"是两回事：
// 后者是这条注入链路自己的失败，前者根本没走到这条链路，判红会与"客户端环境问题"混淆。
const chainDownEvidence = {
  endpointReady: false,
  proxyHook: true,
  proxyHookRequired: false,
  bundleInPage: false,
  bundleSentinelRejected: false,
  verified: false,
  reason: 'not-started'
};

// 载体 DLL 该加载却零日志（t70 报的 P0）：h_proxy_hook_state 返回 ABSENT，
// host-session.inc 把它记成 proxy-carrier-absent 并判失败。
const carrierAbsentEvidence = {
  endpointReady: false,
  proxyHook: false,
  proxyHookRequired: true,
  bundleInPage: false,
  bundleSentinelRejected: false,
  verified: false,
  reason: 'proxy-carrier-absent'
};

// 页面明确否定：哨兵回答 false 或抛异常，宿主自己也会把 stopReason 定成 inject-bundle-unconfirmed。
const rejectedEvidence = {
  endpointReady: true,
  proxyHook: true,
  proxyHookRequired: false,
  bundleInPage: false,
  bundleSentinelRejected: true,
  verified: false,
  reason: 'bundle-sentinel-rejected'
};

// 依赖脚本全部顶掉：不启动客户端、不抓屏、不改输入法、不重启 Explorer，只保留编排与断言。
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

// 宿主进程顶成"启动即退出"的真实进程：不启动客户端，只把合成的 report.json 写进本次运行的私有
// 目录（就是 -RedirectStandardOutput 的父目录），于是脚本读到的是这份报告。
// 必须返回真实的 System.Diagnostics.Process —— 脚本的 finally 会把它传给
// Stop-OwnedProcess([System.Diagnostics.Process])，PSCustomObject 过不了参数类型转换（实测报
// "无法创建 System.Diagnostics.Process 类型的对象"），而且 finally 报错会盖掉原本的断言失败原因。
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

// 7z 顶成脚本（Find-SevenZip 走 Get-Command）、宿主顶成函数、Explorer 修复顶成空实现。
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

function runInjectionCase(report) {
  const directory = createTestDirectory('inject-evidence');
  const runner = path.join(directory, 'runner');
  mkdirSync(runner);
  const script = path.join(directory, 'windows-real-client-injection.ps1');
  copyFileSync(source, script);
  const installer = path.join(directory, 'installer.fixture');
  writeFileSync(installer, 'fixture only');
  const hostFixture = path.join(directory, 'host.fixture');
  writeFileSync(hostFixture, 'must not launch');
  for (const [name, content] of STUBS) writePowerShellScript(path.join(directory, name), content);
  // 依赖脚本由真实脚本自己按 $PSScriptRoot dot-source，所以 stub 里的 Get-Command / Start-Process
  // 只在这个脚本的作用域内生效，不会影响 harness 本身。
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
  assert.ok(line, `harness must report the script outcome:\n${result.stdout}\n${result.stderr}`);
  const artifactPath = path.join(runner, `cx-real-client-${CASE_NAME}-${ARTIFACT_REPORT_SUFFIX}`);
  return {
    output: result.stdout,
    error: JSON.parse(line).Error,
    // 这就是 CI 下载到的那份 artifact：断言必须落在它上面，而不是只落在一个局部变量上。
    artifact: existsSync(artifactPath) ? JSON.parse(readFileSync(artifactPath, 'utf8')) : null,
    artifactPath
  };
}

test('verified=true 的报告通过，且不产生任何未验证告警', { skip: windowsOnly }, () => {
  const result = runInjectionCase(buildReport(verifiedEvidence));
  assert.equal(result.error, '', result.output);
  assert.match(result.output, /REAL_CLIENT_INJECTION_PASS inject/u, result.output);
  assert.doesNotMatch(result.output, /INJECT_BUNDLE_UNVERIFIED/u, 'verified=true 不得告警');
  assert.ok(result.artifact, `CI 上传的 report.json 必须存在:\n${result.output}`);
  assert.deepEqual(result.artifact.injectVerifiedSummary, {
    total: 1,
    verifiedTrue: 1,
    verifiedFalse: 0,
    bundleInPage: true,
    bundleSentinelRejected: false,
    reason: 'verified',
    chainRan: true,
    strictFailures: []
  });
});

// 这是本任务的核心判据（t72 第三级）：pageSessions/bootstraps/bundles 全部 >= 1，
// 说明 CDP 链路与 bootstrap 都通了，但 bundleInPage=false —— 链路通了而 bundle 没落地，
// 必须判红。以前的判据只断那三个计数器，所以这一态是绿的，整条矩阵报"全绿但从未注入成功"。
test('链路通了但 bundle 没落地判红（pageSessions/bootstraps 都有计数而 bundleInPage=false）', { skip: windowsOnly }, () => {
  const result = runInjectionCase(buildReport(unverifiedEvidence));
  assert.match(result.error, /The page never proved the injected bundle ran for inject/u, `必须判红:\n${result.output}`);
  assert.match(result.error, /bundleInPage=False/u, result.error);
  assert.match(result.error, /reason=bundle-unverified/u, result.error);
  assert.doesNotMatch(result.output, /REAL_CLIENT_INJECTION_PASS/u, 'bundle 没落地不得报 PASS');
  assert.ok(result.artifact, `失败路径也必须留下 artifact:\n${result.output}`);
  assert.deepEqual(result.artifact.injectVerifiedSummary.strictFailures, ['bundle-not-in-page']);
  assert.equal(result.artifact.injectVerifiedSummary.chainRan, true, '链路确实跑过，这正是判红的依据');
  assert.equal(result.artifact.injectVerifiedSummary.bundleInPage, false);
});

// 黄级（warning-only）的**可达范围**——这一条是本次改动的边界说明，不是一个行为回归。
//
// 实测（t72）：脚本在 injectEvidence 分级之前还有三条既有断言 pageSessions/bootstraps/bundles >= 1
// （:389-391）。因此凡是能活着走到 injectEvidence 分级的报告，bootstraps 必然 >= 1。
// 配合新的 chainRan = endpointReady && bootstraps >= 1，可得：
//   endpointReady=true  -> chainRan=true  -> bundleInPage=false 必然判红（bundle-not-in-page）
//   endpointReady=false -> 走不到这里（端点没起来时宿主的 bootstrap 也不会 ACK，先在 :390 红）
// 也就是说 **verified=false 且 bundleInPage=false 的报告，在当前脚本里没有任何一条能只记黄**。
// 黄色分支保留为防御：一旦上面三条计数器断言被放宽（例如允许"端点起但引导未送达"作为合法中间态），
// 它会立刻接管那一档，而不是让整条矩阵直接全红。
// 这里显式测试的是"黄级不会被静默绕过"：chainRan=false 时 strictFailures 不含 bundle-not-in-page。
test('chainRan=false（端点没就绪）时不把 bundle 未落地列为 strictFailure', { skip: windowsOnly }, () => {
  // 直接把 bootstraps 记成 1 以满足 :390 的既有断言，但把 endpointReady 置 false：
  // 这是唯一能走到分级逻辑、且 chainRan 为 false 的形态。
  const result = runInjectionCase(buildReport(chainDownEvidence));
  assert.equal(result.error, '', `端点没就绪不得判红:\n${result.output}`);
  assert.match(result.output, /REAL_CLIENT_INJECTION_PASS inject/u, result.output);
  assert.match(result.output, /::warning::INJECT_BUNDLE_UNVERIFIED case=inject/u, result.output);
  assert.equal(result.artifact?.injectVerifiedSummary?.verifiedFalse, 1);
  assert.equal(result.artifact.injectVerifiedSummary.chainRan, false, '端点未就绪 = 链路没跑到');
  assert.deepEqual(
    result.artifact.injectVerifiedSummary.strictFailures,
    [],
    'chainRan=false 时 bundle 未落地不算注入回归，因此不列入 strictFailures'
  );
});

test('载体 DLL 该加载却零日志（proxy-carrier-absent）判红', { skip: windowsOnly }, () => {
  const result = runInjectionCase(buildReport(carrierAbsentEvidence));
  assert.match(result.error, /The proxy carrier DLL never ran for inject/u, `必须判红:\n${result.output}`);
  assert.match(result.error, /proxy-carrier-absent/u, result.error);
  assert.doesNotMatch(result.output, /REAL_CLIENT_INJECTION_PASS/u);
  // 载体没跑时 bundle 必然也没落地，两条 strictFailures 同时成立是正常的；
  // 关键是 proxy-carrier-absent 必须在里面，且它是根因（bundle 是后果）。
  assert.ok(
    result.artifact.injectVerifiedSummary.strictFailures.includes('proxy-carrier-absent'),
    `根因必须被记录:\n${JSON.stringify(result.artifact.injectVerifiedSummary)}`
  );
});

test('bundleSentinelRejected=true（页面明确否定）判红，且汇总仍随报告落盘', { skip: windowsOnly }, () => {
  const result = runInjectionCase(buildReport(rejectedEvidence));
  assert.match(result.error, /The page rejected the injected bundle for inject/u, `必须判红:\n${result.output}`);
  assert.match(result.error, /bundleSentinelRejected=true/u, result.error);
  assert.match(result.error, /bundle-sentinel-rejected/u, result.error);
  assert.doesNotMatch(result.output, /REAL_CLIENT_INJECTION_PASS/u, '明确否定不得报 PASS');
  assert.match(result.output, /::error::real-client failed case=inject/u, result.output);
  assert.ok(result.artifact, `失败路径也必须留下 artifact:\n${result.output}`);
  assert.deepEqual(result.artifact.injectVerifiedSummary.strictFailures, ['bundle-sentinel-rejected']);
  assert.equal(result.artifact.injectVerifiedSummary.bundleSentinelRejected, true);
  assert.equal(result.artifact.injectVerifiedSummary.verifiedFalse, 1);
});

test('报告里没有 injectEvidence 判红（报告契约被改坏，不能静默放过）', { skip: windowsOnly }, () => {
  const result = runInjectionCase(buildReport(undefined));
  assert.match(result.error, /has no injectEvidence object for inject/u, `必须判红:\n${result.output}`);
  assert.doesNotMatch(result.output, /REAL_CLIENT_INJECTION_PASS/u);
});

test('injectEvidence 缺 bundleInPage / verified / reason / bundleSentinelRejected 任一个都判红', { skip: windowsOnly }, () => {
  for (const field of ['bundleInPage', 'verified', 'reason', 'bundleSentinelRejected']) {
    const evidence = { ...verifiedEvidence };
    delete evidence[field];
    const result = runInjectionCase(buildReport(evidence));
    assert.match(result.error, new RegExp(`injectEvidence is missing '${field}' for inject`, 'u'),
      `缺 ${field} 必须判红:\n${result.output}`);
    assert.doesNotMatch(result.output, /REAL_CLIENT_INJECTION_PASS/u);
  }
});
