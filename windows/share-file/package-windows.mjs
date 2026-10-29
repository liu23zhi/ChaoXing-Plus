#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 生成可直接分发的 Windows 发布包：
//   1. 优先包含原生单文件 EXE（资源已内嵌，可独立运行）；
//   2. 同时包含 Node 宿主目录 + dist-windows 资源 + start-windows.cmd；
//   3. 生成 release-info.json 与 SHA256SUMS.txt，并用系统 Compress-Archive 打 zip。
// 脚本不修改工作区构建产物，只读取它们；输出目录默认 release/（已 gitignore）。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_REQUIRED = [
  'windows-bootstrap.js',
  'chaoxing-plus.windows.js',
  'trampoline.js',
  path.join('vendor', 'sweetalert2.min.css'),
  'package-manifest.json'
];
// Node 宿主运行时需要的非模块文件；构建期模块不得进入发布包。
const HOST_RUNTIME_SCRIPTS = ['launch-client.ps1', 'scan-progress-window.ps1', 'selection-window.ps1', 'system-probe.ps1', 'silent-launch.vbs'];
// wipe.mjs / owned-files.mjs 已升级为启动清理运行时依赖；自毁状态机仍由后续模块按需引入。
const HOST_FORBIDDEN_MODULES = new Set(['chrome75-syntax.mjs', 'trampoline.js']);
const EXTERNAL_IMPORT_PATTERN = /\b(?:from|import)\s+'((?!node:|\.\/)[^']+)'/gu;
const RELATIVE_MODULE_PATTERN = /\b(?:from|import)\s+'\.\/([A-Za-z0-9_-]+\.mjs)'/gu;

function fail(message, code = 2) {
  console.error(`[release] ${message}`);
  process.exit(code);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(directory, base = directory) {
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await walkFiles(absolute, base));
    } else if (entry.isFile()) {
      result.push(path.relative(base, absolute).split(path.sep).join('/'));
    }
  }
  return result;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return hash.digest('hex').toUpperCase();
}

// 从 main.mjs 递归收集相对模块闭包，保证发布包只带实际运行依赖；
// 内部原型（自毁/清理/owned-files）和构建期模块不会被打进运行时包。
async function collectHostRuntime(hostDir) {
  const runtime = new Map();
  const pending = [path.join(hostDir, 'main.mjs')];
  while (pending.length > 0) {
    const absolute = pending.pop();
    const relative = path.relative(hostDir, absolute).split(path.sep).join('/');
    if (runtime.has(relative)) continue;
    if (HOST_FORBIDDEN_MODULES.has(relative)) {
      fail(`Node 宿主运行闭包包含第一阶段未发布的内部原型模块：${relative}`);
    }
    if (!(await pathExists(absolute))) fail(`Node 宿主缺少运行模块：${relative}`);
    const source = await fs.readFile(absolute, 'utf8');
    for (const match of source.matchAll(EXTERNAL_IMPORT_PATTERN)) {
      fail(`Node 宿主发布包只能依赖 Node 内置模块，发现外部依赖：${match[1]}（${relative}）`);
    }
    runtime.set(relative, Buffer.byteLength(source));
    for (const match of source.matchAll(RELATIVE_MODULE_PATTERN)) {
      pending.push(path.join(hostDir, match[1]));
    }
  }
  for (const script of HOST_RUNTIME_SCRIPTS) {
    const absolute = path.join(hostDir, script);
    if (!(await pathExists(absolute))) fail(`Node 宿主缺少运行脚本：${script}`);
    runtime.set(script, (await fs.stat(absolute)).size);
  }
  return runtime;
}

