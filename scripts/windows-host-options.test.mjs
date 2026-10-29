import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  applyHostOptionsToConfig,
  applyHostOptionLayers,
  applyOptionsJsonToOptions,
  describeUnsupportedCapabilities,
  parseClientSelectionInput,
  normalizeAnswerThreads,
  parseOptionsJson,
  parseHostArgs,
  UNSUPPORTED_CAPABILITIES,
  validateSupportedJsonOptions
} from '../windows/node-source/options.mjs';

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

test('测试运行时长只接受与原生一致的非负 32 位整数毫秒', () => {
  for (const duration of [0, 1, 2147483647]) {
    assert.equal(parseHostArgs(['--duration', String(duration)]).durationMs, duration);
  }
  assert.equal(parseHostArgs(['--duration', '100', '--duration', '0']).durationMs, 0);
  for (const duration of ['', '-1', 'abc', '100garbage', '2147483648', '1e3', '1.5']) {
    assert.throws(() => parseHostArgs(['--duration', duration]), /--duration.*0 到 2147483647.*整数/u);
  }
});

test('注入链路参数可由 CLI/JSON 配置，并校验启动超时范围', () => {
  const options = parseHostArgs([
    '--expected-browser', 'Chrome/75',
    '--no-inject-blank-frames',
    '--no-capture-console',
    '--inject-strategy', 'script',
    '--inject-retries', '4',
    '--debug-timeout', '45000',
    '--target-poll-interval', '1500',
    '--bundle-timeout', '90000'
  ]);
  assert.equal(options.expectedBrowser, 'Chrome/75');
  assert.equal(options.injectBlankFrames, false);
  assert.equal(options.captureConsole, false);
  assert.equal(options.injectStrategy, 'script');
  assert.equal(options.injectRetries, 4);
  assert.equal(options.debugEndpointTimeoutMs, 45000);
  assert.equal(options.targetPollIntervalMs, 1500);
  assert.equal(options.bundleTimeoutMs, 90000);

  const merged = applyOptionsJsonToOptions(parseHostArgs([]), {
    expectedBrowser: 'Chrome/',
    injectBlankFrames: false,
    captureConsole: false,
    injectStrategy: 'runtime',
    injectRetries: 1,
    debugEndpointTimeoutMs: 60000,
    targetPollIntervalMs: 2000,
    bundleTimeoutMs: 100000
  });
  assert.equal(merged.injectBlankFrames, false);
  assert.equal(merged.captureConsole, false);
  assert.equal(merged.injectStrategy, 'runtime');
  assert.equal(merged.injectRetries, 1);
  assert.equal(merged.debugEndpointTimeoutMs, 60000);
  assert.equal(merged.targetPollIntervalMs, 2000);
  assert.equal(merged.bundleTimeoutMs, 100000);
  assert.throws(() => parseHostArgs(['--debug-timeout', '100']), /1000 到 120000/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { bundleTimeoutMs: 100 }), /1000 到 300000/u);
  assert.throws(() => parseHostArgs(['--inject-strategy', 'unknown']), /hybrid、runtime 或 script/u);
  assert.throws(() => parseHostArgs(['--inject-retries', '6']), /0 到 5/u);
});

test('扫描参数保留常规一级扫描与显式全盘回退语义', () => {
  const common = parseHostArgs(['--scan-mode', 'common', '--client-first', '--ui', 'cli']);
  assert.equal(common.scanMode, 'common');
  assert.equal(common.clientFirst, true);
  assert.equal(common.ui, 'cli');
  assert.equal(common.scanAll, false);

  const fallback = parseHostArgs(['--scan-mode', 'fallback-all', '--scan-all']);
  assert.equal(fallback.scanMode, 'fallback-all');
  assert.equal(fallback.scanAll, true);

  assert.equal(parseHostArgs(['--scan-mode', 'all', '--scan-all']).scanMode, 'fallback-all');
  assert.equal(parseHostArgs(['--scan-mode', 'fallback-all', '--no-scan-all']).scanMode, 'common');
});

