import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyHostOptionsToConfig,
  normalizeAnswerThreads,
  parseHostArgs
} from '../windows/host/options.mjs';

test('Windows 宿主参数解析覆盖客户端选择、面板、答题、日志和线程', () => {
  const options = parseHostArgs([
    '--scan-clients',
    '--client-index', '2',
    '--answer-mode', 'manual',
    '--answer-key', 'Ctrl+Shift+A',
    '--hide-answer-dialog',
    '--no-panel',
    '--no-log',
    '--panel-top', '32',
    '--panel-right', '48',
    '--panel-width', '520',
    '--answer-threads', '4',
    '--panel-collapsed'
  ]);

  assert.equal(options.scanClients, true);
  assert.equal(options.clientIndex, 2);
  assert.equal(options.answerMode, 'manual');
  assert.equal(options.answerKey, 'Ctrl+Shift+A');
  assert.equal(options.showAnswerDialog, false);
  assert.equal(options.panelEnabled, false);
  assert.equal(options.logFileEnabled, false);
  assert.equal(options.answerThreads, 4);
  assert.equal(options.panelCollapsed, true);
  assert.equal(options.panelTop, 32);
  assert.equal(options.panelRight, 48);
  assert.equal(options.panelWidth, 520);
});

test('Windows 宿主参数支持脚本指定路径和自动答题', () => {
  const options = parseHostArgs([
    '--client', 'C:\\Exam\\CXExam.exe',
    '--answer-mode', 'auto',
    '--show-answer-dialog',
    '--panel'
  ]);

  assert.equal(options.clientPath, 'C:\\Exam\\CXExam.exe');
  assert.equal(options.answerMode, 'auto');
  assert.equal(options.showAnswerDialog, true);
  assert.equal(options.panelEnabled, true);
});

test('答题线程限制为 1 到 4', () => {
  assert.equal(normalizeAnswerThreads(0), 1);
  assert.equal(normalizeAnswerThreads(1), 1);
  assert.equal(normalizeAnswerThreads(4), 4);
  assert.equal(normalizeAnswerThreads(9), 4);
  assert.equal(normalizeAnswerThreads('bad'), 1);
});

test('宿主参数写入共享配置，供 bootstrap 和业务 runtime 使用', () => {
  const config = applyHostOptionsToConfig({ settings: {} }, {
    panelEnabled: false,
    panelCollapsed: true,
    panelTop: 32,
    panelRight: 48,
    panelWidth: 520,
    answerMode: 'manual',
    answerKey: 'F8',
    showAnswerDialog: false,
    logFileEnabled: false,
    answerThreads: 3
  });

  assert.deepEqual(config.settings, {
    'common.settings.windows-panel-enabled': false,
    'common.settings.windows-panel-collapsed': true,
    'common.settings.windows-panel-top': 32,
    'common.settings.windows-panel-right': 48,
    'common.settings.windows-panel-width': 520,
    'common.settings.windows-answer-mode': 'manual',
    'common.settings.windows-answer-key': 'F8',
    'common.settings.windows-show-answer-dialog': false,
    'common.settings.windows-answer-threads': 3
  });
});

test('内存执行、删除挂起和自毁参数显式拒绝，不静默降级为普通运行', () => {
  assert.throws(() => parseHostArgs(['--execution-mode', 'memory']), /不支持|normal/u);
  assert.throws(() => parseHostArgs(['--execution-mode', 'delete-suspend']), /不支持|normal/u);
  assert.throws(() => parseHostArgs(['--self-destruct-key', 'Ctrl+Alt+X']), /不支持/u);
  assert.throws(() => parseHostArgs(['--self-destruct-on-fullscreen-exit']), /不支持/u);
});

test('attach 参数与快捷键不合法时直接报错，不得落入普通启动流程', () => {
  for (const port of ['abc', '0', '65536', '1.5']) {
    assert.throws(() => parseHostArgs(['--attach', port]), /必须是/u);
  }
  assert.throws(() => parseHostArgs(['--answer-key', 'Ctrl+Shift+A+B']), /单个按键/u);
  assert.throws(() => parseHostArgs(['--answer-key', 'Ctrl+Shift+Unknown']), /单个按键/u);
  assert.equal(parseHostArgs(['--attach', '9222']).attachPort, 9222);
  assert.equal(parseHostArgs(['--answer-key', 'Ctrl+Shift+A']).answerKey, 'Ctrl+Shift+A');
});

test('Windows 业务 runtime 使用宿主下发的面板和答题设置', async () => {
  const { readFile } = await import('node:fs/promises');
  const [commonSource, cxSource] = await Promise.all([
    readFile(new URL('../src/projects/common.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/projects/cx.ts', import.meta.url), 'utf8')
  ]);

  assert.match(commonSource, /windows-panel-enabled/u);
  assert.match(commonSource, /windows-panel-collapsed/u);
  assert.match(cxSource, /getWindowsRuntimeSetting/u);
  assert.match(cxSource, /'answer-mode'/u);
  assert.match(cxSource, /'show-answer-dialog'/u);
  assert.match(commonSource, /windows-answer-threads/u);
  assert.match(cxSource, /createWindowsManualAnswerGate/u);
  assert.match(cxSource, /matchesWindowsAnswerKey/u);
  assert.match(cxSource, /pendingTokens/u);
  assert.match(cxSource, /common\.settings\.windows-\$\{name\}/u);
  assert.match(cxSource, /'answer-mode'/u);
});
