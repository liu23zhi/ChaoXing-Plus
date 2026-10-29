import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';

const bootstrapPath = resolve(process.cwd(), 'windows', 'bootstrap', 'windows-bootstrap.js');

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.attributes = new Map();
    this.id = '';
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
  }

  addEventListener(type, callback) {
    this.listeners.set(String(type), callback);
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (name === 'id') this.id = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    return node;
  }

  get firstChild() {
    return this.children.length > 0 ? this.children[0] : null;
  }
}

function createHarness({ config = {}, instance = 'test-instance', styleText = '/*swal*/', readyState = 'complete', withDocumentElement = true, href = 'https://mooc1.chaoxing.com/exam-ans/exam/test/examcode/examlist?secret=1' } = {}) {
  const messages = [];
  const storage = new Map();
  const storageCalls = [];
  const listeners = new Map();
  const dispatched = [];
  const createdElements = [];
  const locationUrl = new URL(href);

  const documentObject = {
    readyState,
    documentElement: withDocumentElement ? new FakeElement('html') : null,
    head: null,
    body: null,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    removeEventListener(type, callback) {
      const list = listeners.get(type);
      if (!list) return;
      const index = list.indexOf(callback);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent(event) {
      dispatched.push(event);
      const list = listeners.get(event && event.type ? event.type : '') || [];
      for (const callback of [...list]) callback(event);
      return true;
    },
    createElement(tagName) {
      const element = new FakeElement(tagName);
      createdElements.push(element);
      return element;
    },
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text) };
    },
    getElementById(id) {
      return createdElements.find((element) => element.id === id) || null;
    }
  };
  documentObject.head = documentObject.createElement('head');
  documentObject.body = documentObject.createElement('body');
  documentObject.querySelectorAll = () => [];

  const consoleObject = {
    log: (...args) => { messages.push(String(args[0])); },
    warn: () => {},
    error: () => {}
  };

  const windowObject = {
    location: {
      href,
      origin: locationUrl.origin,
      pathname: locationUrl.pathname
    },
    localStorage: {
      getItem: (key) => { storageCalls.push(['get', key]); return storage.has(key) ? storage.get(key) : null; },
      setItem: (key, value) => { storageCalls.push(['set', key, String(value)]); storage.set(key, String(value)); },
      removeItem: (key) => { storageCalls.push(['remove', key]); storage.delete(key); }
    },
    crypto: {
      getRandomValues(array) {
        for (let index = 0; index < array.length; index += 1) array[index] = (index * 37 + 11) & 0xff;
        return array;
      }
    },
    __CX_WIN_CONFIG_JSON__: config,
    __CX_WIN_INSTANCE__: instance,
    __CX_WIN_STYLE_TEXT__: styleText
  };
  windowObject.window = windowObject;
  windowObject.self = windowObject;
  windowObject.top = windowObject;
  windowObject.Element = FakeElement;
  windowObject.MutationObserver = class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  };
  windowObject.getComputedStyle = () => ({ display: 'block' });
  windowObject.CustomEvent = class FakeCustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init ? init.detail : undefined;
    }
  };

  const sandbox = {
    window: windowObject,
    document: documentObject,
    console: consoleObject,
    CustomEvent: windowObject.CustomEvent,
    Element: FakeElement
  };
  const context = vm.createContext(sandbox);

  async function run() {
    const source = await readFile(bootstrapPath, 'utf8');
    vm.runInContext(source, context, { filename: 'windows-bootstrap.js' });
  }

  function parseMessages() {
    return messages
      .filter((message) => message.startsWith('__CX_WIN_MSG__'))
      .map((message) => JSON.parse(message.slice('__CX_WIN_MSG__'.length)));
  }

  function fireDomContentLoaded() {
    const list = listeners.get('DOMContentLoaded') || [];
    for (const callback of [...list]) callback({ type: 'DOMContentLoaded' });
  }

  return {
    window: windowObject,
    document: documentObject,
    storage,
    storageCalls,
    messages,
    dispatched,
    parseMessages,
    run,
    fireDomContentLoaded
  };
}

