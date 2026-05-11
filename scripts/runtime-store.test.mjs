import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const helperModulePath = resolve(process.cwd(), '.tmp-tests', 'store.js');
const helperSourcePath = resolve(process.cwd(), 'src', 'runtime', 'store.ts');
const tscCliPath = resolve(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
let importVersion = 0;

async function compileStoreHelper() {
  await execFileAsync(process.execPath, [
    tscCliPath,
    helperSourcePath,
    '--outDir',
    resolve(process.cwd(), '.tmp-tests'),
    '--module',
    'nodenext',
    '--target',
    'es2022',
    '--moduleResolution',
    'nodenext'
  ]);
}

async function loadStoreModule() {
  try {
    await compileStoreHelper();
    const moduleUrl = new URL(pathToFileURL(helperModulePath).href);
    moduleUrl.searchParams.set('v', String(importVersion++));
    return await import(moduleUrl.href);
  } catch {
    return {};
  }
}

test('runtime store falls back to shared bootstrap values when localStorage is empty', async () => {
  const memory = new Map();
  const attributes = new Map([
    ['data-chaoxing-plus-shared-common-settings-tiku-adapter-baseurl', '"https://adapter.shared"'],
    ['data-chaoxing-plus-shared-common-settings-tiku-adapter-key', '"shared-key"'],
    ['data-chaoxing-plus-shared-cx-new-study-playbackRate', '"2.5"'],
    ['data-chaoxing-plus-shared-cx-new-study-enableAIFallbackAnswer', '"true"']
  ]);

  globalThis.localStorage = {
    getItem(key) {
      return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
      memory.set(key, value);
    },
    removeItem(key) {
      memory.delete(key);
    }
  };
  globalThis.document = {
    documentElement: {
      getAttribute(name) {
        return attributes.has(name) ? attributes.get(name) : null;
      },
      setAttribute(name, value) {
        attributes.set(name, value);
      },
      removeAttribute(name) {
        attributes.delete(name);
      }
    },
    addEventListener() {},
    dispatchEvent() {
      return true;
    }
  };

  const mod = await loadStoreModule();

  assert.equal(typeof mod.runtimeStore?.get, 'function');
  assert.equal(mod.runtimeStore.get('common.settings.tiku-adapter.baseurl', ''), 'https://adapter.shared');
  assert.equal(mod.runtimeStore.get('common.settings.tiku-adapter.key', ''), 'shared-key');
  assert.equal(mod.runtimeStore.get('cx.new.study.playbackRate', ''), '2.5');
  assert.equal(mod.runtimeStore.get('cx.new.study.enableAIFallbackAnswer', ''), 'true');
});

test('runtime store updates shared config when the extension hydrates another page', async () => {
  const memory = new Map();
  const attributes = new Map();
  const listeners = new Map();

  globalThis.localStorage = {
    getItem(key) {
      return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
      memory.set(key, value);
    },
    removeItem(key) {
      memory.delete(key);
    }
  };
  globalThis.document = {
    documentElement: {
      getAttribute(name) {
        return attributes.has(name) ? attributes.get(name) : null;
      },
      setAttribute(name, value) {
        attributes.set(name, value);
      },
      removeAttribute(name) {
        attributes.delete(name);
      }
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatchEvent(event) {
      listeners.get(event.type)?.(event);
      return true;
    }
  };

  const mod = await loadStoreModule();

  globalThis.document.dispatchEvent({
    type: 'chaoxing-plus:shared-store-hydrate',
    detail: {
      'common.settings.tiku-adapter.baseurl': 'https://adapter.live',
      'common.settings.tiku-adapter.key': 'live-key',
      'cx.new.study.playbackRate': '2.25',
      'cx.new.study.enableChapterTest': false
    }
  });

  assert.equal(mod.runtimeStore.get('common.settings.tiku-adapter.baseurl', ''), 'https://adapter.live');
  assert.equal(mod.runtimeStore.get('common.settings.tiku-adapter.key', ''), 'live-key');
  assert.equal(mod.runtimeStore.get('cx.new.study.playbackRate', ''), '2.25');
  assert.equal(mod.runtimeStore.get('cx.new.study.enableChapterTest', true), false);
});

test('runtime store reads the latest localStorage value even after another page writes it', async () => {
  const memory = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return memory.has(key) ? memory.get(key) : null;
    },
    setItem(key, value) {
      memory.set(key, value);
    },
    removeItem(key) {
      memory.delete(key);
    }
  };
  globalThis.document = {
    documentElement: {
      getAttribute() {
        return null;
      },
      setAttribute() {},
      removeAttribute() {}
    },
    addEventListener() {},
    dispatchEvent() {
      return true;
    }
  };

  const mod = await loadStoreModule();

  assert.equal(typeof mod.runtimeStore?.get, 'function');
  assert.equal(typeof mod.runtimeStore?.set, 'function');

  mod.runtimeStore.set('shared-key', 'first');
  memory.set('shared-key', JSON.stringify('second'));

  assert.equal(mod.runtimeStore.get('shared-key', ''), 'second');
});
