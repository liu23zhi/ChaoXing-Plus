import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const extensionEntryPath = resolve(scriptsDir, '..', 'src', 'extension-entry.js');
const indexPath = resolve(scriptsDir, '..', 'src', 'index.ts');

test('entry bootstrap does not use a top-window singleton guard that suppresses later frame panels', async () => {
  const source = await readFile(indexPath, 'utf8');

  assert.equal(source.includes("const runtimeStartedKey = '__chaoxing_plus_runtime_started__';"), false);
  assert.equal(source.includes('const runtimeOwner = window.top ?? window;'), false);
  assert.equal(source.includes("runtime already started, skip duplicate bootstrap"), false);
  assert.equal(source.includes('start(definedProjects()).catch((err) => {'), true);
});

test('entry bootstrap stays in the page only once even if extension-entry injects repeatedly in nested frames', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes("const injectedWindowKey = '__chaoxing_plus_injected__';"), true);
  assert.equal(source.includes('if (root.dataset[injectedMarkerKey] === frameMarker || window[injectedWindowKey] === frameMarker) {'), true);
  assert.equal(source.includes('window[injectedWindowKey] = frameMarker;'), true);
});

test('extension entry does not remove work results panel in deep iframes', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('[id="panel-common-work-results"]'), false);
});

test('extension entry does not write URL-derived injection markers into dataset keys', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('root.dataset[injectedKey]'), false);
  assert.equal(source.includes('root.dataset[styleInjectedKey]'), false);
});

test('extension entry bootstraps and persists shared config through namespace filters', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('const sharedStorePrefixes = ['), true);
  assert.equal(source.includes("'common.settings.'"), true);
  assert.equal(source.includes("'cx.new.study.'"), true);
  assert.equal(source.includes("'cx.new.work.'"), true);
  assert.equal(source.includes("'cx.new.auto-read.'"), true);
  assert.equal(source.includes("'cx.new.study-dispatcher.'"), true);
  assert.equal(source.includes('const sharedStoreExcludedKeys = new Set(['), true);
  assert.equal(source.includes("'common.work-results.results'"), true);
  assert.equal(source.includes("'common.apps.question-caches'"), true);
  assert.equal(source.includes('const shouldShareStoreKey = (key) => ('), true);
  assert.equal(source.includes('Object.entries(values ?? {}).forEach(([key, value]) => {'), true);
  assert.equal(source.includes('chrome.storage.local.get(null, (result) => {'), true);
  assert.equal(source.includes('const sharedStoreKeys = ['), false);
  assert.equal(source.includes('chrome.storage.local.get(sharedStoreKeys, (result) => {'), false);
});

test('extension entry hydrates shared config again when chrome storage changes in another page', async () => {
  const source = await readFile(extensionEntryPath, 'utf8');

  assert.equal(source.includes('chrome.storage.onChanged.addListener((changes, areaName) => {'), true);
  assert.equal(source.includes("if (areaName !== 'local') {"), true);
  assert.equal(source.includes('const nextValues = {};'), true);
  assert.equal(source.includes('Object.entries(changes ?? {}).forEach(([key, change]) => {'), true);
  assert.equal(source.includes('nextValues[key] = change?.newValue;'), true);
  assert.equal(source.includes('applySharedStoreValues(nextValues);'), true);
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
