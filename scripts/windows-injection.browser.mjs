import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PageSession } from '../windows/host/inject.mjs';
import { fetchJson } from '../windows/host/cdp.mjs';
import { createHostDiagnostics } from '../windows/host/memory-diagnostics.mjs';

const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
const messagePrefix = '__CX_WIN_MSG__';
let browser;
let server;
let port;
let browserPort;
let sequence = 0;

before(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url.startsWith('/csp/')) response.setHeader('Content-Security-Policy', "script-src 'none'");
    response.end('<!doctype html><html><head><title>Windows injection fixture</title></head><body><h1>Local injection fixture</h1></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: [
      '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
      '--host-resolver-rules=MAP a.chaoxing.com 127.0.0.1'
    ]
  });
  browserPort = Number(new URL(browser.wsEndpoint()).port);
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

function fixtureAssets() {
  return {
    version: 'browser-fixture',
    style: '',
    trampoline: `console.log('${messagePrefix}'+JSON.stringify({kind:'boot-request'}));`,
    bootstrap: `if (!window.__injectionFixtureHost) {
      window.__injectionFixtureHost = true;
      window.__CX_WIN_HOST__ = { fixture: true };
      window.__bootstrapMethod = document.currentScript ? 'script' : 'runtime';
      window.__fixtureReadyCount = (window.__fixtureReadyCount || 0) + 1;
      console.log('${messagePrefix}'+JSON.stringify({source:'chaoxing-plus-windows',instance:window.__CX_WIN_INSTANCE__,kind:'ready'}));
    }`,
    bundle: `window.__fixtureBundleCount = (window.__fixtureBundleCount || 0) + 1;
      window.__bundleMethod = document.currentScript ? 'script' : 'runtime';`
  };
}

async function openFixture({ strategy = 'hybrid', retries = 0, csp = false, hostname = 'a.chaoxing.com', pathname, expectBundle = true, assets = fixtureAssets(), configStore = { isEnabled: () => true, settingsSnapshot: () => ({}) }, instanceToken, diagnostics } = {}) {
  const page = await browser.newPage();
  let session;
  try {
    page.setDefaultTimeout(6000);
    const route = csp ? 'csp' : 'page';
    const pagePath = pathname ?? `/${route}/${++sequence}`;
    await page.goto(`http://${hostname}:${port}${pagePath}`);
    const targets = await fetchJson(browserPort, '/json/list');
    const target = targets.find((item) => item.type === 'page' && item.url === page.url());
    assert.ok(target?.webSocketDebuggerUrl, 'the fixture page must expose its own CDP target');
    const logs = [];
    session = new PageSession({
      port: browserPort,
      target,
      assets,
      configStore,
      instanceToken: instanceToken ?? `browser-fixture-${sequence}`,
      injectBlankFrames: true,
      captureConsole: true,
      injectStrategy: strategy,
      injectRetries: retries,
      diagnostics,
      logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) }
    });
    await session.open();
    if (expectBundle) {
      await page.waitForFunction(() => window.__CX_WIN_BUNDLE_LOADED__ === true);
      await waitFor(() => session.stats.bundles === 1, 'the bundle acknowledgement');
    } else {
      await waitFor(() => session.stats.bootstraps === 1, 'the bootstrap acknowledgement');
    }
    return { page, session, logs };
  } catch (error) {
    session?.close();
    await page.close();
    throw error;
  }
}

