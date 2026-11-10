// 生成 tests/fixtures/inject-report/*.json。
//
// ★ 为什么要有这个生成器，而不是手写 JSON ★
//
// 这些 fixture 是「真实宿主写出来的 report.json」的裁剪，字段顺序、键名、
// reasonCounts 的枚举项都直接取自 audit.c 的序列化代码 + 一份真实运行的产物。
// 手写 JSON 会漏掉 reasonCounts 的 8 个键（no-listener / listener-not-owned / …），
// 而 jsons 的键名一旦和宿主不一致，判据脚本读到 undefined 会静默当成 false，
// fixture 就变成了「测一个不存在的形状」——那正是假钉子的常见来源。
//
// 基线来自：chaoxing_plus.exe --client process-fixture.exe --duration 2 --report X
// 真实产物（2026-11-10 实测）：
//   {"version":"0.1.0","host":"native","startedAt":"…","finishedAt":"…","mode":"launch",
//    "durationMs":0,"clientPid":0,"port":0,"attached":false,"ownershipVerified":false,
//    "success":false,"executionMode":"normal","injectStrategy":"hybrid",
//    "stopReason":"discovery-failed","injectMode":"unknown","commandLineInjected":false,
//    "injectEvidence":{…},"endpointProbe":{…,"reasonCounts":{"no-listener":0,…}},
//    "totals":{"contexts":0,"bootstraps":0,"bundles":0,"errors":1,"reconnects":0,"pageSessions":0}}
//
// 每个 fixture 只改「这条判据需要的那几个字段」，其余保持基线，避免一处改动同时命中多条判据。
//
// 用法：node scripts/ci/make-inject-report-fixtures.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('tests/fixtures/inject-report');
mkdirSync(outDir, { recursive: true });

// 真实宿主的 endpointProbe.reasonCounts 有且只有这 8 个键（audit.c 按 CX_ENDPOINT_REASON 枚举序列化）。
const reasonCounts = {
  'no-listener': 0,
  'listener-not-owned': 0,
  'listener-query-failed': 0,
  'listener-binding-rejected': 0,
  'http-failed': 0,
  'invalid-version': 0,
  'browser-mismatch': 0,
  ready: 0
};

function baseReport(overrides = {}) {
  return {
    version: '0.1.0',
    host: 'native',
    startedAt: '2026-11-10T19:34:46.960Z',
    finishedAt: '2026-11-10T19:44:46.961Z',
    mode: 'launch',
    durationMs: 600000,
    clientPid: 4321,
    port: 51000,
    attached: false,
    ownershipVerified: true,
    success: true,
    executionMode: 'normal',
    injectStrategy: 'hybrid',
    stopReason: 'duration',
    injectMode: 'cdp-port',
    commandLineInjected: false,
    injectEvidence: {
      endpointReady: true,
      proxyHook: false,
      proxyHookRequired: false,
      bundleInPage: true,
      bundleSentinelRejected: false,
      verified: true,
      reason: 'verified'
    },
    endpointProbe: {
      attempts: 2,
      elapsedMs: 40,
      listenerSeen: true,
      ownershipVerified: true,
      versionResponseReceived: true,
      lastReason: 'ready',
      reasonCounts: { ...reasonCounts, ready: 2 }
    },
    totals: { contexts: 1, bootstraps: 1, bundles: 1, errors: 0, reconnects: 0, pageSessions: 1 },
    ...overrides
  };
}

/** 只覆盖 injectEvidence 的若干字段，其余保持该态自己的基线。 */
function withEvidence(evidence, totals) {
  const report = baseReport();
  report.injectEvidence = { ...report.injectEvidence, ...evidence };
  if (totals) report.totals = { ...report.totals, ...totals };
  return report;
}

const fixtures = {
  // 1) 绿：端点就绪 + bootstrap ACK + 哨兵确认为 true。
  'bundle-in-page-true.json': baseReport(),

  // 2) 红（t72 第三级）：链路确实跑通（endpointReady + bootstraps>=1），但 bundle 从未落地。
  //    这正是 2026-11-10 六个真实客户端用例的状态，以前只记黄，等于承认从未注入成功还发绿灯。
  'bundle-in-page-false-chain-ran.json': withEvidence(
    { bundleInPage: false, verified: false, reason: 'bundle-unverified' }
  ),

  // 3) 黄：**唯一能走到分级逻辑、且 chainRan=false** 的形态。
  //
  //    ⚠️ 这里有一个必须写清楚的可达性事实（2026-11-11 实测）：
  //    脚本在 injectEvidence 分级之前还有三条既有断言 pageSessions/bootstraps/bundles >= 1
  //    （:389-391）。所以任何「计数全 0」的报告都会先在那里判红，根本到不了分级逻辑。
  //    配合 chainRan = endpointReady && bootstraps>=1，实际可达的黄色只有一种：
  //      endpointReady=false + 计数照常（>=1）+ bundleInPage=false
  //    也就是「端口没应答，但宿主仍然记到了页面会话与引导」——典型于端点探测超时、
  //    或 attach 模式下端口在探测窗口之后才可用。这一态不属于注入回归，故记黄。
  'bundle-unverified-chain-not-ran.json': withEvidence({
    endpointReady: false,
    bundleInPage: false,
    bundleSentinelRejected: false,
    verified: false,
    reason: 'not-started'
  }),

  // 4) 红（t72 新增态）：客户端静态导入表里有载体 DLL、DLL 也在盘上，却零代理日志
  //    ⇒ DLL 根本没被执行（被 AV 拦下 / 改名 / 加载失败）。与 UNKNOWN 的区别是「可证明」。
  'carrier-absent.json': withEvidence({
    endpointReady: false,
    proxyHook: false,
    proxyHookRequired: true,
    bundleInPage: false,
    bundleSentinelRejected: false,
    verified: false,
    reason: 'proxy-carrier-absent'
  }),

  // 5) 红：页面明确否定（哨兵回答 false 或抛异常）。「确定没跑」而非「看不到」。
  'sentinel-rejected.json': withEvidence({
    bundleInPage: false,
    bundleSentinelRejected: true,
    verified: false,
    reason: 'bundle-sentinel-rejected'
  }),

  // 6) 红：报告契约被改坏——整份 injectEvidence 缺失。判据必须先发现这件事，
  //    而不是把它当成「全部 false」静默放过。
  'evidence-missing.json': (() => {
    const report = baseReport();
    delete report.injectEvidence;
    return report;
  })()
};

for (const [name, report] of Object.entries(fixtures)) {
  writeFileSync(path.join(outDir, name), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${name}\n`);
}
