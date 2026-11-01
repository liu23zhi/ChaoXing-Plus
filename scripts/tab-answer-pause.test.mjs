import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from '@typescript/typescript6';
import { resolveTestPath } from './test-helpers/temp-directory.mjs';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
let browser;
let server;
let fixtureDirectory;
let base;
let otherOrigin;
let pauseSource;

before(async () => {
  pauseSource = ts.transpileModule(await readFile('src/projects/tab-answer-pause.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
  }).outputText.replace(/^export /gm, '');
  fixtureDirectory = await mkdtemp(resolveTestPath('.tmp-tests-tab-answer-pause-'));
  const manifest = {
    manifest_version: 3, name: 'Local tab pause fixture', version: '1.0.0', permissions: ['storage'],
    background: { service_worker: 'extension-tab-pause.js' },
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
    content_scripts: [{ matches: ['http://127.0.0.1/*', 'http://localhost/*'], js: ['extension-entry.js'],
      all_frames: true, run_at: 'document_start' }],
    web_accessible_resources: [{ matches: ['<all_urls>'], resources: ['chaoxing-plus.js'] }]
  };
  await writeFile(resolve(fixtureDirectory, 'manifest.json'), JSON.stringify(manifest));
  await copyFile('src/extension-entry.js', resolve(fixtureDirectory, 'extension-entry.js'));
  await copyFile('src/extension-tab-pause.js', resolve(fixtureDirectory, 'extension-tab-pause.js'));
  await writeFile(resolve(fixtureDirectory, 'chaoxing-plus.js'), `${pauseSource}\nwindow.pauseController = getTabAnswerPauseController();\nwindow.initialTabPaused = window.pauseController.isPaused();`);
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><title>Local tab pause fixture</title></head><body><h1>Local tab fixture</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  otherOrigin = `http://localhost:${server.address().port}`;
  browser = await puppeteer.launch({
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    headless: true, pipe: true, enableExtensions: [fixtureDirectory],
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--disable-background-networking']
  });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

async function openPage(t, url = base) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(url);
  await page.waitForFunction(() => !!window.pauseController);
  return page;
}

async function setPaused(page, value) {
  await page.evaluate((paused) => window.pauseController.setPaused(paused), value);
  await page.waitForFunction((paused) => window.pauseController.isPaused() === paused
    && document.documentElement.getAttribute('data-chaoxing-plus-tab-pause-pending') !== 'true', {}, value);
}

test('extension pause survives reload, replace and a different origin in the same tab', async (t) => {
  const page = await openPage(t);
  assert.equal(await page.evaluate(() => window.initialTabPaused), false);
  await setPaused(page, true);
  await page.reload();
  await page.waitForFunction(() => !!window.pauseController);
  assert.equal(await page.evaluate(() => window.initialTabPaused), true);
  await Promise.all([
    page.waitForNavigation(),
    page.evaluate((url) => location.replace(url), `${base}/next-chapter`)
  ]);
  await page.waitForFunction(() => !!window.pauseController);
  assert.equal(await page.evaluate(() => window.initialTabPaused), true);
  await page.goto(`${otherOrigin}/different-origin`);
  await page.waitForFunction(() => !!window.pauseController);
  assert.equal(await page.evaluate(() => window.initialTabPaused), true);
  await setPaused(page, false);
  await page.goto(`${base}/continued`);
  await page.waitForFunction(() => !!window.pauseController);
  assert.equal(await page.evaluate(() => window.initialTabPaused), false);
});

test('new tabs and window.open do not inherit another tab pause or its copied sessionStorage', async (t) => {
  const first = await openPage(t);
  await setPaused(first, true);
  await first.evaluate(() => sessionStorage.setItem('fixture-paused', 'true'));
  const newTab = await openPage(t);
  assert.equal(await newTab.evaluate(() => window.initialTabPaused), false);
  const opened = new Promise((resolve) => first.once('popup', resolve));
  await first.evaluate((url) => window.open(url, '_blank'), `${base}/opened-tab`);
  const child = await opened;
  t.after(() => child.close());
  await child.waitForFunction(() => !!window.pauseController);
  assert.equal(await child.evaluate(() => sessionStorage.getItem('fixture-paused')), 'true');
  assert.equal(await child.evaluate(() => window.initialTabPaused), false);
  await setPaused(child, true);
  await setPaused(first, false);
  assert.equal(await child.evaluate(() => window.pauseController.isPaused()), true);
});

test('same-tab cross-origin iframe receives pause and continue broadcasts', async (t) => {
  const page = await openPage(t);
  await page.evaluate((url) => {
    const frame = document.createElement('iframe');
    frame.src = url;
    document.body.appendChild(frame);
  }, `${otherOrigin}/task-frame`);
  const frame = await (await page.waitForSelector('iframe')).contentFrame();
  await frame.waitForFunction(() => !!window.pauseController);
  await setPaused(page, true);
  await frame.waitForFunction(() => window.pauseController.isPaused());
  await frame.evaluate(() => window.pauseController.setPaused(false));
  await page.waitForFunction(() => !window.pauseController.isPaused());
  assert.equal(await frame.evaluate(() => window.pauseController.isPaused()), false);
});

test('background restart keeps the same tab pause through session storage', async (t) => {
  const page = await openPage(t);
  await setPaused(page, true);
  const devtools = await page.createCDPSession();
  await devtools.send('ServiceWorker.enable');
  await devtools.send('ServiceWorker.stopAllWorkers');
  await devtools.detach();
  await page.goto(`${otherOrigin}/after-worker-restart`);
  await page.waitForFunction(() => !!window.pauseController);
  assert.equal(await page.evaluate(() => window.initialTabPaused), true);
});

test('rapid pause changes cannot be overwritten by an older acknowledgement', async (t) => {
  const page = await openPage(t);
  await page.evaluate(() => {
    window.pauseController.setPaused(true);
    window.pauseController.setPaused(false);
    window.pauseController.setPaused(true);
  });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-chaoxing-plus-tab-pause-pending') !== 'true');
  assert.equal(await page.evaluate(() => window.pauseController.isPaused()), true);
  await page.reload();
  await page.waitForFunction(() => !!window.pauseController);
  assert.equal(await page.evaluate(() => window.initialTabPaused), true);
});

test('non-extension memory pause writes no storage and blocks automatic reload while paused', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.evaluate(() => {
    for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(window, key, {
      get() { throw new Error('Storage must not be accessed'); }
    });
  });
  await page.addScriptTag({ content: `${pauseSource}\nwindow.pauseController = getTabAnswerPauseController();` });
  assert.equal(await page.evaluate(() => window.pauseController.canReload()), true);
  await page.evaluate(() => window.pauseController.setPaused(true));
  assert.equal(await page.evaluate(() => window.pauseController.canReload()), false);
  await page.evaluate(() => history.replaceState(null, '', '#next-task'));
  assert.equal(await page.evaluate(() => window.pauseController.isPaused()), true);
  await page.evaluate(() => window.pauseController.setPaused(false));
  assert.equal(await page.evaluate(() => window.pauseController.canReload()), true);
});

