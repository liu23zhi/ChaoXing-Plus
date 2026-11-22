import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createTestDirectory, resolveTestPath } from '../test-helpers/temp-directory.mjs';

const puppeteer = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES || resolveTestPath(), 'package.json'))('puppeteer');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deviceKey = 'common.settings.device-id', browserKey = 'common.settings.device-instance';
const signalKey = 'common.settings.owned-profile-signal';

test('three live, isolated Chrome profiles send native_browser diagnostics for one host device', { timeout: 150_000 }, async t => {
  const dist = resolveTestPath('dist'), manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background?.service_worker, 'extension-worker.js');
  const root = createTestDirectory('owned-managed-profiles');
  const device = 'owned-managed-host', token = 'fixture-' + randomUUID();
  const ids = Array.from({ length: 3 }, () => randomUUID());
  const browsers = [], pages = [], starts = [], batches = [], errors = [];
  let policies = 0;
  // Wire observer only. Real TiKuHelper authorization, files and slot accounting are a separate gate.
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    try {
      assert.ok(req.headers.authorization === 'Bearer ' + token, 'unexpected fixture credential');
      assert.equal(req.headers['x-script-identity'], undefined);
      if (req.method === 'GET') {
        assert.equal(req.url, '/api/extension-logs/policy?mode=native_browser');
        policies++;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"enabled":true}'); return;
      }
      assert.equal(req.method, 'POST');
      assert.ok(['/api/extension-logs/start', '/api/extension-logs'].includes(req.url));
      let raw = '';
      for await (const chunk of req) { raw += chunk; assert.ok(raw.length <= 65536, 'oversized fixture request'); }
      const body = JSON.parse(raw);
      assert.equal(body.mode, 'native_browser');
      assert.equal(body.device_id, device);
      assert.ok(ids.includes(body.browser_id), 'not a host-supplied browser ID');
      assert.match(body.launch_id, uuid);
      assert.equal(body.version, manifest.version);
      (req.url.endsWith('/start') ? starts : batches).push(body);
      res.writeHead(201).end();
    } catch (error) { errors.push(error); res.writeHead(400).end(); }
  });
  async function until(predicate, label) {
    const limit = Date.now() + 12_000;
    while (!predicate()) {
      if (errors.length) throw errors[0];
      if (Date.now() >= limit) throw new Error(label);
      await sleep(40, undefined, { signal: t.signal });
    }
  }
  try {
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const [i, id] of ids.entries()) {
      // Sequential cold starts limit peak load; keep every profile open through the cross-profile checks.
      const browser = await puppeteer.launch({ headless: true, pipe: true, userDataDir: join(root, 'p' + i), enableExtensions: [dist],
        executablePath: process.env.CX_BROWSER_EXECUTABLE, timeout: 25_000, protocolTimeout: 18_000, signal: t.signal,
        args: ['--disable-background-networking', '--disable-component-update', '--no-proxy-server',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
      });
      browsers.push(browser);
      const worker = await browser.waitForTarget(target => target.type() === 'service_worker' &&
        /^chrome-extension:\/\/[a-p]{32}\/extension-worker\.js$/.test(target.url()), { timeout: 15_000 });
      const page = (await browser.pages())[0] || await browser.newPage();
      pages.push(page);
      await page.goto(new URL('popup.html', worker.url()).href, { timeout: 12_000 });
      await page.evaluate(fields => chrome.storage.local.set(fields), {
        'common.settings.tiku-adapter.baseurl': base, 'common.settings.tiku-adapter.key': token, [deviceKey]: device, [browserKey]: id,
      });
      await until(() => starts.length > i, 'missing real start for profile ' + i);
      assert.equal(starts[i].browser_id, id);
    }
    assert.equal(new Set(starts.map(s => s.browser_id)).size, 3);
    assert.equal(new Set(starts.map(s => s.launch_id)).size, 3);
    for (const [i, page] of pages.entries()) {
      // One signal at a time: a batch observed now must come from exactly this profile and launch.
      await page.evaluate(({ k, v }) => chrome.storage.local.set({ [k]: v }), { k: signalKey, v: i + 1 });
      await until(() => batches.length > i, 'missing real settings event for profile ' + i);
      const { entries, ...scope } = batches[i];
      assert.deepEqual(scope, starts[i]);
      assert.deepEqual(entries.map(({ time, ...entry }) => {
        assert.ok(Number.isFinite(Date.parse(time))); return entry;
      }), [{ event: 'settings.saved', level: 'info' }]);
    }
    const stored = await Promise.all(pages.map(p => p.evaluate(keys => chrome.storage.local.get(keys), [deviceKey, browserKey, signalKey])));
    assert.deepEqual(stored, ids.map((id, i) => ({ [deviceKey]: device, [browserKey]: id, [signalKey]: i + 1 })));
    assert.equal(starts.length, 3); assert.equal(batches.length, 3); assert.ok(policies >= 3);
    if (errors.length) throw errors[0];
    t.diagnostic('3 live Chrome profiles: one device, 3 host browser IDs, 3 distinct launches, 3 correctly scoped settings events');
  } finally {
    const closed = await Promise.allSettled(browsers.map(b => b.close()));
    server.closeAllConnections();
    if (server.listening) await new Promise(ok => server.close(ok));
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
});
