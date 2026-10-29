export const HOST_DIAGNOSTIC_CODES = Object.freeze([
  'host-started', 'client-started', 'endpoint-waiting', 'endpoint-ready',
  'session-connected', 'session-reconnected', 'session-retry',
  'bootstrap-ready', 'bootstrap-failed', 'bundle-ready', 'bundle-failed',
  'config-updated', 'config-failed', 'page-error', 'top-navigated'
]);

const codes = new Set(HOST_DIAGNOSTIC_CODES);
const levels = new Set(['info', 'warn', 'error']);

export function createHostDiagnostics({ clock = () => performance.now(), onChange = () => {} } = {}) {
  const entries = [];
  const startedAt = clock();
  let sequence = 0;
  let elapsedMs = 0;
  return {
    record(code, level = 'info') {
      if (!codes.has(code) || !levels.has(level)) return false;
      const elapsed = Math.floor(clock() - startedAt);
      if (Number.isSafeInteger(elapsed) && elapsed >= elapsedMs) elapsedMs = elapsed;
      entries.push({ sequence: ++sequence, elapsedMs, level, code });
      if (entries.length > 100) entries.shift();
      try { onChange(); } catch { /* Diagnostics never interrupts the host. */ }
      return true;
    },
    snapshot() {
      return entries.map((entry) => ({ ...entry }));
    }
  };
}
