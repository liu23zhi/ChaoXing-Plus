import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const packageScript = path.join(root, 'windows', 'share-file', 'package-windows.mjs');
const multiRuntimeFiles = [
  'chaoxing_plus.exe', 'chaoxing_plus.com',
  'assets/windows-bootstrap.js', 'assets/chaoxing-plus.windows.js', 'assets/trampoline.js',
  'assets/vendor/sweetalert2.min.css', 'winmm-proxy.dll', 'package-to-single/chaoxing_plus.exe'
];

function runPackager(args) {
  // 夹具默认不内嵌真实 node.exe（约 100MB），避免每个用例都拷一遍；
  // 需要验证自带运行时行为的用例显式传 --runtime-exe。
  // 夹具默认按"原生 + Node 备用"布局断言；新的默认（只打原生）由专门用例覆盖。
  let effective = args.includes('--with-node') || args.includes('--no-node') || args.includes('--skip-native')
    ? args
    : [...args, '--with-node'];
  if (!effective.includes('--no-runtime') && !effective.includes('--runtime-exe')) effective = [...effective, '--no-runtime'];
  return spawnSync(process.execPath, [packageScript, ...effective], {
    encoding: 'utf8', timeout: 300000, windowsHide: true
  });
}

async function writeFixtureFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function createFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-release-fixture-'));
  const dist = path.join(directory, 'dist-windows');
  for (const name of ['windows-bootstrap.js', 'chaoxing-plus.windows.js', 'trampoline.js']) {
    await writeFixtureFile(path.join(dist, name), `// ${name}\n`);
  }
  await writeFixtureFile(path.join(dist, 'vendor', 'sweetalert2.min.css'), '/* css */\n');
  await writeFixtureFile(path.join(dist, 'package-manifest.json'), '{"version":"9.9.9"}\n');

  const host = path.join(directory, 'host');
  await writeFixtureFile(path.join(host, 'main.mjs'), [
    "import { launch } from './launch.mjs';",
    "launch();"
  ].join('\n'));
  await writeFixtureFile(path.join(host, 'launch.mjs'), [
    "import { promises as fs } from 'node:fs';",
    'export function launch() { return fs; }'
  ].join('\n'));
  for (const script of ['launch-client.ps1', 'scan-progress-window.ps1', 'selection-window.ps1', 'system-probe.ps1', 'silent-launch.vbs']) {
    await writeFixtureFile(path.join(host, script), '# fixture runtime script\n');
  }
  // 这些文件属于内部原型/构建期模块，不得进入发布包运行闭包。
  for (const decoy of ['chrome75-syntax.mjs', 'trampoline.js', 'wipe-runtime.mjs']) {
    await writeFixtureFile(path.join(host, decoy), '// internal prototype\n');
  }
  const launcher = path.join(directory, 'start-windows.cmd');
  await writeFixtureFile(launcher, '@echo off\n');
  const debugLauncher = path.join(directory, 'start-windows-debug.cmd');
  await writeFixtureFile(debugLauncher, '@echo off\n');
  const silentLauncher = path.join(directory, 'start-windows-silent.cmd');
  await writeFixtureFile(silentLauncher, '@echo off\n');
  const configExample = path.join(directory, 'config.example.json');
  await writeFixtureFile(configExample, '{"settings":{"common.settings.windows-panel-theme":"pink"}}\n');
  const verifier = path.join(root, 'windows', 'share-file', 'verify-release.mjs');
  const exe = path.join(directory, 'chaoxing_plus.exe');
  await fs.writeFile(exe, Buffer.from('MZ fake native host'));
  const multiDir = path.join(directory, 'multi-build');
  for (const relative of multiRuntimeFiles) {
    await writeFixtureFile(path.join(multiDir, relative), `fixture multi runtime ${relative}\n`);
  }
  await writeFixtureFile(path.join(multiDir, 'debug-test.exe'), 'not a release runtime\n');
  await writeFixtureFile(path.join(multiDir, 'package-to-single', 'stale-wrapper.exe'), 'not a release runtime\n');
  return { directory, dist, host, launcher, debugLauncher, silentLauncher, configExample, verifier, exe, multiDir };
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex').toUpperCase();
}

