import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  defaultSelectionWindowScript,
  isNativeSelectionWindowSupported,
  parseSelectionWindowResult,
  probeClientSelectionWindow,
  showClientSelectionWindow
} from '../windows/node-source/selection-window.mjs';

const root = resolve('.');
const interactiveWindowTest = process.env.CX_TEST_NATIVE_WINDOW === '1';

test('原生选择窗口脚本保持纯 ASCII（Windows PowerShell 5.1 无 BOM 时按 ANSI 解析）', async () => {
  const source = await readFile(defaultSelectionWindowScript, 'utf8');
  // 非 ASCII 会让未带 BOM 的 .ps1 在 Windows PowerShell 5.1 下解析失败；界面文案一律走 UTF-8 JSON。
  assert.match(source, /^[\x20-\x7E\r\n\t]*$/u);
  assert.match(source, /System\.Windows\.Forms/u);
  assert.match(source, /OpenFileDialog/u);
});

test('parseSelectionWindowResult 处理选中、取消、自动关闭、错误与非法输出', () => {
  assert.deepEqual(
    parseSelectionWindowResult('{"path":"D:\\\\Exam\\\\CXExam.exe","index":2,"manual":false,"cancelled":false}'),
    { status: 'selected', path: 'D:\\Exam\\CXExam.exe', index: 2, manual: false }
  );
  assert.deepEqual(parseSelectionWindowResult('{"path":"C:\\\\Browsed\\\\CXExam.exe","index":0,"manual":true}'),
    { status: 'selected', path: 'C:\\Browsed\\CXExam.exe', index: 0, manual: true });
  assert.deepEqual(parseSelectionWindowResult('{"cancelled":true}'), { status: 'cancelled', autoClosed: false });
  assert.deepEqual(parseSelectionWindowResult('{"cancelled":true,"autoClosed":true}'), { status: 'cancelled', autoClosed: true });
  assert.deepEqual(parseSelectionWindowResult('{"action":"scan-all"}'), { status: 'scan-all' });
  assert.deepEqual(parseSelectionWindowResult('{"cancelled":true,"error":"winforms-unavailable: x"}'),
    { status: 'unavailable', reason: 'winforms-unavailable: x' });
  assert.equal(parseSelectionWindowResult('not-json').status, 'unavailable');
  assert.equal(parseSelectionWindowResult('{"cancelled":false}').status, 'unavailable');
  assert.equal(parseSelectionWindowResult('[]').status, 'unavailable');
});

test('isNativeSelectionWindowSupported 只在 Windows 启用', () => {
  assert.equal(isNativeSelectionWindowSupported('win32'), true);
  assert.equal(isNativeSelectionWindowSupported('linux'), false);
  assert.equal(isNativeSelectionWindowSupported('darwin'), false);
});

