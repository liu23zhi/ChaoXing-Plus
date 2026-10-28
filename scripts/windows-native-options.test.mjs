import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const host = process.env.CX_NATIVE_HOST_EXE;
const invoke = (...args) => spawnSync(host, ['--print-effective-config', ...args], {
  encoding: 'utf8', timeout: 10_000, windowsHide: true
});

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
    'higher JSON auto preserves the original path after gui',
    'last no-diagnose CLI flag disables diagnostics',
    'last diagnose CLI flag enables diagnostics',
    'CLI no-diagnose overrides configured diagnostics',
    'higher JSON diagnose re-enables diagnostics',
    'nested unsupported JSON capability is rejected',
    'normal mode and disabled optional capabilities preserve shared settings',
    'rejected nested capability leaves previously merged options unchanged'
  ]) {
    assert.ok(result.stdout.includes(`PASS ${regression}`), `missing compiled regression: ${regression}`);
  }
});

const restrictedConfigurations = [
  '{"executionMode":"memory"}',
  '{"memoryExec":true}',
  '{"wipeOwnedFilesOnStart":false}',
  '{"selfDestructKey":"F8"}',
  '{"settings":{"common.settings.windows-execution-mode":"memory"}}',
  '{"settings":{"common.settings.windows-delete_suspend":true}}',
  '{"settings":{"COMMON.SETTINGS.WINDOWS-memory_exec":true}}',
  '{"settings":{"\\u0063ommon.settings.windows-wipe-owned-files-on-start":false}}',
  '{"settings":{"common.settings.windows-self-destruct-key":"F8"}}',
  '{"settings":{"cx.new.study.nested":[{"self_Destruct_Delay":0}]}}',
  '{"settings":{"common.settings.windows-no-self-destruct-confirm":true}}',
  '{"settings":{"common.settings.windows-memory-exec":"false"}}',
  JSON.stringify({ settings: { ['common.settings.windows-self-destruct-' + 'x'.repeat(200)]: true } })
];

test('compiled native inline and file JSON reject unavailable capabilities throughout shared settings', {
  skip: !host
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cx-native-capability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'options.json');
  for (const config of restrictedConfigurations) {
    await writeFile(file, config, 'utf8');
    for (const args of [['--options-json', config], ['--options-json', `@${file}`], ['--config', file]]) {
      const result = invoke(...args);
      assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /not supported/u);
    }
  }
});

test('compiled native ordinary JSON and disabled optional capability values remain valid', {
  skip: !host
}, () => {
  const result = invoke('--options-json', JSON.stringify({
    executionMode: 'normal',
    settings: {
      'common.settings.keep': { enabled: true },
      'common.settings.text': '{"memoryExec":true}',
      'common.settings.windows-execution-mode': 'normal',
      'common.settings.windows-memory-exec': false,
      'common.settings.windows-delete-suspend': false,
      'common.settings.windows-self-destruct-key': false
    }
  }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout)['common.settings.keep'], { enabled: true });
});