test('发布打包脚本生成原生 + Node 双入口包、校验和与 zip', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const out = path.join(fixture.directory, 'out');
  const result = runPackager([
    '--dist-dir', fixture.dist,
    '--host-dir', fixture.host,
    '--launcher', fixture.launcher,
    '--silent-launcher', fixture.silentLauncher, '--debug-launcher', fixture.debugLauncher,
    '--config-example', fixture.configExample,
    '--verifier', fixture.verifier,
    '--exe', fixture.exe,
    '--multi-dir', fixture.multiDir,
    '--out', out,
    '--name', 'fixture-package',
    '--version', '9.9.9',
    '--skip-docs'
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.name, 'fixture-package');
  assert.equal(summary.nativeHost, true);
  const packageRoot = path.join(out, 'fixture-package');
  assert.equal(summary.packageRoot, packageRoot);

  const files = [];
  async function walk(directory, base) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, base);
      else files.push(path.relative(base, absolute).split(path.sep).join('/'));
    }
  }
  await walk(packageRoot, packageRoot);
  for (const expected of [
    'chaoxing_plus.exe', 'start-windows-node.cmd', 'start-windows-node-debug.cmd', 'start-windows-node-silent.cmd',
    'start-windows-node-silent-debug.cmd', 'start-windows-node-silent-no-full-scan-debug.cmd',
    'start-windows.cmd', 'start-windows-debug.cmd', 'start-windows-silent.cmd',
    'start-windows-silent-debug.cmd', 'start-windows-silent-no-full-scan-debug.cmd',
    'dist-windows/windows-bootstrap.js', 'dist-windows/chaoxing-plus.windows.js',
    'dist-windows/trampoline.js', 'dist-windows/vendor/sweetalert2.min.css',
    'dist-windows/package-manifest.json',
    'windows/node-source/main.mjs', 'windows/node-source/launch.mjs',
    'windows/node-scripts/launch-client.ps1', 'windows/node-scripts/selection-window.ps1',
    'windows/node-scripts/scan-progress-window.ps1',
    'windows/node-scripts/system-probe.ps1', 'windows/node-scripts/silent-launch.vbs',
    'windows/share-file/config.example.json', 'verify-release.mjs',
    'release-info.json', 'SHA256SUMS.txt'
  ]) {
    assert.equal(files.includes(expected), true, expected);
  }
  assert.equal(await fs.readFile(path.join(packageRoot, 'windows', 'share-file', 'config.example.json'), 'utf8'),
    '{"settings":{"common.settings.windows-panel-theme":"pink"}}\n', '发布包必须携带首跑配置模板');
  for (const forbidden of ['chrome75-syntax.mjs', 'trampoline.js']) {
    assert.equal(files.some((name) => name === `windows/node-source/${forbidden}`), false, forbidden);
  }
  assert.equal(files.some((name) => name.startsWith('windows/data/')), false,
    '发布包不得包含运行期数据或日志目录');
  assert.equal(files.some((name) => /(?:^|\/)host-[^/]*\.log$/u.test(name) || name.endsWith('.log')), false,
    '发布包不得包含宿主日志文件');

  const info = JSON.parse(await fs.readFile(path.join(packageRoot, 'release-info.json'), 'utf8'));
  assert.equal(info.name, 'fixture-package');
  assert.equal(info.version, '9.9.9');
  assert.equal(info.nativeHost, true);
  assert.equal(info.nodeHost, true);
  assert.deepEqual(info.entrypoints, {
    native: 'chaoxing_plus.exe', node: 'start-windows-node.cmd', nodeDebug: 'start-windows-node-debug.cmd', nodeSilent: 'start-windows-node-silent.cmd', nodeSilentDebug: 'start-windows-node-silent-debug.cmd', nodeSilentNoFullScanDebug: 'start-windows-node-silent-no-full-scan-debug.cmd'
  });
  assert.equal(info.payloadFiles, files.length - 2, 'payload files exclude release-info and SHA256SUMS');
  assert.equal(info.verifier, 'verify-release.mjs');

  const sums = (await fs.readFile(path.join(packageRoot, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/u);
  assert.equal(sums.length, files.length - 1, 'SHA256SUMS 覆盖 release-info 与全部 payload');
  const byPath = new Map(sums.map((line) => {
    const match = line.match(/^([0-9A-F]{64}) \*(.+)$/u);
    assert.notEqual(match, null, line);
    return [match[2], match[1]];
  }));
  for (const relative of files) {
    if (relative === 'SHA256SUMS.txt') continue;
    assert.equal(byPath.get(relative), await sha256(path.join(packageRoot, relative)), relative);
  }

  const verify = spawnSync(process.execPath, [path.join(packageRoot, 'verify-release.mjs')], {
    encoding: 'utf8', timeout: 60000, windowsHide: true
  });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  assert.match(verify.stdout, /发布包完整性校验通过/u);
  const tampered = path.join(packageRoot, 'start-windows-node.cmd');
  await fs.appendFile(tampered, '\nrem tampered\n');
  const verifyFailure = spawnSync(process.execPath, [path.join(packageRoot, 'verify-release.mjs')], {
    encoding: 'utf8', timeout: 60000, windowsHide: true
  });
  assert.equal(verifyFailure.status, 1, `${verifyFailure.stdout}\n${verifyFailure.stderr}`);
  assert.match(verifyFailure.stderr, /摘要不匹配：start-windows-node\.cmd/u);
  await fs.writeFile(tampered, '@echo off\n', 'utf8');
  const zipPath = path.join(out, 'fixture-package.zip');
  assert.equal(summary.archive, zipPath);
  assert.equal((await fs.stat(zipPath)).size > 0, true);
  const zipList = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `[System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}').Entries | ForEach-Object { $_.FullName }`
  ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(zipList.status, 0, zipList.stderr);
  const entries = zipList.stdout.split(/\r?\n/u).filter(Boolean).map((name) => name.replace(/\\/gu, '/'));
  for (const relative of files) {
    assert.equal(entries.includes(`fixture-package/${relative}`), true, relative);
  }
});