test('分层参数在全部覆盖后才校验跨字段约束和无磁盘写入规则', () => {
  const options = applyHostOptionLayers(parseHostArgs(['--config', 'example.json']),
    { deleteConfig: true, noDiskWrite: true },
    { deleteConfig: false, noDiskWrite: false, log: true, diagnose: true, report: 'report.json' });
  assert.equal(options.deleteConfig, false);
  assert.equal(options.noDiskWrite, false);
  assert.equal(options.logFileEnabled, true);
  assert.equal(options.diagnose, true);
  assert.equal(options.noDiagnose, false);
  assert.equal(options.reportPath, 'report.json');
  assert.equal(options.noScanCache, parseHostArgs([]).noScanCache);

  const finalNoDisk = applyHostOptionLayers(parseHostArgs([]),
    { noDiskWrite: false, log: true }, { noDiskWrite: true });
  assert.equal(finalNoDisk.logFileEnabled, false);
  assert.equal(finalNoDisk.noScanCache, true);
  assert.throws(() => applyHostOptionLayers(parseHostArgs(['--config', 'example.json']),
    { deleteConfig: true }, { noDiskWrite: true }), /不能同时使用/u);
});

test('低优先级关闭缓存开关不能取消 CLI 的重新扫描', () => {
  const options = applyHostOptionLayers(parseHostArgs(['--rescan']), {
    clientPath: 'C:\\Exam\\CXExam.exe', noScanCache: false
  });
  assert.equal(options.rescan, true);
  assert.equal(options.scanClients, true);
  assert.equal(options.clientPath, '');
});

test('配置与数据参数解析并应用 no-disk-write 覆盖规则', () => {
  const options = parseHostArgs([
    '--options-json', '{"answerMode":"manual"}',
    '--data-dir', 'C:\\Temp\\cx-data',
    '--no-disk-write',
    '--panel-theme', 'pink',
    '--answer-countdown', '12',
    '--answer-retry', '3',
    '--no-auto-submit'
  ]);
  assert.equal(options.optionsJson, '{"answerMode":"manual"}');
  assert.equal(options.dataDir, 'C:\\Temp\\cx-data');
  assert.equal(options.noDiskWrite, true);
  assert.equal(options.logFileEnabled, false);
  assert.equal(options.noDiagnose, true);
  assert.equal(options.retainData, true);
  assert.equal(options.panelTheme, 'pink');
  assert.equal(options.answerCountdown, 12);
  assert.equal(options.answerRetry, 3);
  assert.equal(options.autoSubmit, false);
  assert.equal(options.noScanCache, true);
  assert.equal(options.diagnose, false);
  assert.equal(options.reportPath, '');
  assert.deepEqual(parseOptionsJson('@C:\\Temp\\options.json'), { filePath: 'C:\\Temp\\options.json' });
});

test('答题设置由宿主配置同步到页面，未指定的开关不覆盖现有值', () => {
  const defaults = parseHostArgs([]);
  assert.equal(defaults.autoSubmit, undefined);

  const options = parseHostArgs([
    '--answer-countdown', '0',
    '--answer-retry', '0',
    '--no-auto-submit'
  ]);
  const config = applyHostOptionsToConfig({ settings: { 'common.settings.windows-auto-submit': true } }, options);
  assert.deepEqual(config.settings, {
    'common.settings.windows-auto-submit': false,
    'common.settings.windows-answer-countdown': 0,
    'common.settings.windows-answer-retry': 0
  });
});

test('options-json 覆盖默认值但不覆盖独立命令行参数', () => {
  const parsed = parseHostArgs(['--answer-threads', '2']);
  const merged = applyOptionsJsonToOptions(parsed, {
    scanMode: 'common',
    answerThreads: 4,
    panel: false,
    noDiskWrite: true
  });
  assert.equal(merged.scanMode, 'common');
  assert.equal(merged.answerThreads, 2);
  assert.equal(merged.panelEnabled, false);
  assert.equal(merged.noDiskWrite, true);
  assert.equal(merged.logFileEnabled, false);
  assert.equal(merged.noScanCache, true);
});