test('bootstrap 水合共享配置、建立 host bridge 并发送 ready', async () => {
  const harness = createHarness({
    config: {
      'common.settings.extension-enabled': true,
      'common.settings.theme': 'pink',
      'cx.new.study.auto': { enabled: true },
      'common.work-results.results': [{ secret: true }],
      'other.key': 'ignored'
    }
  });
  await harness.run();

  assert.equal(typeof harness.window.__CX_WIN_HOST__, 'object');
  assert.equal(harness.window.__CX_WIN_HOST__.version, '1.0.0');
  assert.equal(harness.storage.get('common.settings.theme'), '"pink"');
  assert.equal(harness.storage.has('other.key'), false);
  assert.equal(harness.storage.has('common.work-results.results'), false);
  assert.equal(
    harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-theme'),
    '"pink"'
  );
  const styleElement = harness.document.getElementById('chaoxing-plus-windows-swal-style');
  assert.notEqual(styleElement, null);
  assert.equal(styleElement.children[0].textContent, '/*swal*/');
  const messages = harness.parseMessages();
  assert.equal(messages.some((message) => message.kind === 'ready'), true);
  assert.equal(messages.some((message) => message.kind === 'disabled'), false);
});

function diagnosticSnapshot(instance = 'test-instance', entries = [{ sequence: 1, elapsedMs: 0, level: 'info', code: 'host-started' }]) {
  return { source: 'chaoxing-plus-windows-host', instance, entries };
}

test('bootstrap keeps a defensive bounded diagnostics snapshot entirely in memory', async () => {
  const harness = createHarness({ config: { 'common.settings.windows-no-disk-write': true } });
  await harness.run();
  const host = harness.window.__CX_WIN_HOST__;
  const messages = harness.messages.length;
  const storageCalls = harness.storageCalls.length;
  const snapshot = diagnosticSnapshot();
  assert.equal(host.setDiagnostics(snapshot), true);
  snapshot.entries[0].code = 'page-error';
  const copy = host.getDiagnostics();
  assert.equal(copy[0].code, 'host-started');
  copy[0].code = 'config-failed';
  copy.push({ sequence: 2 });
  assert.equal(host.getDiagnostics().length, 1);
  assert.equal(host.getDiagnostics()[0].code, 'host-started');
  const eventCount = () => harness.dispatched.filter((event) => event.type === 'chaoxing-plus:windows-host-diagnostics').length;
  assert.equal(eventCount(), 1);
  assert.equal(host.setDiagnostics(diagnosticSnapshot()), true);
  assert.equal(eventCount(), 1, 'duplicate snapshots do not notify or append');
  assert.equal(harness.messages.length, messages, 'diagnostics must not enter the host config channel');
  assert.equal(harness.storageCalls.length, storageCalls);
  assert.equal(harness.dispatched.find((event) => event.type === 'chaoxing-plus:windows-host-diagnostics').detail, undefined);
});

test('bootstrap rejects malformed diagnostics atomically and accepts only fixed codes and sorted safe sequences', async () => {
  const harness = createHarness();
  await harness.run();
  const host = harness.window.__CX_WIN_HOST__;
  assert.equal(host.setDiagnostics(diagnosticSnapshot()), true);
  const invalid = [
    { ...diagnosticSnapshot(), source: 'other' }, diagnosticSnapshot('old-instance'),
    diagnosticSnapshot('', []), diagnosticSnapshot('test-instance', {}),
    diagnosticSnapshot('test-instance', Array.from({ length: 101 }, (_, index) => ({ sequence: index + 1, elapsedMs: index, level: 'info', code: 'session-connected' }))),
    ...[
      { sequence: 0 }, { sequence: 1.5 }, { sequence: 9007199254740992 },
      { elapsedMs: -1 }, { elapsedMs: Infinity }, { elapsedMs: '1' },
      { level: 'debug' }, { code: 'arbitrary message' }
    ].map((patch) => diagnosticSnapshot('test-instance', [{ sequence: 2, elapsedMs: 1, level: 'info', code: 'bundle-ready', ...patch }])),
    diagnosticSnapshot('test-instance', [
      { sequence: 2, elapsedMs: 1, level: 'info', code: 'bundle-ready' },
      { sequence: 2, elapsedMs: 2, level: 'warn', code: 'session-retry' }
    ])
  ];
  for (const snapshot of invalid) assert.equal(host.setDiagnostics(snapshot), false, JSON.stringify(snapshot));
  assert.equal(host.getDiagnostics()[0].code, 'host-started');
  const bounded = Array.from({ length: 100 }, (_, index) => ({ sequence: index + 10, elapsedMs: index / 2, level: 'info', code: 'session-connected' }));
  assert.equal(host.setDiagnostics(diagnosticSnapshot('test-instance', bounded)), true);
  assert.equal(host.getDiagnostics().length, 100);
});