test('发布包保留 GUI 主程序、Console 辅助入口和明确列出的多文件运行资源', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const out = path.join(fixture.directory, 'out-variants');
  const result = runPackager([
    '--dist-dir', fixture.dist,
    '--host-dir', fixture.host,
    '--launcher', fixture.launcher,
    '--silent-launcher', fixture.silentLauncher, '--debug-launcher', fixture.debugLauncher,
    '--config-example', fixture.configExample,
    '--verifier', fixture.verifier,
    '--exe', fixture.exe,
    '--multi-dir', fixture.multiDir,
    '--out', out,
    '--name', 'variant-package',
    '--version', '9.9.9',
    '--skip-docs', '--skip-zip'
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packageRoot = path.join(out, 'variant-package');
  assert.equal(await fs.readFile(path.join(packageRoot, 'single-file', 'chaoxing_plus.exe'), 'utf8'), 'MZ fake native host');
  for (const relative of multiRuntimeFiles) {
    assert.equal(await fs.readFile(path.join(packageRoot, 'multi-file', relative), 'utf8'), `fixture multi runtime ${relative}\n`);
  }
  await assert.rejects(fs.access(path.join(packageRoot, 'multi-file', 'debug-test.exe')));
  await assert.rejects(fs.access(path.join(packageRoot, 'multi-file', 'package-to-single', 'stale-wrapper.exe')));
  for (const name of ['start-windows.cmd', 'start-windows-debug.cmd']) {
    const source = await fs.readFile(path.join(packageRoot, 'multi-file', name), 'utf8');
    const debug = name.includes('debug');
    assert.match(source, debug ? /chaoxing_plus\.com/u : /chaoxing_plus\.exe/u,
      `${name} 必须指向${debug ? ' Console 辅助' : ' GUI'}入口`);
    assert.doesNotMatch(source, debug ? /chaoxing_plus\.exe/u : /chaoxing_plus\.com/u, `${name} 不得混用入口`);
  }
  for (const name of ['start-windows-silent.cmd', 'start-windows-silent-debug.cmd', 'start-windows-silent-no-full-scan-debug.cmd']) {
    await assert.rejects(fs.access(path.join(packageRoot, 'multi-file', name)), { code: 'ENOENT' },
      '多文件变体不发布会触发不支持清理行为的静默入口');
  }
  const info = JSON.parse(await fs.readFile(path.join(packageRoot, 'release-info.json'), 'utf8'));
  assert.deepEqual(info.variants, {
    'single-file': { directory: 'single-file', executable: 'single-file/chaoxing_plus.exe', subsystem: 'windows' },
    'multi-file': {
      directory: 'multi-file', executable: 'multi-file/chaoxing_plus.exe',
      consoleHelper: 'multi-file/chaoxing_plus.com', packageToSingle: 'multi-file/package-to-single/chaoxing_plus.exe',
      assetsDir: 'multi-file/assets', subsystem: 'windows'
    }
  });
  const multiInfo = JSON.parse(await fs.readFile(path.join(packageRoot, 'multi-file', 'release-info.json'), 'utf8'));
  assert.deepEqual(multiInfo.entrypoints, {
    native: 'chaoxing_plus.exe', consoleHelper: 'chaoxing_plus.com', packageToSingle: 'package-to-single/chaoxing_plus.exe'
  });
  assert.equal(multiInfo.assetsDir, 'assets');
  assert.equal(multiInfo.subsystem, 'windows');
  const verify = spawnSync(process.execPath, [path.join(packageRoot, 'multi-file', 'verify-release.mjs')], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, cwd: path.join(packageRoot, 'multi-file')
  });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
});

test('多文件构建缺少任一运行文件时拒绝打包且保留原输出', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const out = path.join(fixture.directory, 'incomplete-package');
  const sentinel = path.join(out, 'keep.txt');
  await writeFixtureFile(sentinel, 'user-owned');
  for (const relative of multiRuntimeFiles) {
    const target = path.join(fixture.multiDir, relative);
    const bytes = await fs.readFile(target);
    await fs.rm(target);
    const result = runPackager([
      '--no-node', '--dist-dir', fixture.dist, '--exe', fixture.exe,
      '--multi-dir', fixture.multiDir, '--out', out, '--version', '9.9.9', '--skip-zip', '--skip-docs'
    ]);
    assert.equal(result.status, 2, `${relative}: ${result.stderr || result.stdout}`);
    assert.ok(result.stderr.includes(`多文件构建缺少运行文件：${relative}`), result.stderr);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'user-owned');
    await fs.writeFile(target, bytes);
  }
});