test('CLI 扫描选择会忽略配置层的 clientPath，但显式 --client 仍保持互斥', () => {
  const rescan = applyHostOptionLayers(parseHostArgs(['--rescan']), {
    clientPath: 'C:\\Configured\\CXExam.exe',
    scanMode: 'common',
    clientFirst: true
  });
  assert.equal(rescan.clientPath, '');
  assert.equal(rescan.rescan, true);
  assert.equal(rescan.scanClients, true);
  assert.equal(rescan.clientFirst, true);

  const scanClients = applyHostOptionLayers(parseHostArgs(['--scan-clients']), {
    clientPath: 'C:\\Configured\\CXExam.exe'
  });
  assert.equal(scanClients.clientPath, '');
  assert.equal(scanClients.scanClients, true);

  const indexed = applyHostOptionLayers(parseHostArgs(['--client-index', '2']), {
    clientPath: 'C:\\Configured\\CXExam.exe'
  });
  assert.equal(indexed.clientPath, '');
  assert.equal(indexed.clientIndex, 2);

  assert.throws(() => parseHostArgs(['--client', 'C:\\Explicit\\CXExam.exe', '--scan-clients']), /扫描参数/u);
});

test('显式 GUI/CLI 选择界面不被配置路径绕过，但保留显式客户端路径', () => {
  for (const ui of ['gui', 'cli']) {
    const stored = { clientPath: 'C:\\Configured\\CXExam.exe' };
    const selectedUi = applyHostOptionLayers(parseHostArgs(['--ui', ui]), stored);
    assert.equal(selectedUi.clientPath, '', `ui=${ui}`);
    assert.equal(selectedUi.ui, ui);

    const explicit = applyHostOptionLayers(parseHostArgs([
      '--client', 'D:\\Explicit\\CXExam.exe', '--ui', ui
    ]), stored);
    assert.equal(explicit.clientPath, 'D:\\Explicit\\CXExam.exe', `ui=${ui}`);
  }
  const automatic = applyHostOptionLayers(parseHostArgs(['--ui', 'auto']), {
    clientPath: 'C:\\Configured\\CXExam.exe'
  });
  assert.equal(automatic.clientPath, 'C:\\Configured\\CXExam.exe');
});

test('高优先级 JSON 界面选择覆盖低层路径，同层路径及 CLI 路径仍生效', () => {
  for (const ui of ['gui', 'cli']) {
    const stored = { clientPath: 'C:\\Configured\\CXExam.exe' };
    const selectedUi = applyHostOptionLayers(parseHostArgs([]), stored, { ui });
    assert.equal(selectedUi.clientPath, '', `JSON ui=${ui}`);
    assert.equal(selectedUi.ui, ui);

    const sameLayerPath = applyHostOptionLayers(parseHostArgs([]), stored, {
      ui, clientPath: 'D:\\Inline\\CXExam.exe'
    });
    assert.equal(sameLayerPath.clientPath, 'D:\\Inline\\CXExam.exe', `same layer ui=${ui}`);

    const cliPath = applyHostOptionLayers(parseHostArgs(['--client', 'E:\\CLI\\CXExam.exe']), stored, { ui });
    assert.equal(cliPath.clientPath, 'E:\\CLI\\CXExam.exe', `CLI path JSON ui=${ui}`);

    const laterPath = applyHostOptionLayers(parseHostArgs([]), stored, { ui }, {
      clientPath: 'F:\\Later\\CXExam.exe'
    });
    assert.equal(laterPath.clientPath, 'F:\\Later\\CXExam.exe', `later path ui=${ui}`);
  }
});

