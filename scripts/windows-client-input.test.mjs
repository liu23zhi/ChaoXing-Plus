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
  assert.doesNotMatch(source, /qqpinyin|baidu|QQ拼音|百度/iu, '除搜狗外不得安装其它第三方输入法');
  assert.match(source, /Invoke-Bounded/u, '安装动作必须带超时');
  assert.match(source, /-TimeoutSeconds \$CapabilityTimeoutSeconds/u, '语言能力安装必须有超时上限');
  assert.match(source, /Add-WindowsCapability -Online -Name 'Language\.Basic~~~zh-CN~0\.0\.1\.0'/u,
    '语言文件应通过 Add-WindowsCapability 安装');
});

test('安装搜狗拼音：winget 与官方下载两条线上兜底都在', () => {
  const source = readFileSync(preparationScript, 'utf8');
  assert.match(source, /\[switch\] \$SkipSogouInputMethod/u, '必须能单独跳过搜狗输入法');
  assert.doesNotMatch(source, /WeChat|WeType|wechat/u, '微信输入法安装代码与备份必须彻底移除');
  assert.doesNotMatch(source, /wechat-ime/u, '不得再引用微信输入法安装包');
  const installBody = source.slice(source.indexOf('function Install-SogouInputMethod'));
  assert.match(installBody, /winget\.exe install --id Sogou\.SogouInput/u, '首选 winget 安装');
  assert.match(installBody, /Resolve-SogouInputInstaller/u, 'winget 失败后要有官方安装包兜底');
  assert.match(installBody, /ArgumentList \$using:installer\.Silent/u, '静默参数必须来自解析结果');
  assert.match(source, /function Resolve-SogouInputInstaller/u, '必须能解析当前版本（不写死）');
  assert.match(source, /_sogou_pinyin_\$\(\$version\)_0\.exe/u, '下载地址按固定模板拼装');
  assert.match(source, /manifests\/s\/Sogou\/SogouInput/u, '版本回退到 winget-pkgs 清单');
  assert.match(source, /InstallerSha256/u, '清单提供 SHA256 时必须校验');
  assert.match(source, /Silent = '\/S'/u, 'nullsoft 安装包用 /S 静默');
  assert.match(source, /function Get-SogouInputState/u, '必须能判定是否已安装，避免重复安装');
  const verifier = readFileSync(resolveTestPath('scripts', 'ci', 'verify-sogou-resolver.ps1'), 'utf8');
  assert.match(verifier, /\[switch\] \$NoWinget/u, '验证脚本必须能模拟 winget 缺失');
  assert.match(verifier, /Get-SogouInputState/u, '验证脚本必须复用安装状态判定');
  for (const byte of readFileSync(resolveTestPath('scripts', 'ci', 'verify-sogou-resolver.ps1'))) {
    assert.equal(byte <= 0x7f, true, 'verify-sogou-resolver.ps1 必须保持纯 ASCII');
  }
  assert.match(source, /input: dry run, Sogou Pinyin not installed/u, 'dry run 不得真的安装');
});
test('仓库内搜狗安装包与清单一致，且优先使用', () => {
  const fixtureDir = resolveTestPath('tests', 'private-clients');
  const manifest = JSON.parse(readFileSync(resolveTestPath('tests', 'private-clients', 'sogou-ime.json'), 'utf8'));
  assert.match(manifest.sha256, /^[0-9A-F]{64}$/u, '清单必须记录大写 SHA256');
  assert.equal(manifest.silentSwitch, '/S', '必须记录 nullsoft 静默开关');
  assert.equal(manifest.file, `sogou-ime-v${manifest.version}.exe`, '文件名必须与版本一致');
  const installer = resolveTestPath('tests', 'private-clients', manifest.file);
  assert.ok(existsSync(installer), '搜狗兜底安装包必须随仓库提供');
  const head = readFileSync(installer).subarray(0, 200).toString('utf8');
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1/u.test(head)) {
    const oid = /oid sha256:([0-9a-f]{64})/u.exec(head);
    const size = /size (\d+)/u.exec(head);
    assert.equal(oid[1].toUpperCase(), manifest.sha256, 'LFS 指针 oid 必须与清单一致');
    assert.equal(Number(size[1]), manifest.size, 'LFS 指针 size 必须与清单一致');
  } else {
    assert.equal(statSync(installer).size, manifest.size, '安装包体积必须与清单一致');
  }
  const source = readFileSync(preparationScript, 'utf8');
  const installBody = source.slice(source.indexOf('function Install-SogouInputMethod'));
  assert.ok(installBody.indexOf('using bundled Sogou installer') < installBody.indexOf('winget install Sogou.SogouInput'),
    '仓库内安装包必须优先于 winget');
  assert.ok(installBody.indexOf('winget install Sogou.SogouInput') < installBody.indexOf('Resolve-SogouInputInstaller'),
    'winget 失败后才解析最新下载地址');
  assert.match(source, /function Get-BundledSogouInstaller/u, '必须能定位仓库内搜狗安装包');
  assert.match(source, /sogou-ime-v\*\.exe/u, '按文件名约定查找');
  assert.match(source, /function Test-SogouInstallerFile/u, '执行前必须校验签名与哈希');
  assert.match(source, /unexpected signer/u, '签名主体不含 Sogou 时必须拒绝');
  // 安装器可能用中文 DisplayName 注册，只看名字会重复安装：三条独立信号都要在。
  assert.match(source, /Source = 'uninstall-entry'/u, '必须识别卸载表项');
  assert.match(source, /Control\\Keyboard Layouts/u, '必须识别 IMM 键盘布局注册');
  assert.match(source, /Source = 'install-dir'/u, '必须识别安装目录');
  assert.match(source, /UninstallString/u, '卸载命令含 sogou 也应识别');
  assert.match(source, /function Get-ImmInputMethodProbe/u, '必须记录客户端判定输入法所用的 ImmGetDescriptionW');
  assert.match(source, /cx-real-client-prep-summary\.json/u, '准备阶段必须写出可下载的摘要');
  assert.match(source, /input: imm \$line/u, '必须逐条打印每个布局的 IMM 描述');
  assert.equal(typeof manifest.silentSwitchVerified, 'string', '清单必须记录 /S 的实测结论');
  assert.match(manifest.silentSwitchVerified, /虚拟机/u, '必须注明是虚拟机实测');
});
