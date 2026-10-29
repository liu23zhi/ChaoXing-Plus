#!/usr/bin/env node
// 发布包完整性校验器：按同目录 SHA256SUMS.txt 逐项校验文件摘要。
// 不依赖任何 npm 包，可在解压后的发布包根目录直接运行：
//   node verify-release.mjs [包目录]
// 未指定目录时默认校验脚本自身所在目录。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  console.error(`[verify] ${message}`);
  process.exit(2);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(process.argv[2] || scriptDirectory);
const sumsPath = path.join(packageRoot, 'SHA256SUMS.txt');
if (!existsSync(sumsPath) || !statSync(sumsPath).isFile()) {
  fail(`缺少校验清单：${sumsPath}`);
}

const entries = [];
for (const rawLine of readFileSync(sumsPath, 'utf8').split(/\r?\n/u)) {
  const line = rawLine.trim();
  if (!line) continue;
  const match = line.match(/^([0-9A-Fa-f]{64}) \*(.+)$/u);
  if (!match) fail(`校验清单格式不合法：${line}`);
  const relative = match[2].replace(/\//gu, path.sep);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
    fail(`校验清单包含非法路径：${match[2]}`);
  }
  entries.push({ expected: match[1].toUpperCase(), relative, filePath: path.join(packageRoot, relative) });
}
if (entries.length === 0) fail('校验清单为空');

const failures = [];
for (const entry of entries) {
  if (!existsSync(entry.filePath) || !statSync(entry.filePath).isFile()) {
    failures.push(`缺少文件：${entry.relative}`);
    continue;
  }
  let actual;
  try {
    actual = await hashFile(entry.filePath);
  } catch (error) {
    failures.push(`无法读取：${entry.relative}（${error.message}）`);
    continue;
  }
  if (actual !== entry.expected) failures.push(`摘要不匹配：${entry.relative}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[verify] ${failure}`);
  console.error(`[verify] 校验失败：${failures.length}/${entries.length} 项不通过（${packageRoot}）`);
  process.exit(1);
}
console.log(`[verify] 发布包完整性校验通过：${entries.length} 个文件（${packageRoot}）`);