test('未生成多文件构建时只发布 single-file GUI EXE', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const out = path.join(fixture.directory, 'single-package');
  const result = runPackager([
    '--no-node', '--dist-dir', fixture.dist, '--exe', fixture.exe,
    '--multi-dir', path.join(fixture.directory, 'missing-multi'), '--out', out,
    '--version', '9.9.9', '--skip-zip', '--skip-docs'
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const info = JSON.parse(await fs.readFile(path.join(out, 'release-info.json'), 'utf8'));
  assert.deepEqual(info.entrypoints, { native: 'single-file/chaoxing_plus.exe' });
  assert.deepEqual(Object.keys(info.variants), ['single-file']);
  await assert.rejects(fs.access(path.join(out, 'multi-file')));
});

test('禁用 multi 后保留的用户文件和嵌套空目录不触发多文件发布', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  for (const relative of multiRuntimeFiles) await fs.rm(path.join(fixture.multiDir, relative));
  const extra = path.join(fixture.multiDir, 'user-notes.txt');
  const empty = path.join(fixture.multiDir, 'user-owned', 'nested-empty');
  await fs.writeFile(extra, 'user-owned content\n');
  await fs.mkdir(empty, { recursive: true });
  const out = path.join(fixture.directory, 'disabled-multi-package');
  const result = runPackager([
    '--no-node', '--dist-dir', fixture.dist, '--exe', fixture.exe,
    '--multi-dir', fixture.multiDir, '--out', out, '--version', '9.9.9', '--skip-zip', '--skip-docs'
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const info = JSON.parse(await fs.readFile(path.join(out, 'release-info.json'), 'utf8'));
  assert.deepEqual(info.entrypoints, { native: 'single-file/chaoxing_plus.exe' });
  assert.deepEqual(Object.keys(info.variants), ['single-file']);
  await assert.rejects(fs.access(path.join(out, 'multi-file')));
  assert.equal(await fs.readFile(extra, 'utf8'), 'user-owned content\n');
  assert.deepEqual(await fs.readdir(empty), [], 'the retained empty directory is untouched');
  assert.equal(await fs.readFile(path.join(fixture.multiDir, 'debug-test.exe'), 'utf8'), 'not a release runtime\n');
  assert.equal(await fs.readFile(path.join(fixture.multiDir, 'package-to-single', 'stale-wrapper.exe'), 'utf8'), 'not a release runtime\n');
});

test('发布打包拒绝包含本地调试注入日志的构建', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await writeFixtureFile(path.join(fixture.dist, 'package-manifest.json'), '{"version":"9.9.9","features":{"injectionLog":true}}\n');
  const result = runPackager([
    '--dist-dir', fixture.dist,
    '--host-dir', fixture.host,
    '--launcher', fixture.launcher,
    '--silent-launcher', fixture.silentLauncher, '--debug-launcher', fixture.debugLauncher,
    '--config-example', fixture.configExample,
    '--verifier', fixture.verifier,
    '--exe', fixture.exe,
    '--multi-dir', fixture.multiDir,
    '--out', path.join(fixture.directory, 'out-debug'),
    '--name', 'debug-package',
    '--version', '9.9.9',
    '--skip-docs'
  ]);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /injectionLog/u);
  assert.match(result.stderr, /build:windows -- --release/u);
});
test('发布打包拒绝与发布版本不一致的 dist 构建', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await writeFixtureFile(path.join(fixture.dist, 'package-manifest.json'), '{"version":"9.9.8"}\n');
  const result = runPackager([
    '--dist-dir', fixture.dist,
    '--host-dir', fixture.host,
    '--launcher', fixture.launcher,
    '--silent-launcher', fixture.silentLauncher, '--debug-launcher', fixture.debugLauncher,
    '--config-example', fixture.configExample,
    '--verifier', fixture.verifier,
    '--exe', fixture.exe,
    '--multi-dir', fixture.multiDir,
    '--out', path.join(fixture.directory, 'out-stale'),
    '--name', 'stale-package',
    '--version', '9.9.9',
    '--skip-docs'
  ]);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stderr, /9\.9\.8/u);
  assert.match(result.stderr, /不一致/u);
  assert.match(result.stderr, /build:windows/u);
});

test('--skip-native 生成仅 Node 宿主发布包', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const out = path.join(fixture.directory, 'out-node');
  const result = runPackager([
    '--dist-dir', fixture.dist,
    '--host-dir', fixture.host,
    '--launcher', fixture.launcher,
    '--silent-launcher', fixture.silentLauncher, '--debug-launcher', fixture.debugLauncher,
    '--config-example', fixture.configExample,
    '--verifier', fixture.verifier,
    '--out', out,
    '--name', 'node-only',
    '--version', '9.9.9',
    '--skip-native',
    '--skip-zip',
    '--skip-docs'
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.nativeHost, false);
  assert.equal(summary.archive, null);
  const packageRoot = path.join(out, 'node-only');
  assert.equal((await fs.stat(path.join(packageRoot, 'start-windows-node.cmd'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, 'start-windows-node-silent.cmd'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, 'start-windows-node-debug.cmd'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, 'start-windows-node-silent-debug.cmd'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, 'start-windows-node-silent-no-full-scan-debug.cmd'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, 'windows', 'node-scripts', 'silent-launch.vbs'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, 'windows', 'share-file', 'config.example.json'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, 'verify-release.mjs'))).isFile(), true);
  assert.equal(await fs.access(path.join(packageRoot, 'chaoxing_plus.exe')).then(() => true, () => false), false);
  const info = JSON.parse(await fs.readFile(path.join(packageRoot, 'release-info.json'), 'utf8'));
  assert.equal(info.nativeHost, false);
  assert.deepEqual(info.entrypoints, { node: 'start-windows-node.cmd', nodeDebug: 'start-windows-node-debug.cmd', nodeSilent: 'start-windows-node-silent.cmd', nodeSilentDebug: 'start-windows-node-silent-debug.cmd', nodeSilentNoFullScanDebug: 'start-windows-node-silent-no-full-scan-debug.cmd' });
});

test('打包脚本对缺失资源、内部原型和外部依赖失败关闭', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const commonArgs = [
    '--dist-dir', fixture.dist, '--host-dir', fixture.host, '--launcher', fixture.launcher,
    '--silent-launcher', fixture.silentLauncher, '--debug-launcher', fixture.debugLauncher, '--config-example', fixture.configExample, '--verifier', fixture.verifier,
    '--out', path.join(fixture.directory, 'out-fail'), '--version', '9.9.9', '--skip-native', '--skip-zip', '--skip-docs'
  ];

  const help = runPackager(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法: node windows\/share-file\/package-windows\.mjs/u);
  assert.match(help.stdout, /--multi-dir/u);
  assert.doesNotMatch(help.stdout, /--console-exe/u);

  const unknown = runPackager(['--unknown-flag']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知参数/u);

  const missingDist = runPackager(['--dist-dir', path.join(fixture.directory, 'missing'), ...commonArgs.slice(2)]);
  assert.equal(missingDist.status, 2);
  assert.match(missingDist.stderr, /缺少 dist-windows 目录/u);

  await writeFixtureFile(path.join(fixture.host, 'main.mjs'), "import { launch } from './launch.mjs';\n");
  await writeFixtureFile(path.join(fixture.host, 'launch.mjs'), "import chalk from 'chalk';\nexport function launch() { return chalk; }\n");
  const external = runPackager(commonArgs);
  assert.equal(external.status, 2);
  assert.match(external.stderr, /只能依赖 Node 内置模块/u);

  await writeFixtureFile(path.join(fixture.host, 'launch.mjs'), "export function launch() { return 1; }\n");
  await writeFixtureFile(path.join(fixture.host, 'main.mjs'), "import './chrome75-syntax.mjs';\n");
  const prototype = runPackager(commonArgs);
  assert.equal(prototype.status, 2);
  assert.match(prototype.stderr, /内部原型/u);
});

