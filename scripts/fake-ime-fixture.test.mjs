import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureDir = path.join(root, 'tests', 'fixtures', 'sogou-imm-vm');
const fakeImeDir = path.join(fixtureDir, 'fake-ime');

const IME_EXPORTS = [
  'ImeInquire',
  'ImeConfigure',
  'ImeDestroy',
  'ImeEscape',
  'ImeSelect',
  'ImeSetActiveContext',
  'ImeProcessKey',
  'ImeToAsciiEx',
  'NotifyIME',
  'ImeRegisterWord',
  'ImeUnregisterWord',
  'ImeEnumRegisterWord',
  'ImeSetCompositionString',
  'ImeConversionList',
  'ImeGetRegisterWordStyle',
  'ImeGetImeMenuItems'
];

async function read(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

async function readBytes(relativePath) {
  return readFile(path.join(root, relativePath));
}

test('占位输入法模块导出完整 IME32 接口', async () => {
  const def = await read('tools/fake-ime/cxime.def');
  const exported = def
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(';') && !/^LIBRARY/iu.test(line) && !/^EXPORTS$/u.test(line));
  assert.deepEqual(exported.sort(), [...IME_EXPORTS].sort(), '导出表必须与 IME32 接口一致，且不带 stdcall 修饰');

  const source = await read('tools/fake-ime/cxime.c');
  for (const name of IME_EXPORTS) {
    assert.match(source, new RegExp(`\\b${name}\\s*\\(`, 'u'), `cxime.c 必须实现 ${name}`);
  }
  assert.match(source, /info->fdwProperty = IME_PROP_UNICODE/u, 'ImeInquire 必须声明 Unicode IME 属性');
  assert.match(source, /lstrcpynW\(uiClass, kUiClass, 16\)/u, 'ImeInquire 必须写入 UI 窗口类名');
});

test('构建脚本只依赖 MSVC 且把中间产物放进 build 目录', async () => {
  const script = await read('tools/fake-ime/build-cxime.ps1');
  assert.match(script, /vcvarsall\.bat/u, '必须通过 vcvarsall 找到编译器');
  assert.match(script, /\/LD/u, '必须生成 DLL');
  assert.match(script, /\/DEF:"cxime\.def"/u, '必须使用导出定义文件');
  assert.match(script, /Build-One -Arch 'x86' -OutputName 'cxime32\.dll'/u, '必须构建 32 位模块（CXExam.exe 是 x86）');
  assert.match(script, /Build-One -Arch 'x64' -OutputName 'cxime64\.dll'/u, '必须构建 64 位模块');
  const bytes = await readBytes('tools/fake-ime/build-cxime.ps1');
  assert.equal(bytes.some((byte) => byte > 0x7f), false, 'build-cxime.ps1 必须保持纯 ASCII');
});

