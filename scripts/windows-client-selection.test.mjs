import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveClientSelection } from '../windows/host/client-selection.mjs';
import { applyHostOptionLayers, parseHostArgs } from '../windows/host/options.mjs';

function makeOptions(overrides = {}) {
  return {
    clientPath: '', clientIndex: null, selectClient: false, clientFirst: false,
    listClients: false, scanClients: true, scanMode: 'fallback-all', ui: 'auto', rescan: false, noScanCache: false, noDiskWrite: false,
    quiet: false, ...overrides
  };
}

function makeDeps({ candidates = [], selectedPath = '', showResult, stdinIsTTY = false, stdoutIsTTY = false, platform = 'win32', answer = '', output = '' } = {}) {
  const calls = { show: [], discover: [], warnings: [], lines: [], progress: [] };
  return {
    calls,
    logger: { info() {}, warn(message) { calls.warnings.push(message); } },
    async discover(options) { calls.discover.push(options); return { candidates, source: 'common', selected: candidates[0] || null }; },
    async showWindow(options) {
      calls.show.push(options);
      return showResult || { status: 'selected', path: selectedPath || options.candidates[options.preferredIndex]?.path, manual: false };
    },
    // 默认不打开真实 WinForms 窗口；进度窗口专项测试按需覆盖该依赖。
    async showProgressWindow(options) {
      calls.progress.push(options);
      return { status: 'unavailable', reason: 'test-disabled' };
    },
    async readMachine() { return 0x014c; },
    assertMachine() {},
    stdinIsTTY,
    stdoutIsTTY,
    platform,
    stdout: { write(line) { calls.lines.push(line); output += line; } },
    createInterface() { return { async question() { return answer; }, close() {} }; }
  };
}

const candidates = [
  { path: 'C:\\Exam64\\CXExam.exe', machine: 0x8664 },
  { path: 'D:\\Exam32\\CXExam.exe', machine: 0x014c }
];

test('Windows 无参数入口在已保存客户端路径和交互终端下仍显示 GUI', async () => {
  const stored = { clientPath: 'C:\\Configured\\CXExam.exe', ui: 'auto', scanMode: 'all' };
  const startup = parseHostArgs([], { startup: true, platform: 'win32' });
  const options = applyHostOptionLayers(startup, stored);
  const deps = makeDeps({ candidates, stdinIsTTY: true, stdoutIsTTY: true });
  assert.equal(options.ui, 'gui');
  assert.equal(options.clientPath, '');
  assert.deepEqual(startup.rawArgs, ['--ui', 'gui', '--scan-mode', 'common']);
  assert.equal(await resolveClientSelection(options, stored, deps), candidates[1].path);
  assert.equal(deps.calls.show.length, 1);
  assert.equal(deps.calls.discover.length, 1);
  assert.equal(deps.calls.discover[0].scanMode, 'common');
});

test('GUI 全盘扫描按钮执行实时全盘扫描并刷新列表，不自动选择或启动', async () => {
  const deps = makeDeps({ candidates: [] });
  let windowCalls = 0;
  deps.showWindow = async (options) => {
    deps.calls.show.push(options);
    return ++windowCalls === 1 ? { status: 'scan-all' } : { status: 'cancelled' };
  };
  deps.discover = async (options) => {
    deps.calls.discover.push(options);
    return { candidates: options.scanMode === 'all' ? candidates : [], source: options.scanMode };
  };
  await assert.rejects(resolveClientSelection(makeOptions({ ui: 'gui', scanMode: 'common' }), {}, deps), /已取消客户端选择/u);
  assert.deepEqual(deps.calls.discover.map((call) => call.scanMode), ['common', 'all']);
  assert.equal(deps.calls.discover[1].stopOnMachine, null);
  assert.equal(deps.calls.discover[1].forceRescan, true);
  assert.deepEqual(deps.calls.show[0].candidates, []);
  assert.equal(deps.calls.show[1].candidates.length, 2);
  assert.equal(deps.calls.show[1].preferredIndex, 1);
});

