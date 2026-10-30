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
    'separate settings never replace the common configuration',
    'invalid JSON keeps the settings dialog open',
    'online extension retrieval runs on a worker thread',
    'HTTP download failure never starts a browser',
    'closing intention survives a failed download and finishes shutdown',
    'shutdown closes and destroys every owned browser session',
    'exam page receives a private options copy with the current shared settings',
    'the complete home page exits after asynchronous cleanup'
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
