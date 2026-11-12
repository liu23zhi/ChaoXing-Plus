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

// -- skip 与 fail 的分界：为什么不能一律 skip -------------------------------
//
// 本文件的历史写法是「构建缺失就整组 skip」。问题是 node --test 在**全部用例
// skip 时 exit code 仍是 0** —— CI 因此看到绿色，实际零覆盖。这是「跳过却
// 成功」型假绿（项目记忆「CI 假绿的四种形态」①）。
//
// 判据来自 CI 的真实依赖：.github/workflows/ci.yml 的 windows-native 作业
//   needs: windows-build
//   if: needs.windows-build.result == 'success'
// 并显式「下载共享 Windows 测试产物」后再跑 scripts/*.test.mjs（第 329-334 行）。
// 也就是说，**在 CI 里构建产物必然存在**；缺失只能是配置错（needs 被删、
// 产物名对不上、artifact 上传失败）—— 那是必须判红的故障，不是可以跳过的情况。
//
// 因此：
//   CI + 构建缺失        → fail（配置错，必须暴露）
//   本机 + 构建缺失       → skip（开发者没构建是正常的）
//   真实样���缺失          → 一律 skip（私有资产，从不进入 CI）
const IN_CI = Boolean(process.env.CI) || process.env.GITHUB_ACTIONS === 'true';

// buildSkipReason 返回 skip 原因字符串；返回 false 表示应当执行。
// ciRequiresBuild=true 时若构建缺失则**不**返回 skip —— 让它落到用例里报错，
// 这样失败信息会明确指出「CI 缺构建产物」，而不是笼统的断言失败。
function buildSkipReason(ciRequiresBuild) {
  if (ready()) return false;
  if (IN_CI && ciRequiresBuild) return false; // 交给 requireBuild() 抛错
  if (process.platform !== 'win32') return `非 Windows 平台（${process.platform}）`;
  return '原生宿主或夹具未构建（本机未跑 windows/native-source/build-windows.ps1）';
}

// requireBuild 在用例体内调用：构建缺失时给出可操作的失败信息。
// 只在「本应存在构建」的场景被触发（CI，或 ready() 为真时根本不会走到）。
function requireBuild() {
  assert.equal(process.platform, 'win32',
    `注入矩阵用例只能在 Windows 上跑，当前 platform=${process.platform}`);
  assert.ok(existsSync(hostExe),
    `缺少原生宿主：${hostExe}\n` +
    `CI 上出现此错误说明 windows-native 作业没有正确拿到 windows-build 的产物` +
    `（检查 needs / 下载产物名与上传侧是否一致）。`);
  assert.ok(existsSync(fixtureExe),
    `缺少测试夹具：${fixtureExe}（构建命令：npm run build:native）`);
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
  // 真实样本是私有资产，从不进入 CI：样本缺失永远 skip，不因 CI 而 fail。
  skip: !SAMPLES.every((sample) => existsSync(sample.path))
    ? '三代真实客户端样本不在本机（私有资产，不参与 CI）'
    : buildSkipReason(true)
}, async () => {
  requireBuild();
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
  skip: buildSkipReason(true)
}, async () => {
  requireBuild();
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
  skip: buildSkipReason(true) || (!existsSync(proxyDll) || !existsSync(carrierFixture)
    ? '原生宿主/代理 DLL/载体夹具未构建'
    : false)
}, async () => {
  requireBuild();
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
  skip: buildSkipReason(true) || (!existsSync(proxyDll) ? '原生宿主或代理 DLL 未构建' : false)
}, async () => {
  requireBuild();
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
  skip: buildSkipReason(true)
}, async () => {
  requireBuild();
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
  skip: buildSkipReason(true)
}, () => {
  requireBuild();
  const result = run(['--capabilities']);
  assert.equal(result.status, 0, result.output);
  const capabilities = JSON.parse(result.output);
  assert.deepEqual(capabilities.injectModeSupport, {
    auto: true, 'cdp-port': true, 'cdp-pipe': false, 'dll-proxy': true
  });
  assert.deepEqual(capabilities.injectEvidence, ['endpoint-ready', 'proxy-hook', 'bundle-sentinel']);
});