test('GUI 全盘扫描失败仍可返回原列表手动选择', async () => {
  const deps = makeDeps({ candidates });
  let windowCalls = 0;
  deps.showWindow = async (options) => {
    deps.calls.show.push(options);
    return ++windowCalls === 1 ? { status: 'scan-all' } : { status: 'selected', path: candidates[1].path };
  };
  deps.discover = async (options) => {
    deps.calls.discover.push(options);
    if (options.scanMode === 'all') throw new Error('scan failed');
    return { candidates };
  };
  assert.equal(await resolveClientSelection(makeOptions({ ui: 'gui', scanMode: 'common' }), {}, deps), candidates[1].path);
  assert.equal(deps.calls.show[1].candidates.length, 2);
  assert.match(deps.calls.warnings.join('\n'), /scan failed/u);
});

test('无参数 GUI 取消不会沿用保存路径直接启动', async () => {
  const stored = { clientPath: 'C:\\Configured\\CXExam.exe' };
  const options = applyHostOptionLayers(parseHostArgs([], { startup: true, platform: 'win32' }), stored);
  const deps = makeDeps({ candidates, showResult: { status: 'cancelled' } });
  await assert.rejects(resolveClientSelection(options, stored, deps), /已取消客户端选择/u);
  assert.equal(deps.calls.show.length, 1);
});

test('GUI 默认仅用于 Windows 真正无参数入口，显式配置与调试参数保留原语义', () => {
  assert.equal(parseHostArgs([]).ui, 'auto');
  assert.equal(parseHostArgs([], { startup: true, platform: 'linux' }).ui, 'auto');
  const argSets = [
    ['--client-first'], ['--client', 'C:\\Explicit\\CXExam.exe'],
    ['--ui', 'auto'], ['--config', 'local.json'], ['--help'], ['--self-check'], ['--attach', '9222']
  ];
  for (const args of argSets) {
    const options = parseHostArgs(args, { startup: true, platform: 'win32' });
    assert.deepEqual(options, parseHostArgs(args), args.join(' '));
  }
});

test('UAC 的明确已选路径覆盖配置和内联 JSON 中已完成的重扫请求', () => {
  for (const request of [{ rescan: true }, { noScanCache: true }]) {
    const options = applyHostOptionLayers(parseHostArgs(['--client', 'C:\\Selected\\CXExam.exe', '--elevated']), request);
    assert.equal(options.clientPath, 'C:\\Selected\\CXExam.exe');
    assert.equal(options.scanClients, false);
  }
});

test('显式 --client 在 auto/gui/cli 下均跳过扫描和选择窗口', async () => {
  const clientPath = 'C:\\Explicit\\CXExam.exe';
  for (const ui of ['auto', 'gui', 'cli']) {
    const deps = makeDeps({ candidates, stdinIsTTY: true, stdoutIsTTY: true });
    const selected = await resolveClientSelection(makeOptions({ clientPath, scanClients: false, ui }), { clientPath }, deps);
    assert.equal(selected, clientPath, `ui=${ui}`);
    assert.equal(deps.calls.discover.length, 0, `ui=${ui}`);
    assert.equal(deps.calls.show.length, 0, `ui=${ui}`);
  }
});

test('显式 GUI/CLI 会通过配置分层进入扫描选择，显式 --client 仍直接启动', async () => {
  const configuredPath = 'C:\\Configured\\CXExam.exe';
  for (const ui of ['gui', 'cli']) {
    const options = applyHostOptionLayers(parseHostArgs(['--ui', ui]), { clientPath: configuredPath });
    const deps = makeDeps({ candidates, stdinIsTTY: true, stdoutIsTTY: true, answer: '1' });
    const selected = await resolveClientSelection(options, { clientPath: configuredPath }, deps);
    assert.equal(selected, ui === 'gui' ? candidates[1].path : candidates[0].path, `ui=${ui}`);
    assert.equal(deps.calls.discover.length, 1, `ui=${ui}`);
    assert.equal(deps.calls.show.length, ui === 'gui' ? 1 : 0, `ui=${ui}`);

    const explicitPath = 'D:\\Explicit\\CXExam.exe';
    const explicitOptions = applyHostOptionLayers(parseHostArgs(['--client', explicitPath, '--ui', ui]), {
      clientPath: configuredPath
    });
    const explicitDeps = makeDeps({ candidates, stdinIsTTY: true, stdoutIsTTY: true });
    assert.equal(await resolveClientSelection(explicitOptions, { clientPath: explicitOptions.clientPath }, explicitDeps), explicitPath);
    assert.equal(explicitDeps.calls.discover.length, 0, `explicit client ui=${ui}`);
    assert.equal(explicitDeps.calls.show.length, 0, `explicit client ui=${ui}`);
  }
});

