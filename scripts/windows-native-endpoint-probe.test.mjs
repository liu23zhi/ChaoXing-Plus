import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const executable = process.env.CX_NATIVE_HOST_EXE;
const privateResponse = 'endpoint-private-response-189731';
const reasonCodes = ['no-listener', 'listener-not-owned', 'listener-query-failed',
  'listener-binding-rejected', 'http-failed', 'invalid-version', 'browser-mismatch', 'ready'];

async function probe({ status = 200, body, reason, stopReason, successful = false }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-native-endpoint-'));
  const reportPath = path.join(directory, 'report.json');
  const dataDir = path.join(directory, 'data');
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const text = request.url === '/json/version' ? body : '[]';
    response.writeHead(request.url === '/json/version' ? status : 200, {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text)
    });
    response.end(text);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let child;
  try {
    const result = await new Promise((resolve, reject) => {
      child = spawn(path.resolve(executable), [
        '--attach', String(server.address().port), '--duration', '500', '--debug-timeout', '1000',
        '--options-json', '{"settings":{"common.settings.extension-enabled":false}}',
        '--data-dir', dataDir, '--report', reportPath, '--log', '--no-diagnose', '--quiet'
      ], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('endpoint fixture timed out')); }, 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    assert.equal(result.code, successful ? 0 : 1, JSON.stringify(result));
    assert.equal(result.signal, null);
    assert.equal(result.stdout + result.stderr, '');
    const text = await readFile(reportPath, 'utf8');
    const report = JSON.parse(text);
    assert.equal(report.stopReason, stopReason);
    assert.equal(report.success, successful);
    assert.ok(report.endpointProbe, 'native report must retain endpoint probe classification');
    assert.equal(report.endpointProbe.lastReason, reason);
    assert.equal(report.endpointProbe.ownershipVerified, false, 'attach must not claim process ownership');
    if (status === 200) assert.equal(report.endpointProbe.listenerSeen, true, 'a completed HTTP response proves the listener was seen');
    assert.ok(report.endpointProbe.attempts >= 1);
    assert.ok(report.endpointProbe.elapsedMs >= 0 && report.endpointProbe.elapsedMs <= report.durationMs);
    assert.deepEqual(Object.keys(report.endpointProbe.reasonCounts).sort(), [...reasonCodes].sort());
    const counts = report.endpointProbe.reasonCounts;
    assert.ok(counts[reason] >= 1);
    assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), report.endpointProbe.attempts);
    if (successful) assert.equal(report.endpointProbe.attempts, 1, 'normal target polling must not inflate endpoint attempts');
    const names = await readdir(path.join(dataDir, 'chaoxing', 'logs'));
    assert.equal(names.length, 1);
    const log = await readFile(path.join(dataDir, 'chaoxing', 'logs', names[0]), 'utf8');
    const summaries = log.split(/\r?\n/u).filter(line => line.includes('[endpoint-probe]'));
    assert.equal(summaries.length, successful ? 0 : 1, 'failed probes emit one final summary, not one per retry');
    if (!successful) assert.ok(summaries[0].endsWith(` ${reason}`));
    assert.equal((text + log).includes(privateResponse), false);
    if (!successful) assert.equal(requests.some(url => url !== '/json/version'), false, 'rejected version must never enumerate targets');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [name, fixture] of [
  ['HTTP failure', { status: 503, body: privateResponse, reason: 'http-failed', stopReason: 'duration-before-endpoint' }],
  ['invalid JSON', { body: privateResponse, reason: 'invalid-version', stopReason: 'browser-mismatch' }],
  ['missing Browser', { body: `{"detail":"${privateResponse}"}`, reason: 'invalid-version', stopReason: 'browser-mismatch' }],
  ['non-string Browser', { body: '{"Browser":75}', reason: 'invalid-version', stopReason: 'browser-mismatch' }],
  ['unexpected Browser', { body: `{"Browser":"${privateResponse}"}`, reason: 'browser-mismatch', stopReason: 'browser-mismatch' }],
  ['ready endpoint', { body: '{"Browser":"Chrome/75.0.3770.100"}', reason: 'ready', stopReason: 'duration', successful: true }]
]) {
  test(`compiled native endpoint report classifies ${name} without private data or retry log spam`, { skip: !executable }, async () => {
    await probe(fixture);
  });
}
