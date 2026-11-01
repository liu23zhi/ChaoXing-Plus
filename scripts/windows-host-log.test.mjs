import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';
import { createTestDirectory } from './test-helpers/temp-directory.mjs';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
const screenshots = createTestDirectory('windows-host-log');
let browser;
let bootstrap;
let uiRuntime;
let renderRuntime;
let keepAliveRuntime;

before(async () => {
  bootstrap = await readFile('windows/share-file/windows-bootstrap.js', 'utf8');
  uiRuntime = ts.transpileModule(await readFile('src/runtime/windows-host-log.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const source = await readFile('src/projects/common.ts', 'utf8');
  const parsed = ts.createSourceFile('common.ts', source, ts.ScriptTarget.Latest, true);
  const render = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'renderWorkResultsPanel');
  assert.ok(render, 'use the actual common panel render integration');
  renderRuntime = ts.transpileModule(render.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2019 } }).outputText;
  const panelSource = await readFile('src/runtime/panel.ts', 'utf8');
  const panelParsed = ts.createSourceFile('panel.ts', panelSource, ts.ScriptTarget.Latest, true);
  keepAliveRuntime = ts.transpileModule(['isTopFrame', 'ensureTopPanelKeepAlive'].map((name) => {
    const declaration = panelParsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration);
    return declaration.getText(panelParsed);
  }).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2019 } }).outputText;
  browser = await puppeteer.launch({
    headless: true, executablePath: process.env.CX_BROWSER_EXECUTABLE,
    protocolTimeout: 15000,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server']
  });
});

after(async () => { await browser?.close(); });

async function pageFor(t, options = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  page.setDefaultTimeout(10000);
  await page.setContent('<!doctype html><html><body><main>Simulated exam page</main></body></html>');
  await page.evaluate(({ bootstrap, uiRuntime, renderRuntime, options }) => {
    window.storageTouches = 0;
    for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, {
      configurable: true,
      get() { window.storageTouches++; throw new DOMException('storage unavailable', 'SecurityError'); }
    });
    window.diagnosticListeners = new Set();
    const addListener = document.addEventListener.bind(document);
    const removeListener = document.removeEventListener.bind(document);
    document.addEventListener = (type, listener, config) => {
      if (type === 'chaoxing-plus:windows-host-diagnostics') window.diagnosticListeners.add(listener);
      return addListener(type, listener, config);
    };
    document.removeEventListener = (type, listener, config) => {
      if (type === 'chaoxing-plus:windows-host-diagnostics') window.diagnosticListeners.delete(listener);
      return removeListener(type, listener, config);
    };
    window.__CX_WIN_INSTANCE__ = 'host-a';
    window.__CX_WIN_CONFIG_JSON__ = {
      'common.settings.windows-panel-enabled': options.panel !== false,
      'common.settings.windows-no-disk-write': options.noDiskWrite !== false
    };
    if (options.windows !== false) (0, eval)(bootstrap);
    const root = document.createElement('div');
    root.id = 'panel-common-work-results';
    root.innerHTML = '<header>Stable panel header</header><div data-panel-body></div>';
    document.body.append(root);
    (0, eval)(`(() => {
      const exports = (() => {
        const exports = {};
        ${options.injectionLog === 'unset' ? '' : `const __CXPLUS_WINDOWS_INJECTION_LOG__ = ${options.injectionLog !== false};`}
        ${uiRuntime}
        return exports;
      })();
      window.hostLogUI = exports;
      const mountWindowsHostLogPanel = exports.mountWindowsHostLogPanel;
      const root = document.getElementById('panel-common-work-results');
      const state = { panels: { workResults: { root, body: root.querySelector('[data-panel-body]') } } };
      const isWindowsHostRuntime = () => Boolean(window.__CX_WIN_HOST__);
      const canShowFloatingPanel = () => window.__CX_WIN_HOST__?.getConfig()['common.settings.windows-panel-enabled'] !== false;
      const createWorkResultsPanel = () => {
        window.panelRenders = (window.panelRenders || 0) + 1;
        const content = document.createElement('div');
        content.innerHTML = '<input data-answer-fixture value="keep this answer"><div data-work-results-list="true">Answer rows</div>';
        return content;
      };
      ${renderRuntime}
      window.renderFixture = renderWorkResultsPanel;
      window.renderFixture();
      window.originalAnswerInput = root.querySelector('[data-answer-fixture]');
    })();`);
  }, { bootstrap, uiRuntime, renderRuntime, options });
  return page;
}

