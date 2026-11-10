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
  assert.doesNotMatch(workflow, /Install-FakeInputMethod|build-cxime|Probe-ImeLoad|Language\.Basic~~~zh-CN|Add-WindowsCapability/u,
    '不得执行封存工具或安装语言包');
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
