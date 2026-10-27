import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'windows', 'native');

test('native host sources expose ordinary auditable execution boundaries', async () => {
  const [main, adapter, options, build] = await Promise.all([
    fs.readFile(path.join(native, 'host.c'), 'utf8'),
    fs.readFile(path.join(native, 'host-session.inc'), 'utf8'),
    fs.readFile(path.join(native, 'options.c'), 'utf8'),
    fs.readFile(path.join(native, 'build.ps1'), 'utf8')
  ]);
  const host = main + adapter;
  assert.match(host, /proc_launch\s*\(/);
  assert.match(host, /net_http_get\s*\(/);
  assert.match(host, /net_ws_open\s*\(/);
  assert.match(host, /Runtime\.evaluate/);
  assert.match(host, /windows-bootstrap\.js/);
  assert.match(host, /chaoxing-plus\.windows\.js/);
  assert.match(host, /WinMainCRTStartup/);
  assert.match(host, /h_base_options\.help/);
  assert.match(host, /h_base_options\.capabilities/);
  assert.match(host, /h_base_options\.printEffectiveConfig/);
  assert.match(host, /h_choose_port\(options/);
  assert.match(host, /static char h_settings\[CX_OPTIONS_JSON_CAP\]/);
  assert.doesNotMatch(host, /char settings\[CX_OPTIONS_JSON_CAP\]/);
  assert.match(host, /WriteFile\(out, utf8/);
  assert.match(options, /memory and delete-suspend execution are not supported/);
  assert.match(options, /wipe, memory and self-destruct options are not supported/);
  assert.match(build, /\/NODEFAULTLIB/);
  assert.match(build, /\/MACHINE:X86/);
  assert.match(build, /SkipAssetCopy/);
});

test('compiled native injection honors strategy order, retry limits and unique request IDs', {
  skip: !process.env.CX_NATIVE_INJECTION_EXE
}, () => {
  const result = spawnSync(process.env.CX_NATIVE_INJECTION_EXE, [], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NATIVE INJECTION TESTS PASS/);
});

test('native host build output is not treated as a checked-in artifact', async () => {
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /\.tmp-native-host/);
});

test('compiled native common discovery does not crash while reading default environment roots', {
  skip: !process.env.CX_NATIVE_HOST_EXE
}, () => {
  const result = spawnSync(process.env.CX_NATIVE_HOST_EXE, ['--list-clients', '--scan-mode', 'common', '--quiet'], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true
  });
  assert.ok([0, 1].includes(result.status), `unexpected exit ${result.status}: ${result.stdout}\n${result.stderr}`);
});

test('compiled native explicit index never opens auto GUI with redirected input', {
  skip: !process.env.CX_NATIVE_HOST_EXE
}, () => {
  const result = spawnSync(process.env.CX_NATIVE_HOST_EXE, [
    '--scan-mode', 'common', '--client-index', '2147483647', '--ui', 'auto', '--no-disk-write'
  ], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  assert.equal(result.status, 1, `index must fail before showing GUI: ${result.error ?? ''} ${result.stdout}`);
  assert.match(result.stdout, /client-index is outside|no valid CXExam/);
});

test('native host CLI writes help and machine-readable output to redirected stdout', {
  skip: !process.env.CX_NATIVE_HOST_EXE
}, () => {
  const executable = process.env.CX_NATIVE_HOST_EXE;
  const run = (...args) => spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true
  });

  const help = run('--help');
  assert.equal(help.status, 0, help.stderr || `help exited with ${help.status}`);
  assert.match(help.stdout, /超星学习助手 Windows 宿主/);
  for (const flag of ['--client-index', '--select-client', '--scan-mode', '--inject-strategy', '--attach', '--duration']) {
    assert.ok(help.stdout.includes(flag), `missing native help: ${flag}`);
  }

  const capabilities = run('--capabilities');
  assert.equal(capabilities.status, 0, capabilities.stderr || `capabilities exited with ${capabilities.status}`);
  const nativeCapabilities = JSON.parse(capabilities.stdout);
  assert.equal(nativeCapabilities.host, 'native');
  assert.equal(nativeCapabilities.embeddedResources, true);
  assert.equal(nativeCapabilities.embeddedResourceCount, 4);
  assert.equal(nativeCapabilities.nativeSelection, true);
  assert.equal(nativeCapabilities.contextLifecycle, true);
  assert.equal(nativeCapabilities.navigation, true);
  assert.equal(nativeCapabilities.targetReconnect, true);
  assert.equal(nativeCapabilities.configReload, false);
  assert.equal(nativeCapabilities.fileLogging, false);

  const config = run('--print-effective-config', '--no-disk-write');
  assert.equal(config.status, 0, config.stderr || `config exited with ${config.status}`);
  assert.equal(JSON.parse(config.stdout)['common.settings.windows-no-disk-write'], true);

  const unsupported = run('--wipe-owned-files-on-start');
  assert.equal(unsupported.status, 2, unsupported.stderr || `unsupported option exited with ${unsupported.status}`);
  assert.match(unsupported.stdout, /not supported/);

  for (const args of [
    ['--no-retain-data'], ['--delete-config'], ['--self-check'],
    ['--options-json', '{"retainData":false}'],
    ['--options-json', '{"deleteConfig":true}']
  ]) {
    const result = run('--print-effective-config', ...args);
    assert.equal(result.status, 2, `${args.join(' ')} must fail before launching a client`);
    assert.match(result.stdout, /not supported by native host/);
  }
});