test('CI 工作流与发布脚本入口已接入仓库', async () => {
  const workflow = [
    await fs.readFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
    await fs.readFile(path.join(root, 'scripts', 'ci', 'prepare-windows-test-environment.ps1'), 'utf8'),
    await fs.readFile(path.join(root, 'scripts', 'windows-real-client-injection.ps1'), 'utf8')
  ].join('\n');
  assert.match(workflow, /^name: 持续集成$/mu);
  assert.match(workflow, /^  source:[\s\S]*?runs-on: ubuntu-24\.04/mu, 'CI 必须在 Ubuntu job 执行跨平台源码检查');
  assert.match(workflow, /name: Ubuntu 类型检查与扩展构建/u);
  assert.match(workflow, /name: 持续集成汇总[\s\S]*?needs: \[source, windows-build, windows-unit, windows-pause, windows-window, windows-browser, windows-release, windows-real-client\][\s\S]*?if: always\(\)/u, '汇总 job 必须等待所有拆分环境并报告结果');
  assert.match(workflow, /runs-on: windows-latest/u);
  assert.match(workflow, /node-version: '22'/u);
  assert.match(workflow, /npm ci/u);
  assert.match(workflow, /npm run typecheck/u);
  assert.match(workflow, /npm run build$/mu);
  assert.match(workflow, /npm run build:windows/u);
  assert.match(workflow, /npm run build:native/u);
  assert.match(workflow, /tab-answer-pause\.test\.mjs/u, '高并发全量测试必须包含并显式隔离标签页暂停浏览器回归');
  assert.match(workflow, /node --test --test-reporter=tap --test-concurrency=2 --test-timeout=300000 @testFiles/u, '单元测试必须限制并发');
  assert.match(workflow, /node --test --test-reporter=tap --test-concurrency=1 --test-timeout=300000 \$testFile/u, '标签页暂停浏览器回归必须串行执行');
  assert.match(workflow, /node --test --test-reporter=tap --test-concurrency=1 --test-timeout=600000 @files/u, '浏览器回归必须在独立 runner 串行执行');
  assert.match(workflow, /npm run release:windows/u);
  assert.match(workflow, /Copy-Item -LiteralPath .*'release'/u, 'CI 必须在独立目录验证发布产物');
  assert.match(workflow, /path: windows\/native-build\/release\//u, 'CI 必须直接上传原生发布目录');
  assert.match(workflow, /name: Windows 发布包/u, 'CI 发布包展示名应使用中文');
  assert.match(workflow, /name: 输出各环境结果与发布产物/u, 'CI 必须写入 GitHub Actions 摘要');
  assert.match(workflow, /if: always\(\)/u, 'CI 摘要必须在失败后仍尝试写入');
  assert.match(workflow, /GITHUB_STEP_SUMMARY/u, 'CI 摘要必须写入 GITHUB_STEP_SUMMARY');
  assert.match(workflow, /prepare-windows-test-environment\.ps1 -RequireBrowsers/u, 'CI 必须显式准备浏览器环境');
  assert.match(workflow, /CX_BROWSER_EDGE_PATH/u, 'CI 必须导出 Edge 可执行文件路径');
  assert.match(workflow, /CX_BROWSER_CHROME_PATH/u, 'CI 必须导出 Chrome 可执行文件路径');
  assert.match(workflow, /CX_BROWSER_EXECUTABLE/u, '原生生命周期夹具默认要求 Chrome，Puppeteer 必须使用 Chrome');
  assert.doesNotMatch(workflow, /CX_BROWSER_EXECUTABLE=\$edge/u, 'Edge 专项不能替代默认要求 Chrome 的生命周期回归');
  assert.match(workflow, /CX_DISCOVERY_TEST_DRIVER = 'discovery-cache-driver\.exe'/u, 'CI 必须强制检查复用的原生 discovery 驱动');
  assert.match(workflow, /CX_NATIVE_SILENT_EXE = 'silent-tests\.exe'/u, 'CI 必须强制检查静默引擎原生测试产物');
  assert.match(workflow, /CX_NATIVE_EXTENSION_CACHE_EXE/u, 'CI 必须导出扩展缓存原生测试入口');
  assert.match(workflow, /name: Windows 可见窗口与 Edge\/Chrome 会话回归/u, 'CI 必须执行交互窗口回归');
  assert.match(workflow, /--test-reporter=tap --test-concurrency=1 --test-timeout=600000 @files/u, '交互窗口回归必须串行执行');
  assert.match(workflow, /CX_TEST_NATIVE_WINDOW: '1'/u, 'CI 必须开启真实窗口回归');
  assert.match(workflow, /scripts\/windows-native-adapter\.test\.mjs/u, 'CI 必须覆盖原生账号窗口回归');
  assert.match(workflow, /'scripts\/windows-native-browser-session\.test\.mjs'/u, 'CI 必须在交互环境覆盖 Chrome 与 Edge 可见窗口清理');
  assert.match(workflow, /\$testFiles\.Count -eq 0/u, '全量单元测试清单为空时必须失败');
  assert.match(workflow, /\$files\.Count -eq 0/u, '浏览器测试清单为空时必须失败');
  assert.match(workflow, /name: 发布目录 Node 入口回归/u, 'CI 必须在发布目录生成后补跑 Node 入口回归');
  assert.match(workflow, /scripts\/windows-node-exe\.test\.mjs/u, 'CI 必须补跑发布目录图标与 Node 入口测试');
  assert.match(workflow, /needs: \[windows-build, windows-unit, windows-pause, windows-window, windows-browser\]/u, 'CI 只有全部 Windows 验证成功后才能生成发布包');
  assert.match(workflow, /CX_DISCOVERY_TEST_DRIVER/u, 'CI 必须导出 discovery 测试驱动');
  assert.match(workflow, /真实客户端 3×2 注入矩阵/u, 'CI 摘要必须记录真实客户端矩阵');
  assert.match(workflow, /matrix:/u, '真实客户端注入必须使用矩阵');
  assert.match(workflow, /database: I/u, '真实客户端矩阵必须包含数据库 I');
  assert.match(workflow, /database: II/u, '真实客户端矩阵必须包含数据库 II');
  assert.match(workflow, /tests\/private-clients/u, '真实客户端必须来自私有测试目录');
  assert.match(workflow, /lfs: true/u, '客户端测试必须拉取 Git LFS 资产');
  assert.match(workflow, /Expand-Archive/u, '真实客户端测试必须解压数据库 ZIP');
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /prepare-windows-test-environment\.ps1/u, 'native compiled test paths must be prepared in each runner');
  assert.match(workflow, /发布目录复制后入口自检/u);
  assert.match(workflow, /Start-Process .*chaoxing_plus\.exe.*--self-check/us, 'CI must self-check the packaged native host');
  assert.match(workflow, /single-file\\chaoxing_plus\.exe/u, 'CI must check the GUI variant');
  assert.match(workflow, /multi-file\\chaoxing_plus\.exe/u, 'CI must check the multi-file GUI host');
  assert.match(workflow, /multi-file\\chaoxing_plus\.com/u, 'CI must check the Console helper');
  assert.match(workflow, /multi-file\\package-to-single\\chaoxing_plus\.exe/u, 'CI must check the package launcher');
  assert.match(workflow, /multi-file\\verify-release\.mjs/u, 'CI must verify the multi-file checksum');
  // 原生包里没有 Node 宿主：CI 不得再运行包内 main.mjs，只保留原生自检与禁入清单。
  assert.doesNotMatch(workflow, /node \(Join-Path \$package 'windows\\node-source\\main\.mjs'\)/u, '原生发布包里没有 Node 宿主，CI 不应再运行它');
  assert.match(workflow, /原生发布包不应包含 Node 产物/u, 'CI 必须拒绝混入 Node 产物的原生包');
  assert.match(workflow, /verify-release\.mjs/u, 'CI must run the packaged checksum verifier');
  assert.doesNotMatch(workflow, /secrets\./u);
  const nativeExecutables = [
    'CX_NATIVE_HOST_EXE', 'CX_NATIVE_INJECTION_EXE', 'CX_NATIVE_ASSETS_EXE', 'CX_NATIVE_OPTIONS_EXE',
    'CX_NATIVE_SESSION_EXE', 'CX_NATIVE_SELECTION_EXE', 'CX_NATIVE_TRANSPORT_EXE', 'CX_NATIVE_AUDIT_EXE',
    'CX_NATIVE_CONFIG_EXE', 'CX_NATIVE_CACHE_EXE', 'CX_NATIVE_CACHE_HOST_EXE', 'CX_NATIVE_CLI_SELECTION_EXE',
    'CX_NATIVE_ELEVATION_EXE', 'CX_NATIVE_ELEVATION_HOST_EXE', 'CX_NATIVE_DPI_EXE', 'CX_NATIVE_DPI_PROCESS_EXE',
    'CX_NATIVE_DPI_CHILD_EXE', 'CX_NATIVE_PROCESS_CHECK_EXE', 'CX_NATIVE_PROCESS_FIXTURE_EXE', 'CX_NATIVE_DIAGNOSTICS_EXE',
    'CX_NATIVE_HOME_EXE', 'CX_NATIVE_EXTENSION_CACHE_EXE', 'CX_NATIVE_ADAPTER_EXE', 'CX_NATIVE_ACCOUNT_WINDOW_EXE',
    'CX_NATIVE_BROWSER_SESSION_EXE', 'CX_NATIVE_SILENT_EXE', 'CX_NATIVE_MULTI_HOST_EXE', 'CX_NATIVE_CONSOLE_HELPER_EXE',
    'CX_NATIVE_PACKAGE_LAUNCHER_EXE', 'CX_NATIVE_MULTI_ASSETS_EXE', 'CX_NATIVE_CONSOLE_HELPER_FIXTURE_EXE'
  ];
  for (const name of nativeExecutables) {
    assert.match(workflow, new RegExp(name), `CI must export ${name} so native tests and browser suites run`);
  }
  assert.match(workflow, /node --test --test-reporter=tap --test-concurrency=1 --test-timeout=600000 @files/u);

  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['release:windows'], 'node windows/share-file/package-windows.mjs');
  assert.equal(packageJson.scripts['build:native'].includes('windows/native-source/build-windows.ps1'), true);
  assert.equal(packageJson.scripts['build:native'].includes('-BuildConsole'), true);

  const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(gitignore, /^release\/$/mu);
  assert.match(gitignore, /^\/\.data\/$/mu, '原生宿主默认 .data 目录必须被忽略');
  assert.match(gitignore, /^release-ci\/$/mu, 'CI 冒烟输出目录必须被忽略');
});