test('更高层 auto 覆盖低层界面请求后仍可使用原始配置路径', () => {
  const options = applyHostOptionLayers(parseHostArgs([]),
    { clientPath: 'C:\\Configured\\CXExam.exe' },
    { ui: 'gui' },
    { ui: 'auto' });
  assert.equal(options.ui, 'auto');
  assert.equal(options.clientPath, 'C:\\Configured\\CXExam.exe');
});

test('启动配置逐层应用 options 字段，优先级为默认、同目录、--config、内联 JSON、CLI', () => {
  const options = parseHostArgs(['--no-log']);
  const merged = applyHostOptionLayers(options,
    { scanMode: 'common', log: true, answerThreads: 1 },
    { scanMode: 'fallback-all', answerThreads: 2 },
    { scanMode: 'all', answerThreads: 3 },
    { scanMode: 'common', answerThreads: 4 }
  );
  assert.equal(merged.scanMode, 'common');
  assert.equal(merged.answerThreads, 4);
  assert.equal(merged.logFileEnabled, false);
  assert.equal(merged.scanClients, true);
});

test('配置层 no-disk-write 强制覆盖日志、诊断、报告与扫描缓存', () => {
  const merged = applyHostOptionLayers(parseHostArgs([]), {
    noDiskWrite: true,
    log: true,
    diagnose: true,
    report: 'report.json'
  });
  assert.equal(merged.noDiskWrite, true);
  assert.equal(merged.logFileEnabled, false);
  assert.equal(merged.diagnose, false);
  assert.equal(merged.noDiagnose, true);
  assert.equal(merged.reportPath, '');
  assert.equal(merged.noScanCache, true);
});

test('no-diagnose CLI 开关覆盖 options-json，且禁用的 JSON 能力显式报错', () => {
  const parsed = parseHostArgs(['--options-json', '{"diagnose":true}', '--no-diagnose']);
  const merged = applyOptionsJsonToOptions(parsed, { diagnose: true });
  assert.equal(merged.diagnose, false);
  assert.equal(merged.noDiagnose, true);
  assert.equal(parseHostArgs(['--diagnose', '--no-diagnose']).diagnose, false);
  assert.equal(parseHostArgs(['--no-diagnose', '--diagnose']).diagnose, true);

  const memoryJson = applyOptionsJsonToOptions(parseHostArgs([]), { executionMode: 'memory' });
  assert.equal(memoryJson.executionMode, 'memory');
  assert.equal(memoryJson.noDiskWrite, true);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { memoryExec: 'yes' }), /布尔值/u);
  assert.equal(applyOptionsJsonToOptions(parseHostArgs([]), { memoryExec: true }).executionMode, 'memory');
  assert.equal(applyOptionsJsonToOptions(parseHostArgs([]), { wipeOwnedFilesOnStart: true, wipeRetries: 6 }).wipeRetries, 6);
  assert.throws(() => validateSupportedJsonOptions({ settings: { 'common.settings.windows-self-destruct-on-fullscreen-exit': true } }), /只能作为顶层字段/u);
  assert.throws(() => validateSupportedJsonOptions({ settings: { 'common.settings.windows-execution-mode': 'memory' } }), /只能作为顶层字段/u);
  assert.equal(applyOptionsJsonToOptions(parseHostArgs([]), { retainData: false }).retainData, false);
  assert.equal(applyOptionsJsonToOptions(parseHostArgs([]), { retainData: true }).retainData, true);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { deleteConfig: true }), /--config/u);
  assert.doesNotThrow(() => validateSupportedJsonOptions({ retainData: false, deleteConfig: true }));
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { configPath: 'C:\\override.json' }), /--config/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { panel: 'false' }), /布尔值/u);
  assert.equal(applyOptionsJsonToOptions(parseHostArgs([]), { scanAll: true }).scanMode, 'fallback-all');
  assert.equal(applyOptionsJsonToOptions(parseHostArgs(['--scan-mode', 'common']), { scanAll: true }).scanMode, 'common');
});

