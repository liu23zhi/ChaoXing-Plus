import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestDirectory } from './test-helpers/temp-directory.mjs';

// 三代真实超星考试客户端的注入通道回归。
//
// 这里的断言全部是"参数级"的：只要求原生宿主对给定客户端路径做出正确的注入通道判定，
// 不要求真的启动客户端（CI 里没有这些目录）。样本不存在时整组 skip，绝不 fail。
//
// 实测结论（IG5 只读分析，见 windows/native-source/host.c 的 h_plan_inject 注释）：
//   A 4.3.0.4   Themida 加壳 → dll-proxy（已装代理时复用，不覆盖）
//   B 4.1.4.25512 未加壳    → cdp-port
//   C 4.1.4.25389 未加壳    → cdp-port
//   cdp-pipe / input 三代均不可用 → 显式失败（退出码 4），绝不静默退回 cdp-port

const hostExe = process.env.CX_NATIVE_HOST_EXE
  ? resolve(process.env.CX_NATIVE_HOST_EXE)
  : resolve('windows/native-build/bin/chaoxing_plus.exe');
const fixtureExe = resolve('windows/native-build/bin/process-fixture.exe');
// 真的导入 winmm.dll 的夹具：dll-proxy 复用判定的前提是客户端会加载该载体。
const carrierFixture = resolve('windows/native-build/bin/carrier-fixture.exe');
const proxyDll = resolve('windows/native-build/hook/winmm.dll');

// 真实样本：只在本机存在时参与，CI 上自然 skip。
const SAMPLES = [
  {
    id: 'A-4.3.0.4',
    path: 'C:\\Users\\Zelly\\Desktop\\电子科技大学中山学院考试客户端-4.3.0.4\\CXExam.exe',
    packed: true,
    expectedMode: 'dll-proxy',
    note: 'Themida 加壳，命令行开关被壳吞掉'
  },
  {
    id: 'B-4.1.4.25512',
    path: 'C:\\Users\\Zelly\\Desktop\\河南应用技术职业学院 考试客户端_V4.1.4.25512(2023.06.09)\\CXExam.exe',
    packed: false,
    expectedMode: 'cdp-port',
    note: '未加壳，--remote-debugging-port 可从外部命令行传入'
  },
  {
    id: 'C-4.1.4.25389',
    path: 'C:\\Users\\Zelly\\Desktop\\重庆工商大学自考_考试客户端_V4.1.4.25389(2022.11.22)\\CXExam.exe',
    packed: false,
    expectedMode: 'cdp-port',
    note: '未加壳，同 B'
  }
];

function ready() {
  return process.platform === 'win32' && existsSync(hostExe) && existsSync(fixtureExe);
}

