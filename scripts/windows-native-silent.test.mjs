import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');
const engineSource = path.join(root, 'windows', 'native', 'silent.c');
const engineHeader = path.join(root, 'windows', 'native', 'silent.h');
const buildScript = path.join(root, 'windows', 'native', 'build.ps1');
const defaultExe = path.join(root, 'build-windows', 'bin', 'silent-tests.exe');

test('原生静默引擎暴露自毁状态机与程序清理契约', async () => {
  const header = await readFile(engineHeader, 'utf8');
  for (const symbol of [
    'cx_silent_init',
    'cx_silent_client_started',
    'cx_silent_hotkey',
    'cx_silent_fullscreen',
    'cx_silent_client_exited',
    'cx_silent_finish',
    'cx_cleanup_collect',
    'cx_cleanup_apply',
    'cx_cleanup_detach_self',
    'cx_cleanup_release_self'
  ]) {
    assert.equal(header.includes(symbol), true, `silent.h 缺少 ${symbol}`);
  }
  const source = await readFile(engineSource, 'utf8');
  // CXExam 与 runtime 运行时必须被显式保护，不能只靠调用方自觉。
  assert.match(source, /cxexam/iu);
  assert.match(source, /runtime/iu);
  assert.match(source, /MOVEFILE_DELAY_UNTIL_REBOOT/u);
  const script = await readFile(buildScript, 'utf8');
  assert.match(script, /'silent'/u);
  assert.match(script, /'silent-tests'/u);
});

test('原生构建默认输出到仓库根部 build-windows/bin', async () => {
  const script = await readFile(buildScript, 'utf8');
  assert.match(script, /Join-Path \$root 'build-windows'/u);
  assert.equal((script.match(/[^\x00-\x7F]/gu) || []).length, 0, 'build.ps1 必须保持纯 ASCII');
  const packager = await readFile(path.join(root, 'scripts', 'package-windows.mjs'), 'utf8');
  assert.match(packager, /'build-windows', 'bin', 'chaoxing_plus\.exe'/u);
  const ignore = await readFile(path.join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^build-windows\/$/mu);
});

test('原生静默引擎单元测试通过（未构建时跳过）', { skip: process.platform !== 'win32' }, (t) => {
  const executable = process.env.CX_NATIVE_SILENT_EXE || defaultExe;
  if (!existsSync(executable)) {
    t.skip('未找到 silent-tests.exe，先运行 windows/native/build.ps1 -BuildTests');
    return;
  }
  const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /NATIVE SILENT TESTS PASS/u);
  assert.doesNotMatch(result.stdout, /FAIL - /u);
  // 关键契约必须出现在真实运行输出里，避免只测到函数存在。
  for (const expectation of [
    'CXExam never enters the deletion plan',
    'runtime directory never enters the deletion plan',
    'fullscreen exit without entering fullscreen does nothing',
    'the manual answer key never destroys'
  ]) {
    assert.equal(result.stdout.includes(expectation), true, `缺少断言：${expectation}`);
  }
});

test('原生宿主接受 --silent-scenario 并声明该能力', { skip: process.platform !== 'win32' }, async (t) => {
  const executable = process.env.CX_NATIVE_HOST_EXE || path.join(root, 'build-windows', 'bin', 'chaoxing_plus.exe');
  if (!existsSync(executable)) {
    t.skip('未找到 chaoxing_plus.exe，先运行 windows/native/build.ps1 -BuildTests');
    return;
  }
  const run = (args) => spawnSync(executable, args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--silent-scenario/u);
  assert.match(help.stdout, /--silent-delete-simulate/u);

  const capabilities = run(['--capabilities']);
  assert.equal(capabilities.status, 0, capabilities.stderr);
  assert.equal(JSON.parse(capabilities.stdout).silentScenario, true);

  // 自检必须保持只读：静默参数不得触发任何删除。
  const selfCheck = run(['--silent-scenario', '--silent-delete-simulate', '--self-check', '--no-disk-write', '--quiet']);
  assert.equal(selfCheck.status, 0, selfCheck.stdout + selfCheck.stderr);
  assert.equal(existsSync(executable), true, '自检不得删除自身');
});
