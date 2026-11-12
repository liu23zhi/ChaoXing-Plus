import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

// Capture-guard 事件落盘与 W 汇总（t139）。
//
// 为什么要测这些纯函数：
//   Watch-ClientCaptureGuard 跑在独立 runspace 里，CI 日志看不到它的输出，
//   唯一能判断「200ms 轮询够不够」的数据是它落盘的 capture-guard-events-<pid>.jsonl。
//   如果 W 算错或分位数算错，得到的就是错误结论 —— 而错误结论比没有结论更糟
//   （会导致「轮询够用」或「必须上 hook」的误判）。
//
// 覆盖点：
//   - 正常配对 -> W 正确
//   - 奇数个事件（on 没有 off）-> 不崩，unpairedOn 如实反映
//   - 0 事件 -> events:0，不是报错
//   - 多窗口不交叉配对
//   - 负值（坏数据）被丢弃
//   - nearest-rank 分位数的索引

const guardModule = resolveTestPath('scripts', 'windows-client-capture-guard.ps1');
const windowsOnly = process.platform === 'win32' ? undefined : '仅在 Windows 上执行 PowerShell 辅助脚本';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// 一个 PowerShell 进程跑完全部用例：每个断言单开一次进程只会放大调度噪声。
function runCases(cases) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(guardModule)}`,
    '$out = [ordered]@{}',
    ...cases.map((entry) => entry.statement),
    '$out | ConvertTo-Json -Compress -Depth 6'
  ].join('\n');

  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`PowerShell exit ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  const line = String(result.stdout).split(/\r?\n/u).filter((row) => row.trim().startsWith('{')).pop();
  return JSON.parse(line);
}

// 事件构造器：只关心 event / hwnd / mono_ms
function ev(kind, hwnd, monoMs) {
  return `[pscustomobject]@{event='${kind}'; hwnd='${hwnd}'; mono_ms=${monoMs}}`;
}

test('正常配对：W = off.mono_ms - on.mono_ms', { skip: windowsOnly }, () => {
  const cases = [
    {
      name: 'paired',
      statement: [
        '$e = @(',
        [ev('on', '0x1', 1000), ev('off', '0x1', 1050)].join(','),
        ',' + [ev('on', '0x1', 2000), ev('off', '0x1', 2120)].join(','),
        ',' + [ev('on', '0x1', 3000), ev('off', '0x1', 3300)].join(','),
        ')',
        '$out.paired = Get-CaptureGuardWindowStats -Events $e'
      ].join('\n')
    }
  ];
  const result = runCases(cases);
  assert.equal(result.paired.events, 3, '三对事件应产生 3 个 W 样本');
  assert.equal(result.paired.wMinMs, 50, '最小 W 应为 50ms');
  assert.equal(result.paired.wMaxMs, 300, '最大 W 应为 300ms');
  assert.equal(result.paired.unpairedOn, 0, '没有未配对 on');
});

test('W 不会算成 on.mono - off.mono（负值方向）', { skip: windowsOnly }, () => {
  const cases = [
    {
      name: 'sign',
      statement: [
        '$e = @(',
        [ev('on', '0x1', 1000), ev('off', '0x1', 1180)].join(','),
        ')',
        '$out.sign = Get-CaptureGuardWindowStats -Events $e'
      ].join('\n')
    }
  ];
  const result = runCases(cases);
  assert.equal(result.sign.wMinMs, 180, 'W 必须是正数 180（off 在 on 之后）');
  assert.ok(result.sign.wMinMs > 0, 'W 不得为负');
});

test('奇数个事件（on 没有 off）不崩且 unpairedOn 如实反映', { skip: windowsOnly }, () => {
  const cases = [
    {
      name: 'odd',
      statement: [
        '$e = @(',
        [ev('on', '0x1', 1000), ev('off', '0x1', 1080)].join(','),
        ',' + ev('on', '0x1', 2000),
        ')',
        '$out.odd = Get-CaptureGuardWindowStats -Events $e'
      ].join('\n')
    }
  ];
  const result = runCases(cases);
  assert.equal(result.odd.events, 1, '只有一对能算 W');
  assert.equal(result.odd.wMinMs, 80);
  assert.equal(result.odd.unpairedOn, 1, '悬空的 on 必须被单独计数，不能静默丢弃');
});

test('0 事件：events 为 0 且 min/max/P 均为 null，不抛异常', { skip: windowsOnly }, () => {
  const cases = [
    {
      name: 'empty',
      statement: '$out.empty = Get-CaptureGuardWindowStats -Events @()'
    }
  ];
  const result = runCases(cases);
  assert.equal(result.empty.events, 0);
  assert.equal(result.empty.wMinMs, null);
  assert.equal(result.empty.wMaxMs, null);
  assert.equal(result.empty.wP50Ms, null);
  assert.equal(result.empty.wP95Ms, null);
});

test('多窗口不交叉配对', { skip: windowsOnly }, () => {
  const cases = [
    {
      name: 'multiwindow',
      statement: [
        '$e = @(',
        [ev('on', '0xA', 1000), ev('on', '0xB', 1100), ev('off', '0xA', 1200), ev('off', '0xB', 1300)].join(','),
        ')',
        '$out.multi = Get-CaptureGuardWindowStats -Events $e'
      ].join('\n')
    }
  ];
  const result = runCases(cases);
  assert.equal(result.multi.events, 2, '两个窗口各配一对');
  // 若跨窗口错配，会产生 200 与 100 之外的怪值；正确结果是两个 200
  assert.equal(result.multi.wMinMs, 200);
  assert.equal(result.multi.wMaxMs, 200);
});

