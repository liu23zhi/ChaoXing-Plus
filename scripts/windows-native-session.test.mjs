import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('compiled native session tracks navigation, iframe readiness and cancellation generations', {
  skip: !process.env.CX_NATIVE_SESSION_EXE
}, () => {
  const result = spawnSync(process.env.CX_NATIVE_SESSION_EXE, [], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^FAIL /mu);
  assert.match(result.stdout, /NATIVE SESSION TESTS PASS/u);
  for (const regression of [
    'ready during bootstrap acknowledgement does not reenter injection',
    'navigation cancels a real context generation',
    'detaching a frame cancels its complete context subtree',
    'frame URL overrides an otherwise permitted context origin',
    'missing context events allow top document fallback',
    'context capacity is bounded without overwriting live generations'
  ]) assert.ok(result.stdout.includes(`PASS ${regression}`), `missing compiled regression: ${regression}`);
});
