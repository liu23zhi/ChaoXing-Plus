import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const PROCESS_QUERY_LIMIT = 256 * 1024;
const PROCESS_QUERY_TIMEOUT_MS = 15000;
const DEFAULT_CHAIN_DEPTH = 8;
const DEFAULT_CHAIN_CACHE = 32;
const DEFAULT_FAILURE_CACHE_MS = 30000;
const MAX_CHAIN_DEPTH = 8;
const connectionStates = new Set([
  'CLOSED', 'SYN_SENT', 'SYN_RECEIVED', 'ESTABLISHED', 'FIN_WAIT_1',
  'FIN_WAIT_2', 'CLOSE_WAIT', 'CLOSING', 'LAST_ACK', 'TIME_WAIT', 'DELETE_TCB'
]);

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff;
}

function validSystemRoot(systemRoot) {
  return typeof systemRoot === 'string' && /^[a-z]:[\\/]/iu.test(systemRoot);
}

export function parseNetstatListenerOwner(output, port) {
  if (!validPort(port) || typeof output !== 'string' || output.length > OUTPUT_LIMIT) return null;
  const endpoint = `127.0.0.1:${port}`;
  let owner = null;
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields[1] !== endpoint) continue;
    if (fields.length !== 5 || fields[0] !== 'TCP') return null;
    if (fields[3] !== 'LISTENING') {
      if (!connectionStates.has(fields[3])) return null;
      continue;
    }
    const pid = Number(fields[4]);
    if (owner !== null || fields[2] !== '0.0.0.0:0' || !/^[1-9]\d*$/u.test(fields[4])
      || !Number.isInteger(pid) || pid > 0xffffffff) return null;
    owner = pid;
  }
  return owner;
}

export async function getListenerOwnerPid(port, {
  execFileImpl = execFileAsync,
  platform = process.platform,
  systemRoot = process.env.SystemRoot || process.env.windir
} = {}) {
  if (!validPort(port) || platform !== 'win32' || !validSystemRoot(systemRoot)) return null;
  try {
    // Use the Windows binary directly; never launch a shell or reuse an earlier PID.
    const executable = path.win32.join(systemRoot, 'System32', 'netstat.exe');
    const { stdout, stderr } = await execFileImpl(executable, ['-ano', '-p', 'tcp'], {
      timeout: 5000, windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: OUTPUT_LIMIT
    });
    if (stderr) return null;
    return parseNetstatListenerOwner(stdout, port);
  } catch {
    return null;
  }
}

// Parse the fixed "pid|parentPid|creationFileTimeUtc" chain emitted by the
// PowerShell process query. The chain starts at startPid and walks ancestors.
export function parseProcessParentChain(output, startPid) {
  if (!validPid(startPid) || typeof output !== 'string' || output.length > PROCESS_QUERY_LIMIT) return null;
  const chain = [];
  let rootSeen = false;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (rootSeen) return null;
    const fields = line.split('|');
    if (fields.length !== 3) return null;
    const [pidField, parentField, creationField] = fields;
    if (!/^\d+$/u.test(pidField) || !/^\d+$/u.test(parentField) || !/^\d{1,19}$/u.test(creationField)) return null;
    const pid = Number(pidField);
    const parentPid = Number(parentField);
    // Windows FILETIME values exceed Number.MAX_SAFE_INTEGER; ordering at the
    // recorded resolution stays reliable, so keep a bounded numeric value.
    const creation = Number(creationField);
    if (!validPid(pid) || !Number.isInteger(parentPid) || parentPid < 0 || parentPid > 0xffffffff) return null;
    if (!Number.isFinite(creation) || creation < 0) return null;
    if (chain.length === 0 && pid !== startPid) return null;
    if (chain.length > 0 && pid !== chain[chain.length - 1].parentPid) return null;
    chain.push({ pid, parentPid, creation });
    if (chain.length > MAX_CHAIN_DEPTH + 1) return null;
    if (parentPid === 0) rootSeen = true;
  }
  return chain.length ? chain : null;
}

