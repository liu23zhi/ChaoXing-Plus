import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createServer } from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestDirectory } from './test-helpers/temp-directory.mjs';
import { diagnosticBrowserArgs, openDiagnosticPage } from './test-helpers/local-diagnostic-page.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const puppeteer = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES || '.', 'package.json'))('puppeteer');
const outboxKey = 'extension.diagnostics.outbox.v2';
const device = 'owned-ordinary-profile', agreementDevice = '7075530c-7398-40eb-b5b1-9f1ce331f762';
const token = 'owned-fixture-access', proof = 'agd_' + 'a'.repeat(43);
const body = '由本机测试夹具提供的正文，不是正式政策。\n'.repeat(250);
const hash = createHash('sha256').update(body).digest('hex');
async function status(page, text) {
  try {
    // The install/reader tab may be foreground; don't wait on that tab's rAF.
    await eventually(async () => (await page.evaluate(() =>
      document.getElementById('diagnostics-state')?.textContent))?.includes(text), 'diagnostic status was not observed');
  } catch (error) {
    const state = await page.evaluate(async () => {
      const values = await chrome.storage.local.get(null);
      return {status: document.getElementById('diagnostics-state')?.textContent,
        phase: values['agreement.view.v1']?.phase,
        bound: Object.keys(values).some(k => k.startsWith('agreement.key-base.')),
        enrolled: Object.keys(values).some(k => k.startsWith('agreement.device.'))};
    }).catch(() => null);
    throw new Error('Expected owned popup state ' + text + '; observed ' + JSON.stringify(state), {cause:error});
  }
}

async function eventually(check, title) {
  for (let n = 0; n < 160; n++) { if (await check()) return; await sleep(75); }
  assert.fail(title);
}
async function tlsFixture(root) {
  const certPath = join(root, 'tls.crt'), keyPath = join(root, 'tls.key');
  const windowsGit = join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe');
  const openssl = process.platform === 'win32' && existsSync(windowsGit) ? windowsGit : 'openssl';
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=owned-diagnostic-loopback', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath],
  {stdio: 'ignore', windowsHide: true});
  const cert = await readFile(certPath), key = await readFile(keyPath), spki = new X509Certificate(cert).publicKey.export({format:'der', type:'spki'});
  return {cert, key, sha: createHash('sha256').update(spki).digest('base64')};
}