async function publish(page, entries, instance = 'host-a') {
  return page.evaluate(({ entries, instance }) => window.__CX_WIN_HOST__.setDiagnostics({
    source: 'chaoxing-plus-windows-host', instance, entries
  }), { entries, instance });
}

function entry(sequence, code = 'session-connected', level = 'info') {
  return { sequence, elapsedMs: sequence * 1000, level, code };
}

test('actual Chromium replays bootstrap memory into the compact log area and updates only that area', async (t) => {
  const page = await pageFor(t);
  assert.equal(await publish(page, [entry(1, 'host-started'), entry(2, 'endpoint-waiting', 'warn')]), true);
  const state = await page.evaluate(() => {
    const section = document.querySelector('[data-windows-host-log]');
    window.originalLogSection = section;
    window.originalLogRow = section.querySelector('[data-sequence]');
    return {
      text: section.textContent, size: getComputedStyle(section).fontSize,
      first: section.parentElement.firstElementChild === section,
      renders: window.panelRenders,
      sameInput: document.querySelector('[data-answer-fixture]') === window.originalAnswerInput,
      listeners: window.diagnosticListeners.size, storage: window.storageTouches
    };
  });
  assert.match(state.text, /等待调试连接；部分客户端可能需登录后才开放/);
  assert.equal(state.size, '12px');
  assert.deepEqual({ ...state, text: undefined }, {
    text: undefined, size: '12px', first: true, renders: 1, sameInput: true, listeners: 1, storage: 0
  });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('chaoxing-plus:windows-host-diagnostics', {
    detail: [{ sequence: 999, code: 'injected arbitrary text' }]
  })));
  assert.equal(await publish(page, [entry(1, 'host-started'), entry(2, 'endpoint-waiting', 'warn')]), true);
  assert.equal(await page.evaluate(() => document.querySelector('[data-sequence]') === window.originalLogRow), true);
  await publish(page, [entry(1, 'host-started'), entry(2, 'endpoint-waiting', 'warn'), entry(3, 'bundle-ready')]);
  assert.deepEqual(await page.evaluate(() => ({ renders: window.panelRenders, sameInput: document.querySelector('[data-answer-fixture]') === window.originalAnswerInput, sections: document.querySelectorAll('[data-windows-host-log]').length })),
    { renders: 1, sameInput: true, sections: 1 });
  assert.doesNotMatch(await page.$eval('[data-windows-host-log]', (element) => element.textContent), /injected arbitrary text/);
});

test('first panel render replays earlier entries and ordinary panel refreshes preserve the log node and its scroll', async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    window.hostLogUI.mountWindowsHostLogPanel(document.getElementById('panel-common-work-results'), false);
  });
  await publish(page, Array.from({ length: 100 }, (_, index) => entry(index + 1)));
  assert.equal(await page.evaluate(() => window.diagnosticListeners.size), 0);
  await page.evaluate(() => window.renderFixture());
  await page.evaluate(() => {
    const list = document.querySelector('[data-windows-host-log-entries]');
    list.scrollTop = 80;
    window.savedLogList = list;
  });
  const before = await page.$eval('[data-windows-host-log-entries]', (element) => element.scrollTop);
  assert.ok(before > 0);
  await publish(page, Array.from({ length: 100 }, (_, index) => entry(index + 2)));
  await page.evaluate(() => { window.renderFixture(); window.renderFixture(); });
  assert.deepEqual(await page.evaluate(() => {
    const list = document.querySelector('[data-windows-host-log-entries]');
    return { same: list === window.savedLogList, scroll: list.scrollTop, count: list.children.length,
      first: list.firstElementChild.dataset.sequence, last: list.lastElementChild.dataset.sequence,
      listeners: window.diagnosticListeners.size };
  }), { same: true, scroll: before, count: 100, first: '101', last: '2', listeners: 1 });
  assert.equal(await publish(page, Array.from({ length: 101 }, (_, index) => entry(index + 1))), false);
  assert.equal(await page.$$eval('[data-windows-host-log-entries] [data-sequence]', (rows) => rows.length), 100);
});

