import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const executable = process.env.CX_NATIVE_CONFIG_EXE;

test('compiled native configuration merges real JSON and safely patches files', { skip: !executable }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-native-config-'));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(path.resolve(executable), [], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CX_CONFIG_TEST_DIR: directory },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('native configuration self-test timed out')); }, 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /CONFIG SELF-TEST PASS/);
    assert.doesNotMatch(result.stdout, /FAIL /);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'merged.json'), 'utf8')), {
      'common.settings.a': [1, { nested: true }],
      'common.settings.keep': null,
      'cx.new.work.retry': false,
      'common.apps.question-caches': [],
    });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'selected.json'), 'utf8')), {
      'common.settings.a': 9,
      'cx.new.work.x': { z: [null] },
    });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'canonical.json'), 'utf8')), {
      'common.settings."\\\né': 1,
      'common.settings.\ud800': 2,
    });
    const persistedDirectory = path.join(directory, '配置 space', 'nested');
    const persisted = JSON.parse(await fs.readFile(path.join(persistedDirectory, 'host.json'), 'utf8'));
    assert.deepEqual(persisted, {
      clientPath: 'C:\\client.exe',
      future: { mode: [1, '中文'] },
      settings: { 'common.settings.a': 2, 'common.settings.keep': true, 'cx.new.work.retry': 3 },
    });
    assert.deepEqual((await fs.readdir(persistedDirectory)).sort(), ['host.json', 'host.json.cx-unrelated.tmp']);
    assert.equal(await fs.readFile(path.join(persistedDirectory, 'host.json.cx-unrelated.tmp'), 'utf8'), 'unrelated temporary content');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'root-duplicate.json'), 'utf8')), {
      unknown: [false],
      'settings\u00ad': 7,
      settings: { 'common.settings.last': 9, 'common.settings.a': 2 },
    });
    await assert.rejects(fs.stat(path.join(directory, 'not-created')), { code: 'ENOENT' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
