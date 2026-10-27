import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.env.CX_NATIVE_HOST_EXE;
const querySecret = 'native-diagnostics-query-private-70841';
const questionSecret = 'native-diagnostics-question-private-19307';
const answerSecret = 'native-diagnostics-answer-private-64022';
const sockets = new Set();
let browser;
let server;
let directory;
let assets;
let port;
let browserPort;
let serial = 0;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

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
  directory = await mkdtemp(join(tmpdir(), 'cx-native-diagnostics-'));
  assets = join(directory, 'assets');
  await mkdir(join(assets, 'vendor'), { recursive: true });
  const bootstrap = await readFile('dist-windows/windows-bootstrap.js', 'utf8');
  await writeFile(join(assets, 'windows-bootstrap.js'),
    'window.__nativeDiagnosticsBootstrapRuns=(window.__nativeDiagnosticsBootstrapRuns||0)+1;\n' + bootstrap);
  await writeFile(join(assets, 'chaoxing-plus.windows.js'), [
    'window.__nativeDiagnosticsBundleRuns=(window.__nativeDiagnosticsBundleRuns||0)+1;',
    `document.body.setAttribute('data-diagnostics-question', ${JSON.stringify(questionSecret)});`,
    `document.body.setAttribute('data-diagnostics-answer', ${JSON.stringify(answerSecret)});`,
    'window.__nativeDiagnosticsBundleCompletedAt=Date.now();'
  ].join('\n'));
  await writeFile(join(assets, 'trampoline.js'), await readFile(join('dist-windows', 'trampoline.js')));
  await writeFile(join(assets, 'vendor/sweetalert2.min.css'), await readFile(join('dist-windows', 'vendor/sweetalert2.min.css')));
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><title>Native diagnostics fixture</title></head><body>${questionSecret} ${answerSecret}</body></html>`);
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
    args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP a.chaoxing.com 127.0.0.1']
  });
  browserPort = Number(new URL(browser.wsEndpoint()).port);
});

after(async () => {
  const failures = [];
  try {
    await browser?.close();
  } catch (error) {
    failures.push(error);
  }
  for (const socket of sockets) socket.destroy();
  if (server?.listening) {
    try {
      await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
    } catch (error) {
      failures.push(error);
    }
  }
  for (const value of [port, browserPort]) {
    try {
      await assertPortClosed(value);
    } catch (error) {
      failures.push(error);
    }
  }
  if (directory) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'native diagnostics fixture cleanup failed');
});

async function findDiagnosticsFile(root) {
  if (!await exists(root)) return null;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === 'render-diagnostics.json') return path;
    if (entry.isDirectory()) {
      const nested = await findDiagnosticsFile(path);
      if (nested) return nested;
    }
  }
  return null;
}

async function runFixture({ noDiskWrite = false } = {}) {
  const caseDir = join(directory, `case-${++serial}`);
  const dataDir = join(caseDir, 'data');
  const diagnosticsDir = join(caseDir, 'diagnostics');
  await mkdir(caseDir);
  const page = await browser.newPage();
  let child;
  let closed;
  let stdout = '';
  let stderr = '';
  try {
    await page.goto(`http://a.chaoxing.com:${port}/exam-ans/diagnostics-${serial}?secret=${querySecret}`);
    const args = [
      '--attach', String(browserPort), '--duration', '2500', '--scan-mode', 'common', '--client-index', '2147483647',
      '--assets', assets, '--inject-strategy', 'runtime', '--inject-retries', '0', '--target-poll-interval', '250',
      '--data-dir', dataDir, '--no-log', '--no-panel', '--diagnose', '--diagnostics-dir', diagnosticsDir
    ];
    if (noDiskWrite) args.push('--no-disk-write');
    child = spawn(executable, args, { cwd: caseDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => { stdout += text; });
    child.stderr.on('data', (text) => { stderr += text; });
    closed = new Promise((done, reject) => {
      child.once('close', (code, signal) => done({ code, signal }));
      child.once('error', reject);
    });
    await Promise.race([
      page.waitForFunction(() => window.__nativeDiagnosticsBundleRuns === 1
        && Number.isFinite(window.__nativeDiagnosticsBundleCompletedAt), { timeout: 6000 }),
      closed.then((result) => { throw new Error(`native exited before top-level bundle ACK: ${JSON.stringify(result)}`); })
    ]);
    const result = await Promise.race([
      closed,
      delay(15000).then(() => { throw new Error(`native diagnostics run timed out; stdout=${stdout}\nstderr=${stderr}`); })
    ]);
    assert.equal(result.code, 0, `stdout=${stdout}\nstderr=${stderr}`);
    assert.equal(result.signal, null, `stdout=${stdout}\nstderr=${stderr}`);
    const bundleCompletedAt = await page.evaluate(() => window.__nativeDiagnosticsBundleCompletedAt);
    await page.close();
    return { diagnosticsDir, dataDir, bundleCompletedAt, stdout, stderr };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      if (closed) await Promise.race([closed, delay(3000)]).catch(() => {});
    }
    await page.close().catch(() => {});
  }
}

