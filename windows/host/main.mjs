#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson } from './cdp.mjs';
import { PageSession } from './inject.mjs';
import {
  DEFAULT_PORT_CANDIDATES,
  chooseBindablePort,
  canBindPort,
  createListenerOwnershipVerifier,
  describeMachine,
  getListenerOwnerPid,
  hideConsoleWindow,
  isElevated,
  isSupportedClientMachine,
  killProcessTree,
  listProcessIdsByName,
  readPeMachine,
  relaunchElevated,
  restoreDpiAwarenessOverride,
  sanitizeUrl,
  setDpiAwarenessOverride,
  sleep,
  spawnClient,
  waitForDebugEndpoint
} from './launch.mjs';
import { createConfigStore, defaultConfigPath, ensureConfigFile, ENABLED_KEY, mergeHostConfigLayers } from './config.mjs';
import { applyHostOptionLayers, applyHostOptionsToConfig, applyOptionsJsonToOptions, describeUnsupportedCapabilities, parseHostArgs, UNSUPPORTED_CAPABILITIES, validateLaunchPort, validateSupportedJsonOptions } from './options.mjs';
import { probeClientSelectionWindow } from './selection-window.mjs';
import { resolveClientSelection as resolveClientSelectionFlow } from './client-selection.mjs';
import { isCxExamExecutablePath, resolveExplicitClientPath } from './client-discovery.mjs';
import { observeClientProcess } from './client-process.mjs';
import { createHostDiagnostics } from './memory-diagnostics.mjs';
import {
  RENDER_DIAGNOSTICS_EXPRESSION,
  collectSystemProbe,
  evaluateDpiDiagnosis,
  evaluatePageDiagnosis,
  normalizeDiagnosticsSample,
  summarizeRenderDiagnostics,
  writeDiagnosticsFile,
  writeScreenshot
} from './diagnostics.mjs';

const hostDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(hostDirectory, '..', '..');
const hostScriptPath = fileURLToPath(import.meta.url);

function usage() {
  return [
    '用法：node windows/host/main.mjs [选项]',
    '',
    '  --config <path>      配置文件路径（默认 windows/data/config.json）',
    '  --options-json <json|@file> 合并 JSON 对象或 JSON 文件；独立 CLI 参数优先',
    '  --data-dir <path>    宿主默认配置、日志和诊断数据目录',
    '  --no-disk-write      不写宿主配置、日志、诊断、报告或扫描缓存',
    '  --client <path>      覆盖配置中的客户端 exe 路径（也可作为手动选择）',
    '  --scan-clients       扫描桌面、Program Files 等常见根目录（根目录及一级子目录）',
    '  --scan-mode <mode>   common、fallback-all 或 all；默认常规无结果才全盘递归',
    '  --scan-all           启用常规无结果后的全盘回退（等价 fallback-all）',
    '  --no-scan-all        禁用全盘回退并强制常规扫描模式（common）',
    '  --client-first       选择扫描结果中的首个推荐客户端（x86 优先）',
    '  --ui <mode>          auto、gui 或 cli；gui/--select-client 使用 Windows 原生选择窗口',
    '  --list-clients       扫描并列出候选客户端后退出',
    '  --select-client      扫描后显示原生选择窗口（含手动浏览）；无窗口时回退终端提示',
    '  --client-index <n>   启动扫描结果中的第 n 个客户端（从 1 开始）',
    '  --rescan             忽略配置客户端路径并重新扫描，同时更新扫描缓存',
    '  --no-scan-cache      禁止读取和写入扫描缓存',
    '  --expected-browser <text> 调试端点 Browser 必须包含的文本（默认 Chrome/）',
    '  --inject-blank-frames/--no-inject-blank-frames 是否注入 about:blank/srcdoc frame',
    '  --capture-console/--no-capture-console 是否捕获页面 console 与异常',
    '  --inject-strategy <mode> hybrid、runtime 或 script；默认 hybrid',
    '  --inject-retries <n> 注入失败后的重试次数（0-5）',
    '  --debug-timeout <ms> 调试端点等待超时（1000-120000）',
    '  --target-poll-interval <ms> CDP target 轮询间隔（250-10000）',
    '  --bundle-timeout <ms> 业务 bundle 执行超时（1000-300000）',
    '  --port <n>           CEF 75 调试端口：0 自动选择，或 1024-65534',
    '  --assets <dir>       注入资源目录（默认 dist-windows）',
    '  --duration <ms>      运行指定毫秒后自动退出（测试用）',
    '  --attach <port>      测试/调试：连接已存在的调试端点，不启动、不校验归属',
    '  --report <path>      退出时把运行报告写入指定 JSON 文件',
    '  --self-check         只做环境/资源检查，不启动客户端',
    '  --print-effective-config 输出合并后的共享设置 JSON 后退出（不扫描、不启动、不写文件）',
    '  --elevate-on-start   启动时先申请管理员权限，再扫描和显示选择窗口',
    '  --no-elevate         不自动申请 UAC；客户端实际需要管理员权限时才报错',
    '  --elevated           内部标记：表示当前进程由 UAC 自动重启而来',
    '  --hide-console       静默启动：启动时及 UAC 提权重启时隐藏 Node 控制台窗口（供静默脚本使用）',
    '  --stop-client-on-exit 退出时结束本次启动的客户端进程树',
    '  --diagnose           强制开启渲染诊断（默认启动模式开启、attach 模式关闭）',
    '  --no-diagnose        关闭渲染诊断',
    '  --diagnostics-dir    诊断产物目录（默认 windows/data/diagnostics/<时间戳>）',
    '  --dpi-aware          本次启动临时给客户端加 HIGHDPIAWARE 兼容层（修复系统缩放导致的整体模糊）',
    '  --panel/--no-panel   启用或禁用 Windows 考试面板',
    '  --panel-collapsed    启动时折叠面板（默认折叠）',
    '  --panel-expanded     启动时展开面板',
    '  --panel-top <px>     面板距窗口顶部距离（0-10000）',
    '  --panel-right <px>   面板距窗口右侧距离（0-10000）',
    '  --panel-width <px>   面板宽度（320-800）',
    '  --panel-theme <name> 面板主题：pink（默认）/ blue / green；未知值回退 pink',
    '  --answer-mode <mode> auto 自动答题，manual 按键逐题触发',
    '  --answer-key <keys>  手动模式组合键，例如 Ctrl+Shift+A（默认 F8）',
    '  --show-answer-dialog/--hide-answer-dialog  是否显示自动答题确认弹窗',
    '  --answer-threads <n> 答题并发线程，范围 1-4',
    '  --answer-countdown <sec> 自动答题倒计时（0-3600，默认 5）',
    '  --answer-retry <n>   单题重试次数（0-20）',
    '  --no-auto-submit     不自动提交',
    '  --log/--no-log       是否写入宿主日志文件',
    '  --retain-data/--no-retain-data 退出后是否保留本次运行写入的数据（默认保留）',
    '  --delete-config      退出时删除 --config 指定的外部配置文件（必须同时指定 --config）',
    '  --diagnose/--no-diagnose 开启或关闭页面与窗口渲染诊断',
    '  --diagnostics-dir <path> 诊断输出目录',
    '  --wipe-*             启动清理仅保留参数设计，当前尚未实现并会报错',
    '  --execution-mode normal|memory 选择执行模式；memory 为宿主侧零落盘（客户端仍正常可见启动）',
    '  --memory-exec        --execution-mode memory 的简写',
    '  --version            输出宿主版本号 6.2.0',
    '  --capabilities       输出机器可读的能力标记与未实现能力说明',
    '  --quiet              减少控制台输出，不保证屏蔽参数错误或系统提示'
  ].join('\n');
}

