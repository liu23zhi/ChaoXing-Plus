const ANSWER_MODES = new Set(['manual', 'auto']);

// 第一阶段未实现能力的机器可读 schema / capability 标记。
// 宿主只做“显式拒绝 + 帮助/报告展示”，绝不静默降级为普通运行。
export const UNSUPPORTED_CAPABILITIES = Object.freeze({
  implemented: false,
  reason: '第一阶段仅支持普通可审计运行；以下参数会显式报错，不会静默降级',
  executionModes: Object.freeze({
    supported: Object.freeze(['normal']),
    unsupportedFlags: Object.freeze(['--memory-exec', '--delete-suspend']),
    unsupportedValues: Object.freeze(['memory', 'delete-suspend'])
  }),
  startupWipe: Object.freeze({
    flags: Object.freeze([
      '--wipe-owned-files-on-start',
      '--wipe-failure-policy',
      '--wipe-retries',
      '--wipe-retry-delay',
      '--wipe-runtime-retry',
      '--no-wipe-runtime-retry',
      '--wipe-runtime-interval'
    ]),
    failurePolicies: Object.freeze(['retry', 'background', 'ignore', 'abort']),
    retries: Object.freeze({ min: 1, max: 20, default: 5 }),
    retryDelayMs: Object.freeze({ min: 50, max: 5000, default: 200 }),
    runtimeIntervalSec: Object.freeze({ default: 30 }),
    runtimeRetryDefault: true
  }),
  selfDestruct: Object.freeze({
    flags: Object.freeze([
      '--self-destruct-key',
      '--self-destruct-on-fullscreen-exit',
      '--self-destruct-delay',
      '--no-self-destruct-confirm'
    ]),
    repeatableKey: true,
    delayMs: Object.freeze({ default: 0 }),
    confirmDefault: true
  })
});

export function describeUnsupportedCapabilities() {
  return [
    `execution: 仅支持 ${UNSUPPORTED_CAPABILITIES.executionModes.supported.join('/')}；`
      + `${UNSUPPORTED_CAPABILITIES.executionModes.unsupportedValues.join('/')} 与 `
      + `${UNSUPPORTED_CAPABILITIES.executionModes.unsupportedFlags.join('/')} 未实现`,
    `startup-wipe: 未实现（策略 ${UNSUPPORTED_CAPABILITIES.startupWipe.failurePolicies.join('|')}，`
      + `重试 ${UNSUPPORTED_CAPABILITIES.startupWipe.retries.min}-${UNSUPPORTED_CAPABILITIES.startupWipe.retries.max}，`
      + `间隔 ${UNSUPPORTED_CAPABILITIES.startupWipe.retryDelayMs.min}-${UNSUPPORTED_CAPABILITIES.startupWipe.retryDelayMs.max}ms）`,
    `self-destruct: 未实现（可重复快捷键、延迟 ${UNSUPPORTED_CAPABILITIES.selfDestruct.delayMs.default}ms、默认需确认）`
  ];
}

export function normalizeAnswerThreads(value) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error('答题线程数必须是 1 到 4 之间的整数');
  }
  if (typeof value === 'string' && !/^\d+$/u.test(value.trim())) {
    throw new Error('答题线程数必须是 1 到 4 之间的整数');
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) {
    throw new Error('答题线程数必须是 1 到 4 之间的整数');
  }
  return parsed;
}

function readValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`参数 ${name} 缺少值`);
  }
  return value;
}

export function parseClientSelectionInput(value, defaultIndex) {
  const text = String(value || '').trim();
  if (!text) return { index: defaultIndex, path: '' };
  if (/^\d+$/u.test(text)) return { index: Number.parseInt(text, 10) - 1, path: '' };
  const quote = text[0];
  const selectedPath = (quote === '"' || quote === "'") && text.endsWith(quote)
    ? text.slice(1, -1)
    : text;
  return { index: defaultIndex, path: selectedPath };
}

function readAnswerMode(value) {
  if (!ANSWER_MODES.has(value)) {
    throw new Error(`参数 --answer-mode 只支持 manual 或 auto，当前为 ${value}`);
  }
  return value;
}

function readBoundedNumber(value, name, min, max) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) {
    throw new Error(`参数 ${name} 必须是 ${min} 到 ${max} 之间的数字`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`参数 ${name} 必须是 ${min} 到 ${max} 之间的数字`);
  }
  return parsed;
}

