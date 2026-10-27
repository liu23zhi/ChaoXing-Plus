import test from 'node:test';
import assert from 'node:assert/strict';

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

  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { executionMode: 'memory' }), /尚未实现/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { wipeOwnedFilesOnStart: true }), /尚未实现/u);
  assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), { settings: { selfDestructOnFullscreenExit: true } }), /尚未实现/u);
  assert.throws(() => validateSupportedJsonOptions({ settings: { 'common.settings.windows-self-destruct-on-fullscreen-exit': true } }), /尚未实现/u);
  assert.throws(() => validateSupportedJsonOptions({ settings: { 'common.settings.windows-execution-mode': 'memory' } }), /尚未实现/u);
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

test('未实现能力暴露机器可读 schema / capability 标记', () => {
  assert.equal(parseHostArgs(['--capabilities']).capabilities, true);
  assert.equal(UNSUPPORTED_CAPABILITIES.implemented, false);
  assert.equal(UNSUPPORTED_CAPABILITIES.startupWipe.implemented, false);
  assert.deepEqual([...UNSUPPORTED_CAPABILITIES.executionModes.supported], ['normal']);
  assert.deepEqual([...UNSUPPORTED_CAPABILITIES.executionModes.unsupportedValues], ['memory', 'delete-suspend']);
  assert.equal(UNSUPPORTED_CAPABILITIES.startupWipe.retries.min, 1);
  assert.equal(UNSUPPORTED_CAPABILITIES.startupWipe.retries.max, 20);
  assert.equal(UNSUPPORTED_CAPABILITIES.startupWipe.retryDelayMs.min, 50);
  assert.equal(UNSUPPORTED_CAPABILITIES.startupWipe.retryDelayMs.max, 5000);
  assert.deepEqual([...UNSUPPORTED_CAPABILITIES.startupWipe.failurePolicies], ['retry', 'background', 'ignore', 'abort']);
  assert.equal(UNSUPPORTED_CAPABILITIES.selfDestruct.repeatableKey, true);
  assert.equal(UNSUPPORTED_CAPABILITIES.selfDestruct.confirmDefault, true);
  const notes = describeUnsupportedCapabilities();
  assert.equal(notes.length, 3);
  assert.match(notes.join('\n'), /startup-wipe/u);
  assert.match(notes.join('\n'), /self-destruct/u);
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

test('第一阶段启动清理、自毁和内存执行的 CLI 参数都显式拒绝', () => {
  for (const argument of [
    '--wipe-owned-files-on-start',
    '--wipe-failure-policy',
    '--wipe-retries',
    '--wipe-retry-delay',
    '--wipe-runtime-retry',
    '--no-wipe-runtime-retry',
    '--wipe-runtime-interval',
    '--memory-exec',
    '--delete-suspend',
    '--self-destruct-key',
    '--self-destruct-on-fullscreen-exit',
    '--self-destruct-delay',
    '--no-self-destruct-confirm'
  ]) {
    assert.throws(() => parseHostArgs([argument]), /尚未实现/u);
  }
});

test('第一阶段所有配置层的启动清理参数都显式拒绝，包括关闭值', () => {
  for (const values of [
    { wipeOwnedFilesOnStart: true },
    { wipeOwnedFilesOnStart: false },
    { wipeFailurePolicy: 'retry' },
    { wipeRetries: 5 },
    { wipeRetryDelayMs: 200 },
    { wipeRuntimeRetry: false },
    { wipeRuntimeIntervalSec: 30 },
    { settings: { 'common.settings.windows-wipe-runtime-retry': false } }
  ]) {
    assert.throws(() => validateSupportedJsonOptions(values), /尚未实现/u);
    assert.throws(() => applyOptionsJsonToOptions(parseHostArgs([]), values), /尚未实现/u);
    assert.throws(() => applyHostOptionLayers(parseHostArgs([]), values), /尚未实现/u);
  }
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

test('内存执行、删除挂起和自毁参数显式拒绝，不静默降级为普通运行', () => {
  assert.throws(() => parseHostArgs(['--execution-mode', 'memory']), /尚未实现/u);
  assert.throws(() => parseHostArgs(['--execution-mode', 'delete-suspend']), /尚未实现/u);
  assert.throws(() => parseHostArgs(['--self-destruct-key', 'Ctrl+Alt+X']), /尚未实现/u);
  assert.throws(() => parseHostArgs(['--self-destruct-on-fullscreen-exit']), /尚未实现/u);
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
