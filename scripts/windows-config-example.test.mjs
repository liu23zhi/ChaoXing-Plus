import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const examplePath = path.join(root, 'windows', 'config.example.json');
const hostScript = path.join(root, 'windows', 'host', 'main.mjs');
const nativeExe = process.env.CX_NATIVE_HOST_EXE;

function runNode(args, timeout = 60000) {
  return spawnSync(process.execPath, [hostScript, ...args], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: { ...process.env, CXPLUS_NO_LOG_FILE: '1' }
  });
}

function parseSingleJsonLine(stdout, label) {
  const lines = stdout.trim().split(/\r?\n/u);
  assert.equal(lines.length, 1, `${label} 必须只输出一行 JSON：${stdout}`);
  return JSON.parse(lines[0]);
}

test('config.example.json 保持 ASCII、结构受支持且不含内部原型能力', async () => {
  const bytes = await readFile(examplePath);
  assert.equal([...bytes].some((byte) => byte > 0x7f), false, '示例配置必须保持纯 ASCII');

  const example = JSON.parse(bytes.toString('utf8'));
  const topLevel = [
    'clientPath', 'port', 'expectedBrowser', 'stopClientOnExit', 'injectBlankFrames',
    'captureConsole', 'injectStrategy', 'injectRetries', 'debugEndpointTimeoutMs',
    'targetPollIntervalMs', 'bundleTimeoutMs', 'dpiAwareness', 'settings'
  ];
  assert.deepEqual(Object.keys(example).sort(), [...topLevel].sort(), '示例配置顶层键必须与受支持字段一致');
  assert.equal(example.clientPath, '', '示例配置不得内置真实客户端路径');
  assert.equal(example.port, 0);
  assert.equal(example.dpiAwareness, '');
  assert.equal(typeof example.settings, 'object');
  for (const [key, value] of Object.entries(example.settings)) {
    assert.match(key, /^common\.settings\.[a-z0-9-]+$/u, `非法共享设置键：${key}`);
    assert.equal(['string', 'number', 'boolean'].includes(typeof value), true, `示例设置值类型不支持：${key}`);
    assert.doesNotMatch(key, /(?:memory|delete|self-destruct|wipe)/u, `示例配置不得包含未实现能力：${key}`);
  }
  for (const key of [
    'common.settings.extension-enabled',
    'common.settings.windows-panel-enabled',
    'common.settings.windows-panel-theme',
    'common.settings.windows-answer-mode',
    'common.settings.windows-answer-key'
  ]) {
    assert.equal(key in example.settings, true, `示例配置缺少常用设置：${key}`);
  }
});

test('Node 宿主可直接解析 config.example.json 且 print-effective-config 不写盘', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-example-node-'));
  try {
    const configPath = path.join(directory, 'example.json');
    const exampleText = await readFile(examplePath, 'utf8');
    await writeFile(configPath, exampleText, 'utf8');
    const result = runNode([
      '--print-effective-config',
      '--config', configPath,
      '--data-dir', path.join(directory, 'data'),
      '--no-disk-write'
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const settings = parseSingleJsonLine(result.stdout, 'Node --print-effective-config');
    assert.equal(settings['common.settings.windows-panel-theme'], 'pink');
    assert.equal(settings['common.settings.windows-answer-mode'], 'auto');
    assert.equal(settings['common.settings.windows-answer-key'], 'F8');
    assert.equal(settings['common.settings.windows-no-disk-write'], true);
    assert.deepEqual(await readdir(directory), ['example.json'], 'print-effective-config 不得创建额外文件');
    assert.equal(await readFile(configPath, 'utf8'), exampleText, 'print-effective-config 不得改写示例配置');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('原生宿主可直接解析 config.example.json 且 print-effective-config 不写盘', { skip: !nativeExe }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-example-native-'));
  try {
    const configPath = path.join(directory, 'example.json');
    const exampleText = await readFile(examplePath, 'utf8');
    await writeFile(configPath, exampleText, 'utf8');
    const result = spawnSync(nativeExe, [
      '--config', configPath,
      '--print-effective-config',
      '--no-disk-write'
    ], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const settings = parseSingleJsonLine(result.stdout, '原生 --print-effective-config');
    assert.equal(settings['common.settings.windows-panel-theme'], 'pink');
    assert.equal(settings['common.settings.windows-answer-mode'], 'auto');
    assert.equal(settings['common.settings.windows-answer-key'], 'F8');
    assert.equal(settings['common.settings.windows-answer-threads'], 4);
    assert.equal(settings['common.settings.windows-no-disk-write'], true);
    assert.equal(settings['common.settings.extension-enabled'], true);
    assert.equal('common.settings.tiku-adapter.key' in settings, false, '示例配置不得引入真实密钥');
    assert.deepEqual(await readdir(directory), ['example.json'], '原生 print-effective-config 不得创建额外文件');
    assert.equal(await readFile(configPath, 'utf8'), exampleText, '原生 print-effective-config 不得改写示例配置');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('示例配置中的托管设置与宿主默认值一致', async () => {
  const example = JSON.parse(await readFile(examplePath, 'utf8'));
  const expected = {
    'common.settings.extension-enabled': true,
    'common.settings.windows-panel-enabled': true,
    'common.settings.windows-panel-collapsed': true,
    'common.settings.windows-panel-top': 16,
    'common.settings.windows-panel-right': 16,
    'common.settings.windows-panel-width': 460,
    'common.settings.windows-panel-theme': 'pink',
    'common.settings.windows-answer-mode': 'auto',
    'common.settings.windows-answer-key': 'F8',
    'common.settings.windows-answer-threads': 4,
    'common.settings.windows-show-answer-dialog': true,
    'common.settings.windows-answer-countdown': 5,
    'common.settings.windows-answer-retry': 3,
    'common.settings.windows-auto-submit': true,
    'common.settings.windows-log-enabled': true
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(example.settings[key], value, `示例配置默认值漂移：${key}`);
  }
  assert.equal(existsSync(examplePath), true);
});
