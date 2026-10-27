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
    target: { id: 'lifecycle', url: 'https://mooc1.chaoxing.com/exam-ans/' },
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
  socket.close = () => {};
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
      bootstrap: 'window.__CX_WIN_HOST__=true;window.bootstrapRuns=(window.bootstrapRuns||0)+1;console.log(\'__CX_WIN_MSG__{"kind":"ready"}\');',
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
  const pending = deferred();
  let executions = 0;
  session.evaluateOrThrow = async () => { executions += 1; await pending.promise; };
  const first = session.handlePageMessage({ kind: 'ready' }, 1);
  const second = session.handlePageMessage({ kind: 'ready' }, 1);
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(executions, 1);
  assert.equal(session.stats.bundles, 1);
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

test('旧会话打开失败的迟到结果不会删除已经重建的新会话', async () => {
  const source = await fs.readFile(new URL('../windows/host/main.mjs', import.meta.url), 'utf8');
  const match = source.match(/const pollTargets = (async \(\) => \{[\s\S]*?\n    \});/u);
  assert.ok(match, 'main pollTargets function was not found');
  const pending = deferred();
  const created = [];
  const sessions = new Map();
  const target = { id: 'same-target', type: 'page', url: 'https://mooc1.chaoxing.com/exam-ans/', webSocketDebuggerUrl: 'ws://fixture' };
  const pollTargets = vm.runInNewContext(`(${match[1]})`, {
    stopping: false,
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
    stopping: false,
    fetchJson: async () => [{ id: 'selected', type: 'page', webSocketDebuggerUrl: 'ws://fixture' }],
    port: 9333,
    sessions: new Map(),
    sessionHistory: [],
    PageSession: class {
      constructor(options) { onConfigSync = options.onConfigSync; }
      async open() {}
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