test('原生构建脚本保持 ASCII 且不依赖 PowerShell 模块自动加载', async () => {
  const bytes = await fs.readFile(path.join(root, 'windows', 'native-source', 'build-windows.ps1'));
  for (const byte of bytes) {
    assert.equal(byte <= 0x7f, true, 'build-windows.ps1 必须保持纯 ASCII（Windows PowerShell 5.1 按 ANSI 解析无 BOM .ps1）');
  }
  const source = bytes.toString('utf8');
  // 曾出现 Get-FileHash 在部分启动环境下 CommandNotFound 导致构建误报失败；改用系统 certutil 输出摘要。
  assert.match(source, /certutil\.exe -hashfile \$hostExe SHA256/u);
  assert.doesNotMatch(source, /Get-FileHash/u);
  assert.match(source, /if \(\$BuildTests\)/u);
  assert.match(source, /\[switch\]\$BuildConsole/u);
  assert.match(source, /if \(\$BuildConsole\)/u);
  assert.match(source, /SUBSYSTEM:WINDOWS,6\.01/u);
  assert.match(source, /SUBSYSTEM:CONSOLE,6\.01/u);
  assert.match(source, /chaoxing_plus\.com/u);
  assert.match(source, /console-launcher\.c/u);
  assert.match(source, /package-launcher\.c/u);
  assert.match(source, /CX_MULTI_FILE_BUILD/u);
  assert.match(source, /Join-Path \$release 'single-file'/u);
  assert.match(source, /Join-Path \$release 'multi-file'/u);
  assert.match(source, /singleFileExe/u);
  assert.match(source, /package-to-single/u);
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['build:native'], 'powershell -NoProfile -ExecutionPolicy Bypass -File windows/native-source/build-windows.ps1 -BuildTests -BuildConsole');
});