test('packaged ordinary browser: authenticated consent, exact durable receipt, same worker launch, cold retry and opt-out', {timeout: 115_000}, async t => {
  let stage = 'initialize';
  t.after(() => t.diagnostic('last owned diagnostic flow stage: ' + stage));
  const root = createTestDirectory('extension-diagnostic-receipt');
  const ext = join(root, 'extension'), profile = join(root, 'profile');
  await cp(resolve('dist'), ext, {recursive: true});
  const tls = await tlsFixture(root);
  const packets = [], durable = new Map(), deniedPolicies = [], errors = [];
  let adminEnabled = true, consent = false, lost = false, policies = 0, forbiddenCalls = 0, hold = false;
  const routeCounts = new Map();
  const server = createServer({cert: tls.cert, key: tls.key}, async (req, res) => {
    const reply = (contents, code = 200) =>
      res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(JSON.stringify(contents));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Agreement-Device');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const at = new URL(req.url, 'https://127.0.0.1');
    const knownRoute = at.pathname.startsWith('/api/agreements/') ? 'agreement' : at.pathname.startsWith('/api/extension-logs/') ? 'diagnostics' : 'other';
    routeCounts.set(knownRoute, (routeCounts.get(knownRoute) ?? 0) + 1);
    const data = async () => {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw new Error('oversized owned request'); }
      return JSON.parse(raw);
    };
    try {
      if (at.pathname === '/api/agreements/devices' && req.method === 'POST') {
        return reply({deviceId: agreementDevice, deviceCredential: proof}, 201);
      }
      if (!['/api/agreements/status','/api/agreements/current','/api/agreements/consents',
        '/api/extension-logs/receipt-policy','/api/extension-logs/batches'].includes(at.pathname)) {
        if (at.pathname.startsWith('/api/extension-logs')) forbiddenCalls++;
        return reply({}, 404);
      }
      if (req.headers['x-agreement-device'] !== proof) return reply({}, 401);
      const authorized = req.headers.authorization === 'Bearer ' + token;
      const view = {deviceId: agreementDevice, version: 'v1.0', content_hash: hash, needsAcceptance: !consent};
      if (at.pathname === '/api/agreements/status') return reply(view);
      if (at.pathname === '/api/agreements/current') {
        assert.equal(at.searchParams.get('version'), 'v1.0');
        return reply({...view, summary: '本地协议', type:'user_agreement', body, publishedAt:'2026-11-28T05:00:00.000Z'});
      }
      if (at.pathname === '/api/agreements/consents') {
        assert.ok(authorized, 'consent reached using authorized fixture identity');
        assert.deepEqual(await data(), {version:'v1.0'});
        consent = true;
        return reply({deviceId:agreementDevice, accepted:true, version:'v1.0', acceptedAt:'2026-11-28T06:00:00.000Z'});
      }
      assert.ok(authorized, 'diagnostic endpoint requires the fixture bearer');
      if (at.pathname === '/api/extension-logs/receipt-policy') {
        assert.equal(req.method,'GET');
        assert.equal(at.searchParams.get('mode'),'extension');
        policies++;
        if (!consent || !adminEnabled) deniedPolicies.push(!consent ? 'consent' : 'admin');
        return reply({enabled: consent && adminEnabled, transport: 'receipt-v1'});
      }
      assert.equal(req.method,'POST');
      if (!consent || !adminEnabled) { forbiddenCalls++; return reply({},403); }
      const packet = await data();
      const {batch_id, entries, ...scope} = packet;
      assert.deepEqual(Object.keys(scope).sort(), ['device_id','launch_id','mode','version']);
      assert.equal(scope.device_id, device);
      assert.equal(scope.mode, 'extension');
      assert.match(scope.launch_id, /^[a-f0-9-]{36}$/);
      for (const e of entries) assert.deepEqual(Object.keys(e).sort(), ['event','event_id','event_seq','level','time']);
      packets.push(packet);
      if (hold) return reply({},503);
      const previous = durable.get(batch_id);
      if (previous) assert.deepEqual(packet, previous);
      else durable.set(batch_id, packet);
      if (!lost) { lost = true; res.destroy(); return; }
      return reply({scope, batch_id, accepted_event_ids: entries.map(e => e.event_id)}, previous ? 200 : 201);
    } catch (error) { errors.push(error); if (!res.headersSent) reply({},400); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(ok => server.close(ok));
  });

  const base = 'https://127.0.0.1:' + server.address().port;
  // Only the destination in the owned scratch package is replaced. The tested
  // worker, transport, UI, outbox and manifest are the actual build outputs.
  await writeFile(join(ext, 'extension-agreement-config.js'), 'export const defaultBase = ' + JSON.stringify(base) + ';\n');
  async function launch() {
    browser = await puppeteer.launch({headless:true, pipe:true, userDataDir:profile, enableExtensions: true,
      executablePath: process.env.CX_BROWSER_EXECUTABLE, timeout: 25_000, protocolTimeout: 18_000,
      args: [...diagnosticBrowserArgs, '--load-extension=' + ext, '--ignore-certificate-errors-spki-list=' + tls.sha]});
    return browser.waitForTarget(target => target.type() === 'service_worker'
      && /^chrome-extension:\/\/[a-p]{32}\/extension-worker\.js$/.test(target.url()), {timeout: 15_000});
  }
  stage = 'start browser';
  let target = await launch();
  const internal = path => new URL(path, target.url()).href;
  let popup = await browser.newPage(); await popup.goto(internal('popup.html'));
  await popup.evaluate(({device, token}) => chrome.storage.local.set({
    'common.settings.device-id': device, 'common.settings.tiku-adapter.key': token
  }), {device, token});
  await status(popup, '尚未授权回传').catch(error => { t.diagnostic('owned route counts: ' + JSON.stringify([...routeCounts])); throw error; });
  // Forged display state cannot replace the still-pending server record.
  await popup.evaluate(() => chrome.storage.local.set({'agreement.view.v1': {phase:'accepted'}}));
  const beforeDenied = deniedPolicies.length;
  const preConsent = await openDiagnosticPage(browser);
  await eventually(() => deniedPolicies.length > beforeDenied && deniedPolicies.includes('consent'),
    'lookup before consent not observed');
  assert.equal(await popup.evaluate(k => chrome.storage.local.get(k).then(v => Object.hasOwn(v,k)), outboxKey), false);
  assert.deepEqual([packets.length,durable.size,forbiddenCalls], [0,0,0]);
  await preConsent.close();

  stage = 'manual consent';
  const reader = await browser.newPage(); await reader.goto(internal('extension-agreement.html'));
  await reader.bringToFront();
  await reader.waitForFunction(() => {
    const p = document.querySelector('#cx-plus-agreement')?.shadowRoot;
    return p?.querySelector('.status').textContent.includes('完整阅读并同意');
  }, {polling: 80, timeout: 12000});
  await reader.evaluate(() => {
    const body = document.querySelector('#cx-plus-agreement').shadowRoot.querySelector('.body');
    body.scrollTop = body.scrollHeight;
  });
  await reader.waitForFunction(() => document.querySelector('#cx-plus-agreement')?.shadowRoot.querySelector('.accept').disabled === false,
    {polling: 80, timeout: 12000});
  await reader.click('pierce/.accept');
  await eventually(() => consent, 'manual consent never reached the owned fixture');
  await status(popup, '已启用');
  assert.deepEqual([packets.length,durable.size], [0,0], 'popup and consent establish policy only, not a batch');

  stage = 'first delivery with lost receipt';
  const page = await openDiagnosticPage(browser);
  await eventually(() => packets.length >= 2, 'no actual retry after loss of response');
  assert.deepEqual(packets[1], packets[0]);
  assert.equal(durable.size,1);
  const initial = packets[0];
  assert.equal(initial.entries[0].event,'extension.ready');
  assert.match(initial.entries[0].time, /\.\d{3}Z$/);
  const pendingCount = p => p.evaluate(k => chrome.storage.local.get(k)
    .then(v => (v[k]?.streams ?? []).reduce((n,s) => n+s.snapshot.entries.length,0)), outboxKey);
  await eventually(async () => await pendingCount(popup) === 0, 'matching acknowledgement did not clear queue');

  stage = 'worker reload and same launch';
  const worker = await target.worker(); await worker.close();
  await page.reload();
  await eventually(() => durable.size === 2, 'worker resume did not send a new event');
  assert.equal([...durable.values()][1].launch_id, initial.launch_id);
  await openDiagnosticPage(browser);
  await eventually(() => durable.size === 3, 'another tab did not report');
  assert.equal([...durable.values()][2].launch_id, initial.launch_id);

  stage = 'durable restart';
  hold = true;
  const attempts = packets.length;
  await page.reload();
  await eventually(() => packets.length > attempts, 'owned offline packet did not reach transient fixture');
  const parked = packets[attempts];
  assert.equal(parked.launch_id, initial.launch_id);
  await browser.close();
  hold = false;
  target = await launch();
  popup = await browser.newPage(); await popup.goto(internal('popup.html'));
  await eventually(() => durable.size === 4, 'browser restart lost old bound packet');
  assert.deepEqual([...durable.values()][3], parked);
  await openDiagnosticPage(browser);
  await eventually(() => durable.size === 5, 'new browser launch did not report');
  assert.notEqual([...durable.values()][4].launch_id, initial.launch_id);
  assert.equal([...durable.values()][4].device_id, initial.device_id);

  stage = 'admin default-off and personal withdrawal';
  adminEnabled = false;
  await popup.reload(); await status(popup, '管理员已关闭');
  assert.ok(deniedPolicies.includes('admin'));
  assert.equal(durable.size,5);
  adminEnabled = true;
  await popup.bringToFront();
  await popup.click('#diagnostics-enabled');
  await status(popup, '已关闭诊断回传');
  await openDiagnosticPage(browser);
  assert.deepEqual([durable.size, forbiddenCalls], [5,0]);
  assert.ok(policies > 0);
  if (errors.length) throw errors[0];
  stage = 'all owned ordinary diagnostic checks passed';
});