test('负值（坏数据）被丢弃而不是进入分布', { skip: windowsOnly }, () => {
  const cases = [
    {
      name: 'negative',
      statement: [
        '$e = @(',
        [ev('on', '0x1', 2000), ev('off', '0x1', 1000)].join(','),
        ')',
        '$out.neg = Get-CaptureGuardWindowStats -Events $e'
      ].join('\n')
    }
  ];
  const result = runCases(cases);
  assert.equal(result.neg.events, 0, 'mono_ms 非单调产生负 W，必须丢弃');
});

test('nearest-rank 分位数：1..10 的 P50=5、P95=10', { skip: windowsOnly }, () => {
  const cases = [
    {
      name: 'pct',
      statement: [
        '$v = @(1,2,3,4,5,6,7,8,9,10)',
        '$out.p50 = Get-PercentileValue -SortedValues $v -Percentile 0.50',
        '$out.p95 = Get-PercentileValue -SortedValues $v -Percentile 0.95',
        '$out.single = Get-PercentileValue -SortedValues @(42) -Percentile 0.95'
      ].join('\n')
    }
  ];
  const result = runCases(cases);
  assert.equal(result.p50, 5, 'P50 of 1..10 应为 5');
  assert.equal(result.p95, 10, 'P95 of 1..10 应为 10（nearest-rank 上取整）');
  assert.equal(result.single, 42, '单值任何分位数都是它自己');
});

test('P95 索引：4 个值时取第 4 个而不是第 3 个', { skip: windowsOnly }, () => {
  // ceil(0.95*4)=4 -> index 3。若漏掉 -1 会取到 index 4（越界或错值）。
  const cases = [
    {
      name: 'idx',
      statement: [
        '$v = @(10,20,30,40)',
        '$out.p95 = Get-PercentileValue -SortedValues $v -Percentile 0.95',
        '$out.p50 = Get-PercentileValue -SortedValues $v -Percentile 0.50'
      ].join('\n')
    }
  ];
  const result = runCases(cases);
  assert.equal(result.p95, 40, 'ceil(0.95*4)=4 -> 第 4 个值 40');
  assert.equal(result.p50, 20, 'ceil(0.50*4)=2 -> 第 2 个值 20');
});

test('读 JSONL：坏行跳过并计数，不抛异常', { skip: windowsOnly }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'cg-events-'));
  try {
    const eventsPath = join(directory, 'capture-guard-events-999.jsonl');
    const rows = [
      JSON.stringify({ event: 'on', hwnd: '0x1', mono_ms: 1000 }),
      JSON.stringify({ event: 'off', hwnd: '0x1', mono_ms: 1150 }),
      '{ this is not json',                       // 半截写入
      '',
      JSON.stringify({ event: 'on', hwnd: '0x1', mono_ms: 2000 })
    ];
    writeFileSync(eventsPath, rows.join('\n'), 'utf8');

    const script = [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
      `. ${psQuote(guardModule)}`,
      `$r = Read-CaptureGuardEvents -Path ${psQuote(eventsPath)}`,
      '$s = Get-CaptureGuardWindowStats -Events $r.Lines',
      '@{ available=$r.Available; skipped=$r.Skipped; events=$s.events; wMinMs=$s.wMinMs; unpairedOn=$s.unpairedOn } | ConvertTo-Json -Compress'
    ].join('\n');

    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);

    const parsed = JSON.parse(String(result.stdout).trim().split(/\r?\n/u).pop());
    assert.equal(parsed.available, true);
    assert.equal(parsed.skipped, 1, '坏行必须计数而不是让整份数据报废');
    assert.equal(parsed.events, 1, '一对有效 on/off');
    assert.equal(parsed.wMinMs, 150);
    assert.equal(parsed.unpairedOn, 1, '末尾孤立的 on');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('读 JSONL：文件不存在时 available=false，不抛异常', { skip: windowsOnly }, () => {
  const missing = join(tmpdir(), `cg-missing-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(guardModule)}`,
    `$r = Read-CaptureGuardEvents -Path ${psQuote(missing)}`,
    '$s = Get-CaptureGuardWindowStats -Events $r.Lines',
    '@{ available=$r.Available; events=$s.events } | ConvertTo-Json -Compress'
  ].join('\n');

  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);

  const parsed = JSON.parse(String(result.stdout).trim().split(/\r?\n/u).pop());
  assert.equal(parsed.available, false, '缺文件必须报 available:false');
  assert.equal(parsed.events, 0);
});

test('事件路径优先 RUNNER_TEMP，退化到 TEMP', { skip: windowsOnly }, () => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(guardModule)}`,
    '$withRunner = Get-CaptureGuardEventsPath -ProcessId 4242 -Directory "C:\\runner-temp"',
    '@{ path=$withRunner } | ConvertTo-Json -Compress'
  ].join('\n');

  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);

  const parsed = JSON.parse(String(result.stdout).trim().split(/\r?\n/u).pop());
  assert.match(parsed.path, /capture-guard-events-4242\.jsonl$/u,
    '文件名必须含 pid，否则多个进程会写同一个文件');
  assert.match(parsed.path, /runner-temp/u, '显式 Directory 优先');
});
