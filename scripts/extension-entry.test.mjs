import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const extensionEntryPath = resolve(process.cwd(), 'src', 'extension-entry.js');

test('extension entry does not remove work results panel in deep iframes', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('[id="panel-common-work-results"]'), false);
});

test('extension entry does not write URL-derived injection markers into dataset keys', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('root.dataset[injectedKey]'), false);
  assert.equal(source.includes('root.dataset[styleInjectedKey]'), false);
});

test('extension entry bootstraps and persists shared settings through chrome storage by prefix', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes("const sharedStoreKeyPrefix = 'common.settings.';"), true);
  assert.equal(source.includes('Object.entries(values ?? {}).forEach(([key, value]) => {'), true);
  assert.equal(source.includes("if (!key.startsWith(sharedStoreKeyPrefix) || typeof value !== 'string') {"), true);
  assert.equal(source.includes("Object.entries(detail).forEach(([key, value]) => {"), true);
  assert.equal(source.includes('chrome.storage.local.get(null, (result) => {'), true);
  assert.equal(source.includes('chaoxing-plus:shared-store-sync'), true);
  assert.equal(source.includes('common.settings.tiku-adapter.baseurl'), false);
  assert.equal(source.includes('common.settings.tiku-adapter.key'), false);
});

test('extension entry injects SweetAlert2 styles into the top document for top-window modals', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('function getSwalStyleDocument()'), true);
  assert.equal(source.includes('const topDocument = window.top?.document;'), true);
  assert.equal(source.includes('const targetDocument = getSwalStyleDocument();'), true);
  assert.equal(source.includes('(targetDocument.head || targetRoot).appendChild(link);'), true);
  assert.equal(source.includes('(document.head || root).appendChild(link);'), false);
});