test('发布包内嵌 Node 运行时到 runtime/node.exe 并被校验和覆盖', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const out = path.join(fixture.directory, 'out');
  const runtimeStub = path.join(fixture.directory, 'fake-node.exe');
  await fs.writeFile(runtimeStub, Buffer.from('MZ fake node runtime'));
  const baseArgs = [
    '--dist-dir', fixture.dist,
    '--host-dir', fixture.host,
    '--launcher', fixture.launcher,
    '--silent-launcher', fixture.silentLauncher, '--debug-launcher', fixture.debugLauncher,
    '--config-example', fixture.configExample,
    '--verifier', fixture.verifier,
    '--exe', fixture.exe,
    '--multi-dir', fixture.multiDir,
    '--out', out,
    '--skip-docs',
    '--skip-zip'
  ];

  const withRuntime = runPackager([...baseArgs, '--name', 'runtime-pack', '--version', '9.9.9', '--runtime-exe', runtimeStub]);
  assert.equal(withRuntime.status, 0, withRuntime.stderr || withRuntime.stdout);
  const runtimeRoot = path.join(out, 'runtime-pack');
  const bundled = path.join(runtimeRoot, 'runtime', 'node.exe');
  assert.equal(await fs.readFile(bundled, 'utf8'), 'MZ fake node runtime', '运行时必须落在 runtime/node.exe');
  const info = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'release-info.json'), 'utf8'));
  assert.equal(info.runtime, 'runtime/node.exe');
  const sums = (await fs.readFile(path.join(runtimeRoot, 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/u);
  assert.equal(sums.some((line) => line.endsWith('*runtime/node.exe')), true, '运行时必须进入 SHA256SUMS');
  const verify = spawnSync(process.execPath, [path.join(runtimeRoot, 'verify-release.mjs')], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, cwd: runtimeRoot
  });
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);

  const without = runPackager([...baseArgs, '--name', 'plain-pack', '--version', '9.9.9', '--no-runtime']);
  assert.equal(without.status, 0, without.stderr || without.stdout);
  const plainRoot = path.join(out, 'plain-pack');
  await assert.rejects(fs.access(path.join(plainRoot, 'runtime', 'node.exe')));
  const plainInfo = JSON.parse(await fs.readFile(path.join(plainRoot, 'release-info.json'), 'utf8'));
  assert.equal(plainInfo.runtime, '', '--no-runtime 时不得声明自带运行时');
});