async function closeFixture({ page, session }) {
  session.close();
  if (!page.isClosed()) await page.close();
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const [strategy, expectedMethod] of [['runtime', 'runtime'], ['script', 'script'], ['hybrid', 'runtime']]) {
  test(`${strategy} injects bootstrap and bundle through a real Chromium CDP target`, async () => {
    const fixture = await openFixture({ strategy });
    try {
      assert.deepEqual(await fixture.page.evaluate(() => ({
        bootstrapMethod: window.__bootstrapMethod,
        bundleMethod: window.__bundleMethod,
        bundleCount: window.__fixtureBundleCount,
        version: window.__CX_WIN_BUNDLE_VERSION__,
        scriptMarkers: Object.keys(window).filter((key) => key.startsWith('__CX_WIN_SCRIPT_INJECT_ERROR_'))
      })), {
        bootstrapMethod: expectedMethod,
        bundleMethod: expectedMethod,
        bundleCount: 1,
        version: 'browser-fixture',
        scriptMarkers: []
      });
      assert.equal(fixture.session.stats.bundles, 1);
      assert.equal(fixture.session.stats.errors.length, 0);
      assert.equal(await fixture.page.$$eval('script', (nodes) => nodes.length), 0);
    } finally { await closeFixture(fixture); }
  });
}

test('script strategy detects CSP rejection and falls back to Runtime execution', async () => {
  const fixture = await openFixture({ strategy: 'script', csp: true });
  try {
    assert.equal(await fixture.page.evaluate(() => window.__bootstrapMethod), 'runtime');
    assert.equal(await fixture.page.evaluate(() => window.__bundleMethod), 'runtime');
    assert.ok(fixture.logs.some((message) => /script/.test(message) && /路径失败/.test(message)));
    assert.equal(fixture.session.stats.bundles, 1);
    assert.equal(await fixture.page.$$eval('script', (nodes) => nodes.length), 0);
  } finally { await closeFixture(fixture); }
});

test('hybrid falls back to a real script element after Runtime throws', async () => {
  const fixture = await openFixture({ strategy: 'hybrid' });
  try {
    await fixture.session.injectSource(fixture.session.getTopContextId(), `
      if (!document.currentScript) throw new Error('fixture runtime rejection');
      window.__hybridFallback = document.currentScript.tagName;
    `, 'hybrid browser fixture');
    assert.equal(await fixture.page.evaluate(() => window.__hybridFallback), 'SCRIPT');
    assert.ok(fixture.logs.some((message) => /fixture runtime rejection/.test(message)));
  } finally { await closeFixture(fixture); }
});

test('Runtime retries real exceptions to the configured limit and preserves the final failure', async () => {
  const fixture = await openFixture({ strategy: 'runtime', retries: 2 });
  try {
    const contextId = fixture.session.getTopContextId();
    await fixture.session.injectSource(contextId, `
      window.__runtimeAttempts = (window.__runtimeAttempts || 0) + 1;
      if (window.__runtimeAttempts < 3) throw new Error('fixture transient failure');
      window.__runtimeEventuallyReady = true;
    `, 'runtime retry fixture');
    assert.equal(await fixture.page.evaluate(() => window.__runtimeAttempts), 3);
    assert.equal(await fixture.page.evaluate(() => window.__runtimeEventuallyReady), true);

    fixture.session.injectRetries = 1;
    await assert.rejects(fixture.session.injectSource(contextId, `
      window.__runtimeFailedAttempts = (window.__runtimeFailedAttempts || 0) + 1;
      throw new Error('fixture final failure');
    `, 'runtime exhausted fixture'), /fixture final failure/);
    assert.equal(await fixture.page.evaluate(() => window.__runtimeFailedAttempts), 2);
  } finally { await closeFixture(fixture); }
});

test('navigation replaces the execution context and injects the new document only once', async () => {
  const fixture = await openFixture({ strategy: 'hybrid' });
  try {
    const previousContext = fixture.session.getTopContextId();
    await fixture.page.goto(`http://a.chaoxing.com:${port}/page/navigation-${++sequence}`);
    await fixture.page.waitForFunction(() => window.__CX_WIN_BUNDLE_LOADED__ === true);
    assert.notEqual(fixture.session.getTopContextId(), previousContext);
    assert.equal(await fixture.page.evaluate(() => window.__fixtureBundleCount), 1);
    await assert.rejects(
      fixture.session.injectSource(previousContext, 'window.__staleContextMutation = true;', 'stale context fixture'),
      /context|destroyed/i
    );
    assert.equal(await fixture.page.evaluate(() => window.__staleContextMutation), undefined);
  } finally { await closeFixture(fixture); }
});

