import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
const swalPath = resolve('node_modules/sweetalert2/dist/sweetalert2.all.js');
const screenshots = resolve('.tmp-tests-swal');
let browser;
let server;
let port;
let runtime;

before(async () => {
  const source = process.env.CX_TEST_BASELINE
    ? execFileSync('git', ['show', 'HEAD:src/runtime/message.ts'], { encoding: 'utf8' })
    : await readFile('src/runtime/message.ts', 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  runtime = `(() => {
    const module = { exports: {} };
    const exports = module.exports;
    const require = () => Swal;
    ${compiled}
    window.__modalTest = module.exports.$modal;
  })();`;
  await mkdir(screenshots, { recursive: true });
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><title>Swal iframe regression</title></head>
      <body><h1>Top page</h1><div id="main-panel" style="position:fixed;z-index:2147483646;inset:0;background:#e5efe8">Floating panel</div></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: [
      '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
      '--host-resolver-rules=MAP a.chaoxing.com 127.0.0.1,MAP b.chaoxing.com 127.0.0.1,MAP evil.invalid 127.0.0.1'
    ],
    defaultViewport: { width: 1280, height: 900 }
  });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function installRuntime(frame) {
  await frame.addScriptTag({ path: swalPath });
  await frame.addScriptTag({ content: runtime });
}

async function openPage({ install = true } = {}) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  await page.goto(`http://a.chaoxing.com:${port}/`);
  if (install) await installRuntime(page);
  return page;
}

async function addFrame(parent, hostname = 'a.chaoxing.com') {
  const id = `frame-${Math.random().toString(36).slice(2)}`;
  await parent.evaluate(({ id, src }) => {
    const element = document.createElement('iframe');
    element.id = id;
    element.src = src;
    document.body.appendChild(element);
  }, { id, src: `http://${hostname}:${port}/${id}` });
  const element = await parent.waitForSelector(`#${id}`);
  const frame = await element.contentFrame();
  await frame.waitForFunction(() => document.readyState === 'complete');
  return frame;
}

async function startAlert(frame) {
  await frame.evaluate(() => {
    window.__resolved = false;
    void window.__modalTest.alert({
      content: 'All tasks completed', icon: 'success', allowOutsideClick: false, allowEscapeKey: false
    }).then(() => { window.__resolved = true; });
  });
}

async function confirmAlert(page, frame) {
  await page.waitForSelector('.swal2-confirm', { visible: true });
  assert.equal(await frame.$('.swal2-container'), null);
  await page.click('.swal2-confirm');
  await frame.waitForFunction(() => window.__resolved === true);
}

test('callable top Swal handles an alert from two nested same-origin iframes', async () => {
  const page = await openPage({ install: false });
  try {
    await page.addScriptTag({ path: swalPath });
    await page.evaluate(() => { window.__chaoxing_plus_swal__ = Swal; });
    const frame = await addFrame(await addFrame(page));
    await installRuntime(frame);
    await startAlert(frame);
    await confirmAlert(page, frame);
  } finally { await page.close(); }
});

test('top-owned runtime works without the asynchronous vendor alias and covers the floating panel', async () => {
  const page = await openPage();
  try {
    const frame = await addFrame(await addFrame(page));
    await installRuntime(frame);
    await startAlert(frame);
    await page.waitForSelector('.swal2-confirm', { visible: true });
    assert.equal(await page.evaluate(() => typeof window.__chaoxing_plus_swal__), 'function');
    const covered = await page.evaluate(() => {
      const button = document.querySelector('.swal2-confirm');
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    });
    assert.equal(covered, true);
    await page.screenshot({ path: resolve(screenshots, 'nested-same-origin.png') });
    await confirmAlert(page, frame);
  } finally { await page.close(); }
});

test('a delayed top runtime receives a same-origin iframe alert instead of leaving it in the iframe', async () => {
  const page = await openPage({ install: false });
  try {
    const frame = await addFrame(page);
    await installRuntime(frame);
    await startAlert(frame);
    await installRuntime(page);
    await confirmAlert(page, frame);
  } finally { await page.close(); }
});