test('bootstrap preserves diagnostics on same-instance reconnect and clears before a new host takes over', async () => {
  const harness = createHarness();
  await harness.run();
  const host = harness.window.__CX_WIN_HOST__;
  host.setDiagnostics(diagnosticSnapshot());
  await harness.run();
  assert.equal(host.getDiagnostics().length, 1);
  harness.window.__CX_WIN_INSTANCE__ = 'next-instance';
  await harness.run();
  assert.equal(harness.window.__CX_WIN_HOST__, host);
  assert.equal(host.getDiagnostics().length, 0);
  assert.equal(host.setDiagnostics(diagnosticSnapshot()), false);
  assert.equal(host.setDiagnostics(diagnosticSnapshot('next-instance')), true);
  assert.equal(harness.dispatched.filter((event) => event.type === 'chaoxing-plus:windows-host-diagnostics').length, 3);
});

test('bootstrap 在 no-disk-write 配置位于整包任意位置时只写 DOM 属性，不写 localStorage', async () => {
  const harness = createHarness({
    config: {
      'common.settings.theme': 'pink',
      'cx.new.study.auto': { enabled: true },
      'common.settings.windows-no-disk-write': true
    }
  });
  await harness.run();

  assert.deepEqual(harness.storageCalls, []);
  assert.equal(harness.storage.has('common.settings.theme'), false);
  assert.equal(
    harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-theme'),
    '"pink"'
  );
  assert.equal(
    harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-cx-new-study-auto'),
    '{"enabled":true}'
  );
});

test('bootstrap 在动态配置整包开启 no-disk-write 后不写 localStorage，仍回传内存配置同步', async () => {
  const harness = createHarness({
    config: { 'common.settings.extension-enabled': true }
  });
  await harness.run();
  harness.storageCalls.length = 0;

  harness.window.__CX_WIN_ON_CONFIG__({
    kind: 'config',
    values: {
      'common.settings.theme': 'pink',
      'common.settings.windows-no-disk-write': true
    }
  });
  assert.deepEqual(harness.storageCalls, []);
  assert.equal(harness.storage.has('common.settings.theme'), false);
  assert.equal(
    harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-theme'),
    '"pink"'
  );

  harness.document.dispatchEvent({
    type: 'chaoxing-plus:shared-store-sync',
    detail: { 'common.settings.theme': 'blue' }
  });
  assert.equal(harness.parseMessages().some((message) => message.kind === 'config-sync'), true);
});

test('bootstrap 在 documentElement 未就绪时延迟写属性，并在 DOMContentLoaded 后发 ready', async () => {
  const harness = createHarness({
    config: { 'common.settings.a': 1 },
    readyState: 'loading',
    withDocumentElement: false
  });
  await harness.run();
  assert.equal(harness.parseMessages().some((message) => message.kind === 'ready'), false);
  assert.equal(harness.storage.get('common.settings.a'), '1');
  harness.document.documentElement = new FakeElement('html');
  harness.fireDomContentLoaded();
  assert.equal(harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-a'), '1');
  assert.equal(harness.parseMessages().some((message) => message.kind === 'ready'), true);
});

test('bootstrap 的 replaceChildren polyfill 与随机 UUID 兜底可用', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const element = new FakeElement('div');
  element.appendChild({ nodeType: 3, textContent: 'old' });
  assert.equal(typeof element.replaceChildren, 'function');
  element.replaceChildren('a', { nodeType: 3, textContent: 'b' });
  assert.equal(element.children.length, 2);
  assert.equal(element.children[0].nodeType, 3);
  assert.equal(element.children[0].textContent, 'a');
  assert.equal(typeof harness.window.crypto.randomUUID, 'function');
  assert.match(harness.window.crypto.randomUUID(), /^[0-9a-f-]{36}$/);
});

