import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';

// CX_BROWSER_DEPENDENCIES points to a package directory with Puppeteer installed;
// CX_BROWSER_EXECUTABLE can select Chrome. CX_TEST_BASELINE tests HEAD instead.
const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
const key = 'cx.new.study.enableDebugLogPanel';
let browser;
let server;
let url;
let script;

before(async () => {
  const store = (await readFile('src/runtime/store.ts', 'utf8')).replace(/^export /gm, '');
  const projectSource = process.env.CX_TEST_BASELINE
    ? execFileSync('git', ['show', 'HEAD:src/projects/cx.ts'], { encoding: 'utf8' })
    : await readFile('src/projects/cx.ts', 'utf8');
  const panel = `const debugLogPanelSettingKey${projectSource.split('const debugLogPanelSettingKey')[1].split('type DebugMeta')[0]}`;
  script = ts.transpileModule(`(() => {
    ${store}
    const topWindow = window.top;
    ${panel}
    window.__logTest = { append: appendDebugLogPanelEntry };
  })();`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/early') {
      response.end(`<!doctype html><html><head><script>localStorage.setItem(${JSON.stringify(key)}, 'true');</script><script>${script}</script></head><body>Parsing complete</body></html>`);
      return;
    }
    response.end('<!doctype html><html><body><button id="answer">Answer</button><div id="main" style="position:fixed;z-index:2147483646;right:8px;top:8px;width:100px;height:60px">Main panel</div></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
  browser = await puppeteer.launch({
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
    defaultViewport: { width: 1280, height: 900 }
  });
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

async function openPage(enabled = true) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(url);
  await page.evaluate((key, enabled) => {
    localStorage.setItem(key, JSON.stringify(enabled));
    document.querySelector('#answer').onclick = () => {
      document.querySelector('#answer').dataset.answered = 'true';
    };
    window.__copied = [];
    navigator.clipboard.writeText = async text => { window.__copied.push(text); };
  }, key, enabled);
  return page;
}

async function clickButton(page, label) {
  await page.locator(`::-p-text(${label})`).click();
}

async function addFrame(page) {
  await page.evaluate(url => {
    const frame = document.createElement('iframe');
    frame.src = `${url}frame`;
    document.body.append(frame);
  }, url);
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.readyState === 'complete');
  return page.frames().find(frame => frame.parentFrame());
}

test('saved enabled setting shows the panel at startup without a log or toggle', async () => {
  const page = await openPage();
  try {
    await page.addScriptTag({ content: script });
    assert.equal(await page.$eval('body', body => Boolean(body.querySelector('#chaoxing-plus-debug-log-panel'))), true);
  } finally { await page.close(); }
});

test('startup before body parsing keeps the panel and its controls alive', async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.goto(`${url}early`);
    assert.notEqual(await page.$('#chaoxing-plus-debug-log-panel'), null);
    await page.evaluate(() => window.__logTest.append('info', 'early-startup', {}));
    await page.waitForFunction(() => document.querySelector('[data-cx-debug-log-panel-body]')?.textContent.includes('early-startup'));
    await clickButton(page, '清空');
    assert.equal(await page.$eval('[data-cx-debug-log-panel-body]', body => body.children.length), 0);
  } finally { await page.close(); }
});

test('the log panel is below the main panel', async () => {
  const page = await openPage();
  try {
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.__logTest.append('info', 'level test', {}));
    const levels = await page.evaluate(() => ({
      log: Number(getComputedStyle(document.querySelector('#chaoxing-plus-debug-log-panel')).zIndex),
      main: Number(getComputedStyle(document.querySelector('#main')).zIndex)
    }));
    assert.ok(levels.log < levels.main);
  } finally { await page.close(); }
});

test('top panel buttons and drag survive removal of a logging iframe', async () => {
  const page = await openPage();
  try {
    await page.addScriptTag({ content: script });
    const frame = await addFrame(page);
    await frame.addScriptTag({ content: script });
    await frame.evaluate(() => window.__logTest.append('info', 'iframe entry', { answer: 'A' }));
    await page.waitForFunction(() => document.querySelector('[data-cx-debug-log-panel-body]')?.children.length > 0);
    await page.evaluate(() => document.querySelector('iframe').remove());
    await page.evaluate(() => window.__logTest.append('info', 'after removal', {}));
    await page.waitForFunction(() => document.querySelector('[data-cx-debug-log-panel-body]')?.textContent.includes('after removal'));
    await clickButton(page, '复制');
    assert.equal(await page.$eval('#chaoxing-plus-debug-log-panel button', button => button.textContent), '已复制');
    assert.equal(await page.evaluate(() => window.__copied.length), 1);
    await clickButton(page, '清空');
    assert.equal(await page.$eval('[data-cx-debug-log-panel-body]', body => body.children.length), 0);
    const header = await page.$('[data-cx-debug-log-panel-drag-handle]');
    const initial = await header.boundingBox();
    await page.mouse.move(initial.x + 20, initial.y + 12);
    await page.mouse.down();
    await page.mouse.move(initial.x - 100, initial.y - 90, { steps: 8 });
    await page.mouse.up();
    const moved = await header.boundingBox();
    assert.ok(moved.x < initial.x - 50);
    assert.ok(moved.y < initial.y - 50);
    await clickButton(page, '隐藏');
    assert.equal(await page.$eval('#chaoxing-plus-debug-log-panel', panel => getComputedStyle(panel).display), 'none');
  } finally { await page.close(); }
});