test('background accepts only typed messages from extension content tabs and removes closed tab state', async () => {
  let listener;
  let onRemoved;
  const stored = {};
  const sent = [];
  const chrome = {
    runtime: { id: 'fixture-id', onMessage: { addListener(fn) { listener = fn; } } },
    storage: { session: {
      get(key, callback) { callback({ [key]: stored[key] }); },
      set(value, callback) { Object.assign(stored, value); callback(); },
      remove(key, callback) { delete stored[key]; callback(); }
    } },
    tabs: { onRemoved: { addListener(fn) { onRemoved = fn; } }, sendMessage(id, message, callback) { sent.push({ id, message }); callback(); } }
  };
  vm.runInNewContext(await readFile('src/extension-tab-pause.js', 'utf8'), { chrome });
  const msg = { kind: 'chaoxing-plus:tab-answer-pause', operation: 'write', paused: true, requestId: 'a' };
  assert.equal(listener(msg, { id: 'other', tab: { id: 4 } }, () => {}), false);
  assert.equal(listener(msg, { id: 'fixture-id' }, () => {}), false);
  assert.equal(listener({ ...msg, paused: 'true' }, { id: 'fixture-id', tab: { id: 4 } }, () => {}), false);
  const write = (message, tabId = 4) => new Promise((resolve) => listener(message, { id: 'fixture-id', tab: { id: tabId } }, resolve));
  assert.equal((await write(msg)).paused, true);
  assert.equal((await write({ ...msg, operation: 'read', requestId: 'b' }, 5)).paused, false);
  assert.deepEqual(sent.map((item) => item.id), [4]);
  assert.equal(stored['answer-pause.tab:4'], true);
  onRemoved(4);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stored['answer-pause.tab:4'], undefined);
});

