import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

test('compiled native script lease binds identity, heartbeat and the fixed deadline', {
  skip: !process.env.CX_NATIVE_SCRIPT_LEASE_EXE
}, async (t) => {
  let received = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.ok(['/heartbeat', '/slow-heartbeat'].includes(req.url));
    assert.equal(req.headers.authorization, 'Bearer sr_fixture');
    assert.match(req.headers['x-script-identity'], /^[a-f0-9]{64}$/u);
    ++received;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/slow-heartbeat') {
      res.write('{');
      const timer = setInterval(() => res.write(' '), 30);
      res.once('close', () => clearInterval(timer));
      return;
    }
    res.end('{"expiresAt":"2099-01-01T00:00:00Z"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.env.CX_NATIVE_SCRIPT_LEASE_EXE, [], {
    windowsHide: true,
    env: { ...process.env, CX_SCRIPT_LEASE_TEST_ORIGIN: `http://127.0.0.1:${server.address().port}` }
  });
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('native lease fixture timed out')); }, 15000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(result, 0, output);
  assert.match(output, /NATIVE SCRIPT LEASE TESTS PASS/u);
  assert.doesNotMatch(output, /^FAIL /mu);
  assert.equal(received, 2);
});