function createLogger({ quiet = false, logFile = '' } = {}) {
  let fileHandle = null;
  const write = (level, message) => {
    const line = `[windows-host][${new Date().toISOString()}][${level}] ${message}`;
    if (!quiet) {
      const output = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      output(line);
    }
    if (fileHandle) {
      void fileHandle.write(`${line}\n`).catch(() => {});
    }
  };
  const logger = {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    async attachFile(filePath) {
      if (!filePath) return;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      fileHandle = await fs.open(filePath, 'a');
    },
    async close() {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
        fileHandle = null;
      }
    }
  };
  return logger;
}

async function loadAssets(assetsDir, logger) {
  const bootstrapPath = path.join(assetsDir, 'windows-bootstrap.js');
  const bundlePath = path.join(assetsDir, 'chaoxing-plus.windows.js');
  const trampolinePath = path.join(assetsDir, 'trampoline.js');
  const stylePath = path.join(assetsDir, 'vendor', 'sweetalert2.min.css');
  const manifestPath = path.join(assetsDir, 'package-manifest.json');
  const readRequired = async (filePath, hint) => {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      throw new Error(`缺少注入资源 ${filePath}${hint ? `（${hint}）` : ''}：${error.message}`);
    }
  };
  const assets = {
    bootstrap: await readRequired(bootstrapPath, '运行 npm run build:windows'),
    bundle: await readRequired(bundlePath, '运行 npm run build:windows'),
    trampoline: await readRequired(trampolinePath, '运行 npm run build:windows'),
    style: '',
    version: ''
  };
  try {
    assets.style = await fs.readFile(stylePath, 'utf8');
  } catch {
    logger.warn(`[assets] 未找到 SweetAlert2 样式 ${stylePath}，弹窗将使用默认样式`);
  }
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assets.version = String(manifest.version || '');
    logger.info(`[assets] 资源版本 ${assets.version || 'unknown'}（${assetsDir}）`);
  } catch {
    logger.warn('[assets] 未找到 package-manifest.json，跳过版本校验');
  }
  return assets;
}

function nowIso() {
  return new Date().toISOString();
}

function assertSupportedClientMachine(machine) {
  if (isSupportedClientMachine(machine)) return;
  if (machine === 0x8664) {
    throw new Error('x64 CXExam.exe 需要 64 位 Windows；当前环境只能运行 x86 客户端');
  }
  throw new Error(`不支持的 CXExam.exe 架构：${describeMachine(machine)}`);
}

async function readOptionalJson(filePath, label, { allowMissing = true } = {}) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const value = JSON.parse(text.replace(/^\uFEFF/u, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('顶层必须是 JSON 对象');
    }
    return value;
  } catch (error) {
    if (error && error.code === 'ENOENT' && allowMissing) return {};
    throw new Error(`${label} 无法读取或不是合法 JSON：${filePath}：${error.message}`);
  }
}

async function resolveClientSelection(options, config, logger, hooks = {}) {
  return resolveClientSelectionFlow(options, config, {
    logger,
    onListCandidates: hooks.onListCandidates,
    assertMachine: assertSupportedClientMachine,
    scanCachePath: options.scanCachePath || '',
    onCacheEvent: (event) => {
      if (event.type === 'hit') logger.info(`[client] 使用扫描缓存（${event.count} 个候选）`);
      else if (event.type === 'miss') logger.info('[client] 扫描缓存不可用，执行实时扫描');
      else if (event.type === 'write') logger.info(`[client] 已更新扫描缓存（${event.count} 个候选）`);
      else if (event.type === 'write-error') logger.warn(`[client] 扫描缓存写入失败：${event.error && event.error.message ? event.error.message : String(event.error)}`);
    }
  });
}

async function runSelfCheck(options, logger) {
  const failures = [];
  const warnings = [];
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    if (!ok) failures.push(`${name}: ${detail}`);
  };
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0], 10);
  add('node 版本 >= 22（内置 WebSocket/fetch）', major >= 22, `当前 ${version}`);
  add('全局 WebSocket 可用', typeof WebSocket === 'function', typeof WebSocket);
  add('全局 fetch 可用', typeof fetch === 'function', typeof fetch);
  add('Windows 平台', process.platform === 'win32', process.platform);

  const assetsDir = options.assetsDir || path.join(repositoryRoot, 'dist-windows');
  for (const name of ['windows-bootstrap.js', 'chaoxing-plus.windows.js', 'trampoline.js']) {
    const filePath = path.join(assetsDir, name);
    try {
      const stat = await fs.stat(filePath);
      add(`资源存在 ${name}`, stat.size > 0, `${stat.size} 字节`);
    } catch (error) {
      add(`资源存在 ${name}`, false, `${filePath}: ${error.message}`);
    }
  }
  const stylePath = path.join(assetsDir, 'vendor', 'sweetalert2.min.css');
  try {
    const stat = await fs.stat(stylePath);
    checks.push({ name: 'SweetAlert2 样式', ok: true, detail: `${stat.size} 字节` });
  } catch {
    warnings.push(`缺少 SweetAlert2 样式：${stylePath}`);
  }

  const configPath = resolveHostConfigPath(options);
  let config = null;
  try {
    const text = await fs.readFile(configPath, 'utf8');
    config = JSON.parse(text.replace(/^\uFEFF/, ''));
    checks.push({ name: '配置文件可读', ok: true, detail: configPath });
  } catch (error) {
    warnings.push(`配置文件不可读（首次运行会自动创建）：${configPath}：${error.message}`);
  }
  const configuredClient = options.clientPath || (config && config.clientPath) || '';
  if (configuredClient) {
    try {
      const machine = await readPeMachine(configuredClient);
      add('客户端 PE 可读', Boolean(machine), configureMachineDetail(machine));
      add('客户端架构可运行', isSupportedClientMachine(machine), describeMachine(machine));
    } catch (error) {
      add('客户端 PE 可读', false, `${configuredClient}: ${error.message}`);
    }
  } else {
    warnings.push('尚未配置 clientPath（首次运行请在配置文件中填写 CXExam.exe 路径）');
  }

  const elevated = await isElevated();
  checks.push({ name: '当前权限', ok: true, detail: elevated ? '管理员' : '普通用户（仅客户端需要管理员权限时申请 UAC）' });

  try {
    const selected = await chooseBindablePort(DEFAULT_PORT_CANDIDATES);
    add('存在可绑定的调试端口', selected.port > 0, selected.port > 0 ? `建议 ${selected.port}` : '全部候选端口不可用（检查 Windows 排除端口范围）');
  } catch (error) {
    add('存在可绑定的调试端口', false, error.message);
  }

  // 原生客户端选择窗口（PowerShell + WinForms）：只构建控件做冒烟，不显示窗口。
  if (process.platform === 'win32') {
    try {
      const probe = await probeClientSelectionWindow({ timeoutMs: 30000 });
      checks.push({
        name: '原生客户端选择窗口（PowerShell + WinForms）',
        ok: probe.ok,
        detail: probe.ok ? `已构建窗口控件（候选 ${probe.candidateCount}）` : `不可用：${probe.reason}`
      });
      if (!probe.ok) warnings.push(`原生客户端选择窗口不可用：${probe.reason}`);
    } catch (error) {
      checks.push({ name: '原生客户端选择窗口（PowerShell + WinForms）', ok: false, detail: error.message });
      warnings.push(`原生客户端选择窗口探测失败：${error.message}`);
    }
  } else {
    checks.push({ name: '原生客户端选择窗口', ok: true, detail: '非 Windows 平台不使用原生窗口' });
  }

  const report = {
    mode: 'self-check',
    version: '6.2.0',
    host: 'node',
    generatedAt: nowIso(),
    repositoryRoot,
    assetsDir,
    configPath,
    elevated,
    capabilities: { unsupported: UNSUPPORTED_CAPABILITIES, notes: describeUnsupportedCapabilities() },
    checks,
    warnings,
    failures
  };
  logger.info(`[self-check] 失败 ${failures.length} 项，警告 ${warnings.length} 项`);
  if (!options.quiet) console.log(JSON.stringify(report, null, 2));
  return { report, ok: failures.length === 0 };
}

