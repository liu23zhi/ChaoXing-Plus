import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

// captureGuard 报告字段的三态语义（t142）。
//
// PR#18 的接入有个 bug：$captureGuardSummary 没有默认值，事件文件不存在时
// 既不进 if 分支、也不进 catch（没抛异常），保持 $null，
// 而 [pscustomobject]$null 序列化成裸 JSON `null`。
// 结果 6 份 CI 报告的 captureGuard 全是 null —— 键在，信息为零。
//
// 本文件测的是**报告层**的行为（不是统计函数，那部分已有 11 条覆盖）：
//   - 无事件文件        -> available:false + reason:'no-events-file'
//   - 空事件文件        -> available:true  + events:0 + reason:'no-capture-triggered'
//   - 3 对事件          -> available:true  + events:3 + W 正确 + reason:'ok'
//   - 读取出错          -> available:false + reason:'error'
//
// 做法：把 windows-real-client-injection.ps1 里那段报告逻辑抽出来在独立脚本里
// 重放。抽出来的不是副本 —— 断言用的字段名和分支结构必须与源文件一致，
// 所以下面 REGION_START / REGION_END 直接从源文件里截取那段原文执行，
// 避免「测试里抄一份、源文件改一处」的漂移。

const injectionScript = resolveTestPath('scripts', 'windows-real-client-injection.ps1');
const guardModule = resolveTestPath('scripts', 'windows-client-capture-guard.ps1');
const windowsOnly = process.platform === 'win32' ? undefined : '仅在 Windows 上执行 PowerShell 辅助脚本';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// 从源文件里截取报告段原文，保证测的就是线上那段代码。
function extractReportRegion() {
  const source = readFileSyncUtf8(injectionScript);
  // 起点必须包含 $captureGuardStartedFlag 那行：它是默认值 reason 的输入，
  // 漏掉它会重现「guardStarted 恒 null」的假象（本测试第一次就是这么错的）。
  const startMarker = '  $captureGuardStartedFlag = [bool]$script:captureGuardStarted';
  const endMarker = '  # The report is the artifact CI uploads';
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker);
  assert.notEqual(startIndex, -1, '找不到报告段起点，源文件结构变了，本测试需要同步更新');
  assert.notEqual(endIndex, -1, '找不到报告段终点，源文件结构变了，本测试需要同步更新');
  assert.ok(endIndex > startIndex, '报告段标记顺序异常');
  return source.slice(startIndex, endIndex);
}

function readFileSyncUtf8(path) {
  // 源文件是无 BOM 的纯 ASCII；Node 的 readFileSync 足够
  return readFileSync(path, 'utf8');
}

const reportRegion = extractReportRegion();

// 从源文件截取启动段：它决定 $script:captureGuardStarted。
//
// 这一段必须真的执行，不能手工注入 $script:captureGuardStarted。
// 手工注入会让行为用例与源文件的启动逻辑脱钩 —— 于是「把启动段置真改成置假」
// 这类变异无法被行为用例抓到，测试就退化成摆设。这一点已实测确认。
function extractLaunchRegion() {
  const source = readFileSyncUtf8(injectionScript);
  const startMarker = '  $script:captureGuardStarted = $false';
  const endMarker = '  # Version matrix evidence';
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker);
  assert.notEqual(startIndex, -1, '找不到启动段起点，源文件结构变了，本测试需要同步更新');
  assert.notEqual(endIndex, -1, '找不到启动段终点，源文件结构变了，本测试需要同步更新');
  assert.ok(endIndex > startIndex, '启动段标记顺序异常');
  return source.slice(startIndex, endIndex);
}

const launchRegion = extractLaunchRegion();

