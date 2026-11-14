import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from '@typescript/typescript6';
import { createTestDirectory } from './temp-directory.mjs';

const outDir = createTestDirectory('compiled-typescript');
const loadedModules = new Map();
let importVersion = 0;

/**
 * 把 `.ts` 源码转译进临时目录，并**按它在 `src/` 下的相对路径**落盘。
 *
 * 为什么必须镜像目录结构（而不是一律落到 outDir 根）：只要被加载的模块里有
 * 指向父目录的相对 import（如 `status-panel-http.ts` 的
 * `../runtime/device-identity.js`），落盘位置就决定了那条 import 能否解析。
 * 镜像 `src/` 之后，`../runtime/x.js` 从 `<outDir>/projects/` 出发正好指到
 * `<outDir>/runtime/x.js`。
 *
 * 只跟进**值 import** 的相对 `.js` 说明符（跳过 `import type`，那条在转译时会被
 * 整个擦除，跟进它会把 `src/core/index.ts` 这种大子树无谓地拖进来）。
 */

/** 匹配值 import 的相对 `.js` 说明符；用负向回顾排除 `import type ... from`。 */
function collectRelativeImports(source) {
  const specifiers = new Set();
  // 逐条语句扫：`import ... from '...'` / `export ... from '...'` / `import('...')`
  const STATEMENT = /(?:^|[\n;])\s*(import|export)\s+(?!type\b)([^'"`;]*?)from\s*['"](\.[^'"]*\.js)['"]/gu;
  for (const match of source.matchAll(STATEMENT)) {
    specifiers.add(match[3]);
  }
  const DYNAMIC = /\bimport\s*\(\s*['"](\.[^'"]*\.js)['"]\s*\)/gu;
  for (const match of source.matchAll(DYNAMIC)) {
    specifiers.add(match[1]);
  }
  return [...specifiers];
}

function srcRoot() {
  return resolve(process.cwd(), 'src');
}

/** 说明符对应的源码文件：优先同名 `.ts`（与 build.mjs 的 .ts 优先一致）。 */
async function resolveDependencySource(fromSource, specifier) {
  const target = resolve(dirname(fromSource), specifier);
  for (const candidate of [`${target.slice(0, -3)}.ts`, target]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 试下一个
    }
  }
  return undefined;
}

function outputPathFor(sourcePath) {
  const relativePath = relative(srcRoot(), sourcePath);
  if (!relativePath || relativePath.startsWith('..')) {
    // 不在 src/ 下：退回按文件名落盘（现有调用点没有这种用法，仅作兜底）。
    return resolve(outDir, sourcePath.split(/[\\/]/u).pop().replace(/\.ts$/u, '.js'));
  }
  return resolve(outDir, relativePath.replace(/\.ts$/u, '.js'));
}

async function transpileOne(sourcePath, seen) {
  const absolute = resolve(sourcePath);
  if (seen.has(absolute)) {
    return outputPathFor(absolute);
  }
  seen.add(absolute);

  const source = await readFile(absolute, 'utf8');
  const outputPath = outputPathFor(absolute);

  // 先转译依赖，再写自己 —— 保证 import 目标落盘时已存在。
  for (const specifier of collectRelativeImports(source)) {
    const dependency = await resolveDependencySource(absolute, specifier);
    if (dependency && dependency.endsWith('.ts')) {
      await transpileOne(dependency, seen);
    }
  }

  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, 'utf8');
  return outputPath;
}

export function loadCompiledTypeScriptModule(sourcePath, outputPaths) {
  const source = resolve(sourcePath);
  if (!loadedModules.has(source)) {
    loadedModules.set(source, compileAndImport(source, outputPaths));
  }
  return loadedModules.get(source);
}

async function compileAndImport(sourcePath, outputPaths) {
  // `outputPaths` 保留在签名里以维持调用点不变，但落盘位置改由源码在 `src/` 下的
  // 相对路径决定 —— 否则带父目录相对 import 的模块解析不到依赖。
  void outputPaths;
  const outputPath = await transpileOne(sourcePath, new Set());

  const moduleUrl = new URL(pathToFileURL(outputPath).href);
  moduleUrl.searchParams.set('v', String(importVersion++));
  return import(moduleUrl.href);
}
