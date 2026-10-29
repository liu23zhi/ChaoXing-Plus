import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const packageScript = path.join(root, 'scripts', 'package-windows.mjs');

function runPackager(args) {
  return spawnSync(process.execPath, [packageScript, ...args], {
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
  for (const decoy of ['self-destruct.mjs', 'wipe.mjs', 'owned-files.mjs', 'chrome75-syntax.mjs', 'trampoline.js', 'wipe-runtime.mjs']) {
    await writeFixtureFile(path.join(host, decoy), '// internal prototype\n');
  }
  const launcher = path.join(directory, 'start-windows.cmd');
  await writeFixtureFile(launcher, '@echo off\n');
  const silentLauncher = path.join(directory, 'start-windows-silent.cmd');
  await writeFixtureFile(silentLauncher, '@echo off\n');
  const configExample = path.join(directory, 'config.example.json');
  await writeFixtureFile(configExample, '{"settings":{"common.settings.windows-panel-theme":"pink"}}\n');
  const verifier = path.join(root, 'scripts', 'verify-release.mjs');
  const exe = path.join(directory, 'chaoxing_plus.exe');
  await fs.writeFile(exe, Buffer.from('MZ fake native host'));
  return { directory, dist, host, launcher, silentLauncher, configExample, verifier, exe };
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
    '--silent-launcher', fixture.silentLauncher,
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
    'chaoxing_plus.exe', 'start-windows.cmd', 'start-windows-silent.cmd',
    'dist-windows/windows-bootstrap.js', 'dist-windows/chaoxing-plus.windows.js',
    'dist-windows/trampoline.js', 'dist-windows/vendor/sweetalert2.min.css',
    'dist-windows/package-manifest.json',
    'windows/host/main.mjs', 'windows/host/launch.mjs',
    'windows/host/launch-client.ps1', 'windows/host/selection-window.ps1',
    'windows/host/scan-progress-window.ps1',
    'windows/host/system-probe.ps1', 'windows/host/silent-launch.vbs',
    'windows/config.example.json', 'verify-release.mjs',
    'release-info.json', 'SHA256SUMS.txt'
  ]) {
    assert.equal(files.includes(expected), true, expected);
  }
  assert.equal(await fs.readFile(path.join(packageRoot, 'windows', 'config.example.json'), 'utf8'),
    '{"settings":{"common.settings.windows-panel-theme":"pink"}}\n', '发布包必须携带首跑配置模板');
  for (const forbidden of ['self-destruct.mjs', 'wipe.mjs', 'owned-files.mjs', 'chrome75-syntax.mjs', 'trampoline.js']) {
    assert.equal(files.some((name) => name === `windows/host/${forbidden}`), false, forbidden);
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
    native: 'chaoxing_plus.exe', node: 'start-windows.cmd', nodeSilent: 'start-windows-silent.cmd'
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
  const tampered = path.join(packageRoot, 'start-windows.cmd');
  await fs.appendFile(tampered, '\nrem tampered\n');
  const verifyFailure = spawnSync(process.execPath, [path.join(packageRoot, 'verify-release.mjs')], {
    encoding: 'utf8', timeout: 60000, windowsHide: true
  });
  assert.equal(verifyFailure.status, 1, `${verifyFailure.stdout}\n${verifyFailure.stderr}`);
  assert.match(verifyFailure.stderr, /摘要不匹配：start-windows\.cmd/u);
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

test('发布打包拒绝包含本地调试注入日志的构建', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  await writeFixtureFile(path.join(fixture.dist, 'package-manifest.json'), '{"version":"9.9.9","features":{"injectionLog":true}}\n');
  const result = runPackager([
    '--dist-dir', fixture.dist,
    '--host-dir', fixture.host,
    '--launcher', fixture.launcher,
    '--silent-launcher', fixture.silentLauncher,
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
    '--silent-launcher', fixture.silentLauncher,
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
    '--silent-launcher', fixture.silentLauncher,
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
  assert.equal((await fs.stat(path.join(packageRoot, 'start-windows.cmd'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, 'start-windows-silent.cmd'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, 'windows', 'host', 'silent-launch.vbs'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, 'windows', 'config.example.json'))).isFile(), true);
  assert.equal((await fs.stat(path.join(packageRoot, 'verify-release.mjs'))).isFile(), true);
  assert.equal(await fs.access(path.join(packageRoot, 'chaoxing_plus.exe')).then(() => true, () => false), false);
  const info = JSON.parse(await fs.readFile(path.join(packageRoot, 'release-info.json'), 'utf8'));
  assert.equal(info.nativeHost, false);
  assert.deepEqual(info.entrypoints, { node: 'start-windows.cmd', nodeSilent: 'start-windows-silent.cmd' });
});

test('打包脚本对缺失资源、内部原型和外部依赖失败关闭', async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rm(fixture.directory, { recursive: true, force: true }));
  const commonArgs = [
    '--dist-dir', fixture.dist, '--host-dir', fixture.host, '--launcher', fixture.launcher,
    '--silent-launcher', fixture.silentLauncher, '--config-example', fixture.configExample, '--verifier', fixture.verifier,
    '--out', path.join(fixture.directory, 'out-fail'), '--version', '9.9.9', '--skip-native', '--skip-zip', '--skip-docs'
  ];

  const help = runPackager(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法: node scripts\/package-windows\.mjs/u);

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
  await writeFixtureFile(path.join(fixture.host, 'main.mjs'), "import './self-destruct.mjs';\n");
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
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /\$env:GITHUB_ENV/u, 'native compiled test paths must be exported to later CI steps');
  assert.match(workflow, /发布包解压入口自检/u);
  assert.match(workflow, /windows\\host\\main\.mjs.*--self-check/us, 'CI must self-check the packaged Node launcher');
  assert.match(workflow, /Start-Process .*chaoxing_plus\.exe.*--self-check/us, 'CI must self-check the packaged native host');
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
  assert.equal(packageJson.scripts['release:windows'], 'node scripts/package-windows.mjs');
  assert.equal(packageJson.scripts['build:native'].includes('windows/native/build.ps1'), true);

  const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(gitignore, /^release\/$/mu);
  assert.match(gitignore, /^\/\.data\/$/mu, '原生宿主默认 .data 目录必须被忽略');
  assert.match(gitignore, /^release-ci\/$/mu, 'CI 冒烟输出目录必须被忽略');
});

test('原生构建脚本保持 ASCII 且不依赖 PowerShell 模块自动加载', async () => {
  const bytes = await fs.readFile(path.join(root, 'windows', 'native', 'build.ps1'));
  for (const byte of bytes) {
    assert.equal(byte <= 0x7f, true, 'build.ps1 必须保持纯 ASCII（Windows PowerShell 5.1 按 ANSI 解析无 BOM .ps1）');
  }
  const source = bytes.toString('utf8');
  // 曾出现 Get-FileHash 在部分启动环境下 CommandNotFound 导致构建误报失败；改用系统 certutil 输出摘要。
  assert.match(source, /certutil\.exe -hashfile \$hostExe SHA256/u);
  assert.doesNotMatch(source, /Get-FileHash/u);
  assert.match(source, /if \(\$BuildTests\)/u);
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['build:native'], 'powershell -NoProfile -ExecutionPolicy Bypass -File windows/native/build.ps1 -BuildTests');
});
