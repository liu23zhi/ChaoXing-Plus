import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const packageScript = path.join(root, 'windows', 'share-file', 'package-windows.mjs');

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
  const consoleExe = path.join(directory, 'chaoxing_plus_console.exe');
  await fs.writeFile(consoleExe, Buffer.from('MZ fake console native host'));
  return { directory, dist, host, launcher, debugLauncher, silentLauncher, configExample, verifier, exe, consoleExe };
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

test('发布包新增 single-file 与 multi-file 子目录并区分 GUI/Console 入口', { skip: process.platform !== 'win32' }, async (t) => {
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
    '--console-exe', fixture.consoleExe,
    '--out', out,
    '--name', 'variant-package',
    '--version', '9.9.9',
    '--skip-docs', '--skip-zip'
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packageRoot = path.join(out, 'variant-package');
  assert.equal(await fs.readFile(path.join(packageRoot, 'single-file', 'chaoxing_plus.exe'), 'utf8'), 'MZ fake native host');
  assert.equal(await fs.readFile(path.join(packageRoot, 'multi-file', 'chaoxing_plus_console.exe'), 'utf8'), 'MZ fake console native host');
  for (const name of ['start-windows.cmd', 'start-windows-debug.cmd', 'start-windows-silent.cmd', 'start-windows-silent-debug.cmd', 'start-windows-silent-no-full-scan-debug.cmd']) {
    const source = await fs.readFile(path.join(packageRoot, 'multi-file', name), 'utf8');
    assert.match(source, /chaoxing_plus_console\.exe/u, `${name} 必须指向 Console 子系统入口`);
    assert.doesNotMatch(source, /chaoxing_plus\.exe(?!_console)/u, `${name} 不得误指向 GUI 入口`);
  }
  const info = JSON.parse(await fs.readFile(path.join(packageRoot, 'release-info.json'), 'utf8'));
  assert.deepEqual(info.variants, {
    'single-file': { directory: 'single-file', executable: 'single-file/chaoxing_plus.exe', subsystem: 'windows' },
    'multi-file': { directory: 'multi-file', executable: 'multi-file/chaoxing_plus_console.exe', subsystem: 'console' }
  });
  assert.equal(
    (await fs.readFile(path.join(packageRoot, 'multi-file', 'release-info.json'), 'utf8').then((text) => JSON.parse(text).entrypoints.native)),
    'chaoxing_plus_console.exe'
  );
  const verify = spawnSync(process.execPath, [path.join(packageRoot, 'multi-file', 'verify-release.mjs')], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, cwd: path.join(packageRoot, 'multi-file')
  });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
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
  const workflow = await fs.readFile(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /^name: CI$/mu);
  assert.match(workflow, /runs-on: windows-latest/u);
  assert.match(workflow, /node-version: '22'/u);
  assert.match(workflow, /npm ci/u);
  assert.match(workflow, /npm run typecheck/u);
  assert.match(workflow, /npm run build$/mu);
  assert.match(workflow, /npm run build:windows/u);
  assert.match(workflow, /npm run build:native/u);
  assert.match(workflow, /node --test --test-concurrency=4 --test-timeout=300000 @testFiles/u);
  assert.match(workflow, /node --test --test-concurrency=4 --test-timeout=600000 @browserFiles/u);
  assert.match(workflow, /npm run release:windows/u);
  assert.match(workflow, /Expand-Archive -LiteralPath/u, 'CI 必须验证 ZIP 解压后的实际产物');
  assert.match(workflow, /windows\/native-build\/\*\.zip/u, 'CI 只能上传原生构建目录内的发布包');
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /\$env:GITHUB_ENV/u, 'native compiled test paths must be exported to later CI steps');
  assert.match(workflow, /发布包解压入口自检/u);
  assert.match(workflow, /Start-Process .*chaoxing_plus\.exe.*--self-check/us, 'CI must self-check the packaged native host');
  assert.match(workflow, /single-file\\chaoxing_plus\.exe/u, 'CI must check the GUI variant');
  assert.match(workflow, /multi-file\\chaoxing_plus_console\.exe/u, 'CI must check the Console variant');
  assert.match(workflow, /multi-file\\verify-release\.mjs/u, 'CI must verify the Console variant checksum');
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
    'CX_NATIVE_DPI_CHILD_EXE', 'CX_NATIVE_PROCESS_CHECK_EXE', 'CX_NATIVE_PROCESS_FIXTURE_EXE', 'CX_NATIVE_DIAGNOSTICS_EXE'
  ];
  for (const name of nativeExecutables) {
    assert.match(workflow, new RegExp(name), `CI must export ${name} so native tests and browser suites run`);
  }
  assert.match(workflow, /node --test --test-concurrency=4 --test-timeout=600000 @browserFiles/u);

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
  assert.match(source, /chaoxing_plus_console\.exe/u);
  assert.match(source, /Join-Path \$release 'single-file'/u);
  assert.match(source, /Join-Path \$release 'multi-file'/u);
  assert.match(source, /singleFileExe/u);
  assert.match(source, /multiFileExe/u);
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

