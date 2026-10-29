import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildElevatedRelaunchCommand, hideConsoleWindow } from '../windows/host/launch.mjs';
import { parseHostArgs } from '../windows/host/options.mjs';

const root = path.resolve('.');
const silentCmdPath = path.join(root, 'start-windows-silent.cmd');
const silentVbsPath = path.join(root, 'windows', 'host', 'silent-launch.vbs');

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
  assert.match(cmd, /wscript\.exe\s+\/\/nologo\s+"%~dp0windows\\host\\silent-launch\.vbs"/u);
  // 不能在前台直接运行 node.exe，否则 cmd/Node 控制台窗口会一直可见。
  assert.doesNotMatch(cmd, /^\s*node(?:\.exe)?\s/mu);
  // cmd 不识别反斜杠转义，内联 JSON 会被原样传递成非法参数。
  assert.doesNotMatch(cmd, /--options-json[^\r\n]*\\"/u);
  // "%~dp0" 以反斜杠结尾，直接加闭引号会让 \" 变成转义引号；用 "%~dp0." 表示工作目录。
  assert.match(cmd, /"%~dp0\." "%~dp0windows\\host\\main\.mjs"/u);
  assert.doesNotMatch(cmd, /wscript\.exe[^\r\n]*"%~dp0"/u);
  assert.match(vbs, /shell\.Run command, 0, False/u);
  // VBS 与 .ps1 一样必须保持纯 ASCII，避免 ANSI 解码破坏脚本。
  assert.equal((vbs.match(/[^\x00-\x7F]/gu) || []).length, 0);
  assert.equal((cmd.match(/[^\x00-\x7F]/gu) || []).length, 0);

  // 宿主自身也要隐藏控制台并让 UAC 提权重启使用 Hidden 窗口。
  const mainSource = await readFile(path.join(root, 'windows', 'host', 'main.mjs'), 'utf8');
  assert.match(mainSource, /if \(options\.hideConsole && !options\.printEffectiveConfig\) \{\s*await hideConsoleWindow\(\);/u);
  assert.match(mainSource, /windowStyle: options\.hideConsole \? 'Hidden' : 'Normal'/u);
  assert.match(mainSource, /--hide-console\s+静默启动/u);
  const launchSource = await readFile(path.join(root, 'windows', 'host', 'launch.mjs'), 'utf8');
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

test('官方静默启动入口只隐藏控制台，不强制客户端/面板/磁盘策略', async () => {
  const cmd = await readFile(silentCmdPath, 'utf8');
  const args = readLauncherArgs(cmd);
  assert.deepEqual(args, ['--hide-console'], '静默入口只允许隐藏控制台开关');
  const options = parseHostArgs(args);
  assert.equal(options.hideConsole, true);
  assert.equal(options.noDiskWrite, false);
  assert.equal(options.noDiagnose, false);
  assert.ok(!options.clientIndex);
  assert.ok(!options.clientPath);
  assert.doesNotMatch(cmd, /--client-index|--no-panel|--no-disk-write|--no-log|--no-diagnose/u);
});

test('两个启动脚本都先检查 Node.js 22+ 主版本', async () => {
  for (const launcher of ['start-windows.cmd', 'start-windows-silent.cmd']) {
    const source = await readFile(path.join(root, launcher), 'utf8');
    assert.match(source, /node --version/u, launcher);
    assert.match(source, /LSS 22/u, launcher);
    assert.equal((source.match(/[^\x00-\x7F]/gu) || []).length, 0, `${launcher} 必须保持纯 ASCII`);
  }
  const normal = await readFile(path.join(root, 'start-windows.cmd'), 'utf8');
  assert.match(normal, /node windows\\host\\main\.mjs %\*/u);
});

test('start-windows.cmd 在版本检查后以 --help 正常退出', { skip: process.platform !== 'win32' }, () => {
  const launcherPath = path.join(root, 'start-windows.cmd');
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${launcherPath}" --help`], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    windowsVerbatimArguments: true,
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

test('宿主带 --hide-console 运行不报错（self-check 冒烟）', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(process.execPath, [
    path.join(root, 'windows', 'host', 'main.mjs'),
    '--hide-console',
    '--self-check',
    '--quiet',
    '--no-disk-write',
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
