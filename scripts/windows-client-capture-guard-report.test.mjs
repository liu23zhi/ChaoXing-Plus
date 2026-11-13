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
  const startMarker = '  $captureGuardSummary = [ordered]@{';
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

// 场景执行器：造一个临时的 events 文件（或故意不造），
// 重放报告段，返回序列化后的 captureGuard JSON。
function runScenario({ eventsRows, createFile }) {
  const directory = mkdtempSync(join(tmpdir(), 'cg-report-'));
  try {
    const eventsPath = join(directory, 'capture-guard-events-4242.jsonl');
    if (createFile) {
      writeFileSync(eventsPath, eventsRows.join('\n'), 'utf8');
    }

    const script = [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
      `. ${psQuote(guardModule)}`,
      // 模拟源文件里的环境：$entry 带 ProcessId，$PSScriptRoot 指向 scripts/
      `$entry = [pscustomobject]@{ ProcessId = 4242 }`,
      `$PSScriptRoot = ${psQuote(join(injectionScript, '..'))}`,
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

test('场景1：无事件文件 -> available:false + reason:no-events-file', { skip: windowsOnly }, () => {
  const summary = runScenario({ eventsRows: [], createFile: false });

  assert.notEqual(summary, null, 'captureGuard 不得为 null —— 这正是 PR#18 的 bug');
  assert.equal(summary.available, false);
  assert.equal(summary.reason, 'no-events-file',
    '缺文件必须说明是「hook 没跑」，不能与「客户端没抓屏」混为一谈');
  assert.equal(summary.pollMs, 200, 'pollMs 在缺文件时也要有值，否则无法判断 W 是否有意义');
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

  for (const name of [
    'available', 'eventsPath', 'reason', 'events', 'rawEventCount',
    'unpairedOn', 'errorCount', 'wMinMs', 'wMaxMs', 'wP50Ms', 'wP95Ms', 'pollMs'
  ]) {
    assert.ok(Object.hasOwn(summary, name), `captureGuard.${name} 必须存在`);
  }
});

test('两个 reason 取值不同：no-events-file 与 no-capture-triggered 不可混用', { skip: windowsOnly }, () => {
  const missing = runScenario({ eventsRows: [], createFile: false });
  const empty = runScenario({ eventsRows: [''], createFile: true });

  assert.notEqual(missing.reason, empty.reason,
    '两种「没数据」必须有不同的 reason，否则无法判断是配置问题还是客户端行为');
  assert.equal(missing.available, false);
  assert.equal(empty.available, true);
});

test('源文件的报告段确实先赋默认值再进 try（结构断言）', () => {
  // 这条不看运行结果，直接守住「默认值必须在 try 之前」这个结构约束。
  // 若有人把默认值改回 $null 或挪进 try，这条会先红。
  const source = readFileSyncUtf8(injectionScript);
  const defaultIndex = source.indexOf('$captureGuardSummary = [ordered]@{');
  const tryIndex = source.indexOf('  try {', defaultIndex >= 0 ? defaultIndex - 2000 : 0);
  assert.notEqual(defaultIndex, -1, '找不到 captureGuard 默认值赋值');
  assert.notEqual(tryIndex, -1, '找不到报告段的 try');
  assert.ok(defaultIndex < tryIndex,
    '默认值赋值必须在 try 之前，否则文件不存在时会保持 $null -> JSON null（PR#18 的 bug）');
  assert.ok(source.includes("reason     = 'no-events-file'"),
    '默认值必须带 reason:no-events-file');
});