test('原生发布直接生成输出目录内的两种变体，不增加版本目录或根兼容 EXE', { skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const out = path.join(fixture.directory, 'native-only');
  // 直接调用打包脚本：不附加 --with-node，验证默认行为。
  const result = spawnSync(process.execPath, [packageScript,
    '--dist-dir', fixture.dist,
    '--host-dir', fixture.host,
    '--launcher', fixture.launcher,
    '--silent-launcher', fixture.silentLauncher, '--debug-launcher', fixture.debugLauncher,
    '--config-example', fixture.configExample,
    '--verifier', fixture.verifier,
    '--exe', fixture.exe,
    '--console-exe', fixture.consoleExe,
    '--out', out,
    '--name', 'native-only',
    '--version', '9.9.9',
    '--skip-docs'
  ], { encoding: 'utf8', timeout: 300000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packageRoot = out;
  assert.equal(JSON.parse(result.stdout).packageRoot, out);
  const archive = path.join(fixture.directory, 'native-only.zip');
  assert.equal(JSON.parse(result.stdout).archive, archive);
  assert.ok((await fs.stat(archive)).size > 0);
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(path.relative(packageRoot, absolute).split(path.sep).join('/'));
    }
  }
  await walk(packageRoot);
  for (const expected of ['single-file/chaoxing_plus.exe', 'multi-file/chaoxing_plus_console.exe', 'verify-release.mjs', 'release-info.json', 'SHA256SUMS.txt', 'multi-file/windows/share-file/config.example.json', 'multi-file/start-windows.cmd', 'multi-file/start-windows-silent.cmd', 'multi-file/verify-release.mjs', 'multi-file/SHA256SUMS.txt']) {
    assert.equal(files.includes(expected), true, `默认包缺少 ${expected}`);
  }
  assert.deepEqual(await fs.readdir(path.join(packageRoot, 'single-file')), ['chaoxing_plus.exe']);
  assert.equal(files.includes('chaoxing_plus.exe'), false, '原生发布根目录不再放兼容 EXE');
  for (const forbidden of ['start-windows-node.cmd', 'start-windows-node-silent.cmd', 'runtime/node.exe']) {
    assert.equal(files.includes(forbidden), false, `默认包不得包含 ${forbidden}`);
  }
  assert.equal(files.some((name) => name.startsWith('windows/node-source/')), false, '默认包不得包含 Node 宿主闭包');
  assert.equal(files.some((name) => name.startsWith('dist-windows/')), false, '默认包不得包含 Node 注入资源');
  const info = JSON.parse(await fs.readFile(path.join(packageRoot, 'release-info.json'), 'utf8'));
  assert.equal(info.nodeHost, false);
  assert.deepEqual(info.entrypoints, { native: 'single-file/chaoxing_plus.exe', nativeConsole: 'multi-file/chaoxing_plus_console.exe' });
  assert.equal(info.assetsDir, '');
  assert.equal(info.runtime, '');
  // 发布包只放单个 EXE：代理 DLL 已内嵌在 EXE 里，不再随包外置。
  assert.equal(files.includes('winmm-proxy.dll'), false, '代理不应再以独立文件随包');
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
    '--console-exe', fixture.consoleExe, '--out', fixture.directory, '--version', '9.9.9', '--skip-zip']);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'user-owned');
  assert.equal(await fs.readFile(fixture.exe, 'utf8'), 'MZ fake native host');
});



