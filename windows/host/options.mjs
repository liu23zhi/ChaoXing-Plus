const ANSWER_MODES = new Set(['manual', 'auto']);

export function normalizeAnswerThreads(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) return 1;
  return Math.max(1, Math.min(4, parsed));
}

function readValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`参数 ${name} 缺少值`);
  }
  return value;
}

function readAnswerMode(value) {
  if (!ANSWER_MODES.has(value)) {
    throw new Error(`参数 --answer-mode 只支持 manual 或 auto，当前为 ${value}`);
  }
  return value;
}

function readBoundedNumber(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`参数 ${name} 必须是 ${min} 到 ${max} 之间的数字`);
  }
  return parsed;
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
  throw new Error(`参数 ${argument} 涉及隐蔽进程执行/自毁，当前 Windows 宿主不支持；请使用 --execution-mode normal`);
}

export function parseHostArgs(argv) {
  const options = {
    rawArgs: argv.slice(),
    configPath: '',
    clientPath: '',
    clientIndex: null,
    scanClients: false,
    listClients: false,
    selectClient: false,
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
    answerMode: undefined,
    answerKey: '',
    showAnswerDialog: undefined,
    answerThreads: undefined,
    executionMode: 'normal',
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case '--config': options.configPath = readValue(argv, index, argument); index += 1; break;
      case '--client': options.clientPath = readValue(argv, index, argument); index += 1; break;
      case '--client-index': {
        const value = Number.parseInt(readValue(argv, index, argument), 10);
        if (!Number.isInteger(value) || value < 1) throw new Error('参数 --client-index 必须是从 1 开始的整数');
        options.clientIndex = value;
        index += 1;
        break;
      }
      case '--scan-clients': options.scanClients = true; break;
      case '--list-clients': options.listClients = true; options.scanClients = true; break;
      case '--select-client': options.selectClient = true; options.scanClients = true; break;
      case '--port': options.port = readPort(readValue(argv, index, argument), argument, true); index += 1; break;
      case '--assets': options.assetsDir = readValue(argv, index, argument); index += 1; break;
      case '--duration': options.durationMs = Number.parseInt(readValue(argv, index, argument), 10); index += 1; break;
      case '--attach': options.attachPort = readPort(readValue(argv, index, argument), argument); index += 1; break;
      case '--report': options.reportPath = readValue(argv, index, argument); index += 1; break;
      case '--self-check': options.selfCheck = true; break;
      case '--no-elevate': options.noElevate = true; break;
      case '--elevated': options.elevated = true; break;
      case '--stop-client-on-exit': options.stopClientOnExit = true; break;
      case '--diagnose': options.diagnose = true; break;
      case '--no-diagnose': options.noDiagnose = true; break;
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
      case '--answer-mode': options.answerMode = readAnswerMode(readValue(argv, index, argument)); index += 1; break;
      case '--answer-key': options.answerKey = readAnswerKey(readValue(argv, index, argument)); index += 1; break;
      case '--show-answer-dialog': options.showAnswerDialog = true; break;
      case '--hide-answer-dialog': options.showAnswerDialog = false; break;
      case '--answer-threads': options.answerThreads = normalizeAnswerThreads(readValue(argv, index, argument)); index += 1; break;
      case '--execution-mode': {
        const value = readValue(argv, index, argument);
        if (value !== 'normal') rejectUnsupportedExecutionOption(argument);
        options.executionMode = value;
        index += 1;
        break;
      }
      case '--self-destruct-key': rejectUnsupportedExecutionOption(argument); break;
      case '--self-destruct-on-fullscreen-exit': rejectUnsupportedExecutionOption(argument); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`未知参数：${argument}`);
    }
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
    answerMode: 'common.settings.windows-answer-mode',
    answerKey: 'common.settings.windows-answer-key',
    showAnswerDialog: 'common.settings.windows-show-answer-dialog',
    answerThreads: 'common.settings.windows-answer-threads'
  };
  for (const [optionKey, settingKey] of Object.entries(values)) {
    if (options?.[optionKey] !== undefined && options?.[optionKey] !== '') {
      next.settings[settingKey] = options[optionKey];
    }
  }
  return next;
}
