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
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)); },
      removeItem: (key) => { storage.delete(key); }
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