function configureMachineDetail(machine) {
  return machine == null ? '不是 PE 文件或读取失败' : describeMachine(machine);
}

function resolveHostConfigPath(options) {
  if (options.configPath) return path.resolve(options.configPath);
  if (options.dataDirExplicit) return path.join(path.resolve(options.dataDir), 'config.json');
  return defaultConfigPath(repositoryRoot);
}

async function resolvePort(config, options, logger) {
  const configured = validateLaunchPort(options.port !== null ? options.port : config.port);
  if (configured && configured > 0) {
    const bindable = await canBindPort(configured);
    if (!bindable.ok) {
      throw new Error(`配置端口 ${configured} 无法在 127.0.0.1 绑定（${bindable.code}）；请把 port 改为 0 使用自动选择`);
    }
    logger.info(`[launch] 使用配置端口 ${configured}`);
    return configured;
  }
  const selected = await chooseBindablePort(DEFAULT_PORT_CANDIDATES);
  if (!selected.port) {
    throw new Error('没有找到可绑定的调试端口：Windows 排除端口范围或其他进程占用了候选端口');
  }
  for (const rejected of selected.rejected) {
    logger.warn(`[launch] 候选端口 ${rejected.port} 不可用：${rejected.code}`);
  }
  logger.info(`[launch] 自动选择调试端口 ${selected.port}（已用 bind 验证）`);
  return selected.port;
}

async function writeReport(reportPath, report, logger) {
  if (!reportPath) return;
  try {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    logger.info(`[report] 已写入 ${reportPath}`);
  } catch (error) {
    logger.error(`[report] 写入失败：${error.message}`);
  }
}