test('数据保留和删除外部配置参数按方案解析，删除外部配置必须指定 --config', () => {
  assert.equal(parseHostArgs([]).retainData, true);
  assert.equal(parseHostArgs(['--retain-data']).retainData, true);
  assert.equal(parseHostArgs(['--no-retain-data']).retainData, false);
  assert.equal(parseHostArgs(['--retain-data', '--no-retain-data']).retainData, false);
  assert.throws(() => parseHostArgs(['--delete-config']), /--config/u);
  const options = parseHostArgs(['--delete-config', '--config', 'C:\\Tools\\chaoxing-plus.json']);
  assert.equal(options.deleteConfig, true);
  assert.equal(options.configPath, 'C:\\Tools\\chaoxing-plus.json');
  assert.throws(() => parseHostArgs(['--delete-config', '--config', 'C:\\Tools\\chaoxing-plus.json', '--no-disk-write']), /no-disk-write/u);
  assert.equal(parseHostArgs(['--ui', 'gui']).ui, 'gui');
  assert.equal(parseHostArgs(['--ui', 'cli']).ui, 'cli');
  assert.equal(applyOptionsJsonToOptions(parseHostArgs([]), { ui: 'gui' }).ui, 'gui');
  assert.throws(() => parseHostArgs(['--ui', 'bogus']), /只支持/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { ui: 'bogus' }), /只支持/u);
});

test('--version 开关可解析且默认关闭', () => {
  assert.equal(parseHostArgs([]).version, false);
  assert.equal(parseHostArgs(['--version']).version, true);
  assert.equal(parseHostArgs(['-v']).version, true);
});

test('能力标记区分 Node 已支持与原生 Node-only', () => {
  assert.equal(parseHostArgs(['--capabilities']).capabilities, true);
  assert.equal(UNSUPPORTED_CAPABILITIES.implemented, false);
  assert.equal(UNSUPPORTED_CAPABILITIES.startupWipe.implemented, true);
  assert.equal(UNSUPPORTED_CAPABILITIES.selfDestruct.implemented, true);
  assert.deepEqual([...UNSUPPORTED_CAPABILITIES.executionModes.supported], ['normal', 'memory', 'delete-suspend']);
  assert.deepEqual([...UNSUPPORTED_CAPABILITIES.nodeOnly], ['delete-suspend', 'startup-wipe', 'self-destruct', 'silent-scenario']);
  assert.equal(UNSUPPORTED_CAPABILITIES.startupWipe.retries.min, 1);
  assert.equal(UNSUPPORTED_CAPABILITIES.startupWipe.retries.max, 20);
  assert.equal(UNSUPPORTED_CAPABILITIES.startupWipe.retryDelayMs.min, 50);
  assert.equal(UNSUPPORTED_CAPABILITIES.startupWipe.retryDelayMs.max, 5000);
  assert.deepEqual([...UNSUPPORTED_CAPABILITIES.startupWipe.failurePolicies], ['retry', 'background', 'ignore', 'abort']);
  assert.equal(UNSUPPORTED_CAPABILITIES.selfDestruct.repeatableKey, true);
  assert.equal(UNSUPPORTED_CAPABILITIES.selfDestruct.confirmDefault, true);
  const notes = describeUnsupportedCapabilities();
  assert.equal(notes.length, 3);
  assert.match(notes.join('\n'), /Node 宿主支持/u);
});