test('a new host clears visible history, rejects old snapshots and keeps one listener while reconnecting', async (t) => {
  const page = await pageFor(t);
  await publish(page, [entry(1, 'host-started')]);
  await page.evaluate((bootstrap) => {
    window.__CX_WIN_INSTANCE__ = 'host-b';
    (0, eval)(bootstrap);
  }, bootstrap);
  assert.equal(await page.$$eval('[data-windows-host-log-entries] [data-sequence]', (rows) => rows.length), 0);
  assert.equal(await publish(page, [entry(2, 'bundle-failed', 'error')]), false);
  assert.equal(await publish(page, [entry(1, 'session-reconnected')], 'host-b'), true);
  await page.evaluate((bootstrap) => (0, eval)(bootstrap), bootstrap);
  assert.deepEqual(await page.evaluate(() => ({ listeners: window.diagnosticListeners.size, rows: document.querySelectorAll('[data-sequence]').length, storage: window.storageTouches })),
    { listeners: 1, rows: 1, storage: 0 });
  assert.match(await page.$eval('[data-windows-host-log]', (element) => element.textContent), /已恢复客户端页面连接/);
});

test('disabled or missing build flags, no-panel and extension pages install no log area or diagnostics listener', async (t) => {
  for (const options of [{ injectionLog: false }, { injectionLog: 'unset' }, { panel: false }, { windows: false }]) {
    const page = await pageFor(t, options);
    assert.deepEqual(await page.evaluate(() => ({ sections: document.querySelectorAll('[data-windows-host-log]').length, listeners: window.diagnosticListeners.size, storage: window.storageTouches })),
      { sections: 0, listeners: 0, storage: 0 });
  }
  const page = await pageFor(t);
  await page.evaluate(() => { window.__CX_WIN_HOST__.getConfig()['common.settings.windows-panel-enabled'] = false; });
  await publish(page, [entry(1)]);
  assert.deepEqual(await page.evaluate(() => ({ sections: document.querySelectorAll('[data-windows-host-log]').length, listeners: window.diagnosticListeners.size })),
    { sections: 0, listeners: 0 });
});

test('removing the panel and leaving the document release UI listeners without changing persisted state', async (t) => {
  const page = await pageFor(t, { noDiskWrite: false });
  const initialTouches = await page.evaluate(() => window.storageTouches);
  await publish(page, [entry(1, 'client-started')]);
  await page.evaluate(() => document.getElementById('panel-common-work-results').remove());
  await page.waitForFunction(() => window.diagnosticListeners.size === 0);
  assert.equal(await page.evaluate(() => window.storageTouches), initialTouches);
  const second = await pageFor(t);
  await second.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.deepEqual(await second.evaluate(() => ({ listeners: window.diagnosticListeners.size, sections: document.querySelectorAll('[data-windows-host-log]').length })),
    { listeners: 0, sections: 0 });
});

test('the real panel keep-alive can remount after a SPA body replacement without losing the diagnostics listener', async (t) => {
  const page = await pageFor(t);
  await page.evaluate((runtime) => {
    const root = document.getElementById('panel-common-work-results');
    (new Function('root', runtime + '\nensureTopPanelKeepAlive(root);'))(root);
    window.remountedPanel = root;
    document.body.replaceChildren(document.createElement('main'));
  }, keepAliveRuntime);
  await page.waitForFunction(() => window.remountedPanel.isConnected);
  await publish(page, [entry(1, 'top-navigated')]);
  assert.deepEqual(await page.evaluate(() => ({ listeners: window.diagnosticListeners.size, sections: document.querySelectorAll('[data-windows-host-log]').length })),
    { listeners: 1, sections: 1 });
  assert.match(await page.$eval('[data-windows-host-log]', (element) => element.textContent), /客户端页面已跳转/);
});