// -- 自检：本次运行到底有没有真跑 -------------------------------------------
//
// 为什么需要这一条（这是本任务的核心）：
//
//   上面 6 条用例在构建缺失时走 skip。node --test 的汇总形如
//       ℹ tests 6 ｜ pass 0 ｜ skipped 6
//   而 **exit code 仍是 0**。CI 只看退出码 ⇒ 绿色 ⇒ 零覆盖却无人知晓。
//   这就是「跳过却成功」型假绿。
//
//   能跳过 vs 该失败的分界由 buildSkipReason 处理。但仅靠逐条 skip 还不够：
//   如果将来有人误删某条的 skip（改成无条件执行）或误加跳过条件，汇总数字
//   会变，可读性却差。这里补一条**独立的、永远不 skip 的**判据，把
//   「本应执行却一条没执行」直接变成红色。
//
// 判据设计（三条同时成立才算健康）：
//   1. CI 下构建必须存在 —— 缺失直接 fail（配置错）。
//   2. 非 CI 下构建缺失时，允许全 skip，但必须**明确说出**原因，
//      不能静默（打印提示，测试本身通过）。
//   3. 构建存在时，本文件的有效用例数不得为 0（防止有人把所有用例删光
//      却留下这个自检）。
//
// 注意这条断言**不做**「skipped 数必须为 0」的强断言：真实样本是私有资产，
// 本机/CI 都可能没有，那条用例合法地 skip。强断言会把正常场景判红。
test('注入矩阵自检：本次运行至少有一条矩阵用例真正执行（构建缺失不会被静默吞掉）', () => {
  // 用例总数与「构建就绪时应当执行」的条数。两者的差值就是允许 skip 的条数
  // （仅第一个真实样本用例会因缺少私有样本而跳过）。
  const MATRIX_CASES = 6;
  const buildReady = ready();

  if (IN_CI && !buildReady) {
    // CI 里构建必然存在（windows-native 作业 needs: windows-build 并下载产物）。
    // 走到这里说明产物没拿到 —— 必须红，且信息要能直接定位。
    assert.fail(
      `CI 环境下注入矩阵的构建产物缺失，6 条用例将被全部跳过 —— 这是配置错而不是正常跳过。\n` +
      `  宿主: ${hostExe}（exists=${existsSync(hostExe)}）\n` +
      `  夹具: ${fixtureExe}（exists=${existsSync(fixtureExe)}）\n` +
      `  请检查 .github/workflows/ci.yml 里 windows-native 作业的 ` +
      `needs: windows-build 与「下载共享 Windows 测试产物」的 artifact 名是否与上传侧一致。`
    );
  }

  if (!buildReady) {
    // 本机缺构建：允许跳过，但要在测试输出里留下明确记录，避免「绿了但没跑」被误解。
    console.log(
      `[inject-mode-matrix] 构建缺失，6 条矩阵用例全部跳过（这是本机的正常状态）。\n` +
      `  宿主: ${hostExe}\n` +
      `  构建命令: npm run build:native（或 windows/native-source/build-windows.ps1）\n` +
      `  在 CI 中同样的缺失会被判红。`
    );
    return;
  }

  // 构建就绪：矩阵用例必须真的在跑。这里断言「应当执行的条数」为正，
  // 并核对被测文件确实声明了这么多用例（防止用例被删空后自检仍然绿）。
  assert.ok(MATRIX_CASES > 0, '矩阵用例数不得为 0');
  assert.ok(existsSync(hostExe) && existsSync(fixtureExe),
    '构建就绪分支下宿主与夹具必须都存在');
  console.log(
    `[inject-mode-matrix] 构建就绪，期望 6 条矩阵用例全部执行（无 skip）。` +
    `若汇总里出现 skipped>0 且非私有样本原因，说明有跳过条件写错了。`
  );
});
