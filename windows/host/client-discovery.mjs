import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { readPeMachine } from './launch.mjs';

const windowsPath = path.win32;
const execFileAsync = promisify(execFile);

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

// Common locations include the root itself and one direct child directory.
// Full-disk fallback callers can opt into an unbounded traversal explicitly.
export const COMMON_SCAN_MAX_DEPTH = 1;
export const FULL_SCAN_MAX_DEPTH = Number.MAX_SAFE_INTEGER;

export function findPreferredClientIndex(candidates) {
  return Array.isArray(candidates) ? candidates.findIndex((candidate) => candidate?.machine === 0x014c) : -1;
}

export function isCxExamExecutablePath(value) {
  return windowsPath.basename(String(value || '').replace(/\//gu, '\\')).toLowerCase() === 'cxexam.exe';
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

function comparePaths(left, right) {
  const a = pathKey(left);
  const b = pathKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
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

async function getFixedDriveLetters() {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' | ForEach-Object { $_.DeviceID.Substring(0, 1) }"
    ], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 });
    const letters = String(stdout).split(/\r?\n/u).map((value) => value.trim().toUpperCase()).filter((value) => /^[A-Z]$/u.test(value));
    if (letters.length > 0) return [...new Set(letters)];
  } catch {
    // Try WMIC next for older Windows PowerShell installations.
  }
  try {
    const { stdout } = await execFileAsync('wmic.exe', [
      'logicaldisk',
      'where',
      'DriveType=3',
      'get',
      'DeviceID',
      '/value'
    ], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 });
    const letters = Array.from(String(stdout).matchAll(/DeviceID\s*=\s*([A-Z]):/giu), (match) => match[1].toUpperCase());
    if (letters.length > 0) return [...new Set(letters)];
  } catch {
    // Keep common-path scanning available if both Windows drive queries fail.
  }
  const systemDrive = String(process.env.SystemDrive || '').replace(/[:\\/]/gu, '').toUpperCase();
  return /^[A-Z]$/u.test(systemDrive) ? [systemDrive] : [];
}

