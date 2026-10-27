import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';

const hydrateListeners = new Map();
const moduleDocument = {
  addEventListener(type, listener) {
    hydrateListeners.set(type, listener);
  },
  dispatchEvent(event) {
    const listener = hydrateListeners.get(event.type);
    if (listener) listener(event);
    return true;
  }
};
globalThis.document = moduleDocument;
const { runtimeStore } = await loadCompiledTypeScriptModule('src/runtime/store.ts', ['windows/store-safety.js']);
delete globalThis.document;

test('runtimeStore 在缺少 DOM/localStorage 时仍可读写内存值（Windows about:blank frame 场景）', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(runtimeStore.get('common.settings.windowsProbe', 'fallback'), 'fallback');
  assert.doesNotThrow(() => runtimeStore.set('common.settings.windowsProbe', { enabled: true }));
  assert.deepEqual(runtimeStore.get('common.settings.windowsProbe', null), { enabled: true });
  assert.doesNotThrow(() => runtimeStore.remove('common.settings.windowsProbe'));
});

test('runtimeStore 在 localStorage 抛 SecurityError 时不崩溃并使用内存值', () => {
  globalThis.localStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); }
  };
  try {
    assert.equal(runtimeStore.get('common.settings.opaque', 7), 7);
    assert.doesNotThrow(() => runtimeStore.set('common.settings.opaque', 8));
    assert.equal(runtimeStore.get('common.settings.opaque', 0), 8);
    assert.doesNotThrow(() => runtimeStore.remove('common.settings.opaque'));
  } finally {
    delete globalThis.localStorage;
  }
});