test('real console messages must match the active host before synchronizing configuration', async () => {
  const fixture = await openFixture({ strategy: 'runtime' });
  try {
    const changes = [];
    fixture.session.onConfigSync = (detail) => changes.push(detail);
    await fixture.page.evaluate((prefix) => {
      const send = (envelope, detail) => console.log(prefix + JSON.stringify({ kind: 'config-sync', detail, ...envelope }));
      send({}, { marker: 'missing-envelope' });
      send({ source: 'forged', instance: window.__CX_WIN_INSTANCE__ }, { marker: 'wrong-source' });
      send({ source: 'chaoxing-plus-windows', instance: 'old-instance' }, { marker: 'old-instance' });
      send({ source: 'chaoxing-plus-windows', instance: window.__CX_WIN_INSTANCE__ }, { marker: 'accepted' });
    }, messagePrefix);
    await waitFor(() => changes.length > 0, 'the validated configuration message');
    assert.deepEqual(changes, [{ marker: 'accepted' }]);
    assert.equal(fixture.session.stats.configSyncs, 1);
  } finally { await closeFixture(fixture); }
});

test('removing a real iframe clears its execution context and injection state', async () => {
  const fixture = await openFixture({ strategy: 'runtime' });
  try {
    const frameUrl = `http://a.chaoxing.com:${port}/page/frame-${++sequence}`;
    await fixture.page.evaluate((url) => new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.id = 'injection-child';
      frame.onload = resolve;
      frame.src = url;
      document.body.appendChild(frame);
    }), frameUrl);
    const frame = fixture.page.frames().find((item) => item.url() === frameUrl);
    assert.ok(frame);
    await frame.waitForFunction(() => window.__CX_WIN_BUNDLE_LOADED__ === true);
    const entry = [...fixture.session.contexts].find(([contextId]) => fixture.session.frameUrlForContext(contextId) === frameUrl);
    assert.ok(entry, 'the host must register the actual child execution context');
    const contextId = entry[0];
    await waitFor(() => fixture.session.bundleLoaded.has(contextId), 'the child bundle acknowledgement');
    await fixture.page.$eval('#injection-child', (element) => element.remove());
    await waitFor(() => !fixture.session.contexts.has(contextId), 'the removed iframe context to be discarded');
    assert.equal(fixture.session.bootstrapped.has(contextId), false);
    assert.equal(fixture.session.readyContexts.has(contextId), false);
    assert.equal(fixture.session.bundleLoaded.has(contextId), false);
  } finally { await closeFixture(fixture); }
});

test('closing the session stops future document injection and cancels its timers', async () => {
  const fixture = await openFixture({ strategy: 'hybrid' });
  try {
    fixture.session.scheduleRescan();
    fixture.session.scheduleTopFrameEnsure();
    const previousBundles = fixture.session.stats.bundles;
    fixture.session.close();
    assert.equal(fixture.session.closed, true);
    assert.equal(fixture.session.connection.closed, true);
    assert.equal(fixture.session.rescanTimer, null);
    assert.equal(fixture.session.topEnsureTimer, null);
    await fixture.page.goto(`http://a.chaoxing.com:${port}/page/after-close-${++sequence}`);
    assert.equal(await fixture.page.evaluate(() => window.__CX_WIN_BUNDLE_LOADED__), undefined);
    assert.equal(fixture.session.stats.bundles, previousBundles);
  } finally { await closeFixture(fixture); }
});

test('concurrent requests inject a real bundle only once per execution context', async () => {
  const fixture = await openFixture({ strategy: 'runtime' });
  try {
    const contextId = fixture.session.getTopContextId();
    fixture.session.bundleLoaded.delete(contextId);
    await fixture.page.evaluate(() => { window.__fixtureBundleCount = 0; });
    await Promise.all([
      fixture.session.injectBundle(contextId),
      fixture.session.injectBundle(contextId),
      fixture.session.injectBundle(contextId)
    ]);
    assert.equal(await fixture.page.evaluate(() => window.__fixtureBundleCount), 1);
    assert.equal(fixture.session.stats.bundles, 2);
  } finally { await closeFixture(fixture); }
});

