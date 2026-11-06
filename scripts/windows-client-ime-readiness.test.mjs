import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

const preparationScript = resolveTestPath('scripts', 'ci', 'prepare-windows-real-client-environment.ps1');
const windowsOnly = process.platform === 'win32' ? undefined : '仅在 Windows 上运行环境准备脚本';

test('输入法伪装冻结后，桌面准备不再安装任何输入法', () => {
  const source = readFileSync(preparationScript, 'utf8');
  assert.doesNotMatch(source, /winget|ime\.gtimg\.com|sogou-ime-v|Install-SogouInputMethod|Get-SogouInputState|Resolve-SogouInputInstaller/iu,
    'CI 不得下载或安装第三方输入法');
  assert.doesNotMatch(source, /Add-WindowsCapability|Set-WinUserLanguageList|InputMethodTips|Install-Language/u,
    '不再安装语言包或注册系统输入法');
  assert.doesNotMatch(source, /function Install-StandInInputMethod|Install-FakeInputMethod\.ps1|build-cxime|tools\/fake-ime/u,
    '伪装输入法安装包已删除，不得再调用');
  assert.match(source, /function Get-FrozenInputMethodState/u, '必须保留冻结状态函数');
  assert.match(source, /stand-in-frozen/u, '状态必须明确为 stand-in-frozen');
});

test('就绪判据仍是客户端的 ImmGetDescriptionW，仅用于只读报告', () => {
  const source = readFileSync(preparationScript, 'utf8');
  assert.match(source, /\[DllImport\("imm32\.dll", CharSet = CharSet\.Unicode\)\] public static extern int ImmGetDescriptionW/u,
    '必须调用客户端同一个 API');
  assert.match(source, /function Test-ImmInputMethodReady/u, '必须按非空描述判定就绪');
  assert.match(source, /cx-real-client-prep-summary\.json/u, '准备结果必须落盘供 artifact 使用');
  assert.match(source, /immPreparation = \$summary\.ImmPreparation/u, '摘要必须带 prepared 与 immPreparation');
  assert.match(source, /stand-in-frozen/u, '摘要里的原因必须是冻结状态');
});

test('准备脚本保持可被 CI 直接调用：纯 ASCII、无输入法安装开关、不 exit', () => {
  const bytes = readFileSync(preparationScript);
  assert.equal(bytes.some((byte) => byte > 0x7f), false, '必须保持纯 ASCII');
  const source = bytes.toString('utf8');
  assert.doesNotMatch(source, /\[switch\] \$SkipSogouInputMethod/u, '第三方输入法开关必须删除');
  assert.doesNotMatch(source, /\$SogouImeInstaller/u, '第三方安装包参数必须删除');
  assert.match(source, /\[switch\] \$SkipInputMethod/u, '必须保留整体跳过开关');
  assert.match(source, /if \(-not \$SkipInputMethod\) \{ \$null = Get-FrozenInputMethodState \}/u, '主流程必须走冻结状态');
  assert.doesNotMatch(source, /^\s*exit \d+/mu, '脚本不得 exit，否则会截断 CI 步骤');
});

test('无副作用运行时报告输入法已冻结', { skip: windowsOnly }, () => {
  const result = spawnSync('pwsh', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', preparationScript, '-DryRun', '-SkipResolution', '-SkipCamera'
  ], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stand-in input method is frozen/u, '必须报告冻结，而不是安装');
  assert.match(result.stdout, /prepared=False/u, '没有输入法时必须报告未就绪');
});
