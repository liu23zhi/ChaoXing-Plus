import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseHostArgs } from '../windows/host/options.mjs';

const root = path.resolve('.');
const hostScript = path.join(root, 'windows', 'host', 'main.mjs');

function runHost(args) {
  return spawnSync(process.execPath, [hostScript, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, CXPLUS_NO_LOG_FILE: '1' }
  });
}

test('Node --print-effective-config 解析与帮助文本', () => {
  assert.equal(parseHostArgs([]).printEffectiveConfig, false);
  assert.equal(parseHostArgs(['--print-effective-config']).printEffectiveConfig, true);
  const help = runHost(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--print-effective-config/u);
});

test('Node --print-effective-config 输出合并后的共享设置且不扫描/不写盘', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-node-print-effective-'));
  try {
    const configPath = path.join(directory, 'chaoxing-plus.json');
    const configText = '{"settings":{"common.settings.windows-answer-threads":2,"common.settings.windows-panel-width":600}}';
    await writeFile(configPath, configText, 'utf8');
    const dataDir = path.join(directory, 'data');
    const result = runHost([
      '--print-effective-config',
      '--config', configPath,
      '--options-json', '{"answerThreads":3,"panelWidth":640}',
      '--panel-width', '520',
      '--data-dir', dataDir
    ]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/u);
    assert.equal(lines.length, 1, `stdout must contain exactly one JSON line: ${result.stdout}`);
    const settings = JSON.parse(lines[0]);
    // 优先级：默认层 < --config < --options-json < 独立 CLI 参数
    assert.equal(settings['common.settings.windows-answer-threads'], 3);
    assert.equal(settings['common.settings.windows-panel-width'], 520);
    assert.equal(settings['common.settings.windows-no-disk-write'], false);
    assert.equal(existsSync(dataDir), false, 'print mode must not create the data directory');
    assert.equal(await readFile(configPath, 'utf8'), configText, 'print mode must not rewrite the config file');
    assert.deepEqual(await readdir(directory), ['chaoxing-plus.json'], 'print mode must not create extra files');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const nativeExe = process.env.CX_NATIVE_HOST_EXE;
const nativeTest = (name, run) => test(name, { skip: !nativeExe }, run);
function runNative(args) {
  return spawnSync(nativeExe, args, {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true
  });
}

nativeTest('原生 --print-effective-config 输出完整托管设置、不写盘且无重复键', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-native-print-effective-'));
  try {
    const configPath = path.join(directory, 'chaoxing-plus.json');
    const configText = '{"settings":{"common.settings.windows-panel-width":600,"common.settings.tiku-adapter.baseurl":"https://example.test","common.settings.unknown-key":"keep"}}';
    await writeFile(configPath, configText, 'utf8');
    const dataDir = path.join(directory, 'data');
    const result = runNative([
      '--print-effective-config',
      '--config', configPath,
      '--options-json', '{"settings":{"common.settings.windows-panel-enabled":false,"common.settings.windows-answer-key":"Ctrl+Alt+Shift+S"}}',
      '--data-dir', dataDir,
      '--quiet'
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const lines = result.stdout.trim().split(/\r?\n/u);
    assert.equal(lines.length, 1, `原生 print-effective-config 必须只输出一行 JSON：${result.stdout}`);
    const settings = JSON.parse(lines[0]);
    assert.equal(settings['common.settings.windows-panel-width'], 600, '配置层设置必须生效');
    assert.equal(settings['common.settings.windows-panel-enabled'], false, '内联 JSON 设置必须生效');
    assert.equal(settings['common.settings.windows-answer-key'], 'Ctrl+Alt+Shift+S');
    assert.equal(settings['common.settings.windows-no-disk-write'], false);
    assert.equal(settings['common.settings.tiku-adapter.baseurl'], 'https://example.test', '未托管设置必须保留');
    assert.equal(settings['common.settings.unknown-key'], 'keep', '未知共享设置必须保留');
    assert.equal(settings['common.settings.windows-panel-theme'], 'pink', '托管默认值必须补齐');
    assert.equal(settings['common.settings.windows-answer-threads'], 4);
    const counts = new Map();
    for (const match of lines[0].matchAll(/"common\.settings\.[a-z0-9-]+"/gu)) {
      counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
    }
    assert.equal([...counts.values()].filter((count) => count > 1).length, 0, '输出不得包含重复键');
    assert.equal(existsSync(dataDir), false, 'print mode must not create the data directory');
    assert.equal(await readFile(configPath, 'utf8'), configText, 'print mode must not rewrite the config file');
    assert.deepEqual(await readdir(directory), ['chaoxing-plus.json'], 'print mode must not create extra files');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

nativeTest('原生 --print-effective-config --no-disk-write 输出派生的只读设置', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-native-print-effective-nowrite-'));
  try {
    const dataDir = path.join(directory, 'data');
    const result = runNative(['--print-effective-config', '--no-disk-write', '--data-dir', dataDir, '--quiet']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const settings = JSON.parse(result.stdout.trim());
    assert.equal(settings['common.settings.windows-no-disk-write'], true);
    assert.equal(settings['common.settings.windows-log-enabled'], false);
    assert.equal(settings['common.settings.extension-enabled'], true);
    assert.equal(existsSync(dataDir), false, 'no-disk-write print mode must not create the data directory');
    assert.deepEqual(await readdir(directory), [], 'no-disk-write print mode must not create extra files');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('Node --print-effective-config 不受 --quiet 抑制，且不输出额外日志行', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-node-print-effective-quiet-'));
  try {
    const configPath = path.join(directory, 'chaoxing-plus.json');
    await writeFile(configPath, '{"settings":{"common.settings.windows-panel-width":700}}', 'utf8');
    const result = runHost([
      '--print-effective-config', '--quiet',
      '--config', configPath,
      '--data-dir', path.join(directory, 'data')
    ]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/u);
    assert.equal(lines.length, 1, `--quiet must not suppress or pollute the JSON output: ${result.stdout}`);
    const settings = JSON.parse(lines[0]);
    assert.equal(settings['common.settings.windows-panel-width'], 700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
