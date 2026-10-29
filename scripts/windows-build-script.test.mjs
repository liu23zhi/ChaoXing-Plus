import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');

test('build-windows.sh 使用 Git Bash 构建 x86 无依赖单文件发布包', async () => {
  const script = await readFile(path.join(root, 'build-windows.sh'), 'utf8');
  assert.match(script, /^#!\/usr\/bin\/env bash\n/u);
  assert.doesNotMatch(script, /\r\n/u, 'shell 脚本必须使用 LF 换行');
  for (const expected of [
    'npm run build:windows -- --release',
    'windows/native/build.ps1',
    'npm run release:windows',
    'verify-release.mjs',
    'chaoxing_plus.exe'
  ]) {
    assert.equal(script.includes(expected), true, `缺少构建步骤：${expected}`);
  }
  // 明确记录当前发布决策：x86 单文件 + CDP 注入，不内置 x64 可执行注入器。
  assert.match(script, /x86 无 CRT/u);
  assert.match(script, /CDP 页面注入/u);
  assert.match(script, /不从 x86 进程内存执行 x64 PE/u);
});

test('Windows 打包决策已记录到 AGENTS 与 docs', async () => {
  const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Windows 打包决策（2026-12-06）/u);
  assert.match(agents, /单份 x86、无 CRT、无第三方\/外部 DLL 依赖/u);
  assert.match(agents, /x86 宿主可正常启动并注入 x64 CXExam/u);
  assert.match(agents, /不从 x86 进程内存执行 x64 PE/u);

  const docs = await readFile(path.join(root, 'docs', 'windows.md'), 'utf8');
  assert.match(docs, /Windows 打包决策/u);
  assert.match(docs, /build-windows\.sh/u);
  assert.match(docs, /CDP 页面注入/u);
});

test('build-windows-node.sh 只构建备用 Node 包，并声明 Node 已弃用', async () => {
  const script = await readFile(path.join(root, 'build-windows-node.sh'), 'utf8');
  assert.match(script, /^#!\/usr\/bin\/env bash\n/u);
  assert.doesNotMatch(script, /\r\n/u, 'shell 脚本必须使用 LF 换行');
  for (const expected of [
    'npm run build:windows -- --release',
    'npm run release:windows -- --skip-native',
    'verify-release.mjs',
    'start-windows-silent.cmd'
  ]) {
    assert.equal(script.includes(expected), true, `备用构建缺少：${expected}`);
  }
  // 备用入口不得再构建原生 EXE。
  assert.equal(script.includes('native/build.ps1'), false, '备用脚本不得调用原生构建');
  assert.match(script, /已弃用/u);
});

test('Node 宿主弃用只保留文件，已记录到 AGENTS/docs/README', async () => {
  const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Node 宿主已弃用/u);
  assert.match(agents, /仅保留文件/u);
  assert.match(agents, /不再开发新能力/u);
  const docs = await readFile(path.join(root, 'docs', 'windows.md'), 'utf8');
  assert.match(docs, /Node 宿主已弃用/u);
  assert.match(docs, /build-windows-node\.sh/u);
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /build-windows-node\.sh/u);
});
