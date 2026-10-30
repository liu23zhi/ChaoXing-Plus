import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildElevatedRelaunchCommand, hideConsoleWindow } from '../windows/node-source/launch.mjs';
import { parseHostArgs } from '../windows/node-source/options.mjs';

const root = path.resolve('.');
const launcherSource = (name) => path.join(root, 'windows', name.startsWith('start-windows-node') ? 'node-scripts' : 'native-scripts', name);
const silentCmdPath = launcherSource('start-windows-node-silent.cmd');
const silentVbsPath = path.join(root, 'windows', 'node-scripts', 'silent-memory-launch.vbs');
const nodeLaunchers = ['start-windows-node.cmd', 'start-windows-node-debug.cmd', 'start-windows-node-silent.cmd', 'start-windows-node-silent-debug.cmd', 'start-windows-node-silent-no-full-scan-debug.cmd'];
async function symlinkDirectory(target, linkPath) {
  await symlink(target, linkPath, 'junction');
}

function readLauncherArgs(source) {
  // The official launcher keeps its single host option on the wscript line;
  // accept both one-line and caret-continued argument layouts.
  const flattened = source.replace(/\r?\n/gu, ' ').replace(/\s*\^\s*/gu, ' ');
  const marker = flattened.indexOf('main.mjs');
  if (marker < 0) return [];
  return flattened.slice(marker + 'main.mjs'.length).split(/\s+/u).filter((token) => token.startsWith('--'));
}

