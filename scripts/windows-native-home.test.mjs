import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const executable = process.env.CX_NATIVE_HOME_EXE;

function runHome(dpi, visible = false) {
  const result = spawnSync(executable, [], {
    encoding: 'utf8', timeout: 25_000, windowsHide: true,
    env: {
      ...process.env,
      CXPLUS_NATIVE_UI_DPI: String(dpi),
      CX_TEST_NATIVE_WINDOW: visible ? '1' : '0'
    }
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^FAIL /mu);
  assert.match(result.stdout, /NATIVE HOME TESTS PASS/u);
  for (const expected of [
    'the actual home page creates every workflow control',
    'home window and class use the embedded application icon',
    'home controls scale from the active DPI',
    'settings merge preserves shared values and applies allowed overrides',
    'settings exclude question caches and unknown namespaces',
    'native form emits panel settings as valid shared settings',
    'native form emits answer and logging settings as valid shared settings',
    'settings dialog omits the advanced JSON editor and local CRX input',
    'separate settings never replace the common configuration',
    'online extension retrieval runs on a worker thread',
    'combined browser selection prefers Edge when both browsers are installed',
    'combined browser selection falls back to Chrome when Edge is unavailable',
    'combined browser selection reports when neither supported browser is installed',
    'an invalid cached extension is refreshed online once and verified again',
    'extension cache uses the data directory and obeys no-disk-write',
    'manual extension update bypasses the local cache',
    'HTTP download failure never starts a browser',
    'close selected session closes and destroys the automatically selected browser',
    'closed browser session is removed from the home list',
    'closing the selected first session selects the next remaining session',
    'consecutive close actions close and remove every selected session',
    'closing intention survives a failed download and finishes shutdown',
    'shutdown closes and destroys every owned browser session',
    'exam page receives a private options copy with the current shared settings',
    'multi-browser homepage has no script URL or PowerShell input',
    'entering the exam page exposes its optional script input without launching',
    'empty script URL dispatches the real local exam callback',
    'no-address startup reaches the exam callback without a script lease',
    'direct exam testing never registers a multi-browser device',
    'URL or PowerShell startup resolves a script and automatically starts the exam workflow',
    'resolved script input reaches the exam callback with the real in-memory lease and special token',
    'cross-origin grant or denied script never starts an exam or creates a lease',
    'silent URL and PowerShell redemption acquires a private script grant without a home window',
    'silent redemption preserves script parameters and private authentication in runtime options',
    'silent rejected redemption leaves credentials unchanged and cannot become an unauthorized launch',
    'silent redemption preserves the server denial reason',
    'silent redemption creates zero actual Win32 controls or home windows',
    'synthetic successful exchange captures a private exam grant',
    'home form settings update the typed host options used by the exam runtime',
    'home settings serialize host-managed keys exactly once',
    // 设备槽位（141 §5/§8 / R5–R8）
    'device storage key literal is common.settings.device-id',
    'client instance storage key literal is common.settings.device-instance',
    'device keys are absent while no browser session is being built',
    'browser session settings carry the host device id and this session instance',
    'each browser session gets its own client instance',
    'session client instance is a well formed uuid v4',
    'turning the injection context off removes the device keys again',
    'starting a session reports count=1 with the host device id',
    'closing the last session reports count=0',
    'a session exiting on its own reports the remaining session count',
    'exiting with three open sessions reports count=0 (falls back to the host slot)',
    'a failed session-count report never blocks closing the browser',
    'the failed report was actually attempted',
    'status shows available/limit and the host occupies one slot when no session is open',
    'status shows three occupied slots for three browser sessions',
    'status renders 不限 instead of numbers when the limit is unlimited',
    'status reports 无法获取设备配额 when the quota was never fetched',
    'over-limit still starts a browser session on New Session (R8: remind, never block)',
    'the over-limit reminder is shown exactly once per click',
    'a missing config file gets a freshly generated device id',
    'the generated device id is written back to the configuration file (C4-1)',
    'a second start reuses the persisted device id instead of regenerating it',
    '--no-disk-write keeps the device id in memory and never creates the config file',
    'an existing config without a device id gets one injected',
    'injecting the device id preserves every other key in the config file',
    'the complete home page exits after asynchronous cleanup',
    'script activation uses a fresh 32 byte cryptographic hexadecimal identity',
    'activated sessions replace consumed tickets in memory and force no disk writes',
    'a failed script lease closes every owned browser through normal cleanup',
    'shutdown joins and clears the script heartbeat worker'
  ]) assert.ok(result.stdout.includes(`PASS ${expected}`), result.stdout);
}

for (const dpi of [96, 192]) {
  test(`native home uses real controls, isolated settings and joined workers at ${dpi} DPI`, {
    skip: !executable,
    timeout: 30_000
  }, () => runHome(dpi));
}

test('native home and settings dialogs display and close without launching a client', {
  skip: !executable || process.env.CX_TEST_NATIVE_WINDOW !== '1',
  timeout: 30_000
}, () => runHome(192, true));
