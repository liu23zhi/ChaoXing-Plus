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

test('extension entry bootstraps and persists shared tiku config through chrome storage', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('common.settings.tiku-adapter.baseurl'), true);
  assert.equal(source.includes('common.settings.tiku-adapter.key'), true);
  assert.equal(source.includes('chrome.storage.local.get'), true);
  assert.equal(source.includes('chaoxing-plus:shared-store-sync'), true);
});

test('extension entry injects SweetAlert2 styles into the top document for top-window modals', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('function getSwalStyleDocument()'), true);
  assert.equal(source.includes('const topDocument = window.top?.document;'), true);
  assert.equal(source.includes('const targetDocument = getSwalStyleDocument();'), true);
  assert.equal(source.includes('(targetDocument.head || targetRoot).appendChild(link);'), true);
  assert.equal(source.includes('(document.head || root).appendChild(link);'), false);
});
