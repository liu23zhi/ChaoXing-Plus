import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readPeMachine } from './launch.mjs';

const windowsPath = path.win32;
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export const DEFAULT_SKIP_DIRECTORY_NAMES = new Set([
  '$recycle.bin',
  'config.msi',
  'msocache',
  'perfLogs',
  'recovery',
  'system volume information',
  'system32',
  'syswow64',
  'windows',
  'winsxs'
].map((name) => name.toLowerCase()));

export function findPreferredClientIndex(candidates) {
  return Array.isArray(candidates) ? candidates.findIndex((candidate) => candidate?.machine === 0x014c) : -1;
}

function normalizeWindowsPath(value) {
  const normalized = windowsPath.normalize(String(value || '').trim());
  if (!normalized || normalized === '.') return '';
  const root = windowsPath.parse(normalized).root;
  return normalized.length > root.length ? normalized.replace(/[\\/]+$/u, '') : normalized;
}

function pathKey(value) {
  return normalizeWindowsPath(value).toLowerCase();
}

function isDirectory(entry) {
  return typeof entry?.isDirectory === 'function' ? entry.isDirectory() : entry?.directory === true;
}

function isSymbolicLink(entry) {
  return typeof entry?.isSymbolicLink === 'function' ? entry.isSymbolicLink() : entry?.symlink === true;
}

function isFile(entry) {
  return typeof entry?.isFile === 'function' ? entry.isFile() : entry?.directory !== true;
}

async function isExistingDirectory(directory, fsProvider) {
  try {
    const stat = await fsProvider.stat(directory);
    return typeof stat?.isDirectory === 'function' ? stat.isDirectory() : stat?.directory === true;
  } catch {
    return false;
  }
}

export async function getDefaultDiscoveryRoots({
  env = process.env,
  fsProvider = fs,
  driveLetters = DRIVE_LETTERS
} = {}) {
  const profile = env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : '');
  const candidates = [
    profile ? windowsPath.join(profile, 'Desktop') : '',
    env.OneDrive ? windowsPath.join(env.OneDrive, 'Desktop') : '',
    env.OneDriveConsumer ? windowsPath.join(env.OneDriveConsumer, 'Desktop') : '',
    env.ProgramFiles || '',
    env['ProgramFiles(x86)'] || '',
    env.ProgramW6432 || '',
    env.APPDATA || '',
    env.LOCALAPPDATA || '',
    env.ProgramData || ''
  ];

  const driveRoots = new Set();
  if (env.SystemDrive) driveRoots.add(`${env.SystemDrive.replace(/[\\/]+$/u, '')}\\`);
  for (const letter of driveLetters) {
    const value = String(letter || '').replace(/[:\\/]/gu, '').toUpperCase();
    if (/^[A-Z]$/u.test(value)) driveRoots.add(`${value}:\\`);
  }
  candidates.push(...driveRoots);

  const roots = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = normalizeWindowsPath(candidate);
    const key = pathKey(normalized);
    if (!key || seen.has(key) || !(await isExistingDirectory(normalized, fsProvider))) continue;
    seen.add(key);
    roots.push(normalized);
  }
  return roots;
}

export async function discoverClientExecutables({
  roots,
  rootProvider = getDefaultDiscoveryRoots,
  fsProvider = fs,
  peMachineReader = readPeMachine,
  maxDepth = Number.MAX_SAFE_INTEGER,
  skipDirectoryNames = DEFAULT_SKIP_DIRECTORY_NAMES
} = {}) {
  const resolvedRoots = roots === undefined ? await rootProvider({ fsProvider }) : roots;
  const depthLimit = Number.isFinite(maxDepth) ? Math.max(0, Math.floor(maxDepth)) : Number.MAX_SAFE_INTEGER;
  const skippedNames = new Set(Array.from(skipDirectoryNames || [], (name) => String(name).toLowerCase()));
  const visited = new Set();
  const clients = new Map();

  async function visit(directory, depth) {
    const normalizedDirectory = normalizeWindowsPath(directory);
    const directoryKey = pathKey(normalizedDirectory);
    if (!directoryKey || visited.has(directoryKey)) return;
    visited.add(directoryKey);

    let entries;
    try {
      entries = await fsProvider.readdir(normalizedDirectory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
      const entryPath = windowsPath.join(normalizedDirectory, entry.name);
      if (isDirectory(entry)) {
        if (depth < depthLimit && !isSymbolicLink(entry) && !skippedNames.has(entry.name.toLowerCase())) {
          await visit(entryPath, depth + 1);
        }
        continue;
      }
      if (!isFile(entry) || !/^cxexam\.exe$/iu.test(entry.name)) continue;

      const normalizedPath = normalizeWindowsPath(entryPath);
      const key = pathKey(normalizedPath);
      if (!key || clients.has(key)) continue;
      try {
        const machine = await peMachineReader(normalizedPath);
        if (machine == null) continue;
        clients.set(key, { path: normalizedPath, name: entry.name, machine });
      } catch {
        // Ignore inaccessible, corrupt, or non-PE candidate files.
      }
    }
  }

  for (const root of resolvedRoots || []) {
    const normalizedRoot = normalizeWindowsPath(root);
    if (normalizedRoot) await visit(normalizedRoot, 0);
  }

  return [...clients.values()].sort((left, right) => pathKey(left.path).localeCompare(pathKey(right.path)));
}

