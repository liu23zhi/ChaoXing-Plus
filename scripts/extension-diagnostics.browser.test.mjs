import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES || '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');

test('packaged popup opts in and its real worker sends only fixed diagnostic fields to the configured service', {timeout:60000}, async t => {
  const receipts = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const body = [];
    for await (const chunk of req) body.push(chunk);
    receipts.push({ path:req.url, auth:req.headers.authorization, body:JSON.parse(Buffer.concat(body).toString()) });
    res.writeHead(204).end();
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CX_BROWSER_EXECUTABLE, enableExtensions:[resolve('dist')] });
  t.after(() => browser.close());
  const worker = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('/extension-worker.js'));
  const page = await browser.newPage();
  await page.goto(new URL('popup.html', worker.url()).href);
  await page.evaluate(async base => {
    await chrome.storage.local.set({ 'common.settings.tiku-adapter.baseurl':base, 'common.settings.tiku-adapter.key':'local-fixture-only' });
  }, 'http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => !document.querySelector('#diagnostics-enabled').disabled);
  assert.equal(await page.$eval('#diagnostics-enabled', e => e.checked), false);
  assert.deepEqual(receipts, []);
  await page.click('#diagnostics-enabled');
  await page.waitForFunction(() => document.querySelector('#diagnostics-state').textContent.startsWith('已开启'));
  await page.evaluate(() => chrome.storage.local.set({ 'common.settings.diagnostic-test-signal':'must never be transmitted' }));
  await new Promise((resolve,reject) => {
    let tries = 0; const id = setInterval(() => {
      if (receipts.length) { clearInterval(id); resolve(); }
      else if (++tries >= 70) { clearInterval(id); reject(Error('No diagnostic receipt from packaged worker')); }
    },100);
  });
  assert.equal(receipts[0].path, '/api/extension-logs');
  assert.equal(receipts[0].auth,'Bearer local-fixture-only');
  assert.match(receipts[0].body.version, /^\d+(?:\.\d+)+$/);
  const entries = receipts[0].body.entries;
  assert.equal(entries.length, 1); assert.equal(entries[0].event,'settings.saved');
  assert.deepEqual(Object.keys(entries[0]).sort(), ['event','level','time']);
  await page.evaluate(() => chrome.storage.local.set({ 'common.settings.tiku-adapter.key':'other-local-fixture' }));
  await page.waitForFunction(() => !document.querySelector('#diagnostics-enabled').checked);
});