function assertPrivateBoundary(text) {
  for (const value of [querySecret, questionSecret, answerSecret, 'a.chaoxing.com', 'http://', 'https://']) {
    assert.equal(text.includes(value), false, `diagnostic output must not contain ${value}`);
  }
}

function assertDiagnosticSchema(diagnostic) {
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    'version', 'host', 'source', 'collectedAt', 'bundleLoaded', 'devicePixelRatio',
    'innerWidth', 'innerHeight', 'visualViewport', 'panelCount', 'topPanel', 'scope'
  ].sort());
  assert.deepEqual(Object.keys(diagnostic.visualViewport).sort(), ['width', 'height', 'scale'].sort());
  assert.deepEqual(Object.keys(diagnostic.scope).sort(), ['pageOnly', 'windowDpi', 'screenshots'].sort());
  if (diagnostic.topPanel !== null) {
    assert.deepEqual(Object.keys(diagnostic.topPanel).sort(), ['visible', 'rect', 'fractionalDevicePixel', 'style'].sort());
    assert.deepEqual(Object.keys(diagnostic.topPanel.rect).sort(), ['x', 'y', 'width', 'height'].sort());
    assert.deepEqual(Object.keys(diagnostic.topPanel.style).sort(), [
      'backdropFilter', 'boxShadow', 'transform', 'backgroundColor'
    ].sort());
  }
}

test('native page diagnostics are collected after top-level bundle ACK with a flat privacy-safe schema', {
  skip: !executable
}, async () => {
  const result = await runFixture();
  const path = await findDiagnosticsFile(result.diagnosticsDir);
  assert.ok(path, 'render-diagnostics.json must be written below --diagnostics-dir');
  const text = await readFile(path, 'utf8');
  assertPrivateBoundary(text);
  const diagnostic = JSON.parse(text);
  assertDiagnosticSchema(diagnostic);
  assert.equal(diagnostic.version, '6.2.0');
  assert.equal(diagnostic.host, 'native');
  assert.equal(diagnostic.source, 'native-page');
  assert.equal(typeof diagnostic.collectedAt, 'string');
  const collectedAt = Date.parse(diagnostic.collectedAt);
  assert.ok(Number.isFinite(collectedAt));
  assert.ok(collectedAt >= result.bundleCompletedAt,
    'page diagnostics must be sampled after the top-level bundle has completed');
  assert.equal(diagnostic.bundleLoaded, true);
  assert.equal(typeof diagnostic.devicePixelRatio, 'number');
  assert.equal(typeof diagnostic.innerWidth, 'number');
  assert.equal(typeof diagnostic.innerHeight, 'number');
  assert.ok(diagnostic.visualViewport && typeof diagnostic.visualViewport === 'object');
  assert.equal(typeof diagnostic.visualViewport.width, 'number');
  assert.equal(typeof diagnostic.visualViewport.height, 'number');
  assert.equal(typeof diagnostic.visualViewport.scale, 'number');
  assert.equal(diagnostic.panelCount, 0);
  assert.equal(diagnostic.topPanel, null);
  assert.deepEqual(diagnostic.scope, { pageOnly: true, windowDpi: false, screenshots: false });
});

test('native --no-disk-write suppresses page render diagnostics without changing the bundle ACK path', {
  skip: !executable
}, async () => {
  const result = await runFixture({ noDiskWrite: true });
  assert.equal(await exists(result.diagnosticsDir), false, 'no-disk-write must not create diagnostics directory');
  assert.equal(await exists(join(result.diagnosticsDir, 'render-diagnostics.json')), false,
    'no-disk-write must not leave a render diagnostics file');
});
