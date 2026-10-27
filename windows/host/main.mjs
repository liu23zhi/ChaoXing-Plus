#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { fetchJson } from './cdp.mjs';
import { PageSession } from './inject.mjs';
import {
  DEFAULT_PORT_CANDIDATES,
  chooseBindablePort,
  canBindPort,
  describeMachine,
  getListenerOwnerPid,
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
import { applyHostOptionsToConfig, applyOptionsJsonToOptions, describeUnsupportedCapabilities, parseClientSelectionInput, parseHostArgs, UNSUPPORTED_CAPABILITIES, validateSupportedJsonOptions } from './options.mjs';
import { probeClientSelectionWindow, showClientSelectionWindow } from './selection-window.mjs';
import {
  discoverClientCandidates,
  findPreferredClientIndex,
  isCxExamExecutablePath
} from './client-discovery.mjs';
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
    '  --client-first       选择扫描结果中的首个推荐客户端（x86 优先）',
    '  --ui <mode>          auto、gui 或 cli；gui/--select-client 使用 Windows 原生选择窗口',
    '  --list-clients       扫描并列出候选客户端后退出',
    '  --select-client      扫描后显示原生选择窗口（含手动浏览）；无窗口时回退终端提示',
    '  --client-index <n>   启动扫描结果中的第 n 个客户端（从 1 开始）',
    '  --rescan             忽略配置客户端路径并重新扫描（当前无扫描缓存）',
    '  --no-scan-cache      禁止扫描缓存（当前宿主尚无扫描缓存）',
    '  --port <n>           固定调试端口（0 = 自动选择可绑定端口）',
    '  --assets <dir>       注入资源目录（默认 dist-windows）',
    '  --duration <ms>      运行指定毫秒后自动退出（测试用）',
    '  --attach <port>      测试/调试：连接已存在的调试端点，不启动、不校验归属',
    '  --report <path>      退出时把运行报告写入指定 JSON 文件',
    '  --self-check         只做环境/资源检查，不启动客户端',
    '  --no-elevate         不自动申请 UAC（非管理员时直接报错）',
    '  --elevated           内部标记：表示当前进程由 UAC 自动重启而来',
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
    '  --panel-theme <name> 主题名称（当前保留内置主题）',
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
    '  --wipe-* / --self-destruct-* 当前未实现，出现即报错，不会静默降级',
    '  --execution-mode normal 仅支持普通运行；内存/删除挂起和清理/自毁参数会报错',
    '  --capabilities       输出机器可读的未实现能力标记（第一阶段 schema 与禁用状态）',
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

async function resolveClientSelection(options, config, logger) {
  if (options.clientPath) return config.clientPath;
  if (!options.scanClients && options.clientIndex === null && !options.selectClient && !options.clientFirst && options.ui !== 'cli' && options.ui !== 'gui' && config.clientPath) {
    return config.clientPath;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const nativeSelectionRequested = options.ui === 'gui' || options.selectClient;
  if (options.ui === 'gui' && process.platform !== 'win32') {
    throw new Error('--ui gui 需要 Windows 原生选择窗口；当前平台不支持，请使用 --ui cli 或 --ui auto');
  }
  const terminalPromptRequested = options.clientIndex === null && !options.clientFirst
    && (options.ui === 'cli' || (options.ui === 'auto' && interactive));
  // GUI 窗口 / --select-client / 列表 / 指定序号 / 终端提示都可能需要完整候选列表。
  const mayPrompt = nativeSelectionRequested || (interactive && terminalPromptRequested);

  logger.info('[client] 正在扫描常见安装目录（根目录及一级子目录）');
  const scanMode = options.scanMode === 'all' ? 'all' : options.scanMode;
  const scanResult = await discoverClientCandidates({
    scanMode,
    stopOnMachine: options.listClients || mayPrompt || options.clientIndex !== null ? null : 0x014c,
    onFullScan: () => logger.info('[client] 常规路径未找到客户端，开始固定磁盘根目录递归扫描')
  });
  const candidates = scanResult.candidates;
  if (candidates.length === 0) {
    if (options.listClients) {
      logger.info('[client] 未扫描到可用的 CXExam.exe');
      return null;
    }
    throw new Error('未扫描到可用的 CXExam.exe，请使用 --client <path> 手动指定');
  }
  const preferredIndex = findPreferredClientIndex(candidates);

  const printCandidates = () => {
    candidates.forEach((candidate, index) => {
      const line = `[client] [${index + 1}] ${candidate.path}（${describeMachine(candidate.machine)}）`;
      // --list-clients 与选择界面的候选列表本身就是命令目的，即使 --quiet 也必须给出。
      if (options.listClients || mayPrompt) process.stdout.write(`${line}\n`);
      else logger.info(line);
    });
  };
  printCandidates();

  if (options.listClients) {
    return null;
  }

  const resolveSelectedPath = async (selectedPath, { manual = false } = {}) => {
    const absolute = path.resolve(selectedPath);
    if (!isCxExamExecutablePath(absolute)) {
      throw new Error('选择的文件名必须是 CXExam.exe');
    }
    const machine = await readPeMachine(absolute);
    if (machine === null) throw new Error(`选择的文件不是有效 PE 文件：${absolute}`);
    assertSupportedClientMachine(machine);
    logger.info(`[client] 通过${manual ? '手动浏览' : '选择界面'}选择：${absolute}（${describeMachine(machine)}）`);
    return absolute;
  };

  // 原生选择窗口（Windows / PowerShell + WinForms）：--ui gui 强制使用；--select-client 优先使用。
  if (nativeSelectionRequested) {
    logger.info(`[client] 打开原生选择窗口（共 ${candidates.length} 个候选）`);
    const autoCloseMs = Number.parseInt(String(process.env.CXPLUS_SELECTION_AUTO_CLOSE_MS || ''), 10);
    const windowResult = await showClientSelectionWindow({
      candidates: candidates.map((candidate) => ({ path: candidate.path, machine: describeMachine(candidate.machine) })),
      // 测试/调试用：自动关闭窗口，避免自动化环境阻塞在消息循环。
      ...(Number.isInteger(autoCloseMs) && autoCloseMs > 0 ? { autoCloseMs } : {})
    });
    if (windowResult.status === 'selected') {
      return resolveSelectedPath(windowResult.path, { manual: windowResult.manual });
    }
    if (windowResult.status === 'cancelled') {
      throw new Error('已取消客户端选择，未启动考试客户端');
    }
    logger.warn(`[client] 原生选择窗口不可用：${windowResult.reason || 'unknown'}${options.ui === 'gui' ? '' : '；回退终端提示/推荐候选'}`);
    if (options.ui === 'gui') {
      throw new Error(`无法显示原生选择窗口：${windowResult.reason || 'unknown'}。请检查 PowerShell/WinForms 是否可用，或改用 --ui cli`);
    }
  }

  const willPrompt = Boolean(interactive && (options.selectClient || terminalPromptRequested));
  // 非交互终端里 readline.question 不会 settle，直接挂起；此时明确告知并回退到推荐候选。
  if (!interactive && (options.selectClient || options.ui === 'cli')) {
    logger.warn('[client] 当前不是交互终端，无法显示选择提示；按推荐候选继续（可用 --client/--client-index/--client-first 显式指定）');
  }

  let selectedIndex = options.clientIndex === null
    ? (preferredIndex >= 0 ? preferredIndex : 0)
    : options.clientIndex - 1;
  let selectedManualPath = '';
  if (willPrompt) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await input.question(`请选择客户端编号（1-${candidates.length}，默认 ${selectedIndex + 1}），或输入 CXExam.exe 路径：`);
      if (answer.trim()) {
        const selection = parseClientSelectionInput(answer, selectedIndex);
        selectedIndex = selection.index;
        if (selection.path) selectedManualPath = path.resolve(selection.path);
      }
    } finally {
      input.close();
    }
  }

  if (selectedManualPath) {
    return resolveSelectedPath(selectedManualPath, { manual: true });
  }
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= candidates.length) {
    throw new Error(`客户端编号无效：${selectedIndex + 1}，可选范围为 1-${candidates.length}`);
  }
  assertSupportedClientMachine(candidates[selectedIndex].machine);
  return candidates[selectedIndex].path;
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
  checks.push({ name: '当前权限', ok: true, detail: elevated ? '管理员' : '普通用户（正式运行会申请 UAC）' });

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
  const configured = options.port !== null ? options.port : config.port;
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
  try {
    options = parseHostArgs(process.argv.slice(2));
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
  if (options.capabilities) {
    console.log(JSON.stringify({
      hostVersion: '6.2.0',
      executionMode: options.executionMode,
      supported: { executionModes: ['normal'], scanner: true, parameterGenerator: true, nativeClientSelection: process.platform === 'win32' },
      unsupported: UNSUPPORTED_CAPABILITIES,
      notes: describeUnsupportedCapabilities()
    }, null, 2));
    return;
  }

  const dataDirectory = options.dataDirExplicit
    ? path.resolve(options.dataDir)
    : path.join(repositoryRoot, 'windows', 'data');
  const logger = createLogger({ quiet: options.quiet });
  let configStoreForCleanup = null;
  let cleanupAfterStartupFailure = null;
  // --no-retain-data / --delete-config：只清理“本次运行创建的宿主数据”和显式指定的外部配置，
  // 不删除运行前已存在的数据，避免误删用户文件。
  const runArtifacts = { files: new Set(), directories: new Set() };
  const deleteConfigTarget = options.deleteConfig && options.configPath ? path.resolve(options.configPath) : '';
  let dataLifecycleFinalized = false;
  const finalizeDataLifecycle = async () => {
    if (dataLifecycleFinalized) return;
    dataLifecycleFinalized = true;
    if (options.retainData === false) {
      for (const filePath of runArtifacts.files) {
        await fs.rm(filePath, { force: true }).catch(() => {});
      }
      for (const directory of runArtifacts.directories) {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (deleteConfigTarget) {
      await fs.rm(deleteConfigTarget, { force: true }).catch(() => {});
    }
  };

  try {
    if (options.selfCheck) {
      if (!options.noDiskWrite && options.logFileEnabled !== false && process.env.CXPLUS_NO_LOG_FILE !== '1') {
        const selfCheckLogPath = path.join(dataDirectory, 'logs', `host-${Date.now()}.log`);
        await logger.attachFile(selfCheckLogPath);
        runArtifacts.files.add(selfCheckLogPath);
      }
      const result = await runSelfCheck(options, logger);
      if (!options.noDiskWrite && options.reportPath) {
        const selfCheckReportPath = path.resolve(options.reportPath);
        await writeReport(options.reportPath, result.report, logger);
        runArtifacts.files.add(selfCheckReportPath);
      }
      process.exitCode = result.ok ? 0 : 1;
      await logger.close();
      await finalizeDataLifecycle();
      return;
    }

    const configPath = resolveHostConfigPath(options);
    const appConfigPath = path.join(repositoryRoot, 'chaoxing-plus.json');
    const defaultConfigPathname = defaultConfigPath(repositoryRoot);
    const defaultHostConfig = options.configPath
      ? await readOptionalJson(defaultConfigPathname, '默认宿主配置')
      : null;
    const appConfig = await readOptionalJson(appConfigPath, '同目录配置');
    let selectedConfig = {};
    validateSupportedJsonOptions(appConfig, '同目录配置');
    if (defaultHostConfig) validateSupportedJsonOptions(defaultHostConfig, '默认宿主配置');
    if (options.configPath) {
      selectedConfig = await readOptionalJson(configPath, '--config 配置');
      validateSupportedJsonOptions(selectedConfig, '--config 配置');
    }
    let selectedConfigCreated = false;
    if (!options.noDiskWrite && options.attachPort) {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
    } else if (!options.noDiskWrite) {
      selectedConfigCreated = await ensureConfigFile(repositoryRoot, configPath, (message) => logger.info(message));
      if (selectedConfigCreated) runArtifacts.files.add(configPath);
    }
    if (options.configPath && selectedConfigCreated) {
      selectedConfig = await readOptionalJson(configPath, '--config 配置', { allowMissing: false });
      validateSupportedJsonOptions(selectedConfig, '--config 配置');
    }
    const configStore = createConfigStore(configPath, {
      logger: (message) => logger.info(message),
      persistEnabled: !options.noDiskWrite
    });
    configStoreForCleanup = configStore;
    await configStore.load();
    const inlineConfig = options.optionsJsonObject || {};
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
    if (loggingEnabled && process.env.CXPLUS_NO_LOG_FILE !== '1') {
      const logFilePath = path.join(dataDirectory, 'logs', `host-${Date.now()}.log`);
      await logger.attachFile(logFilePath);
      runArtifacts.files.add(logFilePath);
    }
    if (options.clientPath) config.clientPath = path.resolve(options.clientPath);
    if (options.stopClientOnExit) config.stopClientOnExit = true;
    if (options.dpiAware) config.dpiAwareness = 'system';

    if (!options.attachPort) {
      const selectedClientPath = await resolveClientSelection(options, config, logger);
      if (options.listClients) {
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
    if (diagnosticsEnabled) runArtifacts.directories.add(diagnosticsDirectory);
    const panelDiagnosticsEnabled = config.settings['common.settings.windows-panel-enabled'] !== false;
    const sessions = new Map();
    const report = {
      mode: options.attachPort ? 'attach' : 'launch',
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
    let stopping = false;
    let configWatcherOff = null;
    let targetTimer = null;
    let diagnosticsDone = null;

    const broadcastConfig = async () => {
      for (const session of sessions.values()) {
        await session.broadcastConfig().catch((error) => logger.warn(`[main] 广播配置失败：${error.message}`));
      }
    };

    const collectStats = () => {
      report.targets = [...sessions.values()].map((session) => session.stats);
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
      logger.info(`[main] 停止：${reason}`);
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
      if (clientChild && (forceStopClient || config.stopClientOnExit || options.stopClientOnExit)) {
        await killProcessTree(clientChild.pid, (message) => logger.info(message));
      }
      report.finishedAt = nowIso();
      await configStore.close();
      if (!options.noDiskWrite && options.reportPath) {
        runArtifacts.files.add(path.resolve(options.reportPath));
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

    process.on('SIGINT', () => { void stop('SIGINT'); });
    process.on('SIGTERM', () => { void stop('SIGTERM'); });

    // ---- 启动阶段 ----
    let port = options.attachPort;
    if (!options.attachPort) {
      if (!(await isElevated())) {
        if (options.elevated || options.noElevate) {
          throw new Error('启动客户端需要管理员权限：请以管理员身份运行 start-windows.cmd，或去掉 --no-elevate 让宿主自动申请 UAC');
        }
        logger.warn('[launch] 当前不是管理员，正在通过 UAC 重新启动宿主（会弹出系统确认框）');
        const passthrough = options.rawArgs.filter((argument) => argument !== '--elevated');
        await relaunchElevated({ scriptPath: hostScriptPath, args: passthrough, cwd: process.cwd() });
        logger.info('[launch] 已请求管理员实例启动，当前窗口退出');
        await logger.close();
        await finalizeDataLifecycle();
        return;
      }

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
      try {
        if (config.dpiAwareness === 'system') {
          dpiOverridePrevious = await setDpiAwarenessOverride(clientPath, (message) => logger.info(message));
        }
        clientChild = spawnClient({ exePath: clientPath, port, logger: (message) => logger.info(message) }).child;
      } finally {
        if (dpiOverridePrevious !== undefined) {
          await restoreDpiAwarenessOverride(clientPath, dpiOverridePrevious, (message) => logger.info(message));
        }
      }
      report.clientPid = clientChild.pid;
      logger.info(`[launch] 客户端已启动 pid=${clientChild.pid}，等待调试端点（首次启动通常需要 10-20 秒）`);
      const endpoint = await waitForDebugEndpoint(port, {
        timeoutMs: 30000,
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
      const owner = await getListenerOwnerPid(port);
      if (owner !== clientChild.pid) {
        throw new Error(`调试端口 ${port} 的监听进程（${owner === null ? '未知' : owner}）不是本次启动的客户端（${clientChild.pid}）`);
      }
      report.ownershipVerified = true;
      logger.info(`[launch] 监听归属校验通过：pid=${owner}，127.0.0.1:${port}`);
    } else {
      logger.warn(`[attach] 测试/调试模式：只连接 127.0.0.1:${port}，不启动客户端、不校验监听归属`);
      const endpoint = await fetchJson(port, '/json/version', { timeoutMs: 5000 });
      report.endpoint = {
        browser: endpoint.Browser || '',
        protocolVersion: endpoint['Protocol-Version'] || '',
        userAgent: endpoint['User-Agent'] || ''
      };
      logger.info(`[attach] 已连接调试端点：${report.endpoint.browser}（CDP ${report.endpoint.protocolVersion}）`);
    }

    // ---- 注入阶段 ----
    const pollTargets = async () => {
      if (stopping) return;
      let list;
      try {
        list = await fetchJson(port, '/json/list', { timeoutMs: 2000 });
      } catch (error) {
        logger.warn(`[main] 读取 /json/list 失败：${error.message}`);
        return;
      }
      const pages = (Array.isArray(list) ? list : []).filter((target) => target && target.type === 'page' && target.webSocketDebuggerUrl);
      for (const target of pages) {
        if (sessions.has(target.id) || stopping) continue;
        const session = new PageSession({
          port,
          target: { ...target, url: sanitizeUrl(target.url) },
          assets,
          configStore,
          instanceToken,
          injectBlankFrames: config.injectBlankFrames,
          captureConsole: loggingEnabled && config.captureConsole,
          logger: { info: (message) => logger.info(message), warn: (message) => logger.warn(message) },
          onConfigSync: (detail) => {
            const changed = configStore.updateFromPage(detail);
            if (changed) {
              logger.info(`[config] 页面写入共享配置（revision=${configStore.revision}），广播到全部 frame`);
              void broadcastConfig();
            }
          },
          onBundleInjected: (contextId, url) => {
            logger.info(`[inject] context=${contextId} bundle 完成（${sanitizeUrl(url) || 'about:blank'}）`);
          }
        });
        sessions.set(target.id, session);
        try {
          await session.open();
        } catch (error) {
          logger.warn(`[main] 连接 target ${target.id} 失败：${error.message}`);
          session.close();
          sessions.delete(target.id);
        }
      }
      const activeIds = new Set(pages.map((target) => target.id));
      for (const [targetId, session] of sessions) {
        if (!activeIds.has(targetId) && !stopping) {
          logger.info(`[main] target 已关闭：${targetId}`);
          session.close();
          sessions.delete(targetId);
        }
      }
      collectStats();
    };

    await pollTargets();
    targetTimer = setInterval(() => { void pollTargets(); }, 1000);

    configWatcherOff = configStore.watch({
      onChange: () => {
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
