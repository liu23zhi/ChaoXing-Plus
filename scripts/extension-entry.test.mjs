import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const extensionEntryPath = resolve(scriptsDir, '..', 'src', 'extension-entry.js');

test('extension entry does not remove work results panel in deep iframes', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('[id="panel-common-work-results"]'), false);
});

test('extension entry does not write URL-derived injection markers into dataset keys', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('root.dataset[injectedKey]'), false);
  assert.equal(source.includes('root.dataset[styleInjectedKey]'), false);
});

test('extension entry bootstraps and persists shared settings through chrome storage by exact key list', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('const sharedStoreKeys = ['), true);
  assert.equal(source.includes("'common.settings.tiku-adapter.baseurl'"), true);
  assert.equal(source.includes("'common.settings.tiku-adapter.key'"), true);
  assert.equal(source.includes('sharedStoreKeys.forEach((key) => {'), true);
  assert.equal(source.includes("if (typeof value !== 'string') {"), true);
  assert.equal(source.includes('chrome.storage.local.get(sharedStoreKeys, (result) => {'), true);
  assert.equal(source.includes('chaoxing-plus:shared-store-sync'), true);
  assert.equal(source.includes("const sharedStoreKeyPrefix = 'common.settings.';"), false);
  assert.equal(source.includes('Object.entries(values ?? {}).forEach(([key, value]) => {'), false);
  assert.equal(source.includes('chrome.storage.local.get(null, (result) => {'), false);
});

test('extension entry starts the main script without blocking on SweetAlert runtime readiness', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('async function ensureSwalRuntime()'), true);
  assert.equal(source.includes('void ensureSwalRuntime();'), true);
  assert.equal(source.includes('await ensureSwalRuntime();'), false);
  assert.equal(source.includes("script.src = chrome.runtime.getURL('chaoxing-plus.js');"), true);
});

test('runtime logger stringifies object payloads as readable JSON', async () => {
  const loggerPath = resolve(scriptsDir, '..', 'src', 'runtime', 'logger.ts');
  const source = await readFile(loggerPath, 'utf8');

  assert.equal(source.includes('const normalizedArgs = args.map((arg) => {'), true);
  assert.equal(source.includes('JSON.stringify(arg, null, 2)'), true);
  assert.equal(source.includes("return '[unserializable]';"), true);
});
