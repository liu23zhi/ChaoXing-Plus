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

function runPowerShell(script) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (result.error) throw result.error;
  return result;
}

// The payload mirrors the real fixture: a SQLite database with the documented file signature.
function sqlitePayload(length = 4096) {
  const payload = Buffer.alloc(Math.max(length, 16));
  Buffer.from('SQLite format 3\u0000', 'latin1').copy(payload, 0);
  for (let index = 16; index < payload.length; index++) payload[index] = index % 251;
  return payload;
}

function createClientDirectory() {
  const root = createTestDirectory('client-database');
  const clientDirectory = path.join(root, 'Chaoxing Exam');
  mkdirSync(clientDirectory, { recursive: true });
  writeFileSync(path.join(clientDirectory, 'CXExam.exe'), Buffer.from('MZ fake exam client'));
  return { root, clientDirectory };
}

function install(clientDirectory, base64) {
  const result = runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(databaseScript)}`,
    `$installed = Install-ClientDatabase -ClientDirectory ${psQuote(clientDirectory)} -Base64 ${psQuote(base64)}`,
    '$installed | ConvertTo-Json -Compress'
  ].join('\n'));
  const payloadLine = String(result.stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .pop();
  return { result, installed: payloadLine ? JSON.parse(payloadLine) : undefined };
}

function installFailure(clientDirectory, base64) {
  const result = runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    `. ${psQuote(databaseScript)}`,
    `try { Install-ClientDatabase -ClientDirectory ${psQuote(clientDirectory)} -Base64 ${psQuote(base64)} | Out-Null; 'NO_ERROR' } catch { 'ERROR: ' + $_.Exception.Message }`
  ].join('\n'));
  return { result, message: `${result.stdout}${result.stderr}` };
}

test('Base64 变量解码后直接写成 CXExam.exe 同目录的 UserExamInfo.db', { skip: windowsOnly }, () => {
  const { clientDirectory } = createClientDirectory();
  const payload = sqlitePayload();
  const { result, installed } = install(clientDirectory, payload.toString('base64'));

  assert.equal(result.status, 0, result.stderr);
  assert.ok(installed, `脚本必须输出安装结果: ${result.stdout}${result.stderr}`);
  const expectedPath = path.join(clientDirectory, 'UserExamInfo.db');
  assert.equal(installed.Path, expectedPath, '数据库必须写在 CXExam.exe 同目录');
  assert.equal(installed.ClientPath, path.join(clientDirectory, 'CXExam.exe'));
  assert.equal(installed.Bytes, payload.length, '日志中的字节数必须等于解码后的载荷长度');
  assert.equal(installed.Sqlite, true, '真实 UserExamInfo.db 必须被识别为 SQLite 文件');
  assert.deepEqual(readFileSync(expectedPath), payload, '写入内容必须与 Base64 解码结果逐字节一致');
  assert.match(result.stdout, /written directly beside CXExam\.exe/u, '日志必须说明数据库写在 CXExam.exe 同目录');
});

test('换行的 Base64 仍被接受，并覆盖已有的 UserExamInfo.db', { skip: windowsOnly }, () => {
  const { clientDirectory } = createClientDirectory();
  const stale = Buffer.from('stale database fixture');
  writeFileSync(path.join(clientDirectory, 'UserExamInfo.db'), stale);
  const payload = sqlitePayload(2048);
  const wrapped = `${payload.toString('base64').replace(/(.{48})/gu, '$1\r\n')}  \r\n`;
  const { result, installed } = install(clientDirectory, wrapped);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(installed.Bytes, payload.length);
  assert.deepEqual(readFileSync(path.join(clientDirectory, 'UserExamInfo.db')), payload,
    '变量里的换行与空白必须被忽略，旧文件必须被覆盖');
});

test('未知格式的载荷仍然写入，但签名标记为非 SQLite', { skip: windowsOnly }, () => {
  const { clientDirectory } = createClientDirectory();
  const payload = Buffer.from('not a sqlite database at all');
  const { result, installed } = install(clientDirectory, payload.toString('base64'));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(installed.Sqlite, false, '签名无法识别时只记录，不阻断注入');
  assert.deepEqual(readFileSync(path.join(clientDirectory, 'UserExamInfo.db')), payload);
});

test('旧的 enabled 标记、空载荷与缺少 CXExam.exe 都必须失败关闭', { skip: windowsOnly }, () => {
  const { root, clientDirectory } = createClientDirectory();

  const legacy = installFailure(clientDirectory, 'enabled');
  assert.match(legacy.message, /not valid Base64 text/u, 'enabled 标记必须被拒绝并说明需要 Base64 文本');

  const empty = installFailure(clientDirectory, '');
  assert.match(empty.message, /Base64 payload is empty/u);

  const noClientDirectory = path.join(root, 'package');
  mkdirSync(noClientDirectory, { recursive: true });
  const missingClient = installFailure(noClientDirectory, sqlitePayload(512).toString('base64'));
  assert.match(missingClient.message, /has no CXExam\.exe/u, '没有 CXExam.exe 时不得写出数据库');

  for (const failure of [legacy, empty, missingClient]) {
    assert.doesNotMatch(failure.message, /NO_ERROR/u, '每条失败路径都必须抛出错误');
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
