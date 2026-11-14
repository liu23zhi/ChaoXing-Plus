import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(exe, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { windowsHide: true, env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`native extension cache test timed out\n${stdout}${stderr}`)); }, 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('native extension cache is verified, atomic, refreshable and disabled by no-disk-write', {
  skip: !process.env.CX_NATIVE_EXTENSION_CACHE_EXE,
  timeout: 180_000
}, async () => {
  const packageBytes = Buffer.from('Cr24mock-crx-package');
  const hash = createHash('sha256').update(packageBytes).digest('hex');
  let requests = [], handlerError, serviceVersion = '1.2.3.4';
  const server = http.createServer(async (req, res) => {
    try {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      assert.equal(req.headers.authorization, undefined, 'public extension requests must not include credentials');
      const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.method === 'GET' && req.url === '/api/extensions/edge/latest') {
        return json(200, {
          source: 'edge',
          extensionId: 'lcmeenlnjihhjcjoakekikoaldigonac',
          version: serviceVersion,
          size: packageBytes.length,
          sha256: hash,
          downloadUrl: `/api/extensions/edge/download?sha256=${hash}`
        });
      }
      if (req.method === 'GET' && req.url === `/api/extensions/edge/download?sha256=${hash}`) {
        res.writeHead(200, { 'Content-Type': 'application/x-chrome-extension' });
        return res.end(packageBytes);
      }
      throw new Error(`unexpected request ${req.method} ${req.url}`);
    } catch (error) { handlerError = error; res.writeHead(500); res.end('mock assertion failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let requestsTwo = [], handlerErrorTwo;
  const serverTwo = http.createServer((req, res) => {
    try {
      requestsTwo.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      assert.equal(req.headers.authorization, undefined, 'public extension requests must not include credentials');
      const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.method === 'GET' && req.url === '/api/extensions/edge/latest') {
        return json(200, {
          source: 'edge',
          extensionId: 'lcmeenlnjihhjcjoakekikoaldigonac',
          version: '5.6.7.8',
          size: packageBytes.length,
          sha256: hash,
          downloadUrl: `/api/extensions/edge/download?sha256=${hash}`
        });
      }
      if (req.method === 'GET' && req.url === `/api/extensions/edge/download?sha256=${hash}`) {
        res.writeHead(200, { 'Content-Type': 'application/x-chrome-extension' });
        return res.end(packageBytes);
      }
      throw new Error(`unexpected request ${req.method} ${req.url}`);
    } catch (error) { handlerErrorTwo = error; res.writeHead(500); res.end('mock assertion failed'); }
  });
  await new Promise(resolve => serverTwo.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-native-extension-cache-'));
  const cacheDir = path.join(root, 'cache');
  const base = `http://127.0.0.1:${server.address().port}/adapter-service`;
  const baseTwo = `http://127.0.0.1:${serverTwo.address().port}/adapter-service`;
  const launch = (scenario, directory, baseUrl = base, version = '1.2.3.4') => run(process.env.CX_NATIVE_EXTENSION_CACHE_EXE, {
    CX_EXTENSION_CACHE_TEST_BASE: baseUrl,
    CX_EXTENSION_CACHE_TEST_DIR: directory,
    CX_EXTENSION_CACHE_TEST_SCENARIO: scenario,
    CX_EXTENSION_CACHE_TEST_VERSION: version
  });
  try {
    let result = await launch('sequence', cacheDir);
    if (handlerError) throw handlerError;
    assert.equal(result.code, 0, `sequence: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /NATIVE EXTENSION CACHE TESTS PASS/);
    assert.equal(requests.length, 4, 'initial fetch downloads once, cache hit is local, forced refresh downloads again');
    assert.deepEqual(await readdir(cacheDir), ['edge.crxcache'], 'atomic cache write leaves no temporary files');

    serviceVersion = '2.3.4.5'; requests = []; handlerError = undefined;
    result = await launch('force-with-reader', cacheDir, base, serviceVersion);
    if (handlerError) throw handlerError;
    assert.equal(result.code, 0, `force-with-reader: ${result.stdout}${result.stderr}`);
    assert.equal(requests.length, 2, 'force-refresh downloads a new package while a compatible reader handle is open');

    requests = []; handlerError = undefined;
    result = await launch('fetch-once', cacheDir, `http://127.0.0.1:${server.address().port}/`, serviceVersion);
    if (handlerError) throw handlerError;
    assert.equal(result.code, 0, `normalized-base: ${result.stdout}${result.stderr}`);
    assert.equal(requests.length, 0, 'root URL and explicit /adapter-service suffix normalize to the same service identity');

    const cacheFile = path.join(cacheDir, 'edge.crxcache');
    const corrupted = await readFile(cacheFile);
    corrupted[corrupted.length - 1] ^= 0xff;
    await writeFile(cacheFile, corrupted);
    requests = []; handlerError = undefined;
    result = await launch('corrupt', cacheDir, base, serviceVersion);
    if (handlerError) throw handlerError;
    assert.equal(result.code, 0, `corrupt: ${result.stdout}${result.stderr}`);
    assert.equal(requests.length, 2, 'modified cached bytes fail SHA-256 and trigger a verified online download');

    requestsTwo = []; handlerErrorTwo = undefined;
    result = await launch('fetch-once', cacheDir, baseTwo, '5.6.7.8');
    if (handlerErrorTwo) throw handlerErrorTwo;
    assert.equal(result.code, 0, `different-service: ${result.stdout}${result.stderr}`);
    assert.equal(requestsTwo.length, 2, 'a different adapter service cannot reuse the previous service cache');

    const beforeNoDisk = await readFile(cacheFile);
    requestsTwo = []; handlerErrorTwo = undefined;
    result = await launch('no-disk', cacheDir, baseTwo, '5.6.7.8');
    if (handlerErrorTwo) throw handlerErrorTwo;
    assert.equal(result.code, 0, `no-disk: ${result.stdout}${result.stderr}`);
    assert.equal(requestsTwo.length, 2, 'no-disk-write bypasses an existing cache and fetches online');
    assert.deepEqual(await readFile(cacheFile), beforeNoDisk, 'no-disk-write does not mutate an existing cache');

    const cacheBlocker = path.join(root, 'not-a-directory');
    await writeFile(cacheBlocker, 'preserve');
    requests = []; handlerError = undefined;
    result = await launch('write-fail', cacheBlocker, base, serviceVersion);
    if (handlerError) throw handlerError;
    assert.equal(result.code, 0, `write-fail: ${result.stdout}${result.stderr}`);
    assert.equal(requests.length, 2, 'cache write failure does not fail a verified online fetch');
    assert.equal(await readFile(cacheBlocker, 'utf8'), 'preserve', 'cache failure does not alter unrelated files');

    const absentCache = path.join(root, 'no-disk-cache');
    requests = []; handlerError = undefined;
    result = await launch('no-disk', absentCache, base, serviceVersion);
    if (handlerError) throw handlerError;
    assert.equal(result.code, 0, `no-disk-empty: ${result.stdout}${result.stderr}`);
    assert.equal(requests.length, 2);
    await assert.rejects(stat(absentCache), { code: 'ENOENT' }, 'no-disk-write must not create a cache directory');
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => serverTwo.close(resolve));
  }
});