test('closing after a real Runtime exception prevents fallback and retry execution', async () => {
  const fixture = await openFixture({ strategy: 'hybrid', retries: 3 });
  try {
    const contextId = fixture.session.getTopContextId();
    const evaluate = fixture.session.evaluateOrThrow.bind(fixture.session);
    const script = fixture.session.injectViaScriptElement.bind(fixture.session);
    let runtimeAttempts = 0;
    let scriptAttempts = 0;
    fixture.session.evaluateOrThrow = async (...args) => {
      runtimeAttempts += 1;
      try { return await evaluate(...args); }
      catch (error) {
        fixture.session.close();
        throw error;
      }
    };
    fixture.session.injectViaScriptElement = (...args) => {
      scriptAttempts += 1;
      return script(...args);
    };
    await assert.rejects(fixture.session.injectSource(contextId, `
      window.__beforeCloseAttempt = (window.__beforeCloseAttempt || 0) + 1;
      throw new Error('fixture close boundary');
    `, 'close boundary fixture'));
    assert.equal(runtimeAttempts, 1);
    assert.equal(scriptAttempts, 0);
    assert.equal(await fixture.page.evaluate(() => window.__beforeCloseAttempt), 1);
  } finally { await closeFixture(fixture); }
});

test('closing the real Chromium page closes its host session and cancels timers', async () => {
  const fixture = await openFixture({ strategy: 'runtime' });
  try {
    fixture.session.scheduleRescan();
    fixture.session.scheduleTopFrameEnsure();
    await fixture.page.close();
    await waitFor(() => fixture.session.closed, 'the disconnected session to close');
    assert.equal(fixture.session.connection.closed, true);
    assert.equal(fixture.session.rescanTimer, null);
    assert.equal(fixture.session.topEnsureTimer, null);
    assert.ok(fixture.logs.some((message) => /调试连接已断开/.test(message)));
  } finally { await closeFixture(fixture); }
});

test('reconnecting to an existing document restores a missing bundle without another ready message', async () => {
  const fixture = await openFixture({ strategy: 'runtime' });
  let reconnected;
  try {
    await fixture.page.evaluate(() => { delete window.__CX_WIN_BUNDLE_LOADED__; });
    // Runtime.enable replays buffered console entries; discard the original ready to test recovery itself.
    await fixture.session.connection.send('Runtime.discardConsoleEntries');
    fixture.session.connection.socket.close(1000, 'fixture reconnect');
    await waitFor(() => fixture.session.closed, 'the original disconnected session to close');
    assert.equal(fixture.page.isClosed(), false);
    assert.equal(await fixture.page.evaluate(() => window.__CX_WIN_HOST__.fixture), true);

    reconnected = new PageSession({
      port: browserPort,
      target: fixture.session.target,
      assets: fixture.session.assets,
      configStore: fixture.session.configStore,
      instanceToken: `browser-reconnect-${sequence}`,
      injectBlankFrames: true,
      captureConsole: true,
      injectStrategy: 'runtime',
      injectRetries: 0,
      logger: fixture.session.logger
    });
    await reconnected.open();
    await fixture.page.waitForFunction(() => window.__CX_WIN_BUNDLE_LOADED__ === true, { timeout: 4000 });
    await waitFor(() => reconnected.stats.bundles === 1, 'the recovered bundle acknowledgement');
    assert.equal(await fixture.page.evaluate(() => window.__fixtureBundleCount), 2);
    assert.equal(await fixture.page.evaluate(() => window.__fixtureReadyCount), 1);
    assert.equal(reconnected.readyContexts.size, 0);
    assert.equal(reconnected.stats.errors.length, 0);
  } finally {
    reconnected?.close();
    await closeFixture(fixture);
  }
});

