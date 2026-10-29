import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    assert.match(before.output, /probe: channel=cdp-port/u);

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
test('dll-proxy 自动安装后在运行结束时自动还原', { skip: process.platform !== 'win32' || !ready() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cx-proxy-auto-'));
  try {
    const client = join(dir, 'CXExam.exe');
    await copyFile(fixtureExe, client);
    // 把首个节名改成 .themida，让宿主把它当作加壳客户端（dll-proxy 只对加壳客户端开放）。
    const image = await readFile(client);
    const marker = Buffer.from('.text\0\0\0', 'latin1');
    const at = image.indexOf(marker);
    assert.notEqual(at, -1, 'fixture 缺少 .text 节名，无法构造加壳场景');
    image.write('.themida', at, 'latin1');
    await writeFile(client, image);
    assert.equal(existsSync(join(dir, 'winmm.dll')), false);

    const result = run([
      '--inject-mode', 'dll-proxy',
      '--proxy-source', proxyDll,
      '--client', client,
      '--no-elevate', '--no-log', '--no-disk-write',
      '--duration', '2'
    ]);
    assert.match(result.output, /本次运行临时安装代理/u);
    // 无论注入是否成功，运行结束都必须把临时安装的代理清理干净。
    assert.equal(existsSync(join(dir, 'winmm.dll')), false, `winmm.dll 残留: ${result.output}`);
    assert.equal(existsSync(join(dir, 'cxhook-proxy.marker')), false, `marker 残留: ${result.output}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('auto 模式对加壳客户端自动选择 dll-proxy 并清理临时代理', { skip: process.platform !== 'win32' || !ready() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cx-proxy-auto2-'));
  try {
    const client = join(dir, 'CXExam.exe');
    await copyFile(fixtureExe, client);
    const image = await readFile(client);
    const at = image.indexOf(Buffer.from('.text\0\0\0', 'latin1'));
    image.write('.themida', at, 'latin1');
    await writeFile(client, image);

    const report = join(dir, 'report.json');
    const result = run([
      '--client', client,
      '--report', report,
      '--no-elevate', '--no-log',
      '--duration', '2'
    ]);
    assert.match(result.output, /已自动安装代理并启用 dll-proxy/u);
    const parsed = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(parsed.injectMode, 'dll-proxy');
    assert.equal(existsSync(join(dir, 'winmm.dll')), false, `winmm.dll 残留: ${result.output}`);
    assert.equal(existsSync(join(dir, 'cxhook-proxy.marker')), false, `marker 残留: ${result.output}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('--proxy-target version 安装/卸载到 version.dll 且不动 winmm.dll', { skip: process.platform !== 'win32' || !ready() }, async () => {
  const proxyVersion = resolve('build-windows/hook/version.dll');
  if (!existsSync(proxyVersion)) return; // 未构建 version 目标时跳过（build-proxy.ps1 -Target version）
  const dir = await mkdtemp(join(tmpdir(), 'cx-proxy-version-'));
  try {
    const client = join(dir, 'CXExam.exe');
    await copyFile(fixtureExe, client);
    const install = run(['--install-proxy', '--proxy-target', 'version', '--proxy-source', proxyVersion, '--client', client]);
    assert.equal(install.status, 0, install.output);
    assert.equal(existsSync(join(dir, 'version.dll')), true);
    assert.equal(existsSync(join(dir, 'winmm.dll')), false, '不得写到 winmm.dll');
    assert.equal(existsSync(join(dir, 'cxhook-proxy.marker')), true);
    const uninstall = run(['--uninstall-proxy', '--proxy-target', 'version', '--client', client]);
    assert.equal(uninstall.status, 0, uninstall.output);
    assert.equal(existsSync(join(dir, 'version.dll')), false);
    assert.equal(existsSync(join(dir, 'cxhook-proxy.marker')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('--proxy-target uxtheme 与 auto 解析', { skip: process.platform !== 'win32' || !ready() }, async () => {
  const proxyUx = resolve('build-windows/hook/uxtheme.dll');
  const dir = await mkdtemp(join(tmpdir(), 'cx-proxy-ux-'));
  try {
    const client = join(dir, 'CXExam.exe');
    await copyFile(fixtureExe, client);
    if (existsSync(proxyUx)) {
      const install = run(['--install-proxy', '--proxy-target', 'uxtheme', '--proxy-source', proxyUx, '--client', client]);
      assert.equal(install.status, 0, install.output);
      assert.equal(existsSync(join(dir, 'uxtheme.dll')), true);
      assert.equal(existsSync(join(dir, 'winmm.dll')), false);
      run(['--uninstall-proxy', '--proxy-target', 'uxtheme', '--client', client]);
      assert.equal(existsSync(join(dir, 'uxtheme.dll')), false);
    }
    // auto：夹具不导入任何候选 DLL，应回落到 winmm
    const auto = run(['--install-proxy', '--proxy-target', 'auto', '--proxy-source', proxyDll, '--client', client]);
    assert.equal(auto.status, 0, auto.output);
    assert.equal(existsSync(join(dir, 'winmm.dll')), true, `auto 应回落到 winmm: ${auto.output}`);
    run(['--uninstall-proxy', '--client', client]);
    assert.equal(existsSync(join(dir, 'winmm.dll')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('载体冲突时 auto 换下一个载体，marker 记录载体名且卸载不动第三方 DLL', { skip: process.platform !== 'win32' || !ready() }, async () => {
  const proxyVersion = resolve('build-windows/hook/version.dll');
  if (!existsSync(proxyVersion)) return;
  const dir = await mkdtemp(join(tmpdir(), 'cx-proxy-clash-'));
  try {
    const client = join(dir, 'CXExam.exe');
    await copyFile(fixtureExe, client);
    // 伪造第三方 winmm.dll（无 marker），auto 应改用 version
    await copyFile(fixtureExe, join(dir, 'winmm.dll'));
    const install = run(['--install-proxy', '--proxy-target', 'auto', '--proxy-source', proxyVersion, '--client', client]);
    assert.equal(install.status, 0, install.output);
    assert.match(install.output, /载体冲突，改用 version/u);
    assert.equal(existsSync(join(dir, 'version.dll')), true);
    const marker = await readFile(join(dir, 'cxhook-proxy.marker'), 'utf8');
    assert.match(marker, /carrier=version/u);
    const uninstall = run(['--uninstall-proxy', '--client', client]);
    assert.equal(uninstall.status, 0, uninstall.output);
    assert.equal(existsSync(join(dir, 'version.dll')), false, '卸载应删除我们装的载体');
    assert.equal(existsSync(join(dir, 'winmm.dll')), true, '不得删除第三方 winmm.dll');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('端口拿不到端点时自动改用 settings-only 代理重试（端口自愈）', { skip: process.platform !== 'win32' || !ready() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cx-proxy-heal-'));
  try {
    const client = join(dir, 'CXExam.exe');
    await copyFile(fixtureExe, client);
    // 把 .text 改名成 .xemida0：既有 PE 结构不变，又不会被判为加壳 → auto 走 cdp-port
    const image = await readFile(client);
    const at = image.indexOf(Buffer.from('.text\0\0\0', 'latin1'));
    image.write('.xemida0', at, 'latin1');
    await writeFile(client, image);

    const result = run([
      '--client', client,
      '--no-elevate', '--no-log', '--no-disk-write',
      '--debug-timeout', '1500', '--duration', '2000'
    ]);
    assert.match(result.output, /改用 settings-only 代理重试/u);
    assert.equal(existsSync(join(dir, 'winmm.dll')), false, `自愈后必须清理代理: ${result.output}`);
    assert.equal(existsSync(join(dir, 'cxhook-proxy.marker')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('小载体 msimg32 / sensapi / oledlg / wtsapi32 可安装并卸载', { skip: process.platform !== 'win32' || !ready() }, async () => {
  for (const carrier of ['msimg32', 'sensapi', 'oledlg', 'wtsapi32']) {
    const src = resolve(`build-windows/hook/${carrier}.dll`);
    if (!existsSync(src)) continue;
    const dir = await mkdtemp(join(tmpdir(), `cx-proxy-${carrier}-`));
    try {
      const client = join(dir, 'CXExam.exe');
      await copyFile(fixtureExe, client);
      const install = run(['--install-proxy', '--proxy-target', carrier, '--proxy-source', src, '--client', client]);
      assert.equal(install.status, 0, install.output);
      assert.equal(existsSync(join(dir, `${carrier}.dll`)), true, `${carrier} 未安装`);
      const marker = await readFile(join(dir, 'cxhook-proxy.marker'), 'utf8');
      assert.match(marker, new RegExp(`carrier=${carrier}`, 'u'));
      const uninstall = run(['--uninstall-proxy', '--client', client]);
      assert.equal(uninstall.status, 0, uninstall.output);
      assert.equal(existsSync(join(dir, `${carrier}.dll`)), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
test('KnownDLLs 里的名字（imm32）拒绝作为载体', { skip: process.platform !== 'win32' || !ready() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cx-proxy-known-'));
  try {
    const client = join(dir, 'CXExam.exe');
    await copyFile(fixtureExe, client);
    const result = run(['--install-proxy', '--proxy-target', 'imm32', '--proxy-source', proxyDll, '--client', client]);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /KnownDLLs/u);
    assert.equal(existsSync(join(dir, 'imm32.dll')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('--probe-all 输出通道汇总 plan 行', { skip: process.platform !== 'win32' || !ready() }, () => {
  const result = run(['--probe-all', '--no-disk-write']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /probe-all: candidates=\d+/u);
  assert.match(result.output, /plan: clients=\d+ cdp-port=\d+ dll-proxy=\d+/u);
});

