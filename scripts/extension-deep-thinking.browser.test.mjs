import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { createTestDirectory } from './test-helpers/temp-directory.mjs';

const keys = ['deepThinkingEnabled', 'hasPromptedDeepThinking', 'cx.new.study.deepThinking'];
const dialog = '#cx-deep-thinking-guide';
const agree = '#cx-plus-agreement';
const hash = value => createHash('sha256').update(value);
const body = '本地引导测试专用协议。\n'.repeat(400);
const deviceId = '7075530c-7398-40eb-b5b1-9f1ce331f762';

const guide = (page, present = true) => page.waitForFunction((selector, visible) => {
  const host = document.querySelector(selector);
  return Boolean(host?.shadowRoot?.querySelector('dialog[open]')) === visible;
}, { timeout: 12000, polling: 60 }, dialog, present);
const click = async (page, selector) => { await page.bringToFront(); await page.click('pierce/' + selector); };

test('ordinary MV3: consent first, explicit choice, trusted isolation and production controls across tabs/reloads', { timeout: 90000 }, async t => {
  const dir = createTestDirectory('deep-thinking-chrome');
  const path = join(dir, 'extension');
  const oldDist = process.env.CX_DEEP_THINKING_OLD_DIST;
  const candidate = resolve(process.env.CX_DEEP_THINKING_DIST || 'dist');
  cpSync(oldDist ? resolve(oldDist) : candidate, path, { recursive: true });
  if (oldDist) {
    const manifestPath = join(path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '0.0.0.1' }));
  }
  const keyPath = join(dir, 'key.pem'), certPath = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:guide.chaoxing.com,DNS:outside.test',
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  const spki = hash(execFileSync('openssl', ['pkey', '-pubin', '-outform', 'DER'], {
    input: execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-pubkey'])
  })).digest('base64');
  let consents = 0, searchCalls = 0;
  const service = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Agreement-Device, X-Device-Id, X-Device-Instance, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const pathname = new URL(req.url, 'https://localhost').pathname;
    const data = { version: 'v1', deviceId, content_hash: hash(body).digest('hex'), needsAcceptance: consents === 0 };
    const reply = (value, code = 200) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (pathname === '/api/agreements/devices') return reply({ deviceId, deviceCredential: 'agd_' + 'j'.repeat(43) }, 201);
    if (pathname === '/api/agreements/status') return reply(data);
    if (pathname === '/api/agreements/current') return reply({ ...data, type: 'user_agreement', body, summary: '离线夹具', publishedAt: '2026-11-01T00:00:00Z' });
    if (pathname === '/api/agreements/consents' && req.method === 'POST') {
      consents++;
      return reply({ accepted: true, version: 'v1', deviceId, acceptedAt: '2026-11-01T00:00:00Z' });
    }
    if (pathname.startsWith('/api/search')) { searchCalls++; return reply({}, 418); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><title>Owned passive guide fixture</title><main>Owned fixture</main>' +
      (pathname === '/' ? '<iframe src="/idle" title="owned child"></iframe>' : ''));
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const port = service.address().port;
  const patchBase = (extension = path) => writeFileSync(join(extension, 'extension-agreement-config.js'), 'export const defaultBase = ' + JSON.stringify('https://localhost:' + port));
  patchBase();
  let browser;
  t.after(async () => {
    await browser?.close();
    service.closeAllConnections();
    await new Promise(resolve => service.close(resolve));
  });
  const launch = () => puppeteer.launch({ userDataDir: join(dir, 'profile'), headless: true,
    executablePath: process.env.CX_BROWSER_EXECUTABLE, enableExtensions: oldDist ? true : [path],
    ignoreDefaultArgs: oldDist ? ['--disable-extensions'] : undefined,
    args: [...(oldDist ? ['--load-extension=' + path] : []),
      '--no-sandbox', '--disable-background-networking', '--no-proxy-server',
      '--ignore-certificate-errors-spki-list=' + spki,
      '--host-resolver-rules=MAP guide.chaoxing.com 127.0.0.1, MAP outside.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost']
  });
  browser = await launch();
  const internal = await (await browser.waitForTarget(target => target.type() === 'page'
    && target.url().endsWith('/extension-agreement.html'))).page();
  const internalUrl = internal.url();
  assert.equal(await internal.$(dialog), null, 'no guide on the extension agreement page');
  const url = 'https://guide.chaoxing.com:' + port + '/';
  let first = await browser.newPage();
  const errors = [];
  const observe = page => page.on('pageerror', error => errors.push(error.message));
  observe(first);
  await first.goto(url);
  await first.waitForFunction(selector => !document.querySelector(selector)?.shadowRoot.querySelector('.accept').hidden
    && Boolean(document.querySelector(selector)?.shadowRoot.querySelector('.body').textContent), { timeout: 12000 }, agree)
    .catch(async error => {
      console.error('agreement fixture', await first.evaluate(selector => document.querySelector(selector)?.shadowRoot.querySelector('.status').textContent, agree));
      throw error;
    });
  assert.equal(await first.$(dialog), null, 'guide may not cover unsigned agreement');
  await first.evaluate(selector => {
    const el = document.querySelector(selector).shadowRoot.querySelector('.body');
    el.scrollTop = el.scrollHeight;
  }, agree);
  await first.waitForFunction(selector => document.querySelector(selector)?.shadowRoot.querySelector('.accept').disabled === false, {}, agree);
  await click(first, '.accept');
  await first.waitForFunction(selector => document.querySelector(selector)?.hidden === true, {}, agree);
  assert.equal(consents, 1);
  t.diagnostic('T02 fixture: agreement accepted');
  let settings = await browser.newPage();
  await settings.goto(new URL('popup.html', internalUrl).href);
  const read = () => settings.evaluate(keys => chrome.storage.local.get(keys), keys);
  const set = data => settings.evaluate(data => chrome.storage.local.set(data), data);
  const clear = () => settings.evaluate(keys => chrome.storage.local.remove(keys), [...keys, 'common.settings.work-options']);
  const settingsTab = page => page.click('[data-cx-panel-tab="study"]');
  const checked = (page, value) => page.waitForFunction(value => {
    const toggle = document.querySelector('[data-cx-deep-thinking-toggle]');
    return toggle?.getAttribute('aria-pressed') === String(value)
      && toggle.textContent.includes(value ? '已开启' : '已关闭');
  }, { timeout: 12000, polling: 60 }, value);
  const assertState = async value => assert.deepEqual(await read(), {
    [keys[0]]: value, [keys[1]]: true, [keys[2]]: value
  });
  const trustedUrl = new URL('popup.html#deep-thinking', internalUrl).href;
  async function openSettings(page, fromGuide = true) {
    const opening = browser.waitForTarget(target => target.type() === 'page' && target.url() === trustedUrl, { timeout: 12000 });
    if (fromGuide) await click(page, 'button.configure');
    else {
      await page.bringToFront();
      await page.click('[data-cx-deep-thinking-toggle]');
    }
    const confirmation = await (await opening).page();
    observe(confirmation);
    await confirmation.waitForSelector('#deep-thinking-settings', { visible: true });
    const surface = await confirmation.evaluate(() => ({
      protocol: location.protocol,
      topLevel: window === window.top,
      noOpener: window.opener === null,
      costNotice: document.getElementById('deep-thinking-description').textContent.includes('费用也可能更高'),
      notExposed: !chrome.runtime.getManifest().web_accessible_resources
        .some(item => item.resources.includes('popup.html') || item.resources.includes('*'))
    }));
    assert.deepEqual(surface, { protocol: 'chrome-extension:', topLevel: true, noOpener: true, costNotice: true, notExposed: true });
    return confirmation;
  }
  async function confirm(confirmation, value) {
    const button = value ? '#deep-thinking-enable' : '#deep-thinking-disable';
    await confirmation.bringToFront();
    await confirmation.waitForSelector(button + ':enabled', { timeout: 12000 });
    await confirmation.click(button);
    await confirmation.waitForFunction(() => document.getElementById('deep-thinking-notice').textContent.includes('已同步共享设置'),
      { timeout: 12000, polling: 60 });
    await confirmation.close();
  }

  if (oldDist) {
    assert.deepEqual(await read(), {});
    await set({ [keys[2]]: false }); // Presence of old false is not informed choice.
    const management = await browser.newPage();
    await management.goto('chrome://extensions', { waitUntil: 'domcontentloaded' });
    await management.waitForSelector('pierce/#devMode', { timeout: 12000 });
    const developerMode = await management.$('pierce/#devMode');
    if (!await developerMode.evaluate(el => el.checked)) await developerMode.click();
    await management.waitForFunction(() => document.querySelector('extensions-manager').shadowRoot
      .querySelector('extensions-toolbar').shadowRoot.querySelector('#devMode').checked, { timeout: 12000 });
    await management.close();

    const id = new URL(internalUrl).hostname;
    const cdp = await browser.target().createCDPSession();
    const registered = async () => (await cdp.send('Extensions.getExtensions')).extensions
      .filter(item => item.path === path).map(({ id, version, enabled }) => ({ id, version, enabled }));
    assert.deepEqual(await registered(), [{ id, version: '0.0.0.1', enabled: true }]);
    await first.close();
    await internal.close();
    const candidateStage = join(dir, 'candidate');
    cpSync(candidate, candidateStage, { recursive: true });
    patchBase(candidateStage);
    renameSync(path, join(dir, 'old-extension'));
    renameSync(candidateStage, path);
    await settings.evaluate(() => { chrome.runtime.reload(); }); // Real MV3 update; do not just restart the profile.
    const upgraded = await browser.waitForTarget(target => target.type() === 'page' && target.url() === internalUrl, { timeout: 16000 });
    assert.deepEqual(await registered(), [{ id, version: '6.3.0', enabled: true }]);
    const upgradedPage = await upgraded.page();
    assert.equal(await upgradedPage.evaluate(async () => (await chrome.storage.local.get('agreement.install.v1'))['agreement.install.v1']), 'incomplete');
    await upgradedPage.close();
    settings = await browser.newPage();
    await settings.goto(new URL('popup.html', internalUrl).href);
    assert.equal(await settings.evaluate(() => chrome.runtime.id), id);
    t.diagnostic('T02 fixture: real upgrade, same profile/extension ID, automatic T04 page, legacy setting retained');
    first = await browser.newPage();
    observe(first);
    await first.goto(url);
  }
  await guide(first); // Expected baseline RED: no such dialog at #30.
  t.diagnostic('T02 fixture: guide opened');
  assert.deepEqual(await read(), oldDist ? { [keys[2]]: false } : {});
  assert.equal(await first.frames()[1].$(dialog), null, 'never mounts in a child frame');
  await first.waitForSelector('#panel-common-work-results');
  await checked(first, false);
  t.diagnostic('T02 fixture: panel reads off');
  assert.equal(await first.evaluate(selector => document.querySelector(selector).shadowRoot.activeElement?.className, dialog), 'close');
  assert.deepEqual(await first.evaluate(selector => {
    const shadow = document.querySelector(selector).shadowRoot;
    return Array.from(shadow.querySelectorAll('button'), node => node.textContent.trim());
  }, dialog), ['×', '打开扩展设置'], 'the owned web fixture only presents navigation, never choice controls');
  await first.evaluate(selector => document.querySelector(selector).shadowRoot.querySelector('.configure').click(), dialog);
  assert.deepEqual(await read(), oldDist ? { [keys[2]]: false } : {}, 'page-only navigation does not save');
  await first.bringToFront();
  await first.mouse.click(5, 5);
  assert.deepEqual(await read(), oldDist ? { [keys[2]]: false } : {}, 'backdrop interaction writes nothing');
  await guide(first);
  await first.keyboard.press('Escape');
  t.diagnostic('T02 fixture: escape');
  await guide(first, false);
  await first.reload(); await guide(first);
  await click(first, 'button.close');
  t.diagnostic('T02 fixture: close button');
  await guide(first, false);
  await first.reload(); await guide(first);
  const second = await browser.newPage(); observe(second); await second.goto(url);
  await guide(second);
  const ignored = await openSettings(first);
  assert.deepEqual(await read(), oldDist ? { [keys[2]]: false } : {}, 'opening the trusted page alone changes nothing');
  await ignored.close();
  await guide(first); await guide(second);
  await confirm(await openSettings(first), false);
  t.diagnostic('T02 fixture: trusted extension page decline');
  await Promise.all([guide(first, false), guide(second, false), checked(first, false), checked(second, false)])
    .catch(async error => {
      console.error('persisted choice', await read(), 'dialog message', await first.evaluate(selector =>
        document.querySelector(selector)?.shadowRoot.querySelector('.notice')?.textContent, dialog));
      throw error;
    });
  await assertState(false);
  t.diagnostic('T02 fixture: durable off');
  await first.reload();
  await first.waitForSelector('#panel-common-work-results');
  await guide(first, false);
  await checked(first, false);

  await clear(); // Simulates a fresh window/profile preference, without bypassing the agreement.
  await first.reload(); await second.reload();
  await guide(first); await guide(second);
  await confirm(await openSettings(second), true);
  t.diagnostic('T02 fixture: trusted extension page opt-in');
  await Promise.all([guide(first, false), guide(second, false), checked(first, true), checked(second, true)]);
  await assertState(true);
  t.diagnostic('T02 fixture: durable on');
  await first.evaluate(selector => {
    localStorage.setItem('cx.new.study.deepThinking', 'false');
    document.documentElement.setAttribute('data-chaoxing-plus-shared-cx-new-study-deepThinking', 'false');
    document.dispatchEvent(new CustomEvent('chaoxing-plus:shared-store-sync', { detail: {
      'cx.new.study.deepThinking': false, 'common.settings.work-options': { deepThinking: true },
      deepThinkingEnabled: false, hasPromptedDeepThinking: false
    }}));
    if (document.querySelector(selector)?.shadowRoot.querySelector('dialog[open]')) throw Error('unexpected guide');
  }, dialog);
  await assertState(true);
  assert.equal(await settings.evaluate(async () => (await chrome.storage.local.get('common.settings.work-options'))['common.settings.work-options']), undefined);
  await first.bringToFront();
  await first.reload({ waitUntil: 'domcontentloaded', timeout: 12000 });
  await checked(first, true);
  t.diagnostic('T02 fixture: reloaded true');
  assert.equal(await first.evaluate(() => localStorage.getItem('cx.new.study.deepThinking')), null, 'no page-readable mirror');
  t.diagnostic('T02 fixture: recorded exclusive storage');
  await settingsTab(first);
  t.diagnostic('T02 fixture: panel settings');
  const manualOff = await openSettings(first, false);
  await assertState(true); // navigating from the production control does not write
  await confirm(manualOff, false);
  await Promise.all([checked(first, false), checked(second, false)]);
  await assertState(false);
  const manualOn = await openSettings(first, false);
  await manualOn.waitForSelector('#deep-thinking-enable:enabled', { timeout: 12000 });
  await manualOn.evaluate(() => document.getElementById('deep-thinking-enable').click());
  await assertState(false);
  await manualOn.close(); // Cancel manual enable; no write.
  await guide(first, false);
  await assertState(false);
  await confirm(await openSettings(first, false), true);
  await Promise.all([guide(first, false), checked(first, true), checked(second, true)]);
  await assertState(true);
  t.diagnostic('T02 fixture: manual switch synced both directions');

  await clear();
  await set({ [keys[2]]: true, 'common.settings.work-options': { deepThinking: false } });
  await first.reload(); await checked(first, true); await guide(first);
  assert.deepEqual(await read(), { [keys[2]]: true }, 'legacy true preserved but not inferred to be an explicit recorded choice');
  await first.close();
  await set({ [keys[0]]: 'false', [keys[1]]: true, [keys[2]]: 'true', 'common.settings.work-options': { deepThinking: 'true' } });
  await second.reload(); await guide(second); await checked(second, false);
  const outside = await browser.newPage();
  await outside.goto('https://outside.test:' + port + '/');
  assert.equal(await outside.$(dialog), null);
  assert.deepEqual(errors, []);
  assert.equal(searchCalls, 0, 'a preference alone may not call a model, search API, or change billable behavior');
  assert.equal(consents, 1, 'guide never signs or resubmits the agreement');
});