function createFakeWindowDependencies(outputValue) {
  const files = new Map();
  const calls = [];
  const fsImpl = {
    async mkdtemp(prefix) {
      const directory = `${prefix}fake-window`;
      files.set(directory, '');
      return directory;
    },
    async writeFile(filePath, data) {
      files.set(filePath, String(data));
    },
    async readFile(filePath) {
      if (!files.has(filePath)) {
        const error = new Error(`missing ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    },
    async rm() {}
  };
  const execFileImpl = async (command, args, options) => {
    calls.push({ command, args, options });
    if (outputValue instanceof Error) throw outputValue;
    return { stdout: JSON.stringify(outputValue), stderr: '' };
  };
  return { fsImpl, execFileImpl, files, calls };
}

test('showClientSelectionWindow 通过 PowerShell 进程契约解析选中结果', async () => {
  const deps = createFakeWindowDependencies({ path: 'D:\\Exam\\CXExam.exe', index: 2, manual: false, cancelled: false });
  const result = await showClientSelectionWindow({
    candidates: [{ path: 'D:\\Exam\\CXExam.exe', machine: 'x86' }],
    ...deps
  });
  assert.deepEqual(result, { status: 'selected', path: 'D:\\Exam\\CXExam.exe', index: 2, manual: false });
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].command, 'powershell.exe');
  assert.equal(deps.calls[0].options.windowsHide, true);
  const args = deps.calls[0].args;
  assert.equal(args.includes('-STA'), true);
  assert.equal(args.includes('-Probe'), false);
  assert.equal(args.includes('-InputPath'), false);
  assert.equal(args.includes('-OutputPath'), false);
  const payload = JSON.parse(deps.calls[0].options.input);
  assert.equal(payload.candidates[0].path, 'D:\\Exam\\CXExam.exe');
  assert.match(payload.candidates[0].display, /^\[ 1 \] D:\\Exam\\CXExam\.exe（x86）$/u);
  assert.equal(payload.title, '超星学习助手 - 选择考试客户端');
  assert.equal(payload.iconPath, resolve(root, 'windows/share-file/assets/app-icon.ico'));
});

test('showClientSelectionWindow 返回取消，并在 PowerShell 失败时标记不可用', async () => {
  const cancelled = await showClientSelectionWindow({
    candidates: [{ path: 'D:\\Exam\\CXExam.exe', machine: 'x86' }],
    ...createFakeWindowDependencies({ cancelled: true, autoClosed: true })
  });
  assert.deepEqual(cancelled, { status: 'cancelled', autoClosed: true });

  const unavailable = await showClientSelectionWindow({
    candidates: [{ path: 'D:\\Exam\\CXExam.exe', machine: 'x86' }],
    ...createFakeWindowDependencies(new Error('spawn powershell.exe ENOENT'))
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.match(unavailable.reason, /ENOENT/u);

  const emptyDeps = createFakeWindowDependencies({ path: 'C:\\Manual\\CXExam.exe', manual: true });
  assert.equal((await showClientSelectionWindow({ candidates: [], ...emptyDeps })).status, 'selected');
  assert.equal(emptyDeps.calls.length, 1);
});

test('选择窗口使用标准输入输出传递推荐序号，避免创建临时业务文件', async () => {
  const deps = createFakeWindowDependencies({ cancelled: true });
  await showClientSelectionWindow({
    candidates: [{ path: 'C:\\Exam64\\CXExam.exe', machine: 'x64' }, { path: 'D:\\Exam32\\CXExam.exe', machine: 'x86' }],
    preferredIndex: 1,
    ...deps,
    fsImpl: new Proxy({}, { get() { throw new Error('must not access filesystem'); } })
  });
  const payload = JSON.parse(deps.calls[0].options.input);
  assert.equal(payload.preferredIndex, 1);
});

test('选择窗口保留跨 stdout/stderr 数据块的 UTF-8 中文路径与错误', async () => {
  const moduleUrl = new URL('../windows/node-source/selection-window.mjs', import.meta.url).href;
  const selectedPath = 'D:\\考试客户端\\CXExam.exe';
  const failureReason = '考试客户端选择失败';
  for (const errorOutput of [false, true]) {
    const source = `
      import { mock } from 'node:test';
      import { EventEmitter } from 'node:events';
      const bytes = Buffer.from(${JSON.stringify(errorOutput ? failureReason : JSON.stringify({ path: selectedPath, cancelled: false }))}, 'utf8');
      const boundary = bytes.findIndex((value) => value > 127) + 1;
      mock.module('node:child_process', { namedExports: { spawn() {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.kill = () => {};
        child.stdin.end = () => queueMicrotask(() => {
          const output = child.${errorOutput ? 'stderr' : 'stdout'};
          output.emit('data', bytes.subarray(0, boundary));
          output.emit('data', bytes.subarray(boundary));
          child.emit('close', ${errorOutput ? 1 : 0});
        });
        return child;
      } } });
      const { showClientSelectionWindow } = await import(${JSON.stringify(moduleUrl)});
      process.stdout.write(JSON.stringify(await showClientSelectionWindow({ candidates: [] })));
    `;
    const result = await new Promise((resolveResult, rejectResult) => {
      const child = spawn(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', source], { windowsHide: true });
      const stdout = [], stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', rejectResult);
      child.on('close', (code) => {
        if (code !== 0) rejectResult(new Error(Buffer.concat(stderr).toString('utf8')));
        else resolveResult(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      });
    });
    if (errorOutput) assert.deepEqual(result, { status: 'unavailable', reason: failureReason });
    else assert.equal(result.path, selectedPath);
  }
});

test('probeClientSelectionWindow 可构建 WinForms 窗口控件（Windows 冒烟）', { skip: process.platform !== 'win32' }, async () => {
  const result = await probeClientSelectionWindow({ timeoutMs: 60000 });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.iconApplied, true, '共享图标必须应用到 WinForms 标题栏');
});

test('内嵌选择窗口脚本仍为标题栏应用共享图标', { skip: process.platform !== 'win32' }, async () => {
  const previousScripts = globalThis.__CX_SILENT_EMBEDDED_SCRIPTS__;
  try {
    globalThis.__CX_SILENT_EMBEDDED_SCRIPTS__ = {
      'selection-window.ps1': await readFile(defaultSelectionWindowScript, 'utf8')
    };
    const result = await probeClientSelectionWindow({ timeoutMs: 60000 });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.iconApplied, true, '内嵌脚本必须应用标题栏图标');
  } finally {
    globalThis.__CX_SILENT_EMBEDDED_SCRIPTS__ = previousScripts;
  }
});

test('SEA 选择窗口 payload 从当前 EXE 提取图标', { skip: process.platform !== 'win32' }, async () => {
  const previousSea = globalThis.__CX_NODE_SEA__;
  const deps = createFakeWindowDependencies({ cancelled: true });
  try {
    globalThis.__CX_NODE_SEA__ = true;
    await showClientSelectionWindow({ candidates: [], ...deps });
    assert.equal(JSON.parse(deps.calls[0].options.input).iconPath, process.execPath);
  } finally {
    globalThis.__CX_NODE_SEA__ = previousSea;
  }
});

test('三个候选在默认及最小窗口中完整可见且可分别选择', { skip: !interactiveWindowTest || process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'cx-selection-layout-'));
  const candidates = [
    { path: 'C:\\考试客户端一\\CXExam.exe', machine: 'x86' },
    { path: 'D:\\考试客户端二\\CXExam.exe', machine: 'x64' },
    { path: 'E:\\考试客户端三\\CXExam.exe', machine: 'x86' }
  ];
  try {
    const source = await readFile(defaultSelectionWindowScript, 'utf8');
    const scriptPath = resolve(directory, 'layout.ps1');
    const instrumented = source.replace('ConvertTo-Json -Compress', 'ConvertTo-Json -Compress -Depth 8')
      .replace('$script:selection = @{ cancelled = $true; autoClosed = $true }', `
    $snapshots = @()
    foreach ($size in @($ui.form.Size, $ui.form.MinimumSize)) {
      $ui.form.Size = $size
      $ui.form.PerformLayout()
      $hint = @($ui.form.Controls | Where-Object { $_ -is [System.Windows.Forms.Label] })[0]
      $rows = @()
      for ($index = 0; $index -lt $ui.list.Items.Count; $index += 1) {
        $rect = $ui.list.GetItemRectangle($index)
        $point = New-Object System.Drawing.Point(($ui.list.Left + 10), ($ui.list.Top + $rect.Top + [int]($rect.Height / 2)))
        $ui.list.SelectedIndex = $index
        $rows += @{
          top = $rect.Top; bottom = $rect.Bottom
          text = [string]$ui.list.Items[$index]
          hitList = [object]::ReferenceEquals($ui.form.GetChildAtPoint($point), $ui.list)
          selectedIndex = $ui.list.SelectedIndex
        }
      }
      $snapshots += @{
        count = $ui.list.Items.Count; listTop = $ui.list.Top; listBottom = $ui.list.Bottom
        listClientHeight = $ui.list.ClientSize.Height
        hintBottom = $hint.Bottom; buttonsTop = $ui.buttons.Top; rows = $rows
      }
    }
    $ui.list.SelectedIndex = [int]$payload.preferredIndex
    $ui.ok.PerformClick()
    $script:selection.layout = $snapshots
`);
    await writeFile(scriptPath, instrumented, 'ascii');
    for (const preferredIndex of [0, 1, 2]) {
      const result = await showClientSelectionWindow({
        candidates, preferredIndex, scriptPath, autoCloseMs: 350, timeoutMs: 30000,
        execFileImpl: (command, args, options) => new Promise((resolveResult, rejectResult) => {
          const child = spawn(command, args, { windowsHide: options.windowsHide, stdio: ['pipe', 'pipe', 'pipe'] });
          const stdout = [], stderr = [];
          const timer = setTimeout(() => { child.kill(); rejectResult(new Error('layout probe timed out')); }, options.timeout);
          child.stdout.on('data', (chunk) => stdout.push(chunk));
          child.stderr.on('data', (chunk) => stderr.push(chunk));
          child.on('error', (error) => { clearTimeout(timer); rejectResult(error); });
          child.on('close', (code) => {
            clearTimeout(timer);
            try {
              assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
              const raw = JSON.parse(Buffer.concat(stdout).toString('utf8'));
              assert.equal(raw.layout.length, 2);
              for (const layout of raw.layout) {
                assert.equal(layout.count, 3, 'all scanned candidates must reach the list');
                assert.ok(layout.listTop >= layout.hintBottom, `hint covers list: ${JSON.stringify(layout)}`);
                assert.ok(layout.listBottom <= layout.buttonsTop, 'buttons must not cover the list');
                for (const [index, row] of layout.rows.entries()) {
                  assert.ok(row.top >= 0 && row.bottom <= layout.listClientHeight, 'candidate row must fit in the list');
                  assert.equal(row.hitList, true, `candidate ${index + 1} is covered by another control`);
                  assert.equal(row.selectedIndex, index);
                  assert.ok(row.text.includes(candidates[index].path), 'candidate path must remain intact');
                }
              }
              resolveResult({ stdout: JSON.stringify(raw) });
            } catch (error) { rejectResult(error); }
          });
          child.stdin.end(options.input, 'utf8');
        })
      });
      assert.deepEqual(result, { status: 'selected', path: candidates[preferredIndex].path, index: preferredIndex + 1, manual: false });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('真实选择窗口对操作系统可见，全盘按钮返回请求（自动操作，不启动客户端）', { skip: !interactiveWindowTest || process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'cx-selection-visibility-'));
  try {
    const source = await readFile(defaultSelectionWindowScript, 'utf8');
    for (const scanAll of [false, true]) {
      const instrumented = source.replace("$script:selection = @{ cancelled = $true }", `
Add-Type -Name WindowProbe -Namespace SelectionTest -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);'
$script:selection = @{ cancelled = $true }
`).replace('$script:selection = @{ cancelled = $true; autoClosed = $true }', scanAll
        ? '$ui.scanAll.PerformClick(); return'
        : '$script:selection = @{ cancelled = $true; autoClosed = $true; visible = [SelectionTest.WindowProbe]::IsWindowVisible($ui.form.Handle); iconApplied = ($ui.iconApplied -and $ui.form.ShowIcon -and ([Win32Dpi.DpiAwareness]::SendMessage($ui.form.Handle, 127, [IntPtr]::Zero, [IntPtr]::Zero) -ne [IntPtr]::Zero)) }');
    const scriptPath = resolve(directory, 'visibility.ps1');
    await writeFile(scriptPath, instrumented, 'ascii');
    const result = await showClientSelectionWindow({
      candidates: [], scriptPath, autoCloseMs: 500, timeoutMs: 30000,
      execFileImpl: async (command, args, options) => new Promise((resolveResult, rejectResult) => {
        const child = spawn(command, args, { windowsHide: options.windowsHide, stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout = [], stderr = [];
        const timer = setTimeout(() => { child.kill(); rejectResult(new Error('visibility probe timed out')); }, options.timeout);
        child.stdout.on('data', (chunk) => stdout.push(chunk));
        child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.on('error', (error) => { clearTimeout(timer); rejectResult(error); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) { rejectResult(new Error(Buffer.concat(stderr).toString('utf8'))); return; }
          const raw = JSON.parse(Buffer.concat(stdout).toString('utf8'));
          try {
            if (!scanAll) {
              assert.equal(raw.visible, true, 'IsWindowVisible returned false for the chooser');
              assert.equal(raw.iconApplied, true, 'WM_GETICON must return the titlebar icon for the visible chooser');
            }
          } catch (error) { rejectResult(error); return; }
          resolveResult({ stdout: JSON.stringify(raw) });
        });
        child.stdin.end(options.input, 'utf8');
      })
    });
      assert.deepEqual(result, scanAll ? { status: 'scan-all' } : { status: 'cancelled', autoClosed: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('真实原生选择窗口可显示并按定时器关闭', { skip: !interactiveWindowTest || process.platform !== 'win32' }, async () => {
  const started = Date.now();
  const result = await showClientSelectionWindow({
    candidates: [
      { path: 'C:\\Windows\\CXExam.exe', machine: 'x86' },
      { path: 'C:\\Program Files\\Exam\\CXExam.exe', machine: 'x64' }
    ],
    autoCloseMs: 1200,
    timeoutMs: 60000
  });
  assert.deepEqual(result, { status: 'cancelled', autoClosed: true });
  assert.ok(Date.now() - started < 30000);

  const emptyStarted = Date.now();
  const emptyResult = await showClientSelectionWindow({ candidates: [], autoCloseMs: 900, timeoutMs: 60000 });
  assert.deepEqual(emptyResult, { status: 'cancelled', autoClosed: true });
  assert.ok(Date.now() - emptyStarted >= 700);
});

function runHost(args, env = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [resolve(root, 'windows', 'node-source', 'main.mjs'), ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error('host process timed out'));
    }, 90000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => { clearTimeout(timer); rejectPromise(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

test('宿主 --ui gui / --select-client 已接入原生选择窗口（自动关闭冒烟）', { skip: !interactiveWindowTest || process.platform !== 'win32' }, async () => {
  const env = { CXPLUS_SELECTION_AUTO_CLOSE_MS: '900' };
  for (const args of [['--ui', 'gui', '--scan-mode', 'common', '--no-elevate', '--no-log', '--no-disk-write'], ['--select-client', '--scan-mode', 'common', '--no-elevate', '--no-log', '--no-disk-write']]) {
    const result = await runHost(args, env);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.code, 3, output);
    if (output.includes('未扫描到可用的 CXExam.exe')) {
      // 本机没有可扫描的客户端时无法验证窗口链路；探针测试已覆盖窗口可用性。
      continue;
    }
    assert.match(output, /打开原生选择窗口/u);
    assert.match(output, /已取消客户端选择/u);
  }
});
