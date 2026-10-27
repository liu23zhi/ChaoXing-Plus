import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const executable = process.env.CX_NATIVE_HOST_EXE;
const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
const puppeteer = browserRequire('puppeteer');
let browser, server, directory, assets, port, browserPort;
let serial = 0;

before(async () => {
  if (!executable) return;
  directory = await mkdtemp(join(tmpdir(), 'cx-native-lifecycle-'));
  assets = join(directory, 'assets');
  await mkdir(join(assets, 'vendor'), { recursive: true });
  const bootstrap = await readFile('dist-windows/windows-bootstrap.js', 'utf8');
  await writeFile(join(assets, 'windows-bootstrap.js'), 'window.__nativeBootstrapRuns=(window.__nativeBootstrapRuns||0)+1;\n' + bootstrap);
  await writeFile(join(assets, 'chaoxing-plus.windows.js'), 'window.__nativeBundleRuns=(window.__nativeBundleRuns||0)+1;window.__nativeBundleMethod=document.currentScript?"script":"runtime";');
  for (const name of ['trampoline.js', 'vendor/sweetalert2.min.css']) {
    await writeFile(join(assets, name), await readFile(join('dist-windows', name)));
  }
  server = createServer((request, response) => {
    if (request.url.startsWith('/csp/')) response.setHeader('Content-Security-Policy', "script-src 'none'");
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><title>Native lifecycle fixture</title></head><body>Local fixture</body></html>');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  port = server.address().port;
  browser = await puppeteer.launch({
    headless: true, executablePath: process.env.CX_BROWSER_EXECUTABLE,
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP a.chaoxing.com 127.0.0.1']
  });
  browserPort = Number(new URL(browser.wsEndpoint()).port);
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(strategy = 'runtime', csp = false, extra = []) {
  const page = await browser.newPage();
  const url = `http://a.chaoxing.com:${port}/${csp ? 'csp' : 'exam-ans'}/${++serial}`;
  await page.goto(url);
  const child = spawn(executable, [
    '--attach', String(browserPort), '--duration', '10000', '--scan-mode', 'common', '--client-index', '2147483647',
    '--assets', assets, '--inject-strategy', strategy, '--inject-retries', '0', '--no-disk-write', '--no-panel',
    '--target-poll-interval', '250', ...extra
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.on('data', (bytes) => { output += bytes; });
  const closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
  const error = new Promise((_, reject) => child.once('error', reject));
  const wait = async (target = page) => {
    try { await Promise.race([
      target.waitForFunction(() => window.__nativeBundleRuns === 1, { timeout: 6000 }),
      closed.then((result) => { throw new Error(`native exited before injection: ${JSON.stringify(result)} ${output}`); }),
      error
    ]); } catch (error) {
      const state = await target.evaluate(() => ({ host: !!window.__CX_WIN_HOST__, bundle: window.__nativeBundleRuns, bootstrap: window.__nativeBootstrapRuns })).catch(() => null);
      throw new Error(`${error.message}; page=${JSON.stringify(state)}; native=${output}`, { cause: error });
    }
  };
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    if (!page.isClosed()) await page.close();
  };
  return { page, child, wait, close, closed, output: () => output };
}

for (const [strategy, method] of [['runtime', 'runtime'], ['script', 'script'], ['hybrid', 'runtime']]) {
  test(`compiled native ${strategy} injects through its real WebSocket adapter`, { skip: !executable }, async () => {
    const value = await fixture(strategy);
    try {
      await value.wait();
      assert.equal(await value.page.evaluate(() => window.__nativeBundleMethod), method);
    } finally { await value.close(); }
  });
}

test('compiled native host follows navigation and injects each new document once', { skip: !executable }, async () => {
  const value = await fixture();
  try {
    await value.wait();
    await value.page.goto(`http://a.chaoxing.com:${port}/exam-ans/navigation-${++serial}`);
    await value.wait();
    assert.equal(await value.page.evaluate(() => window.__nativeBundleRuns), 1);
  } finally { await value.close(); }
});

test('compiled native host handles late blank iframes and new page targets', { skip: !executable }, async () => {
  const value = await fixture();
  let popup;
  try {
    await value.wait();
    await value.page.evaluate(() => document.body.appendChild(document.createElement('iframe')));
    await value.page.waitForFunction(() => document.querySelector('iframe').contentWindow.__nativeBundleRuns === 1, { timeout: 6000 });
    popup = await browser.newPage();
    await popup.goto(`http://a.chaoxing.com:${port}/exam-ans/popup-${++serial}`);
    await value.wait(popup);
    await value.page.$eval('iframe', (frame) => frame.remove());
    assert.equal(await value.page.evaluate(() => window.__nativeBundleRuns), 1);
  } finally {
    if (popup) await popup.close();
    await value.close();
  }
});

test('compiled native script falls back to Runtime on a CSP page', { skip: !executable }, async () => {
  const value = await fixture('script', true);
  try {
    await value.wait();
    assert.equal(await value.page.evaluate(() => window.__nativeBundleMethod), 'runtime');
  } finally { await value.close(); }
});

test('compiled native duration closes its session without terminating an attached browser', { skip: !executable }, async () => {
  const value = await fixture('runtime', false, ['--duration', '1500']);
  try {
    await value.wait();
    const result = await value.closed;
    assert.equal(result.code, 0, value.output());
    assert.equal(browser.connected, true);
    await value.page.goto(`http://a.chaoxing.com:${port}/exam-ans/after-close-${++serial}`);
    assert.equal(await value.page.evaluate(() => window.__nativeBundleRuns), undefined);
  } finally { await value.close(); }
});

test('compiled native blank-frame option keeps the top page enabled', { skip: !executable }, async () => {
  const value = await fixture('runtime', false, ['--no-inject-blank-frames']);
  try {
    await value.wait();
    await value.page.evaluate(() => document.body.appendChild(document.createElement('iframe')));
    await value.page.waitForFunction(() => !!document.querySelector('iframe').contentWindow.__CX_WIN_HOST__);
    assert.equal(await value.page.evaluate(() => document.querySelector('iframe').contentWindow.__nativeBundleRuns), undefined);
    assert.equal(await value.page.evaluate(() => window.__nativeBundleRuns), 1);
  } finally { await value.close(); }
});

test('compiled native watches an unrelated page without injecting business until eligible navigation', { skip: !executable }, async () => {
  const value = await fixture();
  try {
    await value.wait();
    await value.page.goto(`http://127.0.0.1:${port}/unrelated-${++serial}`);
    await value.page.waitForFunction(() => !!window.__CX_WIN_HOST__);
    assert.equal(await value.page.evaluate(() => window.__nativeBundleRuns), undefined);
    await value.page.goto(`http://a.chaoxing.com:${port}/exam-ans/eligible-${++serial}`);
    await value.wait();
  } finally { await value.close(); }
});

test('compiled native rejects an unexpected Browser before bootstrap', { skip: !executable }, async () => {
  const value = await fixture('runtime', false, ['--expected-browser', 'NotTheFixtureBrowser/']);
  try {
    assert.equal((await value.closed).code, 1);
    assert.match(value.output(), /Browser does not match/);
    assert.equal(await value.page.evaluate(() => window.__CX_WIN_HOST__), undefined);
  } finally { await value.close(); }
});

async function cdpProxy() {
  const connections = new Set();
  let proxyPort;
  const track = (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  };
  const proxy = createServer(async (request, response) => {
    try {
      const upstream = await fetch(`http://127.0.0.1:${browserPort}${request.url}`);
      const body = (await upstream.text()).replaceAll(`127.0.0.1:${browserPort}`, `127.0.0.1:${proxyPort}`);
      response.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' });
      response.end(body);
    } catch { response.writeHead(502); response.end(); }
  });
  proxy.on('upgrade', (request, downstream, head) => {
    track(downstream);
    const upstream = track(createConnection({ host: '127.0.0.1', port: browserPort }));
    downstream.on('close', () => upstream.destroy());
    upstream.on('close', () => downstream.destroy());
    upstream.once('connect', () => {
      const headers = request.rawHeaders.reduce((text, value, index) => text + value + (index % 2 ? '\r\n' : ': '), '');
      upstream.write(`GET ${request.url} HTTP/1.1\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(downstream).pipe(upstream);
    });
  });
  await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
  proxyPort = proxy.address().port;
  return {
    port: proxyPort,
    disconnect: () => { for (const socket of connections) socket.destroy(); },
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise((done) => proxy.close(done));
    }
  };
}

test('compiled native reconnects a dropped CDP socket without repeating business execution', { skip: !executable }, async () => {
  const proxy = await cdpProxy();
  let value;
  try {
    value = await fixture('runtime', false, ['--attach', String(proxy.port)]);
    await value.wait();
    const bootstraps = await value.page.evaluate(() => window.__nativeBootstrapRuns);
    proxy.disconnect();
    await value.page.waitForFunction((before) => window.__nativeBootstrapRuns > before, { timeout: 6000 }, bootstraps);
    assert.equal(await value.page.evaluate(() => window.__nativeBundleRuns), 1);
    await value.page.goto(`http://a.chaoxing.com:${port}/exam-ans/reconnected-${++serial}`);
    await value.wait();
  } finally {
    if (value) await value.close();
    await proxy.close();
  }
});

test('compiled native reconnect restores iframe readiness after console history is cleared', { skip: !executable }, async () => {
  const proxy = await cdpProxy();
  let value;
  try {
    value = await fixture('runtime', false, ['--attach', String(proxy.port)]);
    await value.wait();
    await value.page.evaluate(() => document.body.appendChild(document.createElement('iframe')));
    await value.page.waitForFunction(() => document.querySelector('iframe').contentWindow.__nativeBundleRuns === 1);
    // Model disconnect between a completed bootstrap and business execution.
    await value.page.evaluate(() => {
      const frame = document.querySelector('iframe').contentWindow;
      delete frame.__CX_WIN_BUNDLE_LOADED__;
      delete frame.__nativeBundleRuns;
    });
    const protocol = await value.page.createCDPSession();
    await protocol.send('Runtime.discardConsoleEntries');
    await protocol.detach();
    proxy.disconnect();
    await value.page.waitForFunction(() => document.querySelector('iframe').contentWindow.__nativeBundleRuns === 1, { timeout: 6000 });
    assert.equal(await value.page.evaluate(() => window.__nativeBundleRuns), 1);
  } finally {
    if (value) await value.close();
    await proxy.close();
  }
});
