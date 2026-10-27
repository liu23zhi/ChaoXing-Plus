import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('compiled native options honor scan aliases and layered client selection', {
  skip: !process.env.CX_NATIVE_OPTIONS_EXE
}, () => {
  const result = spawnSync(process.env.CX_NATIVE_OPTIONS_EXE, [], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^FAIL /mu);
  assert.match(result.stdout, /^RESULT PASS\r?$/mu);
  for (const regression of [
    'no-scan-all changes the actual scan mode to common',
    'CLI client-first overrides configured path',
    'same CLI layer path and rescan remain a conflict',
    'higher JSON auto preserves the original path after gui'
  ]) {
    assert.ok(result.stdout.includes(`PASS ${regression}`), `missing compiled regression: ${regression}`);
  }
});