test('bootstrap 在总开关关闭时只上报 disabled，不请求业务注入', async () => {
  const harness = createHarness({
    config: { 'common.settings.extension-enabled': false }
  });
  await harness.run();
  const messages = harness.parseMessages();
  assert.equal(messages.some((message) => message.kind === 'disabled'), true);
  assert.equal(messages.some((message) => message.kind === 'ready'), false);
  assert.equal(typeof harness.window.__CX_WIN_HOST__, 'object');
});

test('bootstrap 回传配置变更时只同步共享键，并执行宿主的配置广播', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  harness.document.dispatchEvent({
    type: 'chaoxing-plus:shared-store-sync',
    detail: {
      'common.settings.b': 5,
      'other.key': 1
    }
  });
  const syncMessage = harness.parseMessages().find((message) => message.kind === 'config-sync');
  assert.equal(syncMessage.source, 'chaoxing-plus-windows');
  assert.equal(syncMessage.instance, 'test-instance');
  assert.deepEqual(syncMessage.detail, { 'common.settings.b': 5 });

  harness.window.__CX_WIN_ON_CONFIG__({
    kind: 'config',
    values: {
      'common.settings.b': 6,
      'other.key': 2
    }
  });
  assert.equal(harness.storage.get('common.settings.b'), '6');
  assert.equal(harness.storage.has('other.key'), false);
  const hydrateEvent = harness.dispatched.find((event) => event.type === 'chaoxing-plus:shared-store-hydrate');
  assert.deepEqual(JSON.parse(JSON.stringify(hydrateEvent.detail)), { 'common.settings.b': 6 });
});

test('bootstrap 安装面板生命周期观测并上报 panel-state', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const messages = harness.parseMessages();
  const panelState = messages.find((message) => message.kind === 'panel-state');
  assert.notEqual(panelState, undefined);
  assert.equal(typeof panelState.detail.count, 'number');
  assert.equal(typeof panelState.detail.visible, 'number');
  const source = await readFile(bootstrapPath, 'utf8');
  assert.equal(source.includes('function installPanelLifecycleObserver()'), true);
  assert.equal(source.includes("report('panel-state'"), true);
  assert.equal(source.includes('data-chaoxing-plus-panel-owner'), true);
});

test('bootstrap 在考试相关页面提前挂载折叠面板壳', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();

  const messages = harness.parseMessages();
  const shellMessage = messages.find((message) => message.kind === 'panel-shell');
  assert.notEqual(shellMessage, undefined);
  const shell = harness.document.getElementById('panel-common-work-results');
  assert.notEqual(shell, null);
  assert.equal(shell.getAttribute('data-cx-win-panel-shell'), '1');
  assert.equal(shell.getAttribute('data-chaoxing-plus-theme'), 'pink');
  assert.equal(harness.document.body.children.includes(shell), true);
  assert.equal(harness.document.documentElement.getAttribute('data-chaoxing-plus-panel-owner'), harness.window.location.href);

  const source = await readFile(bootstrapPath, 'utf8');
  assert.equal(source.includes('function mountPanelShell()'), true);
  assert.equal(source.includes("send('panel-shell'"), true);
  assert.equal(source.includes('__CX_WIN_SHELL_EXPAND_REQUESTED__'), true);
});