test('the initial top-frame fallback respects the non-Chaoxing bundle restriction', async () => {
  const fixture = await openFixture({ strategy: 'runtime', hostname: '127.0.0.1', expectBundle: false });
  try {
    await waitFor(
      () => fixture.logs.some((message) => /顶层 frame 缺少业务 bundle/.test(message)),
      'the initial top-frame fallback', 4000
    );
    assert.equal(fixture.session.shouldInjectBundle(fixture.session.getTopContextId()), false);
    assert.equal(await fixture.page.evaluate(() => window.__CX_WIN_BUNDLE_LOADED__), undefined);
    assert.equal(await fixture.page.evaluate(() => window.__fixtureBundleCount), undefined);
    assert.equal(fixture.session.stats.bundles, 0);
    assert.equal(fixture.session.stats.errors.length, 0);
  } finally { await closeFixture(fixture); }
});

test('the initial top-frame fallback does not repeat the existing login-document bundle', async () => {
  const fixture = await openFixture({ strategy: 'runtime', pathname: '/login' });
  try {
    await waitFor(
      () => fixture.logs.some((message) => /顶层 frame 兜底检查通过/.test(message)),
      'the login-document top-frame check', 4000
    );
    assert.equal(fixture.session.shouldInjectBundle(fixture.session.getTopContextId()), true);
    assert.equal(await fixture.page.evaluate(() => window.__fixtureBundleCount), 1);
    assert.equal(fixture.session.stats.bundles, 1);
    assert.equal(fixture.session.stats.errors.length, 0);
  } finally { await closeFixture(fixture); }
});

test('reconnecting the real bootstrap in the same instance hydrates the new configuration into its existing bridge', async () => {
  let snapshot = {
    'common.settings.extension-enabled': true,
    'common.settings.windows-panel-enabled': false,
    'common.settings.windows-no-disk-write': true,
    'common.settings.theme': 'initial'
  };
  const configStore = { isEnabled: () => true, settingsSnapshot: () => snapshot };
  const assets = {
    ...fixtureAssets(),
    bootstrap: await readFile(resolve('windows/share-file/windows-bootstrap.js'), 'utf8')
  };
  const fixture = await openFixture({ strategy: 'runtime', assets, configStore });
  let reconnected;
  try {
    assert.equal(await fixture.page.evaluate(() => window.__CX_WIN_HOST__.getConfig()['common.settings.theme']), 'initial');
    await fixture.page.evaluate(() => {
      window.__fixtureOriginalHost = window.__CX_WIN_HOST__;
      window.__fixtureOriginalConfigBridge = window.__CX_WIN_ON_CONFIG__;
      window.__fixtureHydrationEvents = 0;
      document.addEventListener('chaoxing-plus:shared-store-hydrate', () => { window.__fixtureHydrationEvents += 1; });
    });
    snapshot = { ...snapshot, 'common.settings.theme': 'broadcast' };
    await fixture.session.broadcastConfig();
    assert.deepEqual(await fixture.page.evaluate(() => ({
      attribute: document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-theme'),
      config: window.__CX_WIN_HOST__.getConfig()['common.settings.theme'],
      hydrationEvents: window.__fixtureHydrationEvents
    })), {
      attribute: '"broadcast"',
      config: 'broadcast',
      hydrationEvents: 1
    });
    await fixture.session.connection.send('Runtime.discardConsoleEntries');
    fixture.session.connection.socket.close(1000, 'real bootstrap reconnect');
    await waitFor(() => fixture.session.closed, 'the original real-bootstrap session to disconnect');
    snapshot = { ...snapshot, 'common.settings.theme': 'reconnected' };
    reconnected = new PageSession({
      port: browserPort,
      target: fixture.session.target,
      assets,
      configStore,
      instanceToken: fixture.session.instanceToken,
      injectBlankFrames: true,
      captureConsole: true,
      injectStrategy: 'runtime',
      injectRetries: 0,
      logger: fixture.session.logger
    });
    await reconnected.open();
    await waitFor(() => reconnected.stats.bootstraps === 1, 'the reconnected real bootstrap acknowledgement');
    assert.deepEqual(await fixture.page.evaluate(() => ({
      attribute: document.documentElement.getAttribute('data-chaoxing-plus-shared-common-settings-theme'),
      config: window.__CX_WIN_HOST__.getConfig()['common.settings.theme'],
      hostReused: window.__fixtureOriginalHost === window.__CX_WIN_HOST__,
      bridgeReused: window.__fixtureOriginalConfigBridge === window.__CX_WIN_ON_CONFIG__,
      hydrationEvents: window.__fixtureHydrationEvents,
      bundleCount: window.__fixtureBundleCount,
      panelCount: document.querySelectorAll('#panel-common-work-results').length
    })), {
      attribute: '"reconnected"',
      config: 'reconnected',
      hostReused: true,
      bridgeReused: true,
      hydrationEvents: 2,
      bundleCount: 1,
      panelCount: 0
    });
    assert.equal(reconnected.readyContexts.size, 0);
    assert.equal(reconnected.stats.errors.length, 0);
  } finally {
    reconnected?.close();
    await closeFixture(fixture);
  }
});