test('文档中的普通启动示例参数均可通过宿主解析器', () => {
  const examples = [
    ['--scan-mode', 'fallback-all', '--client-first', '--execution-mode', 'normal', '--no-disk-write', '--no-log', '--quiet', '--no-panel', '--answer-mode', 'manual', '--answer-key', 'Ctrl+Alt+Shift+S', '--answer-threads', '1', '--hide-answer-dialog'],
    ['--scan-mode', 'fallback-all', '--select-client', '--panel', '--panel-expanded', '--panel-top', '24', '--panel-right', '24', '--panel-width', '520', '--answer-mode', 'auto', '--answer-countdown', '5', '--answer-threads', '4', '--show-answer-dialog', '--log', '--diagnose'],
    ['--report', '.data\\last-report.json', '--retain-data'],
    ['--client', 'D:\\Exam\\CXExam.exe', '--data-dir', 'D:\\CXPlusData', '--panel', '--panel-width', '520', '--log'],
    ['--scan-mode', 'common', '--list-clients', '--no-log', '--quiet'],
    ['--scan-mode', 'all', '--list-clients', '--no-log'],
    ['--config', '.\\chaoxing-plus.json', '--panel'],
    ['--config', '.\\chaoxing-plus.json', '--delete-config'],
    ['--options-json', '{"panel":true,"panelTop":24,"panelWidth":520}']
  ];
  for (const args of examples) assert.doesNotThrow(() => parseHostArgs(args));
});

test('客户端选择参数互斥时在启动前报错', () => {
  assert.throws(() => parseHostArgs(['--client', 'C:\\CXExam.exe', '--client-first']), /不能与/u);
  assert.throws(() => parseHostArgs(['--client-index', '1', '--select-client']), /不能与/u);
  assert.throws(() => parseHostArgs(['--client', 'C:\\CXExam.exe', '--scan-clients']), /扫描参数/u);
  assert.throws(() => parseHostArgs(['--client', 'C:\\CXExam.exe', '--scan-mode', 'common']), /扫描参数/u);
  assert.throws(() => parseHostArgs(['--client', 'C:\\CXExam.exe', '--rescan']), /扫描参数/u);
  assert.throws(() => parseHostArgs(['--client', 'C:\\CXExam.exe', '--no-scan-cache']), /扫描参数/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), {
    clientPath: 'C:\\CXExam.exe',
    scanMode: 'common'
  }), /扫描参数/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), {
    clientPath: 'C:\\CXExam.exe',
    noScanCache: true
  }), /扫描参数/u);
});

test('终端客户端选择输入支持序号或带引号的手动路径', () => {
  assert.deepEqual(parseClientSelectionInput('2', 0), { index: 1, path: '' });
  assert.deepEqual(parseClientSelectionInput('', 2), { index: 2, path: '' });
  assert.deepEqual(parseClientSelectionInput('"D:\\Exam Files\\CXExam.exe"', 0), { index: 0, path: 'D:\\Exam Files\\CXExam.exe' });
  assert.deepEqual(parseClientSelectionInput("'D:\\Exam Files\\CXExam.exe'", 0), { index: 0, path: 'D:\\Exam Files\\CXExam.exe' });
});

test('启动清理、自毁和删除挂起 CLI 参数已接入并做冲突校验', () => {
  assert.equal(parseHostArgs(['--delete-suspend']).executionMode, 'delete-suspend');
  assert.equal(parseHostArgs(['--execution-mode', 'delete-suspend']).executionMode, 'delete-suspend');
  const wipe = parseHostArgs(['--wipe-owned-files-on-start', '--wipe-retries', '7', '--wipe-failure-policy', 'abort']);
  assert.equal(wipe.wipeOwnedFilesOnStart, true);
  assert.equal(wipe.wipeRetries, 7);
  assert.throws(() => parseHostArgs(['--wipe-retries', '7']), /一起使用/u);
  const destruct = parseHostArgs(['--self-destruct-key', 'Ctrl+Alt+X', '--no-self-destruct-confirm', '--self-destruct-delay', '1000']);
  assert.deepEqual(destruct.selfDestructKeys, ['Ctrl+Alt+X']);
  assert.equal(destruct.selfDestructConfirm, false);
  assert.equal(destruct.selfDestructDelayMs, 1000);
  assert.throws(() => parseHostArgs(['--self-destruct-delay', '1000']), /至少启用/u);
  assert.throws(() => parseHostArgs(['--self-destruct-key', 'Ctrl+Alt+Shift+E', '--answer-key', 'Ctrl+Alt+Shift+E']), /不能与/u);
});

