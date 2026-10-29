// Phase-two design prototype; the stage-one host does not import this module.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DIAGNOSTICS_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/u;
const DIAGNOSTIC_FILES = new Set([
  'render-diagnostics.json',
  'render-diagnostics-window.png',
  'render-diagnostics-page.png'
]);

function comparePaths(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

function pathKey(value) {
  return path.win32.normalize(path.resolve(value)).toLowerCase();
}

function isClientExecutableName(value) {
  const basename = path.win32.basename(value).replace(/[ .]+$/gu, '').toLowerCase();
  return /^cxexam\.exe(?:$|[:.])/u.test(basename) || /^cxexam~\d+(?:\.|$)/u.test(basename);
}

async function isRealDirectory(directory) {
  try {
    const stat = await fs.lstat(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function listMatchingFiles(directory, matches) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile() || !matches(entry.name)) continue;
    const filePath = path.resolve(directory, entry.name);
    if (!isClientExecutableName(filePath)) files.push(filePath);
  }
  return files;
}

export async function listOwnedHostFiles(appDataDirectory, { externalConfigPath = '' } = {}) {
  if (typeof appDataDirectory !== 'string' || !appDataDirectory.trim() || !path.isAbsolute(appDataDirectory)) {
    return [];
  }

  const root = path.resolve(appDataDirectory);
  if (!(await isRealDirectory(root))) return [];
  const externalConfigKey = typeof externalConfigPath === 'string' && externalConfigPath.trim()
    ? pathKey(externalConfigPath)
    : '';
  const ownedFiles = [];
  const addUnlessExternal = (filePath) => {
    if (!externalConfigKey || pathKey(filePath) !== externalConfigKey) ownedFiles.push(filePath);
  };

  for (const filePath of await listMatchingFiles(root, (name) => ['config.json', 'scan-cache.json'].includes(name.toLowerCase()))) {
    addUnlessExternal(filePath);
  }

  const logsDirectory = path.join(root, 'logs');
  if (await isRealDirectory(logsDirectory)) {
    const logFiles = await listMatchingFiles(logsDirectory, (name) => /^host-.*\.log$/iu.test(name));
    for (const filePath of logFiles) addUnlessExternal(filePath);
  }

  const diagnosticsDirectory = path.join(root, 'diagnostics');
  if (await isRealDirectory(diagnosticsDirectory)) {
    let entries = [];
    try {
      entries = await fs.readdir(diagnosticsDirectory, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || !DIAGNOSTICS_STAMP.test(entry.name)) continue;
      const runDirectory = path.join(diagnosticsDirectory, entry.name);
      if (!(await isRealDirectory(runDirectory))) continue;
      const runFiles = await listMatchingFiles(runDirectory, (name) => DIAGNOSTIC_FILES.has(name.toLowerCase()));
      for (const filePath of runFiles) addUnlessExternal(filePath);
    }
  }

  return [...new Set(ownedFiles)].sort(comparePaths);
}
