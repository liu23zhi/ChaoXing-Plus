import path from 'node:path';
import { createInterface as defaultCreateInterface } from 'node:readline/promises';

import { describeMachine, readPeMachine } from './launch.mjs';
import { parseClientSelectionInput } from './options.mjs';
import { isCxExamExecutablePath, findPreferredClientIndex, discoverClientCandidates, resolveExplicitClientPath } from './client-discovery.mjs';
import { showClientSelectionWindow } from './selection-window.mjs';

export async function resolveClientSelection(options, config, {
  logger = { info() {}, warn() {} },
  discover = discoverClientCandidates,
  showWindow = showClientSelectionWindow,
  readMachine = readPeMachine,
  assertMachine = () => {},
  parseInput = parseClientSelectionInput,
  createInterface = defaultCreateInterface,
  stdinIsTTY = Boolean(process.stdin && process.stdin.isTTY),
  stdoutIsTTY = Boolean(process.stdout && process.stdout.isTTY),
  platform = process.platform,
  stdout = process.stdout,
  scanCachePath = '',
  cacheFs,
  cacheTtlMs,
  onCacheEvent = () => {}
} = {}) {
  if (options.clientPath) return config.clientPath || options.clientPath;
  if (!options.scanClients && options.clientIndex === null && !options.selectClient && !options.clientFirst && options.ui !== 'cli' && options.ui !== 'gui' && config.clientPath) {
    return config.clientPath;
  }

  const interactive = Boolean(stdinIsTTY && stdoutIsTTY);
  const autoWindowRequested = options.ui === 'auto' && platform === 'win32' && !interactive
    && !options.quiet && !options.clientFirst && options.clientIndex === null && !options.listClients;
  const nativeSelectionRequested = options.ui === 'gui' || options.selectClient || autoWindowRequested;
  if (options.ui === 'gui' && platform !== 'win32') {
    throw new Error('--ui gui 需要 Windows 原生选择窗口；当前平台不支持，请使用 --ui cli 或 --ui auto');
  }
  const terminalPromptRequested = options.clientIndex === null && !options.clientFirst && options.ui === 'cli'
    || (options.clientIndex === null && !options.clientFirst && options.ui === 'auto' && interactive);
  const mayPrompt = nativeSelectionRequested || (interactive && terminalPromptRequested);

  logger.info('[client] 正在扫描常见安装目录（根目录及一级子目录）');
  const scanResult = await discover({
    scanMode: options.scanMode === 'all' ? 'all' : options.scanMode,
    stopOnMachine: options.listClients || mayPrompt || options.clientIndex !== null ? null : 0x014c,
    onFullScan: () => logger.info('[client] 常规路径未找到客户端，开始固定磁盘根目录递归扫描'),
    cachePath: scanCachePath,
    noScanCache: options.noScanCache === true,
    noDiskWrite: options.noDiskWrite === true,
    forceRescan: options.rescan === true,
    ...(cacheFs ? { cacheFs } : {}),
    ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
    onCacheEvent
  });
  const candidates = scanResult.candidates || [];
  const preferredIndex = findPreferredClientIndex(candidates);

  const printCandidates = () => {
    candidates.forEach((candidate, index) => {
      const line = `[client] [${index + 1}] ${candidate.path}（${describeMachine(candidate.machine)}）`;
      if (options.listClients || mayPrompt) stdout.write(`${line}\n`);
      else logger.info(line);
    });
    if (options.listClients && candidates.length === 0) stdout.write('[client] 未扫描到可用的 CXExam.exe\n');
  };
  printCandidates();
  if (options.listClients) return null;

  const resolveSelectedPath = async (selectedPath, { manual = false } = {}) => {
    const absolute = path.resolve(selectedPath);
    const resolved = await resolveExplicitClientPath(absolute, { peMachineReader: readMachine });
    const candidatePath = resolved || absolute;
    if (!isCxExamExecutablePath(candidatePath)) throw new Error('选择的文件名必须是 CXExam.exe，或包含 CXExam.exe 的客户端目录');
    const machine = await readMachine(candidatePath);
    if (machine === null) throw new Error(`选择的文件不是有效 PE 文件：${candidatePath}`);
    assertMachine(machine);
    logger.info(`[client] 通过${manual ? '手动浏览' : '选择界面'}选择：${candidatePath}（${describeMachine(machine)}）`);
    return candidatePath;
  };

  if (nativeSelectionRequested) {
    logger.info(`[client] 打开原生选择窗口（共 ${candidates.length} 个候选）`);
    const autoCloseMs = Number.parseInt(String(process.env.CXPLUS_SELECTION_AUTO_CLOSE_MS || ''), 10);
    const windowResult = await showWindow({
      candidates: candidates.map((candidate) => ({ path: candidate.path, machine: describeMachine(candidate.machine) })),
      preferredIndex,
      ...(Number.isInteger(autoCloseMs) && autoCloseMs > 0 ? { autoCloseMs } : {})
    });
    if (windowResult.status === 'selected') return resolveSelectedPath(windowResult.path, { manual: windowResult.manual });
    if (windowResult.status === 'cancelled') throw new Error('已取消客户端选择，未启动考试客户端');
    logger.warn(`[client] 原生选择窗口不可用：${windowResult.reason || 'unknown'}${options.ui === 'gui' ? '' : '；回退终端提示/推荐候选'}`);
    if (options.ui === 'gui') throw new Error(`无法显示原生选择窗口：${windowResult.reason || 'unknown'}。请检查 PowerShell/WinForms 是否可用，或改用 --ui cli`);
  }

  if (candidates.length === 0) {
    if (!interactive || !terminalPromptRequested) {
      if (options.listClients || (options.quiet && options.clientFirst)) return null;
      throw new Error('未扫描到可用的 CXExam.exe，请使用 --client <path> 手动指定');
    }
    const input = createInterface({ input: process.stdin, output: stdout });
    try {
      const answer = await input.question('未扫描到候选，请输入 CXExam.exe 路径（留空取消）：');
      if (!answer.trim()) return null;
      const selection = parseInput(answer, -1);
      if (!selection.path) throw new Error('未扫描到候选时请输入 CXExam.exe 路径');
      return resolveSelectedPath(selection.path, { manual: true });
    } finally {
      input.close();
    }
  }

  const willPrompt = Boolean(interactive && (options.selectClient || terminalPromptRequested));
  if (!interactive && (options.selectClient || options.ui === 'cli')) {
    logger.warn('[client] 当前不是交互终端，无法显示选择提示；按推荐候选继续（可用 --client/--client-index/--client-first 显式指定）');
  }
  let selectedIndex = options.clientIndex === null ? (preferredIndex >= 0 ? preferredIndex : 0) : options.clientIndex - 1;
  let selectedManualPath = '';
  if (willPrompt) {
    const input = createInterface({ input: process.stdin, output: stdout });
    try {
      const answer = await input.question(`请选择客户端编号（1-${candidates.length}，默认 ${selectedIndex + 1}），或输入 CXExam.exe 路径：`);
      if (answer.trim()) {
        const selection = parseInput(answer, selectedIndex);
        selectedIndex = selection.index;
        if (selection.path) selectedManualPath = path.resolve(selection.path);
      }
    } finally {
      input.close();
    }
  }
  if (selectedManualPath) return resolveSelectedPath(selectedManualPath, { manual: true });
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= candidates.length) {
    throw new Error(`客户端编号无效：${selectedIndex + 1}，可选范围为 1-${candidates.length}`);
  }
  assertMachine(candidates[selectedIndex].machine);
  return candidates[selectedIndex].path;
}