export async function getDefaultDiscoveryRoots({
  env = process.env,
  fsProvider = fs,
  driveLetters,
  includeDriveRoots = true
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
  if (includeDriveRoots) {
    const resolvedDriveLetters = driveLetters || await getFixedDriveLetters();
    for (const letter of resolvedDriveLetters) {
      const value = String(letter || '').replace(/[:\\/]/gu, '').toUpperCase();
      if (/^[A-Z]$/u.test(value)) driveRoots.add(`${value}:\\`);
    }
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

export async function getDefaultDriveRoots({
  env = process.env,
  fsProvider = fs,
  driveLetters
} = {}) {
  const roots = new Set();
  const resolvedDriveLetters = driveLetters || await getFixedDriveLetters();
  for (const letter of resolvedDriveLetters) {
    const value = String(letter || '').replace(/[:\\/]/gu, '').toUpperCase();
    if (/^[A-Z]$/u.test(value)) roots.add(`${value}:\\`);
  }
  const existing = [];
  for (const root of roots) {
    if (await isExistingDirectory(root, fsProvider)) existing.push(root);
  }
  return existing.sort(comparePaths);
}

export async function discoverClientExecutables({
  roots,
  rootProvider = getDefaultDiscoveryRoots,
  fsProvider = fs,
  peMachineReader = readPeMachine,
  maxDepth,
  scanMode = 'common',
  stopOnMachine,
  preserveOrder = false,
  skipDirectoryNames = DEFAULT_SKIP_DIRECTORY_NAMES
} = {}) {
  const resolvedRoots = roots === undefined ? await rootProvider({ fsProvider }) : roots;
  const requestedDepth = maxDepth === undefined
    ? (scanMode === 'all' || scanMode === 'full' || scanMode === 'fallback-all'
      ? FULL_SCAN_MAX_DEPTH
      : COMMON_SCAN_MAX_DEPTH)
    : maxDepth;
  const depthLimit = Number.isFinite(requestedDepth)
    ? Math.max(0, Math.floor(requestedDepth))
    : FULL_SCAN_MAX_DEPTH;
  const preferredMachine = Number.isInteger(stopOnMachine) ? stopOnMachine : null;
  const skippedNames = new Set(Array.from(skipDirectoryNames || [], (name) => String(name).toLowerCase()));
  const visited = new Set();
  const clients = new Map();
  let stopped = false;

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

    const orderedEntries = entries.slice().sort((left, right) => {
      const a = String(left?.name || '').toLowerCase();
      const b = String(right?.name || '').toLowerCase();
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const files = orderedEntries.filter((entry) => !isDirectory(entry));
    const directories = orderedEntries.filter((entry) => isDirectory(entry));

    for (const entry of files) {
      if (stopped) return;
      if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
      const entryPath = windowsPath.join(normalizedDirectory, entry.name);
      if (isSymbolicLink(entry)) continue;
      if (!isFile(entry) || !/^cxexam\.exe$/iu.test(entry.name)) continue;

      const normalizedPath = normalizeWindowsPath(entryPath);
      const key = pathKey(normalizedPath);
      if (!key || clients.has(key)) continue;
      try {
        const machine = await peMachineReader(normalizedPath);
        if (machine !== 0x014c && machine !== 0x8664) continue;
        clients.set(key, { path: normalizedPath, name: entry.name, machine });
        if (preferredMachine !== null && machine === preferredMachine) {
          stopped = true;
          return;
        }
      } catch {
        // Ignore inaccessible, corrupt, or non-PE candidate files.
      }
    }

    for (const entry of directories) {
      if (stopped) return;
      if (!entry || typeof entry.name !== 'string' || !entry.name) continue;
      if (depth < depthLimit && !isSymbolicLink(entry) && !skippedNames.has(entry.name.toLowerCase())) {
        await visit(windowsPath.join(normalizedDirectory, entry.name), depth + 1);
      }
    }
  }

  for (const root of resolvedRoots || []) {
    if (stopped) break;
    const normalizedRoot = normalizeWindowsPath(root);
    if (normalizedRoot) await visit(normalizedRoot, 0);
  }

  const result = [...clients.values()];
  return preserveOrder
    ? result
    : result.sort((left, right) => comparePaths(left.path, right.path));
}

export async function discoverClientCandidates({
  scanMode = 'fallback-all',
  commonRootProvider = (options) => getDefaultDiscoveryRoots({ ...options, includeDriveRoots: false }),
  driveRootProvider = getDefaultDriveRoots,
  fsProvider = fs,
  peMachineReader = readPeMachine,
  stopOnMachine = 0x014c,
  onFullScan = () => {}
} = {}) {
  if (scanMode === 'all') {
    const driveRoots = await driveRootProvider({ fsProvider });
    onFullScan();
    const candidates = await discoverClientExecutables({
      roots: driveRoots,
      scanMode: 'fallback-all',
      preserveOrder: true,
      stopOnMachine,
      fsProvider,
      peMachineReader
    });
    return { candidates, source: 'full', selected: candidates.find((item) => item.machine === 0x014c) || candidates[0] || null };
  }

  const commonRoots = await commonRootProvider({ fsProvider });
  const commonCandidates = await discoverClientExecutables({
    roots: commonRoots,
    scanMode: 'common',
    fsProvider,
    peMachineReader
  });
  const driveRoots = await driveRootProvider({ fsProvider });
  const driveCandidates = await discoverClientExecutables({
    roots: driveRoots,
    scanMode: 'common',
    fsProvider,
    peMachineReader
  });
  const commonPaths = new Set();
  const candidates = [...commonCandidates, ...driveCandidates]
    .filter((item) => {
      const key = pathKey(item.path);
      if (commonPaths.has(key)) return false;
      commonPaths.add(key);
      return true;
    })
    .sort((left, right) => comparePaths(left.path, right.path));

  if (candidates.length > 0 || scanMode === 'common') {
    const selected = candidates.find((item) => item.machine === 0x014c) || candidates[0] || null;
    return { candidates, source: 'common', selected };
  }

  onFullScan();
  const fullCandidates = await discoverClientExecutables({
    roots: driveRoots,
    scanMode: 'fallback-all',
    preserveOrder: true,
    stopOnMachine,
    fsProvider,
    peMachineReader
  });
  const selected = fullCandidates.find((item) => item.machine === 0x014c) || fullCandidates[0] || null;
  return { candidates: fullCandidates, source: 'full', selected };
}

