// 静默场景内存启动引导：通过 stdin 执行，先把 Node 宿主模块闭包读入内存，
// 注册内存 ESM 加载器，再从内存 import main.mjs。磁盘宿主文件随后由运行中的
// 程序清理控制器删除；之后的模块解析全部来自内存。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';

const hostDirectory = path.join(process.cwd(), 'windows', 'node-source');
const scriptsDirectory = path.join(process.cwd(), 'windows', 'node-scripts');
const mainPath = path.join(hostDirectory, 'main.mjs');
const argumentsList = process.argv.slice(2);
globalThis.__CX_SILENT_MEMORY_BOOTSTRAP__ = true;

const files = new Map();
try {
  const entries = await fs.readdir(hostDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const absolute = path.join(hostDirectory, entry.name);
    files.set(pathToFileURL(absolute).href, await fs.readFile(absolute, 'utf8'));
  }
  const launchScript = await fs.readFile(path.join(scriptsDirectory, 'launch-client.ps1'), 'utf8');
  globalThis.__CX_SILENT_EMBEDDED_SCRIPTS__ = Object.freeze({ 'launch-client.ps1': launchScript });
  const scriptNames = ['launch-client.ps1', 'selection-window.ps1', 'scan-progress-window.ps1', 'system-probe.ps1'];
  const embeddedScripts = { 'launch-client.ps1': launchScript };
  for (const name of scriptNames) {
    try { embeddedScripts[name] = await fs.readFile(path.join(scriptsDirectory, name), 'utf8'); } catch {}
  }
  globalThis.__CX_SILENT_EMBEDDED_SCRIPTS__ = Object.freeze(embeddedScripts);
  const assetsDirectory = path.join(process.cwd(), 'dist-windows');
  const embeddedAssets = {
    bootstrap: await fs.readFile(path.join(assetsDirectory, 'windows-bootstrap.js'), 'utf8'),
    bundle: await fs.readFile(path.join(assetsDirectory, 'chaoxing-plus.windows.js'), 'utf8'),
    trampoline: await fs.readFile(path.join(assetsDirectory, 'trampoline.js'), 'utf8'),
    style: '',
    version: ''
  };
  try { embeddedAssets.style = await fs.readFile(path.join(assetsDirectory, 'vendor', 'sweetalert2.min.css'), 'utf8'); } catch {}
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(assetsDirectory, 'package-manifest.json'), 'utf8'));
    embeddedAssets.version = String(manifest.version || '');
  } catch {}
  globalThis.__CX_SILENT_EMBEDDED_ASSETS__ = Object.freeze(embeddedAssets);
  globalThis.__CX_SILENT_EMBEDDED_STATS__ = Object.freeze({
    modules: files.size,
    scripts: Object.keys(embeddedScripts).length,
    assets: ['bootstrap', 'bundle', 'trampoline', 'style'].filter((key) => Boolean(embeddedAssets[key])).length
  });
  if (argumentsList.includes('--memory-probe')) {
    console.log(JSON.stringify(globalThis.__CX_SILENT_EMBEDDED_STATS__));
    process.exit(0);
  }
} catch {
  process.exitCode = 2;
  // 无控制台：不输出，直接退出；调试入口仍走磁盘 main.mjs。
  process.exit(2);
}

const loaderSource = `export async function initialize(data) {
  globalThis.__CX_MEMORY_FILES__ = new Map(data.files || []);
}
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.')) {
    try {
      const url = new URL(specifier, context.parentURL).href;
      if (globalThis.__CX_MEMORY_FILES__.has(url)) return { url, shortCircuit: true };
    } catch {}
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (globalThis.__CX_MEMORY_FILES__ && globalThis.__CX_MEMORY_FILES__.has(url)) {
    return { format: 'module', source: globalThis.__CX_MEMORY_FILES__.get(url), shortCircuit: true };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, {
  data: { files: [...files.entries()] }
});

process.argv = [process.execPath, mainPath, ...argumentsList];
await import(pathToFileURL(mainPath).href);