function parseArgs(argv) {
  const options = {
    out: path.join(repoRoot, 'release'),
    distDir: path.join(repoRoot, 'dist-windows'),
    hostDir: path.join(repoRoot, 'windows', 'node-source'),
    launcher: path.join(repoRoot, 'windows', 'node-source', 'start-windows-node.cmd'),
    debugLauncher: path.join(repoRoot, 'windows', 'node-source', 'start-windows-node-debug.cmd'),
    silentLauncher: path.join(repoRoot, 'windows', 'node-source', 'start-windows-node-silent.cmd'),
    configExample: path.join(repoRoot, 'windows', 'share-file', 'config.example.json'),
    verifier: path.join(repoRoot, 'windows', 'share-file', 'verify-release.mjs'),
    exe: path.join(repoRoot, 'build-windows', 'bin', 'chaoxing_plus.exe'),
    // 自带 Node 运行时：发布包内的入口优先用 runtime\node.exe，避免依赖目标机器的
    // C:\Program Files\nodejs\node.exe（考试机通常没有 Node.js）。
    runtimeExe: process.platform === 'win32' ? process.execPath : '',
    // Node 宿主已弃用：发布包默认只含原生 EXE，Node 闭包/启动器/运行时需 --with-node。
    withNode: false,
    skipRuntime: process.platform !== 'win32',
    skipNative: false,
    skipZip: false,
    skipDocs: false,
    name: '',
    version: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) fail(`${argument} 缺少参数值`);
      index += 1;
      return next;
    };
    switch (argument) {
      case '--out': options.out = path.resolve(value()); break;
      case '--dist-dir': options.distDir = path.resolve(value()); break;
      case '--host-dir': options.hostDir = path.resolve(value()); break;
      case '--launcher': options.launcher = path.resolve(value()); break;
      case '--debug-launcher': options.debugLauncher = path.resolve(value()); break;
      case '--silent-launcher': options.silentLauncher = path.resolve(value()); break;
      case '--config-example': options.configExample = path.resolve(value()); break;
      case '--verifier': options.verifier = path.resolve(value()); break;
      case '--exe': options.exe = path.resolve(value()); break;
      case '--runtime-exe': options.runtimeExe = path.resolve(value()); options.skipRuntime = false; break;
      case '--no-runtime': options.skipRuntime = true; break;
      case '--with-node': options.withNode = true; break;
      case '--no-node': options.withNode = false; break;
      case '--name': options.name = value(); break;
      case '--version': options.version = value(); break;
      case '--skip-native': options.skipNative = true; options.withNode = true; break;
      case '--skip-zip': options.skipZip = true; break;
      case '--skip-docs': options.skipDocs = true; break;
      case '--help': case '-h':
        console.log([
          '用法: node windows/share-file/package-windows.mjs [选项]',
          '  --out <dir>        输出目录（默认 release/）',
          '  --dist-dir <dir>   dist-windows 资源目录',
          '  --host-dir <dir>   Node 宿主目录（默认 windows/node-source）',
          '  --launcher <file>  start-windows-node.cmd（无控制台常规入口）',
          '  --debug-launcher <file>  start-windows-node-debug.cmd（可见控制台调试入口）',
          '  --silent-launcher <file>  start-windows-node-silent.cmd（无控制台启动入口）',
          '  --config-example <file>   windows/share-file/config.example.json（首跑配置模板）',
          '  --verifier <file>          windows/share-file/verify-release.mjs（包内完整性校验器）',
          '  --exe <file>       原生 EXE（默认原生构建产物；不存在时仅打 Node 包）',
          '  --runtime-exe <file> 内嵌到 runtime\\node.exe 的 Node 运行时（默认当前 node.exe）',
          '  --no-runtime       不内嵌 Node 运行时（入口退回 PATH 上的 node.exe）',
          '  --with-node        额外携带 Node 宿主闭包/启动器/自带运行时（Node 已弃用，仅备用）',
          '  --no-node          只打原生 EXE（默认）',
          '  --skip-native      不包含原生 EXE',
          '  --skip-zip         只生成暂存目录，不创建 zip',
          '  --skip-docs        不包含 README.md / docs/windows.md',
          '  --name <name>      包目录名（默认 chaoxing-plus-<version>-windows）',
          '  --version <ver>    覆盖 package.json 的版本号',
          '  --help             显示帮助'
        ].join('\n'));
        process.exit(0);
        break;
      default: fail(`未知参数：${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = options.version || packageJson.version;
  const name = options.name || `chaoxing-plus-${version}-windows`;
  const packageRoot = path.join(options.out, name);

  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(String(version))) fail(`版本号不合法：${version}`);
  if (!(await pathExists(options.distDir))) fail(`缺少 dist-windows 目录：${options.distDir}（先运行 npm run build:windows）`);
  for (const required of DIST_REQUIRED) {
    if (!(await pathExists(path.join(options.distDir, required)))) fail(`dist-windows 缺少资源：${required}`);
  }
  // 本地 windows/local-features.json 可能开启调试面板日志；发布包必须由
  // `npm run build:windows -- --release` 强制关闭后再构建，避免把调试构建发出去。
  const manifestPath = path.join(options.distDir, 'package-manifest.json');
  let packageManifest;
  try {
    packageManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    fail(`dist-windows/package-manifest.json 不是合法 JSON：${error.message}`);
  }
  // 旧构建常被误打成新版本；包清单版本必须与发布版本一致，失败关闭。
  const manifestVersion = packageManifest && packageManifest.version !== undefined ? String(packageManifest.version) : '';
  if (!manifestVersion) {
    fail('dist-windows/package-manifest.json 缺少 version；请重新运行 npm run build:windows 后再打包');
  }
  if (manifestVersion !== String(version)) {
    fail(`dist-windows/package-manifest.json 版本 ${manifestVersion} 与发布版本 ${version} 不一致；请重新运行 npm run build:windows -- --release 后再打包`);
  }
  if (packageManifest && packageManifest.features && packageManifest.features.injectionLog === true) {
    fail('dist-windows 包含本地调试注入日志（features.injectionLog=true），发布包拒绝打包；请先运行 npm run build:windows -- --release 并重新构建原生宿主');
  }
  if (options.withNode) {
    if (!(await pathExists(options.launcher))) fail(`缺少启动脚本：${options.launcher}`);
    if (!(await pathExists(options.debugLauncher))) fail(`缺少调试启动脚本：${options.debugLauncher}`);
    if (!(await pathExists(options.silentLauncher))) fail(`缺少静默启动脚本：${options.silentLauncher}`);
  }
  if (!(await pathExists(options.configExample))) fail(`缺少配置模板：${options.configExample}`);
  if (!(await pathExists(options.verifier))) fail(`缺少发布包校验器：${options.verifier}`);
  if (options.withNode && !(await pathExists(options.hostDir))) fail(`缺少 Node 宿主目录：${options.hostDir}`);

  const includeNative = !options.skipNative && await pathExists(options.exe);
  if (!options.skipNative && !includeNative) {
    console.warn(`[release] 未找到原生 EXE（${options.exe}），将生成仅含 Node 宿主的发布包；如需原生单文件请先构建原生宿主。`);
  }

  await fs.rm(packageRoot, { recursive: true, force: true });
  await fs.mkdir(packageRoot, { recursive: true });

  // Node 宿主已弃用：默认只打原生 EXE；--with-node（或 --skip-native）才携带下面的内容。
  if (options.withNode) {
    // dist-windows 只是 Node 宿主的注入资源；原生 EXE 使用构建期内嵌副本。
    await fs.cp(options.distDir, path.join(packageRoot, 'dist-windows'), { recursive: true });

    // Node 宿主目录：只带 main.mjs 运行闭包和受控运行脚本，测试/内部原型不进入发布包。
    const hostRuntime = await collectHostRuntime(options.hostDir);
    const hostTarget = path.join(packageRoot, 'windows', 'node-source');
    await fs.mkdir(hostTarget, { recursive: true });
    for (const relative of [...hostRuntime.keys()].sort()) {
      await fs.copyFile(path.join(options.hostDir, relative), path.join(hostTarget, relative));
    }
    await fs.copyFile(options.launcher, path.join(packageRoot, 'start-windows-node.cmd'));
    await fs.copyFile(options.debugLauncher, path.join(packageRoot, 'start-windows-node-debug.cmd'));
    await fs.copyFile(options.silentLauncher, path.join(packageRoot, 'start-windows-node-silent.cmd'));
    for (const [sourceName, targetName] of [
      [path.join('windows','node-source','silent-memory-bootstrap.mjs'), 'windows/node-source/silent-memory-bootstrap.mjs'],
      [path.join('windows','node-source','silent-memory-launch.vbs'), 'windows/node-source/silent-memory-launch.vbs']
    ]) {
      const source = path.join(repoRoot, sourceName);
      if (await pathExists(source)) {
        const target = path.join(packageRoot, targetName);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
      }
    }
    for (const [sourceName, targetName] of [
      ['start-windows-node-silent-debug.cmd', 'start-windows-node-silent-debug.cmd'],
      ['start-windows-node-silent-no-full-scan-debug.cmd', 'start-windows-node-silent-no-full-scan-debug.cmd']
    ]) {
      const source = path.join(repoRoot, 'windows', 'node-source', sourceName);
      if (await pathExists(source)) await fs.copyFile(source, path.join(packageRoot, targetName));
    }
  }
  // Both package variants use the shared configuration template directory.
  await fs.mkdir(path.join(packageRoot, 'windows', 'share-file'), { recursive: true });
  await fs.copyFile(options.configExample, path.join(packageRoot, 'windows', 'share-file', 'config.example.json'));
  if (includeNative) {
    // 原生入口：指向包内 chaoxing_plus.exe，不依赖 Node/PowerShell。
    for (const name of [
      'start-windows.cmd',
      'start-windows-debug.cmd',
      'start-windows-silent.cmd',
      'start-windows-silent-debug.cmd',
      'start-windows-silent-no-full-scan-debug.cmd'
    ]) {
      const source = path.join(repoRoot, 'windows', 'native-source', name);
      if (!(await pathExists(source))) fail(`缺少原生启动脚本：${name}`);
      await fs.copyFile(source, path.join(packageRoot, name));
    }
  }
  await fs.copyFile(options.verifier, path.join(packageRoot, 'verify-release.mjs'));
  if (!options.skipDocs) {
    for (const doc of ['README.md', path.join('docs', 'windows.md')]) {
      const source = path.join(repoRoot, doc);
      if (!(await pathExists(source))) continue;
      const target = path.join(packageRoot, doc);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
  }
  if (includeNative) {
    await fs.copyFile(options.exe, path.join(packageRoot, 'chaoxing_plus.exe'));
  }

  // 自带运行时：包内入口优先使用它，目标机器不需要安装 Node.js。
  let runtimeRelative = '';
  if (options.withNode && !options.skipRuntime && options.runtimeExe) {
    if (await pathExists(options.runtimeExe)) {
      runtimeRelative = 'runtime/node.exe';
      await fs.mkdir(path.join(packageRoot, 'runtime'), { recursive: true });
      await fs.copyFile(options.runtimeExe, path.join(packageRoot, runtimeRelative));
    } else {
      console.warn(`[release] 未找到可内嵌的 Node 运行时（${options.runtimeExe}）；包内入口会退回 PATH 上的 node.exe`);
    }
  }

  const files = await walkFiles(packageRoot);
  const info = {
    name,
    version,
    host: 'windows',
    createdAt: new Date().toISOString(),
    nativeHost: includeNative,
    nodeHost: options.withNode,
    node: options.withNode ? process.version : '',
    entrypoints: options.withNode
      ? (includeNative
        ? { native: 'chaoxing_plus.exe', node: 'start-windows-node.cmd', nodeDebug: 'start-windows-node-debug.cmd', nodeSilent: 'start-windows-node-silent.cmd', nodeSilentDebug: 'start-windows-node-silent-debug.cmd', nodeSilentNoFullScanDebug: 'start-windows-node-silent-no-full-scan-debug.cmd' }
        : { node: 'start-windows-node.cmd', nodeDebug: 'start-windows-node-debug.cmd', nodeSilent: 'start-windows-node-silent.cmd', nodeSilentDebug: 'start-windows-node-silent-debug.cmd', nodeSilentNoFullScanDebug: 'start-windows-node-silent-no-full-scan-debug.cmd' })
      : { native: 'chaoxing_plus.exe' },
    assetsDir: options.withNode ? 'dist-windows' : '',
    runtime: runtimeRelative,
    payloadFiles: files.length,
    verifier: 'verify-release.mjs'
  };
  await fs.writeFile(path.join(packageRoot, 'release-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');

  const hashTargets = [...files, 'release-info.json'].sort();
  const sums = [];
  for (const relative of hashTargets) {
    sums.push(`${await hashFile(path.join(packageRoot, relative))} *${relative}`);
  }
  await fs.writeFile(path.join(packageRoot, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`, 'utf8');

  let archive = '';
  if (!options.skipZip) {
    if (process.platform !== 'win32') {
      fail('创建 zip 需要 Windows 的 Compress-Archive；可在非 Windows 仅生成暂存目录（--skip-zip）');
    }
    archive = path.join(options.out, `${name}.zip`);
    await fs.rm(archive, { force: true });
    const script = [
      `$ErrorActionPreference='Stop'`,
      `Compress-Archive -LiteralPath ${shellQuote(packageRoot)} -DestinationPath ${shellQuote(archive)} -CompressionLevel Optimal`
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 300000
    });
    if (result.status !== 0 || !(await pathExists(archive))) {
      fail(`创建 zip 失败：${(result.stderr || result.stdout || '').trim()}`, 1);
    }
  }

  console.log(JSON.stringify({
    ok: true,
    name,
    version,
    packageRoot,
    archive: archive || null,
    nativeHost: includeNative,
    files: hashTargets.length,
    verifier: 'verify-release.mjs',
    sizeBytes: (await fs.stat(path.join(packageRoot, includeNative ? 'chaoxing_plus.exe' : 'start-windows-node.cmd'))).size
  }, null, 2));
}

main().catch((error) => fail(error && error.message ? error.message : String(error), 1));