test('内联 JSON 的 GUI/CLI 选择覆盖文件路径，但同一 JSON 的直接路径优先', async () => {
  const configuredPath = 'C:\\Configured\\CXExam.exe';
  for (const ui of ['gui', 'cli']) {
    const options = applyHostOptionLayers(parseHostArgs([]), { clientPath: configuredPath }, { ui });
    const deps = makeDeps({ candidates, stdinIsTTY: true, stdoutIsTTY: true, answer: '1' });
    const selected = await resolveClientSelection(options, { clientPath: configuredPath }, deps);
    assert.equal(selected, ui === 'gui' ? candidates[1].path : candidates[0].path);
    assert.equal(deps.calls.discover.length, 1);

    const directPath = 'D:\\Inline\\CXExam.exe';
    const directOptions = applyHostOptionLayers(parseHostArgs([]), { clientPath: configuredPath }, { ui, clientPath: directPath });
    const directDeps = makeDeps({ candidates, stdinIsTTY: true, stdoutIsTTY: true });
    assert.equal(await resolveClientSelection(directOptions, { clientPath: directOptions.clientPath }, directDeps), directPath);
    assert.equal(directDeps.calls.discover.length, 0);
    assert.equal(directDeps.calls.show.length, 0);
  }
});

test('原生选择在没有扫描候选时仍可手动浏览 CXExam.exe', async () => {
  const deps = makeDeps({ selectedPath: 'D:\\Manual\\CXExam.exe' });
  const selected = await resolveClientSelection(makeOptions({ ui: 'gui' }), {}, deps);
  assert.equal(selected, 'D:\\Manual\\CXExam.exe');
  assert.deepEqual(deps.calls.show[0].candidates, []);
});

test('Windows auto 非交互默认显示原生选择并预选 x86 候选', async () => {
  const deps = makeDeps({ candidates });
  const selected = await resolveClientSelection(makeOptions(), {}, deps);
  assert.equal(selected, candidates[1].path);
  assert.equal(deps.calls.show.length, 1);
  assert.equal(deps.calls.show[0].preferredIndex, 1);
});

test('quiet 或 client-first 自动选择不显示原生窗口', async () => {
  for (const options of [makeOptions({ quiet: true }), makeOptions({ clientFirst: true })]) {
    const deps = makeDeps({ candidates });
    const selected = await resolveClientSelection(options, {}, deps);
    assert.equal(selected, candidates[1].path);
    assert.equal(deps.calls.show.length, 0);
  }
});

test('quiet client-first 没有候选时返回空结果而不是启动错误', async () => {
  const deps = makeDeps();
  assert.equal(await resolveClientSelection(makeOptions({ quiet: true, clientFirst: true }), {}, deps), null);
  assert.equal(deps.calls.show.length, 0);
});

test('普通 auto 无候选时返回启动错误而不是成功退出', async () => {
  const deps = makeDeps({ showResult: { status: 'error', reason: 'test-unavailable' } });
  await assert.rejects(
    resolveClientSelection(makeOptions(), {}, deps),
    /未扫描到可用的 CXExam\.exe，请使用 --client <path> 手动指定/u
  );
});

test('quiet list-clients 仍把候选输出到标准输出', async () => {
  const deps = makeDeps({ candidates });
  assert.equal(await resolveClientSelection(makeOptions({ quiet: true, listClients: true }), {}, deps), null);
  assert.match(deps.calls.lines.join(''), /Exam64/u);
  assert.match(deps.calls.lines.join(''), /Exam32/u);
  assert.equal(deps.calls.show.length, 0);
});

test('CLI 交互在候选为空时可输入手动 CXExam.exe 路径', async () => {
  const deps = makeDeps({ stdinIsTTY: true, stdoutIsTTY: true, answer: 'D:\\Manual\\CXExam.exe' });
  const selected = await resolveClientSelection(makeOptions({ ui: 'cli' }), {}, deps);
  assert.equal(selected, 'D:\\Manual\\CXExam.exe');
});

