import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

const databaseScript = resolveTestPath('scripts', 'windows-client-database.ps1');
const injectionScript = resolveTestPath('scripts', 'windows-real-client-injection.ps1');
const windowsOnly = process.platform === 'win32' ? undefined : '仅在 Windows 上执行 PowerShell 数据库安装脚本';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// The payload mirrors the real fixture: a SQLite database with the documented file signature.
function sqlitePayload(length = 4096) {
  const payload = Buffer.alloc(Math.max(length, 16));
  Buffer.from('SQLite format 3\u0000', 'latin1').copy(payload, 0);
  for (let index = 16; index < payload.length; index++) payload[index] = index % 251;
  return payload;
}

function clientDirectory(label) {
  const root = createTestDirectory('client-database');
  const directory = path.join(root, label, 'Chaoxing Exam');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'CXExam.exe'), Buffer.from('MZ fake exam client'));
  return { root, directory };
}

const payloads = {
  install: sqlitePayload(),
  overwrite: sqlitePayload(2048),
  opaque: Buffer.from('not a sqlite database at all')
};

// One PowerShell process covers every scenario: the unit job runs at concurrency 2 next to real
// Chromium suites, so spawning one pwsh/powershell per assertion adds avoidable scheduling noise.
const scenarios = windowsOnly ? null : (() => {
  const install = clientDirectory('install');
  const overwrite = clientDirectory('overwrite');
  const opaque = clientDirectory('opaque');
  const legacy = clientDirectory('legacy');
  const empty = clientDirectory('empty');
  const missingRoot = createTestDirectory('client-database');
  const missing = { root: missingRoot, directory: path.join(missingRoot, 'package') };
  mkdirSync(missing.directory, { recursive: true });
  writeFileSync(path.join(overwrite.directory, 'UserExamInfo.db'), Buffer.from('stale database fixture'));
  return { install, overwrite, opaque, legacy, empty, missing };
})();

let pendingResults;

function results() {
  if (pendingResults) return pendingResults;
  const wrapped = `${payloads.overwrite.toString('base64').replace(/(.{48})/gu, '$1\r\n')}  \r\n`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(databaseScript)}`,
    `$out = [ordered]@{}`,
    `$out.install = Install-ClientDatabase -ClientDirectory ${psQuote(scenarios.install.directory)} -Base64 ${psQuote(payloads.install.toString('base64'))}`,
    `$out.overwrite = Install-ClientDatabase -ClientDirectory ${psQuote(scenarios.overwrite.directory)} -Base64 ${psQuote(wrapped)}`,
    `$out.opaque = Install-ClientDatabase -ClientDirectory ${psQuote(scenarios.opaque.directory)} -Base64 ${psQuote(payloads.opaque.toString('base64'))}`,
    `try { Install-ClientDatabase -ClientDirectory ${psQuote(scenarios.legacy.directory)} -Base64 'enabled' | Out-Null; $out.legacy = 'NO_ERROR' } catch { $out.legacy = $_.Exception.Message }`,
    `try { Install-ClientDatabase -ClientDirectory ${psQuote(scenarios.empty.directory)} -Base64 '' | Out-Null; $out.empty = 'NO_ERROR' } catch { $out.empty = $_.Exception.Message }`,
    `try { Install-ClientDatabase -ClientDirectory ${psQuote(scenarios.missing.directory)} -Base64 ${psQuote(payloads.install.toString('base64'))} | Out-Null; $out.missing = 'NO_ERROR' } catch { $out.missing = $_.Exception.Message }`,
    '$out | ConvertTo-Json -Compress -Depth 4'
  ].join('\n');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (result.error) throw result.error;
  const line = String(result.stdout)
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.startsWith('{'))
    .pop();
  assert.ok(line, `脚本必须输出安装结果: ${result.stdout}${result.stderr}`);
  pendingResults = { result, json: JSON.parse(line) };
  return pendingResults;
}

test('Base64 变量解码后直接写成 CXExam.exe 同目录的 UserExamInfo.db', { skip: windowsOnly }, () => {
  const { result, json } = results();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(json.install.Path, path.join(scenarios.install.directory, 'UserExamInfo.db'),
    '数据库必须写在 CXExam.exe 同目录');
  assert.equal(json.install.ClientPath, path.join(scenarios.install.directory, 'CXExam.exe'));
  assert.equal(json.install.Bytes, payloads.install.length, '日志中的字节数必须等于解码后的载荷长度');
  assert.equal(json.install.Sqlite, true, '真实 UserExamInfo.db 必须被识别为 SQLite 文件');
  assert.deepEqual(readFileSync(json.install.Path), payloads.install, '写入内容必须与 Base64 解码结果逐字节一致');
  assert.match(result.stdout, /written directly beside CXExam\.exe/u, '日志必须说明数据库写在 CXExam.exe 同目录');
});

test('换行的 Base64 仍被接受，并覆盖已有的 UserExamInfo.db', { skip: windowsOnly }, () => {
  const { json } = results();
  assert.equal(json.overwrite.Bytes, payloads.overwrite.length);
  assert.deepEqual(readFileSync(json.overwrite.Path), payloads.overwrite,
    '变量里的换行与空白必须被忽略，旧文件必须被覆盖');
});

test('未知格式的载荷仍然写入，但签名标记为非 SQLite', { skip: windowsOnly }, () => {
  const { json } = results();
  assert.equal(json.opaque.Sqlite, false, '签名无法识别时只记录，不阻断注入');
  assert.deepEqual(readFileSync(json.opaque.Path), payloads.opaque);
});

test('旧的 enabled 标记、空载荷与缺少 CXExam.exe 都必须失败关闭', { skip: windowsOnly }, () => {
  const { json } = results();
  assert.match(json.legacy, /not valid Base64 text/u, 'enabled 标记必须被拒绝并说明需要 Base64 文本');
  assert.match(json.empty, /Base64 payload is empty/u);
  assert.match(json.missing, /has no CXExam\.exe/u, '没有 CXExam.exe 时不得写出数据库');
  for (const value of [json.legacy, json.empty, json.missing]) {
    assert.doesNotMatch(value, /NO_ERROR/u, '每条失败路径都必须抛出错误');
  }
});

test('注入脚本复用数据库安装助手，两个脚本都保持纯 ASCII', async () => {
  const script = await readFile(injectionScript, 'utf8');
  assert.match(script, /\.\s*\(Join-Path \$PSScriptRoot 'windows-client-database\.ps1'\)/u,
    '注入脚本必须 dot-source 数据库安装助手');
  assert.match(script, /Install-ClientDatabase -ClientDirectory \$clientDirectory -Base64 \$base64/u,
    '注入脚本必须调用同一安装函数，不能自行解码');
  assert.doesNotMatch(script, /Expand-Archive|database\.zip|FromBase64String/u,
    '数据库载荷不允许再按 ZIP 解压或在注入脚本里重复解码');

  for (const file of [databaseScript, injectionScript]) {
    const bytes = readFileSync(file);
    for (const byte of bytes) assert.equal(byte <= 0x7f, true, `${path.basename(file)} 必须保持纯 ASCII`);
  }
});