function run(args, options = {}) {
  const result = spawnSync(hostExe, args, {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    ...options
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// --probe-client 是宿主的只读离线探测入口：不启动客户端、不写盘，
// 直接输出 packed / channel / suggested 三行判定，正是 auto 分派所依赖的证据。
function probe(clientPath) {
  const result = run(['--probe-client', clientPath]);
  assert.equal(result.status, 0, result.output);
  const packed = /probe: packed=(\S+)/u.exec(result.output);
  const channel = /probe: channel=(\S+)/u.exec(result.output);
  const suggested = /probe: suggested=(\S+)/u.exec(result.output);
  assert.ok(packed && channel && suggested, `探测输出缺少判定行：${result.output}`);
  return { packed: packed[1], channel: channel[1], suggested: suggested[1], raw: result.output };
}

// 把一个任意 PE 复制成"加壳"形态：改首节名即可命中宿主的 .themida 判定。
async function writePackedClient(target) {
  await copyFile(fixtureExe, target);
  const image = await readFile(target);
  const marker = Buffer.from('.text\0\0\0', 'latin1');
  const at = image.indexOf(marker);
  assert.notEqual(at, -1, '夹具缺少 .text 节名，无法构造加壳场景');
  image.write('.themida', at, 'latin1');
  await writeFile(target, image);
}

test('三代真实样本的 auto 通道判定符合实测矩阵', {
  skip: !ready() || !SAMPLES.every((sample) => existsSync(sample.path))
    ? '三代真实客户端样本不在本机'
    : false
}, async () => {
  for (const sample of SAMPLES) {
    const result = probe(sample.path);
    assert.equal(result.packed, sample.packed ? 'themida' : 'none',
      `${sample.id}（${sample.note}）加壳判定不符：${result.raw}`);
    assert.equal(result.channel, sample.expectedMode,
      `${sample.id}（${sample.note}）通道判定不符：${result.raw}`);
    // A 目录已有生效中的代理，必须被识别为可直接复用（suggested=dll-proxy）。
    if (sample.packed) {
      assert.match(result.suggested, /^dll-proxy/u,
        `${sample.id} 必须给出 dll-proxy 建议：${result.raw}`);
    } else {
      assert.equal(result.suggested, 'cdp-port',
        `${sample.id} 必须给出 cdp-port 建议：${result.raw}`);
    }
  }
});

test('加壳样本的 dll-proxy 判定与未加壳样本的 cdp-port 判定都来自磁盘 PE 证据', {
  skip: !ready() ? '原生宿主或夹具未构建' : false
}, async () => {
  const directory = createTestDirectory('inject-matrix');
  const plain = resolve(directory, 'plain', 'CXExam.exe');
  const packed = resolve(directory, 'packed', 'CXExam.exe');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(resolve(directory, 'plain'), { recursive: true });
  await mkdir(resolve(directory, 'packed'), { recursive: true });
  await copyFile(fixtureExe, plain);
  await writePackedClient(packed);

  const plainResult = probe(plain);
  assert.equal(plainResult.packed, 'none');
  assert.equal(plainResult.channel, 'cdp-port');
  assert.equal(plainResult.suggested, 'cdp-port');

  const packedResult = probe(packed);
  assert.equal(packedResult.packed, 'themida');
  assert.equal(packedResult.channel, 'dll-proxy');
  // 目录里没有我们的代理，因此建议"必须装代理"而不是"可直接用"。
  assert.equal(packedResult.suggested, 'dll-proxy-required');
});

test('已装代理的加壳客户端被判定为可直接复用而不是需要重装', {
  skip: !ready() || !existsSync(proxyDll) || !existsSync(carrierFixture)
    ? '原生宿主/代理 DLL/载体夹具未构建'
    : false
}, async () => {
  const directory = createTestDirectory('inject-matrix-installed');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(resolve(directory, 'client'), { recursive: true });
  const client = resolve(directory, 'client', 'CXExam.exe');
  // 必须用真的导入 winmm.dll 的夹具：载体不被导入时 DLL 永远不会加载，复用判定本就该拒绝。
  await copyFile(carrierFixture, client);
  const image = await readFile(client);
  const at = image.indexOf(Buffer.from('.text\0\0\0', 'latin1'));
  assert.notEqual(at, -1, '夹具缺少 .text 节名，无法构造加壳场景');
  image.write('.themida', at, 'latin1');
  await writeFile(client, image);

  const install = run([
    '--install-proxy', '--proxy-source', proxyDll, '--proxy-target', 'winmm', '--client', client
  ]);
  assert.equal(install.status, 0, install.output);
  assert.equal(existsSync(resolve(directory, 'client', 'winmm.dll')), true);
  assert.equal(existsSync(resolve(directory, 'client', 'cxhook-proxy.marker')), true);

  const result = probe(client);
  assert.equal(result.packed, 'themida');
  assert.equal(result.channel, 'dll-proxy');
  // 夹具确实导入 winmm.dll，marker 里的载体核对通过 → 可复用。
  assert.equal(result.suggested, 'dll-proxy', `已装代理必须被判为可复用：${result.raw}`);

  // 清理：卸载只删我们自己装了 marker 的那份。
  const uninstall = run(['--uninstall-proxy', '--client', client]);
  assert.equal(uninstall.status, 0, uninstall.output);
  assert.equal(existsSync(resolve(directory, 'client', 'winmm.dll')), false);
});

test('客户端不导入载体 DLL 时，已装的代理不被当作可复用', {
  skip: !ready() || !existsSync(proxyDll) ? '原生宿主或代理 DLL 未构建' : false
}, async () => {
  const directory = createTestDirectory('inject-matrix-carrier-mismatch');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(resolve(directory, 'client'), { recursive: true });
  const client = resolve(directory, 'client', 'CXExam.exe');
  // process-fixture 不导入 winmm.dll：DLL 放进去也永远不会被加载。
  await writePackedClient(client);

  const install = run(['--install-proxy', '--proxy-source', proxyDll, '--client', client]);
  assert.equal(install.status, 0, install.output);

  const result = probe(client);
  assert.equal(result.packed, 'themida');
  assert.equal(result.channel, 'dll-proxy');
  // 载体会被跳过 → 不能声称可复用，必须提示 dll-proxy-required。
  assert.equal(result.suggested, 'dll-proxy-required',
    `未导入载体时必须提示重新安装：${result.raw}`);

  run(['--uninstall-proxy', '--client', client]);
});
test('cdp-pipe 与 input 显式失败而不是静默降级到 cdp-port', {
  skip: !ready() ? '原生宿主未构建' : false
}, async () => {
  const directory = createTestDirectory('inject-matrix-unsupported');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(resolve(directory, 'client'), { recursive: true });
  const client = resolve(directory, 'client', 'CXExam.exe');
  await copyFile(fixtureExe, client);
  const report = resolve(directory, 'report.json');

  // input 完全未实现：必须立即以退出码 4 失败。
  const input = run([
    '--inject-mode', 'input', '--client', client, '--report', report,
    '--no-elevate', '--no-log'
  ]);
  assert.equal(input.status, 4, `input 必须以退出码 4 失败：${input.output}`);
  assert.match(input.output, /inject-input-unavailable|input 模式未实现/u);
  {
    const parsed = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(parsed.stopReason, 'inject-input-unavailable');
    assert.notEqual(parsed.injectMode, 'cdp-port', 'input 不得把实际通道改写成 cdp-port');
    assert.equal(parsed.success, false);
  }

  // cdp-pipe 已接线（NUL 帧），但对非 Chromium 客户端必然失败。
  // 关键断言：失败必须是"管道失败"，绝不能悄悄退回端口模式。
  const pipe = run([
    '--inject-mode', 'cdp-pipe', '--client', client, '--report', report,
    '--no-elevate', '--no-log'
  ]);
  assert.notEqual(pipe.status, 0, `cdp-pipe 对非 Chromium 客户端不得报成功：${pipe.output}`);
  assert.match(pipe.output, /cdp-pipe/u, `cdp-pipe 必须走管道通道：${pipe.output}`);
  assert.doesNotMatch(pipe.output, /--remote-debugging-port/u,
    `cdp-pipe 不得悄悄退回端口模式：${pipe.output}`);
  {
    const parsed = JSON.parse(await readFile(report, 'utf8'));
    assert.match(parsed.stopReason, /^pipe-/u, 'cdp-pipe 的失败原因必须如实记录为管道失败');
    assert.notEqual(parsed.injectMode, 'cdp-port', 'cdp-pipe 不得把实际通道改写成 cdp-port');
    assert.equal(parsed.success, false);
  }
});

test('capabilities 声明 cdp-pipe 不受支持，且列出注入判据', {
  skip: !existsSync(hostExe) ? '原生宿主未构建' : false
}, () => {
  const result = run(['--capabilities']);
  assert.equal(result.status, 0, result.output);
  const capabilities = JSON.parse(result.output);
  assert.deepEqual(capabilities.injectModeSupport, {
    auto: true, 'cdp-port': true, 'cdp-pipe': false, 'dll-proxy': true
  });
  assert.deepEqual(capabilities.injectEvidence, ['endpoint-ready', 'proxy-hook', 'bundle-sentinel']);
});
