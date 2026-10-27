import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.env.CX_NATIVE_HOST_EXE;
const querySecret = 'audit-query-private-92731';
const hashSecret = 'audit-hash-private-41856';
const tokenSecret = 'audit-token-private-58392';
const questionSecret = 'audit-question-private-16543';
const answerSecret = 'audit-answer-private-74621';
const consoleSecret = 'audit-console-error-private-82519';
const exceptionSecret = 'audit-exception-private-36274';
const optionsJson = JSON.stringify({ settings: { 'common.settings.audit-fixture-token': tokenSecret } });
const sockets = new Set();
let browser, server, directory, assets, port, browserPort;
let serial = 0;

before(async () => {
  if (!executable) return;
  const browserRequire = createRequire(resolve(process.env.CX_BROWSER_DEPENDENCIES ?? '.', 'package.json'));
  const puppeteer = browserRequire('puppeteer');
  directory = await mkdtemp(join(tmpdir(), 'cx-native-audit-'));
  assets = join(directory, 'assets');
  await mkdir(join(assets, 'vendor'), { recursive: true });
  const bootstrap = await readFile('dist-windows/windows-bootstrap.js', 'utf8');
  await writeFile(join(assets, 'windows-bootstrap.js'), 'window.__nativeAuditBootstrapRuns=(window.__nativeAuditBootstrapRuns||0)+1;\n' + bootstrap);
  await writeFile(join(assets, 'chaoxing-plus.windows.js'), [
    'window.__nativeAuditBundleRuns=(window.__nativeAuditBundleRuns||0)+1;',
    `window.__CX_WIN_HOST__.send('bootstrap-error',{stage:'audit-fixture',message:${JSON.stringify(tokenSecret)}});`,
    `console.log(${JSON.stringify(questionSecret)},${JSON.stringify(answerSecret)});`,
    `console.error(${JSON.stringify(consoleSecret)});`,
    `setTimeout(function(){function deep(n){if(n>0)return deep(n-1);throw new Error(${JSON.stringify(exceptionSecret)});}deep(12);},0);`
  ].join('\n'));
  for (const name of ['trampoline.js', 'vendor/sweetalert2.min.css']) {
    await writeFile(join(assets, name), await readFile(join('dist-windows', name)));
  }
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><title>Native audit fixture</title></head><body>Local audit fixture</body></html>');
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

after(async () => {
  try {
    await browser?.close();
  } finally {
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

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
}

function assertPrivate(text) {
  for (const value of [querySecret, hashSecret, tokenSecret, questionSecret, answerSecret, consoleSecret, exceptionSecret, optionsJson, '?secret=', '#private=']) {
    assert.equal(text.includes(value), false, 'audit output must exclude private fixture payloads and URL queries');
  }
}

function assertReport(report) {
  assert.equal(report.host, 'native');
  assert.equal(report.version, '6.2.0');
  assert.equal(report.success, true);
  assert.equal(report.mode, 'attach');
  assert.equal(typeof report.startedAt, 'string');
  assert.equal(typeof report.finishedAt, 'string');
  const started = Date.parse(report.startedAt);
  const finished = Date.parse(report.finishedAt);
  assert.ok(Number.isFinite(started), 'startedAt must be a valid timestamp');
  assert.ok(Number.isFinite(finished) && finished >= started, 'finishedAt must follow startedAt');
  assert.ok(Number.isInteger(report.durationMs) && report.durationMs > 0);
  assert.ok(Number.isInteger(report.totals.bootstraps) && report.totals.bootstraps > 0);
  assert.ok(Number.isInteger(report.totals.bundles) && report.totals.bundles > 0);
  assert.ok(Number.isInteger(report.totals.errors) && report.totals.errors >= 0);
}

async function readReport(path) {
  const text = await readFile(path, 'utf8');
  assertPrivate(text);
  const report = JSON.parse(text);
  assertReport(report);
  return report;
}

async function logText(dataDir) {
  const names = await readdir(join(dataDir, 'logs'));
  const files = names.filter((name) => /^windows-host-.*\.log$/u.test(name));
  assert.equal(files.length, 1, 'one log file must be written for this native process');
  const text = await readFile(join(dataDir, 'logs', files[0]), 'utf8');
  assertPrivate(text);
  return text;
}

function assertPageException(text, capture = true) {
  const exception = /(?:\[pageexception\]|\[page\][^\r\n]*exception)/iu;
  const consoleError = /\[page\][^\r\n]*console[^\r\n]*error/iu;
  if (capture) {
    assert.match(text, exception, 'a deep page exception must emit a fixed event');
    assert.match(text, consoleError, 'a console error must emit a fixed event');
  } else {
    assert.doesNotMatch(text, exception, 'console capture disabled must suppress page exception events');
    assert.doesNotMatch(text, consoleError, 'console capture disabled must suppress console error events');
  }
}

function assertBootstrapError(text) {
  assert.match(text, /\[bootstrap\][^\r\n]*(?:reported[^\r\n]*error|error[^\r\n]*reported)/iu,
    'bootstrap control errors must remain observable with private detail omitted');
}

function errorEvents(text) {
  const lines = text.split(/\r?\n/u);
  const count = (pattern) => lines.filter((line) => pattern.test(line)).length;
  const events = {
    bootstrap: count(/\[warn\]\s+\[bootstrap\][^\r\n]*reported[^\r\n]*error/iu),
    exceptions: count(/\[warn\]\s+(?:\[pageexception\]|\[page\][^\r\n]*exception)/iu),
    connections: count(/\[warn\]\s+\[session\][^\r\n]*connection[^\r\n]*(?:closed|failed)/iu),
    injections: count(/\[warn\]\s+\[(?:bootstrap|bundle)\][^\r\n]*injection[^\r\n]*failed/iu)
  };
  return { ...events, total: Object.values(events).reduce((total, value) => total + value, 0) };
}

function assertErrorTotals(report, text, { capture = true, reconnect = false } = {}) {
  const events = errorEvents(text);
  const diagnostic = JSON.stringify({ reported: report.totals.errors, events });
  assert.ok(events.bootstrap > 0, `bootstrap control errors must contribute with either capture setting: ${diagnostic}`);
  assert.equal(events.exceptions > 0, capture, `page exception counts must follow captureConsole: ${diagnostic}`);
  assert.equal(events.injections, 0, `normal duration cancellation must not count as failed injection: ${diagnostic}`);
  assert.equal(events.connections > 0, reconnect, diagnostic);
  // Console error warnings are intentionally absent from this error sum.
  assert.equal(report.totals.errors, events.total, `report errors must match fixed native error events: ${diagnostic}`);
  return events;
}

async function readLogs(dataDir, capture = true) {
  const text = await logText(dataDir);
  for (const event of [/session/iu, /bundle/iu, /stop/iu]) assert.match(text, event);
  assertPageException(text, capture);
  assertBootstrapError(text);
  return text;
}

async function acknowledged(dataDir, minimum) {
  const deadline = Date.now() + 2000;
  let counts;
  do {
    const text = await logText(dataDir);
    counts = {
      bootstraps: [...text.matchAll(/\[info\]\s+\[bootstrap\]/giu)].length,
      bundles: [...text.matchAll(/\[info\]\s+\[bundle\]/giu)].length,
      errors: errorEvents(text).total
    };
    if (counts.bootstraps >= minimum.bootstraps && counts.bundles >= minimum.bundles) return counts;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`native acknowledgement deadline: ${JSON.stringify({ counts, minimum })}`);
}

async function runFixture(extra = [], prepare = async () => {}, interact = async () => {}) {
  const caseDir = join(directory, `case-${++serial}`);
  const dataDir = join(caseDir, 'data');
  const reportPath = join(caseDir, 'report.json');
  await mkdir(caseDir);
  const prepared = await prepare({ caseDir, dataDir, reportPath });
  const page = await browser.newPage();
  let child, closed, watchdog;
  let stdout = '', stderr = '';
  let spawnError;
  const output = () => `stdout=${stdout}\nstderr=${stderr}`;
  try {
    await page.goto(`http://a.chaoxing.com:${port}/exam-ans/audit-${serial}?secret=${querySecret}#private=${hashSecret}`);
    child = spawn(executable, [
      '--attach', String(browserPort), '--duration', '2000', '--scan-mode', 'common', '--client-index', '2147483647',
      '--assets', assets, '--inject-strategy', 'runtime', '--inject-retries', '0', '--target-poll-interval', '250',
      '--data-dir', dataDir, '--report', reportPath, '--no-panel', '--no-diagnose', '--options-json', optionsJson,
      ...extra, ...(prepared?.args ?? [])
    ], { cwd: caseDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => { stdout += text; });
    child.stderr.on('data', (text) => { stderr += text; });
    child.once('error', (error) => { spawnError = error; });
    closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
    const deadline = new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error(`native duration did not finish; ${output()}`)), 15_000);
    });
    await Promise.race([
      page.waitForFunction(() => window.__nativeAuditBundleRuns === 1, { timeout: 6000 }),
      closed.then((result) => { throw new Error(`native exited before fixture injection: ${JSON.stringify(result)}; ${spawnError?.message ?? ''}; ${output()}`); }),
      deadline
    ]);
    const interaction = await interact({ page, child, closed, output, dataDir });
    const result = await Promise.race([closed, deadline]);
    assert.equal(result.code, 0, output());
    assert.equal(result.signal, null, output());
    assert.equal(await page.evaluate(() => window.__nativeAuditBundleRuns), 1);
    assert.ok(await page.evaluate(() => window.__nativeAuditBootstrapRuns > 0));
    assert.equal(browser.connected, true, 'attach duration must leave the fixture browser running');
    assertPrivate(stdout + stderr);
    return { caseDir, dataDir, reportPath, stdout, stderr, prepared, interaction };
  } catch (error) {
    const state = await page.evaluate(() => ({
      host: !!window.__CX_WIN_HOST__, bundle: window.__nativeAuditBundleRuns, bootstrap: window.__nativeAuditBootstrapRuns
    })).catch(() => null);
    throw new Error(`${error.message}; page=${JSON.stringify(state)}; ${output()}`, { cause: error });
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (closed) await closed;
    if (!page.isClosed()) await page.close();
  }
}

test('compiled native duration writes default audit logs and a successful JSON report', { skip: !executable }, async () => {
  const value = await runFixture();
  const report = await readReport(value.reportPath);
  assertErrorTotals(report, await readLogs(value.dataDir));
});

test('compiled native quiet suppresses console output while preserving logs and report', { skip: !executable }, async () => {
  const value = await runFixture(['--quiet']);
  assert.equal(value.stdout, '');
  assert.equal(value.stderr, '');
  const report = await readReport(value.reportPath);
  assertErrorTotals(report, await readLogs(value.dataDir));
});

test('compiled native no-log leaves the logs directory absent while writing the report', { skip: !executable }, async () => {
  const value = await runFixture(['--no-log']);
  assert.equal(await exists(join(value.dataDir, 'logs')), false);
  const report = await readReport(value.reportPath);
  assertPageException(value.stdout + value.stderr);
  assertBootstrapError(value.stdout + value.stderr);
  assertErrorTotals(report, value.stdout + value.stderr);
});

test('compiled native no-disk-write overrides explicit log and report outputs', { skip: !executable }, async () => {
  const value = await runFixture(['--no-disk-write', '--log']);
  assert.equal(await exists(value.dataDir), false);
  assert.equal(await exists(value.reportPath), false);
  assertBootstrapError(value.stdout + value.stderr);
});

test('compiled native no-capture-console still receives readiness and reports successful bundle injection', { skip: !executable }, async () => {
  const value = await runFixture(['--no-capture-console']);
  const report = await readReport(value.reportPath);
  assertErrorTotals(report, await readLogs(value.dataDir, false), { capture: false });
  assertPageException(value.stdout + value.stderr, false);
  assertBootstrapError(value.stdout + value.stderr);
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
      const headers = request.rawHeaders.reduce((text, value, index) => text + value + (index % 2 ? '\r\n' : ': '), '');
      upstream.write(`GET ${request.url} HTTP/1.1\r\n${headers}\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(downstream).pipe(upstream);
    });
  });
  await new Promise((done, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', done);
  });
  proxyPort = proxy.address().port;
  return {
    port: proxyPort,
    disconnect: () => { for (const socket of connections) socket.destroy(); },
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise((done, reject) => proxy.close((error) => error ? reject(error) : done()));
      await assertPortClosed(proxyPort);
    }
  };
}

test('compiled native report preserves reconnect totals and snapshots only live default contexts', { skip: !executable }, async () => {
  const proxy = await cdpProxy();
  try {
    const value = await runFixture(['--attach', String(proxy.port), '--duration', '6000'], undefined, async ({ page, dataDir }) => {
      await page.evaluate(() => {
        for (let index = 0; index < 3; index += 1) {
          const frame = document.createElement('iframe');
          frame.dataset.auditTemporary = '1';
          document.body.appendChild(frame);
        }
      });
      await page.waitForFunction(() => [...document.querySelectorAll('iframe[data-audit-temporary]')]
        .every((frame) => frame.contentWindow.__nativeAuditBundleRuns === 1), { timeout: 4000 });
      // Log events follow native success acknowledgement, unlike page counters.
      const before = await acknowledged(dataDir, { bootstraps: 4, bundles: 4 });
      const pageBootstraps = await page.evaluate(() => window.__nativeAuditBootstrapRuns);
      await page.evaluate(() => {
        for (const frame of document.querySelectorAll('iframe[data-audit-temporary]')) frame.remove();
      });
      proxy.disconnect();
      await page.waitForFunction((previous) => window.__nativeAuditBootstrapRuns > previous, { timeout: 4000 }, pageBootstraps);
      const after = await acknowledged(dataDir, { bootstraps: before.bootstraps + 1, bundles: before.bundles + 1 });
      const activeContexts = (await browser.pages()).reduce((total, target) => total + target.frames().length, 0);
      return { before, after, activeContexts };
    });
    const report = await readReport(value.reportPath);
    const events = assertErrorTotals(report, await readLogs(value.dataDir), { reconnect: true });
    const counts = JSON.stringify({ totals: report.totals, observed: value.interaction });
    assert.ok(value.interaction.before.errors > 0, 'the fixture must acknowledge errors before reconnect');
    assert.ok(report.totals.errors >= value.interaction.before.errors + events.connections,
      `errors from closed iframe sessions must survive reconnect: ${counts}`);
    assert.ok(report.totals.pageSessions > report.totals.reconnects && report.totals.reconnects > 0, counts);
    assert.ok(report.totals.bootstraps >= value.interaction.after.bootstraps, `reconnected bootstraps must retain successful history: ${counts}`);
    assert.ok(report.totals.bundles >= value.interaction.after.bundles, `bundle totals count acknowledged native injection tasks across reconnects: ${counts}`);
    assert.equal(report.totals.contexts, value.interaction.activeContexts, 'destroyed iframe and old session contexts must be excluded');
  } finally { await proxy.close(); }
});

for (const blockedBy of ['directory', 'file']) {
  test(`compiled native report blocked by a ${blockedBy} preserves existing data and successful injection`, { skip: !executable }, async () => {
    const value = await runFixture([], async ({ caseDir }) => {
      const blocker = join(caseDir, 'existing');
      const previous = 'existing report destination must remain unchanged';
      if (blockedBy === 'directory') {
        await mkdir(blocker);
        await writeFile(join(blocker, 'keep.txt'), previous);
      } else await writeFile(blocker, previous);
      return { blocker, previous, args: ['--report', blockedBy === 'directory' ? blocker : join(blocker, 'report.json')] };
    });
    const text = await readLogs(value.dataDir);
    assert.match(value.stdout + value.stderr + text, /(?:report[^\r\n]*(?:error|fail)|(?:error|fail)[^\r\n]*report)/iu);
    const { blocker, previous } = value.prepared;
    assert.equal(await readFile(blockedBy === 'directory' ? join(blocker, 'keep.txt') : blocker, 'utf8'), previous);
    if (blockedBy === 'directory') assert.deepEqual(await readdir(blocker), ['keep.txt']);
    assert.equal(await exists(value.reportPath), false);
  });
}