test('bootstrap 折叠壳按 --panel-theme 着色，未知主题回退 pink 并支持热更新', async () => {
  for (const [theme, expected] of [['blue', 'blue'], ['green', 'green'], ['light-purple', 'pink'], ['', 'pink']]) {
    const harness = createHarness({
      config: {
        'common.settings.extension-enabled': true,
        'common.settings.windows-panel-theme': theme
      }
    });
    await harness.run();
    const shell = harness.document.getElementById('panel-common-work-results');
    assert.notEqual(shell, null, theme);
    assert.equal(shell.getAttribute('data-chaoxing-plus-theme'), expected, theme);
  }
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const shell = harness.document.getElementById('panel-common-work-results');
  harness.window.__CX_WIN_ON_CONFIG__({
    kind: 'config',
    values: { 'common.settings.windows-panel-theme': 'green' }
  });
  assert.equal(shell.getAttribute('data-chaoxing-plus-theme'), 'green');
  assert.equal(harness.window.__CX_WIN_CONFIG_JSON__ !== undefined, true);

  const source = await readFile(bootstrapPath, 'utf8');
  assert.equal(source.includes('function applyPanelShellTheme('), true);
  assert.equal(source.includes("PANEL_THEME_STYLES = {"), true);
  for (const gradient of ['#fff0f7', '#f0f6ff', '#ecfdf5']) {
    assert.equal(source.includes(gradient), true, gradient);
  }
});

test('bootstrap 在宿主关闭 Windows 面板时不挂载面板壳', async () => {
  const harness = createHarness({
    config: {
      'common.settings.extension-enabled': true,
      'common.settings.windows-panel-enabled': false
    }
  });
  await harness.run();

  assert.equal(harness.document.getElementById('panel-common-work-results'), null);
  assert.equal(harness.parseMessages().some((message) => message.kind === 'panel-shell'), false);
  assert.equal(harness.parseMessages().some((message) => message.kind === 'panel-state'), false);
});

test('bootstrap 折叠壳使用启动参数提供的面板位置和宽度', async () => {
  const harness = createHarness({
    config: {
      'common.settings.extension-enabled': true,
      'common.settings.windows-panel-top': 28,
      'common.settings.windows-panel-right': 42,
      'common.settings.windows-panel-width': 520
    }
  });
  await harness.run();

  const shell = harness.document.getElementById('panel-common-work-results');
  assert.equal(shell.style.top, '28px');
  assert.equal(shell.style.right, '42px');
  assert.equal(shell.style.width, '520px');
});

test('bootstrap 在非考试/答题页面不挂载面板壳', async () => {
  const harness = createHarness({
    config: { 'common.settings.extension-enabled': true },
    href: 'https://passport2.chaoxing.com/login?loginType=4&fid=2182'
  });
  await harness.run();
  assert.equal(harness.document.getElementById('panel-common-work-results'), null);
  assert.equal(harness.parseMessages().some((message) => message.kind === 'panel-shell'), false);
});

test('bootstrap 在面板壳上点击展开会记录请求标记', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const shell = harness.document.getElementById('panel-common-work-results');
  assert.notEqual(shell, null);
  const header = shell.children[0];
  assert.notEqual(header, undefined);
  assert.equal(typeof header.listeners.get('click'), 'function');
  header.listeners.get('click')();
  assert.equal(harness.window.__CX_WIN_SHELL_EXPAND_REQUESTED__, true);
});

test('bootstrap 在同一文档重复注入时不会重复发 ready', async () => {
  const harness = createHarness({ config: { 'common.settings.extension-enabled': true } });
  await harness.run();
  const firstReadyCount = harness.parseMessages().filter((message) => message.kind === 'ready').length;
  await harness.run();
  const secondReadyCount = harness.parseMessages().filter((message) => message.kind === 'ready').length;
  assert.equal(firstReadyCount, 1);
  assert.equal(secondReadyCount, 1);
});