async function failingBackground({ readError = false, writeError = false } = {}) {
  let listener;
  const runtime = { id: 'fixture-id', lastError: undefined, onMessage: { addListener(fn) { listener = fn; } } };
  const chrome = {
    runtime,
    storage: { session: {
      get(_key, callback) {
        if (readError === 'throw') throw new Error('session read unavailable');
        runtime.lastError = readError ? { message: 'session read unavailable' } : undefined;
        callback({});
        runtime.lastError = undefined;
      },
      set(_value, callback) {
        if (writeError === 'throw') throw new Error('session write unavailable');
        runtime.lastError = writeError ? { message: 'session write unavailable' } : undefined;
        callback();
        runtime.lastError = undefined;
      },
      remove(_key, callback) { callback(); }
    } },
    tabs: { onRemoved: { addListener() {} }, sendMessage(_id, _message, callback) { callback(); } }
  };
  vm.runInNewContext(await readFile('src/extension-tab-pause.js', 'utf8'), { chrome });
  return (operation, paused) => new Promise((resolve) => listener({
    kind: 'chaoxing-plus:tab-answer-pause', operation, paused, requestId: `${operation}:${Math.random()}`
  }, { id: 'fixture-id', tab: { id: 8 } }, resolve));
}

test('background session read errors pause without claiming durable state', async () => {
  const request = await failingBackground({ readError: true });
  const result = await request('read');
  assert.equal(result.paused, true);
  assert.equal(result.durable, false);
  assert.equal(result.tabIdentity, '8');
  assert.equal((await request('read')).paused, true);
});

test('background session write errors retain memory pause without claiming durability', async () => {
  const request = await failingBackground({ writeError: true });
  const result = await request('write', true);
  assert.equal(result.paused, true);
  assert.equal(result.durable, false);
  const reread = await request('read');
  assert.equal(reread.paused, true);
  assert.equal(reread.durable, false);
});

test('synchronous session failures also preserve the safe memory state', async () => {
  const read = await failingBackground({ readError: 'throw' });
  const failedRead = await read('read');
  assert.equal(failedRead.paused, true);
  assert.equal(failedRead.durable, false);
  const write = await failingBackground({ writeError: 'throw' });
  assert.equal((await write('write', true)).paused, true);
  const continued = await write('write', false);
  assert.equal(continued.paused, false);
  assert.equal(continued.durable, false);
  assert.equal((await write('read')).paused, false);
});

test('content bridge marks non-durable state as memory and rehydrates a restored page', async (t) => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent('<!doctype html><html><head></head><body></body></html>');
  await page.evaluate(() => {
    window.__hydrations = 0;
    Object.defineProperty(window, 'chrome', { configurable: true, value: {
      storage: { local: { get(_key, callback) { callback({}); } } },
      runtime: { id: 'fixture-id', onMessage: { addListener() {} },
        getURL() { return 'data:text/javascript,window.fixtureMainStarted=true'; },
        sendMessage(message, callback) {
          window.__hydrations += 1;
          callback({ kind: message.kind, requestId: message.requestId, paused: true, durable: false, tabIdentity: '8' });
        }
      }
    } });
  });
  await page.addScriptTag({ content: await readFile('src/extension-entry.js', 'utf8') });
  await page.waitForFunction(() => window.fixtureMainStarted);
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-chaoxing-plus-tab-pause-ready')), 'memory');
  await page.addScriptTag({ content: `${pauseSource}\nwindow.pauseController = getTabAnswerPauseController();` });
  assert.equal(await page.evaluate(() => window.pauseController.canReload()), false);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal(await page.evaluate(() => window.__hydrations), 2);
});
