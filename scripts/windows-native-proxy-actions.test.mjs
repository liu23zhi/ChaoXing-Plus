import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hostExe = process.env.CX_NATIVE_HOST_EXE ? resolve(process.env.CX_NATIVE_HOST_EXE) : resolve('build-windows/bin/chaoxing_plus.exe');
const proxyDll = resolve('build-windows/hook/winmm.dll');
const fixtureExe = resolve('build-windows/bin/process-fixture.exe');

function ready() {
  return existsSync(hostExe) && existsSync(proxyDll) && existsSync(fixtureExe);
}

function run(args) {
  const result = spawnSync(hostExe, args, { encoding: 'utf8', timeout: 60000 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('代理安装/探测/卸载的完整闭环', { skip: process.platform !== 'win32' || !ready() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cx-proxy-actions-'));
  try {
    const client = join(dir, 'CXExam.exe');
    await copyFile(fixtureExe, client);

    const before = run(['--probe-client', client]);
    assert.equal(before.status, 0, before.output);
    assert.match(before.output, /marker=absent/u);
    assert.match(before.output, /client-winmm=/u);
    assert.match(before.output, /suggested=cdp-port/u);

    const install = run(['--install-proxy', '--proxy-source', proxyDll, '--client', client]);
    assert.equal(install.status, 0, install.output);
    assert.equal(existsSync(join(dir, 'winmm.dll')), true);
    assert.equal(existsSync(join(dir, 'cxhook-proxy.marker')), true);

    const after = run(['--probe-client', client]);
    assert.equal(after.status, 0, after.output);
    assert.match(after.output, /marker=present/u);
    assert.match(after.output, /portfile=absent/u);
    // 夹具不导入 winmm.dll：标记如实显示 present，但不建议 dll-proxy（真实客户端导入时才建议）。
    assert.match(after.output, /marker=present/u);
    assert.match(after.output, /portfile=absent/u);
    assert.match(after.output, /client-winmm=no/u);
    assert.match(after.output, /suggested=cdp-port/u);

    const uninstall = run(['--uninstall-proxy', '--client', client]);
    assert.equal(uninstall.status, 0, uninstall.output);
    assert.equal(existsSync(join(dir, 'winmm.dll')), false);
    assert.equal(existsSync(join(dir, 'cxhook-proxy.marker')), false);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('缺少标记时拒绝卸载未知 winmm.dll', { skip: process.platform !== 'win32' || !ready() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cx-proxy-actions-'));
  try {
    const client = join(dir, 'CXExam.exe');
    await copyFile(fixtureExe, client);
    await copyFile(proxyDll, join(dir, 'winmm.dll'));
    const uninstall = run(['--uninstall-proxy', '--client', client]);
    assert.equal(uninstall.status, 1, uninstall.output);
    assert.match(uninstall.output, /marker not found/u);
    assert.equal(existsSync(join(dir, 'winmm.dll')), true);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});



