#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NtExecutable, NtExecutableResource } from 'pe-library';
import { Data, Resource } from 'resedit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptNames = ['launch-client.ps1', 'selection-window.ps1', 'scan-progress-window.ps1', 'system-probe.ps1'];
const assetNames = {
  bootstrap: 'windows-bootstrap.js', bundle: 'chaoxing-plus.windows.js',
  trampoline: 'trampoline.js', style: 'vendor/sweetalert2.min.css'
};

export async function collectPayload({ hostDir, scriptsDir, distDir, configExample, version }) {
  const manifest = JSON.parse(await fs.readFile(path.join(distDir, 'package-manifest.json'), 'utf8'));
  if (manifest.version !== version || manifest.features?.injectionLog === true) {
    throw new Error('Injection assets must match the version and disable injectionLog; run npm run build:windows -- --release');
  }
  const modules = {};
  const pending = ['main.mjs'];
  while (pending.length) {
    const name = pending.pop();
    if (Object.hasOwn(modules, name)) continue;
    if (!/^[a-z0-9-]+\.mjs$/u.test(name) || name === 'chrome75-syntax.mjs') {
      throw new Error(`Unsupported host module: ${name}`);
    }
    const source = await fs.readFile(path.join(hostDir, name), 'utf8');
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)['"]([^'"]+)['"]/gu)) {
      if (match[1].startsWith('node:')) continue;
      if (!/^\.\/[a-z0-9-]+\.mjs$/u.test(match[1])) throw new Error(`External host dependency: ${match[1]}`);
      pending.push(match[1].slice(2));
    }
    modules[name] = source;
  }
  const scripts = {};
  for (const name of scriptNames) scripts[name] = await fs.readFile(path.join(scriptsDir, name), 'utf8');
  const assets = { version };
  for (const [key, name] of Object.entries(assetNames)) {
    assets[key] = await fs.readFile(path.join(distDir, name), 'utf8');
    if (!assets[key].trim()) throw new Error(`Empty injection asset: ${name}`);
  }
  const template = await fs.readFile(configExample, 'utf8');
  JSON.parse(template);
  return { version, modules, scripts, assets, configExample: template };
}

export function embedWindowsResources(executable, icon, blob) {
  const pe = NtExecutable.from(executable, { ignoreCert: true });
  const resources = NtExecutableResource.from(pe);
  // Remove Node's original icons, preserving its manifest and SEA support.
  resources.entries = resources.entries.filter((entry) => entry.type !== 3 && entry.type !== 14);
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033,
    Data.IconFile.from(icon).icons.map((item) => item.data));
  resources.entries.push({ type: 10, id: 'NODE_SEA_BLOB', lang: 0, codepage: 0, bin: blob });
  resources.outputResource(pe);
  const output = Buffer.from(pe.generate());
  // Node SEA uses a named RCDATA resource and this fuse to select its entry.
  const fuse = Buffer.from('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0');
  const offset = output.indexOf(fuse);
  if (offset < 0 || output.lastIndexOf(fuse) !== offset) throw new Error('Node SEA fuse is missing or ambiguous');
  output[offset + fuse.length - 1] = 0x31;
  return output;
}

export async function buildNodeExe(options) {
  if (process.platform !== 'win32') throw new Error('Windows is required to build and verify the Node EXE');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required');
  const payload = await collectPayload(options);
  await fs.mkdir(options.buildDir, { recursive: true });
  await fs.mkdir(options.out, { recursive: true });
  const payloadPath = path.join(options.buildDir, 'host-payload.json');
  const blobPath = path.join(options.buildDir, 'sea-prep.blob');
  const configPath = path.join(options.buildDir, 'sea-config.json');
  const candidate = path.join(options.buildDir, 'chaoxing_plus_node.exe');
  const executable = path.join(options.out, 'chaoxing_plus_node.exe');
  await fs.writeFile(payloadPath, JSON.stringify(payload));
  await fs.writeFile(configPath, JSON.stringify({
    main: path.join(root, 'windows', 'node-source', 'sea-bootstrap.cjs'),
    output: blobPath, disableExperimentalSEAWarning: true,
    useSnapshot: false, useCodeCache: false, assets: { 'host-payload.json': payloadPath }
  }, null, 2));
  const preparation = spawnSync(process.execPath, ['--experimental-sea-config', configPath], {
    encoding: 'utf8', windowsHide: true, timeout: 120000
  });
  if (preparation.status !== 0) throw new Error(preparation.stderr || preparation.error?.message || 'SEA preparation failed');
  await fs.writeFile(candidate, embedWindowsResources(await fs.readFile(process.execPath),
    await fs.readFile(options.icon), await fs.readFile(blobPath)));
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (probe.status !== 0 || probe.stdout.trim() !== options.version) {
    throw new Error(`SEA version check failed: ${probe.error?.message || probe.stderr || probe.stdout}`);
  }
  await fs.copyFile(candidate, executable);
  return { ok: true, executable, version: options.version, node: process.version, architecture: process.arch,
    modules: Object.keys(payload.modules).length, sizeBytes: (await fs.stat(executable)).size,
    sha256: createHash('sha256').update(await fs.readFile(executable)).digest('hex') };
}

async function main() {
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const options = {
    version, hostDir: path.join(root, 'windows', 'node-source'), scriptsDir: path.join(root, 'windows', 'node-scripts'), distDir: path.join(root, 'dist-windows'),
    configExample: path.join(root, 'windows', 'share-file', 'config.example.json'),
    icon: path.join(root, 'windows', 'share-file', 'assets', 'app-icon.ico'),
    buildDir: path.join(root, 'windows', 'node-build', 'build'),
    out: path.join(root, 'windows', 'node-build', 'release')
  };
  const valueOptions = { '--out': 'out', '--build-dir': 'buildDir', '--dist-dir': 'distDir' };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--help' || args[index] === '-h') {
      console.log('Usage: node windows/node-source/package-node-exe.mjs [--out dir] [--build-dir dir] [--dist-dir dir]\nDefault: windows/node-build/release/chaoxing_plus_node.exe (Node SEA, embedded host/assets/icon)');
      return;
    }
    const key = valueOptions[args[index]];
    if (!key || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid argument: ${args[index]}`);
    options[key] = path.resolve(args[++index]);
  }
  console.log(JSON.stringify(await buildNodeExe(options), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[node-exe] ${error.stack || error}`); process.exitCode = 1; });
}
