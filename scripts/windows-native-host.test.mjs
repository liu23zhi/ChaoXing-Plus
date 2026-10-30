import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'windows', 'native-source');

test('native host sources expose ordinary auditable execution boundaries', async () => {
  const [main, adapter, options, build] = await Promise.all([
    fs.readFile(path.join(native, 'host.c'), 'utf8'),
    fs.readFile(path.join(native, 'host-session.inc'), 'utf8'),
    fs.readFile(path.join(native, 'options.c'), 'utf8'),
    fs.readFile(path.join(root, 'windows', 'native-source', 'build.ps1'), 'utf8')
  ]);
  const host = main + adapter;
  assert.match(host, /proc_launch\s*\(/);
  assert.match(host, /net_http_get_timeout\s*\(/);
  assert.match(host, /net_ws_open_timeout\s*\(/);
  assert.match(host, /Runtime\.evaluate/);
  assert.ok(/h_collect_page_diagnostics\(page\)/.test(host), 'native host must sample page diagnostics after a top-level bundle');
  assert.ok(/static void h_collect_page_diagnostics\(/.test(host), 'native host must define the page diagnostics collector');
  assert.ok(/cx_diagnostics_write_page_json\(/.test(host), 'native host must persist the diagnostics schema through the module');
  assert.ok(/if \(task\.top\).*h_collect_page_diagnostics/s.test(host), 'only top-level bundle tasks may trigger diagnostics');
  assert.ok(/Page diagnostics sample failed; continuing without page diagnostics/.test(host), 'diagnostic failure must remain non-fatal');
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
  assert.match(options, /cx_valid_mode\(const WCHAR \*value\)[\s\S]{0,160}L"memory"/u);
  assert.match(options, /cx_json_execution_mode\(CX_OPTIONS \*o/u);
  assert.match(options, /delete-suspend\/wipe\/self-destruct flags are not supported by the native host/);
  assert.match(host, /executionModeMemory \? "memory" : "normal"/u);

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
  for (const regression of [
    'HTTP transport receives only the remaining run budget',
    'late HTTP response is discarded at the run deadline',
    'expired run budget performs no HTTP request',
    'late version response cannot pass the endpoint deadline',
    'run expiry before endpoint has a distinct stop reason',
    'owned client exit before endpoint is not reported as timeout',
    'WebSocket Upgrade receives only the remaining run budget',
    'late Upgrade leaves no session or CDP command',
    'client exit during Upgrade leaves no session or CDP command',
    'expired run budget performs no WebSocket Upgrade',
    'endpoint probe distinguishes no listener',
    'endpoint probe distinguishes foreign ownership',
    'endpoint probe distinguishes listener query failure',
    'endpoint probe distinguishes rejected binding',
    'endpoint probe retains HTTP failure beside duration stop reason',
    'endpoint probe separates invalid version from browser mismatch',
    'endpoint probe records valid but mismatched browser'
  ]) assert.ok(result.stdout.includes(`PASS ${regression}`), result.stdout);
});

test('native host build output is not treated as a checked-in artifact', async () => {
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /windows\/native-build\//);
  assert.doesNotMatch(ignore, /^build-windows\/$/mu);
});

test('compiled native common discovery does not crash while reading default environment roots', {
  skip: !process.env.CX_NATIVE_HOST_EXE
}, () => {
  const result = spawnSync(process.env.CX_NATIVE_HOST_EXE, ['--list-clients', '--scan-mode', 'common', '--quiet', '--no-disk-write'], {
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
}, async () => {
  const executable = process.env.CX_NATIVE_HOST_EXE;
  const run = (...args) => spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true
  });

  const help = run('--help');
  assert.equal(help.status, 0, help.stderr || `help exited with ${help.status}`);
  assert.match(help.stdout, /超星学习助手 Windows 宿主/);
  assert.equal(help.stdout.includes('不采集窗口 DPI'), false, 'stale help must not deny implemented window diagnostics');
  assert.match(help.stdout, /页面截图/u);
  for (const flag of ['--version', '--client-index', '--select-client', '--scan-mode', '--scan-clients', '--scan-all', '--no-scan-all', '--answer-retry', '--inject-strategy', '--attach', '--duration']) {
    assert.ok(help.stdout.includes(flag), `missing native help: ${flag}`);
  }

  const version = run('--version');
  assert.equal(version.status, 0, version.stderr || `version exited with ${version.status}`);
  assert.equal(version.stdout.trim(), '6.2.0');

  const capabilities = run('--capabilities');
  assert.equal(capabilities.status, 0, capabilities.stderr || `capabilities exited with ${capabilities.status}`);
  const nativeCapabilities = JSON.parse(capabilities.stdout);
  assert.equal(nativeCapabilities.host, 'native');
  assert.equal(nativeCapabilities.embeddedResources, true);
  assert.equal(nativeCapabilities.embeddedResourceCount, 5);
  assert.equal(nativeCapabilities.embeddedProxy, true);
  assert.equal(nativeCapabilities.nativeSelection, true);
  assert.equal(nativeCapabilities.highDpiUi, true);
  assert.equal(nativeCapabilities.contextLifecycle, true);
  assert.equal(nativeCapabilities.navigation, true);
  assert.equal(nativeCapabilities.targetReconnect, true);
  assert.equal(nativeCapabilities.configReload, true);
  assert.equal(nativeCapabilities.configPersistence, true);
  assert.equal(nativeCapabilities.fileLogging, true);
  assert.equal(nativeCapabilities.runReport, true);
  assert.equal(nativeCapabilities.renderDiagnostics, false);
  assert.equal(nativeCapabilities.pageRenderDiagnostics, true);
  assert.equal(nativeCapabilities.pageScreenshots, true);
  assert.equal(nativeCapabilities.windowDiagnostics, true);
  assert.equal(nativeCapabilities.diagnosticsSummary, true);
  assert.equal(nativeCapabilities.selfCheck, true);
  assert.equal(nativeCapabilities.retainData, true);
  assert.equal(nativeCapabilities.deleteConfig, true);

  const config = run('--print-effective-config', '--no-disk-write');
  assert.equal(config.status, 0, config.stderr || `config exited with ${config.status}`);
  assert.equal(JSON.parse(config.stdout)['common.settings.windows-no-disk-write'], true);

  const unsupported = run('--wipe-owned-files-on-start');
  assert.equal(unsupported.status, 2, unsupported.stderr || `unsupported option exited with ${unsupported.status}`);
  assert.match(unsupported.stdout, /not supported/);

  // 原生宿主现已支持数据生命周期；delete-config 仍要求显式 --config。
  const retained = run('--print-effective-config', '--no-retain-data');
  assert.equal(retained.status, 0, retained.stderr || retained.stdout);
  const retainedJson = run('--print-effective-config', '--options-json', '{"retainData":false}');
  assert.equal(retainedJson.status, 0, retainedJson.stderr || retainedJson.stdout);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-native-lifecycle-config-'));
  try {
    const configPath = path.join(directory, 'chaoxing-plus.json');
    await fs.writeFile(configPath, '{"settings":{"common.settings.extension-enabled":true}}', 'utf8');
    const withoutConfig = run('--delete-config');
    assert.equal(withoutConfig.status, 2, 'delete-config without --config must fail before launching a client');
    assert.match(withoutConfig.stdout, /explicit --config/);
    const withConfig = run('--print-effective-config', '--config', configPath, '--delete-config');
    assert.equal(withConfig.status, 0, withConfig.stderr || withConfig.stdout);
    const jsonWithConfig = run('--print-effective-config', '--config', configPath, '--options-json', '{"deleteConfig":true}');
    assert.equal(jsonWithConfig.status, 0, jsonWithConfig.stderr || jsonWithConfig.stdout);
    const jsonWithoutConfig = run('--print-effective-config', '--options-json', '{"deleteConfig":true}');
    assert.equal(jsonWithoutConfig.status, 2, 'JSON delete-config without --config must fail');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('compiled native listing writes only an explicitly requested report', {
  skip: !process.env.CX_NATIVE_HOST_EXE
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-native-list-audit-'));
  try {
    const run = (...args) => spawnSync(process.env.CX_NATIVE_HOST_EXE, [
      '--list-clients', '--scan-mode', 'common', '--quiet', ...args
    ], { cwd: directory, encoding: 'utf8', timeout: 20_000, windowsHide: true });
    const plain = run();
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.deepEqual(await fs.readdir(directory), [], 'pure listing must not create default logs');

    const before = Date.now();
    const reported = run('--report', 'scan-report.json');
    const after = Date.now();
    assert.equal(reported.status, 0, reported.stdout + reported.stderr);
    assert.equal(reported.stdout, plain.stdout, 'audit events must not pollute the candidate list');
    assert.deepEqual(await fs.readdir(directory), ['scan-report.json']);
    const report = JSON.parse(await fs.readFile(path.join(directory, 'scan-report.json'), 'utf8'));
    assert.equal(report.stopReason, 'list-clients');
    assert.equal(report.success, true);
    assert.equal(report.clientPid, 0);
    assert.equal(report.totals.errors, 0);
    assert.ok(Date.parse(report.startedAt) >= before && Date.parse(report.finishedAt) <= after);
    assert.ok(Math.abs(Date.parse(report.finishedAt) - Date.parse(report.startedAt) - report.durationMs) < 100);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('compiled native startup failure retains its exit code and a redacted report', {
  skip: !process.env.CX_NATIVE_HOST_EXE
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cx-native-failure-audit-'));
  try {
    const privatePath = path.join(directory, 'private-client-canary', 'CXExam.exe');
    const result = spawnSync(process.env.CX_NATIVE_HOST_EXE, [
      '--client', privatePath, '--no-log', '--quiet', '--report', 'failure-report.json'
    ], { cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout + result.stderr, '');
    assert.deepEqual(await fs.readdir(directory), ['failure-report.json']);
    const text = await fs.readFile(path.join(directory, 'failure-report.json'), 'utf8');
    const report = JSON.parse(text);
    assert.equal(report.stopReason, 'discovery-failed');
    assert.equal(report.success, false);
    assert.equal(report.clientPid, 0);
    assert.equal(report.totals.errors, 1);
    assert.doesNotMatch(text, /private-client-canary/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native host embeds a DPI-aware asInvoker manifest', { skip: !process.env.CX_NATIVE_HOST_EXE }, async () => {
  const bytes = await fs.readFile(process.env.CX_NATIVE_HOST_EXE);
  const text = bytes.toString('latin1');
  assert.ok(text.includes('ChaoxingPlus.NativeHost'), 'host manifest identity must be embedded');
  assert.ok(text.includes('dpiAware'), 'host manifest must declare DPI awareness');
  assert.ok(text.includes('asInvoker'), 'host manifest must keep the standard asInvoker execution level');
});