test('iframe bootstrap diagnostics remain frame-local and cannot create a second top-level log panel', async (t) => {
  const page = await pageFor(t);
  await publish(page, [entry(1, 'bundle-ready')]);
  await page.evaluate(() => {
    const iframe = document.createElement('iframe');
    iframe.srcdoc = '<!doctype html><html><body><div id="child-panel"></div></body></html>';
    document.body.append(iframe);
  });
  const frame = page.frames().find((frame) => frame !== page.mainFrame());
  await frame.waitForSelector('#child-panel');
  const state = await frame.evaluate(({ bootstrap, uiRuntime }) => {
    window.__CX_WIN_INSTANCE__ = 'child-instance';
    window.__CX_WIN_CONFIG_JSON__ = { 'common.settings.windows-no-disk-write': true };
    (0, eval)(bootstrap);
    const exports = {};
    (new Function('exports', '__CXPLUS_WINDOWS_INJECTION_LOG__', uiRuntime))(exports, true);
    const mounted = exports.mountWindowsHostLogPanel(document.getElementById('child-panel'), true);
    window.__CX_WIN_HOST__.setDiagnostics({ source: 'chaoxing-plus-windows-host', instance: 'child-instance', entries: [
      { sequence: 1, elapsedMs: 0, level: 'error', code: 'page-error' }
    ] });
    return { mounted: Boolean(mounted), rows: document.querySelectorAll('[data-windows-host-log]').length };
  }, { bootstrap, uiRuntime });
  assert.deepEqual(state, { mounted: false, rows: 0 });
  assert.equal(await page.$$eval('[data-windows-host-log]', (sections) => sections.length), 1);
  assert.doesNotMatch(await page.$eval('[data-windows-host-log]', (element) => element.textContent), /页面运行出现异常/);
});