async function main() {
  const nodeMajor = Number.parseInt(String(process.versions.node).split('.')[0], 10);
  if (nodeMajor < 22) {
    console.error(`[windows-host] 需要 Node.js 22 或更高版本（内置 fetch/WebSocket），当前 ${process.versions.node}`);
    process.exitCode = 2;
    return;
  }
  if (typeof WebSocket !== 'function' || typeof fetch !== 'function') {
    console.error('[windows-host] 当前 Node.js 缺少内置 WebSocket/fetch，请升级到 Node.js 22+');
    process.exitCode = 2;
    return;
  }
  let options;
  let cliOptions;
  try {
    cliOptions = parseHostArgs(process.argv.slice(2), { startup: true });
    options = cliOptions;
    const optionJson = options.optionsJsonFile
      ? await readOptionalJson(path.resolve(options.optionsJsonFile), '--options-json 配置', { allowMissing: false })
      : (options.optionsJson ? JSON.parse(options.optionsJson) : null);
    if (optionJson) {
      validateSupportedJsonOptions(optionJson, '--options-json');
      options = applyOptionsJsonToOptions(options, optionJson);
      options.optionsJsonObject = optionJson;
    }
  } catch (error) {
    console.error(`[windows-host] 参数错误：${error.message}\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.version) {
    console.log('6.2.0');
    return;
  }
  if (options.capabilities) {
    console.log(JSON.stringify({
      hostVersion: '6.2.0',
      executionMode: options.executionMode,
      supported: {
        executionModes: ['normal', 'memory'],
        scanner: true,
        parameterGenerator: true,
        nativeClientSelection: process.platform === 'win32',
        configReload: true,
        configPersistence: true,
        fileLogging: true,
        runReport: true,
        pageRenderDiagnostics: true,
        pageScreenshots: true,
        windowDiagnostics: true,
        renderDiagnostics: true,
        retainData: true,
        deleteConfig: true
      },
      unsupported: UNSUPPORTED_CAPABILITIES,
      notes: describeUnsupportedCapabilities()
    }, null, 2));
    return;
  }

  // --hide-console：静默脚本已通过 wscript 隐藏初始控制台；这里兜底隐藏本进程
  // （包括 UAC 提升后的实例）附着的控制台窗口，避免出现持续可见的 Node 黑框。
  // --print-effective-config 需要把 JSON 输出到控制台，因此不隐藏。
  if (options.hideConsole && !options.printEffectiveConfig) {
    await hideConsoleWindow();
  }

  const isConsoleQuiet = () => options.quiet || options.printEffectiveConfig;

  let dataDirectory = options.dataDirExplicit
    ? path.resolve(options.dataDir)
    : path.join(repositoryRoot, 'windows', 'data');
  options.scanCachePath = path.join(dataDirectory, 'scan-cache.json');
  let logger = createLogger({ quiet: isConsoleQuiet() });
  let loggerQuiet = options.quiet;
  let configStoreForCleanup = null;
  let cleanupAfterStartupFailure = null;
  let diagnosticsChanged = () => {};
  const diagnostics = createHostDiagnostics({ onChange: () => diagnosticsChanged() });
  diagnostics.record('host-started');
  let configFailureReported = false;
  const recordConfigFailure = () => {
    if (!configFailureReported) diagnostics.record('config-failed', 'warn');
    configFailureReported = true;
  };
  // --no-retain-data / --delete-config：只清理“本次运行创建的宿主数据”和显式指定的外部配置，
  // 不删除运行前已存在的数据，避免误删用户文件。
  const runArtifacts = { files: new Set(), directories: new Set() };
  const registerNewFile = async (filePath) => {
    const absolute = path.resolve(filePath);
    try {
      await fs.lstat(absolute);
    } catch (error) {
      if (error && error.code === 'ENOENT') runArtifacts.files.add(absolute);
      else throw error;
    }
  };
  let deleteConfigTarget = '';
  const refreshDeleteConfigTarget = () => {
    deleteConfigTarget = options.deleteConfig && options.configPath ? path.resolve(options.configPath) : '';
  };
  let dataLifecycleFinalized = false;
  const finalizeDataLifecycle = async () => {
    if (dataLifecycleFinalized) return;
    dataLifecycleFinalized = true;
    if (options.retainData === false) {
      for (const filePath of runArtifacts.files) {
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
      for (const directory of runArtifacts.directories) {
        await fs.rmdir(directory).catch(() => {});
      }
    }
    if (deleteConfigTarget) {
      await fs.rm(deleteConfigTarget, { force: true }).catch(() => {});
    }
  };

  try {
    if (options.selfCheck) {
      // Self-check is read-only by default (mirroring the native host): it must
      // not create logs/diagnostics/config implicitly. Explicit --log/--report
      // are errors the user asked for; only then do we write files.
      if (!options.noDiskWrite && options.logFileEnabled === true && process.env.CXPLUS_NO_LOG_FILE !== '1') {
        const selfCheckLogPath = path.join(dataDirectory, 'logs', `host-${Date.now()}.log`);
        await registerNewFile(selfCheckLogPath);
        await logger.attachFile(selfCheckLogPath);
      }
      const result = await runSelfCheck(options, logger);
      if (!options.noDiskWrite && options.reportPath) {
        const selfCheckReportPath = path.resolve(options.reportPath);
        await registerNewFile(selfCheckReportPath);
        await writeReport(options.reportPath, result.report, logger);
      }
      process.exitCode = result.ok ? 0 : 1;
      await logger.close();
      await finalizeDataLifecycle();
      return;
    }

    const configPath = resolveHostConfigPath(options);
    const appConfigPath = path.join(repositoryRoot, 'chaoxing-plus.json');
    const defaultHostConfigPathname = options.configPath ? defaultConfigPath(repositoryRoot) : configPath;
    let defaultHostConfig = await readOptionalJson(defaultHostConfigPathname, '默认宿主配置');
    const appConfig = await readOptionalJson(appConfigPath, '同目录配置');
    let selectedConfig = options.configPath
      ? await readOptionalJson(configPath, '--config 配置')
      : {};
    validateSupportedJsonOptions(appConfig, '同目录配置');
    validateSupportedJsonOptions(defaultHostConfig, '默认宿主配置');
    if (options.configPath) validateSupportedJsonOptions(selectedConfig, '--config 配置');
    const inlineConfig = options.optionsJsonObject || {};
    const resolveLayeredOptions = () => applyHostOptionLayers(
      cliOptions,
      defaultHostConfig,
      appConfig,
      selectedConfig,
      inlineConfig
    );
    options = resolveLayeredOptions();
    options.optionsJsonObject = inlineConfig;
    if (loggerQuiet !== isConsoleQuiet()) {
      await logger.close();
      logger = createLogger({ quiet: isConsoleQuiet() });
      loggerQuiet = isConsoleQuiet();
    }
    if (options.elevateOnStart && !options.attachPort && !options.listClients) {
      if (process.platform !== 'win32') throw new Error('--elevate-on-start 需要 Windows');
      if (!(await isElevated())) {
        if (options.elevated) throw new Error('管理员重启未获得提升后的权限，停止重复申请 UAC');
        logger.info('[launch] --elevate-on-start：正在通过系统 UAC 请求管理员宿主，确认后继续扫描和选择');
        await relaunchElevated({
          scriptPath: hostScriptPath,
          args: options.rawArgs,
          cwd: process.cwd(),
          windowStyle: options.hideConsole ? 'Hidden' : 'Normal'
        });
        await logger.close();
        return;
      }
    }
    refreshDeleteConfigTarget();
    dataDirectory = options.dataDirExplicit
      ? path.resolve(options.dataDir)
      : path.join(repositoryRoot, 'windows', 'data');
    options.scanCachePath = path.join(
      dataDirectory,
      'scan-cache.json'
    );
    if (loggerQuiet !== isConsoleQuiet()) {
      await logger.close();
      logger = createLogger({ quiet: isConsoleQuiet() });
      loggerQuiet = isConsoleQuiet();
    }

    let selectedConfigCreated = false;
    if (!options.noDiskWrite && !options.printEffectiveConfig && options.attachPort) {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
    } else if (!options.noDiskWrite && !options.printEffectiveConfig) {
      selectedConfigCreated = await ensureConfigFile(repositoryRoot, configPath, (message) => logger.info(message));
      if (selectedConfigCreated) runArtifacts.files.add(configPath);
    }
    if (selectedConfigCreated) {
      const createdLayer = await readOptionalJson(configPath, '宿主默认配置', { allowMissing: false });
      validateSupportedJsonOptions(createdLayer, '宿主默认配置');
      if (options.configPath) selectedConfig = createdLayer;
      else defaultHostConfig = createdLayer;
      options = resolveLayeredOptions();
      options.optionsJsonObject = inlineConfig;
      refreshDeleteConfigTarget();
      dataDirectory = options.dataDirExplicit
        ? path.resolve(options.dataDir)
        : path.join(repositoryRoot, 'windows', 'data');
      options.scanCachePath = path.join(
        dataDirectory,
        'scan-cache.json'
      );
      if (loggerQuiet !== isConsoleQuiet()) {
        await logger.close();
        logger = createLogger({ quiet: isConsoleQuiet() });
        loggerQuiet = isConsoleQuiet();
      }
    }
    if (!options.noDiskWrite && !options.printEffectiveConfig) await registerNewFile(configPath);
    const configStore = createConfigStore(configPath, {
      logger: (message) => logger.info(message),
      persistEnabled: !options.noDiskWrite,
      onError: recordConfigFailure
    });
    configStoreForCleanup = configStore;
    await configStore.load();
    const mergedConfig = mergeHostConfigLayers({
      defaultHostConfig,
      appConfig,
      selectedConfig: options.configPath ? selectedConfig : {},
      loadedConfig: configStore.config,
      inlineConfig
    });
    configStore.replaceFromDisk(mergedConfig);
    const config = configStore.config;
    applyHostOptionsToConfig(config, options);
    const configuredLogging = config.settings['common.settings.windows-log-enabled'] !== false;
    const loggingEnabled = options.noDiskWrite
      ? false
      : (options.logFileEnabled === undefined ? configuredLogging : options.logFileEnabled);
    config.settings['common.settings.windows-no-disk-write'] = options.noDiskWrite;
    config.settings['common.settings.windows-log-enabled'] = loggingEnabled;
    if (options.printEffectiveConfig) {
      // 与原生 --print-effective-config 对齐：只输出合并后的共享设置 JSON，
      // 不扫描、不启动客户端、不申请 UAC、不写日志/配置/报告。
      process.stdout.write(`${JSON.stringify(config.settings)}\n`);
      await configStore.close();
      await logger.close();
      return;
    }
    if (loggingEnabled && process.env.CXPLUS_NO_LOG_FILE !== '1') {
      const logFilePath = path.join(dataDirectory, 'logs', `host-${Date.now()}.log`);
      await registerNewFile(logFilePath);
      await logger.attachFile(logFilePath);
    }
    if (options.clientPath) config.clientPath = path.resolve(options.clientPath);
    if (config.clientPath) {
      const resolvedExplicitClient = await resolveExplicitClientPath(config.clientPath);
      if (resolvedExplicitClient) {
        if (resolvedExplicitClient !== config.clientPath) {
          logger.info(`[client] 显式客户端目录已解析为：${resolvedExplicitClient}`);
        }
        config.clientPath = resolvedExplicitClient;
      }
    }
    if (options.stopClientOnExit) config.stopClientOnExit = true;
    if (options.dpiAware) config.dpiAwareness = 'system';

    if (!options.attachPort) {
      if (!options.noDiskWrite && !options.noScanCache) await registerNewFile(options.scanCachePath);
      let listedCandidates = null;
      const listStartedAt = nowIso();
      const selectedClientPath = await resolveClientSelection(options, config, logger, {
        onListCandidates: (candidates) => { listedCandidates = candidates; }
      });
      if (options.listClients) {
        if (!options.noDiskWrite && options.reportPath) {
          const listFinishedAt = nowIso();
          await writeReport(options.reportPath, {
            mode: 'list-clients',
            version: '6.2.0',
            host: 'node',
            stopReason: 'list-clients',
            startedAt: listStartedAt,
            finishedAt: listFinishedAt,
            durationMs: Math.max(0, Date.parse(listFinishedAt) - Date.parse(listStartedAt)),
            scanMode: options.scanMode,
            success: true,
            total: Array.isArray(listedCandidates) ? listedCandidates.length : 0,
            candidates: listedCandidates || []
          }, logger);
        }
        await configStore.close();
        await logger.close();
        await finalizeDataLifecycle();
        return;
      }
      if (selectedClientPath === null) {
        await configStore.close();
        await logger.close();
        await finalizeDataLifecycle();
        return;
      }
      if (selectedClientPath) config.clientPath = selectedClientPath;
    }

    const assetsDir = options.assetsDir || path.join(repositoryRoot, 'dist-windows');
    const assets = await loadAssets(assetsDir, logger);
    const instanceToken = `${Date.now()}-${process.pid}`;
    const diagnosticsStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const diagnosticsDirectory = options.diagnosticsDir
      || path.join(dataDirectory, 'diagnostics', diagnosticsStamp);
    const diagnosticsEnabled = !options.noDiskWrite
      && (options.diagnose === true || (!options.attachPort && !options.noDiagnose));
    if (diagnosticsEnabled) {
      try {
        await fs.lstat(diagnosticsDirectory);
      } catch (error) {
        if (error && error.code === 'ENOENT') runArtifacts.directories.add(path.resolve(diagnosticsDirectory));
        else throw error;
      }
      for (const name of ['render-diagnostics.json', 'render-diagnostics-window.png', 'render-diagnostics-page.png']) {
        await registerNewFile(path.join(diagnosticsDirectory, name));
      }
    }
    const panelDiagnosticsEnabled = config.settings['common.settings.windows-panel-enabled'] !== false;
    const sessions = new Map();
    const sessionHistory = [];
    const report = {
      mode: options.attachPort ? 'attach' : 'launch',
      version: '6.2.0',
      host: 'node',
      executionMode: options.executionMode,
      startedAt: nowIso(),
      finishedAt: '',
      configPath,
      assetsDir,
      assetsVersion: assets.version,
      clientPath: config.clientPath,
      clientPid: 0,
      port: options.attachPort || 0,
      endpoint: null,
      ownershipVerified: false,
      targets: [],
      totals: { contexts: 0, bootstraps: 0, bundles: 0, configSyncs: 0, errors: 0 },
      diagnostics: {
        enabled: diagnosticsEnabled,
        directory: diagnosticsDirectory,
        system: null,
        windowScreenshot: null,
        pageScreenshots: [],
        dpiDiagnosis: null,
        pageDiagnosis: null,
        samples: []
      }
    };
    if (diagnosticsEnabled) {
      logger.info(`[diagnostics] 渲染诊断已开启：${panelDiagnosticsEnabled ? 'DPI/窗口/面板样式/截图' : 'DPI/窗口/截图'}将写入 ${diagnosticsDirectory}`);
      if (panelDiagnosticsEnabled) {
        logger.info('[diagnostics] 若仍是“悬浮窗附近模糊”，运行后请把 render-diagnostics*.json/png 与日志一起反馈');
      }
    }

    let clientChild = null;
    let detachClientProcessObserver = null;
    let stopping = false;
    let configWatcherOff = null;
    let targetTimer = null;
    let diagnosticsDone = null;
    let diagnosticBroadcastRunning = false;
    let diagnosticBroadcastDirty = false;
    const broadcastMemoryDiagnostics = async () => {
      if (stopping) return;
      diagnosticBroadcastDirty = true;
      if (diagnosticBroadcastRunning) return;
      diagnosticBroadcastRunning = true;
      try {
        do {
          diagnosticBroadcastDirty = false;
          for (const session of sessions.values()) {
            if (stopping) break;
            await session.broadcastDiagnostics().catch(() => false);
          }
        } while (diagnosticBroadcastDirty && !stopping);
      } finally { diagnosticBroadcastRunning = false; }
    };
    diagnosticsChanged = () => { void broadcastMemoryDiagnostics(); };

    const broadcastConfig = async () => {
      for (const session of sessions.values()) {
        await session.broadcastConfig().catch((error) => logger.warn(`[main] 广播配置失败：${error.message}`));
      }
    };

    const applyRuntimePolicies = (nextConfig, nextOptions) => {
      const resolved = applyHostOptionsToConfig(nextConfig, { ...nextOptions, noDiskWrite: options.noDiskWrite });
      resolved.noDiskWrite = options.noDiskWrite;
      resolved.settings['common.settings.windows-no-disk-write'] = options.noDiskWrite;
      resolved.settings['common.settings.windows-log-enabled'] = loggingEnabled;
      return resolved;
    };
    const runtimeOptionOverrides = applyHostOptionsToConfig(
      { settings: {} }, applyHostOptionLayers(cliOptions, inlineConfig)
    ).settings;

    const collectStats = () => {
      report.targets = sessionHistory.slice();
      report.totals = report.targets.reduce((totals, stats) => ({
        contexts: totals.contexts + stats.contexts,
        bootstraps: totals.bootstraps + stats.bootstraps,
        bundles: totals.bundles + stats.bundles,
        configSyncs: totals.configSyncs + stats.configSyncs,
        errors: totals.errors + stats.errors.length
      }), { contexts: 0, bootstraps: 0, bundles: 0, configSyncs: 0, errors: 0 });
    };

    const stop = async (reason, forceStopClient = false) => {
      if (stopping) return;
      stopping = true;
      diagnosticsChanged = () => {};
      logger.info(`[main] 停止：${reason}`);
      if (detachClientProcessObserver) {
        detachClientProcessObserver();
        detachClientProcessObserver = null;
      }
      if (clientChild && typeof clientChild.disconnect === 'function') clientChild.disconnect();
      if (targetTimer) clearInterval(targetTimer);
      if (configWatcherOff) configWatcherOff();
      collectStats();
      for (const session of sessions.values()) session.close();
      sessions.clear();
      if (diagnosticsDone) {
        await Promise.race([diagnosticsDone, sleep(4000)]).catch(() => {});
      }
      if (report.diagnostics.enabled && !options.noDiskWrite) {
        await writeDiagnosticsFile(report.diagnostics.directory, report.diagnostics, (message) => logger.info(message));
      }
      if (clientChild && clientChild.exitCode === null
        && (forceStopClient || config.stopClientOnExit || options.stopClientOnExit)) {
        await killProcessTree(clientChild.pid, (message) => logger.info(message));
      }
      report.finishedAt = nowIso();
      await configStore.close();
      if (!options.noDiskWrite && options.reportPath) {
        await registerNewFile(options.reportPath);
        await writeReport(options.reportPath, report, logger);
      }
      if (options.retainData === false) {
        logger.info('[data] --no-retain-data：退出时删除本次运行创建的宿主数据文件');
      }
      if (deleteConfigTarget) {
        logger.info(`[data] --delete-config：退出时删除外部配置 ${deleteConfigTarget}`);
      }
      await logger.close();
      await finalizeDataLifecycle();
      // CLI 安全兜底：CDP/WebSocket 关闭握手异常时避免进程挂住（unref 不阻止正常退出）。
      const forceExitTimer = setTimeout(() => process.exit(process.exitCode ?? 0), 2000);
      forceExitTimer.unref();
    };
    cleanupAfterStartupFailure = () => stop('启动失败，清理本次启动的客户端与注入资源', true);

    // 监听归属校验同时接受本次启动 PID 及其后代链（客户端可能把调试监听交给
    // 子进程）；每个监听 PID 最多一次 PowerShell 父链查询，直接 PID 不查询。
    const listenerOwnershipVerifier = createListenerOwnershipVerifier();
    const verifyEndpointOwnership = async () => {
      if (stopping) return false;
      if (options.attachPort) return true;
      let owner = null;
      try { owner = await getListenerOwnerPid(port); } catch { /* Unknown ownership is rejected below. */ }
      if (stopping) return false;
      const clientPid = clientChild && Number.isInteger(clientChild.pid) && clientChild.pid > 0 ? clientChild.pid : 0;
      const ownership = clientPid
        ? await listenerOwnershipVerifier.verify(owner, clientPid)
        : { verified: false, reason: 'unknown-client', depth: -1 };
      if (stopping) return false;
      if (!ownership.verified) {
        report.ownershipVerified = false;
        for (const session of sessions.values()) session.close();
        sessions.clear();
        throw Object.assign(new Error(`调试端口 ${port} 的监听进程（${owner === null ? '未知' : owner}）不是本次启动的客户端或其子进程（${clientPid || '未知'}，原因：${ownership.reason}）`), { code: 'CX_ENDPOINT_OWNERSHIP' });
      }
      report.ownershipVerified = true;
      return true;
    };

    process.on('SIGINT', () => { void stop('SIGINT'); });
    process.on('SIGTERM', () => { void stop('SIGTERM'); });

    // ---- 启动阶段 ----
    let port = options.attachPort;
    if (!options.attachPort) {
      const clientPath = config.clientPath;
      if (!clientPath) throw new Error(`配置文件缺少 clientPath：${configPath}`);
      if (!isCxExamExecutablePath(clientPath)) throw new Error('客户端文件名必须是 CXExam.exe');
      const machine = await readPeMachine(clientPath);
      if (machine === null) throw new Error(`客户端不是有效 PE 文件：${clientPath}`);
      assertSupportedClientMachine(machine);
      logger.info(`[launch] 客户端：${clientPath}（${describeMachine(machine)}）`);

      const running = await listProcessIdsByName(path.basename(clientPath));
      const foreign = running.filter((pid) => pid !== process.pid);
      if (foreign.length > 0) {
        throw new Error(`检测到已有 CXExam 客户端进程（PID ${foreign.join(', ')}）。为避免连接真实考试会话，请先全部退出`);
      }

      port = await resolvePort(config, options, logger);
      report.port = port;
      if (config.dpiAwareness === 'system') {
        logger.info('[launch] dpiAwareness=system：临时使用 HIGHDPIAWARE 兼容层启动客户端（启动后立即恢复注册表原值）');
      }
      let dpiOverridePrevious;
      let launchError;
      try {
        if (config.dpiAwareness === 'system') {
          dpiOverridePrevious = await setDpiAwarenessOverride(clientPath, (message) => logger.info(message));
        }
        const launch = spawnClient({ exePath: clientPath, port, logger: (message) => logger.info(message) });
        clientChild = launch.child;
        if (launch.started) await launch.started;
        if (Number.isInteger(clientChild.pid) && clientChild.pid > 0) diagnostics.record('client-started');
        detachClientProcessObserver = observeClientProcess(clientChild, {
          onExit: ({ code, signal }) => {
            logger.warn(`[launch] 本次启动的 CXExam 已退出（code=${code === null ? '?' : code}，signal=${signal || '?'}）`);
            if (!stopping) void stop('本次启动的 CXExam 进程已退出');
          },
          onError: (error) => {
            logger.error(`[launch] 启动 CXExam 进程失败：${error && error.message ? error.message : String(error)}`);
            if (!stopping) void stop('本次启动的 CXExam 进程启动失败');
          }
        });
      } catch (error) {
        launchError = error;
      } finally {
        if (dpiOverridePrevious !== undefined) {
          await restoreDpiAwarenessOverride(clientPath, dpiOverridePrevious, (message) => logger.info(message));
        }
      }
      if (launchError) {
        if (clientChild && typeof clientChild.disconnect === 'function') clientChild.disconnect();
        if (launchError.win32Code !== 740) throw launchError;
        if (options.elevated || options.noElevate || await isElevated()) {
          throw new Error('启动客户端需要管理员权限：自动提权已禁用或本轮已申请，请检查权限或 --no-elevate 设置');
        }
        logger.warn('[launch] 客户端普通启动返回 Win32 740，正在通过系统 UAC 重新启动宿主');
        const passthrough = options.rawArgs.filter((argument) => argument !== '--elevated');
        await configStore.close();
        await relaunchElevated({
          scriptPath: hostScriptPath,
          args: passthrough,
          cwd: process.cwd(),
          selectedClientPath: config.clientPath,
          windowStyle: options.hideConsole ? 'Hidden' : 'Normal'
        });
        logger.info('[launch] 已请求管理员实例启动，保留本次选择，当前窗口退出');
        await logger.close();
        await finalizeDataLifecycle();
        return;
      }
      report.clientPid = clientChild.pid;
      logger.info(`[launch] 客户端已启动 pid=${clientChild.pid}，等待调试端点（首次启动通常需要 10-20 秒）`);
      diagnostics.record('endpoint-waiting');
      const endpoint = await waitForDebugEndpoint(port, {
        timeoutMs: config.debugEndpointTimeoutMs,
        child: clientChild,
        fetchJson
      });
      report.endpoint = {
        browser: endpoint.Browser || '',
        protocolVersion: endpoint['Protocol-Version'] || '',
        userAgent: endpoint['User-Agent'] || ''
      };
      logger.info(`[launch] 调试端点可用：${report.endpoint.browser}（CDP ${report.endpoint.protocolVersion}）`);
      const expected = String(config.expectedBrowser || 'Chrome/');
      if (expected && !String(report.endpoint.browser).includes(expected)) {
        throw new Error(`调试端点 Browser=${report.endpoint.browser} 与期望 ${expected} 不匹配，可能连接到了其它程序`);
      }
      if (!(await verifyEndpointOwnership())) return;
      diagnostics.record('endpoint-ready');
      logger.info(`[launch] 监听归属校验通过：pid=${clientChild.pid}（或其后代进程），127.0.0.1:${port}`);
    } else {
      logger.warn(`[attach] 测试/调试模式：只连接 127.0.0.1:${port}，不启动客户端、不校验监听归属`);
      diagnostics.record('endpoint-waiting');
      const endpoint = await fetchJson(port, '/json/version', { timeoutMs: 5000 });
      report.endpoint = {
        browser: endpoint.Browser || '',
        protocolVersion: endpoint['Protocol-Version'] || '',
        userAgent: endpoint['User-Agent'] || ''
      };
      logger.info(`[attach] 已连接调试端点：${report.endpoint.browser}（CDP ${report.endpoint.protocolVersion}）`);
      diagnostics.record('endpoint-ready');
    }

    // ---- 注入阶段 ----
    const connectedTargets = new Set();
    const retryingTargets = new Set();
    let targetRefreshFailed = false;
    const pollTargets = async () => {
      if (stopping) return;
      let list;
      try {
        if (!(await verifyEndpointOwnership())) return;
        list = await fetchJson(port, '/json/list', { timeoutMs: 2000 });
      } catch (error) {
        if (!targetRefreshFailed) diagnostics.record('session-retry', 'warn');
        targetRefreshFailed = true;
        logger.warn(`[main] 刷新调试 target 失败：${error.message}`);
        return;
      }
      targetRefreshFailed = false;
      const pages = (Array.isArray(list) ? list : []).filter((target) => target && target.type === 'page' && target.webSocketDebuggerUrl);
      for (const target of pages) {
        const previousSession = sessions.get(target.id);
        if (previousSession && previousSession.closed) {
          sessions.delete(target.id);
          logger.info(`[main] target ${target.id} 仍存在，重新建立已断开的 CDP 会话`);
        }
        if (sessions.has(target.id) || stopping) continue;
        const session = new PageSession({
          port,
          target: { ...target, url: sanitizeUrl(target.url) },
          assets,
          configStore,
          instanceToken,
          injectBlankFrames: config.injectBlankFrames,
          captureConsole: loggingEnabled && config.captureConsole,
          injectStrategy: config.injectStrategy,
          injectRetries: config.injectRetries,
          bundleTimeoutMs: config.bundleTimeoutMs,
          diagnostics,
          logger: { info: (message) => logger.info(message), warn: (message) => logger.warn(message) },
          onConfigSync: (detail, contextId) => {
            try {
              const candidate = mergeHostConfigLayers({
                defaultHostConfig: configStore.snapshot(),
                selectedConfig: { settings: detail },
                inlineConfig
              });
              const nextOptions = applyHostOptionLayers(
                cliOptions, { settings: candidate.settings }, { settings: runtimeOptionOverrides }
              );
              const constrained = applyRuntimePolicies(candidate, nextOptions);
              const correctionNeeded = Object.keys(detail || {}).some((key) =>
                Object.prototype.hasOwnProperty.call(constrained.settings, key)
                && JSON.stringify(detail[key]) !== JSON.stringify(constrained.settings[key]));
              const changed = configStore.updateFromPage(constrained.settings);
              if (changed || correctionNeeded) {
                configFailureReported = false;
                if (session.isTopContext(contextId)) diagnostics.record('config-updated');
                logger.info(`[config] 页面写入共享配置（revision=${configStore.revision}），广播到全部 frame`);
                void broadcastConfig();
              }
            } catch (error) {
              if (session.isTopContext(contextId)) recordConfigFailure();
              logger.warn(`[config] 页面共享配置无效（忽略本次）：${error.message}`);
            }
          },
          onBundleInjected: (contextId, url) => {
            logger.info(`[inject] context=${contextId} bundle 完成（${sanitizeUrl(url) || 'about:blank'}）`);
          }
        });
        sessionHistory.push(session.stats);
        sessions.set(target.id, session);
        try {
          if (!(await verifyEndpointOwnership())) return;
          await session.open();
          if (stopping || session.closed) continue;
          diagnostics.record(connectedTargets.has(target.id) ? 'session-reconnected' : 'session-connected');
          connectedTargets.add(target.id);
          retryingTargets.delete(target.id);
        } catch (error) {
          if (!stopping && !retryingTargets.has(target.id)) {
            diagnostics.record('session-retry', 'warn');
            retryingTargets.add(target.id);
          }
          logger.warn(`[main] 连接 target ${target.id} 失败：${error.message}`);
          session.close();
          if (sessions.get(target.id) === session) sessions.delete(target.id);
          if (error.code === 'CX_ENDPOINT_OWNERSHIP') return;
        }
      }
      const activeIds = new Set(pages.map((target) => target.id));
      for (const [targetId, session] of sessions) {
        if (!activeIds.has(targetId) && !stopping) {
          logger.info(`[main] target 已关闭：${targetId}`);
          session.close();
          sessions.delete(targetId);
          connectedTargets.delete(targetId);
          retryingTargets.delete(targetId);
        }
      }
      collectStats();
    };

    await pollTargets();
    if (stopping) return;
    let targetPollPending = false;
    targetTimer = setInterval(() => {
      if (stopping || targetPollPending) return;
      targetPollPending = true;
      void pollTargets().catch((error) => logger.warn(`[main] target 轮询失败：${error.message}`))
        .finally(() => { targetPollPending = false; });
    }, config.targetPollIntervalMs);

    configWatcherOff = configStore.watch({
      resolveConfig: (raw) => {
        validateSupportedJsonOptions(raw, '热更新配置');
        const requestedExecutionMode = raw.memoryExec === true ? 'memory'
          : raw.memoryExec === false ? 'normal'
          : raw.executionMode;
        if (requestedExecutionMode !== undefined && requestedExecutionMode !== options.executionMode) {
          throw new Error(`热更新配置不能改变 executionMode 启动策略（当前 ${options.executionMode}，需要重启宿主）`);
        }
        const nextDefault = options.configPath ? defaultHostConfig : raw;
        const nextSelected = options.configPath ? raw : {};
        const nextOptions = applyHostOptionLayers(cliOptions, nextDefault, appConfig, nextSelected, inlineConfig);
        if (nextOptions.noDiskWrite !== options.noDiskWrite) {
          logger.warn('[config] noDiskWrite 已按本次启动策略锁定，修改后需要重启宿主才能生效');
        }
        const nextConfig = mergeHostConfigLayers({
          defaultHostConfig: nextDefault,
          appConfig,
          selectedConfig: nextSelected,
          loadedConfig: raw,
          inlineConfig
        });
        return applyRuntimePolicies(nextConfig, nextOptions);
      },
      onChange: () => {
        configFailureReported = false;
        diagnostics.record('config-updated');
        logger.info('[config] 配置文件发生变化，广播到页面');
        void broadcastConfig();
      }
    });

    if (diagnosticsEnabled) {
      diagnosticsDone = (async () => {
        const state = report.diagnostics;
        // 1) 先采集系统/窗口信息：即使注入失败也能看到 DPI、窗口 DPI 感知与客户端命令行。
        const windowShotPath = path.join(diagnosticsDirectory, 'render-diagnostics-window.png');
        const clientProcessName = report.clientPath
          ? path.basename(report.clientPath).replace(/\.exe$/i, '')
          : 'CXExam';
        let system = await collectSystemProbe({
          pid: report.clientPid,
          processName: clientProcessName,
          screenshotPath: windowShotPath,
          logger: (message) => logger.info(message)
        });
        if (stopping) return;
        state.system = system;
        state.windowScreenshot = system && system.windowScreenshot ? system.windowScreenshot : null;
        if (system) {
          logger.info(`[diagnostics] 系统 AppliedDPI=${system.appliedDpi ?? '?'}`
            + `；屏幕=${system.screen && system.screen.bounds ? `${system.screen.bounds.width}x${system.screen.bounds.height}` : '?'}`);
          for (const windowInfo of Array.isArray(system.windows) ? system.windows : []) {
            logger.info(`[diagnostics] 客户端窗口 pid=${windowInfo.processId} class=${windowInfo.className}`
              + ` rect=${windowInfo.rect ? `${windowInfo.rect.width}x${windowInfo.rect.height}` : '?'}`
              + ` windowDpi=${windowInfo.windowDpi} visible=${windowInfo.visible}`);
          }
          for (const processInfo of Array.isArray(system.clientProcesses) ? system.clientProcesses : []) {
            logger.info(`[diagnostics] CXExam pid=${processInfo.processId} cmd=${String(processInfo.commandLine || '').slice(0, 400)}`);
          }
        }
        state.dpiDiagnosis = evaluateDpiDiagnosis(system);
        if (state.dpiDiagnosis.status === 'mismatch') {
          logger.warn(`[diagnostics] ${state.dpiDiagnosis.suggestion}`);
          logger.warn(`[diagnostics] 关键数据：系统 systemDpi=${state.dpiDiagnosis.systemDpi}`
            + `，客户端窗口 windowDpi=${state.dpiDiagnosis.windowDpi}`
            + `，缩放=${state.dpiDiagnosis.scale}x，窗口进程=${state.dpiDiagnosis.windowProcessId}`);
        } else if (state.dpiDiagnosis.status === 'match') {
          logger.info(`[diagnostics] 客户端窗口 DPI 与系统一致（windowDpi=${state.dpiDiagnosis.windowDpi}，systemDpi=${state.dpiDiagnosis.systemDpi}），不会因系统位图缩放发虚`);
        } else {
          logger.warn('[diagnostics] 无法判断客户端窗口 DPI 感知（窗口未找到或探测失败），见 render-diagnostics.json');
        }
        await writeDiagnosticsFile(diagnosticsDirectory, state, (message) => logger.info(message));

        // 2) 等第一个业务 bundle 注入成功后，采样面板渲染状态并保存页面截图。
        const waitStarted = Date.now();
        while (!stopping && Date.now() - waitStarted < 25000) {
          if ([...sessions.values()].some((session) => session.stats.bundles > 0)) break;
          await sleep(500);
        }
        if (stopping) return;

        // 客户端主窗口在启动早期可能还没创建（CEF 通常启动后 5-15 秒才出现），
        // 等业务 bundle 注入成功后再重试窗口探测，保证 DPI 诊断与窗口截图可用。
        if (!options.attachPort && (!Array.isArray(system.windows) || system.windows.length === 0)) {
          const retryStarted = Date.now();
          while (!stopping && Date.now() - retryStarted < 20000) {
            await sleep(1000);
            const retry = await collectSystemProbe({
              pid: report.clientPid,
              processName: clientProcessName,
              screenshotPath: windowShotPath,
              logger: () => {}
            });
            if (stopping) return;
            if (!Array.isArray(retry.windows) || retry.windows.length === 0) continue;
            system = retry;
            state.system = system;
            state.windowScreenshot = system.windowScreenshot || state.windowScreenshot;
            state.dpiDiagnosis = evaluateDpiDiagnosis(system);
            if (state.dpiDiagnosis.status === 'mismatch') {
              logger.warn(`[diagnostics] ${state.dpiDiagnosis.suggestion}`);
            } else if (state.dpiDiagnosis.status === 'match') {
              logger.info(`[diagnostics] 客户端窗口 DPI 与系统一致（windowDpi=${state.dpiDiagnosis.windowDpi}，systemDpi=${state.dpiDiagnosis.systemDpi}）`);
            }
            for (const windowInfo of system.windows) {
              logger.info(`[diagnostics] 客户端窗口 pid=${windowInfo.processId}`
                + ` rect=${windowInfo.rect ? `${windowInfo.rect.width}x${windowInfo.rect.height}` : '?'}`
                + ` windowDpi=${windowInfo.windowDpi} visible=${windowInfo.visible}`);
            }
            await writeDiagnosticsFile(diagnosticsDirectory, state, (message) => logger.info(message));
            break;
          }
        }

        for (let index = 0; index < 4 && !stopping; index += 1) {
          if (index > 0) await sleep(2000);
          const session = [...sessions.values()].find((item) => item.stats.bundles > 0);
          if (!session) continue;
          const contextId = session.getTopContextId();
          if (!contextId) continue;
          let rawValue = null;
          try {
            const result = await session.evaluateReturnByValue(contextId, RENDER_DIAGNOSTICS_EXPRESSION);
            rawValue = result ? result.value : null;
          } catch (error) {
            logger.warn(`[diagnostics] 页面采样失败：${error.message}`);
          }
          const sample = normalizeDiagnosticsSample(rawValue);
          state.samples.push({
            index,
            at: new Date().toISOString(),
            targetId: session.stats.targetId,
            contextId,
            sample
          });
          logger.info(`[diagnostics] 采样 #${index + 1}：${summarizeRenderDiagnostics(sample, { includePanel: panelDiagnosticsEnabled })}`);
          if (index === 0) {
            const screenshot = await session.captureScreenshot();
            if (stopping) return;
            const savedPath = await writeScreenshot(
              diagnosticsDirectory,
              'render-diagnostics-page.png',
              screenshot,
              (message) => logger.info(message)
            );
            if (savedPath) state.pageScreenshots.push(savedPath);
          }
          await writeDiagnosticsFile(diagnosticsDirectory, state, () => {});
        }

        const validSample = state.samples
          .map((entry) => entry.sample)
          .find((item) => item && !item.error) || null;
        state.pageDiagnosis = panelDiagnosticsEnabled
          ? evaluatePageDiagnosis(validSample)
          : { status: 'disabled', findings: [] };
        if (panelDiagnosticsEnabled) {
          for (const finding of state.pageDiagnosis.findings) {
            logger.warn(`[diagnostics] 页面可疑项 ${finding.code}：${finding.detail}`);
          }
          if (!state.pageDiagnosis.findings.length) {
            logger.info('[diagnostics] 页面采样未发现面板亚像素定位 / backdrop 模糊 / transform 缩放问题');
          }
        }
        await writeDiagnosticsFile(diagnosticsDirectory, state, (message) => logger.info(message));
      })().catch((error) => logger.warn(`[diagnostics] 渲染诊断任务失败：${error.message}`));
    }

    logger.info('[main] 注入循环已启动：按 Ctrl+C 停止');
    if (!options.quiet) {
      console.log('[windows-host] 正在注入。请观察上面的 [inject] 日志；按 Ctrl+C 停止。');
    }

    if (options.durationMs > 0) {
      await sleep(options.durationMs);
      await stop(`duration=${options.durationMs}ms 到期`);
    } else {
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (stopping) {
            clearInterval(timer);
            resolve();
          }
        }, 200);
      });
      if (!report.finishedAt) await stop('main loop exited');
    }

    const bundles = report.totals.bundles;
    if (bundles === 0) {
      logger.warn('[main] 本次没有完成任何业务 bundle 注入（可能没有页面 target 或总开关关闭）');
      process.exitCode = 5;
    } else {
      logger.info(`[main] 完成：${bundles} 个 bundle、${report.totals.bootstraps} 个 bootstrap、${report.totals.configSyncs} 次配置同步`);
    }
  } catch (error) {
    if (options.quiet && error.code === 'ERR_UNSUPPORTED_HOST_OPTION') {
      console.error(`[windows-host] 参数错误：${error.message}`);
    }
    logger.error(`[main] 失败：${error.message}`);
    process.exitCode = 3;
    if (cleanupAfterStartupFailure) {
      await cleanupAfterStartupFailure().catch((cleanupError) => {
        logger.error(`[main] 启动失败清理异常：${cleanupError.message}`);
      });
    } else if (configStoreForCleanup) {
      await configStoreForCleanup.close().catch(() => {});
    }
    await logger.close();
    await finalizeDataLifecycle();
  }
}

main().catch((error) => {
  console.error(`[windows-host] 未捕获错误：${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