test('启动清理/自毁 JSON 只允许顶层，页面共享设置仍拒绝', () => {
  const wipe = applyOptionsJsonToOptions(parseHostArgs([]), { wipeOwnedFilesOnStart: true, wipeRetries: 6, wipeFailurePolicy: 'background' });
  assert.equal(wipe.wipeOwnedFilesOnStart, true);
  assert.equal(wipe.wipeRetries, 6);
  assert.equal(wipe.wipeFailurePolicy, 'background');
  const destruct = applyOptionsJsonToOptions(parseHostArgs([]), { selfDestructKeys: ['Ctrl+Alt+Shift+E'], noSelfDestructConfirm: true });
  assert.deepEqual(destruct.selfDestructKeys, ['Ctrl+Alt+Shift+E']);
  assert.equal(destruct.selfDestructConfirm, false);
  assert.throws(() => validateSupportedJsonOptions({ settings: { 'common.settings.windows-wipe-runtime-retry': false } }), /只能作为顶层字段/u);
  assert.throws(() => validateSupportedJsonOptions({ settings: { 'common.settings.windows-self-destruct-on-fullscreen-exit': true } }), /只能作为顶层字段/u);
  assert.throws(() => validateSupportedJsonOptions({ settings: { 'common.settings.windows-execution-mode': 'delete-suspend' } }), /只能作为顶层字段/u);
});

test('答题线程限制为 1 到 4', () => {
  assert.throws(() => normalizeAnswerThreads(0), /1 到 4/u);
  assert.equal(normalizeAnswerThreads(1), 1);
  assert.equal(normalizeAnswerThreads(4), 4);
  assert.throws(() => normalizeAnswerThreads(9), /1 到 4/u);
  assert.throws(() => normalizeAnswerThreads('4.5'), /1 到 4/u);
  assert.throws(() => normalizeAnswerThreads(true), /1 到 4/u);
  assert.throws(() => normalizeAnswerThreads(null), /1 到 4/u);
  assert.throws(() => parseHostArgs(['--answer-threads', '2.5']), /1 到 4/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { answerThreads: 0 }), /1 到 4/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { answerThreads: true }), /1 到 4/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { answerRetry: true }), /整数/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { answerCountdown: false }), /整数/u);
  assert.throws(() => parseHostArgs(['--answer-countdown', '1.5']), /整数/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { answerCountdown: 1.5 }), /整数/u);
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

  const noDiskWriteConfig = applyHostOptionsToConfig({ settings: {} }, { noDiskWrite: true });
  assert.equal(noDiskWriteConfig.settings['common.settings.windows-no-disk-write'], true);
});