test('bootstrap 同实例重连复用配置桥水合新快照，不重复安装监听或面板', async () => {
  const harness = createHarness({
    config: {
      'common.settings.extension-enabled': true,
      'common.settings.theme': 'initial'
    }
  });
  await harness.run();
  const initialHost = harness.window.__CX_WIN_HOST__;
  const initialBridge = harness.window.__CX_WIN_ON_CONFIG__;
  const initialPanel = harness.document.getElementById('panel-common-work-results');
  harness.storageCalls.length = 0;
  harness.window.__CX_WIN_CONFIG_JSON__ = {
    'common.settings.extension-enabled': true,
    'common.settings.theme': 'reconnected',
    'common.settings.windows-no-disk-write': true
  };
  await harness.run();

  assert.equal(harness.window.__CX_WIN_HOST__, initialHost);
  assert.equal(harness.window.__CX_WIN_ON_CONFIG__, initialBridge);
  assert.equal(initialHost.getConfig()['common.settings.theme'], 'reconnected');
  assert.equal(initialHost.getConfig()['common.settings.windows-no-disk-write'], true);
  assert.equal(harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-theme'), '"reconnected"');
  assert.deepEqual(harness.storageCalls, []);
  assert.equal(harness.document.getElementById('panel-common-work-results'), initialPanel);
  assert.equal(harness.parseMessages().filter((message) => message.kind === 'ready').length, 1);
  assert.equal(harness.parseMessages().filter((message) => message.kind === 'panel-shell').length, 1);
  assert.equal(harness.dispatched.filter((event) => event.type === 'chaoxing-plus:shared-store-hydrate').length, 1);
  harness.document.dispatchEvent({
    type: 'chaoxing-plus:shared-store-sync',
    detail: { 'common.settings.theme': 'updated-after-reconnect' }
  });
  assert.equal(harness.parseMessages().filter((message) => message.kind === 'config-sync').length, 1);
});

test('bootstrap 新宿主接管旧文档时更新原有发送闭包和完整快照，不重复监听或面板', async () => {
  const harness = createHarness({ instance: 'native-first', config: {
    'common.settings.extension-enabled': true,
    'common.settings.theme': 'initial',
    'common.settings.retired': 'old'
  } });
  await harness.run();
  const initialHost = harness.window.__CX_WIN_HOST__;
  const initialSend = initialHost.send;
  const initialBridge = harness.window.__CX_WIN_ON_CONFIG__;
  const initialPanel = harness.document.getElementById('panel-common-work-results');
  harness.storageCalls.length = 0;
  harness.window.__CX_WIN_INSTANCE__ = 'native-second';
  harness.window.__CX_WIN_CONFIG_JSON__ = {
    'common.settings.extension-enabled': true,
    'common.settings.theme': 'second-host',
    'common.settings.windows-no-disk-write': true
  };
  await harness.run();

  assert.equal(harness.window.__CX_WIN_HOST__, initialHost);
  assert.equal(harness.window.__CX_WIN_ON_CONFIG__, initialBridge);
  assert.equal(initialHost.instance, 'native-second');
  assert.equal(initialHost.send, initialSend);
  assert.equal(initialHost.getConfig()['common.settings.theme'], 'second-host');
  assert.equal(Object.hasOwn(initialHost.getConfig(), 'common.settings.retired'), false);
  assert.equal(harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-theme'), '"second-host"');
  assert.equal(harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-retired'), null);
  assert.deepEqual(harness.storageCalls, []);
  assert.equal(harness.document.getElementById('panel-common-work-results'), initialPanel);
  assert.equal(harness.parseMessages().filter((message) => message.kind === 'panel-shell').length, 1);
  assert.equal(harness.parseMessages().filter((message) => message.kind === 'ready').length, 2);

  initialSend('config-sync', { 'common.settings.theme': 'from-original-send-function' });
  harness.document.dispatchEvent({ type: 'chaoxing-plus:shared-store-sync',
    detail: { 'common.settings.theme': 'from-original-listener' } });
  const syncMessages = harness.parseMessages().filter((message) => message.kind === 'config-sync');
  assert.equal(syncMessages.length, 2);
  assert.equal(syncMessages.every((message) => message.instance === 'native-second'), true);
  assert.deepEqual(syncMessages[1].detail, { 'common.settings.theme': 'from-original-listener' });
  await harness.run();
  assert.equal(harness.parseMessages().filter((message) => message.kind === 'ready').length, 2);
  harness.window.__CX_WIN_ON_CONFIG__({ kind: 'config', values: { 'common.settings.incremental': true } });
  assert.equal(initialHost.getConfig()['common.settings.theme'], 'second-host');
  assert.equal(initialHost.getConfig()['common.settings.incremental'], true);
});

test('bootstrap 完整快照删除旧共享配置并保留增量消息和非共享存储', async () => {
  const harness = createHarness({ config: {
    'common.settings.extension-enabled': true,
    'common.settings.retired': 'old',
    'common.settings.keep': 'retained'
  } });
  await harness.run();
  harness.storage.set('other.private', 'unrelated');
  harness.window.__CX_WIN_ON_CONFIG__({ kind: 'config', replace: true, values: {
    'common.settings.extension-enabled': true,
    'common.settings.keep': 'retained',
    'common.settings.added': 'new',
    'other.private': 'ignored'
  } });
  assert.equal(Object.hasOwn(harness.window.__CX_WIN_HOST__.getConfig(), 'common.settings.retired'), false);
  assert.equal(Object.hasOwn(harness.window.__CX_WIN_HOST__.getConfig(), 'other.private'), false);
  assert.equal(harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-retired'), null);
  assert.equal(harness.storage.has('common.settings.retired'), false);
  assert.equal(harness.storage.get('other.private'), 'unrelated');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.dispatched.find((event) =>
    event.type === 'chaoxing-plus:shared-store-remove').detail)), ['common.settings.retired']);
  assert.equal(harness.parseMessages().some((message) => message.kind === 'config-sync'), false);
  harness.window.__CX_WIN_ON_CONFIG__({ kind: 'config', values: { 'common.settings.retired': 'restored' } });
  assert.equal(harness.window.__CX_WIN_HOST__.getConfig()['common.settings.keep'], 'retained');
  assert.equal(harness.window.__CX_WIN_HOST__.getConfig()['common.settings.retired'], 'restored');
  assert.equal(harness.storage.get('common.settings.retired'), '"restored"');
});

test('bootstrap no-disk-write 完整快照删除内存及 DOM 镜像但不触碰旧磁盘值', async () => {
  const harness = createHarness({ config: {
    'common.settings.windows-no-disk-write': true,
    'common.settings.retired': 'memory-value'
  } });
  harness.storage.set('common.settings.retired', '"old-disk-value"');
  await harness.run();
  harness.storageCalls.length = 0;
  harness.window.__CX_WIN_ON_CONFIG__({ kind: 'config', replace: true,
    values: { 'common.settings.windows-no-disk-write': true } });
  assert.equal(Object.hasOwn(harness.window.__CX_WIN_HOST__.getConfig(), 'common.settings.retired'), false);
  assert.equal(harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-retired'), null);
  assert.equal(harness.storage.get('common.settings.retired'), '"old-disk-value"');
  assert.deepEqual(harness.storageCalls, []);
});

test('bootstrap 完整快照清理未就绪属性队列并容忍不透明 origin，重新添加可恢复', async () => {
  const harness = createHarness({ config: { 'common.settings.retired': 'old' },
    readyState: 'loading', withDocumentElement: false });
  await harness.run();
  Object.defineProperty(harness.window, 'localStorage', { get() { throw new Error('SecurityError'); } });
  harness.window.__CX_WIN_ON_CONFIG__({ kind: 'config', replace: true, values: {} });
  harness.document.documentElement = new FakeElement('html');
  harness.fireDomContentLoaded();
  assert.equal(harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-retired'), null);
  assert.equal(Object.hasOwn(harness.window.__CX_WIN_HOST__.getConfig(), 'common.settings.retired'), false);
  harness.window.__CX_WIN_ON_CONFIG__({ kind: 'config', replace: true,
    values: { 'common.settings.retired': 'restored' } });
  assert.equal(harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-retired'), '"restored"');
  assert.equal(harness.window.__CX_WIN_HOST__.getConfig()['common.settings.retired'], 'restored');
});

test('bootstrap 同文档重连使用完整快照删除已移除的共享配置', async () => {
  const harness = createHarness({ config: { 'common.settings.retired': 'old' } });
  await harness.run();
  harness.window.__CX_WIN_CONFIG_JSON__ = {};
  await harness.run();
  assert.equal(Object.hasOwn(harness.window.__CX_WIN_HOST__.getConfig(), 'common.settings.retired'), false);
  assert.equal(harness.storage.has('common.settings.retired'), false);
  assert.equal(harness.document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-retired'), null);
});