test('cross-origin alert survives delayed initialization and waits beyond the bridge timeout for confirmation', async () => {
  const page = await openPage({ install: false });
  try {
    const frame = await addFrame(await addFrame(page, 'b.chaoxing.com'), 'b.chaoxing.com');
    await installRuntime(frame);
    await startAlert(frame);
    await installRuntime(page);
    await page.waitForSelector('.swal2-confirm', { visible: true });
    await page.keyboard.press('Escape');
    await page.mouse.click(3, 3);
    // This deliberately exceeds the handshake timeout to catch duplicate local fallbacks.
    await new Promise((resolve) => setTimeout(resolve, 2700));
    assert.equal(await frame.evaluate(() => window.__resolved), false);
    assert.equal(await frame.$('.swal2-container'), null);
    assert.equal(await page.$$eval('.swal2-container', (elements) => elements.length), 1);
    await page.screenshot({ path: resolve(screenshots, 'nested-cross-origin.png') });
    await confirmAlert(page, frame);
  } finally { await page.close(); }
});

test('cross-origin confirmation cancellation denial and timer results return to their original caller', async () => {
  const page = await openPage();
  try {
    const frame = await addFrame(page, 'b.chaoxing.com');
    await installRuntime(frame);
    for (const [button, expected] of [['.swal2-confirm', true], ['.swal2-cancel', false]]) {
      await frame.evaluate(() => {
        window.__result = undefined;
        void window.__modalTest.confirm('Confirm in the top page').then((result) => { window.__result = result; });
      });
      await page.waitForSelector(button, { visible: true });
      await page.click(button);
      await frame.waitForFunction(() => typeof window.__result === 'boolean');
      assert.equal(await frame.evaluate(() => window.__result), expected);
    }
    await frame.evaluate(() => {
      window.__denied = false;
      void window.__modalTest.alert({ content: 'Optional denial', denyButtonText: 'Skip', onDeny: () => { window.__denied = true; } });
    });
    await page.waitForSelector('.swal2-deny', { visible: true });
    await page.click('.swal2-deny');
    await frame.waitForFunction(() => window.__denied === true);
    assert.equal(await frame.evaluate(() => window.__modalTest.confirm({
      content: 'Default on timer', timer: 80, defaultConfirmed: true
    })), true);
  } finally { await page.close(); }
});

test('a top page without a runtime falls back once after bounded waiting', async () => {
  const page = await openPage({ install: false });
  try {
    const frame = await addFrame(page, 'b.chaoxing.com');
    await installRuntime(frame);
    await startAlert(frame);
    assert.equal(await frame.$('.swal2-container'), null);
    await frame.waitForSelector('.swal2-confirm', { visible: true });
    assert.equal(await page.$('.swal2-container'), null);
    assert.equal(await frame.$$eval('.swal2-container', (elements) => elements.length), 1);
    await frame.$eval('.swal2-confirm', (button) => button.click());
    await frame.waitForFunction(() => window.__resolved === true);
  } finally { await page.close(); }
});

test('removing a cross-origin caller leaves the top alert usable for a replacement iframe', async () => {
  const page = await openPage();
  try {
    const frame = await addFrame(page, 'b.chaoxing.com');
    await installRuntime(frame);
    await startAlert(frame);
    await page.waitForSelector('.swal2-confirm', { visible: true });
    await page.$eval('iframe', (element) => element.remove());
    await page.click('.swal2-confirm');
    const replacement = await addFrame(page, 'b.chaoxing.com');
    await installRuntime(replacement);
    await startAlert(replacement);
    await confirmAlert(page, replacement);
  } finally { await page.close(); }
});

test('an unrelated embedded origin cannot request a top modal', async () => {
  const page = await openPage();
  try {
    const frame = await addFrame(page, 'evil.invalid');
    const id = 'untrusted-frame';
    await frame.evaluate((id) => {
      window.__probeDone = false;
      window.addEventListener('message', (event) => {
        if (event.data?.namespace === 'probe') window.__probeDone = true;
      });
      window.top.postMessage({ namespace: 'chaoxing-plus:swal', kind: 'fire', id, options: { text: 'untrusted' } }, '*');
      window.top.postMessage({ namespace: 'probe', id }, '*');
    }, id);
    await page.evaluate(() => {
      // Observe another event-loop turn after the previous messages were delivered.
      return new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.equal(await page.$('.swal2-container'), null);
  } finally { await page.close(); }
});
