import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NtExecutable, NtExecutableResource } from 'pe-library';
import { Data, Resource } from 'resedit';
import { buildNodeExe, collectPayload } from '../windows/node-source/package-node-exe.mjs';
import { buildElevatedRelaunchCommand } from '../windows/node-source/launch.mjs';
import { buildPowerShellScriptArgs } from '../windows/node-source/embedded-scripts.mjs';

const root = path.resolve('.');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const icon = path.join(root, 'windows/share-file/assets/app-icon.ico');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cx-sea-中文 O'Brien & "));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const distDir = path.join(directory, 'dist');
  await fs.mkdir(path.join(distDir, 'vendor'), { recursive: true });
  for (const name of ['windows-bootstrap.js', 'chaoxing-plus.windows.js', 'trampoline.js', 'vendor/sweetalert2.min.css']) {
    await fs.writeFile(path.join(distDir, name), `/* ${name} */`);
  }
  await fs.writeFile(path.join(distDir, 'package-manifest.json'), JSON.stringify({ version }));
  return { directory, version, hostDir: path.join(root, 'windows/node-source'), scriptsDir: path.join(root, 'windows/node-scripts'), distDir,
    configExample: path.join(root, 'windows/share-file/config.example.json'), icon,
    buildDir: path.join(directory, 'build'), out: path.join(directory, 'release') };
}

function assertIcon(executableBytes, iconBytes) {
  const resources = NtExecutableResource.from(NtExecutable.from(executableBytes));
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  assert.equal(groups.length, 1);
  const embedded = groups[0].getIconItemsFromEntries(resources.entries);
  const expected = Data.IconFile.from(iconBytes).icons;
  assert.equal(embedded.length, expected.length);
  for (let index = 0; index < embedded.length; index += 1) {
    assert.deepEqual(Buffer.from(embedded[index].generate()), Buffer.from(expected[index].data.generate()));
  }
}

test('SEA payload rejects debug or stale injection resources and external host imports', async (t) => {
  const options = await fixture(t);
  const manifest = path.join(options.distDir, 'package-manifest.json');
  for (const value of [{ version: '0.0.0' }, { version, features: { injectionLog: true } }]) {
    await fs.writeFile(manifest, JSON.stringify(value));
    await assert.rejects(collectPayload(options), /must match the version and disable injectionLog/u);
  }
  await fs.writeFile(manifest, JSON.stringify({ version }));
  const hostDir = path.join(options.directory, 'bad-host');
  await fs.mkdir(hostDir);
  await fs.writeFile(path.join(hostDir, 'main.mjs'), "import unsafe from 'external-package';");
  await assert.rejects(collectPayload({ ...options, hostDir }), /External host dependency/u);
});

test('Node single EXE runs alone with embedded assets, scripts, icon and preserved JSON arguments', {
  skip: process.platform !== 'win32', timeout: 120000
}, async (t) => {
  const options = await fixture(t);
  const summary = await buildNodeExe(options);
  assert.equal(summary.version, version);
  const bytes = await fs.readFile(summary.executable);
  assertIcon(bytes, await fs.readFile(icon));
  // Move only the EXE; remove every build/payload file before running it.
  const isolated = path.join(options.directory, 'isolated');
  await fs.mkdir(isolated);
  const executable = path.join(isolated, '超星助手.exe');
  await fs.copyFile(summary.executable, executable);
  await fs.rm(options.buildDir, { recursive: true, force: true });
  await fs.rm(options.out, { recursive: true, force: true });
  await fs.rm(options.distDir, { recursive: true, force: true });
  const system32 = path.join(process.env.SystemRoot, 'System32');
  const environment = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '',
    PATH: [system32, path.join(system32, 'WindowsPowerShell/v1.0')].join(path.delimiter) };
  const run = (args) => {
    const result = spawnSync(executable, args, { cwd: isolated, env: environment,
      encoding: 'utf8', windowsHide: true, timeout: 45000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  assert.equal(run(['--version']).trim(), version);
  assert.match(run(['--help']), /--self-check/u);
  assert.equal(JSON.parse(run(['--capabilities'])).hostVersion, version);
  const key = 'common.settings.sea-test';
  const value = '中文 "引号" O\'Brien & $() `text` \\';
  const args = ['--print-effective-config', '--no-disk-write', '--options-json', JSON.stringify({ settings: { [key]: value } })];
  assert.equal(JSON.parse(run(args))[key], value);
  const output = run(['--self-check', '--no-disk-write']);
  const report = JSON.parse(output.slice(output.indexOf('{')));
  assert.deepEqual(report.failures, []);
  assert.equal(report.checks.filter((item) => item.name.startsWith('资源存在')).every((item) => item.ok && item.detail.includes('内嵌')), true);
  assert.equal(report.checks.find((item) => item.name.includes('PowerShell')).ok, true);
  assert.equal(report.checks.find((item) => item.name.includes('PowerShell')).iconApplied, true);
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const command = buildElevatedRelaunchCommand({ scriptPath: '', args, cwd: isolated, nodeExecutable: executable })
      .replace(/-Verb RunAs -WindowStyle Normal$/u, '-NoNewWindow -Wait');
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' + command], {
      cwd: isolated, encoding: 'utf8', windowsHide: true, timeout: 30000
    });
    if (shell === 'pwsh.exe' && result.error?.code === 'ENOENT') continue;
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout)[key], value);
  }
  assert.deepEqual(await fs.readdir(isolated), ['超星助手.exe'], 'Read-only actions must not unpack files or write host data');
});

test('embedded PowerShell preserves named arguments and stdin without a script file', { skip: process.platform !== 'win32' }, () => {
  const previous = globalThis.__CX_SILENT_EMBEDDED_SCRIPTS__;
  try {
    globalThis.__CX_SILENT_EMBEDDED_SCRIPTS__ = { 'probe.ps1':
      'param([string]$Value,[switch]$Probe) @{ value=$Value; probe=[bool]$Probe; input=[Console]::In.ReadToEnd() } | ConvertTo-Json -Compress' };
    const value = '中文 \' " \\ & $()';
    const scriptArgs = buildPowerShellScriptArgs('probe.ps1', 'missing.ps1', { parameters: [['Value', value], ['Probe', true]] });
    assert.equal(scriptArgs[0], '-EncodedCommand');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...scriptArgs], {
      input: '输入中文', encoding: 'utf8', windowsHide: true, timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { value, probe: true, input: '输入中文' });
    assert.deepEqual(buildPowerShellScriptArgs('probe.ps1', 'custom.ps1', { defaultScriptPath: 'missing.ps1' }), ['-File', 'custom.ps1']);
  } finally {
    if (previous === undefined) delete globalThis.__CX_SILENT_EMBEDDED_SCRIPTS__;
    else globalThis.__CX_SILENT_EMBEDDED_SCRIPTS__ = previous;
  }
});

test('native and Node release executables use the same repository icon', async (t) => {
  const native = path.join(root, 'windows/native-build/release/single-file/chaoxing_plus.exe');
  try { await fs.access(native); } catch { return t.skip('Native build is not present'); }
  assertIcon(await fs.readFile(native), await fs.readFile(icon));
  assert.deepEqual(await fs.readFile(native), await fs.readFile(path.join(root, 'windows/native-build/bin/chaoxing_plus.exe')));
});
