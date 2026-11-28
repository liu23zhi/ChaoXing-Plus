import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTestDirectory, resolveTestPath } from '../test-helpers/temp-directory.mjs';
import { diagnosticBrowserArgs, openDiagnosticPage } from '../test-helpers/local-diagnostic-page.mjs';

const puppeteer = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES || resolveTestPath(), 'package.json'))('puppeteer');
const deviceKey = 'common.settings.device-id', browserKey = 'common.settings.device-instance';
const signalKey = 'common.settings.owned-profile-signal';

test('three live native-owned profiles keep their distinct identities without an authorized diagnostic path', { timeout: 150_000 }, async t => {
  const dist = resolveTestPath('dist'), manifest = JSON.parse(await readFile(join(dist,'manifest.json'),'utf8'));
  assert.equal(manifest.manifest_version,3);
  assert.deepEqual(manifest.permissions,['storage']);
  assert.equal(manifest.background?.service_worker,'extension-worker.js');
  const root = createTestDirectory('owned-managed-profiles'), ext = join(root,'owned-scratch-ext');
  await cp(dist, ext, {recursive: true});
  await writeFile(join(ext,'extension-agreement-config.js'), "export const defaultBase = '';\n");
  const device = 'owned-managed-host', ids = Array.from({length:3}, () => randomUUID());
  const browsers = [], pages = [];
  let calls = 0;
  // An owned sentinel that would accept the legacy opportunistic sender. No
  // profile should reach it (not even a policy GET) using writable host values.
  const server = createServer((req,res) => {
    if (req.url.startsWith('/api/extension-logs')) calls++;
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.writeHead(200, {'Content-Type':'application/json'}).end('{"enabled":true}');
  });
  try {
    await new Promise((ok,fail) => {server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const [i, id] of ids.entries()) {
      const browser = await puppeteer.launch({headless:true, pipe:true, enableExtensions:true, userDataDir:join(root,'p'+i),
        executablePath:process.env.CX_BROWSER_EXECUTABLE, timeout:25_000, protocolTimeout:18_000, signal:t.signal,
        args:[...diagnosticBrowserArgs,'--load-extension='+ext]});
      browsers.push(browser);
      const worker = await browser.waitForTarget(target => target.type() === 'service_worker'
        && /^chrome-extension:\/\/[a-p]{32}\/extension-worker\.js$/.test(target.url()), {timeout:15_000});
      const page = await browser.newPage(); pages.push(page);
      await page.goto(new URL('popup.html',worker.url()).href, {timeout:12_000});
      await page.evaluate(fields => chrome.storage.local.set(fields), {
        'common.settings.tiku-adapter.baseurl':base, 'common.settings.tiku-adapter.key':'fixture-owned-no-grant',
        [deviceKey]:device,[browserKey]:id,[signalKey]:i+1,'agreement.view.v1':{phase:'accepted'}
      });
      await page.waitForFunction(() => document.getElementById('diagnostics-state').textContent.includes('未提供可信诊断授权'));
      assert.equal(calls,0);
    }
    for (const browser of browsers) await openDiagnosticPage(browser);
    const evidence = await Promise.all(pages.map(p => p.evaluate(async keys => {
      const state = await chrome.runtime.sendMessage({kind:'chaoxing-plus:extension-diagnostics',op:'inspect'});
      return {state, stored:await chrome.storage.local.get(keys)};
    }, [deviceKey,browserKey,signalKey,'extension.diagnostics.outbox.v2'])));
    assert.deepEqual(evidence, ids.map((id,i) => ({state:{state:'host-unavailable'},stored:{[deviceKey]:device,[browserKey]:id,[signalKey]:i+1}})));
    assert.equal(new Set(ids).size,3);
    assert.equal(calls,0,'native profiles without production consent proof cannot send events');
    t.diagnostic('3 live Chrome profiles: device and browser identities unchanged, no unauthorized policy, outbox or upload');
  } finally {
    const closed = await Promise.allSettled(browsers.map(b => b.close()));
    server.closeAllConnections();
    if (server.listening) await new Promise(ok => server.close(ok));
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
});
