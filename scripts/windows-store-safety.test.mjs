import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCompiledTypeScriptModule } from './test-helpers/load-compiled-typescript.mjs';

const { runtimeStore } = await loadCompiledTypeScriptModule('src/runtime/store.ts', ['windows/store-safety.js']);

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
