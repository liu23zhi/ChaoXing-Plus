import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from '@typescript/typescript6';

const root = process.cwd();
const outDir = resolve(root, '.tmp-tests');
const loadedModules = new Map();
let importVersion = 0;

export function loadCompiledTypeScriptModule(sourcePath, outputPaths) {
  const source = resolve(sourcePath);
  if (!loadedModules.has(source)) {
    loadedModules.set(source, compileAndImport(source, outputPaths));
  }
  return loadedModules.get(source);
}

async function compileAndImport(sourcePath, outputPaths) {
  const outputPath = resolve(outDir, outputPaths[0]);
  const source = await readFile(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, 'utf8');

  const moduleUrl = new URL(pathToFileURL(outputPath).href);
  moduleUrl.searchParams.set('v', String(importVersion++));
  return import(moduleUrl.href);
}