test('原生发布只生成运行目录并清理旧文档和 ZIP，保留其他文件', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const out = path.join(fixture.directory, 'native-only');
  await writeFixtureFile(path.join(out, 'multi-file', 'README.md'), 'legacy generated readme');
  await writeFixtureFile(path.join(out, 'multi-file', 'docs', 'windows.md'), 'legacy generated docs');
  const archive = path.join(fixture.directory, 'native-only.zip');
  await writeFixtureFile(archive, 'legacy generated archive');
  const unrelatedArchive = path.join(fixture.directory, 'user-backup.zip');
  await writeFixtureFile(unrelatedArchive, 'preserve unrelated archive');
  const holder = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    cwd: path.join(out, 'multi-file'), windowsHide: true, stdio: ['pipe', 'ignore', 'ignore']
  });
  await once(holder, 'spawn');
  // 直接调用打包脚本：不附加 --with-node，验证默认行为。
  let result;
  try { result = spawnSync(process.execPath, [packageScript,
    '--dist-dir', fixture.dist,
    '--host-dir', fixture.host,
    '--launcher', fixture.launcher,
    '--silent-launcher', fixture.silentLauncher, '--debug-launcher', fixture.debugLauncher,
    '--config-example', fixture.configExample,
    '--verifier', fixture.verifier,
    '--exe', fixture.exe,
    '--multi-dir', fixture.multiDir,
    '--out', out,
    '--name', 'native-only',
    '--version', '9.9.9'
  ], { encoding: 'utf8', timeout: 300000, windowsHide: true });
  } finally {
    const closed = once(holder, 'close');
    holder.stdin.end();
    await closed;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packageRoot = out;
  assert.equal(JSON.parse(result.stdout).packageRoot, out);
  assert.equal(JSON.parse(result.stdout).archive, null);
  await assert.rejects(fs.access(archive), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(out, 'multi-file', 'docs')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(out, 'multi-file', 'README.md')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(unrelatedArchive, 'utf8'), 'preserve unrelated archive');
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(path.relative(packageRoot, absolute).split(path.sep).join('/'));
    }
  }
  await walk(packageRoot);
  assert.equal(files.some((name) => name.endsWith('.md') || name.endsWith('.zip') || name.includes('/docs/')), false);
  for (const expected of ['single-file/chaoxing_plus.exe', ...multiRuntimeFiles.map((relative) => `multi-file/${relative}`), 'verify-release.mjs', 'release-info.json', 'SHA256SUMS.txt', 'multi-file/windows/share-file/config.example.json', 'multi-file/start-windows.cmd', 'multi-file/start-windows-debug.cmd', 'multi-file/verify-release.mjs', 'multi-file/SHA256SUMS.txt']) {
    assert.equal(files.includes(expected), true, `默认包缺少 ${expected}`);
  }
  assert.deepEqual(files.filter((name) => name.startsWith('multi-file/') && name.endsWith('.cmd')).sort(), [
    'multi-file/start-windows-debug.cmd', 'multi-file/start-windows.cmd'
  ], '多文件变体只发布可用的普通与调试两个启动入口');
  assert.deepEqual(await fs.readdir(path.join(packageRoot, 'single-file')), ['chaoxing_plus.exe']);
  assert.equal(files.includes('chaoxing_plus.exe'), false, '原生发布根目录不再放兼容 EXE');
  for (const forbidden of ['start-windows-node.cmd', 'start-windows-node-silent.cmd', 'runtime/node.exe']) {
    assert.equal(files.includes(forbidden), false, `默认包不得包含 ${forbidden}`);
  }
  assert.equal(files.some((name) => name.startsWith('windows/node-source/')), false, '默认包不得包含 Node 宿主闭包');
  assert.equal(files.some((name) => name.startsWith('dist-windows/')), false, '默认包不得包含 Node 注入资源');
  const info = JSON.parse(await fs.readFile(path.join(packageRoot, 'release-info.json'), 'utf8'));
  assert.equal(info.nodeHost, false);
  assert.deepEqual(info.entrypoints, {
    native: 'single-file/chaoxing_plus.exe', nativeMulti: 'multi-file/chaoxing_plus.exe',
    nativeConsole: 'multi-file/chaoxing_plus.com', nativePackage: 'multi-file/package-to-single/chaoxing_plus.exe'
  });
  assert.equal(info.assetsDir, '');
  assert.equal(info.runtime, '');
  assert.equal(files.includes('winmm-proxy.dll'), false, '根目录不应放置多文件变体的代理');
  assert.equal(files.includes('multi-file/winmm-proxy.dll'), true, '多文件变体必须携带代理侧文件');
  assert.equal(files.some((name) => name.startsWith('hook/')), false, '不应出现 hook 代理目录');
  assert.equal(info.proxyDir, undefined, 'release-info 不再声明外部代理目录');
  const verify = spawnSync(process.execPath, [path.join(packageRoot, 'verify-release.mjs')], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, cwd: packageRoot
  });
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
});

test('原生发布拒绝覆盖源码或带无关文件的输出目录', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const sentinel = path.join(fixture.directory, 'keep.txt');
  await fs.writeFile(sentinel, 'user-owned');
  const result = runPackager(['--no-node', '--dist-dir', fixture.dist, '--exe', fixture.exe,
    '--multi-dir', fixture.multiDir, '--out', fixture.directory, '--version', '9.9.9', '--skip-zip']);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'user-owned');
  assert.equal(await fs.readFile(fixture.exe, 'utf8'), 'MZ fake native host');
  for (const name of ['../user-backup', '..\\user-backup', 'C:backup']) {
    const unsafeName = runPackager(['--no-node', '--dist-dir', fixture.dist, '--exe', fixture.exe,
      '--multi-dir', fixture.multiDir, '--out', path.join(fixture.directory, 'safe-output'), '--version', '9.9.9', '--name', name]);
    assert.equal(unsafeName.status, 2, unsafeName.stderr || unsafeName.stdout);
    assert.match(unsafeName.stderr, /原生发布名称不能包含路径/u);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'user-owned');
  }
});



