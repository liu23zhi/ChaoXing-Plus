import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type), header = Buffer.alloc(4), crc = Buffer.alloc(4);
  header.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([header, name, data, crc]);
}
function captchaPNG() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255]);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}
function run(exe, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { windowsHide: true, env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`native adapter test timed out\n${stdout}${stderr}`)); }, 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('native adapter uses complete captcha login, token authentication and verified public downloads', {
  skip: !process.env.CX_NATIVE_ADAPTER_EXE,
  timeout: 180_000
}, async () => {
  const packageBytes = Buffer.from('Cr24mock-crx-package');
  assert.equal(packageBytes.length, 20);
  const hash = createHash('sha256').update(packageBytes).digest('hex');
  const imageData = `data:image/png;base64,${captchaPNG().toString('base64')}`;
  let scenario = '', requests = [], handlerError;
  const server = http.createServer(async (req, res) => {
    try {
      const body = Buffer.concat(await Array.fromAsync(req)).toString('utf8');
      const payload = body ? JSON.parse(body) : undefined;
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, payload });
      assert.equal(req.headers.cookie, undefined, 'native requests must not reuse web cookies');
      const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.url === '/adapter-service/public/captcha/challenge') {
        assert.equal(req.method, 'POST'); assert.deepEqual(payload, { scene: 'login_password' });
        return json(200, { challengeId: 'challenge-1', imageData, expiresAt: '2030-01-01T00:00:00Z' });
      }
      if (req.url === '/adapter-service/public/captcha/verify') {
        assert.deepEqual(payload, { challengeId: 'challenge-1', scene: 'login_password', captchaCode: payload.captchaCode });
        return json(payload.captchaCode === 'a7b9' ? 200 : 400, payload.captchaCode === 'a7b9' ? { captchaToken: 'captcha-one-shot' } : { message: 'incorrect captcha' });
      }
      if (req.url === '/adapter-service/user/login') {
        assert.equal(payload.username, 'mock-user'); assert.equal(payload.captchaToken, 'captcha-one-shot');
        return json(payload.password === 'p"ass\\word' ? 200 : 401, payload.password === 'p"ass\\word' ? { jwt: 'mock-jwt' } : { message: 'incorrect password' });
      }
      if (req.url === '/adapter-service/access-tokens') {
        if (scenario === 'unauthorized') { assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, 'invalid-jwt'); return json(401, { message: 'unauthorized' }); }
        assert.equal(req.headers.authorization, 'mock-jwt');
        if (req.method === 'GET') return json(200, scenario === 'create' ? [] : [{ id: 6, status: 'disabled', tokenValue: 'tk_disabled' }, { id: 7, status: 'enabled', tokenValue: 'tk_mock-existing' }]);
        assert.deepEqual(payload, { name: 'chaoxing_plus_native', remark: '\u539f\u751f\u5ba2\u6237\u7aef', totalQuotaLimit: 0 });
        assert.match(payload.name, /^[a-zA-Z0-9_@]+$/, 'token name must satisfy the server restricted-name validator');
        return json(200, { token: 'tk_mock-created', accessToken: { id: 8 } });
      }
      if (req.url === '/adapter-service/search/health') return json(req.headers.authorization === 'Bearer tk_mock-existing' ? 200 : 401, { ok: req.headers.authorization === 'Bearer tk_mock-existing' });
      assert.equal(req.headers.authorization, undefined, 'public extension requests must not include any credential');
      if (req.url === '/adapter-service/extensions/edge/latest') {
        const metadata = { source: 'edge', extensionId: 'lcmeenlnjihhjcjoakekikoaldigonac', version: '1.2.3.4', size: packageBytes.length, sha256: hash, downloadUrl: `/adapter-service/extensions/edge/download?sha256=${hash}` };
        if (scenario === 'hash') metadata.sha256 = '0'.repeat(64), metadata.downloadUrl = `/adapter-service/extensions/edge/download?sha256=${metadata.sha256}`;
        if (scenario === 'size') metadata.size++;
        if (scenario === 'version') metadata.version = '../bad';
        if (scenario === 'source') metadata.source = 'chrome';
        if (scenario === 'url') metadata.downloadUrl = `http://127.0.0.1/steal?sha256=${hash}`;
        if (scenario === 'redirect') { res.writeHead(302, { Location: '/unexpected-redirect' }); return res.end(); }
        return json(200, metadata);
      }
      if (req.url.startsWith('/adapter-service/extensions/edge/download?sha256=')) { res.writeHead(200, { 'Content-Type': 'application/x-chrome-extension' }); return res.end(packageBytes); }
      throw new Error(`unexpected request ${req.method} ${req.url}`);
    } catch (error) { handlerError = error; res.writeHead(500); res.end('mock assertion failed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (scenario of ['account', 'create', 'unauthorized', 'extension', 'hash', 'size', 'version', 'source', 'url', 'redirect']) {
      requests = []; handlerError = undefined;
      const result = await run(process.env.CX_NATIVE_ADAPTER_EXE, {
        CX_ADAPTER_TEST_BASE: `http://127.0.0.1:${server.address().port}/adapter-service`,
        CX_ADAPTER_TEST_SCENARIO: scenario
      });
      if (handlerError) throw handlerError;
      assert.equal(result.code, 0, `${scenario}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /NATIVE ADAPTER TESTS PASS/);
      if (scenario === 'account') assert.equal(requests.length, 8);
      if (scenario === 'unauthorized') assert.equal(requests.length, 1, 'unauthorized listing must not create any token');
      if (['extension', 'hash', 'size'].includes(scenario)) assert.equal(requests.length, 2, 'latest and exact query download must both run');
      if (['version', 'source', 'url', 'redirect'].includes(scenario)) assert.equal(requests.length, 1, 'invalid metadata or redirects must not download');
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('native account HWND supports DPI, keyboard limits, icons and safe in-flight close or quit', {
  skip: !process.env.CX_NATIVE_ACCOUNT_WINDOW_EXE || process.env.CX_TEST_NATIVE_WINDOW !== '1',
  timeout: 120_000
}, async () => {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/adapter-service/search/health');
    assert.equal(req.headers.authorization, 'Bearer tk_mock-existing');
    requestCount++;
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }, 300);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [scenario, dpi] of [['cancel', '96'], ['accept', '96'], ['close', '144'], ['quit', '192']]) {
      const result = await run(process.env.CX_NATIVE_ACCOUNT_WINDOW_EXE, {
        CX_ADAPTER_TEST_BASE: `http://127.0.0.1:${server.address().port}`,
        CX_ACCOUNT_TEST_SCENARIO: scenario, CXPLUS_NATIVE_UI_DPI: dpi
      });
      assert.equal(result.code, 0, `${scenario}/${dpi}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /NATIVE ACCOUNT WINDOW TESTS PASS/);
    }
    assert.equal(requestCount, 3, 'cancel must not request; accept, close and quit each complete exactly one request');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