test('burst logs remain bounded, ordered, and clearable while answering still works', async () => {
  const page = await openPage();
  try {
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      for (let i = 0; i < 3000; i++) window.__logTest.append('info', `entry-${i}`, { text: 'x'.repeat(10000) });
    });
    await page.waitForFunction(() => document.querySelector('[data-cx-debug-log-panel-body]')?.textContent.includes('entry-2999'));
    const logs = await page.$eval('[data-cx-debug-log-panel-body]', body => Array.from(body.children, row => row.textContent));
    assert.equal(logs.length, 200);
    assert.match(logs[0], /entry-2999/);
    assert.match(logs.at(-1), /entry-2800/);
    assert.ok(logs.every(log => log.length < 4200));
    await page.click('#answer');
    assert.equal(await page.$eval('#answer', button => button.dataset.answered), 'true');
    await clickButton(page, '清空');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.$eval('[data-cx-debug-log-panel-body]', body => body.children.length), 0);
  } finally { await page.close(); }
});

test('a replacement iframe and pending frame removal cannot strand the top rendering queue', async () => {
  const page = await openPage();
  try {
    await page.addScriptTag({ content: script });
    const frame = await addFrame(page);
    await frame.addScriptTag({ content: script });
    await frame.evaluate(() => {
      for (let i = 0; i < 300; i++) window.__logTest.append('info', `before-removal-${i}`, {});
      window.frameElement.remove();
    }).catch(error => {
      if (!error.message.includes('Execution context was destroyed')) throw error;
    });
    const replacement = await addFrame(page);
    await replacement.addScriptTag({ content: script });
    await replacement.evaluate(() => window.__logTest.append('info', 'replacement-frame', {}));
    await page.waitForFunction(() => document.querySelector('[data-cx-debug-log-panel-body]')?.textContent.includes('replacement-frame'));
    await clickButton(page, '清空');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.$eval('[data-cx-debug-log-panel-body]', body => body.children.length), 0);
  } finally { await page.close(); }
});

test('turning the saved switch off and on recreates a hidden panel without unrelated settings unhiding it', async () => {
  const page = await openPage();
  try {
    await page.addScriptTag({ content: script });
    await clickButton(page, '隐藏');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('chaoxing-plus:shared-store-sync', { detail: { 'cx.new.study.volume': 1 } })));
    assert.equal(await page.$eval('#chaoxing-plus-debug-log-panel', panel => getComputedStyle(panel).display), 'none');
    const frame = await addFrame(page);
    await frame.addScriptTag({ content: script });
    assert.equal(await page.$eval('#chaoxing-plus-debug-log-panel', panel => getComputedStyle(panel).display), 'none');
    await frame.evaluate(key => document.dispatchEvent(new CustomEvent('chaoxing-plus:shared-store-hydrate', { detail: { [key]: true } })), key);
    assert.equal(await page.$eval('#chaoxing-plus-debug-log-panel', panel => getComputedStyle(panel).display), 'none');
    await page.evaluate(key => document.dispatchEvent(new CustomEvent('chaoxing-plus:shared-store-hydrate', { detail: { [key]: false } })), key);
    assert.equal(await page.$('#chaoxing-plus-debug-log-panel'), null);
    await page.evaluate(key => document.dispatchEvent(new CustomEvent('chaoxing-plus:shared-store-hydrate', { detail: { [key]: true } })), key);
    assert.equal(await page.$eval('#chaoxing-plus-debug-log-panel', panel => getComputedStyle(panel).display), 'flex');
  } finally { await page.close(); }
});

test('large and accessor details are bounded without executing page getters', async () => {
  const page = await openPage();
  try {
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      window.__getterCalls = 0;
      const detail = {};
      Object.defineProperty(detail, 'expensive', { enumerable: true, get() { window.__getterCalls++; throw new Error('getter must not execute'); } });
      detail.huge = 'x'.repeat(1000000);
      window.__logTest.append('info', 'bounded-detail', detail);
    });
    await page.waitForFunction(() => document.querySelector('[data-cx-debug-log-panel-body]')?.textContent.includes('bounded-detail'));
    assert.equal(await page.evaluate(() => window.__getterCalls), 0);
    assert.ok(await page.$eval('[data-cx-debug-log-panel-body]', body => body.textContent.length < 4200));
    await page.screenshot({ path: join(process.env.CX_BROWSER_SCREENSHOTS ?? tmpdir(), 'debug-log-panel-desktop.png') });
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({ path: join(process.env.CX_BROWSER_SCREENSHOTS ?? tmpdir(), 'debug-log-panel-mobile.png') });
  } finally { await page.close(); }
});

test('a cross-origin top document falls back to the current frame without a startup error', async () => {
  const page = await openPage(false);
  try {
    await page.addScriptTag({ content: script });
    const frameUrl = url.replace('127.0.0.1', 'localhost');
    await page.evaluate(frameUrl => {
      const frame = document.createElement('iframe');
      frame.style.width = '900px';
      frame.style.height = '600px';
      frame.src = frameUrl;
      document.body.append(frame);
    }, frameUrl);
    await page.waitForFrame(frame => frame.url().startsWith(frameUrl));
    const frame = page.frames().find(frame => frame.parentFrame());
    await frame.evaluate(key => localStorage.setItem(key, 'true'), key);
    await frame.addScriptTag({ content: script });
    await frame.evaluate(() => window.__logTest.append('info', 'cross-origin-entry', {}));
    await frame.waitForFunction(() => document.querySelector('[data-cx-debug-log-panel-body]')?.textContent.includes('cross-origin-entry'));
    await frame.locator('::-p-text(清空)').click();
    assert.equal(await frame.$eval('[data-cx-debug-log-panel-body]', body => body.children.length), 0);
    assert.equal(await page.$('#chaoxing-plus-debug-log-panel'), null);
  } finally { await page.close(); }
});
