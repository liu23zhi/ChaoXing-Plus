import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.env.CX_NATIVE_HOST_EXE;
const nativeTest = (name, run) => test(name, { skip: !executable }, run);

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'cx-native-self-check-中文 空格-'));
  try {
    const host = join(directory, 'chaoxing_plus.exe');
    await copyFile(executable, host);
    const invoke = (...args) => spawnSync(host, ['--self-check', ...args], {
      cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10000
    });
    return await run({ directory, host, invoke });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function report(result, status = 0) {
  assert.equal(result.status, status, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(value.mode, 'self-check');
  assert.equal(value.host, 'native');
  assert.equal(value.version, '0.1.0');
  assert.equal(value.success, status === 0);
  assert.deepEqual(value.scope, { discoveryScan: false, launch: false, connect: false, write: false });
  assert.ok(Array.isArray(value.checks));
  assert.ok(Array.isArray(value.failures));
  assert.ok(Array.isArray(value.warnings));
  for (const check of value.checks) {
    assert.equal(typeof check.id, 'string');
    assert.equal(typeof check.ok, 'boolean');
    assert.ok(['passed', 'failed', 'warning', 'skipped'].includes(check.status));
    assert.equal(typeof check.detail, 'string');
  }
  return value;
}

async function externalAssets(directory, bundle = 'window.__selfCheckFixtureBundle=true;') {
  const assets = join(directory, 'assets');
  await mkdir(join(assets, 'vendor'), { recursive: true });
  await Promise.all([
    writeFile(join(assets, 'windows-bootstrap.js'), 'window.__selfCheckFixtureBootstrap=true;'),
    writeFile(join(assets, 'chaoxing-plus.windows.js'), bundle),
    writeFile(join(assets, 'trampoline.js'), '(function(){return true;})();'),
    writeFile(join(assets, 'vendor/sweetalert2.min.css'), '.swal2-container{position:fixed;}')
  ]);
  return assets;
}

nativeTest('native self-check works from a standalone EXE without scanning, launching or writing outputs', async () => {
  await fixture(async ({ directory, invoke }) => {
    const result = invoke('--ui', 'gui', '--scan-mode', 'all', '--log', '--diagnose', '--report', 'must-not-exist.json');
    const value = report(result);
    assert.deepEqual(value.failures, []);
    for (const id of ['configuration', 'architecture', 'permissions', 'embedded-resources',
      'windows-bootstrap.js', 'chaoxing-plus.windows.js', 'trampoline.js', 'sweetalert2.min.css', 'resource-limits', 'port']) {
      assert.ok(value.checks.some((check) => check.id === id), `missing self-check ${id}`);
    }
    assert.ok(value.warnings.includes('client'), 'without an explicit client self-check must warn instead of scanning');
    assert.ok(value.port > 0);
    assert.deepEqual(await readdir(directory), ['chaoxing_plus.exe']);
  });
});

nativeTest('native self-check validates an explicit Unicode client path without executing it', async () => {
  await fixture(async ({ directory, host, invoke }) => {
    const installation = join(directory, '客户端副本');
    await mkdir(installation);
    const client = join(installation, 'CXExam.exe');
    await copyFile(host, client);
    const before = await readFile(client);
    const value = report(invoke('--client', installation, '--no-disk-write'));
    const check = value.checks.find((item) => item.id === 'client');
    assert.equal(check.status, 'passed');
    assert.equal(check.detail, 'x86');
    assert.deepEqual(await readFile(client), before);
    assert.deepEqual((await readdir(directory)).sort(), ['chaoxing_plus.exe', '客户端副本'].sort());
  });
});

nativeTest('native self-check reports invalid clients without exposing paths or configuration values', async () => {
  await fixture(async ({ directory, invoke }) => {
    const secret = 'native-self-check-secret-47318';
    const client = join(directory, secret, 'CXExam.exe');
    const result = invoke('--client', client, '--options-json', JSON.stringify({
      settings: { 'common.settings.tiku-adapter.key': secret }
    }));
    const value = report(result, 1);
    assert.ok(value.failures.includes('client'));
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stdout.includes(directory), false);
    assert.deepEqual(await readdir(directory), ['chaoxing_plus.exe']);
  });
});

nativeTest('native self-check rejects missing explicit resources without silently falling back', async () => {
  await fixture(async ({ directory, invoke }) => {
    const value = report(invoke('--assets', join(directory, 'missing-assets'), '--no-disk-write'), 1);
    for (const id of ['windows-bootstrap.js', 'chaoxing-plus.windows.js', 'trampoline.js', 'sweetalert2.min.css']) {
      assert.ok(value.failures.includes(id), `missing explicit asset must fail: ${id}`);
    }
    assert.deepEqual(await readdir(directory), ['chaoxing_plus.exe']);
  });
});

nativeTest('native self-check uses complete explicit resources and keeps configuration errors distinct', async () => {
  await fixture(async ({ directory, invoke }) => {
    const assets = await externalAssets(directory);
    const value = report(invoke('--assets', assets));
    for (const id of ['windows-bootstrap.js', 'chaoxing-plus.windows.js', 'trampoline.js', 'sweetalert2.min.css']) {
      const check = value.checks.find((item) => item.id === id);
      assert.equal(check.status, 'passed');
      assert.match(check.detail, /Explicit external/);
    }
    const configuration = join(directory, 'bad-config.json');
    const original = '{"settings":{"common.settings.tiku-adapter.key":"private-self-check-key"';
    await writeFile(configuration, original);
    const invalid = invoke('--config', configuration);
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout.includes('private-self-check-key'), false);
    assert.equal(await readFile(configuration, 'utf8'), original);
    assert.deepEqual((await readdir(directory)).sort(), ['assets', 'bad-config.json', 'chaoxing_plus.exe'].sort());
  });
});

nativeTest('native self-check detects resource sizes that ordinary injection would reject', async () => {
  await fixture(async ({ directory, invoke }) => {
    const assets = await externalAssets(directory, ' '.repeat(2 * 1024 * 1024));
    const value = report(invoke('--assets', assets), 1);
    assert.ok(value.failures.includes('resource-limits'));
  });
});

nativeTest('native self-check detects an occupied explicit port and never connects to attach endpoints', async () => {
  await fixture(async ({ invoke }) => {
    let connections = 0;
    const server = createServer((socket) => { ++connections; socket.destroy(); });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const port = server.address().port;
    try {
      const busy = report(invoke('--port', String(port)), 1);
      assert.ok(busy.failures.includes('port'));
      const attached = report(invoke('--attach', String(port)));
      assert.equal(attached.checks.find((check) => check.id === 'port').status, 'skipped');
      await delay(50);
      assert.equal(connections, 0);
    } finally {
      await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
    }
  });
});

nativeTest('native self-check keeps quiet output empty and still rejects unsupported execution requests', async () => {
  await fixture(async ({ invoke }) => {
    const quiet = invoke('--quiet', '--no-disk-write');
    assert.equal(quiet.status, 0, quiet.error?.message);
    assert.equal(quiet.stdout + quiet.stderr, '');
    // 内存执行与删除挂起均已支持；自检不启动清理。
    const suspend = invoke('--delete-suspend');
    assert.equal(suspend.status, 0, suspend.stdout + suspend.stderr);
    assert.equal(JSON.parse(suspend.stdout).mode, 'self-check');
  });
});
