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
export const CLIENT_SCAN_CACHE_VERSION = 2;
export const DEFAULT_CLIENT_SCAN_CACHE_TTL_MS = 5 * 60 * 1000;

export function findPreferredClientIndex(candidates) {
  return Array.isArray(candidates) ? candidates.findIndex((candidate) => candidate?.machine === 0x014c) : -1;
}

export function isCxExamExecutablePath(value) {
  return windowsPath.basename(String(value || '').replace(/\//gu, '\\')).toLowerCase() === 'cxexam.exe';
}

/**
 * Resolve an explicit client target. A target may be CXExam.exe itself or an
 * installation directory containing CXExam.exe at its root/first child level.
 */
export async function resolveExplicitClientPath(value, {
  fsProvider = fs,
  peMachineReader = readPeMachine
} = {}) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (isCxExamExecutablePath(input)) return input;
  let stat;
  try {
    stat = await fsProvider.stat(input);
  } catch {
    return input;
  }
  const isDir = typeof stat?.isDirectory === 'function' ? stat.isDirectory() : stat?.directory === true;
  if (!isDir) return input;
  const candidates = [];
  const addCandidate = async (candidatePath, name) => {
    if (!isCxExamExecutablePath(name)) return;
    try {
      const candidateStat = typeof fsProvider.lstat === 'function'
        ? await fsProvider.lstat(candidatePath)
        : await fsProvider.stat(candidatePath);
      if (typeof candidateStat?.isSymbolicLink === 'function' && candidateStat.isSymbolicLink()) return;
      if (typeof candidateStat?.isFile === 'function' && !candidateStat.isFile()) return;
      const machine = await peMachineReader(candidatePath);
      if (machine === 0x014c || machine === 0x8664) candidates.push({ path: candidatePath, name, machine });
    } catch {
      // Ignore inaccessible or invalid candidates and let the caller report no match.
    }
  };
  await addCandidate(path.join(input, 'CXExam.exe'), 'CXExam.exe');
  let entries = [];
  try {
    entries = await fsProvider.readdir(input, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const children = entries.slice().sort((left, right) => String(left?.name || '').toLowerCase().localeCompare(String(right?.name || '').toLowerCase()));
  for (const entry of children) {
    if (!entry || typeof entry.name !== 'string' || isSymbolicLink(entry)) continue;
    if (!isDirectory(entry)) continue;
    await addCandidate(path.join(input, entry.name, 'CXExam.exe'), 'CXExam.exe');
  }
  candidates.sort((left, right) => {
    if (left.machine !== right.machine) return left.machine === 0x014c ? -1 : 1;
    return comparePaths(left.path, right.path);
  });
  return candidates[0]?.path || '';
}

function normalizeCachedCandidate(value) {
  if (!value || typeof value !== 'object' || typeof value.path !== 'string' || !isCxExamExecutablePath(value.path)) return null;
  const machine = Number(value.machine);
  if (machine !== 0x014c && machine !== 0x8664) return null;
  const normalizedPath = normalizeWindowsPath(value.path);
  if (!normalizedPath) return null;
  return { path: normalizedPath, name: path.win32.basename(normalizedPath), machine };
}

function createClientScanScope(scanMode, commonRoots, driveRoots) {
  return {
    commonRoots: scanMode === 'all' ? [] : Array.from(commonRoots || [], pathKey),
    driveRoots: Array.from(driveRoots || [], pathKey),
    commonMaxDepth: COMMON_SCAN_MAX_DEPTH,
    fullMaxDepth: FULL_SCAN_MAX_DEPTH,
    skippedDirectories: Array.from(DEFAULT_SKIP_DIRECTORY_NAMES, (name) => String(name).toLowerCase()).sort()
  };
}

async function readClientScanCache(cachePath, { scanMode, scope, fsProvider, peMachineReader, cacheFs = fs, cacheTtlMs = DEFAULT_CLIENT_SCAN_CACHE_TTL_MS } = {}) {
  if (!cachePath || !cacheFs || typeof cacheFs.readFile !== 'function') return null;
  let parsed;
  try {
    const text = await cacheFs.readFile(cachePath, 'utf8');
    parsed = JSON.parse(String(text).replace(/^\uFEFF/u, ''));
  } catch {
    return null;
  }
  if (!parsed || parsed.version !== CLIENT_SCAN_CACHE_VERSION || parsed.scanMode !== scanMode) return null;
  if (JSON.stringify(parsed.scope) !== JSON.stringify(scope) || parsed.complete !== true) return null;
  if (parsed.source !== 'common' && parsed.source !== 'full') return null;
  if (scanMode === 'all' && parsed.source !== 'full') return null;
  if (scanMode === 'common' && parsed.source !== 'common') return null;
  if (!Number.isFinite(parsed.createdAt) || Date.now() - parsed.createdAt > cacheTtlMs || Date.now() - parsed.createdAt < 0) return null;
  if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) return null;

  const candidates = [];
  for (const raw of parsed.candidates) {
    const candidate = normalizeCachedCandidate(raw);
    if (!candidate) return null;
    try {
      const stat = typeof fsProvider.lstat === 'function'
        ? await fsProvider.lstat(candidate.path)
        : await fsProvider.stat(candidate.path);
      if (typeof stat?.isSymbolicLink === 'function' && stat.isSymbolicLink()) return null;
      if (typeof stat?.isFile === 'function' && !stat.isFile()) return null;
      const machine = await peMachineReader(candidate.path);
      if (machine !== candidate.machine || (machine !== 0x014c && machine !== 0x8664)) return null;
    } catch {
      return null;
    }
    candidates.push(candidate);
  }
  const unique = new Map(candidates.map((candidate) => [pathKey(candidate.path), candidate]));
  const result = [...unique.values()];
  return parsed.source === 'full' ? result : result.sort(compareCommonCandidates);
}

async function writeClientScanCache(cachePath, { scanMode, scope, source, complete, candidates, cacheFs = fs } = {}) {
  if (!cachePath || !cacheFs || typeof cacheFs.writeFile !== 'function' || typeof cacheFs.mkdir !== 'function') return;
  const directory = path.dirname(cachePath);
  const payload = {
    version: CLIENT_SCAN_CACHE_VERSION,
    createdAt: Date.now(),
    scanMode,
    scope,
    source,
    complete: complete === true,
    candidates: candidates.map(({ path: candidatePath, name, machine }) => ({ path: candidatePath, name, machine }))
  };
  await cacheFs.mkdir(directory, { recursive: true });
  await cacheFs.writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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

function compareCommonCandidates(left, right) {
  if (left.machine !== right.machine) return left.machine === 0x014c ? -1 : 1;
  return comparePaths(left.path, right.path);
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

async function getCurrentUserDesktopRoot() {
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::Out.WriteLine([Environment]::GetFolderPath('Desktop'))"
    ], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8' });
    return String(stdout || '').replace(/^\uFEFF/u, '').trim();
  } catch {
    return '';
  }
}

export async function getDefaultDiscoveryRoots({
  env = process.env,
  fsProvider = fs,
  desktopRootProvider = getCurrentUserDesktopRoot,
  driveLetters,
  includeDriveRoots = true
} = {}) {
  const profile = env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : '');
  let desktopRoot = '';
  try {
    desktopRoot = normalizeWindowsPath(await desktopRootProvider({ env, fsProvider }));
  } catch {
    // Keep conventional Desktop discovery available when the Known Folder query fails.
  }
  if (!desktopRoot || !(await isExistingDirectory(desktopRoot, fsProvider))) {
    desktopRoot = profile ? windowsPath.join(profile, 'Desktop') : '';
  }
  const candidates = [
    desktopRoot,
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
  desktopRootProvider,
  commonRootProvider = (options) => getDefaultDiscoveryRoots({ ...options, includeDriveRoots: false }),
  driveRootProvider = getDefaultDriveRoots,
  fsProvider = fs,
  peMachineReader = readPeMachine,
  stopOnMachine = 0x014c,
  onFullScan = () => {},
  cachePath = '',
  noScanCache = false,
  noDiskWrite = false,
  cacheFs = fs,
  cacheTtlMs = DEFAULT_CLIENT_SCAN_CACHE_TTL_MS,
  onCacheEvent = () => {},
  forceRescan = false
} = {}) {
  const cacheEnabled = Boolean(cachePath) && !noScanCache && !noDiskWrite;
  // Resolve the current scan range before reusing a cache from another environment.
  const commonRoots = scanMode === 'all' ? [] : await commonRootProvider({ fsProvider, desktopRootProvider });
  const driveRoots = await driveRootProvider({ fsProvider });
  const scope = createClientScanScope(scanMode, commonRoots, driveRoots);
  if (cacheEnabled && !forceRescan) {
    const cachedCandidates = await readClientScanCache(cachePath, {
      scanMode,
      scope,
      fsProvider,
      peMachineReader,
      cacheFs,
      cacheTtlMs
    });
    if (cachedCandidates) {
      onCacheEvent({ type: 'hit', path: cachePath, count: cachedCandidates.length });
      const selected = cachedCandidates.find((item) => item.machine === 0x014c) || cachedCandidates[0] || null;
      return { candidates: cachedCandidates, source: 'cache', selected };
    }
    onCacheEvent({ type: 'miss', path: cachePath });
  }
  let result;
  if (scanMode === 'all') {
    onFullScan();
    const candidates = await discoverClientExecutables({
      roots: driveRoots,
      scanMode: 'fallback-all',
      preserveOrder: true,
      stopOnMachine,
      fsProvider,
      peMachineReader
    });
    result = { candidates, source: 'full', selected: candidates.find((item) => item.machine === 0x014c) || candidates[0] || null };
  } else {
    const commonCandidates = await discoverClientExecutables({
      roots: commonRoots,
      scanMode: 'common',
      fsProvider,
      peMachineReader
    });
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
      .sort(compareCommonCandidates);

    if (candidates.length > 0 || scanMode === 'common') {
      const selected = candidates.find((item) => item.machine === 0x014c) || candidates[0] || null;
      result = { candidates, source: 'common', selected };
    } else {
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
      result = { candidates: fullCandidates, source: 'full', selected };
    }
  }
  // Every common root is fully scanned; a positive common result also completes
  // fallback-all because recursive scanning is only needed when common is empty.
  const cacheComplete = result.source === 'common' || stopOnMachine === null;
  if (cacheEnabled && result.candidates.length > 0 && (result.source !== 'full' || cacheComplete)) {
    try {
      await writeClientScanCache(cachePath, { scanMode, scope, source: result.source, complete: cacheComplete, candidates: result.candidates, cacheFs });
      onCacheEvent({ type: 'write', path: cachePath, count: result.candidates.length });
    } catch (error) {
      onCacheEvent({ type: 'write-error', path: cachePath, error });
    }
  }
  return result;
}

