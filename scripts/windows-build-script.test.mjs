// 打包决策类断言只针对仓库内实际存在的文件；
// 打包行为由 windows/native-source/build-windows.sh 的首个用例与
// windows-release-package.test.mjs 的实际产物断言覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('.');

function decodeWindowsScript(bytes, relative) {
  if (relative === 'windows/native-source/build-windows.ps1') {
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '含中文的 PowerShell 5.1 构建脚本必须使用 UTF-8 BOM');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  if (relative === 'windows/native-source/build-windows.cmd') {
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CMD 入口不得包含 UTF-8 BOM');
    const text = new TextDecoder('gbk', { fatal: true }).decode(bytes);
    assert.match(text, /Windows 原生构建入口/u);
    assert.doesNotMatch(text, /\uFFFD/u);
    assert.match(text, /\r\n/u, '含中文的 CMD 入口必须使用 CRLF');
    assert.doesNotMatch(text, /(?<!\r)\n/u, '含中文的 CMD 入口不能包含裸 LF，否则 cmd.exe 会错误拆分中文行');
    return text;
  }
  assert.equal(bytes.filter(value => value > 127).length, 0, `${relative} 必须保持纯 ASCII`);
  return bytes.toString('utf8');
}

function findGitBash() {
  if (process.platform !== 'win32') return '';
  const located = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true });
  const candidates = (located.stdout || '').trim().split(/\r?\n/u).filter(Boolean).flatMap((git) => [
    path.resolve(path.dirname(git), '..', 'bin', 'bash.exe'),
    path.resolve(path.dirname(git), '..', 'usr', 'bin', 'bash.exe')
  ]);
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