test('runtimeStore 在 Windows no-disk-write 下只保留内存与属性镜像，不读写 localStorage', () => {
  const storageCalls = [];
  const attributes = new Map([
    ['data-chaoxing-plus-shared-common-settings-windows-no-disk-write', 'true']
  ]);
  globalThis.localStorage = {
    getItem(key) { storageCalls.push(['get', key]); return JSON.stringify('disk-value'); },
    setItem(key, value) { storageCalls.push(['set', key, value]); },
    removeItem(key) { storageCalls.push(['remove', key]); }
  };
  globalThis.window = { __CX_WIN_HOST__: {} };
  globalThis.document = {
    documentElement: {
      getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      removeAttribute(name) { attributes.delete(name); }
    },
    addEventListener() {},
    dispatchEvent() { return true; }
  };
  try {
    assert.equal(runtimeStore.get('common.settings.windows-no-disk-write', false), true);
    storageCalls.length = 0;
    runtimeStore.set('common.settings.windowsProbe', 'memory-value');
    assert.deepEqual(storageCalls, []);
    assert.equal(attributes.get('data-chaoxing-plus-shared-common-settings-windowsProbe'), '"memory-value"');
    assert.equal(runtimeStore.get('common.settings.windowsProbe', 'fallback'), 'memory-value');
    runtimeStore.remove('common.settings.windowsProbe');
    assert.deepEqual(storageCalls, []);
    assert.equal(attributes.has('data-chaoxing-plus-shared-common-settings-windowsProbe'), false);
    assert.equal(runtimeStore.get('common.settings.windowsProbe', 'removed'), 'removed');
    assert.deepEqual(storageCalls, []);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('runtimeStore 以内存最近值优先于 no-disk-write 页面上已有 localStorage 值', () => {
  const storageCalls = [];
  const attributes = new Map([
    ['data-chaoxing-plus-shared-common-settings-windows-no-disk-write', 'true'],
    ['data-chaoxing-plus-shared-common-settings-windowsProbe', '"attribute-value"']
  ]);
  globalThis.localStorage = {
    getItem(key) { storageCalls.push(['get', key]); return JSON.stringify('disk-value'); },
    setItem(key, value) { storageCalls.push(['set', key, value]); },
    removeItem(key) { storageCalls.push(['remove', key]); }
  };
  globalThis.window = { __CX_WIN_HOST__: {} };
  globalThis.document = {
    documentElement: {
      getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
      setAttribute(name, value) { attributes.set(name, String(value)); }
    },
    addEventListener() {},
    dispatchEvent() { return true; }
  };
  try {
    runtimeStore.set('common.settings.windowsProbe', 'memory-value');
    storageCalls.length = 0;
    assert.equal(runtimeStore.get('common.settings.windowsProbe', 'fallback'), 'memory-value');
    assert.deepEqual(storageCalls, []);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('runtimeStore 在 no-disk-write 下仍可读取已有 localStorage 配置，但不回写', () => {
  const storageCalls = [];
  const attributes = new Map([
    ['data-chaoxing-plus-shared-common-settings-windows-no-disk-write', 'true']
  ]);
  globalThis.localStorage = {
    getItem(key) {
      storageCalls.push(['get', key]);
      return key === 'common.settings.existing' ? '"disk-config"' : null;
    },
    setItem(key, value) { storageCalls.push(['set', key, value]); },
    removeItem(key) { storageCalls.push(['remove', key]); }
  };
  globalThis.window = { __CX_WIN_HOST__: {} };
  globalThis.document = {
    documentElement: {
      getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
      setAttribute(name, value) { attributes.set(name, String(value)); }
    },
    addEventListener() {},
    dispatchEvent() { return true; }
  };
  try {
    assert.equal(runtimeStore.get('common.settings.windows-no-disk-write', false), true);
    storageCalls.length = 0;
    assert.equal(runtimeStore.get('common.settings.existing', 'fallback'), 'disk-config');
    assert.deepEqual(storageCalls, [['get', 'common.settings.existing']]);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('runtimeStore 在 no-disk-write 下读取属性镜像时不回填 localStorage', () => {
  const storageCalls = [];
  const attributes = new Map([
    ['data-chaoxing-plus-shared-common-settings-windows-no-disk-write', 'true'],
    ['data-chaoxing-plus-shared-common-settings-fromHost', '"host-value"']
  ]);
  globalThis.localStorage = {
    getItem(key) { storageCalls.push(['get', key]); return null; },
    setItem(key, value) { storageCalls.push(['set', key, value]); },
    removeItem(key) { storageCalls.push(['remove', key]); }
  };
  globalThis.window = { __CX_WIN_HOST__: {} };
  globalThis.document = {
    documentElement: {
      getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
      setAttribute(name, value) { attributes.set(name, String(value)); }
    },
    addEventListener() {},
    dispatchEvent() { return true; }
  };
  try {
    assert.equal(runtimeStore.get('common.settings.windows-no-disk-write', false), true);
    storageCalls.length = 0;
    assert.equal(runtimeStore.get('common.settings.fromHost', 'fallback'), 'host-value');
    assert.deepEqual(storageCalls, []);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('runtimeStore 水合整包配置时先识别末尾的 no-disk-write 标记再写入其它值', () => {
  const storageCalls = [];
  const attributes = new Map();
  globalThis.localStorage = {
    getItem(key) { storageCalls.push(['get', key]); return null; },
    setItem(key, value) { storageCalls.push(['set', key, value]); },
    removeItem(key) { storageCalls.push(['remove', key]); }
  };
  globalThis.window = { __CX_WIN_HOST__: {} };
  globalThis.document = {
    documentElement: {
      getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
      setAttribute(name, value) { attributes.set(name, String(value)); }
    }
  };
  try {
    moduleDocument.dispatchEvent({
      type: 'chaoxing-plus:shared-store-hydrate',
      detail: {
        'common.settings.beforeFlag': 'memory-config',
        'common.settings.windows-no-disk-write': true
      }
    });

    assert.deepEqual(storageCalls, []);
    assert.equal(attributes.get('data-chaoxing-plus-shared-common-settings-beforeFlag'), '"memory-config"');
    assert.equal(runtimeStore.get('common.settings.beforeFlag', 'fallback'), 'memory-config');
    assert.equal(runtimeStore.get('common.settings.windows-no-disk-write', false), true);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
    delete globalThis.document;
  }
});
