import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildElevatedRelaunchCommand } from '../windows/host/launch.mjs';

for (const shell of ['powershell.exe', 'pwsh.exe']) {
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