test('静默启动脚本通过 wscript 隐藏初始 Node 控制台窗口', async () => {
  const cmd = await readFile(silentCmdPath, 'utf8');
  const vbs = await readFile(silentVbsPath, 'utf8');
  assert.match(cmd, /wscript\.exe\s+\/\/nologo\s+"%CXPLUS_ROOT%\\windows\\node-scripts\\silent-memory-launch\.vbs"/u);
  // 不能在前台直接运行 node.exe，否则 cmd/Node 控制台窗口会一直可见。
  assert.doesNotMatch(cmd, /^\s*node(?:\.exe)?\s/mu);
  // cmd 不识别反斜杠转义，内联 JSON 会被原样传递成非法参数。
  assert.doesNotMatch(cmd, /--options-json[^\r\n]*\\"/u);
  // 保留工作目录末尾的点，避免尾反斜杠把闭引号解析为转义引号。
  assert.match(cmd, /"%CXPLUS_ROOT%\\\." "%CXPLUS_ROOT%\\windows\\node-source\\silent-memory-bootstrap\.mjs"/u);
  assert.doesNotMatch(cmd, /wscript\.exe[^\r\n]*"%~dp0"/u);
  assert.match(vbs, /shell\.Run command, 0, False/u);
  // VBS 与 .ps1 一样必须保持纯 ASCII，避免 ANSI 解码破坏脚本。
  assert.equal((vbs.match(/[^\x00-\x7F]/gu) || []).length, 0);

  // 宿主自身也要隐藏控制台并让 UAC 提权重启使用 Hidden 窗口。
  const mainSource = await readFile(path.join(root, 'windows', 'node-source', 'main.mjs'), 'utf8');
  assert.match(mainSource, /if \(options\.hideConsole && !options\.printEffectiveConfig\) \{\s*await hideConsoleWindow\(\);/u);
  assert.match(mainSource, /windowStyle: options\.hideConsole \? 'Hidden' : 'Normal'/u);
  assert.match(mainSource, /--hide-console\s+静默启动/u);
  const launchSource = await readFile(path.join(root, 'windows', 'node-source', 'launch.mjs'), 'utf8');
  assert.match(launchSource, /export async function hideConsoleWindow/u);
  assert.match(launchSource, /ShowWindow\(\$handle, 0\)/u);
});

test('静默启动器保真传递尾反斜杠、引号与空格参数', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-silent-quote-'));
  try {
    const marker = path.join(directory, 'quoted.json');
    const probe = path.join(directory, 'probe quote.mjs');
    await writeFile(
      probe,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n`,
      'utf8'
    );
    // WScript.Arguments 使用 WSH 自己的解析规则，内嵌双引号无法可靠穿越；
    // 官方入口只传 --hide-console 与 %~dp0 派生路径（可含空格），因此覆盖
    // 尾反斜杠、空格路径与尾空格参数即可。
    const tricky = ['--data-dir', directory + '\\', '--report', 'C:\\temp with space\\ report.json ', '--client', 'C:\\tail\\'];
    const result = spawnSync('wscript.exe', ['//nologo', silentVbsPath, directory + '\\', probe, ...tricky], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const deadline = Date.now() + 15000;
    let content = '';
    while (Date.now() < deadline) {
      try {
        content = await readFile(marker, 'utf8');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.notEqual(content, '', '尾反斜杠参数导致隐藏启动器没有运行 Node 脚本');
    const payload = JSON.parse(content);
    assert.equal(path.resolve(payload.cwd), path.resolve(directory), '工作目录的尾反斜杠应被规范化');
    assert.deepEqual(payload.args, tricky, '全部参数必须逐项保真');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('静默入口固定零落盘内存场景：快速扫描后回退、自动首选 x86、无面板/日志/控制台', async () => {
  const cmd = await readFile(silentCmdPath, 'utf8');
  const pairs = [
    ['--hide-console'],
    ['--scan-mode', 'fallback-all'],
    ['--client-first'],
    ['--execution-mode', 'memory'],
    ['--no-disk-write'],
    ['--no-log'],
    ['--quiet'],
    ['--no-panel'],
    ['--answer-mode', 'manual'],
    ['--answer-key', 'Ctrl+Alt+Shift+S'],
    ['--answer-threads', '1'],
    ['--hide-answer-dialog']
  ];
  for (const pair of pairs) {
    assert.equal(cmd.includes(pair.join(' ')), true, `静默入口缺少固定参数 ${pair.join(' ')}`);
  }
  const flat = pairs.flat();
  const options = parseHostArgs(flat);
  assert.equal(options.hideConsole, true);
  assert.equal(options.executionMode, 'memory');
  assert.equal(options.noDiskWrite, true);
  assert.equal(options.logFileEnabled, false);
  assert.equal(options.panelEnabled, false);
  assert.equal(options.quiet, true);
  assert.equal(options.scanMode, 'fallback-all');
  assert.equal(options.clientFirst, true);
  assert.equal(options.answerMode, 'manual');
  assert.equal(options.answerKey, 'Ctrl+Alt+Shift+S');
  assert.equal(options.answerThreads, 1);
  // 静默场景的自毁/全屏/程序删除由 --silent-scenario 固定启用，入口不再单独传
  // --self-destruct* 开关；这里断言解析结果，避免"参数没传=功能没开"的误判。
  const silent = parseHostArgs([...flat, '--silent-scenario']);
  assert.equal(silent.silentScenario, true);
  assert.equal(silent.silentDeleteSimulate, false);
  assert.deepEqual(silent.selfDestructKeys, ['Ctrl+Alt+Shift+E', 'F8']);
  assert.equal(silent.selfDestructOnFullscreenExit, true);
  assert.equal(silent.selfDestructConfirm, false);
  assert.equal(silent.panelEnabled, false);
  assert.equal(silent.noDiskWrite, true);
  assert.equal(silent.scanMode, 'fallback-all');
  // 真正的删除只允许静默入口（debug 入口传 --silent-delete-simulate）。
  assert.doesNotMatch(cmd, /--delete-suspend|--silent-delete-simulate/u);
});

test('静默入口启动前检查必需产物，缺失时询问是否构建', async () => {
  const cmd = await readFile(silentCmdPath, 'utf8');
  for (const required of [
    'windows\\node-source\\main.mjs',
    'windows\\node-source\\silent-memory-bootstrap.mjs',
    'windows\\node-scripts\\silent-memory-launch.vbs',
    'windows\\node-scripts\\launch-client.ps1',
    'dist-windows\\windows-bootstrap.js',
    'dist-windows\\chaoxing-plus.windows.js',
    'dist-windows\\trampoline.js'
  ]) {
    assert.equal(cmd.includes(required), true, `产物检查缺少 ${required}`);
  }
  assert.match(cmd, /choice \/c YN \/n \/m /u);
  assert.match(cmd, /call npm run build:windows -- --release/u);
  // 检查必须发生在隐藏启动之前，否则真删除会先删掉入口依赖的文件。
  assert.ok(cmd.indexOf('call :check_build_output') < cmd.indexOf('wscript.exe //nologo'),
    '产物检查必须在 wscript 隐藏启动之前');
});

test('静默入口缺失产物时拒绝构建会以 9043 退出并列出缺失文件', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-silent-precheck-'));
  try {
    await mkdir(path.join(directory, 'windows', 'node-source'), { recursive: true });
    await writeFile(path.join(directory, 'windows', 'node-source', 'main.mjs'), '// fixture\n', 'utf8');
    const launcher = path.join(directory, 'start-windows-node-silent.cmd');
    await writeFile(launcher, await readFile(silentCmdPath, 'utf8'), 'utf8');
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${launcher}"`], {
      input: 'N\r\n',
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      windowsVerbatimArguments: true,
      cwd: directory
    });
    assert.equal(result.status, 9043, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /required build output is missing/u);
    assert.match(result.stdout, /dist-windows\\windows-bootstrap\.js/u);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('两个静默调试入口只模拟删除并保留控制台', async () => {
  for (const name of ['start-windows-node-silent-debug.cmd', 'start-windows-node-silent-no-full-scan-debug.cmd']) {
    const source = await readFile(launcherSource(name), 'utf8');
    assert.match(source, /type "%CXPLUS_ROOT%\\windows\\node-source\\silent-memory-bootstrap\.mjs" \| node --input-type=module -/u);
    assert.equal(source.includes('--silent-delete-simulate'), true, `${name} 必须模拟删除`);
    assert.equal(source.includes('--silent-scenario'), true, `${name} 必须复用静默场景`);
    assert.equal(source.includes('--no-disk-write'), true, `${name} 不得写盘`);
    // 调试入口需要可见输出：不能传 --quiet，也不能走隐藏启动器。
    assert.doesNotMatch(source, /--quiet/u, `${name} 不得静默输出`);
    assert.doesNotMatch(source, /wscript\.exe|--hide-console/u, `${name} 必须保留控制台`);
  }
  const noFullScan = await readFile(launcherSource('start-windows-node-silent-no-full-scan-debug.cmd'), 'utf8');
  assert.match(noFullScan, /--scan-mode common/u);
  assert.doesNotMatch(noFullScan, /fallback-all/u, '不完整扫描入口不得回退全盘');
  const debug = await readFile(launcherSource('start-windows-node-silent-debug.cmd'), 'utf8');
  assert.match(debug, /--scan-mode fallback-all/u, '默认调试入口保留全盘回退');
});
test('Node 备用入口都先检查 Node.js 22+ 主版本', async () => {
  for (const launcher of ['start-windows-node.cmd', 'start-windows-node-debug.cmd', 'start-windows-node-silent.cmd']) {
    const source = await readFile(launcherSource(launcher), 'utf8');
    assert.match(source, /node --version/u, launcher);
    assert.match(source, /LSS 22/u, launcher);
  }
  const normal = await readFile(launcherSource('start-windows-node.cmd'), 'utf8');
  assert.match(normal, /wscript\.exe \/\/nologo "%CXPLUS_ROOT%\\windows\\node-scripts\\silent-launch\.vbs"/u);
  assert.doesNotMatch(normal, /^\s*node(?:\.exe)?\s/mu, '常规入口不得显示控制台');
  const debug = await readFile(launcherSource('start-windows-node-debug.cmd'), 'utf8');
  assert.match(debug, /node windows\\node-source\\main\.mjs %\*/u, '调试入口必须保留可见控制台');
});

test('迁移后的 Node 调试入口从项目外工作目录以 --help 正常退出', { skip: process.platform !== 'win32' }, () => {
  const launcherPath = launcherSource('start-windows-node-debug.cmd');
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${launcherPath}" --help`], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    windowsVerbatimArguments: true,
    cwd: tmpdir(),
    env: { ...process.env, CXPLUS_NO_LOG_FILE: '1' }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /--capabilities/u, '--help 输出应来自宿主 usage');
});
test('--hide-console 让 UAC 提权重启使用隐藏窗口', () => {
  assert.equal(parseHostArgs([]).hideConsole, false);
  assert.equal(parseHostArgs(['--hide-console']).hideConsole, true);
  const scriptPath = path.resolve('scripts/test-helpers/windows-argv-probe.mjs');
  const normal = buildElevatedRelaunchCommand({ scriptPath, args: [], cwd: 'C:\\Work' });
  assert.match(normal, /-FilePath '[^']*node\.exe'/u);
  assert.match(normal, /-Verb RunAs -WindowStyle Normal$/u);
  const hidden = buildElevatedRelaunchCommand({ scriptPath, args: ['--hide-console'], cwd: 'C:\\Work', windowStyle: 'Hidden' });
  assert.match(hidden, /-Verb RunAs -WindowStyle Hidden$/u);
  assert.match(hidden, /--hide-console/u);
  assert.throws(
    () => buildElevatedRelaunchCommand({ scriptPath, args: [], cwd: 'C:\\Work', windowStyle: 'Invisible' }),
    /不支持的提权重启窗口样式/u
  );
});

test('hideConsoleWindow 在无控制台或非 Windows 环境下安全返回', async () => {
  const hidden = await hideConsoleWindow();
  assert.equal(typeof hidden, 'boolean');
  if (process.platform !== 'win32') assert.equal(hidden, false);
});

test('宿主带 --hide-console 运行不报错（self-check 冒烟）', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-hidden-self-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [
    path.join(root, 'windows', 'node-source', 'main.mjs'),
    '--hide-console',
    '--self-check',
    '--quiet',
    '--no-disk-write',
    '--data-dir', directory,
    '--assets', path.join(root, 'dist-windows')
  ], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, CXPLUS_NO_LOG_FILE: '1' }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('静默启动器以隐藏方式运行 Node 脚本并保真传递参数与工作目录', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-silent-launcher-'));
  try {
    const marker = path.join(directory, 'result.json');
    const probe = path.join(directory, 'probe.mjs');
    await writeFile(
      probe,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));\n`,
      'utf8'
    );
    const result = spawnSync('wscript.exe', ['//nologo', silentVbsPath, directory, probe, '--ui', 'cli', '中文 参数', '--quiet'], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const deadline = Date.now() + 15000;
    let content = '';
    while (Date.now() < deadline) {
      try {
        content = await readFile(marker, 'utf8');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.notEqual(content, '', '隐藏启动器没有运行 Node 脚本');
    const payload = JSON.parse(content);
    assert.equal(path.resolve(payload.cwd), path.resolve(directory));
    assert.deepEqual(payload.args, ['--ui', 'cli', '中文 参数', '--quiet']);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('静默入口产物齐全时直接隐藏启动，并把固定参数交给 launcher', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-silent-ready-'));
  try {
    // 只造出入口要求的文件，launcher 换成记录参数的桩，绝不启动真实宿主。
    for (const relative of [
      'windows\\node-source\\main.mjs',
      'windows\\node-source\\silent-memory-bootstrap.mjs',
      'windows\\node-scripts\\launch-client.ps1',
      'dist-windows\\windows-bootstrap.js',
      'dist-windows\\chaoxing-plus.windows.js',
      'dist-windows\\trampoline.js'
    ]) {
      const target = path.join(directory, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, '// fixture\n', 'utf8');
    }
    const marker = path.join(directory, 'launch-args.txt');
    await writeFile(
      path.join(directory, 'windows\\node-scripts\\silent-memory-launch.vbs'),
      [
        'Option Explicit',
        'Dim args, index, text',
        'text = WScript.Arguments(0)',
        'For index = 1 To WScript.Arguments.Count - 1',
        '  text = text & "|" & WScript.Arguments(index)',
        'Next',
        'Dim fso, stream',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'Set stream = fso.CreateTextFile("' + marker.replace(/\\/gu, '\\\\') + '", True)',
        'stream.Write text',
        'stream.Close',
        'WScript.Quit 0',
        ''
      ].join('\r\n'),
      'utf8'
    );
    const launcher = path.join(directory, 'start-windows-node-silent.cmd');
    await writeFile(launcher, await readFile(silentCmdPath, 'utf8'), 'utf8');
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${launcher}"`], {
      input: '',
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      windowsVerbatimArguments: true,
      cwd: directory
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const deadline = Date.now() + 15000;
    let recorded = '';
    while (Date.now() < deadline) {
      try {
        recorded = await readFile(marker, 'utf8');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.notEqual(recorded, '', '产物齐全时静默入口必须交给隐藏 launcher');
    const tokens = recorded.split('|');
    assert.equal(path.resolve(tokens[0]), directory, '第一项必须是规范化后的工作目录');
    assert.equal(path.resolve(tokens[1]), path.join(directory, 'windows\\node-source\\silent-memory-bootstrap.mjs'));
    for (const expected of ['--hide-console', '--silent-scenario', 'fallback-all', '--client-first', 'memory', '--no-disk-write', '--no-log', '--quiet', '--no-panel', 'Ctrl+Alt+Shift+S']) {
      assert.equal(tokens.includes(expected), true, `launcher 参数缺少 ${expected}`);
    }
    assert.doesNotMatch(recorded, /--silent-delete-simulate/u, '真删除入口不得模拟删除');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('五个入口都优先使用包内自带的 Node 运行时', async () => {
  for (const launcher of [
    ...nodeLaunchers
  ]) {
    const source = await readFile(launcherSource(launcher), 'utf8');
    assert.equal(
      source.includes('if exist "%CXPLUS_ROOT%\\runtime\\node.exe" set "PATH=%CXPLUS_ROOT%\\runtime;%PATH%"'),
      true,
      `${launcher} 必须优先挂载包内 runtime\\node.exe`
    );
    const prepend = source.indexOf('if exist "%CXPLUS_ROOT%\\runtime\\node.exe"');
    const firstNodeUse = [source.indexOf('where node'), source.indexOf('node --version')]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    assert.ok(firstNodeUse > prepend, `${launcher} 必须先挂载自带运行时再检查/运行 node`);
  }
});

test('包内运行时存在时静默入口先挂载它，并且版本检查用的是包内 node.exe', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-silent-runtime-'));
  try {
    for (const relative of [
      'windows\\node-source\\main.mjs',
      'windows\\node-source\\silent-memory-bootstrap.mjs',
      'windows\\node-scripts\\launch-client.ps1',
      'dist-windows\\windows-bootstrap.js',
      'dist-windows\\chaoxing-plus.windows.js',
      'dist-windows\\trampoline.js'
    ]) {
      const target = path.join(directory, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, '// fixture\n', 'utf8');
    }
    // 用目录联接指向真实 node.exe 所在目录：版本检查能通过，又不产生 100MB 拷贝，
    // 也不需要 Program Files 的写权限。
    const runtimeDirectory = path.join(directory, 'runtime');
    await mkdir(runtimeDirectory, { recursive: true });
    await copyFile(process.execPath, path.join(runtimeDirectory, 'node.exe'));
    const marker = path.join(directory, 'launch-env.json');
    await writeFile(
      path.join(directory, 'windows\\node-scripts\\silent-memory-launch.vbs'),
      [
        'Option Explicit',
        'Dim shell, processEnvironment, text',
        'Set shell = CreateObject("WScript.Shell")',
        'Set processEnvironment = shell.Environment("PROCESS")',
        'text = processEnvironment("PATH")',
        'Dim fso, stream',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'Set stream = fso.CreateTextFile("' + marker.replace(/\\/gu, '\\\\') + '", True)',
        'stream.Write text',
        'stream.Close',
        'WScript.Quit 0',
        ''
      ].join('\r\n'),
      'utf8'
    );
    const launcher = path.join(directory, 'start-windows-node-silent.cmd');
    await writeFile(launcher, await readFile(silentCmdPath, 'utf8'), 'utf8');
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${launcher}"`], {
      input: '',
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      windowsVerbatimArguments: true,
      cwd: directory
    });
    if (result.status === 9009) { t.skip('当前环境无法解析包内 node.exe'); return; }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const deadline = Date.now() + 15000;
    let recorded = '';
    while (Date.now() < deadline) {
      try { recorded = await readFile(marker, 'utf8'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.notEqual(recorded, '', 'launcher 必须被调用');
    const firstPathEntry = String(recorded).split(';').find((entry) => entry.trim());
    assert.equal(path.resolve(String(firstPathEntry).trim()), runtimeDirectory,
      'PATH 首项必须是包内 runtime 目录，版本检查才会用到包内 node.exe');
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});





test('原生入口直接运行 chaoxing_plus.exe，不依赖 Node/PowerShell', async () => {
  const nativeLaunchers = [
    'start-windows.cmd',
    'start-windows-debug.cmd',
    'start-windows-silent.cmd',
    'start-windows-silent-debug.cmd',
    'start-windows-silent-no-full-scan-debug.cmd'
  ];
  for (const name of nativeLaunchers) {
    const source = await readFile(launcherSource(name), 'utf8');
    assert.equal(source.includes('chaoxing_plus.exe'), true, `${name} 必须启动原生 EXE`);
    assert.doesNotMatch(source, /^\s*(?:wscript|powershell)(?:\.exe)?\s/im, `${name} 不得执行 wscript/PowerShell`);
    assert.doesNotMatch(source, /^\s*node(?:\.exe)?\s/mu, `${name} 不得直接调用 node`);
    assert.equal(source.includes('\r'), false, `${name} 必须使用 LF 换行`);
  }
  const silent = await readFile(launcherSource('start-windows-silent.cmd'), 'utf8');
  for (const expected of ['--silent-scenario', '--stage-boot', '--no-panel', '--no-log', '--no-disk-write', '--quiet', '--answer-key Ctrl+Alt+Shift+S', '--hide-answer-dialog']) {
    assert.equal(silent.includes(expected), true, `原生静默入口缺少 ${expected}`);
  }
  assert.match(silent, /--hide-answer-dialog\s+%\*/u, '原生静默入口必须把调用方追加参数传给暂存副本');
  const simulate = await readFile(launcherSource('start-windows-silent-debug.cmd'), 'utf8');
  assert.equal(simulate.includes('--silent-delete-simulate'), true);
  assert.doesNotMatch(simulate, /--quiet/u, '调试入口必须保留控制台输出');
  const noFull = await readFile(launcherSource('start-windows-silent-no-full-scan-debug.cmd'), 'utf8');
  assert.match(noFull, /--scan-mode common/u);
  assert.doesNotMatch(noFull, /fallback-all/u, '不完整扫描入口不得回退全盘');
});

test('原生启动脚本只负责启动参数并在启动后保留窗口', async () => {
  const nativeLaunchers = [
    'start-windows.cmd',
    'start-windows-debug.cmd',
    'start-windows-silent.cmd',
    'start-windows-silent-debug.cmd',
    'start-windows-silent-no-full-scan-debug.cmd'
  ];
  for (const name of nativeLaunchers) {
    const source = await readFile(launcherSource(name), 'utf8');
    assert.match(source, /pause/u, `${name} 启动后必须保留窗口`);
    assert.doesNotMatch(source, /echo \[(?:windows|silent-debug)\] (?:Silent mode|If the client|simulate mode|Task Manager|not a release layout)/u,
      `${name} 正常启动路径不应输出额外说明`);
    assert.match(source, /(?:chaoxing_plus\.exe[^\r\n]*|CXPLUS_EXE[^\r\n]*)%\*/u,
      `${name} 必须透传调用方追加参数`);
  }
});

test('原生入口在缺少 chaoxing_plus.exe 时给出中文提示并以 9009 退出', async () => {
  for (const name of ['start-windows.cmd', 'start-windows-debug.cmd', 'start-windows-silent.cmd']) {
    const source = await readFile(launcherSource(name), 'utf8');
    assert.equal(source.includes('未找到 chaoxing_plus.exe') || source.includes('chaoxing_plus.exe is missing'), true, `${name} 缺少提示`);
    assert.equal(source.includes('exit /b 9009'), true, `${name} 缺少 9009 退出码`);
  }
});

