import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

const entryScript = resolveTestPath('scripts', 'windows-client-entry.ps1');
const injectionScript = resolveTestPath('scripts', 'windows-real-client-injection.ps1');
const windowsOnly = process.platform === 'win32' ? undefined : '仅在 Windows 上执行原生窗口辅助脚本';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function run(script) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (result.error) throw result.error;
  return result;
}

function runJson(body) {
  const result = run([
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(entryScript)}`,
    body
  ].join('\n'));
  const line = String(result.stdout)
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.startsWith('{'))
    .pop();
  return { result, json: line ? JSON.parse(line) : undefined };
}

test('进入考试按钮坐标由客户区尺寸换算，与 DPI 无关', { skip: windowsOnly }, () => {
  const cases = [
    { width: 1200, height: 700, x: 412, y: 78 },
    { width: 1800, height: 1050, x: 618, y: 117 },
    { width: 2400, height: 1400, x: 824, y: 156 }
  ];
  for (const item of cases) {
    const { result, json } = runJson(`(Get-ClientEntryPoint -Width ${item.width} -Height ${item.height}) | ConvertTo-Json -Compress`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(json, { X: item.x, Y: item.y }, `${item.width}x${item.height} 的按钮坐标必须与实测一致`);
  }

  const invalid = run([
    "$ErrorActionPreference = 'Stop'",
    `. ${psQuote(entryScript)}`,
    "try { Get-ClientEntryPoint -Width 0 -Height 700; 'NO_ERROR' } catch { 'ERROR: ' + $_.Exception.Message }"
  ].join('\n'));
  assert.match(invalid.stdout, /Client area must be positive/u, '非法尺寸必须失败关闭');
});

test('找不到客户端检查窗口时返回明确原因，不误报点击成功', { skip: windowsOnly }, () => {
  const missing = resolveTestPath('.tmp-tests-not-a-client', 'CXExam.exe');
  const { result, json } = runJson(`(Wait-ClientExamEntry -ClientPath ${psQuote(missing)} -TimeoutSeconds 1 -PollMilliseconds 200) | ConvertTo-Json -Compress`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json.Clicked, false);
  assert.equal(json.Reason, 'entry-window-not-found');
  assert.equal(json.ProcessId, 0);
});

test('注入脚本在报告校验前自动点击进入考试，并接受客户端提前退出', async () => {
  const script = await readFile(injectionScript, 'utf8');
  assert.match(script, /\.\s*\(Join-Path \$PSScriptRoot 'windows-client-entry\.ps1'\)/u, '注入脚本必须 dot-source 进入考试助手');
  assert.match(script, /Wait-ClientExamEntry -ClientPath \$client\.FullName/u, '注入脚本必须在宿主启动后点击进入考试');
  assert.match(script, /\$stage = 'enter-exam'/u, '进入考试必须是可报告的独立阶段');
  assert.match(script, /'--duration', '120000'/u, '运行时必须给检查窗口和页面加载留出足够时间');
  assert.match(script, /\$report\.stopReason -notin @\('duration', 'client-exit'\)/u,
    '客户端被关闭或被杀掉后仍应接受完整报告');
  assert.match(script, /entry click=\$\(\$entry\.Reason\)/u, 'pageSessions 为 0 时必须报告进入考试点击结果');
  assert.doesNotMatch(script, /stopReason -ne 'duration'/u, '不得再要求客户端必须自然跑到时长结束');
});

test('进入考试助手保持纯 ASCII 且不发送重复点击', () => {
  const bytes = readFileSync(entryScript);
  for (const byte of bytes) assert.equal(byte <= 0x7f, true, 'windows-client-entry.ps1 必须保持纯 ASCII');
  const text = bytes.toString('utf8');
  assert.equal((text.match(/PostMessageW\(\$window, 0x0201/gu) ?? []).length, 1, '只允许发送一次按下消息，避免打开多个页面');
  assert.doesNotMatch(text, /mouse_event|SetCursorPos|SendInput/u, '不得使用会被 UIPI 或 DPI 影响的整屏输入');
});
