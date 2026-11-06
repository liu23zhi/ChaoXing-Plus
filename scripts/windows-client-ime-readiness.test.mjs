import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

const preparationScript = resolveTestPath('scripts', 'ci', 'prepare-windows-real-client-environment.ps1');
const windowsOnly = process.platform === 'win32' ? undefined : '仅在 Windows 上运行环境准备脚本';

test('桌面准备改用仓库内伪装输入法，不再下载或安装第三方输入法', () => {
  const source = readFileSync(preparationScript, 'utf8');
  assert.doesNotMatch(source, /winget|ime\.gtimg\.com|sogou-ime-v|Install-SogouInputMethod|Get-SogouInputState|Resolve-SogouInputInstaller/iu,
    'CI 不得再下载或安装第三方输入法');
  assert.doesNotMatch(source, /Add-WindowsCapability|Set-WinUserLanguageList|InputMethodTips/u,
    '不再下载语言包或注册系统自带输入法');
  assert.match(source, /function Install-StandInInputMethod/u, '必须由伪装输入法完成准备');
  assert.match(source, /tools\/fake-ime/u, '必须指向 tools/fake-ime');
  assert.match(source, /Install-FakeInputMethod\.ps1/u, '必须调用伪装输入法的安装脚本');
  assert.match(source, /-DisplayName 'StandInInput'/u, '布局描述必须稳定');
  assert.match(source, /function Get-StandInImeRoot/u, '必须能从仓库根定位夹具');
  assert.match(source, /build-cxime\.ps1/u, '模块缺失时必须能就地编译');
});

test('就绪判据仍是客户端的 ImmGetDescriptionW，并区分失败原因', () => {
  const source = readFileSync(preparationScript, 'utf8');
  assert.match(source, /\[DllImport\("imm32\.dll", CharSet = CharSet\.Unicode\)\] public static extern int ImmGetDescriptionW/u,
    '必须调用客户端同一个 API');
  assert.match(source, /function Test-ImmInputMethodReady/u, '必须按非空描述判定就绪');
  assert.match(source, /already-ready/u, '已就绪时必须跳过安装');
  assert.match(source, /stand-in-fixture-missing/u, '夹具缺失必须显式记录');
  assert.match(source, /stand-in-build-failed/u, '编译失败必须显式记录');
  assert.match(source, /stand-in-installed-but-not-ready/u, '安装成功但描述为空必须能区分');
  assert.match(source, /stand-in-installed'/u, '成功路径必须可识别');
  assert.match(source, /cx-real-client-prep-summary\.json/u, '准备结果必须落盘供 artifact 使用');
  assert.match(source, /immPreparation = \$summary\.ImmPreparation/u, '摘要必须带 prepared 与 immPreparation');
});

test('准备脚本保持可被 CI 直接调用：纯 ASCII、无第三方安装开关、不 exit', () => {
  const bytes = readFileSync(preparationScript);
  assert.equal(bytes.some((byte) => byte > 0x7f), false, '必须保持纯 ASCII');
  const source = bytes.toString('utf8');
  assert.doesNotMatch(source, /\[switch\] \$SkipSogouInputMethod/u, '第三方输入法开关必须删除');
  assert.doesNotMatch(source, /\$SogouImeInstaller/u, '第三方安装包参数必须删除');
  assert.match(source, /\[switch\] \$SkipInputMethod/u, '必须保留整体跳过开关');
  assert.match(source, /if \(-not \$SkipInputMethod\) \{ \$null = Install-StandInInputMethod \}/u, '主流程必须调用伪装输入法准备');
  assert.doesNotMatch(source, /^\s*exit \d+/mu, '脚本不得 exit，否则会截断 CI 步骤');
});

test('无副作用运行时报告伪装输入法跳过而非安装', { skip: windowsOnly }, () => {
  const result = spawnSync('pwsh', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', preparationScript, '-DryRun', '-SkipResolution', '-SkipCamera'
  ], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry run, stand-in input method not installed/u, 'dry run 不得安装');
  assert.match(result.stdout, /input: imm 0x/u, '必须打印每个布局的 IMM 描述');
  assert.match(result.stdout, /prepared=False/u, '没有输入法时必须报告未就绪');
});