test('安装脚本按客户端判据注册布局并支持只读复核与回滚', async () => {
  const script = await read('tools/fake-ime/Install-FakeInputMethod.ps1');
  const bytes = await readBytes('tools/fake-ime/Install-FakeInputMethod.ps1');
  assert.equal(bytes.some((byte) => byte > 0x7f), false, 'Install-FakeInputMethod.ps1 必须保持纯 ASCII');

  assert.match(script, /\[string\] \$Klid = ''/u, 'KLID 默认按当前系统输入语言推导');
  assert.match(script, /SPI_GETDEFAULTINPUTLANG = 0x0059/u, '必须读取系统默认输入语言');
  assert.match(script, /\$Klid = 'E0F0' \+ \$suffix/u, 'KLID 必须由 E0F0 + 语言后缀组成');
  assert.match(script, /\$layoutsRoot = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Keyboard Layouts'/u, '必须写入客户端读取的布局注册表根');
  assert.match(script, /-Name 'Layout Text'/u, '必须写 Layout Text（ImmGetDescriptionW 的文本来源）');
  assert.match(script, /-Name 'IME file'/u, '必须写 IME file，否则 imm32 不会加载模块');
  assert.match(script, /Save-Backup/u, '安装前必须备份 Preload 与已有键值');
  assert.match(script, /Copy-Item -LiteralPath \$item\.Path -Destination \$item\.Target/u, '必须把模块复制进 System32/SysWOW64');
  assert.match(script, /\[CxImeProbe\]::LoadLayout\(\$Klid/u, '必须把布局加载进会话');
  assert.match(script, /RESULT=IME_READY/u, '就绪结果字符串必须稳定');

  // -Verify 是只读路径：分支必须在安装段落之前，且只调用探测函数。
  const verifyBranch = script.indexOf('if ($Verify) {');
  const installSection = script.indexOf('# ---- install ----');
  assert.ok(verifyBranch > 0 && installSection > verifyBranch, '-Verify 必须早于安装段落');
  assert.match(script, /\$code = Invoke-Verify\s+exit \$code/u, '-Verify 只能调用探测并返回退出码');

  const verifyBody = script.slice(script.indexOf('function Invoke-Verify'), script.indexOf('if ($Verify) {'));
  assert.doesNotMatch(verifyBody, /New-Item|Set-ItemProperty|Copy-Item|Remove-Item/u, '-Verify 不得写注册表或文件');
  assert.match(verifyBody, /if \(\$Load\)/u, '-Verify -Load 必须允许在探针进程内加载布局');

  const readyBody = script.slice(script.indexOf('function Test-ImeReady'), script.indexOf('function Show-Layouts'));
  assert.match(readyBody, /ToUpperInvariant\(\)\) -ne 'E'/u, '就绪判据必须要求 E0 标记');
  assert.match(readyBody, /Get-LanguageFromKlid/u, '就绪判据必须核对语言后缀');
});

test('仓库不携带任何预编译模块，CI 现场编译', async () => {
  const { access } = await import('node:fs/promises');
  for (const relative of [
    ['tests', 'fixtures', 'sogou-imm-vm', 'fake-ime', 'prebuilt', 'cxime32.dll'],
    ['tests', 'fixtures', 'sogou-imm-vm', 'fake-ime', 'prebuilt', 'cxime64.dll']
  ]) {
    await assert.rejects(access(path.join(root, ...relative)), '不允许提交本机编译的产物');
  }
  const install = await read('tools/fake-ime/Install-FakeInputMethod.ps1');
  assert.match(install, /Run build-cxime\.ps1 first/u, '缺少模块时必须要求先编译');
  const workflow = await read('.github/workflows/ci.yml');
  assert.match(workflow, /WARN: 编译失败，跳过伪装输入法安装与复核/u, 'CI 的编译失败必须降级为告警');
  assert.match(workflow, /vars\.FAKE_IME_RUNNER/u, 'job 必须允许指向带 zh-CN 的 runner');
  assert.match(workflow, /Install-zhCN-Language\.ps1/u, '必须复用厂商安装脚本');
  assert.match(workflow, /-NoReboot/u, '安装脚本必须带 -NoReboot，让 job 继续执行');
  assert.match(workflow, /AddSeconds\(1800\)/u, '语言包安装必须有 1800 秒上限');
  assert.match(workflow, /Stop-Job -Job \$job/u, '超时必须停止后台作业');
  assert.match(workflow, /\$build\.Build -ne 26100/u, '必须核对 Windows Server 2025 的 build 号');
  assert.match(workflow, /仍按要求尝试安装语言包/u, '版本不符时也要继续尝试安装，只告警');
  assert.doesNotMatch(workflow, /（build \$\(\$build\.Build\)），跳过语言包安装/u, '不得因版本不符直接跳过');
  assert.match(workflow, /Language\.Basic~~~zh-CN/u, '必须先检查东亚语言支持（legacy IMM 的前提）');
  assert.match(workflow, /CX_FAKE_IME_HOST/u, '没有东亚语言支持时必须跳过安装与复核');
  assert.doesNotMatch(workflow, /prebuilt/u, 'CI 不得回退到仓库内的预编译模块');
});

test('模块携带 VERSIONINFO，否则 LoadKeyboardLayout 返回 1813', async () => {
  const rc = await read('tools/fake-ime/cxime.rc');
  assert.match(rc, /VERSIONINFO/u, '必须有版本资源');
  assert.match(rc, /VALUE "FileDescription", "ExamInput IME stub"/u, 'FileDescription 必须稳定');
  assert.match(rc, /VALUE "ProductName", "ExamInput"/u, 'ProductName 必须稳定');
  const build = await read('tools/fake-ime/build-cxime.ps1');
  assert.match(build, /rc \/nologo \/fo /u, '构建脚本必须编译 .rc');
  assert.match(build, /"cxime\.c" "' \+ \$res \+ '"|"cxime\.c" "\$res"/u, '必须把 .res 链接进 DLL')
    ;
  const install = await read('tools/fake-ime/Install-FakeInputMethod.ps1');
  assert.match(install, /error 1813 = the IME module has no VERSIONINFO resource/u, '安装脚本必须解释 1813');
  assert.match(install, /LoadLayoutWithFlags\(\$Klid, 2/u, '失败后必须再试 KLF_SUBSTITUTE_OK');
});

test('仓库内置 zh-CN 语言包，CI 用它安装东亚语言支持', async () => {
  const zip = await readBytes('tools/fake-ime/langpack/WinSrv2025-zhCN-LanguagePack.zip');
  assert.ok(zip.length > 100 * 1024 * 1024, '语言包必须真的随仓库提供（>100MB）');
  assert.deepEqual([...zip.subarray(0, 2)], [0x50, 0x4b], '必须是 zip');
  const attributes = await read('.gitattributes');
  assert.match(attributes, /tools\/fake-ime\/langpack\/\*\.zip filter=lfs/u, '语言包必须走 Git LFS');
  const workflow = await read('.github/workflows/ci.yml');
  assert.match(workflow, /tools\/fake-ime\/langpack\/WinSrv2025-zhCN-LanguagePack\.zip/u, 'CI 必须使用仓库内置语言包');
  assert.match(workflow, /Expand-Archive -LiteralPath \$zip/u, '使用前必须解压');
  assert.match(workflow, /lfs: true/u, '检出必须拉取 Git LFS 对象，否则只有指针');
  assert.match(workflow, /语言包是 Git LFS 指针/u, '未拉取 LFS 时必须告警跳过而不是直接失败');
  assert.match(workflow, /Install-zhCN-Language\.ps1/u, '必须调用语言包自带的安装脚本');
  assert.match(workflow, /Set-Location \(Split-Path -Parent \$ScriptPath\)/u, '脚本必须在自己的目录里运行（ 定位 repo）');
});

test('提供 IME 加载 A/B 探针，区分模块与子系统问题', async () => {
  const probe = await readBytes('tools/fake-ime/Probe-ImeLoad.ps1');
  assert.ok(!probe.some((byte) => byte > 127), 'Probe-ImeLoad.ps1 必须保持纯 ASCII');
  const text = await read('tools/fake-ime/Probe-ImeLoad.ps1');
  assert.match(text, /msctfime\.ime/u, '必须用系统自带 IME 做对照');
  assert.match(text, /cxime\.ime/u, '必须同时测试占位模块');
  assert.match(text, /diagnosis: /u, '必须输出结论行');
  const workflow = await read('.github/workflows/ci.yml');
  assert.match(workflow, /Probe-ImeLoad\.ps1/u, 'CI 必须调用该探针');
});

test('CI 在管理员 Windows runner 上验证伪装输入法并回滚', async () => {
  const workflow = await read('.github/workflows/ci.yml');
  assert.match(workflow, /^  windows-fake-ime:$/mu, '必须有独立的伪装输入法 job');
  assert.match(workflow, /name: 确认管理员上下文/u, 'job 必须先确认管理员上下文');
  assert.match(workflow, /build-cxime\.ps1/u, 'job 必须编译模块');
  assert.match(workflow, /-DisplayName 'CiExamInput'/u, 'job 必须安装布局');
  assert.match(workflow, /SysWOW64\\WindowsPowerShell\\v1\.0\\powershell\.exe/u, 'job 必须用 32 位宿主复核');
  assert.match(workflow, /Install-FakeInputMethod\.ps1/u, 'job 必须调用安装脚本');
  assert.match(workflow, /-Verify -Load/u, '32 位复核必须在探针进程内加载布局');
  assert.match(workflow, /-Uninstall/u, 'job 必须回滚');
  assert.match(workflow, /WARN: 编译失败，跳过伪装输入法安装与复核/u, '编译失败只能告警，不能阻断后续步骤');
  assert.match(workflow, /CX_FAKE_IME_MODULE/u, '必须用环境标记把“没有模块”传给后续步骤');
  assert.match(workflow, /if: env\.CX_FAKE_IME_MODULE == '1'/u, '安装与复核必须按模块可用性跳过');
  assert.match(workflow, /-Verify 用 1 表示“未就绪”[\s\S]*?exit 0/u, '预期非零退出的步骤必须显式 exit 0');
  assert.match(workflow, /needs: \[source, windows-build, windows-unit, windows-pause, windows-window, windows-browser, windows-release, windows-real-client-discovery, windows-real-client, windows-fake-ime\]/u,
    '汇总 job 必须等待伪装输入法验证');
});