test('the built Windows business bundle obeys its injection-log flag without rebuilding answer controls', async (t) => {
  const [builtBootstrap, bundle, manifestText] = await Promise.all([
    readFile('dist-windows/windows-bootstrap.js', 'utf8'), readFile('dist-windows/chaoxing-plus.windows.js', 'utf8'),
    readFile('dist-windows/package-manifest.json', 'utf8')
  ]);
  const showInjectionLogs = JSON.parse(manifestText).features?.injectionLog === true;
  const page = await browser.newPage();
  t.after(() => page.close());
  page.setDefaultTimeout(15000);
  await page.setViewport({ width: 1100, height: 850, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isNavigationRequest()) void request.respond({
      status: 200, contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><head><title>模拟考试列表</title></head><body><main><h1>模拟考试列表</h1><p>此页面没有试题，不运行答题。</p></main></body></html>'
    });
    else void request.abort();
  });
  await page.goto('http://a.chaoxing.com/exam-ans/exam/list');
  await page.evaluate((bootstrap) => {
    window.storageTouches = 0;
    window.diagnosticListeners = new Set();
    const addListener = document.addEventListener.bind(document);
    const removeListener = document.removeEventListener.bind(document);
    document.addEventListener = (type, listener, config) => {
      if (type === 'chaoxing-plus:windows-host-diagnostics') window.diagnosticListeners.add(listener);
      return addListener(type, listener, config);
    };
    document.removeEventListener = (type, listener, config) => {
      if (type === 'chaoxing-plus:windows-host-diagnostics') window.diagnosticListeners.delete(listener);
      return removeListener(type, listener, config);
    };
    for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, {
      configurable: true,
      get() { window.storageTouches++; throw new DOMException('storage unavailable', 'SecurityError'); }
    });
    window.__CX_WIN_INSTANCE__ = 'built-host';
    window.__CX_WIN_CONFIG_JSON__ = {
      'common.settings.windows-no-disk-write': true,
      'common.settings.windows-panel-enabled': true,
      'common.settings.windows-panel-collapsed': false,
      'cx.new.study.enableAnswer': false,
      'cx.new.study.enableChapterTest': false,
      'cx.new.study.enableVisibleQuestionFallback': false
    };
    (0, eval)(bootstrap);
    window.__CX_WIN_HOST__.setDiagnostics({ source: 'chaoxing-plus-windows-host', instance: 'built-host', entries: [
      { sequence: 1, elapsedMs: 0, level: 'info', code: 'host-started' },
      { sequence: 2, elapsedMs: 20, level: 'info', code: 'client-started' },
      { sequence: 3, elapsedMs: 100, level: 'warn', code: 'endpoint-waiting' },
      { sequence: 4, elapsedMs: 900, level: 'info', code: 'endpoint-ready' },
      { sequence: 5, elapsedMs: 1000, level: 'info', code: 'session-connected' }
    ] });
  }, builtBootstrap);
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector('#panel-common-work-results input');
  if (!showInjectionLogs) {
    await page.evaluate(() => {
      window.originalBuiltControl = document.querySelector('#panel-common-work-results input');
      const entries = window.__CX_WIN_HOST__.getDiagnostics();
      entries.push({ sequence: 6, elapsedMs: 1100, level: 'info', code: 'bundle-ready' });
      window.__CX_WIN_HOST__.setDiagnostics({ source: 'chaoxing-plus-windows-host', instance: 'built-host', entries });
    });
    assert.deepEqual(await page.evaluate(() => ({
      sections: document.querySelectorAll('[data-windows-host-log]').length,
      listeners: window.diagnosticListeners.size,
      sameControl: document.querySelector('#panel-common-work-results input') === window.originalBuiltControl
    })), { sections: 0, listeners: 0, sameControl: true });
    await page.screenshot({ path: resolve(screenshots, 'release-panel.png'), fullPage: true });
    return;
  }
  await page.waitForSelector('[data-windows-host-log]');
  await page.evaluate(() => {
    window.builtLogSection = document.querySelector('[data-windows-host-log]');
    window.builtAnswerControl = document.querySelector('#panel-common-work-results input');
  });
  const initial = await page.evaluate(() => ({
    title: document.querySelector('[data-windows-host-log]').firstElementChild.textContent,
    text: document.querySelector('[data-windows-host-log]').textContent,
    fontSize: getComputedStyle(document.querySelector('[data-windows-host-log]')).fontSize,
    rows: document.querySelectorAll('[data-windows-host-log] [data-sequence]').length,
    input: Boolean(window.builtAnswerControl), storage: window.storageTouches
  }));
  assert.equal(initial.title, '连接与注入日志 · 最近 100 条');
  assert.match(initial.text, /宿主已启动/);
  assert.match(initial.text, /等待调试连接；部分客户端可能需登录后才开放/);
  assert.equal(initial.fontSize, '12px');
  assert.equal(initial.rows, 5);
  assert.equal(initial.input, true);
  // Other business modules may probe unavailable storage during startup. The
  // diagnostics update must add no access to that existing startup baseline.
  await page.evaluate(() => {
    const entries = window.__CX_WIN_HOST__.getDiagnostics();
    entries.push({ sequence: 6, elapsedMs: 1100, level: 'info', code: 'bundle-ready' });
    window.__CX_WIN_HOST__.setDiagnostics({ source: 'chaoxing-plus-windows-host', instance: 'built-host', entries });
  });
  assert.deepEqual(await page.evaluate(() => ({
    sameSection: document.querySelector('[data-windows-host-log]') === window.builtLogSection,
    sameControl: document.querySelector('#panel-common-work-results input') === window.builtAnswerControl,
    rows: document.querySelectorAll('[data-windows-host-log] [data-sequence]').length,
    storage: window.storageTouches
  })), { sameSection: true, sameControl: true, rows: 6, storage: initial.storage });
  await page.screenshot({ path: resolve(screenshots, 'panel.png'), fullPage: true });
});