test('real bootstrap receives bounded memory history, replays it after navigation and adopts a reconnected host', async () => {
  const diagnostics = createHostDiagnostics();
  for (const code of ['host-started', 'client-started', 'endpoint-waiting', 'endpoint-ready']) diagnostics.record(code);
  const assets = { ...fixtureAssets(), bootstrap: await readFile(resolve('windows/share-file/windows-bootstrap.js'), 'utf8') };
  const configStore = { isEnabled: () => true, settingsSnapshot: () => ({ 'common.settings.windows-no-disk-write': true }) };
  const fixture = await openFixture({ strategy: 'runtime', assets, configStore, diagnostics, pathname: `/exam-ans/diagnostics-${++sequence}` });
  let reconnected;
  try {
    assert.equal(await fixture.session.broadcastDiagnostics(), true);
    const initial = await fixture.page.evaluate(() => window.__CX_WIN_HOST__.getDiagnostics());
    assert.deepEqual(initial, diagnostics.snapshot());
    assert.ok(initial.some((entry) => entry.code === 'endpoint-waiting'));
    await fixture.page.goto(`http://a.chaoxing.com:${port}/exam-ans/diagnostics-next-${++sequence}`);
    await fixture.page.waitForFunction(() => window.__CX_WIN_BUNDLE_LOADED__ === true);
    await waitFor(() => fixture.session.stats.bundles === 2, 'navigated diagnostic bundle acknowledgement');
    assert.equal(await fixture.session.broadcastDiagnostics(), true);
    assert.deepEqual(await fixture.page.evaluate(() => window.__CX_WIN_HOST__.getDiagnostics()), diagnostics.snapshot());
    await fixture.page.evaluate(() => { window.__previousDiagnosticsHost = window.__CX_WIN_HOST__; });
    await fixture.session.connection.send('Runtime.discardConsoleEntries');
    fixture.session.connection.socket.close(1000, 'diagnostics reconnect fixture');
    await waitFor(() => fixture.session.closed, 'diagnostics original session close');
    const instanceToken = `diagnostics-reconnected-${++sequence}`;
    reconnected = new PageSession({
      port: browserPort, target: fixture.session.target, assets, configStore, instanceToken,
      injectBlankFrames: true, captureConsole: false, injectStrategy: 'runtime', injectRetries: 0,
      logger: fixture.session.logger, diagnostics
    });
    await reconnected.open();
    await waitFor(() => reconnected.stats.bootstraps === 1, 'reconnected diagnostic bootstrap');
    for (let index = 0; index < 120; index++) diagnostics.record(index % 2 ? 'config-updated' : 'top-navigated');
    assert.equal(await reconnected.broadcastDiagnostics(), true);
    assert.deepEqual(await fixture.page.evaluate(() => ({
      reused: window.__previousDiagnosticsHost === window.__CX_WIN_HOST__,
      instance: window.__CX_WIN_HOST__.instance,
      entries: window.__CX_WIN_HOST__.getDiagnostics()
    })), { reused: true, instance: instanceToken, entries: diagnostics.snapshot() });
    assert.equal(diagnostics.snapshot().length, 100);
  } finally {
    reconnected?.close();
    await closeFixture(fixture);
  }
});

