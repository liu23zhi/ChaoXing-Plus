import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 原生静默场景端到端：用 process-fixture.exe 冒充 CXExam.exe，验证
// "删除程序痕迹但永不删除 CXExam" 这条最危险的行为，不接触真实客户端。
const root = path.resolve('.');
const hostExe = path.join(root, 'build-windows', 'bin', 'chaoxing_plus.exe');
const fixtureExe = path.join(root, 'build-windows', 'bin', 'process-fixture.exe');

function killOwnedClients(directory) {
  const script = `$p = Get-CimInstance Win32_Process -Filter "Name='CXExam.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -like '${directory.replace(/\\/gu, '\\\\')}*' }; foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000, windowsHide: true });
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

test('原生静默场景删除程序痕迹但保留 CXExam，并改名自身', { skip: process.platform !== 'win32' }, async (t) => {
  if (!existsSync(hostExe) || !existsSync(fixtureExe)) {
    t.skip('未构建 chaoxing_plus.exe / process-fixture.exe');
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-native-silent-'));
  try {
    await copyFile(hostExe, path.join(directory, 'chaoxing_plus.exe'));
    await copyFile(fixtureExe, path.join(directory, 'CXExam.exe'));
    await writeFile(path.join(directory, 'SHA256SUMS.txt'), 'deadbeef *chaoxing_plus.exe\n', 'utf8');
    await writeFile(path.join(directory, 'README.md'), '# fixture\n', 'utf8');
    await mkdir(path.join(directory, 'windows'), { recursive: true });
    await writeFile(path.join(directory, 'windows', 'config.example.json'), '{}\n', 'utf8');
    await mkdir(path.join(directory, 'dist-windows'), { recursive: true });
    await writeFile(path.join(directory, 'dist-windows', 'windows-bootstrap.js'), '// fixture\n', 'utf8');

    const result = spawnSync(path.join(directory, 'chaoxing_plus.exe'), [
      '--silent-scenario',
      '--silent-client', path.join(directory, 'CXExam.exe'),
      '--quiet', '--no-log', '--no-disk-write', '--no-panel',
      '--debug-timeout', '1000', '--duration', '4000', '--no-elevate', '--port', '0'
    ], { encoding: 'utf8', timeout: 60000, windowsHide: true });

    // 没有 CDP 端点，退出码非 0 属正常；关键是不能挂住。
    assert.notEqual(result.error && result.error.code, 'ETIMEDOUT', '静默场景不得挂住');
    const files = await listFiles(directory);
    assert.equal(files.includes('chaoxing_plus.exe'), false, '原 EXE 路径必须消失（自身改名）');
    assert.equal(files.includes('README.md'), false, '程序文件必须被删除');
    assert.equal(files.includes('windows/config.example.json'), false, '宿主数据必须被删除');
    assert.equal(files.includes('dist-windows/windows-bootstrap.js'), false, '注入资源必须被删除');
    assert.equal(files.includes('CXExam.exe'), true, 'CXExam 必须保留');
    assert.equal(files.some((name) => name.endsWith('.log')), false, '不得写日志文件');
    assert.equal(files.some((name) => name.startsWith('.data')), false, '不得写数据目录');
    // 改名后的自身允许在进程退出后由看门狗清理；这里只要求不再占用原路径。
    assert.equal(files.filter((name) => name.startsWith('chaoxing_plus.exe')).length <= 1, true);
    const originals = await stat(path.join(directory, 'CXExam.exe')).catch(() => null);
    assert.notEqual(originals, null, 'CXExam.exe 必须仍然可访问');
  } finally {
    killOwnedClients(directory);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test('原生静默模拟模式只报告计划，不删除任何文件', { skip: process.platform !== 'win32' }, async (t) => {
  if (!existsSync(hostExe) || !existsSync(fixtureExe)) {
    t.skip('未构建 chaoxing_plus.exe / process-fixture.exe');
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'cx-native-silent-sim-'));
  try {
    await copyFile(hostExe, path.join(directory, 'chaoxing_plus.exe'));
    await copyFile(fixtureExe, path.join(directory, 'CXExam.exe'));
    await writeFile(path.join(directory, 'SHA256SUMS.txt'), 'deadbeef *chaoxing_plus.exe\n', 'utf8');
    await writeFile(path.join(directory, 'README.md'), '# fixture\n', 'utf8');
    const result = spawnSync(path.join(directory, 'chaoxing_plus.exe'), [
      '--silent-scenario', '--silent-delete-simulate',
      '--silent-client', path.join(directory, 'CXExam.exe'),
      '--no-log', '--no-disk-write', '--no-panel',
      '--debug-timeout', '1000', '--duration', '2000', '--no-elevate', '--port', '0'
    ], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.notEqual(result.error && result.error.code, 'ETIMEDOUT', '模拟模式不得挂住');
    const files = await listFiles(directory);
    assert.equal(files.includes('chaoxing_plus.exe'), true, '模拟模式必须保留 EXE');
    assert.equal(files.includes('README.md'), true, '模拟模式必须保留程序文件');
    assert.equal(files.includes('CXExam.exe'), true);
  } finally {
    killOwnedClients(directory);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