test('原生窗口取消会中止启动而不回退到推荐候选', async () => {
  const deps = makeDeps({ candidates, showResult: { status: 'cancelled' } });
  await assert.rejects(resolveClientSelection(makeOptions({ ui: 'gui' }), {}, deps), /已取消客户端选择/u);
  assert.equal(deps.calls.show.length, 1);
});

test('Windows auto quiet 与 client-first 不显示窗口；非 Windows gui 明确拒绝', async () => {
  const deps = makeDeps({ candidates, platform: 'linux' });
  await assert.rejects(resolveClientSelection(makeOptions({ ui: 'gui' }), {}, deps), /需要 Windows/u);
  assert.equal(deps.calls.discover.length, 0);
});

test('rescan 强制绕过扫描缓存', async () => {
  const deps = makeDeps({ candidates });
  let received;
  deps.discover = async (options) => {
    received = options;
    return { candidates, source: 'common', selected: candidates[0] };
  };
  await resolveClientSelection(makeOptions({ rescan: true, clientFirst: true }), {}, deps);
  assert.equal(received.noScanCache, false);
  assert.equal(received.forceRescan, true);
});

test('全盘扫描显示进度窗口、传递进度并在完成后关闭窗口', async () => {
  const deps = makeDeps({ candidates: [] });
  const progress = { updates: [], closed: 0 };
  deps.showProgressWindow = async (options) => {
    deps.calls.progress.push(options);
    let resolveCancelled;
    const cancelled = new Promise((resolve) => { resolveCancelled = resolve; });
    return {
      status: 'ok',
      cancelled,
      async update(update) { progress.updates.push(update); return true; },
      async close() { progress.closed += 1; resolveCancelled(false); }
    };
  };
  let windowCalls = 0;
  deps.showWindow = async (options) => {
    deps.calls.show.push(options);
    return ++windowCalls === 1 ? { status: 'scan-all' } : { status: 'selected', path: candidates[1].path };
  };
  deps.discover = async (options) => {
    deps.calls.discover.push(options);
    if (options.scanMode === 'all') {
      options.onProgress?.({ directoriesVisited: 4, candidatesFound: 1, elapsedMs: 20 });
      options.onProgress?.({ directoriesVisited: 9, candidatesFound: 2, elapsedMs: 40 });
      return { candidates, source: 'full' };
    }
    return { candidates: [] };
  };
  const selected = await resolveClientSelection(makeOptions({ ui: 'gui', scanMode: 'common' }), {}, deps);
  assert.equal(selected, candidates[1].path);
  assert.equal(deps.calls.progress.length, 1);
  assert.deepEqual(progress.updates.map((update) => update.directoriesVisited), [4, 9]);
  assert.equal(progress.closed, 1);
  assert.equal(deps.calls.show.length, 2);
});

test('扫描进度窗口取消会中止全盘扫描并保留原候选', async () => {
  const deps = makeDeps({ candidates: [] });
  let resolveCancelled;
  const cancelled = new Promise((resolve) => { resolveCancelled = resolve; });
  let closed = 0;
  deps.showProgressWindow = async () => ({
    status: 'ok',
    cancelled,
    async update() { return true; },
    async close() { closed += 1; resolveCancelled(true); }
  });
  let windowCalls = 0;
  deps.showWindow = async (options) => {
    deps.calls.show.push(options);
    return ++windowCalls === 1 ? { status: 'scan-all' } : { status: 'cancelled' };
  };
  deps.discover = async (options) => {
    deps.calls.discover.push(options);
    if (options.scanMode !== 'all') return { candidates: [] };
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
      if (options.signal.aborted) { abort(); return; }
      options.signal.addEventListener('abort', abort, { once: true });
      setTimeout(() => resolveCancelled(true), 20).unref?.();
    });
  };
  await assert.rejects(
    resolveClientSelection(makeOptions({ ui: 'gui', scanMode: 'common' }), {}, deps),
    /已取消客户端选择/u
  );
  assert.equal(deps.calls.discover.length, 2);
  assert.equal(deps.calls.discover[1].signal instanceof AbortSignal, true);
  assert.match(deps.calls.warnings.join('\n'), /已取消全盘扫描/u);
  assert.equal(closed, 1);
});