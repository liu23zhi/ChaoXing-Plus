import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

const inputScript = resolveTestPath('scripts', 'windows-client-input.ps1');
const injectionScript = resolveTestPath('scripts', 'windows-real-client-injection.ps1');
const preparationScript = resolveTestPath('scripts', 'ci', 'prepare-windows-real-client-environment.ps1');
const windowsOnly = process.platform === 'win32' ? undefined : '仅在 Windows 上检查输入法状态';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

test('输入法状态可采集，且未变化时恢复是空操作', { skip: windowsOnly }, () => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(inputScript)}`,
    '$before = Get-InputState',
    'Start-Sleep -Milliseconds 200',
    '$after = Get-InputState',
    '$diff = Compare-InputState -Before $before -After $after',
    '$restored = Restore-InputState -State $before',
    '@{ before = $before; diff = @($diff); restored = @($restored) } | ConvertTo-Json -Compress -Depth 6'
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
  const line = String(result.stdout)
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.startsWith('{'))
    .pop();
  assert.ok(line, `脚本必须输出输入法状态: ${result.stdout}${result.stderr}`);
  const json = JSON.parse(line);
  assert.ok(Array.isArray(json.before.LayoutHandles) && json.before.LayoutHandles.length >= 1,
    '必须能列出已加载的键盘布局');
  assert.match(json.before.ActiveLayout, /^0x[0-9A-F]{8}$/u, '必须记录当前激活布局句柄');
  assert.match(json.before.DefaultInputLanguage ?? '', /^0x[0-9A-F]{8}$/u, '必须记录系统默认输入语言（客户端会用 SPI_SETDEFAULTINPUTLANG 改它）');
  assert.deepEqual(json.diff, [], '同一状态连续采集不应出现差异');
  assert.deepEqual(json.restored, [], '状态未变化时恢复必须是空操作');
});

test('注入脚本在运行前后快照并恢复输入法', async () => {
  const script = await readFile(injectionScript, 'utf8');
  assert.match(script, /\.\s*\(Join-Path \$PSScriptRoot 'windows-client-input\.ps1'\)/u, '注入脚本必须 dot-source 输入法助手');
  assert.match(script, /\$inputState = Get-InputState/u, '启动客户端前必须快照输入法状态');
  assert.match(script, /cx-real-client-\$CaseName-input-before\.json/u, '必须落盘输入法快照');
  assert.match(script, /Restore-InputState -State \$inputState/u, '结束后必须恢复输入法');
  assert.match(script, /input changed=\$\(\$inputChanges -join ','\) restored=\$\(\$restoredInput -join ','\)/u,
    '必须记录输入法是否被改动以及恢复结果');
  assert.match(script, /Save-RunArtifacts -CaseName \$CaseName/u, '成功与失败都要保留现场');
  const helper = readFileSync(inputScript, 'utf8');
  // 客户端导入 LoadKeyboardLayoutW/UnloadKeyboardLayout 并在退出时留下自载布局，恢复必须卸载多余布局。
  assert.match(helper, /Unload/u, '恢复时需要卸载客户端自载的布局');
  assert.match(helper, /KlidFromHkl/u, '恢复时要把缺失的布局重新载入');
  assert.match(helper, /SPI_SETDEFAULTINPUTLANG|0x005A/u, '必须能恢复系统默认输入语言');
  assert.match(helper, /SystemParametersInfoW\(0x0059/u, '必须快照系统默认输入语言');
  assert.match(helper, /New-WinUserLanguageList -Language \$entry\.Tag/u,
    'New-WinUserLanguageList 只接受单个语言，必须逐个构造');
  assert.doesNotMatch(helper, /New-WinUserLanguageList -Language \$tags/u,
    '传数组会得到空列表，调用 Set-WinUserLanguageList 会清空全部语言');
  assert.match(helper, /refusing to clear the configured languages/u, '语言列表为空时必须拒绝写入');
  const restoreBody = helper.slice(helper.indexOf('function Restore-InputState'));
  assert.ok(restoreBody.indexOf('Set-WinUserLanguageList -LanguageList $list') > 0, '恢复分支必须写回语言列表');
  assert.ok(restoreBody.indexOf('Set-WinUserLanguageList -LanguageList $list') < restoreBody.indexOf("foreach ($name in @('Preload', 'Substitutes'))"),
    '必须先恢复语言列表再写注册表：Set-WinUserLanguageList 会重写 Preload');
});

test('CI 桌面环境准备脚本可在无副作用模式下运行', () => {
  const bytes = readFileSync(preparationScript);
  for (const byte of bytes) assert.equal(byte <= 0x7f, true, 'prepare-windows-real-client-environment.ps1 必须保持纯 ASCII');
  const result = spawnSync('pwsh', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', preparationScript, '-DryRun', '-SkipResolution', '-SkipCamera'
  ], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[desktop-prep\]/u, '必须输出准备日志');
  assert.doesNotMatch(result.stdout, /camera: choco install/u, '跳过开关不得真的安装摄像头驱动');
});

test('输入法准备改用仓库内伪装输入法，不再下载或安装第三方输入法', () => {
  const source = readFileSync(preparationScript, 'utf8');
  assert.doesNotMatch(source, /winget|ime\.gtimg\.com|sogou-ime-v|Install-SogouInputMethod|Get-SogouInputState|Resolve-SogouInputInstaller/iu,
    'CI 不得再下载或安装第三方输入法');
  assert.doesNotMatch(source, /Add-WindowsCapability|Set-WinUserLanguageList|InputMethodTips/u,
    '不再下载语言包或注册系统自带输入法');
  assert.doesNotMatch(source, /Install-Language/u, 'Install-Language 在 runner 上会长时间挂起，不得使用');
  assert.match(source, /function Install-StandInInputMethod/u, '必须用仓库内伪装输入法替代第三方安装');
  assert.match(source, /tools\/fake-ime/u, '必须指向 tools/fake-ime');
  assert.match(source, /Install-FakeInputMethod\.ps1/u, '必须调用伪装输入法安装脚本');
  assert.match(source, /-DisplayName 'StandInInput'/u, '必须传入稳定的布局描述');
  assert.match(source, /function Get-ImmInputMethodProbe/u, '必须保留客户端判据探针');
  assert.match(source, /ImmGetDescriptionW/u, '探针必须使用客户端同一个 API');
  assert.match(source, /function Test-ImmInputMethodReady/u, '必须按非空描述判定就绪');
  assert.match(source, /stand-in-installed'/u, '必须记录安装成功');
  assert.match(source, /stand-in-installed-but-not-ready/u, '安装成功但描述为空必须能区分');
  assert.match(source, /stand-in-fixture-missing/u, '夹具缺失必须显式记录');
  assert.match(source, /stand-in-build-failed/u, '模块编译失败必须显式记录');
  assert.match(source, /Invoke-Bounded -Label 'input: build stand-in IME module'/u, '编译步骤必须带超时');
  assert.match(source, /cx-real-client-prep-summary\.json/u, '准备阶段必须写出可下载的摘要');
  assert.match(source, /input: imm \$line/u, '必须逐条打印每个布局的 IMM 描述');
});

test('准备脚本只保留整体跳过开关，没有第三方输入法专用开关', () => {
  const source = readFileSync(preparationScript, 'utf8');
  assert.match(source, /\[switch\] \$SkipInputMethod/u, '必须能整体跳过输入法准备');
  assert.doesNotMatch(source, /\[switch\] \$SkipSogouInputMethod/u, '第三方输入法开关必须删除');
  assert.doesNotMatch(source, /\$SogouImeInstaller/u, '第三方安装包参数必须删除');
  assert.match(source, /if \(-not \$SkipInputMethod\) \{ \$null = Install-StandInInputMethod \}/u, '主流程必须直接调用伪装输入法准备');
});

test('准备脚本不再引用搜狗安装包与清单', async () => {
  const { access } = await import('node:fs/promises');
  for (const relative of [
    ['tests', 'private-clients', 'sogou-ime-v16.9.0.5523.exe'],
    ['tests', 'private-clients', 'sogou-ime.json'],
    ['scripts', 'ci', 'verify-sogou-resolver.ps1'],
    ['tests', 'fixtures', 'sogou-imm-vm', 'sogou-ime-v16.9.0.5523.exe']
  ]) {
    await assert.rejects(access(resolveTestPath(...relative)), '输入法安装包与清单必须删除');
  }
});