// Read the bounded ancestor chain for one PID. Get-CimInstance returns the
// recorded parent PID and creation time; the creation time protects against
// PID reuse. Any query failure fails closed.
export async function getProcessParentChain(pid, {
  execFileImpl = execFileAsync,
  platform = process.platform,
  systemRoot = process.env.SystemRoot || process.env.windir,
  maxDepth = DEFAULT_CHAIN_DEPTH
} = {}) {
  if (!validPid(pid) || platform !== 'win32' || !validSystemRoot(systemRoot)
    || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_CHAIN_DEPTH) return null;
  const script = `$chain = @(); $current = ${pid}; for ($index = 0; $index -lt ${maxDepth + 1}; $index++) { $item = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue; if (-not $item) { break }; $created = 0; try { $created = [int64]$item.CreationDate.ToFileTimeUtc() } catch { }; $chain += ('{0}|{1}|{2}' -f [int64]$item.ProcessId, [int64]$item.ParentProcessId, $created); if ([int64]$item.ParentProcessId -le 0) { break }; $current = [int64]$item.ParentProcessId }; $chain -join [Environment]::NewLine`;
  try {
    const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // WMI process queries take several seconds on some machines; this runs at
    // most once per listener PID and never for the common direct-PID case.
    const { stdout, stderr } = await execFileImpl(executable, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], {
      timeout: PROCESS_QUERY_TIMEOUT_MS, windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: PROCESS_QUERY_LIMIT
    });
    if (stderr) return null;
    return parseProcessParentChain(stdout, pid);
  } catch {
    return null;
  }
}

// Decide whether a listener PID is the launched client or one of its
// descendants. Results are cached per (listener, client) pair because the
// process tree is immutable after creation; each distinct listener PID costs at
// most one PowerShell query, while the common direct-PID case costs none.
export function createListenerOwnershipVerifier({
  queryParentChain = getProcessParentChain,
  maxChainDepth = DEFAULT_CHAIN_DEPTH,
  cacheLimit = DEFAULT_CHAIN_CACHE,
  failureCacheMs = DEFAULT_FAILURE_CACHE_MS,
  now = Date.now
} = {}) {
  const depthLimit = Number.isInteger(maxChainDepth) && maxChainDepth >= 1 && maxChainDepth <= MAX_CHAIN_DEPTH
    ? maxChainDepth : DEFAULT_CHAIN_DEPTH;
  const limit = Number.isInteger(cacheLimit) && cacheLimit >= 1 && cacheLimit <= 256
    ? cacheLimit : DEFAULT_CHAIN_CACHE;
  const failureTtl = Number.isInteger(failureCacheMs) && failureCacheMs >= 0 && failureCacheMs <= 600000
    ? failureCacheMs : DEFAULT_FAILURE_CACHE_MS;
  const clock = typeof now === 'function' ? now : Date.now;
  const cache = new Map();
  async function evaluate(ownerPid, clientPid) {
    if (ownerPid === clientPid) return { verified: true, reason: 'direct', depth: 0 };
    let chain;
    try {
      chain = await queryParentChain(ownerPid, { maxDepth: depthLimit });
    } catch {
      return { verified: false, reason: 'process-query-failed', depth: -1 };
    }
    if (!Array.isArray(chain) || chain.length === 0 || !chain[0] || chain[0].pid !== ownerPid) {
      return { verified: false, reason: 'process-query-unavailable', depth: -1 };
    }
    if (chain.length > depthLimit + 1) return { verified: false, reason: 'chain-too-deep', depth: -1 };
    let previous = chain[0];
    for (let index = 1; index < chain.length; index += 1) {
      const item = chain[index];
      if (!item || !validPid(item.pid) || item.pid !== previous.parentPid) {
        return { verified: false, reason: 'broken-chain', depth: -1 };
      }
      // A parent process is created before its child; a newer parent means the
      // recorded PID was reused and the chain cannot be trusted.
      if (previous.creation > 0 && item.creation > 0 && item.creation > previous.creation) {
        return { verified: false, reason: 'invalid-creation-order', depth: -1 };
      }
      if (item.pid === clientPid) {
        return { verified: true, reason: index === 1 ? 'child' : 'descendant', depth: index };
      }
      previous = item;
    }
    return { verified: false, reason: 'not-descendant', depth: -1 };
  }
  return {
    async verify(ownerPid, clientPid) {
      if (!validPid(ownerPid)) return { verified: false, reason: 'unknown-owner', depth: -1 };
      if (!validPid(clientPid)) return { verified: false, reason: 'unknown-client', depth: -1 };
      if (ownerPid === clientPid) return { verified: true, reason: 'direct', depth: 0 };
      const key = `${ownerPid}:${clientPid}`;
      const cached = cache.get(key);
      const timestamp = clock();
      // Verified chains never change; failures are retried after a short TTL so
      // a transient WMI delay cannot permanently reject a valid listener.
      if (cached && (cached.result.verified || timestamp - cached.at <= failureTtl)) return cached.result;
      const result = await evaluate(ownerPid, clientPid);
      cache.set(key, { result, at: timestamp });
      if (cache.size > limit) cache.delete(cache.keys().next().value);
      return result;
    },
    clearCache() {
      cache.clear();
    }
  };
}
