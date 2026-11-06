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
    'rejected nested capability leaves previously merged options unchanged',
    'CEF75 launch port range rejects reserved and excluded values',
    'attach retains generic TCP port limits',
    'CLI valid launch port overrides lower unsupported JSON port',
    'elevate-on-start CLI survives layered merging',
    'higher JSON can disable early elevation',
    'CLI early elevation overrides configured false',
    'early elevation conflicts with no-elevate',
    'configured early elevation conflicts with CLI no-elevate',
    'early elevation JSON requires a boolean',
    'native F1 through F24 shortcuts remain accepted',
    'native function shortcuts reject leading zeroes and out-of-range keys'
  ]) {
    assert.ok(result.stdout.includes(`PASS ${regression}`), `missing compiled regression: ${regression}`);
  }
});

const restrictedConfigurations = [
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

test('compiled native memory execution mode is supported and forces zero-disk-write', {
  skip: !host
}, () => {
  for (const args of [
    ['--execution-mode', 'memory', '--print-effective-config'],
    ['--memory-exec', '--print-effective-config'],
    ['--options-json', '{"executionMode":"memory"}', '--print-effective-config'],
    ['--options-json', '{"memoryExec":true}', '--print-effective-config']
  ]) {
    const result = invoke(...args);
    assert.equal(result.status, 0, JSON.stringify(args) + ': ' + result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout)['common.settings.windows-no-disk-write'], true,
      'memory execution must imply host-side zero-disk-write');
  }
  const capabilities = invoke('--memory-exec', '--capabilities');
  assert.equal(capabilities.status, 0, capabilities.stdout + capabilities.stderr);
  const parsed = JSON.parse(capabilities.stdout);
  assert.equal(parsed.executionMode, 'memory');
  assert.deepEqual(parsed.executionModes, ['normal', 'memory', 'delete-suspend']);
  assert.equal(parsed.memory, true);
  const suspend = invoke('--execution-mode', 'delete-suspend', '--capabilities');
  assert.equal(suspend.status, 0, suspend.stdout + suspend.stderr);
  assert.equal(JSON.parse(suspend.stdout).executionMode, 'delete-suspend');
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

test('compiled native direction shortcuts accept canonical browser keys and legacy aliases', {
  skip: !host
}, () => {
  for (const direction of ['Up', 'Down', 'Left', 'Right']) {
    for (const key of [direction, `Arrow${direction}`]) {
      const shortcut = `Ctrl+${key}`;
      for (const args of [['--answer-key', shortcut], ['--options-json', JSON.stringify({ answerKey: shortcut })]]) {
        const result = invoke(...args);
        assert.equal(result.status, 0, `${JSON.stringify(args)}: ${result.stdout}${result.stderr}`);
        assert.equal(JSON.parse(result.stdout)['common.settings.windows-answer-key'], shortcut);
      }
    }
  }
});

test('compiled native CEF75 launch port limits apply to CLI and JSON without limiting attach', {
  skip: !host
}, () => {
  for (const port of [0, 1024, 9333, 65534, 1, 1023, 65535]) {
    const expected = port === 0 || (port >= 1024 && port <= 65534) ? 0 : 2;
    for (const args of [['--port', String(port)], ['--options-json', JSON.stringify({ port })]]) {
      const result = invoke(...args);
      assert.equal(result.status, expected, `${JSON.stringify(args)}: ${result.stdout}${result.stderr}`);
      if (expected) assert.match(result.stdout, /1024.*65534/u);
    }
  }
  for (const port of [1, 1023, 65535]) {
    const result = invoke('--attach', String(port));
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.equal(invoke('--options-json', '{"port":1023}', '--port', '9333').status, 0);
});

test('compiled native answer shortcuts reject keys the exam client keyboard hook swallows', {
  skip: !host
}, () => {
  // CXExam.exe 装了会话级 WH_KEYBOARD_LL 钩子（IG5: FUN_004774b0）：这些组合在按键到达任何窗口
  // 之前就被吞掉，配成答题键等于"按了没反应"。
  for (const key of ['Escape', 'Ctrl+Escape', 'Alt+Escape', 'Ctrl+W', 'Ctrl+Shift+W', 'Alt+Tab', 'Ctrl+Alt+Tab', 'Alt+Space', 'Alt+F5', 'Alt+F24', 'Win+S']) {
    for (const args of [['--answer-key', key], ['--options-json', JSON.stringify({ answerKey: key })]]) {
      const result = invoke(...args);
      assert.equal(result.status, 2, `${JSON.stringify(args)} 必须被拒绝: ${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /swallowed by the exam client keyboard hook/u);
    }
  }
  // 钩子只吞 Ctrl+W / Alt+Tab / Alt+Space / Alt+F1-F24 / Win 组合与 Esc，其余组合必须继续可用。
  for (const key of ['F8', 'Ctrl+Shift+A', 'Ctrl+Alt+Shift+S', 'Ctrl+Tab', 'Shift+W', 'Ctrl+F8']) {
    const result = invoke('--answer-key', key);
    assert.equal(result.status, 0, `${key} 必须仍然可用: ${result.stdout}${result.stderr}`);
  }
  const settings = invoke('--options-json', JSON.stringify({ settings: { 'common.settings.windows-answer-key': 'Alt+Tab' } }));
  assert.equal(settings.status, 2, '共享设置里的答题键同样要拒绝');
  const destruct = invoke('--self-destruct-key', 'Ctrl+W');
  assert.equal(destruct.status, 2, '自毁键也不能用被吞掉的组合');
  assert.match(`${destruct.stdout}${destruct.stderr}`, /self-destruct-key is swallowed/u);
});

test('compiled native function shortcuts reject leading zeros without losing F1 through F24', {
  skip: !host
}, () => {
  for (const key of ['F1', 'F8', 'F24', 'F01', 'F08', 'F00000008', 'F25']) {
    const expected = ['F1', 'F8', 'F24'].includes(key) ? 0 : 2;
    for (const args of [['--answer-key', key], ['--options-json', JSON.stringify({ answerKey: key })]]) {
      const result = invoke(...args);
      assert.equal(result.status, expected, `${JSON.stringify(args)}: ${result.stdout}${result.stderr}`);
    }
  }
});
