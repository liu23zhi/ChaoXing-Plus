import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

async function exists(relative) {
  try {
    await stat(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

async function read(relative) {
  return readFile(path.join(root, relative), 'utf8');
}

test('输入法伪装已冻结：工具封存归档，不再执行', async () => {
  assert.equal(await exists('tools/fake-ime/SEALED.md'), true, '工具必须封存并留下 SEALED.md');
  const sealed = await read('tools/fake-ime/SEALED.md');
  assert.match(sealed, /归档/u, 'SEALED.md 必须写明归档用途');
  // 原断言「SEALED.md 必须指向 ime-spoofing-freeze.md」验证的是一个仓库内并不存在的路径
  //（冻结记录实际在私有 TikuDoc 的 docs/ime-spoofing-freeze.md，本仓库无 docs/ 目录）。
  // 2026-11-10 改断言 SEALED.md 自身必须禁止调用封存工具，保住原本守护的语义。
  assert.match(sealed, /不得再调用|不得调用/u, 'SEALED.md 必须禁止调用封存工具');

  const readme = await read('tools/fake-ime/README.md');
  assert.match(readme, /已封存/u, 'README 顶部必须有封存说明');

  for (const file of ['cxime.c', 'cxime.def', 'cxime.rc', 'build-cxime.ps1', 'Install-FakeInputMethod.ps1']) {
    assert.equal(await exists(path.join('tools/fake-ime', file)), true, `归档源码必须保留: ${file}`);
  }
});

test('语言包已删除，仓库不再追踪 LFS 规则', async () => {
  assert.equal(await exists('tools/fake-ime/langpack'), false, '语言包目录必须已删除');
  const attributes = await read('.gitattributes');
  assert.doesNotMatch(attributes, /fake-ime|langpack/u, '不得残留语言包的 LFS 规则');
});

test('CI 不执行封存工具，也不安装输入法', async () => {
  const workflow = await read('.github/workflows/ci.yml');
  assert.doesNotMatch(workflow, /windows-fake-ime/u, '不得残留伪装输入法 job');
  assert.doesNotMatch(workflow, /cx-fake-ime-modules|CX_FAKE_IME_/u, '不得残留产物名与开关');
  assert.doesNotMatch(workflow, /Install-FakeInputMethod|build-cxime|Probe-ImeLoad|Language\.Basic/u,
    '不得执行封存工具或安装语言包');
  assert.doesNotMatch(workflow, /Add-WindowsCapability[^\n]*Language\./u,
    'Add-WindowsCapability 不得用于安装语言包');

  // 2026-11-12：`Add-WindowsCapability` 从「绝对禁用」放宽为「只许装 OpenSSH.Server」。
  //
  // 原断言把它整条拉黑，是因为当时它在 CI 里唯一出现的形式就是
  //   Add-WindowsCapability -Online -Name 'Language.Basic~~~zh-CN~0.0.1.0'
  // 即「装中文语言包」——那正是要冻结的行为。
  //
  // 本仓库随后把 Windows 客机镜像构建并入 ci.yml，同一条命令被用于
  //   Add-WindowsCapability -Online -Name 'OpenSSH.Server*'
  // 给客机装 SSH 服务端（dockur 镜像里没有预装，是两阶段自毁验证唯一的命令通道）。
  // 它与输入法无关，属合法用途；若继续整条拉黑，等于用「防输入法」的守卫
  // 挡住「装 SSH」，守卫会名不副实。
  //
  // 放宽的同时把守卫改精确：凡是 Get/Add-WindowsCapability 里出现的
  // capability 名字面量，只允许 OpenSSH.Server 系列。出现任何其他 capability
  // （尤其 Language.*）都判红。
  //
  // 注意 `-Name $cap.Name` 是变量间接引用（名字来自上面的 Get-WindowsCapability），
  // 所以不能只做「每行必须含 OpenSSH.Server」这种字面断言 —— 那会误判。
  // 做法：把两处名字都抓出来校验。
  const capabilityNames = [...workflow.matchAll(/-Name\s+(?:'([^']+)'|"([^"]+)")/gu)]
    .map((m) => m[1] ?? m[2])
    .filter((name) => /^(?:OpenSSH|Language|Windows|Microsoft|Server)/u.test(name));
  assert.ok(capabilityNames.length > 0, 'ci.yml 里应当至少有一处 capability 名字面量（OpenSSH.Server）');
  for (const name of capabilityNames) {
    assert.match(name, /^OpenSSH\.Server/u, `capability 只许用 OpenSSH.Server，实际：${name}`);
  }
});

test('桌面准备只保留只读探针，状态固定为冻结', async () => {
  const prep = await read('scripts/ci/prepare-windows-real-client-environment.ps1');
  assert.match(prep, /function Get-FrozenInputMethodState/u, '必须有冻结状态函数');
  assert.match(prep, /stand-in-frozen/u, '状态必须是 stand-in-frozen');
  assert.match(prep, /function Get-ImmInputMethodProbe/u, '只读探针必须保留');
  assert.match(prep, /ImmGetDescriptionW/u, '探针必须使用客户端同一个 API');
  assert.doesNotMatch(prep, /Install-FakeInputMethod|build-cxime|Set-WinUserLanguageList|Add-WindowsCapability/u,
    '准备脚本不得安装或注册输入法');
  assert.doesNotMatch(prep, /tools\/fake-ime/u, '不得调用封存目录');
});
