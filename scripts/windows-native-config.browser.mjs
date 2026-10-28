import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.env.CX_NATIVE_HOST_EXE;
const enabledKey = 'common.settings.extension-enabled';
const noDiskKey = 'common.settings.windows-no-disk-write';
const modeKey = 'common.settings.windows-answer-mode';
const widthKey = 'common.settings.windows-panel-width';
const countdownKey = 'common.settings.windows-answer-countdown';
const markerKey = 'common.settings.native-config-fixture';
const retainedKey = 'cx.new.work.native-config-retained';
const excludedKeys = ['common.work-results.results', 'answerCache.fixture', 'other.private'];
const sockets = new Set();
let browser, server, directory, assets, port, browserPort, syncEvent;
let serial = 0;

async function assertPortClosed(value) {
  if (!value) return;
  await new Promise((done, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: value });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`test-owned listener ${value} is still open`));
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') done();
      else reject(error);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error(`could not verify closure of test-owned listener ${value}`));
    });
  });
}

before(async () => {
  if (!executable) return;
  const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
  const puppeteer = browserRequire('puppeteer');
  directory = await mkdtemp(join(tmpdir(), 'cx-native-config-'));
  assets = join(directory, 'assets');
  await mkdir(join(assets, 'vendor'), { recursive: true });
  const bootstrap = await readFile('windows/bootstrap/windows-bootstrap.js', 'utf8');
  syncEvent = /var SYNC_EVENT = '([^']+)'/u.exec(bootstrap)?.[1];
  assert.ok(syncEvent, 'the test must use the actual bootstrap sync event');
  await writeFile(join(assets, 'windows-bootstrap.js'),
    'window.__nativeConfigBootstrapRuns=(window.__nativeConfigBootstrapRuns||0)+1;\n' + bootstrap);
  await writeFile(join(assets, 'chaoxing-plus.windows.js'),
    'window.__nativeConfigBundleRuns=(window.__nativeConfigBundleRuns||0)+1;');
  await writeFile(join(assets, 'trampoline.js'), await readFile('windows/host/trampoline.js'));
  await writeFile(join(assets, 'vendor/sweetalert2.min.css'), await readFile('dist-windows/vendor/sweetalert2.min.css'));
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><title>Native config fixture</title></head><body>Local configuration fixture</body></html>');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  port = server.address().port;
  browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP a.chaoxing.com 127.0.0.1, MAP b.chaoxing.com 127.0.0.1']
  });
  browserPort = Number(new URL(browser.wsEndpoint()).port);
});

