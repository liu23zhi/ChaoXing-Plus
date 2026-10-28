import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const connectionStates = new Set([
  'CLOSED', 'SYN_SENT', 'SYN_RECEIVED', 'ESTABLISHED', 'FIN_WAIT_1',
  'FIN_WAIT_2', 'CLOSE_WAIT', 'CLOSING', 'LAST_ACK', 'TIME_WAIT', 'DELETE_TCB'
]);

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
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
  if (!validPort(port) || platform !== 'win32' || typeof systemRoot !== 'string'
    || !/^[a-z]:[\\/]/iu.test(systemRoot)) return null;
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