test('real bootstrap with a hidden panel receives no memory history despite successful injections', async () => {
  const diagnostics = createHostDiagnostics();
  diagnostics.record('host-started');
  const fixture = await openFixture({
    strategy: 'runtime', diagnostics,
    assets: { ...fixtureAssets(), bootstrap: await readFile(resolve('windows/share-file/windows-bootstrap.js'), 'utf8') },
    configStore: { isEnabled: () => true, settingsSnapshot: () => ({
      'common.settings.windows-panel-enabled': false, 'common.settings.windows-no-disk-write': true
    }) }
  });
  try {
    assert.equal(await fixture.session.broadcastDiagnostics(), false);
    assert.deepEqual(await fixture.page.evaluate(() => window.__CX_WIN_HOST__.getDiagnostics()), []);
    assert.ok(diagnostics.snapshot().some((entry) => entry.code === 'bundle-ready'));
    assert.equal(await fixture.page.evaluate(() => document.querySelectorAll('#panel-common-work-results').length), 0);
  } finally { await closeFixture(fixture); }
});

test('production Node attach exposes memory diagnostics with quiet no-disk-write and no generated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cx-node-memory-diagnostics-'));
  const assetsDir = join(directory, 'assets');
  const page = await browser.newPage();
  let child;
  try {
    await mkdir(join(assetsDir, 'vendor'), { recursive: true });
    const assets = { ...fixtureAssets(), bootstrap: await readFile(resolve('windows/share-file/windows-bootstrap.js'), 'utf8') };
    await Promise.all([
      writeFile(join(assetsDir, 'windows-bootstrap.js'), assets.bootstrap),
      writeFile(join(assetsDir, 'chaoxing-plus.windows.js'), assets.bundle),
      writeFile(join(assetsDir, 'trampoline.js'), assets.trampoline),
      writeFile(join(assetsDir, 'vendor', 'sweetalert2.min.css'), ''),
      writeFile(join(assetsDir, 'package-manifest.json'), '{"version":"6.2.0"}')
    ]);
    await page.goto(`http://a.chaoxing.com:${port}/exam-ans/production-diagnostics-${++sequence}?private-token=fixture`);
    child = spawn(process.execPath, [resolve('windows/host/main.mjs'),
      '--attach', String(browserPort), '--assets', assetsDir, '--config', join(directory, 'config.json'),
      '--data-dir', join(directory, 'data'), '--report', join(directory, 'report.json'),
      '--duration', '3000', '--no-disk-write', '--quiet'
    ], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const finished = new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', (code, signal) => done({ code, signal }));
    });
    await page.waitForFunction(() => window.__CX_WIN_HOST__ && window.__CX_WIN_HOST__.getDiagnostics()
      .some((entry) => entry.code === 'session-connected'), { timeout: 7000 });
    const entries = await page.evaluate(() => window.__CX_WIN_HOST__.getDiagnostics());
    for (const code of ['host-started', 'endpoint-waiting', 'endpoint-ready', 'session-connected', 'bootstrap-ready', 'bundle-ready']) {
      assert.ok(entries.some((entry) => entry.code === code), code);
    }
    assert.equal(entries.some((entry) => entry.code === 'client-started'), false, 'attach must not claim to launch a client');
    assert.doesNotMatch(JSON.stringify(entries), /private-token|fixture|exam-ans|assets|config\.json/u);
    let exitDeadline;
    const result = await Promise.race([finished, new Promise((_, fail) => {
      exitDeadline = setTimeout(() => fail(new Error('Node diagnostics fixture did not stop')), 10000);
    })]).finally(() => clearTimeout(exitDeadline));
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stdout + stderr, '');
    assert.deepEqual(await readdir(directory), ['assets']);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await page.close();
    await rm(directory, { recursive: true, force: true });
  }
});

