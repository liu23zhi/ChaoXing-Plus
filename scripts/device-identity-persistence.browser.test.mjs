import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import ts from '@typescript/typescript6';
import { createTestDirectory } from './test-helpers/temp-directory.mjs';
import { diagnosticBrowserArgs } from './test-helpers/local-diagnostic-page.mjs';

const key = 'common.settings.device-id';
const oldId = 'fixture-old';
const manifest = {
  manifest_version: 3, name: 'Owned Chrome storage fixture', version: '1.0',
  permissions: ['storage'], background: { service_worker: 'worker.js' }
};
const inputs = [
  'src/core/utils/request.ts', 'src/core/utils/tiku-adapter-error.ts',
  'src/runtime/device-identity.ts', 'src/runtime/agreement-gate.ts', 'src/runtime/store.ts'
];

test('real Chrome storage rejects a replacement at quota; successful recovery persists across independent extension pages', {
  timeout: 90000
}, async t => {
  const root = createTestDirectory('device-storage-confirmation'), extension = join(root, 'extension');
  await mkdir(extension);
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(extension, 'worker.js'), `
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (sender.id === chrome.runtime.id && msg?.operation === 'authorize') reply({ allowed: true });
    });
  `);
  await writeFile(join(extension, 'boot.js'), `
    globalThis.mountCxAgreement = () => {};
    globalThis.__CXPLUS_BROWSER_AGREEMENT_GATE__ = true;
  `);
  await writeFile(join(extension, 'fixture.html'), '<!doctype html><title>Owned storage fixture</title>' +
    '<script src="boot.js"></script><script src="extension-entry.js"></script><script type="module" src="probe.js"></script>');
  await copyFile('src/extension-entry.js', join(extension, 'extension-entry.js'));
  for (const file of inputs) {
    const path = join(extension, file.replace(/\.ts$/, '.js'));
    await mkdir(dirname(path), { recursive: true });
    const source = await readFile(file, 'utf8');
    await writeFile(path, ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
    }).outputText);
  }
  await writeFile(join(extension, 'probe.js'), `
    import { request } from './src/core/utils/request.js';
    import { getDeviceIdentity } from './src/runtime/device-identity.js';
    const key = ${JSON.stringify(key)};
    globalThis.fixtureIdentity = () => ({
      privateId: globalThis.__CXPLUS_PRIVATE_SETTINGS__.get(key),
      pageLocalId: localStorage.getItem(key),
      pageAttribute: document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-device-id')
    });
    globalThis.findDevice = () => getDeviceIdentity().deviceId;
    globalThis.exerciseConflict = async () => {
      const calls = [];
      const before = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        if (url !== 'https://fixture.invalid/api/search') throw Error('network not allowed');
        calls.push(init.headers['X-Device-Id']);
        return calls.length === 1 ? Response.json({ code: 'DEVICE_ID_CONFLICT' }, { status: 409 }) : Response.json({ ok: true });
      };
      let disposition;
      try {
        await request('https://fixture.invalid/api/search', { headers: { Authorization: 'Bearer local-fixture' } });
        disposition = 'ok';
      } catch (error) { disposition = error.status; }
      finally { globalThis.fetch = before; }
      return { calls, disposition, stored: (await chrome.storage.local.get(key))[key], ...fixtureIdentity() };
    };
  `);

  const browser = await puppeteer.launch({
    headless: true, enableExtensions: [extension], userDataDir: join(root, 'profile'),
    executablePath: process.env.CX_BROWSER_EXECUTABLE, args: diagnosticBrowserArgs,
  });
  t.after(() => browser.close());
  const target = await browser.waitForTarget(item => item.type() === 'service_worker' && item.url().endsWith('/worker.js'));
  const fixtureUrl = new URL('fixture.html', target.url()).href;
  const first = await browser.newPage();
  await first.goto(fixtureUrl);
  await first.waitForFunction(() => typeof globalThis.exerciseConflict === 'function');
  const used = await first.evaluate(async ({ key, oldId }) => {
    const filler = 'owned-fixture-quota';
    const capacity = chrome.storage.local.QUOTA_BYTES;
    // Current size fits exactly; replacing the short old ID with UUIDv4 requires more storage.
    const fill = capacity - key.length - JSON.stringify(oldId).length - filler.length - 2;
    await chrome.storage.local.set({ [key]: oldId, [filler]: 'x'.repeat(fill) });
    return { capacity, bytes: await chrome.storage.local.getBytesInUse(null) };
  }, { key, oldId });
  assert.equal(used.bytes, used.capacity);
  await first.waitForFunction(expected => globalThis.fixtureIdentity().privateId === expected, {}, oldId);
  const denied = await first.evaluate(() => globalThis.exerciseConflict());
  assert.deepEqual(denied, { calls: [oldId], disposition: 409, stored: oldId, privateId: oldId,
    pageLocalId: null, pageAttribute: null });

  await first.evaluate(() => chrome.storage.local.remove('owned-fixture-quota'));
  const second = await browser.newPage();
  await second.goto(fixtureUrl);
  await second.waitForFunction(expected => globalThis.fixtureIdentity?.().privateId === expected, {}, oldId);
  const accepted = await first.evaluate(() => globalThis.exerciseConflict());
  assert.equal(accepted.disposition, 'ok');
  assert.equal(accepted.calls.length, 2);
  assert.match(accepted.stored, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
  assert.notEqual(accepted.stored, oldId);
  assert.deepEqual(accepted.calls, [oldId, accepted.stored]);
  assert.equal(accepted.stored, accepted.privateId);
  assert.equal(accepted.pageLocalId, null);
  assert.equal(accepted.pageAttribute, null);
  await second.waitForFunction(expected => globalThis.findDevice() === expected, {}, accepted.stored);
  await second.reload();
  await second.waitForFunction(expected => globalThis.fixtureIdentity?.().privateId === expected, {}, accepted.stored);
  assert.equal(await second.evaluate(() => globalThis.findDevice()), accepted.stored);
  t.diagnostic('real Chrome quota rejects rotation; successful rotation uses one replay and survives another page and reload');
});