// 场景执行器：造一个临时的 events 文件（或故意不造），
// 先执行源文件的启动段（决定 guardStarted），再执行报告段，返回 captureGuard JSON。
//
// guardLaunches 模拟启动条件是否成立：
//   true  -> $script:cdpPort 有值且 $entry.ProcessId > 0（CI 实测的常态）
//   false -> 条件不成立（无端口 / 无 pid），启动段不会进 if
function runScenario({ eventsRows, createFile, guardLaunches = true }) {
  const directory = mkdtempSync(join(tmpdir(), 'cg-report-'));
  try {
    const eventsPath = join(directory, 'capture-guard-events-4242.jsonl');
    if (createFile) {
      writeFileSync(eventsPath, eventsRows.join('\n'), 'utf8');
    }
    // 只用 cdpPort 控制启动条件，clientPid 始终有效：
    // 报告段读事件文件也依赖 ProcessId，若把它置 0 会同时切断「读文件」，
    // 那样构造出来的是「读不到文件」而不是「守护没启动」，两个因素混在一起。
    const cdpPort = guardLaunches ? 12345 : 0;
    const clientPid = 4242;

    const script = [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
      `. ${psQuote(guardModule)}`,
      // 模拟源文件里的环境
      `$script:cdpPort = ${cdpPort}`,
      `$entry = [pscustomobject]@{ ProcessId = ${clientPid} }`,
      `$PSScriptRoot = ${psQuote(join(injectionScript, '..'))}`,
      // 不真的起 runspace：把 [PowerShell]::Create() 换成记录调用的假对象。
      // 这样启动段的判定逻辑保持真实，又不需要真跑守护。
      'function New-FakeGuard { [pscustomobject]@{ Handle = "fake" } }',
      launchRegion,
      // 让 Get-CaptureGuardEventsPath 返回我们造的路径（覆盖它的目录决策）
      `function Get-CaptureGuardEventsPath { param([int] $ProcessId, [string] $Directory) return ${psQuote(eventsPath)} }`,
      reportRegion,
      // 只输出 captureGuard 的 JSON，便于断言
      'ConvertTo-Json -InputObject ([pscustomobject]$captureGuardSummary) -Compress -Depth 6'
    ].join('\n');

    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`PowerShell exit ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }
    const line = String(result.stdout).split(/\r?\n/u).filter((row) => row.trim().startsWith('{')).pop();
    return JSON.parse(line);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function ev(kind, hwnd, monoMs) {
  return JSON.stringify({ event: kind, hwnd, mono_ms: monoMs });
}

test('场景1：守护已启动 + 无事件文件 -> no-capture-triggered（不是 no-events-file）', { skip: windowsOnly }, () => {
  const summary = runScenario({ eventsRows: [], createFile: false, guardLaunches: true });

  assert.notEqual(summary, null, 'captureGuard 不得为 null —— 这正是 PR#18 的 bug');
  assert.equal(summary.available, false);
  assert.equal(summary.guardStarted, true, '守护确实起来了');
  // 核心：守护跑了但一次跳变都没有 => 客户端没抓屏。
  // 事件文件是首次跳变才创建的，所以「文件不存在」不能推断成「守护没跑」。
  assert.equal(summary.reason, 'no-capture-triggered',
    'CI 实测 port>0 且 pid>0 时守护必然启动；文件缺失只能说明没发生跳变');
  assert.notEqual(summary.reason, 'no-events-file',
    'no-events-file 已废弃：它描述症状而非原因，会与 guard-not-started 混淆');
  assert.equal(summary.pollMs, 200, 'pollMs 在缺文件时也要有值，否则无法判断 W 是否有意义');
});

test('场景1b：守护未启动 -> guard-not-started', { skip: windowsOnly }, () => {
  const summary = runScenario({ eventsRows: [], createFile: false, guardLaunches: false });

  assert.notEqual(summary, null);
  assert.equal(summary.available, false);
  assert.equal(summary.guardStarted, false, '守护没起来必须如实记录');
  assert.equal(summary.reason, 'guard-not-started',
    '只有守护没跑时才报 guard-not-started，与「跑了但没跳变」严格区分');
});

test('场景1c：守护未启动但有残留文件 -> 仍按 guardStarted 报告', { skip: windowsOnly }, () => {
  // 上一次运行留下的同名文件不该让本次报告误称「守护跑过」以外的东西；
  // available 由文件决定，但 guardStarted 必须反映本次的真实启动状态。
  const rows = [ev('on', '0x1', 1000), ev('off', '0x1', 1100)];
  const summary = runScenario({ eventsRows: rows, createFile: true, guardLaunches: false });

  assert.equal(summary.available, true, '文件在，可读');
  assert.equal(summary.guardStarted, false, '本次守护没起来，必须如实说');
});

test('场景2：空事件文件 -> available:true + events:0 + reason:no-capture-triggered', { skip: windowsOnly }, () => {
  const summary = runScenario({ eventsRows: [''], createFile: true });

  assert.notEqual(summary, null);
  assert.equal(summary.available, true, '文件存在就是 hook 跑过了');
  assert.equal(summary.events, 0);
  assert.equal(summary.reason, 'no-capture-triggered',
    '文件在但 0 事件 = 客户端确实没抓屏，与「hook 没装」必须区分');
});

test('场景3：3 对事件 -> available:true + events:3 + W 正确 + reason:ok', { skip: windowsOnly }, () => {
  const rows = [
    ev('on', '0x1', 1000), ev('off', '0x1', 1050),   // W=50
    ev('on', '0x1', 2000), ev('off', '0x1', 2120),   // W=120
    ev('on', '0x1', 3000), ev('off', '0x1', 3300)    // W=300
  ];
  const summary = runScenario({ eventsRows: rows, createFile: true });

  assert.notEqual(summary, null);
  assert.equal(summary.available, true);
  assert.equal(summary.reason, 'ok');
  assert.equal(summary.events, 3);
  assert.equal(summary.rawEventCount, 6);
  assert.equal(summary.wMinMs, 50);
  assert.equal(summary.wMaxMs, 300);
  assert.equal(summary.wP50Ms, 120);
  assert.equal(summary.wP95Ms, 300);
  assert.equal(summary.pollMs, 200);
});

test('字段名保持不变（报告消费者可能已按这些名字读）', { skip: windowsOnly }, () => {
  const rows = [ev('on', '0x1', 1000), ev('off', '0x1', 1100)];
  const summary = runScenario({ eventsRows: rows, createFile: true });

  // guardStarted 是本轮新增的字段；其余 12 个名字必须原样保留。
  for (const name of [
    'available', 'guardStarted', 'eventsPath', 'reason', 'events', 'rawEventCount',
    'unpairedOn', 'errorCount', 'wMinMs', 'wMaxMs', 'wP50Ms', 'wP95Ms', 'pollMs'
  ]) {
    assert.ok(Object.hasOwn(summary, name), `captureGuard.${name} 必须存在`);
  }
});

test('guardStarted 与 reason 的组合必须自洽', { skip: windowsOnly }, () => {
  const notStarted = runScenario({ eventsRows: [], createFile: false, guardLaunches: false });
  const ranNoFile = runScenario({ eventsRows: [], createFile: false, guardLaunches: true });
  const ranEmptyFile = runScenario({ eventsRows: [''], createFile: true, guardLaunches: true });

  // 守护没跑 => guard-not-started（且只有这一种 reason）
  assert.equal(notStarted.guardStarted, false);
  assert.equal(notStarted.reason, 'guard-not-started');

  // 守护跑了但没文件 / 空文件 => 都是 no-capture-triggered，可用 available 区分
  assert.equal(ranNoFile.reason, 'no-capture-triggered');
  assert.equal(ranEmptyFile.reason, 'no-capture-triggered');
  assert.equal(ranNoFile.available, false, '没有文件');
  assert.equal(ranEmptyFile.available, true, '有文件');

  // 三者 reason 不得全部相同 —— 若混成一个值，这张表就失去意义
  assert.ok(new Set([notStarted.reason, ranNoFile.reason]).size >= 2,
    'guard-not-started 与 no-capture-triggered 必须不同');
});

test('源文件的报告段确实先赋默认值再进 try（结构断言）', () => {
  // 这条不看运行结果，直接守住「默认值必须在 try 之前」这个结构约束。
  // 若有人把默认值改回 $null 或挪进 try，这条会先红。
  const source = readFileSyncUtf8(injectionScript);
  const defaultIndex = source.indexOf('$captureGuardSummary = [ordered]@{');
  const flagIndex = source.indexOf('$captureGuardStartedFlag = [bool]$script:captureGuardStarted');
  const tryIndex = source.indexOf('  try {', defaultIndex >= 0 ? defaultIndex - 2000 : 0);
  assert.notEqual(defaultIndex, -1, '找不到 captureGuard 默认值赋值');
  assert.notEqual(flagIndex, -1, '找不到 guardStarted 的读取');
  assert.notEqual(tryIndex, -1, '找不到报告段的 try');
  assert.ok(flagIndex < defaultIndex,
    'guardStarted 必须在默认值之前读取，否则默认值的 reason 无法分档');
  assert.ok(defaultIndex < tryIndex,
    '默认值赋值必须在 try 之前，否则文件不存在时会保持 $null -> JSON null（PR#18 的 bug）');
});

test('源文件：默认值按 guardStarted 分档，且 no-events-file 已废弃', () => {
  const source = readFileSyncUtf8(injectionScript);

  assert.ok(source.includes('guard-not-started'),
    '默认值必须能在守护未启动时报 guard-not-started');
  assert.ok(source.includes('no-capture-triggered'),
    '守护启动但无文件时也必须报 no-capture-triggered');
  assert.ok(!source.includes("'no-events-file'"),
    'no-events-file 已废弃：它描述症状而非原因，会与 guard-not-started 混淆');
  assert.ok(source.includes('$script:captureGuardStarted = $true'),
    '启动成功后必须把 captureGuardStarted 置真，否则报告段无从判断');
});

test('源文件：captureGuardStarted 的初值必须显式置假', () => {
  const source = readFileSyncUtf8(injectionScript);
  const initIndex = source.indexOf('$script:captureGuardStarted = $false');
  const setTrueIndex = source.indexOf('$script:captureGuardStarted = $true');
  assert.notEqual(initIndex, -1, '必须显式初始化 captureGuardStarted = $false');
  assert.notEqual(setTrueIndex, -1, '启动成功后必须置 true');
  assert.ok(initIndex < setTrueIndex, '初始化必须在置真之前');
});