function readBoundedInteger(value, name, min, max) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`参数 ${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  if (typeof value === 'string' && !/^\d+$/u.test(value.trim())) {
    throw new Error(`参数 ${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`参数 ${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return parsed;
}

function readBoolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`options-json 的 ${name} 必须是布尔值`);
  return value;
}

function readString(value, name) {
  if (typeof value !== 'string') throw new Error(`options-json 的 ${name} 必须是字符串`);
  return value;
}

function readPort(value, name, allowZero = false) {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > 65535) {
    throw new Error(`参数 ${name} 必须是 ${allowZero ? '0 或 ' : ''}1 到 65535 之间的整数`);
  }
  return parsed;
}

function readAnswerKey(value) {
  const parts = String(value || '').split('+').map((part) => part.trim()).filter(Boolean);
  const modifiers = new Set(['ctrl', 'control', 'alt', 'shift', 'meta', 'win', 'windows', 'command']);
  const keys = parts.filter((part) => !modifiers.has(part.toLowerCase()));
  if (keys.length !== 1 || !/^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|space|enter|escape|esc|tab|delete|backspace|home|end|pageup|pagedown|arrow(?:up|down|left|right))$/iu.test(keys[0])) {
    throw new Error('参数 --answer-key 必须是单个按键或组合键，例如 F8 或 Ctrl+Shift+A');
  }
  return parts.join('+');
}

function rejectUnsupportedExecutionOption(argument) {
  throw new Error(`参数 ${argument} 当前 Windows 宿主尚未实现；请使用已支持的普通运行参数`);
}

export function validateSupportedJsonOptions(value, source = 'options-json') {
  const unsupportedKey = /^(?:executionmode|memoryexec|deletesuspend|selfdestruct.*|wipe.*)$/iu;
  const visit = (item, prefix = '') => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      const normalizedKey = key
        .replace(/^common\.settings\.windows-/iu, '')
        .replace(/[-_]/gu, '')
        .toLowerCase();
      if (unsupportedKey.test(normalizedKey) && child !== false && !(normalizedKey === 'executionmode' && child === 'normal')) {
        throw new Error(`${source} 包含当前宿主尚未实现的参数：${fullKey}`);
      }
      visit(child, fullKey);
    }
  };
  visit(value);
}

function rejectUnsupportedJsonOptions(value) {
  validateSupportedJsonOptions(value, 'options-json');
}

export function parseOptionsJson(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('参数 --options-json 不能为空');
  if (text.startsWith('@')) {
    const filePath = text.slice(1).trim();
    if (!filePath) throw new Error('参数 --options-json @<file> 缺少文件路径');
    return { filePath };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层必须是 JSON 对象');
    }
    return { value: parsed };
  } catch (error) {
    throw new Error(`参数 --options-json 不是合法 JSON：${error.message}`);
  }
}

const JSON_OPTION_KEYS = {
  clientPath: 'clientPath',
  clientIndex: 'clientIndex',
  clientFirst: 'clientFirst',
  listClients: 'listClients',
  selectClient: 'selectClient',
  scanMode: 'scanMode',
  scanAll: 'scanMode',
  ui: 'ui',
  rescan: 'rescan',
  noScanCache: 'noScanCache',
  dataDir: 'dataDir',
  noDiskWrite: 'noDiskWrite',
  retainData: 'retainData',
  deleteConfig: 'deleteConfig',
  panel: 'panelEnabled',
  panelEnabled: 'panelEnabled',
  panelCollapsed: 'panelCollapsed',
  panelTop: 'panelTop',
  panelRight: 'panelRight',
  panelWidth: 'panelWidth',
  panelTheme: 'panelTheme',
  answerMode: 'answerMode',
  answerKey: 'answerKey',
  showAnswerDialog: 'showAnswerDialog',
  answerThreads: 'answerThreads',
  answerCountdown: 'answerCountdown',
  answerRetry: 'answerRetry',
  autoSubmit: 'autoSubmit',
  log: 'logFileEnabled',
  logFileEnabled: 'logFileEnabled',
  quiet: 'quiet',
  diagnose: 'diagnose',
  noDiagnose: 'diagnose',
  diagnosticsDir: 'diagnosticsDir',
  report: 'reportPath',
  reportPath: 'reportPath',
  stopClientOnExit: 'stopClientOnExit',
  dpiAware: 'dpiAware'
};

const CLI_OPTION_KEYS = {
  '--client': 'clientPath', '--client-index': 'clientIndex', '--client-first': 'clientFirst',
  '--list-clients': 'listClients', '--select-client': 'selectClient', '--scan-mode': 'scanMode',
  '--scan-all': 'scanMode', '--no-scan-all': 'scanMode', '--ui': 'ui', '--rescan': 'rescan',
  '--no-scan-cache': 'noScanCache', '--config': 'configPath', '--data-dir': 'dataDir',
  '--no-disk-write': 'noDiskWrite', '--retain-data': 'retainData', '--no-retain-data': 'retainData',
  '--delete-config': 'deleteConfig', '--panel': 'panelEnabled', '--no-panel': 'panelEnabled',
  '--panel-collapsed': 'panelCollapsed', '--panel-expanded': 'panelCollapsed', '--panel-top': 'panelTop',
  '--panel-right': 'panelRight', '--panel-width': 'panelWidth', '--panel-theme': 'panelTheme',
  '--answer-mode': 'answerMode', '--answer-key': 'answerKey', '--show-answer-dialog': 'showAnswerDialog',
  '--hide-answer-dialog': 'showAnswerDialog', '--answer-threads': 'answerThreads',
  '--answer-countdown': 'answerCountdown', '--answer-retry': 'answerRetry', '--no-auto-submit': 'autoSubmit',
  '--log': 'logFileEnabled', '--no-log': 'logFileEnabled', '--quiet': 'quiet', '--diagnose': 'diagnose',
  '--no-diagnose': 'diagnose', '--diagnostics-dir': 'diagnosticsDir', '--report': 'reportPath',
  '--stop-client-on-exit': 'stopClientOnExit', '--dpi-aware': 'dpiAware'
};

export function applyOptionsJsonToOptions(options, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return options;
  rejectUnsupportedJsonOptions(value);
  if (Object.prototype.hasOwnProperty.call(value, 'configPath')) {
    throw new Error('options-json 不能改变本次已选择的配置文件，请使用 --config');
  }
  const next = { ...options };
  const cliKeys = options.cliOptionKeys || new Set();
  const selectedByCli = ['clientPath', 'clientIndex', 'clientFirst', 'listClients', 'selectClient'].find((key) => cliKeys.has(key));
  const selectionKeys = new Set(['clientPath', 'clientIndex', 'clientFirst', 'listClients', 'selectClient']);
  for (const [jsonKey, optionKey] of Object.entries(JSON_OPTION_KEYS)) {
    if (selectedByCli && (selectionKeys.has(optionKey) || (selectedByCli === 'clientPath' && ['scanMode', 'scanAll'].includes(optionKey)))) continue;
    if (!Object.prototype.hasOwnProperty.call(value, jsonKey) || cliKeys.has(optionKey)) continue;
    const raw = value[jsonKey];
    switch (optionKey) {
      case 'scanMode':
        if (jsonKey === 'scanAll') {
          if (Object.prototype.hasOwnProperty.call(value, 'scanMode')) break;
          if (typeof raw !== 'boolean') throw new Error('options-json 的 scanAll 必须是布尔值');
          next.scanMode = raw ? 'fallback-all' : 'common';
          next.scanAll = raw;
        } else {
          if (!['common', 'fallback-all', 'all'].includes(raw)) throw new Error('options-json 的 scanMode 无效');
          next.scanMode = raw;
          next.scanAll = raw === 'all';
        }
        next.scanClients = true;
        break;
      case 'answerMode': next.answerMode = readAnswerMode(raw); break;
      case 'answerKey': next.answerKey = readAnswerKey(readString(raw, jsonKey)); break;
      case 'diagnose':
        next.diagnose = jsonKey === 'noDiagnose' ? !readBoolean(raw, jsonKey) : readBoolean(raw, jsonKey);
        next.noDiagnose = !next.diagnose;
        break;
      case 'panelTop': next.panelTop = readBoundedNumber(raw, 'options-json.panelTop', 0, 10000); break;
      case 'panelRight': next.panelRight = readBoundedNumber(raw, 'options-json.panelRight', 0, 10000); break;
      case 'panelWidth': next.panelWidth = readBoundedNumber(raw, 'options-json.panelWidth', 320, 800); break;
      case 'answerThreads': next.answerThreads = normalizeAnswerThreads(raw); break;
      case 'answerCountdown': next.answerCountdown = readBoundedInteger(raw, 'options-json.answerCountdown', 0, 3600); break;
      case 'answerRetry': next.answerRetry = readBoundedInteger(raw, 'options-json.answerRetry', 0, 20); break;
      case 'clientPath': next.clientPath = readString(raw, jsonKey); break;
      case 'clientIndex': next.clientIndex = readBoundedInteger(raw, jsonKey, 1, Number.MAX_SAFE_INTEGER); break;
      case 'ui':
        if (!['auto', 'gui', 'cli'].includes(raw)) throw new Error('options-json 的 ui 只支持 auto、gui 或 cli');
        next.ui = raw;
        break;
      case 'dataDir': next.dataDir = readString(raw, jsonKey); next.dataDirExplicit = true; break;
      case 'diagnosticsDir': next.diagnosticsDir = readString(raw, jsonKey); break;
      case 'reportPath': next.reportPath = readString(raw, jsonKey); break;
      case 'panelTheme': next.panelTheme = readString(raw, jsonKey); break;
      case 'clientFirst': next.clientFirst = readBoolean(raw, jsonKey); if (next.clientFirst) next.scanClients = true; break;
      case 'listClients': next.listClients = readBoolean(raw, jsonKey); if (next.listClients) next.scanClients = true; break;
      case 'selectClient': next.selectClient = readBoolean(raw, jsonKey); if (next.selectClient) next.scanClients = true; break;
      case 'rescan':
      case 'noScanCache':
      case 'noDiskWrite':
      case 'retainData':
      case 'deleteConfig':
      case 'panelEnabled':
      case 'panelCollapsed':
      case 'showAnswerDialog':
      case 'quiet':
      case 'stopClientOnExit':
      case 'dpiAware':
      case 'autoSubmit':
      case 'logFileEnabled':
        next[optionKey] = readBoolean(raw, jsonKey);
        if (optionKey === 'rescan') next.scanClients = raw;
        break;
      default:
        if (['panelTop', 'panelRight', 'panelWidth'].includes(optionKey)) break;
        next[optionKey] = raw;
    }
  }
  if (next.noDiskWrite) {
    next.logFileEnabled = false;
    next.noDiagnose = true;
    next.diagnose = false;
    next.reportPath = '';
    next.noScanCache = true;
  }
  validateClientSelectionOptions(next);
  validateDataLifecycleOptions(next);
  return next;
}

function validateDataLifecycleOptions(options) {
  if (options.deleteConfig && !options.configPath) {
    throw new Error('--delete-config 必须与 --config <path> 一起使用，避免误删默认配置');
  }
  if (options.deleteConfig && options.noDiskWrite) {
    throw new Error('--no-disk-write 与 --delete-config 不能同时使用（禁止磁盘写入时不能删除外部配置）');
  }
}

function validateClientSelectionOptions(options) {
  if (options.clientPath && (options.clientIndex !== null && options.clientIndex !== undefined || options.clientFirst || options.selectClient || options.listClients)) {
    throw new Error('--client 不能与 --client-index、--client-first、--select-client 或 --list-clients 同时使用');
  }
  if (options.clientIndex !== null && options.clientIndex !== undefined && (options.clientFirst || options.selectClient || options.listClients)) {
    throw new Error('--client-index 不能与 --client-first、--select-client 或 --list-clients 同时使用');
  }
  if (options.clientFirst && (options.selectClient || options.listClients)) {
    throw new Error('--client-first 不能与 --select-client 或 --list-clients 同时使用');
  }
  if (options.selectClient && options.listClients) {
    throw new Error('--select-client 不能与 --list-clients 同时使用');
  }
}

export function parseHostArgs(argv) {
  const options = {
    rawArgs: argv.slice(),
    configPath: '',
    optionsJson: '',
    optionsJsonFile: '',
    clientPath: '',
    clientIndex: null,
    clientFirst: false,
    scanClients: false,
    listClients: false,
    selectClient: false,
    scanMode: 'fallback-all',
    scanAll: false,
    ui: 'auto',
    dataDir: '.data',
    dataDirExplicit: false,
    noDiskWrite: false,
    retainData: true,
    deleteConfig: false,
    port: null,
    assetsDir: '',
    durationMs: 0,
    attachPort: 0,
    reportPath: '',
    selfCheck: false,
    noElevate: false,
    elevated: false,
    stopClientOnExit: false,
    diagnose: false,
    noDiagnose: false,
    diagnosticsDir: '',
    dpiAware: false,
    quiet: false,
    logFileEnabled: undefined,
    panelEnabled: undefined,
    panelCollapsed: undefined,
    panelTop: undefined,
    panelRight: undefined,
    panelWidth: undefined,
    panelTheme: undefined,
    answerMode: undefined,
    answerKey: '',
    showAnswerDialog: undefined,
    answerThreads: undefined,
    answerCountdown: undefined,
    answerRetry: undefined,
    autoSubmit: undefined,
    executionMode: 'normal',
    help: false,
    capabilities: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--config': options.configPath = readValue(argv, index, argument); index += 1; break;
      case '--options-json': {
        const parsed = parseOptionsJson(readValue(argv, index, argument));
        options.optionsJson = parsed.value ? JSON.stringify(parsed.value) : '';
        options.optionsJsonFile = parsed.filePath || '';
        index += 1;
        break;
      }
      case '--client': options.clientPath = readValue(argv, index, argument); index += 1; break;
      case '--client-index': {
        const value = readBoundedInteger(readValue(argv, index, argument), argument, 1, Number.MAX_SAFE_INTEGER);
        options.clientIndex = value;
        index += 1;
        break;
      }
      case '--client-first': options.clientFirst = true; options.scanClients = true; break;
      case '--scan-clients': options.scanClients = true; break;
      case '--list-clients': options.listClients = true; options.scanClients = true; break;
      case '--select-client': options.selectClient = true; options.scanClients = true; break;
      case '--scan-mode': {
        const value = readValue(argv, index, argument);
        if (!['common', 'fallback-all', 'all'].includes(value)) {
          throw new Error('参数 --scan-mode 只支持 common、fallback-all 或 all');
        }
        options.scanMode = value;
        options.scanAll = value === 'all';
        options.scanClients = true;
        index += 1;
        break;
      }
      case '--scan-all': options.scanAll = true; options.scanMode = 'fallback-all'; options.scanClients = true; break;
      case '--no-scan-all': options.scanAll = false; options.scanMode = 'common'; options.scanClients = true; break;
      case '--ui': {
        const value = readValue(argv, index, argument);
        if (!['auto', 'gui', 'cli'].includes(value)) throw new Error('参数 --ui 只支持 auto、gui 或 cli');
        options.ui = value;
        index += 1;
        break;
      }
      case '--rescan': options.rescan = true; options.scanClients = true; break;
      case '--no-scan-cache': options.noScanCache = true; break;
      case '--data-dir': options.dataDir = readValue(argv, index, argument); options.dataDirExplicit = true; index += 1; break;
      case '--no-disk-write': options.noDiskWrite = true; options.logFileEnabled = false; options.noDiagnose = true; options.reportPath = ''; break;
      case '--retain-data':
        options.retainData = true;
        break;
      case '--no-retain-data':
        options.retainData = false;
        break;
      case '--delete-config':
        options.deleteConfig = true;
        break;
      case '--port': options.port = readPort(readValue(argv, index, argument), argument, true); index += 1; break;
      case '--assets': options.assetsDir = readValue(argv, index, argument); index += 1; break;
      case '--duration': options.durationMs = Number.parseInt(readValue(argv, index, argument), 10); index += 1; break;
      case '--attach': options.attachPort = readPort(readValue(argv, index, argument), argument); index += 1; break;
      case '--report': options.reportPath = readValue(argv, index, argument); index += 1; break;
      case '--self-check': options.selfCheck = true; break;
      case '--no-elevate': options.noElevate = true; break;
      case '--elevated': options.elevated = true; break;
      case '--stop-client-on-exit': options.stopClientOnExit = true; break;
      case '--diagnose': options.diagnose = true; options.noDiagnose = false; break;
      case '--no-diagnose': options.diagnose = false; options.noDiagnose = true; break;
      case '--diagnostics-dir': options.diagnosticsDir = readValue(argv, index, argument); index += 1; break;
      case '--dpi-aware': options.dpiAware = true; break;
      case '--quiet': options.quiet = true; break;
      case '--log': options.logFileEnabled = true; break;
      case '--no-log': options.logFileEnabled = false; break;
      case '--panel': options.panelEnabled = true; break;
      case '--no-panel': options.panelEnabled = false; break;
      case '--panel-collapsed': options.panelCollapsed = true; break;
      case '--panel-expanded': options.panelCollapsed = false; break;
      case '--panel-top': options.panelTop = readBoundedNumber(readValue(argv, index, argument), argument, 0, 10000); index += 1; break;
      case '--panel-right': options.panelRight = readBoundedNumber(readValue(argv, index, argument), argument, 0, 10000); index += 1; break;
      case '--panel-width': options.panelWidth = readBoundedNumber(readValue(argv, index, argument), argument, 320, 800); index += 1; break;
      case '--panel-theme': options.panelTheme = readValue(argv, index, argument); index += 1; break;
      case '--answer-mode': options.answerMode = readAnswerMode(readValue(argv, index, argument)); index += 1; break;
      case '--answer-key': options.answerKey = readAnswerKey(readValue(argv, index, argument)); index += 1; break;
      case '--show-answer-dialog': options.showAnswerDialog = true; break;
      case '--hide-answer-dialog': options.showAnswerDialog = false; break;
      case '--answer-threads': options.answerThreads = normalizeAnswerThreads(readValue(argv, index, argument)); index += 1; break;
      case '--answer-countdown': options.answerCountdown = readBoundedInteger(readValue(argv, index, argument), argument, 0, 3600); index += 1; break;
      case '--answer-retry': options.answerRetry = readBoundedInteger(readValue(argv, index, argument), argument, 0, 20); index += 1; break;
      case '--no-auto-submit': options.autoSubmit = false; break;
      case '--execution-mode': {
        const value = readValue(argv, index, argument);
        if (value !== 'normal') rejectUnsupportedExecutionOption(argument);
        options.executionMode = value;
        index += 1;
        break;
      }
      case '--self-destruct-key':
      case '--self-destruct-on-fullscreen-exit':
      case '--self-destruct-delay':
      case '--no-self-destruct-confirm':
      case '--wipe-owned-files-on-start':
      case '--wipe-failure-policy':
      case '--wipe-retries':
      case '--wipe-retry-delay':
      case '--wipe-runtime-retry':
      case '--no-wipe-runtime-retry':
      case '--wipe-runtime-interval':
      case '--memory-exec':
      case '--delete-suspend':
        rejectUnsupportedExecutionOption(argument);
      case '--help': case '-h': options.help = true; break;
      case '--capabilities': options.capabilities = true; break;
      default: throw new Error(`未知参数：${argument}`);
    }
  }
  options.cliOptionKeys = new Set(argv.map((argument) => CLI_OPTION_KEYS[argument]).filter(Boolean));
  validateClientSelectionOptions(options);
  validateDataLifecycleOptions(options);
  if (options.noDiskWrite) {
    options.logFileEnabled = false;
    options.noDiagnose = true;
    options.diagnose = false;
    options.reportPath = '';
    options.noScanCache = true;
  }
  return options;
}

export function applyHostOptionsToConfig(config, options) {
  const next = config && typeof config === 'object' ? config : {};
  next.settings = { ...(next.settings && typeof next.settings === 'object' ? next.settings : {}) };
  const values = {
    panelEnabled: 'common.settings.windows-panel-enabled',
    panelCollapsed: 'common.settings.windows-panel-collapsed',
    panelTop: 'common.settings.windows-panel-top',
    panelRight: 'common.settings.windows-panel-right',
    panelWidth: 'common.settings.windows-panel-width',
    panelTheme: 'common.settings.windows-panel-theme',
    answerMode: 'common.settings.windows-answer-mode',
    answerKey: 'common.settings.windows-answer-key',
    showAnswerDialog: 'common.settings.windows-show-answer-dialog',
    answerThreads: 'common.settings.windows-answer-threads',
    answerCountdown: 'common.settings.windows-answer-countdown',
    answerRetry: 'common.settings.windows-answer-retry',
    autoSubmit: 'common.settings.windows-auto-submit'
  };
  for (const [optionKey, settingKey] of Object.entries(values)) {
    if (options?.[optionKey] !== undefined && options?.[optionKey] !== '') {
      next.settings[settingKey] = options[optionKey];
    }
  }
  // 向页面下发宿主写盘开关，用于关闭题库缓存等页面侧持久化（业务 runtime 读取该共享设置）。
  if (options?.noDiskWrite === true) {
    next.settings['common.settings.windows-no-disk-write'] = true;
  }
  return next;
}
