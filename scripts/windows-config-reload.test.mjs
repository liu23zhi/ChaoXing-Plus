import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createConfigStore, mergeHostConfigLayers } from '../windows/node-source/config.mjs';
import { applyHostOptionLayers, applyHostOptionsToConfig, parseHostArgs } from '../windows/node-source/options.mjs';

test('config layer merging retains unoverridden shared settings from earlier layers', () => {
  const config = mergeHostConfigLayers({
    defaultHostConfig: { settings: { 'common.settings.default-only': 1, 'common.settings.overridden': 'default' } },
    appConfig: { settings: { 'common.settings.app-only': 2 } },
    selectedConfig: { settings: { 'common.settings.disk-only': 3 } },
    inlineConfig: { settings: { 'common.settings.overridden': 'inline', 'other.private': 4 } }
  });
  assert.equal(config.settings['common.settings.default-only'], 1);
  assert.equal(config.settings['common.settings.app-only'], 2);
  assert.equal(config.settings['common.settings.disk-only'], 3);
  assert.equal(config.settings['common.settings.overridden'], 'inline');
  assert.equal(config.settings['other.private'], undefined);
});

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await delay(10);
  }
}

async function createFixture(t, initial, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cxplus-reload-'));
  const filePath = path.join(directory, 'config.json');
  await fs.writeFile(filePath, JSON.stringify(initial), 'utf8');
  const store = createConfigStore(filePath, options);
  await store.load();
  let stopWatching = () => {};
  t.after(async () => {
    stopWatching();
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    filePath,
    watch(options) {
      stopWatching = store.watch({ intervalMs: 20, ...options });
    },
    async write(value) {
      // Let watchFile record its initial stat before changing the fixture.
      await delay(50);
      await fs.writeFile(filePath, JSON.stringify(value), 'utf8');
    }
  };
}

test('config watch reapplies CLI and inline layers while accepting unoverridden disk settings', async (t) => {
  const initial = {
    settings: {
      'common.settings.windows-panel-enabled': true,
      'common.settings.windows-answer-mode': 'auto',
      'common.settings.inline-only': 'disk-old',
      'common.settings.mutable': 'old'
    }
  };
  const fixture = await createFixture(t, initial, { persistEnabled: false });
  const cli = parseHostArgs(['--config', fixture.filePath, '--no-panel', '--answer-mode', 'manual', '--no-disk-write']);
  const inlineConfig = { settings: { 'common.settings.inline-only': 'inline' } };
  const resolveConfig = (raw) => {
    const options = applyHostOptionLayers(cli, raw, inlineConfig);
    return applyHostOptionsToConfig(mergeHostConfigLayers({ selectedConfig: raw, inlineConfig }), options);
  };
  fixture.store.replaceFromDisk(resolveConfig(initial));
  let changes = 0;
  fixture.watch({ resolveConfig, onChange: () => { changes += 1; } });
  await fixture.write({
    settings: {
      'common.settings.windows-panel-enabled': true,
      'common.settings.windows-answer-mode': 'auto',
      'common.settings.windows-no-disk-write': false,
      'common.settings.inline-only': 'disk-new',
      'common.settings.mutable': 'new'
    }
  });
  await waitFor(() => changes > 0, 'config watch did not apply the disk update');
  const settings = fixture.store.settingsSnapshot();
  assert.equal(settings['common.settings.windows-panel-enabled'], false);
  assert.equal(settings['common.settings.windows-answer-mode'], 'manual');
  assert.equal(settings['common.settings.windows-no-disk-write'], true);
  assert.equal(settings['common.settings.inline-only'], 'inline');
  assert.equal(settings['common.settings.mutable'], 'new');
});

test('config watch awaits a resolver and preserves the previous valid snapshot when it rejects', async (t) => {
  const messages = [];
  const initial = { settings: { 'common.settings.mutable': 'old' } };
  const fixture = await createFixture(t, initial, { logger: (message) => messages.push(message) });
  const before = fixture.store.snapshot();
  const revision = fixture.store.revision;
  let resolverCalled = false;
  let changes = 0;
  fixture.watch({
    resolveConfig: async () => {
      resolverCalled = true;
      await delay(10);
      throw new Error('resolver rejected fixture');
    },
    onChange: () => { changes += 1; }
  });
  await fixture.write({ settings: { 'common.settings.mutable': 'new' } });
  await waitFor(() => messages.some((message) => message.includes('resolver rejected fixture')), 'resolver failure was not handled');
  assert.equal(resolverCalled, true);
  assert.equal(changes, 0);
  assert.equal(fixture.store.revision, revision);
  assert.deepEqual(fixture.store.snapshot(), before);
});

test('config watch discards an async resolver result completed after the store closes', async (t) => {
  const initial = { settings: { 'common.settings.mutable': 'old' } };
  const fixture = await createFixture(t, initial);
  let completeResolver;
  let resolverCalled = false;
  let changes = 0;
  fixture.watch({
    resolveConfig: () => {
      resolverCalled = true;
      return new Promise((resolve) => { completeResolver = resolve; });
    },
    onChange: () => { changes += 1; }
  });
  await fixture.write({ settings: { 'common.settings.mutable': 'new' } });
  await waitFor(() => resolverCalled, 'resolver was not started');
  const before = fixture.store.snapshot();
  const revision = fixture.store.revision;
  await fixture.store.close();
  completeResolver({ settings: { 'common.settings.mutable': 'late' } });
  await delay(30);
  assert.equal(changes, 0);
  assert.equal(fixture.store.revision, revision);
  assert.deepEqual(fixture.store.snapshot(), before);
});

test('config failures notify observers without passing private errors or changing the valid snapshot', async (t) => {
  const observed = [];
  const fixture = await createFixture(t, { settings: { 'common.settings.mutable': 'old' } }, {
    onError(...args) { observed.push(args); throw new Error('observer failure must stay nonfatal'); }
  });
  const before = fixture.store.snapshot();
  fixture.watch();
  await delay(50);
  await fs.writeFile(fixture.filePath, '{private-token=invalid-json', 'utf8');
  await waitFor(() => observed.length > 0, 'invalid JSON did not notify the observer');
  assert.deepEqual(observed, [[]]);
  assert.deepEqual(fixture.store.snapshot(), before);
});
