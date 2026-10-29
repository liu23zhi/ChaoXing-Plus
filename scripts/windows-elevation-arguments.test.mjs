import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildElevatedRelaunchCommand } from '../windows/node-source/launch.mjs';
import { applyHostOptionLayers, parseHostArgs } from '../windows/node-source/options.mjs';

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  test(`GUI selection survives ${shell} handoff without selecting again`, {
    skip: process.platform !== 'win32'
  }, async (t) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cx-gui-handoff-中文 O'Brien & "));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const selectedClientPath = 'C:\\已选 客户端\\CXExam.exe';
    const inline = JSON.stringify({ clientFirst: true, answerMode: 'manual', answerKey: 'Ctrl+Shift+A' });
    const args = ['--select-client', '--scan-mode', 'all', '--rescan', '--no-scan-cache', '--ui', 'gui', '--options-json', inline, '--no-disk-write'];
    const command = buildElevatedRelaunchCommand({
      scriptPath: path.resolve('scripts/test-helpers/windows-argv-probe.mjs'), args, cwd, selectedClientPath
    });
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); '
        + command.replace(/-Verb RunAs -WindowStyle Normal$/u, '-NoNewWindow -Wait')
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (shell === 'pwsh.exe' && result.error?.code === 'ENOENT') return t.skip('PowerShell 7 is not installed');
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout.split(/\r?\n/u).find(line => line.startsWith('{')));
    assert.deepEqual(output, { args: ['--ui', 'gui', '--options-json', inline, '--no-disk-write', '--client', selectedClientPath, '--elevated'], cwd });
    const parsed = parseHostArgs(output.args);
    const merged = applyHostOptionLayers(parsed, { clientPath: 'C:\\Old\\CXExam.exe', clientIndex: 2 }, JSON.parse(parsed.optionsJson));
    assert.equal(merged.clientPath, selectedClientPath);
    assert.equal(merged.scanClients, false);
    assert.equal(merged.selectClient, false);
    assert.equal(merged.clientFirst, false);
  });

  test(`Node elevation arguments survive ${shell} without requesting elevation`, {
    skip: process.platform !== 'win32'
  }, async (t) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cx-elevation-中文 O'Brien & "));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const args = [
      '--options-json', JSON.stringify({ panel: false, answerKey: 'Ctrl+Alt+Shift+S', value: '中文 "引号" \\' }),
      '--client', 'C:\\Exam Test\\CXExam.exe', '--data-dir', 'C:\\folder with space\\',
      '', 'quote"in"text', String.raw`slash\\"quote`, "O'Brien", '$()', '`echo unsafe`',
      '&|<>^()%CX_ELEVATION_CANARY%!'
    ];
    const command = buildElevatedRelaunchCommand({
      scriptPath: path.resolve('scripts/test-helpers/windows-argv-probe.mjs'), args, cwd
    });
    // Keep the production argument string, replacing only its UAC/window request.
    const withoutElevation = command.replace(/-Verb RunAs -WindowStyle Normal$/u, '-NoNewWindow -Wait');
    assert.notEqual(command, withoutElevation);
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ' + withoutElevation
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (shell === 'pwsh.exe' && result.error?.code === 'ENOENT') return t.skip('PowerShell 7 is not installed');
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout.split(/\r?\n/u).find(line => line.startsWith('{'));
    assert.ok(output, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(output), { args: [...args, '--elevated'], cwd });
  });
}
