import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const pinned = '56acb76dc6a92b875abf26781bfab44e787a3880';
const joint = 'TestChaoXingThreeModeHTTP';
const quota = 'TestNativeHostReportedSessionsUseThreeThenOneSlot';
const client = fileURLToPath(new URL('../../', import.meta.url));

// CI supplies a public checkout at the pinned revision. Archive only tracked Go
// sources, never a local database, untracked file, compiled server, or .git/config.
test('extension and host send three modes to the pinned TiKuHelper HTTP/store; host quota follows 3 → 1', async t => {
  assert.ok(process.env.TIKUHELPER_ROOT, 'Set TIKUHELPER_ROOT to the pinned TiKuHelper checkout');
  const checkout = resolve(process.env.TIKUHELPER_ROOT);
  const head = await run('git', ['-C', checkout, 'rev-parse', 'HEAD']);
  assert.equal(head.stdout.trim(), pinned, 'unexpected TiKuHelper checkout');
  const dir = await mkdtemp(join(tmpdir(), 'cx-three-mode-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tar = join(dir, 'service.tar');
  await run('git', ['-C', checkout, 'archive', '--format=tar', '-o', tar, pinned,
    'go.mod', 'go.sum', 'configs/config.go', 'internal', 'pkg']);
  await run('tar', ['-xf', tar, '-C', dir]);
  await copyFile(new URL('./three-mode-contract.fixture.go', import.meta.url),
    join(dir, 'internal', 'controller', 'chaoxing_three_mode_external_test.go'));

  const expected = [joint, quota];
  const args = ['test', '-json', '-mod=readonly', '-count=1', '-timeout=2m', '-run',
    '^(' + expected.join('|') + ')$', './internal/controller', './internal/service'];
  const buildEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'GOCACHE', 'GOMODCACHE', 'GOPATH', 'GOROOT', 'GOTOOLCHAIN']
    .filter(k => process.env[k]).map(k => [k, process.env[k]]));
  let result;
  try {
    result = await run('go', args, {
      cwd: dir, maxBuffer: 16 << 20, timeout: 12 * 60_000,
      env: { ...buildEnv, GOENV: 'off', GOWORK: 'off', CX_CONTRACT_NODE: process.execPath, CX_CONTRACT_CLIENT: client },
    });
  } catch (err) {
    // Decode Go's test stream so CI shows the failing check rather than a buried JSON escape.
    const log = String(err.stdout ?? '').split('\n').flatMap(line => {
      try { const e = JSON.parse(line); return e.Output ?? []; } catch { return line; }
    }).join('').slice(-14000);
    throw new Error('Pinned service contract failed (' + (err.code ?? err.signal) + '):\n' + log + '\n' + (err.stderr ?? ''));
  }
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(e => e.Action === 'pass' && e.Test).map(e => e.Test).sort(), expected.sort(),
    'both named Go tests must actually run and pass; no match or skip is not success');
  for (const e of events.filter(e => e.Test === joint && e.Output?.includes('CONTRACT:'))) {
    t.diagnostic(e.Output.slice(e.Output.indexOf('CONTRACT:')).trim());
  }
  t.diagnostic(quota + ': PASS (unbound host rejected; reported 3, 3, 0 → occupied 3, 3, 1)');
});
