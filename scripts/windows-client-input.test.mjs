import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
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

test('只登记微软自带拼音与五笔，且安装步骤都有超时上限', () => {
  const source = readFileSync(preparationScript, 'utf8');
  assert.match(source, /\{81D4E9C9-1D3B-41BC-9E6C-4B40BF79E35E\}/u, '必须登记微软拼音输入法');
  assert.match(source, /\{E7EA138E-69F8-11D7-A6EA-00065B844310\}/u, '必须登记微软五笔输入法');
  assert.doesNotMatch(source, /Install-Language/u, 'Install-Language 在 runner 上会长时间挂起，不得再使用');
  assert.doesNotMatch(source, /sogou|qqpinyin|baidu|搜狗|QQ拼音|百度/iu, '不得安装第三方输入法');
  assert.match(source, /Invoke-Bounded/u, '安装动作必须带超时');
  assert.match(source, /-TimeoutSeconds \$CapabilityTimeoutSeconds/u, '语言能力安装必须有超时上限');
  assert.match(source, /Add-WindowsCapability -Online -Name 'Language\.Basic~~~zh-CN~0\.0\.1\.0'/u,
    '语言文件应通过 Add-WindowsCapability 安装');
});

test('微信输入法优先使用仓库内兜底安装包，且不会重复启动安装器', () => {
  const source = readFileSync(preparationScript, 'utf8');
  assert.match(source, /\[string\] \$WeChatImeInstaller/u, '必须允许显式指定安装包路径');
  assert.match(source, /\[switch\] \$SkipWeChatInputMethod/u, '必须能单独跳过微信输入法');
  assert.match(source, /function Get-FixtureRoot/u, '安装包定位不得依赖 $PSScriptRoot（被复用时为空）');
  assert.match(source, /wechat-ime-v\*\.exe/u, '必须按文件名约定查找仓库内安装包');
  const installBody = source.slice(source.indexOf('function Install-WeChatInputMethod'));
  assert.ok(installBody.indexOf('using bundled installer') < installBody.indexOf('winget install Tencent.WeType'),
    '仓库内安装包必须优先于 winget');
  assert.ok(installBody.indexOf('winget install Tencent.WeType') < installBody.indexOf('Resolve-WeChatInputMethodInstaller'),
    'winget 失败后才解析最新下载地址');
  assert.match(source, /\$state\.Installed = \(\(\[int\]\$values\.Enable -eq 1\) -and \$state\.FilesFound\)/u,
    '只有注册表启用且有二进制才算已安装：否则安装器会弹出卸载窗口');
  assert.match(source, /Remove-WeChatInputMethodLeftovers/u, '安装前必须清理半卸载残留');
  assert.match(source, /Tencent/u, '执行前必须校验签名主体');
  assert.match(source, /signature status \$\(\$signature\.Status\)/u, '执行前必须校验签名状态');
});

test('仓库内兜底安装包与清单一致', () => {
  const fixtureDir = resolveTestPath('tests', 'private-clients');
  const manifest = JSON.parse(readFileSync(resolveTestPath('tests', 'private-clients', 'wechat-ime.json'), 'utf8'));
  assert.match(manifest.sha256, /^[0-9A-F]{64}$/u, '清单必须记录大写 SHA256');
  assert.equal(manifest.silentSwitch, '/s', '必须记录静默安装开关');
  assert.equal(manifest.file, `wechat-ime-v${manifest.version}.exe`, '文件名必须与版本一致');
  const installer = resolveTestPath('tests', 'private-clients', manifest.file);
  assert.ok(existsSync(installer), '兜底安装包必须随仓库提供');
  assert.equal(statSync(installer).size, manifest.size, '兜底安装包体积必须与清单一致');
  const attributes = readFileSync(resolveTestPath('.gitattributes'), 'utf8');
  assert.match(attributes, /tests\/private-clients\/\*\.exe filter=lfs/u, '兜底安装包必须走 Git LFS');
});