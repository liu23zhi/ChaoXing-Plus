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
  const def = await read('tests/fixtures/sogou-imm-vm/fake-ime/cxime.def');
  const exported = def
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(';') && !/^LIBRARY/iu.test(line) && !/^EXPORTS$/u.test(line));
  assert.deepEqual(exported.sort(), [...IME_EXPORTS].sort(), '导出表必须与 IME32 接口一致，且不带 stdcall 修饰');

  const source = await read('tests/fixtures/sogou-imm-vm/fake-ime/cxime.c');
  for (const name of IME_EXPORTS) {
    assert.match(source, new RegExp(`\\b${name}\\s*\\(`, 'u'), `cxime.c 必须实现 ${name}`);
  }
  assert.match(source, /info->fdwProperty = IME_PROP_UNICODE/u, 'ImeInquire 必须声明 Unicode IME 属性');
  assert.match(source, /lstrcpynW\(uiClass, kUiClass, 16\)/u, 'ImeInquire 必须写入 UI 窗口类名');
});

test('构建脚本只依赖 MSVC 且把中间产物放进 build 目录', async () => {
  const script = await read('tests/fixtures/sogou-imm-vm/fake-ime/build-cxime.ps1');
  assert.match(script, /vcvarsall\.bat/u, '必须通过 vcvarsall 找到编译器');
  assert.match(script, /\/LD/u, '必须生成 DLL');
  assert.match(script, /\/DEF:"cxime\.def"/u, '必须使用导出定义文件');
  assert.match(script, /Build-One -Arch 'x86' -OutputName 'cxime32\.dll'/u, '必须构建 32 位模块（CXExam.exe 是 x86）');
  assert.match(script, /Build-One -Arch 'x64' -OutputName 'cxime64\.dll'/u, '必须构建 64 位模块');
  const bytes = await readBytes('tests/fixtures/sogou-imm-vm/fake-ime/build-cxime.ps1');
  assert.equal(bytes.some((byte) => byte > 0x7f), false, 'build-cxime.ps1 必须保持纯 ASCII');
});

test('安装脚本按客户端判据注册布局并支持只读复核与回滚', async () => {
  const script = await read('tests/fixtures/sogou-imm-vm/fake-ime/Install-FakeInputMethod.ps1');
  const bytes = await readBytes('tests/fixtures/sogou-imm-vm/fake-ime/Install-FakeInputMethod.ps1');
  assert.equal(bytes.some((byte) => byte > 0x7f), false, 'Install-FakeInputMethod.ps1 必须保持纯 ASCII');

  assert.match(script, /\[string\] \$Klid = 'E0F00804'/u, '默认 KLID 必须是 E0 前缀 + 0804 语言');
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
  const install = await read('tests/fixtures/sogou-imm-vm/fake-ime/Install-FakeInputMethod.ps1');
  assert.match(install, /Run build-cxime\.ps1 first/u, '缺少模块时必须要求先编译');
  const workflow = await read('.github/workflows/ci.yml');
  assert.match(workflow, /只使用 CI 现场编译的模块/u, 'CI 只使用现场编译产物');
  assert.doesNotMatch(workflow, /prebuilt/u, 'CI 不得回退到仓库内的预编译模块');
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
  assert.match(workflow, /needs: \[source, windows-build, windows-unit, windows-pause, windows-window, windows-browser, windows-release, windows-real-client-discovery, windows-real-client, windows-fake-ime\]/u,
    '汇总 job 必须等待伪装输入法验证');
});