test('build-windows.sh 使用 Git Bash 构建 GUI 双变体及 Console 辅助入口', async () => {
  const script = await readFile(path.join(root, 'windows/native-source/build-windows.sh'), 'utf8');
  assert.match(script, /^#!\/usr\/bin\/env bash\n/u);
  assert.doesNotMatch(script, /\r\n/u, 'shell 脚本必须使用 LF 换行');
  for (const expected of [
    'npm run build:windows -- --release',
    'windows/native-source/build-windows.ps1',
    'windows/native-build',
    'npm run release:windows',
    'verify-release.mjs',
    'chaoxing_plus.exe',
    'chaoxing_plus.com',
    'multi-file/package-to-single/chaoxing_plus.exe',
    '-BuildConsole'
  ]) {
    assert.equal(script.includes(expected), true, `缺少构建步骤：${expected}`);
  }
  // 明确记录当前发布决策：x86 单文件 + CDP 注入，不内置 x64 可执行注入器。
  assert.match(script, /x86 无 CRT/u);
  assert.match(script, /CDP 页面注入/u);
  assert.match(script, /不从 x86 进程内存执行 x64 PE/u);
});

test('原生 PowerShell、CMD、Bash 与 npm 构建入口统一使用 build-windows.ps1', async () => {
  const nativeSource = path.join(root, 'windows', 'native-source');
  const psPath = path.join(nativeSource, 'build-windows.ps1');
  assert.equal(existsSync(psPath), true, '原生 PowerShell 构建入口必须使用统一文件名');
  assert.equal(existsSync(path.join(nativeSource, 'build.ps1')), false, '旧构建脚本名不得保留');

  const ps = await readFile(psPath, 'utf8');
  const cmd = await readFile(path.join(nativeSource, 'build-windows.cmd'), 'utf8');
  const bash = await readFile(path.join(nativeSource, 'build-windows.sh'), 'utf8');
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  for (const [name, source] of [['CMD', cmd], ['Bash', bash]]) {
    assert.match(source, /native-source[\\/]build-windows\.ps1/u, `${name} 必须调用统一的 PowerShell 构建脚本`);
    assert.match(source, /BuildConsole/u, `${name} 必须构建多文件 GUI 和 Console 辅助入口`);
    assert.match(source, /PACKAGE_DIR[="]+windows[\\/]native-build[\\/]release/u, `${name} 必须校验原生发布目录`);
    assert.doesNotMatch(source, /PACKAGE_DIR[="]+release[\\/]/u, `${name} 不得重新向仓库根 release 输出`);
  }
  assert.match(ps, /\[switch\]\$BuildConsole/u);
  assert.match(ps, /Join-Path \$release 'single-file'/u);
  assert.match(ps, /Join-Path \$release 'multi-file'/u);
  assert.match(ps, /singleFileExe/u);
  assert.match(ps, /multiHostExe/u);
  assert.match(ps, /\/ENTRY:ConsoleLauncherMain \/SUBSYSTEM:CONSOLE/u);
  assert.match(ps, /package-multi-payload\.mjs/u);
  assert.match(packageJson.scripts['build:native'], /windows\/native-source\/build-windows\.ps1/u);

  const launchers = await Promise.all(['start-windows.cmd', 'start-windows-debug.cmd', 'start-windows-silent.cmd', 'start-windows-silent-debug.cmd', 'start-windows-silent-no-full-scan-debug.cmd']
    .map((name) => readFile(path.join(root, 'windows', 'native-scripts', name), 'utf8')));
  for (const source of launchers) assert.match(source, /native-source\\build-windows\.ps1/u);
});

test('build-windows-node.sh 只构建备用 Node 包，并声明 Node 已弃用', async () => {
  const script = await readFile(path.join(root, 'windows/node-source/build-windows-node.sh'), 'utf8');
  assert.match(script, /^#!\/usr\/bin\/env bash\n/u);
  assert.doesNotMatch(script, /\r\n/u, 'shell 脚本必须使用 LF 换行');
  for (const expected of [
    'npm run build:windows -- --release',
    'npm run release:windows -- --skip-native',
    'windows/node-build',
    '--out',
    'verify-release.mjs',
    'start-windows-node-silent.cmd'
  ]) {
    assert.equal(script.includes(expected), true, `备用构建缺少：${expected}`);
  }
  // 备用入口不得再构建原生 EXE。
  assert.equal(script.includes('native/build-windows.ps1'), false, '备用脚本不得调用原生构建');
  assert.match(script, /已弃用/u);
});

test('Node 宿主弃用已在 README 声明', async () => {
  // 弃用声明只断言仓库内仅存的 README.md。
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /build-windows-node\.sh/u);
});
test('build-windows.cmd / build-windows-node.cmd 是不依赖 Git Bash 的 CMD 入口', async () => {
  const cases = [
    ['build-windows.cmd', ['npm run build:windows -- --release', 'windows\\native-source\\build-windows.ps1', 'windows\\native-build', 'native-build\\release\\single-file', 'native-build\\release\\multi-file', 'npm run release:windows', 'verify-release.mjs', 'chaoxing_plus.exe', 'chaoxing_plus.com', 'package-to-single\\chaoxing_plus.exe', '-BuildConsole', 'multi-file']],
    ['build-windows-node.cmd', ['npm run build:windows -- --release', '--skip-native', 'windows\\node-build', '--out', 'start-windows-node.cmd', 'verify-release.mjs']]
  ];
  for (const [name, expected] of cases) {
    const sourceDirectory = name.includes('-node') ? 'node-source' : 'native-source';
    const bytes = await readFile(path.join(root, 'windows', sourceDirectory, name));
    if (name !== 'build-windows.cmd') assert.equal(bytes.includes(13), false, `${name} 必须使用 LF 换行`);
    const text = decodeWindowsScript(bytes, `windows/${sourceDirectory}/${name}`);
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
      encoding: 'buffer', timeout: 15000, windowsHide: true, windowsVerbatimArguments: true,
      cwd: tmpdir(),
      // 帮助无需工具链；解析回归也不能意外触发真正的构建。
      env: { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') }
    });
    const stdout = new TextDecoder(directory === 'native-source' ? 'gbk' : 'utf-8', { fatal: true }).decode(result.stdout);
    const stderr = result.stderr.toString('utf8');
    assert.equal(result.status, 0, `${name}: ${stdout}\n${stderr}`);
    const lines = stdout.trim().split(/\r?\n/u);
    if (directory === 'native-source') {
      assert.equal(lines.length, 3);
      assert.equal(lines[0], `用法：${name} [--skip-tests] [--no-deps]`);
      assert.match(lines[1], /构建原生 x86/u);
      assert.match(lines[2], /--no-deps/u);
    } else {
      assert.equal(lines.length, 2, `${name} 只能输出用法和描述`);
      assert.equal(lines[0], `Usage: ${name} [--skip-tests]`);
      assert.match(lines[1], /^\s*Builds /u);
    }
    assert.doesNotMatch(stdout, /\[build-windows\].*(?:building|正在)/iu);
    assert.equal(stderr, '');
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
    ['node-scripts', 'start-windows-node-debug.cmd'],
    ['native-scripts', 'start-windows-debug.cmd']
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
  assert.match(browser, /Vite 8 需要 Node\.js 20\.19\+ 或 22\.12\+/u);
  assert.match(browser, /WSL\/Linux Node\.js/u);
  assert.match(browser, /NPM_PATH=/u);
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
  for (const directory of ['node-source', 'native-source', 'native-scripts', 'node-scripts', 'share-file']) {
    assert.equal(windowsEntries.includes(directory), true, `缺少 ${directory}`);
  }
  const browserBuild = await readFile(path.join(root, 'build.mjs'), 'utf8');
  assert.match(browserBuild, /src\/index\.ts/u);
  assert.match(browserBuild, /outDir:\s*['"]dist['"]/u);
  const sharedWindowsFiles = [...browserBuild.matchAll(/['"](windows\/(?:node-source|native-source|share-file)\/[^'"]+)['"]/gu)]
    .map(match => match[1]);
  assert.deepEqual(sharedWindowsFiles, ['windows/node-source/extension-log-core.mjs'],
    '扩展只复用明确登记的诊断核心，不得调用原生/Node宿主构建或写入Windows产物目录');
  assert.equal((await readFile(path.join(root, 'src/index.ts'))).length > 0, true);
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.build, 'node build.mjs');
});
test('Windows 脚本验证明确编码：中文构建 PS1 使用 BOM、中文 CMD 使用 GBK，其余保留 ASCII', async () => {
  const directories = ['windows/native-source', 'windows/native-scripts', 'windows/node-source', 'windows/node-scripts', 'windows/share-file'];
  const extensions = ['.cmd', '.ps1', '.vbs'];
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(path.join(root, directory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const extension = extensions.find((ext) => entry.name.endsWith(ext));
      if (!extension) continue;
      const bytes = await readFile(path.join(root, directory, entry.name));
      decodeWindowsScript(bytes, `${directory}/${entry.name}`);
      if (extension === '.cmd' && `${directory}/${entry.name}` !== 'windows/native-source/build-windows.cmd') {
        assert.equal(bytes.includes(13), false, `${directory}/${entry.name} 必须使用 LF 换行`);
      }
    }
  }
});

