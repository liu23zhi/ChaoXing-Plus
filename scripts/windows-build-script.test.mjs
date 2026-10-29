import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('.');

function findGitBash() {
  if (process.platform !== 'win32') return '';
  const located = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true });
  const candidates = (located.stdout || '').trim().split(/\r?\n/u).filter(Boolean).flatMap((git) => [
    path.resolve(path.dirname(git), '..', 'bin', 'bash.exe'),
    path.resolve(path.dirname(git), '..', 'usr', 'bin', 'bash.exe')
  ]);
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

test('build-windows.sh 使用 Git Bash 构建 x86 无依赖单文件发布包', async () => {
  const script = await readFile(path.join(root, 'windows/native-source/build-windows.sh'), 'utf8');
  assert.match(script, /^#!\/usr\/bin\/env bash\n/u);
  assert.doesNotMatch(script, /\r\n/u, 'shell 脚本必须使用 LF 换行');
  for (const expected of [
    'npm run build:windows -- --release',
    'windows/native-source/build.ps1',
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
  const script = await readFile(path.join(root, 'windows/node-source/build-windows-node.sh'), 'utf8');
  assert.match(script, /^#!\/usr\/bin\/env bash\n/u);
  assert.doesNotMatch(script, /\r\n/u, 'shell 脚本必须使用 LF 换行');
  for (const expected of [
    'npm run build:windows -- --release',
    'npm run release:windows -- --skip-native',
    'verify-release.mjs',
    'start-windows-node-silent.cmd'
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
test('build-windows.cmd / build-windows-node.cmd 是不依赖 Git Bash 的 CMD 入口', async () => {
  const cases = [
    ['build-windows.cmd', ['npm run build:windows -- --release', 'windows\\native-source\\build.ps1', 'npm run release:windows', 'verify-release.mjs', 'chaoxing_plus.exe']],
    ['build-windows-node.cmd', ['npm run build:windows -- --release', '--skip-native', 'start-windows-node.cmd', 'verify-release.mjs']]
  ];
  for (const [name, expected] of cases) {
    const sourceDirectory = name.includes('-node') ? 'node-source' : 'native-source';
    const bytes = await readFile(path.join(root, 'windows', sourceDirectory, name));
    assert.equal(bytes.includes(13), false, `${name} 必须使用 LF 换行`);
    assert.equal(bytes.filter((value) => value > 127).length, 0, `${name} 必须保持纯 ASCII`);
    const text = bytes.toString('utf8');
    for (const token of expected) assert.equal(text.includes(token), true, `${name} 缺少步骤：${token}`);
    assert.doesNotMatch(text, /bash build-windows/u, `${name} 不得依赖 Git Bash`);
    assert.match(text, /--skip-tests/u, `${name} 必须支持 --skip-tests`);
  }
});

test('迁移后的两个 CMD 构建入口从项目外执行 --help 只显示帮助', { skip: process.platform !== 'win32' }, () => {
  for (const [directory, name] of [
    ['native-source', 'build-windows.cmd'],
    ['node-source', 'build-windows-node.cmd']
  ]) {
    const launcher = path.join(root, 'windows', directory, name);
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${launcher}" --help`], {
      encoding: 'utf8', timeout: 15000, windowsHide: true, windowsVerbatimArguments: true,
      cwd: tmpdir(),
      // 帮助无需工具链；解析回归也不能意外触发真正的构建。
      env: { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') }
    });
    assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
    const lines = result.stdout.trim().split(/\r?\n/u);
    assert.equal(lines.length, 2, `${name} 只能输出用法和描述`);
    assert.equal(lines[0], `Usage: ${name} [--skip-tests]`);
    assert.match(lines[1], /^\s*Builds /u);
    assert.doesNotMatch(result.stdout, /\bbuilding\b|npm run|vite/iu);
    assert.equal(result.stderr, '');
  }
});

test('原生 Bash 构建入口从源码目录按 basename 执行 --help', (t) => {
  const bash = findGitBash();
  if (!bash) { t.skip('Git Bash 不可用'); return; }
  const result = spawnSync(bash, ['build-windows.sh', '--help'], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    cwd: path.join(root, 'windows', 'native-source')
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /^#!\/usr\/bin\/env bash\r?\n/u);
  assert.match(result.stdout, /bash windows\/native-source\/build-windows\.sh --skip-tests/u);
  assert.doesNotMatch(result.stdout, /\[build-windows\].*(?:构建|building)/iu);
  assert.equal(result.stderr, '');
});

test('缺失宿主的发布入口不会回退调用仓库开发文件', { skip: process.platform !== 'win32' }, async (t) => {
  const releaseDirectory = path.join(root, 'release');
  await mkdir(releaseDirectory, { recursive: true });
  const directory = await mkdtemp(path.join(releaseDirectory, 'launcher-missing-host-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const [sourceDirectory, name] of [
    ['node-source', 'start-windows-node-debug.cmd'],
    ['native-source', 'start-windows-debug.cmd']
  ]) {
    const launcher = path.join(directory, name);
    await copyFile(path.join(root, 'windows', sourceDirectory, name), launcher);
    // --help 即使在旧回退行为重新出现时也只做只读检查，绝不启动客户端。
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${launcher}" --help`], {
      encoding: 'utf8', timeout: 15000, windowsHide: true, windowsVerbatimArguments: true,
      cwd: tmpdir(), env: { ...process.env, CXPLUS_NO_LOG_FILE: '1' }
    });
    assert.equal(result.status, 9009, `${name}: ${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /--capabilities/u, '缺失包文件时不得输出开发宿主的帮助');
    assert.deepEqual((await readdir(directory)).filter((entry) => entry !== 'start-windows-node-debug.cmd' && entry !== 'start-windows-debug.cmd'), []);
  }
});

test('扩展构建脚本已改名为 build-browser.sh，Windows 入口保持独立', async () => {
  const browser = await readFile(path.join(root, 'build-browser.sh'), 'utf8');
  assert.match(browser, /^#!\/usr\/bin\/env bash\n/u);
  assert.match(browser, /npm run build/u);
  assert.match(browser, /dist/u);
  const entries = await readdir(root);
  assert.equal(entries.includes('build.sh'), false, 'build.sh 应改名为 build-browser.sh');
  assert.equal(entries.includes('build-browser.sh'), true);
  for (const name of [
    'windows/native-source/build-windows.cmd',
    'windows/node-source/build-windows-node.cmd',
    'windows/share-file/README.md'
  ]) {
    assert.equal((await readFile(path.join(root, name))).length > 0, true, `缺少 ${name}`);
  }
});

test('Windows 专用文件归入三目录，插件构建继续使用原位共享源码与 dist', async () => {
  const entries = await readdir(root);
  assert.equal(entries.some((name) => /^(?:build|start)-windows.*\.(?:cmd|sh)$/u.test(name)), false,
    'Windows 专用启动和构建脚本必须迁入 windows');
  assert.equal(entries.includes('build.windows.mjs'), false);
  const windowsEntries = await readdir(path.join(root, 'windows'));
  assert.equal(windowsEntries.includes('host'), false);
  assert.equal(windowsEntries.includes('native'), false);
  for (const directory of ['node-source', 'native-source', 'share-file']) {
    assert.equal(windowsEntries.includes(directory), true, `缺少 ${directory}`);
  }
  const browserBuild = await readFile(path.join(root, 'build.mjs'), 'utf8');
  assert.match(browserBuild, /src\/index\.ts/u);
  assert.match(browserBuild, /outDir:\s*['"]dist['"]/u);
  assert.doesNotMatch(browserBuild, /windows\/(?:node-source|native-source|share-file)/u);
  assert.equal((await readFile(path.join(root, 'src/index.ts'))).length > 0, true);
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.build, 'node build.mjs');
});