test('内存/delete-suspend 强制零落盘，自毁参数可解析', () => {
  const memory = parseHostArgs(['--execution-mode', 'memory']);
  assert.equal(memory.executionMode, 'memory');
  assert.equal(memory.noDiskWrite, true);
  assert.equal(memory.logFileEnabled, false);
  assert.equal(memory.noDiagnose, true);
  assert.equal(memory.noScanCache, true);
  assert.equal(memory.reportPath, '');
  assert.equal(parseHostArgs(['--memory-exec', '--report', 'x.json']).reportPath, '');
  const deleteSuspend = parseHostArgs(['--delete-suspend']);
  assert.equal(deleteSuspend.executionMode, 'delete-suspend');
  assert.equal(deleteSuspend.noDiskWrite, true);
  assert.equal(parseHostArgs(['--self-destruct-key', 'Ctrl+Alt+X']).selfDestructKeys.length, 1);
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

test('方向键快捷键同时接受页面规范名称与原生旧别名', () => {
  for (const direction of ['Up', 'Down', 'Left', 'Right']) {
    for (const key of [direction, `Arrow${direction}`]) {
      const shortcut = `Ctrl+${key}`;
      assert.equal(parseHostArgs(['--answer-key', shortcut]).answerKey, shortcut);
      assert.equal(applyOptionsJsonToOptions(parseHostArgs([]), { answerKey: shortcut }).answerKey, shortcut);
    }
  }
});

test('CEF75 普通启动端口只接受自动或 1024 到 65534，attach 保持通用范围', () => {
  for (const port of [0, 1024, 9333, 65534]) {
    assert.equal(parseHostArgs(['--port', String(port)]).port, port);
    assert.equal(applyOptionsJsonToOptions(parseHostArgs([]), { port }).port, port);
  }
  for (const port of [1, 1023, 65535]) {
    assert.throws(() => parseHostArgs(['--port', String(port)]), /1024.*65534/u);
    assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { port }), /1024.*65534/u);
  }
  assert.equal(parseHostArgs(['--port', '1023', '--port', '9333']).port, 9333);
  for (const port of [1, 1023, 65535]) assert.equal(parseHostArgs(['--attach', String(port)]).attachPort, port);
  assert.equal(applyHostOptionLayers(parseHostArgs(['--port', '9333']), { port: 1023 }).port, 9333);
  assert.equal(applyHostOptionLayers(parseHostArgs([]), { port: 1023 }, { port: 9333 }).port, 9333);
});

test('spawnClient 在创建进程前拒绝不支持的 CEF75 端口', async () => {
  const { spawnClient } = await import('../windows/node-source/launch.mjs');
  for (const port of [0, 1, 1023, 65535]) {
    assert.throws(() => {
      const result = spawnClient({ exePath: 'must-not-start-CXExam.exe', port });
      result.child.on('error', () => {});
    }, /端口/u);
  }
});

test('elevate-on-start 参数可解析并拒绝与 no-elevate 冲突', () => {
  assert.equal(parseHostArgs(['--elevate-on-start']).elevateOnStart, true);
  assert.equal(applyOptionsJsonToOptions(parseHostArgs([]), { elevateOnStart: true }).elevateOnStart, true);
  assert.throws(() => parseHostArgs(['--elevate-on-start', '--no-elevate']), /不能同时使用/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { elevateOnStart: 'true' }), /布尔值/u);
  assert.throws(() => applyHostOptionLayers(parseHostArgs(['--no-elevate']), { elevateOnStart: true }), /不能同时使用/u);
  assert.equal(applyHostOptionLayers(parseHostArgs([]), { elevateOnStart: true, noElevate: true }, { elevateOnStart: false }).noElevate, true);
  const startup = parseHostArgs(['--elevate-on-start'], { startup: true, platform: 'win32' });
  assert.equal(startup.ui, 'gui');
  assert.equal(startup.scanMode, 'common');
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
  assert.match(commonSource, /windows-no-disk-write/u);
  assert.match(commonSource, /isWindowsNoDiskWrite/u);
  assert.match(commonSource, /function saveQuestionCaches\(\) \{\s*if \(isWindowsNoDiskWrite\(\)\)/u);
  assert.match(commonSource, /function isLocalQuestionCacheEnabled\(\) \{\s*if \(isWindowsNoDiskWrite\(\)\)/u);
  assert.match(cxSource, /createWindowsManualAnswerGate/u);
  assert.match(cxSource, /matchesWindowsAnswerKey/u);
  assert.match(cxSource, /pendingTokens/u);
  assert.match(cxSource, /common\.settings\.windows-\$\{name\}/u);
  assert.match(cxSource, /'answer-mode'/u);
});

test('host usage lists scan fallback and client scan controls, including --no-scan-all', () => {
  const result = spawnSync(process.execPath, [resolve('windows/node-source/main.mjs'), '--help'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 15000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  for (const flag of ['--scan-clients', '--scan-all', '--no-scan-all']) {
    assert.ok(result.stdout.includes(flag), 'missing host usage flag: ' + flag);
  }
});
