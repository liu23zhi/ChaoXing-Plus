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
  const calls = { show: [], discover: [], warnings: [], lines: [] };
  return {
    calls,
    logger: { info() {}, warn(message) { calls.warnings.push(message); } },
    async discover(options) { calls.discover.push(options); return { candidates, source: 'common', selected: candidates[0] || null }; },
    async showWindow(options) {
      calls.show.push(options);
      return showResult || { status: 'selected', path: selectedPath || options.candidates[options.preferredIndex]?.path, manual: false };
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