after(async () => {
  try { await browser?.close(); }
  finally {
    try {
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
      await assertPortClosed(port);
      await assertPortClosed(browserPort);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
});

function fixtureConfig(marker = 'initial') {
  return {
    expectedBrowser: 'Chrome/',
    captureConsole: false,
    debugEndpointTimeoutMs: 45000,
    answerMode: 'auto',
    settings: {
      [enabledKey]: true,
      [markerKey]: marker,
      [retainedKey]: { keep: 'unrelated shared setting' },
      [widthKey]: 320,
      [countdownKey]: 8
    }
  };
}

function launchHost(caseDir, configPath, { defaultConfig = false, extra = [], proxy } = {}) {
  const child = spawn(join(caseDir, 'chaoxing_plus.exe'), [
    '--attach', String(proxy?.port ?? browserPort), '--duration', '30000', '--scan-mode', 'common',
    '--client-index', '2147483647', '--assets', assets, '--inject-strategy', 'runtime',
    '--inject-retries', '0', '--target-poll-interval', '250', '--no-panel', '--no-log',
    '--data-dir', join(caseDir, 'data'), ...(defaultConfig ? [] : ['--config', configPath]), ...extra
  ], { cwd: caseDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.on('data', (bytes) => { output += bytes; });
  const closed = new Promise((done, reject) => {
    child.once('close', (code, signal) => done({ code, signal }));
    child.once('error', reject);
  });
  // Register immediately so a failed spawn cannot leave an unhandled rejection.
  closed.catch(() => {});
  const waitFor = async (operation) => {
    try {
      return await Promise.race([
        operation,
        closed.then((result) => { throw new Error(`native exited during config regression: ${JSON.stringify(result)}; ${output}`); })
      ]);
    } catch (error) {
      throw new Error(`${error.message}; native=${output}`, { cause: error });
    }
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  };
  return { child, closed, stop, waitFor, output: () => output };
}

async function fixture({ config = fixtureConfig(), defaultConfig = false, extra = [], proxy } = {}) {
  const caseDir = join(directory, `case-${++serial}`);
  await mkdir(caseDir);
  await copyFile(executable, join(caseDir, 'chaoxing_plus.exe'));
  const configPath = join(caseDir, defaultConfig ? 'chaoxing-plus.json' : 'selected-config.json');
  if (config !== undefined) await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(`http://a.chaoxing.com:${port}/exam-ans/config-${serial}`);
  const host = launchHost(caseDir, configPath, { defaultConfig, extra, proxy });
  const close = async () => {
    try { await host.stop(); }
    finally { await context.close(); }
  };
  return { caseDir, configPath, context, page, ...host, close };
}

async function waitConfig(value, target, expected, { disk = true, bundle = true, timeout = 6000 } = {}) {
  try {
    await value.waitFor(target.waitForFunction((entries, checkDisk, checkBundle) => {
      if (!window.__CX_WIN_HOST__ || (checkBundle && window.__nativeConfigBundleRuns !== 1)) return false;
      const config = window.__CX_WIN_HOST__.getConfig();
      return entries.every(([key, setting]) => {
        const serialized = JSON.stringify(setting);
        const attribute = 'data-chaoxing-plus-shared-' + key.replace(/[^a-z0-9_-]/gi, '-');
        if (JSON.stringify(config[key]) !== serialized || document.documentElement.getAttribute(attribute) !== serialized) return false;
        return !checkDisk || localStorage.getItem(key) === serialized;
      });
    }, { timeout, polling: 50 }, Object.entries(expected), disk, bundle));
  } catch (error) {
    const observed = await target.evaluate((keys) => ({
      config: Object.fromEntries(Object.entries(window.__CX_WIN_HOST__?.getConfig() || {}).map(([key, value]) =>
        [key, typeof value === 'string' && value.length > 256 ? `[string length=${value.length}]` : value])),
      bundleRuns: window.__nativeConfigBundleRuns,
      values: keys.map((key) => ({ key,
        attribute: String(document.documentElement.getAttribute('data-chaoxing-plus-shared-' + key.replace(/[^a-z0-9_-]/gi, '-'))).slice(0, 256),
        storage: String(localStorage.getItem(key)).slice(0, 256)
      }))
    }), Object.keys(expected)).catch(() => undefined);
    throw new Error(`${error.message}; observed=${JSON.stringify(observed)}`, { cause: error });
  }
}

async function sync(target, detail) {
  await target.evaluate((eventName, values) => document.dispatchEvent(new CustomEvent(eventName, { detail: values })), syncEvent, detail);
}

async function waitFile(path, predicate, timeout = 4000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try {
      last = JSON.parse(await readFile(path, 'utf8'));
      if (predicate(last)) return last;
    } catch (error) { if (error.code && error.code !== 'ENOENT') throw error; }
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`configuration file did not reach expected state: ${JSON.stringify(last)}`);
}

async function addFrame(value, origin = 'b.chaoxing.com') {
  const frameUrl = `http://${origin}:${port}/exam-ans/frame-${++serial}`;
  await value.page.evaluate((url) => {
    const frame = document.createElement('iframe');
    frame.src = url;
    document.body.appendChild(frame);
  }, frameUrl);
  await value.page.waitForFunction((url) => [...document.querySelectorAll('iframe')].some((frame) => frame.src === url), {}, frameUrl);
  const deadline = Date.now() + 6000;
  do {
    const frame = value.page.frames().find((candidate) => candidate.url() === frameUrl);
    if (frame) return frame;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail('new configuration iframe did not navigate');
}

async function assertAbsent(target, keys) {
  assert.deepEqual(await target.evaluate((names) => names.filter((key) =>
    Object.hasOwn(window.__CX_WIN_HOST__.getConfig(), key) ||
    document.documentElement.hasAttribute('data-chaoxing-plus-shared-' + key.replace(/[^a-z0-9_-]/gi, '-')) ||
    localStorage.getItem(key) !== null), keys), []);
}

async function waitAbsent(value, target, key, storage = null) {
  await value.waitFor(target.waitForFunction((name, expectedStorage) => {
    const config = window.__CX_WIN_HOST__?.getConfig();
    return config && !Object.hasOwn(config, name) &&
      !document.documentElement.hasAttribute('data-chaoxing-plus-shared-' + name.replace(/[^a-z0-9_-]/gi, '-')) &&
      localStorage.getItem(name) === expectedStorage;
  }, { timeout: 2500, polling: 50 }, key, storage));
}

test('compiled native page config sync persists shared values, preserves the file and enforces inline/CLI precedence', { skip: !executable }, async () => {
  const value = await fixture({ extra: ['--options-json', JSON.stringify({ answerMode: 'auto', panelWidth: 370 }), '--answer-mode', 'manual'] });
  try {
    const pinned = { [modeKey]: 'manual', [widthKey]: 370 };
    await waitConfig(value, value.page, { [markerKey]: 'initial', ...pinned });
    const frame = await addFrame(value);
    await waitConfig(value, frame, { [markerKey]: 'initial', ...pinned });
    await sync(frame, {
      [markerKey]: 'from-page', [countdownKey]: 13, [modeKey]: 'auto', [widthKey]: 490,
      ...Object.fromEntries(excludedKeys.map((key) => [key, 'must not persist']))
    });
    for (const target of [value.page, frame]) {
      await waitConfig(value, target, { [markerKey]: 'from-page', [countdownKey]: 13, ...pinned });
      await assertAbsent(target, excludedKeys);
    }
    const saved = await waitFile(value.configPath, (config) => config.settings?.[markerKey] === 'from-page');
    assert.equal(saved.expectedBrowser, 'Chrome/');
    assert.equal(saved.captureConsole, false);
    assert.equal(saved.debugEndpointTimeoutMs, 45000);
    assert.deepEqual(saved.settings[retainedKey], { keep: 'unrelated shared setting' });
    for (const key of excludedKeys) assert.equal(Object.hasOwn(saved.settings, key), false);
    // Bypass the page filter to verify the native control-message boundary too.
    await frame.evaluate((keys) => window.__CX_WIN_HOST__.send('config-sync', Object.fromEntries(keys.map((key) => [key, 'blocked']))), excludedKeys);
    await frame.evaluate((key) => {
      const instance = window.__CX_WIN_HOST__.instance;
      for (const identity of [
        { source: 'wrong-source', instance },
        { source: 'chaoxing-plus-windows', instance: 'wrong-instance' },
        {}
      ]) console.log('__CX_WIN_MSG__' + JSON.stringify({ kind: 'config-sync', detail: { [key]: 'forged-control-message' }, ...identity }));
    }, markerKey);
    await sync(frame, { [markerKey]: 'must-reject-whole-transaction', [countdownKey]: 'invalid-number' });
    await delay(1700);
    await waitConfig(value, value.page, { [markerKey]: 'from-page', [countdownKey]: 13, ...pinned });
    const afterRejected = JSON.parse(await readFile(value.configPath, 'utf8'));
    assert.equal(afterRejected.settings[markerKey], 'from-page');
    for (const key of excludedKeys) assert.equal(Object.hasOwn(afterRejected.settings, key), false);
    await assertAbsent(value.page, excludedKeys);
    await value.page.goto(`http://a.chaoxing.com:${port}/exam-ans/page-sync-navigation-${++serial}`);
    await waitConfig(value, value.page, { [markerKey]: 'from-page', [countdownKey]: 13, ...pinned });
    assert.equal(await value.page.evaluate(() => window.__nativeConfigBundleRuns), 1);
  } finally { await value.close(); }
});

test('compiled native replacement host takes over the existing document and configuration bridge without repeating business execution', { skip: !executable }, async () => {
  const value = await fixture();
  let replacement;
  try {
    await waitConfig(value, value.page, { [markerKey]: 'initial', [retainedKey]: { keep: 'unrelated shared setting' } });
    const previous = await value.page.evaluate(() => {
      window.__nativeConfigDocumentIdentity = 'same-document-after-host-replacement';
      return window.__CX_WIN_HOST__.instance;
    });
    assert.equal(typeof previous, 'string');
    assert.ok(previous.length > 0);
    await value.stop();
    const replacementConfigPath = join(value.caseDir, 'replacement-config.json');
    const config = fixtureConfig('replacement-host-snapshot');
    delete config.settings[retainedKey];
    await writeFile(replacementConfigPath, JSON.stringify(config));
    replacement = launchHost(value.caseDir, replacementConfigPath);
    await replacement.waitFor(value.page.waitForFunction((instance) =>
      typeof window.__CX_WIN_HOST__?.instance === 'string' && window.__CX_WIN_HOST__.instance !== instance,
    { timeout: 6000, polling: 50 }, previous));
    await waitConfig(replacement, value.page, { [markerKey]: 'replacement-host-snapshot' });
    await waitAbsent(replacement, value.page, retainedKey);
    await sync(value.page, { [markerKey]: 'replacement-host-page-sync' });
    await waitConfig(replacement, value.page, { [markerKey]: 'replacement-host-page-sync' });
    await waitFile(replacementConfigPath, (saved) => saved.settings?.[markerKey] === 'replacement-host-page-sync');
    assert.equal(await value.page.evaluate(() => window.__nativeConfigDocumentIdentity), 'same-document-after-host-replacement');
    assert.equal(await value.page.evaluate(() => window.__nativeConfigBundleRuns), 1);
  } finally {
    if (replacement) await replacement.stop();
    await value.close();
  }
});

async function cdpProxy() {
  const connections = new Set();
  let proxyPort;
  const track = (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  };
  const proxy = createServer(async (request, response) => {
    try {
      const upstream = await fetch(`http://127.0.0.1:${browserPort}${request.url}`, { signal: AbortSignal.timeout(3000) });
      const body = (await upstream.text()).replaceAll(`127.0.0.1:${browserPort}`, `127.0.0.1:${proxyPort}`);
      response.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' });
      response.end(body);
    } catch { response.writeHead(502); response.end(); }
  });
  proxy.on('connection', track);
  proxy.on('upgrade', (request, downstream, head) => {
    const upstream = track(createConnection({ host: '127.0.0.1', port: browserPort }));
    downstream.once('close', () => upstream.destroy());
    upstream.once('close', () => downstream.destroy());
    upstream.once('connect', () => {
      const headers = request.rawHeaders.reduce((text, item, index) => text + item + (index % 2 ? '\r\n' : ': '), '');
      upstream.write(`GET ${request.url} HTTP/1.1\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(downstream).pipe(upstream);
    });
  });
  await new Promise((done, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', done); });
  proxyPort = proxy.address().port;
  return {
    port: proxyPort,
    disconnect() { for (const socket of connections) socket.destroy(); },
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise((done, reject) => proxy.close((error) => error ? reject(error) : done()));
      await assertPortClosed(proxyPort);
    }
  };
}

test('compiled native selected-file hot reload reaches current/new documents and reconnect while rejecting invalid snapshots', { skip: !executable }, async () => {
  const proxy = await cdpProxy();
  let value;
  try {
    value = await fixture({ proxy, extra: ['--options-json', JSON.stringify({ panelWidth: 375 }), '--answer-mode', 'manual'] });
    await waitConfig(value, value.page, { [markerKey]: 'initial' });
    const frame = await addFrame(value);
    await waitConfig(value, frame, { [markerKey]: 'initial' });
    const changed = fixtureConfig('external-update');
    changed.answerMode = 'auto';
    changed.panelWidth = 480;
    changed.port = 1024;
    changed.settings[countdownKey] = 17;
    const expected = { [markerKey]: 'external-update', [countdownKey]: 17, [modeKey]: 'manual', [widthKey]: 375 };
    await writeFile(value.configPath, JSON.stringify(changed));
    for (const target of [value.page, frame]) await waitConfig(value, target, expected, { timeout: 1800 });
    await writeFile(value.configPath, '{ invalid JSON');
    await delay(1700);
    await waitConfig(value, value.page, expected);
    await writeFile(value.configPath, JSON.stringify({ ...changed, settings: { ...changed.settings, [markerKey]: 'invalid-typed', [countdownKey]: 'wrong' } }));
    await delay(1700);
    await waitConfig(value, value.page, expected);
    await writeFile(value.configPath, JSON.stringify({ ...changed, port: 1, settings: { ...changed.settings, [markerKey]: 'invalid-port' } }));
    await delay(1700);
    await waitConfig(value, value.page, expected);
    await rm(value.configPath);
    await delay(1700);
    for (const target of [value.page, frame]) await waitConfig(value, target, expected);
    changed.settings[markerKey] = 'restored-after-deletion';
    expected[markerKey] = 'restored-after-deletion';
    await writeFile(value.configPath, JSON.stringify(changed));
    for (const target of [value.page, frame]) await waitConfig(value, target, expected, { timeout: 1800 });
    const bootstrapRuns = await value.page.evaluate(() => window.__nativeConfigBootstrapRuns);
    const protocol = await value.page.createCDPSession();
    await protocol.send('Runtime.discardConsoleEntries');
    await protocol.detach();
    proxy.disconnect();
    await value.page.waitForFunction((before) => window.__nativeConfigBootstrapRuns > before, { timeout: 6000 }, bootstrapRuns);
    for (const target of [value.page, frame]) await waitConfig(value, target, expected);
    const newFrame = await addFrame(value, 'a.chaoxing.com');
    await waitConfig(value, newFrame, expected);
    const popup = await value.context.newPage();
    await popup.goto(`http://b.chaoxing.com:${port}/exam-ans/config-popup-${++serial}`);
    await waitConfig(value, popup, expected);
    await value.page.goto(`http://a.chaoxing.com:${port}/exam-ans/config-reload-navigation-${++serial}`);
    await waitConfig(value, value.page, expected);
    for (const target of [value.page, popup]) assert.equal(await target.evaluate(() => window.__nativeConfigBundleRuns), 1);
    // The bootstrap reloads top documents on an extension-enabled transition.
    changed.settings[enabledKey] = false;
    await writeFile(value.configPath, JSON.stringify(changed));
    await value.waitFor(value.page.waitForFunction((key) =>
      window.__CX_WIN_HOST__?.getConfig()[key] === false && window.__nativeConfigBundleRuns === undefined,
    { timeout: 6000, polling: 50 }, enabledKey));
    await waitConfig(value, value.page, { ...expected, [enabledKey]: false }, { bundle: false, timeout: 4000 });
    assert.equal(await value.page.evaluate(() => window.__nativeConfigBundleRuns), undefined);
    changed.settings[enabledKey] = true;
    await writeFile(value.configPath, JSON.stringify(changed));
    await waitConfig(value, value.page, { ...expected, [enabledKey]: true });
  } finally {
    if (value) await value.close();
    await proxy.close();
  }
});

test('compiled native default executable-side configuration persists page sync and accepts external changes', { skip: !executable }, async () => {
  const value = await fixture({ defaultConfig: true });
  try {
    await waitConfig(value, value.page, { [markerKey]: 'initial' });
    await sync(value.page, { [markerKey]: 'default-file-page' });
    await waitConfig(value, value.page, { [markerKey]: 'default-file-page' });
    const saved = await waitFile(value.configPath, (config) => config.settings?.[markerKey] === 'default-file-page');
    assert.equal(saved.debugEndpointTimeoutMs, 45000);
    saved.settings[markerKey] = 'default-file-external';
    await writeFile(value.configPath, JSON.stringify(saved));
    await waitConfig(value, value.page, { [markerKey]: 'default-file-external' }, { timeout: 1800 });
    const frame = await addFrame(value);
    await waitConfig(value, frame, { [markerKey]: 'default-file-external' });
    await rm(value.configPath);
    for (const target of [value.page, frame]) {
      await waitAbsent(value, target, markerKey);
      await waitAbsent(value, target, retainedKey);
    }
    const newFrame = await addFrame(value, 'a.chaoxing.com');
    await waitConfig(value, newFrame, { [enabledKey]: true });
    await waitAbsent(value, newFrame, markerKey);
    await waitAbsent(value, newFrame, retainedKey);
    saved.settings[markerKey] = 'default-file-restored';
    await writeFile(value.configPath, JSON.stringify(saved));
    for (const target of [value.page, frame, newFrame]) {
      await waitConfig(value, target, { [markerKey]: 'default-file-restored', [retainedKey]: { keep: 'unrelated shared setting' } }, { timeout: 1800 });
      assert.equal(await target.evaluate(() => window.__nativeConfigBundleRuns), 1);
    }
    assert.equal(await value.page.evaluate(() => window.__nativeConfigBundleRuns), 1);
  } finally { await value.close(); }
});

test('compiled native page sync preserves a large UTF-8 inline setting without growing merged snapshots', { skip: !executable }, async () => {
  const largeKey = 'common.settings.native-config-large-inline';
  const inlineValue = '\u914d'.repeat(12000);
  assert.ok(Buffer.byteLength(inlineValue, 'utf8') > 34 * 1024);
  const value = await fixture({ extra: ['--options-json', JSON.stringify({ settings: { [largeKey]: inlineValue } })] });
  try {
    await waitConfig(value, value.page, { [markerKey]: 'initial', [largeKey]: inlineValue });
    const frame = await addFrame(value);
    await waitConfig(value, frame, { [markerKey]: 'initial', [largeKey]: inlineValue });
    await sync(frame, { [markerKey]: 'small-change-with-large-inline', [largeKey]: 'page-cannot-override-inline' });
    for (const target of [value.page, frame]) {
      await waitConfig(value, target, { [markerKey]: 'small-change-with-large-inline', [largeKey]: inlineValue });
    }
    await waitFile(value.configPath, (config) => config.settings?.[markerKey] === 'small-change-with-large-inline');
    await sync(value.page, { [markerKey]: 'second-small-change-with-large-inline' });
    for (const target of [value.page, frame]) {
      await waitConfig(value, target, { [markerKey]: 'second-small-change-with-large-inline', [largeKey]: inlineValue });
    }
  } finally { await value.close(); }
});

for (const noDiskWrite of [false, true]) {
  test(`compiled native full file snapshots remove a shared key in ${noDiskWrite ? 'no-disk-write' : 'ordinary'} mode`, { skip: !executable }, async () => {
    const value = await fixture({ extra: noDiskWrite ? ['--no-disk-write'] : [] });
    try {
      await waitConfig(value, value.page, { [markerKey]: 'initial', [retainedKey]: { keep: 'unrelated shared setting' } }, { disk: !noDiskWrite });
      const frame = await addFrame(value);
      await waitConfig(value, frame, { [markerKey]: 'initial', [retainedKey]: { keep: 'unrelated shared setting' } }, { disk: !noDiskWrite });
      const sentinel = noDiskWrite ? 'pre-existing-local-storage-must-survive' : null;
      if (noDiskWrite) {
        for (const target of [value.page, frame]) {
          await target.evaluate((key, text) => localStorage.setItem(key, text), retainedKey, sentinel);
        }
      }
      const changed = fixtureConfig('key-removed-by-file');
      delete changed.settings[retainedKey];
      const externalText = JSON.stringify(changed);
      await writeFile(value.configPath, externalText);
      for (const target of [value.page, frame]) {
        await waitConfig(value, target, { [markerKey]: 'key-removed-by-file' }, { disk: !noDiskWrite, timeout: 1800 });
        await waitAbsent(value, target, retainedKey, sentinel);
        assert.equal(await target.evaluate(() => window.__nativeConfigBundleRuns), 1);
      }
      const newFrame = await addFrame(value);
      await waitConfig(value, newFrame, { [markerKey]: 'key-removed-by-file' }, { disk: !noDiskWrite });
      await waitAbsent(value, newFrame, retainedKey, sentinel);
      assert.equal(await readFile(value.configPath, 'utf8'), externalText);
    } finally { await value.close(); }
  });
}

async function tree(path) {
  const names = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    names.push(entry.name);
    if (entry.isDirectory()) for (const name of await tree(join(path, entry.name))) names.push(join(entry.name, name));
  }
  return names.sort();
}

test('compiled native no-disk-write locks the launch policy while still broadcasting page and file config updates', { skip: !executable }, async () => {
  const value = await fixture({ extra: ['--no-disk-write', '--report', 'forbidden-report.json'] });
  try {
    await waitConfig(value, value.page, { [markerKey]: 'initial', [noDiskKey]: true }, { disk: false });
    const frame = await addFrame(value);
    await waitConfig(value, frame, { [markerKey]: 'initial', [noDiskKey]: true }, { disk: false });
    const original = await readFile(value.configPath, 'utf8');
    const originalStat = await stat(value.configPath);
    const originalTree = await tree(value.caseDir);
    await sync(frame, { [markerKey]: 'no-disk-page', [noDiskKey]: false });
    for (const target of [value.page, frame]) await waitConfig(value, target, { [markerKey]: 'no-disk-page', [noDiskKey]: true }, { disk: false });
    await delay(1700);
    assert.equal(await readFile(value.configPath, 'utf8'), original);
    assert.equal((await stat(value.configPath)).mtimeMs, originalStat.mtimeMs);
    assert.deepEqual(await tree(value.caseDir), originalTree, 'no-disk-write must not create config temp files, data directories or reports');
    const changed = fixtureConfig('no-disk-external');
    changed.noDiskWrite = false;
    changed.log = true;
    changed.settings[noDiskKey] = false;
    const externalText = JSON.stringify(changed);
    await writeFile(value.configPath, externalText);
    for (const target of [value.page, frame]) await waitConfig(value, target, { [markerKey]: 'no-disk-external', [noDiskKey]: true }, { disk: false, timeout: 1800 });
    await sync(frame, { [markerKey]: 'still-no-disk-page', [noDiskKey]: false });
    await waitConfig(value, value.page, { [markerKey]: 'still-no-disk-page', [noDiskKey]: true }, { disk: false });
    await delay(1700);
    assert.equal(await readFile(value.configPath, 'utf8'), externalText);
    assert.deepEqual(await tree(value.caseDir), originalTree);
    for (const target of [value.page, frame]) {
      assert.equal(await target.evaluate((key) => localStorage.getItem(key), markerKey), null);
      assert.equal(await target.evaluate(() => window.__nativeConfigBundleRuns), 1);
    }
    await value.page.goto(`http://a.chaoxing.com:${port}/exam-ans/no-disk-navigation-${++serial}`);
    await waitConfig(value, value.page, { [markerKey]: 'still-no-disk-page', [noDiskKey]: true }, { disk: false });
    assert.equal(await value.page.evaluate((key) => localStorage.getItem(key), markerKey), null);
  } finally { await value.close(); }
});
