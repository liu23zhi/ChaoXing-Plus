import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import vm from 'node:vm';
import { CdpConnection } from '../windows/host/cdp.mjs';
import { PageSession } from '../windows/host/inject.mjs';
import { mergeHostConfigLayers } from '../windows/host/config.mjs';
import { applyHostOptionLayers, applyHostOptionsToConfig, parseHostArgs } from '../windows/host/options.mjs';

function makeSession(overrides = {}) {
  const session = new PageSession({
    port: 9333,
    target: { id: 'lifecycle', url: 'https://mooc1.chaoxing.com/exam-ans/', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/lifecycle' },
    assets: { bootstrap: '', bundle: 'window.bundleRuns=(window.bundleRuns||0)+1;', trampoline: '', style: '' },
    configStore: { isEnabled: () => true, settingsSnapshot: () => ({}) },
    instanceToken: 'lifecycle-test',
    injectBlankFrames: true,
    captureConsole: true,
    logger: { info() {}, warn() {} },
    ...overrides
  });
  session.contexts.set(1, { frameId: 'top', origin: 'https://mooc1.chaoxing.com' });
  session.frameUrls.set('top', session.target.url);
  session.topFrameId = 'top';
  return session;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function mockRegistrationCdp(t, { deferContext = false, deferRegistration = false, emitReady = true } = {}) {
  const registrationRequested = deferred();
  const warnings = [];
  const commands = [];
  let runtimeEnables = 0;
  let session;
  const socket = new EventTarget();
  socket.readyState = 1;
  const receive = (message) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  const page = vm.createContext({
    console: {
      log(message) {
        if (!emitReady) return;
        receive({ method: 'Runtime.consoleAPICalled', params: {
          executionContextId: 1,
          args: [{ type: 'string', value: String(message) }]
        } });
      }
    }
  });
  page.window = page;
  socket.close = () => { socket.readyState = 3; };
  socket.send = (payload) => {
    const command = JSON.parse(payload);
    commands.push(command);
    queueMicrotask(() => {
      if (command.method === 'Page.addScriptToEvaluateOnNewDocument') {
        registrationRequested.resolve();
        if (!deferRegistration) receive({ id: command.id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      let result = {};
      if (command.method === 'Page.getFrameTree') {
        result = { frameTree: { frame: { id: 'top', url: session.target.url } } };
      } else if (command.method === 'Runtime.enable') {
        runtimeEnables += 1;
        if (!deferContext || runtimeEnables > 1) receive({
          method: 'Runtime.executionContextCreated',
          params: { context: { id: 1, origin: 'https://mooc1.chaoxing.com', auxData: { isDefault: true, frameId: 'top' } } }
        });
      } else if (command.method === 'Runtime.evaluate') {
        const value = vm.runInContext(command.params.expression, page);
        result = { result: { type: typeof value, value } };
      }
      receive({ id: command.id, result });
    });
  };
  const connection = new CdpConnection(socket);
  const originalOpen = CdpConnection.open;
  CdpConnection.open = async () => connection;
  session = makeSession({
    injectStrategy: 'runtime',
    assets: {
      bootstrap: 'window.__CX_WIN_HOST__=true;window.bootstrapRuns=(window.bootstrapRuns||0)+1;console.log(\'__CX_WIN_MSG__{"source":"chaoxing-plus-windows","instance":"lifecycle-test","kind":"ready"}\');',
      bundle: 'window.bundleRuns=(window.bundleRuns||0)+1;',
      trampoline: '',
      style: ''
    },
    logger: { info() {}, warn(message) { warnings.push(message); } }
  });
  session.contexts.clear();
  t.after(() => { session.close(); CdpConnection.open = originalOpen; });
  return { session, page, connection, warnings, commands, registrationRequested };
}

test('新文档注册被 CDP 拒绝时仍执行当前上下文的 bootstrap 和业务 bundle', async (t) => {
  const fixture = mockRegistrationCdp(t);
  assert.equal(await fixture.session.open(), fixture.session);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.page.bootstrapRuns, 1);
  assert.equal(fixture.page.bundleRuns, 1);
  assert.equal(fixture.page.__CX_WIN_BUNDLE_LOADED__, true);
  assert.equal(fixture.session.scriptIdentifier, null);
  assert.ok(fixture.session.topEnsureTimer);
  assert.equal(fixture.session.closed, false);
  assert.equal(fixture.session.stats.errors.length, 0);
  assert.equal(fixture.warnings.length, 1);
  assert.match(fixture.warnings[0], /新文档.*注册失败.*降级.*当前上下文.*顶层.*CDP Method not found/);
});

test('新文档注册失败且首次漏报上下文时，顶层定时兜底仍会补注入', { timeout: 5000 }, async (t) => {
  const fixture = mockRegistrationCdp(t, { deferContext: true, emitReady: false });
  const injected = deferred();
  fixture.session.onBundleInjected = () => injected.resolve();
  await fixture.session.open();
  assert.equal(fixture.page.bootstrapRuns, undefined);
  await injected.promise;
  assert.equal(fixture.page.bootstrapRuns, 1);
  assert.equal(fixture.page.bundleRuns, 1);
  assert.equal(fixture.page.__CX_WIN_BUNDLE_LOADED__, true);
  assert.equal(fixture.commands.filter((command) => command.method === 'Runtime.enable').length, 2);
});

test('新文档注册期间关闭会话时只取消，不记录兼容性降级或安排补注入', async (t) => {
  const fixture = mockRegistrationCdp(t, { deferRegistration: true, deferContext: true });
  const opening = fixture.session.open();
  await fixture.registrationRequested.promise;
  fixture.session.close();
  await assert.rejects(opening, { code: 'CX_INJECTION_CANCELLED' });
  assert.deepEqual(fixture.warnings, []);
  assert.equal(fixture.session.topEnsureTimer, null);
  assert.equal(fixture.session.rescanTimer, null);
  assert.equal(fixture.page.bootstrapRuns, undefined);
});

test('同一上下文并发 ready 只执行一次业务 bundle', async () => {
  const session = makeSession();
  session.bootstrapped.add(1);
  const pending = deferred();
  let executions = 0;
  session.evaluateOrThrow = async () => { executions += 1; await pending.promise; };
  const ready = { source: 'chaoxing-plus-windows', instance: 'lifecycle-test', kind: 'ready' };
  const first = session.handlePageMessage(ready, 1);
  const second = session.handlePageMessage(ready, 1);
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(executions, 1);
  assert.equal(session.stats.bundles, 1);
});

test('配置的注入超时同时传递到 bootstrap 和业务 bundle 的 CDP 请求', async () => {
  for (const injectStrategy of ['runtime', 'script', 'hybrid']) {
    const session = makeSession({ injectStrategy, bundleTimeoutMs: 12000 });
    const timeouts = [];
    session.connection = {
      async send(method, _params, options) {
        assert.equal(method, 'Runtime.evaluate');
        timeouts.push(options.timeoutMs);
        return { result: { value: { ok: true } } };
      }
    };
    await session.injectBootstrap(1);
    await session.injectBundle(1);
    assert.deepEqual(timeouts, [12000, 12000], injectStrategy);
    assert.equal(session.stats.bootstraps, 1);
    assert.equal(session.stats.bundles, 1);
  }
});

test('拒绝未知上下文和伪造来源的 ready 与 config-sync 消息', async () => {
  let injections = 0;
  let configSyncs = 0;
  const session = makeSession({ onConfigSync: () => { configSyncs += 1; } });
  session.bootstrapped.add(1);
  session.injectBundle = async () => { injections += 1; };
  await session.handlePageMessage({ source: 'chaoxing-plus-windows', instance: 'lifecycle-test', kind: 'ready' }, 999);
  await session.handlePageMessage({ source: 'forged', instance: 'lifecycle-test', kind: 'ready' }, 1);
  await session.handlePageMessage({ source: 'chaoxing-plus-windows', instance: 'other-instance', kind: 'ready' }, 1);
  await session.handlePageMessage({ source: 'forged', instance: 'lifecycle-test', kind: 'config-sync', detail: { enabled: false } }, 1);
  await session.handlePageMessage({ source: 'chaoxing-plus-windows', instance: 'other-instance', kind: 'config-sync', detail: { enabled: false } }, 1);
  assert.equal(injections, 0);
  assert.equal(configSyncs, 0);
  assert.equal(session.readyContexts.size, 0);
  assert.equal(session.stats.configSyncs, 0);
});

test('trampoline boot-request 仅能从已登记的默认执行上下文触发 bootstrap', async () => {
  const session = makeSession();
  const requested = [];
  session.injectBootstrap = async (contextId) => { requested.push(contextId); };
  await session.handlePageMessage({ kind: 'boot-request' }, 999);
  await session.handlePageMessage({ kind: 'boot-request' }, 1);
  assert.deepEqual(requested, [1]);
});

test('boot-request 拒绝伪造或不完整的宿主标识，允许初始化前请求和完整匹配标识', async () => {
  const session = makeSession();
  const requested = [];
  session.injectBootstrap = async (contextId) => { requested.push(contextId); };
  for (const envelope of [
    { source: 'forged', instance: 'lifecycle-test' },
    { source: 'chaoxing-plus-windows', instance: 'other-instance' },
    { source: 'chaoxing-plus-windows' },
    { instance: 'lifecycle-test' },
    { source: null, instance: null }
  ]) {
    await session.handlePageMessage({ kind: 'boot-request', ...envelope }, 1);
  }
  assert.deepEqual(requested, []);
  await session.handlePageMessage({ kind: 'boot-request' }, 1);
  await session.handlePageMessage({ kind: 'boot-request', source: 'chaoxing-plus-windows', instance: 'lifecycle-test' }, 1);
  assert.deepEqual(requested, [1, 1]);
});

test('初始 frame 树保留父子关系，使移除父 frame 能清理已存在的后代', async () => {
  const session = makeSession();
  session.connection = { send: async () => ({ frameTree: {
    frame: { id: 'top', url: session.target.url },
    childFrames: [{
      frame: { id: 'child', parentId: 'top', url: 'about:blank' },
      childFrames: [{ frame: { id: 'grandchild', parentId: 'child', url: 'about:blank' } }]
    }]
  } }) };
  await session.refreshFrameTree();
  assert.deepEqual([...session.frameParents], [['child', 'top'], ['grandchild', 'child']]);
  session.contexts.set(2, { frameId: 'child' });
  session.contexts.set(3, { frameId: 'grandchild' });
  session.removeFrameSubtree('child');
  assert.deepEqual([...session.contexts.keys()], [1]);
  assert.deepEqual([...session.frameUrls.keys()], ['top']);
  assert.equal(session.frameParents.size, 0);
});

test('frameDetached 清除目标 frame 及后代的执行上下文和注入状态', async () => {
  const session = makeSession();
  session.contexts.set(2, { frameId: 'child', origin: 'https://mooc1.chaoxing.com' });
  session.contexts.set(3, { frameId: 'grandchild', origin: 'https://mooc1.chaoxing.com' });
  session.contexts.set(4, { frameId: 'sibling', origin: 'https://mooc1.chaoxing.com' });
  session.frameUrls.set('child', 'about:blank');
  session.frameUrls.set('grandchild', 'about:blank');
  session.frameUrls.set('sibling', 'about:blank');
  session.frameParents = new Map([['child', 'top'], ['grandchild', 'child'], ['sibling', 'top']]);
  for (const contextId of [1, 2, 3, 4]) {
    session.bootstrapped.add(contextId);
    session.readyContexts.add(contextId);
    session.bundleLoaded.add(contextId);
    session.bundlePending.set(contextId, Promise.resolve());
  }
  let rescans = 0;
  session.scheduleRescan = () => { rescans += 1; };
  await session.handleEvent({ method: 'Page.frameDetached', params: { frameId: 'child', reason: 'remove' } });
  assert.deepEqual([...session.contexts.keys()], [1, 4]);
  assert.deepEqual([...session.bootstrapped], [1, 4]);
  assert.deepEqual([...session.readyContexts], [1, 4]);
  assert.deepEqual([...session.bundleLoaded], [1, 4]);
  assert.deepEqual([...session.bundlePending.keys()], [1, 4]);
  assert.equal(session.frameUrls.has('child'), false);
  assert.equal(session.frameUrls.has('grandchild'), false);
  assert.equal(session.frameUrls.has('sibling'), true);
  assert.equal(session.stats.contexts, 2);
  assert.equal(rescans, 1);
});

test('上下文销毁后丢弃注入的迟到结果并移除 frame 状态', async () => {
  let completed = 0;
  const session = makeSession({ onBundleInjected: () => { completed += 1; } });
  const pending = deferred();
  session.evaluateOrThrow = async () => pending.promise;
  const injection = session.injectBundle(1);
  await session.handleEvent({ method: 'Runtime.executionContextDestroyed', params: { executionContextId: 1 } });
  pending.resolve();
  await injection;
  assert.equal(session.contexts.has(1), false);
  assert.equal(session.readyContexts.has(1), false);
  assert.equal(session.bundleLoaded.has(1), false);
  assert.equal(session.stats.bundles, 0);
  assert.equal(completed, 0);
});

test('关闭会话后停止 hybrid 策略回退和重试', async () => {
  const session = makeSession({ injectStrategy: 'hybrid', injectRetries: 2 });
  const pending = deferred();
  let scripts = 0;
  session.evaluateOrThrow = async () => { await pending.promise; throw new Error('context lost'); };
  session.injectViaScriptElement = async () => { scripts += 1; };
  const injection = session.injectBundle(1);
  session.close();
  pending.resolve();
  await injection;
  assert.equal(scripts, 0);
  assert.equal(session.stats.bundles, 0);
  assert.equal(session.stats.errors.length, 0);
});

test('CDP 断开后关闭会话供宿主下一次轮询重建', async () => {
  const session = makeSession();
  await session.handleEvent({ method: 'cx.disconnected', params: {} });
  assert.equal(session.closed, true);
});

test('关闭期间建立成功的 CDP 连接立即关闭，不继续注册脚本', async (t) => {
  const pending = deferred();
  const originalOpen = CdpConnection.open;
  CdpConnection.open = () => pending.promise;
  t.after(() => { CdpConnection.open = originalOpen; });
  const sent = [];
  let closes = 0;
  const session = makeSession();
  const opening = session.open();
  session.close();
  pending.resolve({
    onEvent() {},
    async send(method) { sent.push(method); return {}; },
    close() { closes += 1; }
  });
  await assert.rejects(opening, { code: 'CX_INJECTION_CANCELLED' });
  assert.equal(closes, 1);
  assert.deepEqual(sent, []);
  assert.equal(session.topEnsureTimer, null);
});

test('PageSession 拒绝非本机、不同端口和无效的 WebSocket target', async (t) => {
  const originalOpen = CdpConnection.open;
  let connections = 0;
  CdpConnection.open = async () => { connections += 1; throw new Error('unexpected network connection'); };
  t.after(() => { CdpConnection.open = originalOpen; });
  for (const websocket of [
    'ws://other.invalid:9333/devtools/page/probe',
    'ws://127.0.0.1:9444/devtools/page/probe',
    'wss://127.0.0.1:9333/devtools/page/probe',
    'ws://user@127.0.0.1:9333/devtools/page/probe',
    'ws://127.0.0.1:9333/devtools/page/probe#fragment',
    'ws://127.0.0.1:9333/devtools/page/space here',
    'ws://127.0.0.1:9333/devtools/page/\nprobe',
    'ws://127.0.0.1:9333',
    undefined
  ]) {
    const session = makeSession({ target: { id: 'rejected-target', webSocketDebuggerUrl: websocket } });
    await assert.rejects(session.open(), { code: 'CX_ENDPOINT_URL' });
  }
  assert.equal(connections, 0);
});

test('PageSession 把同端口 localhost target 固定到已验证的 IPv4 回环地址', async (t) => {
  const originalOpen = CdpConnection.open;
  const connections = [];
  CdpConnection.open = async (url) => { connections.push(url); throw new Error('stop before network'); };
  t.after(() => { CdpConnection.open = originalOpen; });
  for (const host of ['127.0.0.1', 'LOCALHOST']) {
    const session = makeSession({ target: { id: 'local-target', webSocketDebuggerUrl: `ws://${host}:9333/devtools/page/probe?x=1` } });
    await assert.rejects(session.open(), /stop before network/u);
  }
  assert.deepEqual(connections, [
    'ws://127.0.0.1:9333/devtools/page/probe?x=1',
    'ws://127.0.0.1:9333/devtools/page/probe?x=1'
  ]);
});

async function ownershipFixture({ attach = false, owner = 101, queryError = null } = {}) {
  const source = await fs.readFile(new URL('../windows/host/main.mjs', import.meta.url), 'utf8');
  const match = source.match(/const verifyEndpointOwnership = (async \(\) => \{[\s\S]*?\n    \});/u);
  assert.ok(match, 'main ownership verifier was not found');
  const state = { owner, queryError, queries: 0, stopping: false };
  const report = { ownershipVerified: true };
  const sessions = new Map();
  const context = {
    options: { attachPort: attach ? 9333 : 0 },
    clientChild: { pid: 101 },
    port: 9333,
    report,
    sessions,
    get stopping() { return state.stopping; },
    getListenerOwnerPid: async () => {
      state.queries += 1;
      if (state.queryError) throw state.queryError;
      return typeof state.owner === 'function' ? state.owner() : state.owner;
    },
    listenerOwnershipVerifier: {
      // Mirrors the production contract: only the launched PID (or a stub
      // descendant) passes; real parent-chain logic is covered by
      // windows-listener-owner.test.mjs.
      verify: async (ownerPid, clientPid) => ({
        verified: Number.isInteger(ownerPid) && ownerPid === clientPid,
        reason: 'stub',
        depth: ownerPid === clientPid ? 0 : -1
      })
    }
  };
  const verify = vm.runInNewContext(`(${match[1]})`, context);
  return { state, report, sessions, verify };
}

test('监听归属变更或无法查询时关闭全部旧会话，恢复后重新通过校验', async () => {
  for (const failure of [{ owner: 202 }, { owner: null }, { queryError: new Error('query failed') }]) {
    const fixture = await ownershipFixture(failure);
    let closes = 0;
    fixture.sessions.set('first', { close() { closes += 1; } });
    fixture.sessions.set('second', { close() { closes += 1; } });
    await assert.rejects(fixture.verify(), { code: 'CX_ENDPOINT_OWNERSHIP' });
    assert.equal(closes, 2);
    assert.equal(fixture.sessions.size, 0);
    assert.equal(fixture.report.ownershipVerified, false);
    fixture.state.queryError = null;
    fixture.state.owner = 101;
    assert.equal(await fixture.verify(), true);
    assert.equal(fixture.report.ownershipVerified, true);
  }
});

test('归属校验在 attach 中不查询进程，停止后的迟到结果不能恢复验证状态', async () => {
  const attached = await ownershipFixture({ attach: true });
  assert.equal(await attached.verify(), true);
  assert.equal(attached.state.queries, 0);
  const fixture = await ownershipFixture();
  const pending = deferred();
  fixture.state.owner = () => pending.promise;
  fixture.report.ownershipVerified = false;
  const checking = fixture.verify();
  fixture.state.stopping = true;
  pending.resolve(101);
  assert.equal(await checking, false);
  assert.equal(fixture.report.ownershipVerified, false);
  assert.equal(await fixture.verify(), false);
  assert.equal(fixture.state.queries, 1);
});

function diagnosticsGlobals() {
  return {
    diagnostics: { record() {} }, connectedTargets: new Set(), retryingTargets: new Set(),
    targetRefreshFailed: false, configFailureReported: false, recordConfigFailure() {},
    // pollTargets 创建页面会话时会读静默场景的清理开关；夹具里视为"未启用清理"，
    // 因此 silentControl 传 null，不会触碰静默自毁/热键链路。
    programCleanupNeeded: false
  };
}

test('target 轮询先检查监听归属，并在建连前再次检查，失效时不接触端点', async () => {
  const source = await fs.readFile(new URL('../windows/host/main.mjs', import.meta.url), 'utf8');
  const match = source.match(/const pollTargets = (async \(\) => \{[\s\S]*?\n    \});/u);
  assert.ok(match);
  for (const failAt of [1, 2]) {
    const calls = [];
    const sessions = new Map();
    let checks = 0;
    const poll = vm.runInNewContext(`(${match[1]})`, {
      ...diagnosticsGlobals(),
      stopping: false,
      verifyEndpointOwnership: async () => {
        calls.push('ownership');
        checks += 1;
        if (checks === failAt) {
          for (const session of sessions.values()) session.close();
          sessions.clear();
          throw Object.assign(new Error('listener changed'), { code: 'CX_ENDPOINT_OWNERSHIP' });
        }
        return true;
      },
      fetchJson: async () => {
        calls.push('list');
        return [{ id: 'selected', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/selected' }];
      },
      port: 9333,
      sessions,
      sessionHistory: [],
      PageSession: class {
        async open() { calls.push('open'); }
        close() { calls.push('close'); }
      },
      logger: { info() {}, warn() {} },
      sanitizeUrl: (value) => value,
      assets: {}, configStore: {}, instanceToken: 'ownership-fixture', config: {}, loggingEnabled: false,
      collectStats() {}
    });
    await poll();
    assert.equal(calls.includes('open'), false);
    assert.deepEqual(calls.filter((call) => call !== 'close'), failAt === 1 ? ['ownership'] : ['ownership', 'list', 'ownership']);
    assert.equal(sessions.size, 0);
  }
});

test('旧会话打开失败的迟到结果不会删除已经重建的新会话', async () => {
  const source = await fs.readFile(new URL('../windows/host/main.mjs', import.meta.url), 'utf8');
  const match = source.match(/const pollTargets = (async \(\) => \{[\s\S]*?\n    \});/u);
  assert.ok(match, 'main pollTargets function was not found');
  const pending = deferred();
  const created = [];
  const sessions = new Map();
  const target = { id: 'same-target', type: 'page', url: 'https://mooc1.chaoxing.com/exam-ans/', webSocketDebuggerUrl: 'ws://fixture' };
  const pollTargets = vm.runInNewContext(`(${match[1]})`, {
    ...diagnosticsGlobals(),
    stopping: false,
    verifyEndpointOwnership: async () => true,
    fetchJson: async () => [target],
    port: 9333,
    sessions,
    sessionHistory: [],
    PageSession: class {
      constructor() { this.closed = false; created.push(this); }
      open() { return created[0] === this ? pending.promise : Promise.resolve(this); }
      close() { this.closed = true; }
    },
    logger: { info() {}, warn() {} },
    sanitizeUrl: (value) => value,
    assets: {},
    configStore: {},
    instanceToken: 'race-fixture',
    config: {},
    loggingEnabled: false,
    broadcastConfig() {},
    collectStats() {}
  });
  const firstPoll = pollTargets();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 1);
  created[0].closed = true;
  await pollTargets();
  assert.equal(created.length, 2);
  const replacement = created[1];
  assert.equal(sessions.get(target.id), replacement);
  pending.reject(new Error('old connection failed late'));
  await firstPoll;
  assert.equal(sessions.get(target.id), replacement);
  assert.equal(replacement.closed, false);
});

test('页面共享配置同步不把已选择的客户端路径当成新的启动参数验证', async () => {
  const source = await fs.readFile(new URL('../windows/host/main.mjs', import.meta.url), 'utf8');
  const match = source.match(/const pollTargets = (async \(\) => \{[\s\S]*?\n    \});/u);
  assert.ok(match);
  const snapshot = {
    clientPath: 'C:/selected/CXExam.exe',
    scanMode: 'common',
    clientFirst: true,
    settings: { 'common.settings.mutable': 'old' }
  };
  let onConfigSync;
  let broadcasts = 0;
  const warnings = [];
  const pollTargets = vm.runInNewContext(`(${match[1]})`, {
    ...diagnosticsGlobals(),
    stopping: false,
    verifyEndpointOwnership: async () => true,
    fetchJson: async () => [{ id: 'selected', type: 'page', webSocketDebuggerUrl: 'ws://fixture' }],
    port: 9333,
    sessions: new Map(),
    sessionHistory: [],
    PageSession: class {
      constructor(options) { onConfigSync = options.onConfigSync; }
      async open() {}
      isTopContext() { return true; }
    },
    logger: { info() {}, warn(message) { warnings.push(message); } },
    sanitizeUrl: (value) => value,
    assets: {},
    configStore: {
      snapshot: () => JSON.parse(JSON.stringify(snapshot)),
      updateFromPage(changes) { Object.assign(snapshot.settings, changes); return true; }
    },
    instanceToken: 'selected-client-fixture',
    config: snapshot,
    loggingEnabled: false,
    inlineConfig: {},
    runtimeOptionOverrides: {},
    cliOptions: parseHostArgs([]),
    mergeHostConfigLayers,
    applyHostOptionLayers,
    applyRuntimePolicies: (config, options) => applyHostOptionsToConfig(config, options),
    broadcastConfig() { broadcasts += 1; },
    collectStats() {}
  });
  await pollTargets();
  onConfigSync({ 'common.settings.mutable': 'new' });
  assert.deepEqual(warnings, []);
  assert.equal(snapshot.settings['common.settings.mutable'], 'new');
  assert.equal(broadcasts, 1);
});

test('首次轮询在关闭后才完成时不再启动定时器和配置监视', async () => {
  const source = await fs.readFile(new URL('../windows/host/main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('    await pollTargets();');
  const end = source.indexOf('    if (diagnosticsEnabled)', start);
  assert.ok(start >= 0 && end > start);
  let timers = 0;
  let watchers = 0;
  await vm.runInNewContext(`(async () => {${source.slice(start, end)}})()`, {
    pollTargets: async () => {},
    stopping: true,
    setInterval() { timers += 1; },
    config: { targetPollIntervalMs: 250 },
    configStore: { watch() { watchers += 1; } }
  });
  assert.equal(timers, 0);
  assert.equal(watchers, 0);
});

test('定时 target 轮询不会重叠，失败后允许下一轮继续', async () => {
  const source = await fs.readFile(new URL('../windows/host/main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('    await pollTargets();');
  const end = source.indexOf('    configWatcherOff = configStore.watch(', start);
  assert.ok(start >= 0 && end > start);
  const pending = deferred();
  let polls = 0;
  let tick;
  const warnings = [];
  await vm.runInNewContext(`(async () => {${source.slice(start, end)}})()`, {
    pollTargets: () => { polls += 1; return polls === 2 ? pending.promise : Promise.resolve(); },
    stopping: false,
    logger: { warn(message) { warnings.push(message); } },
    setInterval(callback) { tick = callback; return 1; },
    config: { targetPollIntervalMs: 250 }
  });
  tick();
  tick();
  assert.equal(polls, 2);
  pending.reject(new Error('fixture poll failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 1);
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 3);
});
