import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// 自毁兜底：关机关联、开机续删登记与强制关机保障。
// 单元用例不关机、不写真实自启项；宿主级用例只验证"未启用自毁时绝不登记"。
const root = path.resolve('.');
const sourceRoot = path.join(root, 'windows', 'native-source');
const purgeSource = path.join(sourceRoot, 'purge.c');
const purgeHeader = path.join(sourceRoot, 'purge.h');
const hostSource = path.join(sourceRoot, 'host.c');
const buildScript = path.join(sourceRoot, 'build-windows.ps1');
const purgeTests = process.env.CX_NATIVE_PURGE_EXE || path.join(root, 'windows', 'native-build', 'bin', 'purge-tests.exe');
const hostExe = process.env.CX_NATIVE_HOST_EXE || path.join(root, 'windows', 'native-build', 'bin', 'chaoxing_plus.exe');
const fixtureExe = path.join(root, 'windows', 'native-build', 'bin', 'process-fixture.exe');
const RUN_ONCE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
const VALUE_PREFIX = 'cxplus-purge-';

function runOnceValues() {
  const result = spawnSync('reg.exe', ['query', RUN_ONCE], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(VALUE_PREFIX))
    .map((line) => line.split(/\s+/u)[0]);
}

function purgeTempDirs() {
  try {
    return readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('cx-purge-') && !entry.name.startsWith('cx-purge-tests-'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// 只清理本用例期间新出现的登记项，不动开发者已有的内容。
function removeNewArtifacts(beforeValues, beforeDirs) {
  for (const name of runOnceValues()) {
    if (beforeValues.includes(name)) continue;
    spawnSync('reg.exe', ['delete', RUN_ONCE, '/v', name, '/f'], { timeout: 30000, windowsHide: true });
  }
  for (const name of purgeTempDirs()) {
    if (beforeDirs.includes(name)) continue;
    spawnSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', path.join(tmpdir(), name)], { timeout: 30000, windowsHide: true });
  }
}

function runHost(args) {
  const result = spawnSync(hostExe, args, { encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.ifError(result.error);
  return result;
}

async function unusedPort() {
  const { createServer } = await import('node:http');
  const server = createServer((_request, response) => response.end(''));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listFiles(directory, base = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(absolute, base));
    else result.push(path.relative(base, absolute).split(path.sep).join('/'));
  }
  return result;
}

test('原生自毁兜底暴露关机关联、开机续删与强制关机契约', async () => {
  const header = await readFile(purgeHeader, 'utf8');
  for (const symbol of [
    'cx_purge_init',
    'cx_purge_journal',
    'cx_purge_run',
    'cx_purge_settle',
    'cx_purge_after_exit',
    'cx_purge_watch_shutdown',
    'cx_purge_pending_delete'
  ]) {
    assert.equal(header.includes(symbol), true, `purge.h 缺少 ${symbol}`);
  }
  const source = await readFile(purgeSource, 'utf8');
  // 三层兜底必须都在源码里，不能只留注释。
  assert.match(source, /WM_QUERYENDSESSION/u, '必须处理关机询问');
  assert.match(source, /WM_ENDSESSION/u, '必须处理强制结束会话');
  assert.match(source, /SetProcessShutdownParameters/u, '必须尽早拿到关机通知');
  assert.match(source, /SHUTDOWN_NORETRY/u, '关机流程不得弹重试框拖住关机');
  assert.match(source, /HKCU:|CurrentVersion\\\\RunOnce/u, '必须在当前用户 RunOnce 登记续删');
  assert.match(source, /MOVEFILE_DELAY_UNTIL_REBOOT/u, '必须为强制关机登记重启后删除');
  assert.match(source, /New-ItemProperty/u, '续删脚本必须能在残留时重新登记');
  assert.match(source, /Remove-ItemProperty/u, '续删脚本必须能在删净后撤销登记');
  assert.match(source, /WideCharToMultiByte\(CP_UTF8/u, '续删脚本必须写成带 BOM 的 UTF-8');

  const host = await readFile(hostSource, 'utf8');
  assert.match(host, /cx_purge_journal\(&h_purge/u, '宿主必须在删除前登记续删');
  assert.match(host, /cx_purge_watch_shutdown\(&h_purge, h_force_destruct\)/u, '宿主必须接收关机通知');
  assert.match(host, /h_silent_begin_destruct\(TRUE\)/u, '关机自毁不得走确认与延迟');
  assert.match(host, /cx_purge_after_exit\(&h_purge\)/u, '残留必须交给退出后续删');
  const commitIndex = host.indexOf('static void h_purge_commit(void)');
  const journalIndex = host.indexOf('cx_purge_journal(&h_purge', commitIndex);
  const applyIndex = host.indexOf('h_silent_cleanup_pass(TRUE);', journalIndex);
  assert.ok(commitIndex > 0 && journalIndex > commitIndex && applyIndex > journalIndex,
    '登记必须先于删除（先落盘意图再破坏痕迹）');

  const script = await readFile(buildScript, 'utf8');
  assert.match(script, /'purge'/u);
  assert.match(script, /'purge-tests'/u);
});

test('原生续删单元测试通过（未构建时跳过）', { skip: process.platform !== 'win32' }, (t) => {
  if (!existsSync(purgeTests)) {
    t.skip('未找到 purge-tests.exe，先运行 windows/native-source/build-windows.ps1 -BuildTests');
    return;
  }
  const before = runOnceValues();
  const beforeDirs = purgeTempDirs();
  try {
    const result = spawnSync(purgeTests, [], { encoding: 'utf8', timeout: 300000, windowsHide: true });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /NATIVE PURGE TESTS PASS/u);
    assert.doesNotMatch(result.stdout, /FAIL - /u);
    for (const expectation of [
      'an unresolved trace keeps the boot-resume registration',
      'a clean purge unregisters the boot-resume entry',
      'a forced session end also triggers self-destruct',
      'the dispatched resume script deletes the queued trace',
      'the resume script sweeps the renamed copy of the host',
      'the resume script deletes itself once clean'
    ]) {
      assert.equal(result.stdout.includes(expectation), true, `缺少断言：${expectation}`);
    }
    // 生成的续删脚本必须真的能被 PowerShell 解析：正文回显里包含关键结构。
    for (const marker of ['$files=@(', '$attemptMax=16', '*.cxdel', 'Remove-ItemProperty']) {
      assert.equal(result.stdout.includes(marker), true, `生成的续删脚本缺少 ${marker}`);
    }
  } finally {
    removeNewArtifacts(before, beforeDirs);
  }
});

test('宿主声明自毁兜底能力并在帮助里说明', { skip: process.platform !== 'win32' || !existsSync(hostExe) }, () => {
  const capabilities = runHost(['--capabilities']);
  assert.equal(capabilities.status, 0, capabilities.stderr);
  const json = JSON.parse(capabilities.stdout);
  assert.equal(json.selfDestructOnShutdown, true, '单文件版必须声明关机自毁');
  assert.equal(json.selfDestructBootResume, true, '单文件版必须声明开机续删');
  assert.equal(json.selfDestructPendingDelete, true, '单文件版必须声明重启后删除');

  const help = runHost(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /关机\/注销（含强制结束会话）也会触发自毁/u);
  assert.match(help.stdout, /下次登录继续删除残留/u);
  assert.match(help.stdout, /多文件版明确拒绝/u);
});

test('未启用自毁的普通运行不登记开机续删', { skip: process.platform !== 'win32' || !existsSync(hostExe) }, async (t) => {
  const before = runOnceValues();
  const beforeDirs = purgeTempDirs();
  try {
    const port = await unusedPort();
    const result = runHost([
      '--attach', String(port), '--duration', '500', '--debug-timeout', '1000',
      '--no-scan-cache', '--no-disk-write', '--quiet'
    ]);
    assert.notEqual(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(runOnceValues(), before, '普通运行不得留下 RunOnce 登记');
    assert.deepEqual(purgeTempDirs(), beforeDirs, '普通运行不得留下续删临时目录');
  } finally {
    removeNewArtifacts(before, beforeDirs);
  }
});

test('模拟自毁既不删除文件也不登记开机续删', { skip: process.platform !== 'win32' || !existsSync(hostExe) || !existsSync(fixtureExe) }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-native-purge-sim-'));
  const before = runOnceValues();
  const beforeDirs = purgeTempDirs();
  try {
    await copyFile(hostExe, path.join(directory, 'chaoxing_plus.exe'));
    await copyFile(fixtureExe, path.join(directory, 'CXExam.exe'));
    await writeFile(path.join(directory, 'SHA256SUMS.txt'), 'deadbeef *chaoxing_plus.exe\n', 'utf8');
    await writeFile(path.join(directory, 'README.md'), '# fixture\n', 'utf8');
    await mkdir(path.join(directory, 'dist-windows'), { recursive: true });
    await writeFile(path.join(directory, 'dist-windows', 'windows-bootstrap.js'), '// fixture\n', 'utf8');

    const child = spawn(path.join(directory, 'chaoxing_plus.exe'), [
      '--silent-scenario', '--silent-delete-simulate',
      '--silent-client', path.join(directory, 'CXExam.exe'),
      '--no-log', '--no-disk-write', '--no-panel',
      '--debug-timeout', '1000', '--duration', '2000', '--no-elevate', '--port', '0'
    ], { stdio: 'ignore', windowsHide: true });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 60000);
      child.once('exit', (value) => { clearTimeout(timer); resolve(value); });
    });
    assert.notEqual(code, 'timeout', '模拟模式不得挂住');

    const files = await listFiles(directory);
    assert.equal(files.includes('chaoxing_plus.exe'), true, '模拟模式必须保留 EXE');
    assert.equal(files.includes('README.md'), true, '模拟模式必须保留程序文件');
    assert.equal(files.includes('CXExam.exe'), true, '模拟模式必须保留客户端');
    assert.deepEqual(runOnceValues(), before, '模拟模式不得登记开机续删');
    assert.deepEqual(purgeTempDirs(), beforeDirs, '模拟模式不得写续删脚本');
  } finally {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='CXExam.exe'" | Where-Object { $_.ExecutablePath -like '${directory.replace(/\\/gu, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ], { timeout: 30000, windowsHide: true });
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    removeNewArtifacts(before, beforeDirs);
  }
});
