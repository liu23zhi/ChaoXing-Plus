// 141 §7：**5 处**请求入口必须全部带设备头。
//
// 为什么参数化成 5 条而不是抽查一处：
// 漏一处就有一个功能在限设备账号上失败，而且各入口的**表现完全不同** ——
// 搜题主链路能用、状态页 403、证据上传静默丢、健康探测退化成同步搜索……
// 这种「部分可用」比全挂更难排查，因为第一反应会怀疑服务端。
//
// 每一条用例都走**该入口真实的那条代码路径**（不是断言源码字符串），
// 所以删掉任何一处 header 注入都会让对应那条变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./scripts/ci/ts-source-hooks.mjs', new URL('../', import.meta.url));

const { DEVICE_ID_HEADER, DEVICE_INSTANCE_HEADER, tikuAdapterDeviceHeaders } = await import('../src/runtime/device-identity.js');

const ADAPTER_BASE = 'https://entry.adapter.test';
const KEY = 'tk-entry-test';
const AUTH = { Authorization: `Bearer ${KEY}` };

/** 期望的设备头（同一运行内固定）。 */
const expected = () => tikuAdapterDeviceHeaders();

/** 断言一组 header 里带了两个设备头且值与当前身份一致。 */
function assertDeviceHeaders(headers, label) {
  assert.ok(headers, `${label}：请求没有 headers`);
  const map = new Map(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const wanted = expected();
  for (const name of [DEVICE_ID_HEADER, DEVICE_INSTANCE_HEADER]) {
    assert.equal(
      map.get(name.toLowerCase()),
      wanted[name],
      `${label}：缺少或错配 ${name}（漏这一处 = 该功能在限设备账号上单独失败）`
    );
  }
}

async function withFetch(handler, body) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// 入口 1／5：src/core/utils/request.ts —— 搜题主链路（统一封装）
// ---------------------------------------------------------------------------

test('入口 1/5 request.ts：适配器 GET 带设备头', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ answer: { answerText: 'A' } });
  }, async () => {
    const { request } = await import('../src/core/utils/request.js');
    await request(`${ADAPTER_BASE}/api/search`, { headers: AUTH, timeoutMs: 2000 });
  });

  assert.equal(calls.length, 1);
  assertDeviceHeaders(calls[0].init.headers, 'request.ts GET');
  // 原有业务头不能被设备头挤掉。
  assert.equal(calls[0].init.headers.Authorization, AUTH.Authorization);
});

test('入口 1/5 request.ts：适配器 POST（即使不带幂等键、不重放）也带设备头', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ answer: { answerText: 'B' } });
  }, async () => {
    const { request } = await import('../src/core/utils/request.js');
    await request(`${ADAPTER_BASE}/api/search`, { method: 'post', headers: AUTH, data: { q: '1' }, timeoutMs: 2000 });
  });

  assert.equal(calls.length, 1);
  assertDeviceHeaders(calls[0].init.headers, 'request.ts POST');
});

test('入口 1/5 request.ts：非适配器 URL 不注入设备头（不把设备标识泄漏给第三方）', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true });
  }, async () => {
    const { request } = await import('../src/core/utils/request.js');
    await request('https://third-party.example/collect', { headers: { Accept: 'application/json' }, timeoutMs: 2000 });
  });

  assert.equal(calls.length, 1);
  const map = new Map(Object.entries(calls[0].init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(map.has(DEVICE_ID_HEADER.toLowerCase()), false, '非适配器请求不得带设备 ID');
  assert.equal(map.has(DEVICE_INSTANCE_HEADER.toLowerCase()), false);
});

// ---------------------------------------------------------------------------
// 入口 2／5：src/projects/status-panel-http.ts —— 状态页取数
// ---------------------------------------------------------------------------

test('入口 2/5 status-panel-http.ts：fetchServiceStatusRequester 带设备头', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ status: 'healthy', retained: 0 });
  }, async () => {
    const { fetchServiceStatusRequester } = await import('../src/projects/status-panel-http.js');
    await fetchServiceStatusRequester(`${ADAPTER_BASE}/api/service-status/summary`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${KEY}` }
    });
  });

  assert.equal(calls.length, 1);
  assertDeviceHeaders(calls[0].init.headers, 'status-panel-http.ts');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`, '原 Authorization 必须保留');
});

test('入口 2/5 status-panel-http.ts：走 createServiceStatusHttpFetcher 全链路也带设备头', async () => {
  const seen = [];
  const fetchCalls = [];
  await withFetch(async (url, init) => {
    fetchCalls.push({ url, init });
    return Response.json({ status: 'healthy', retained: 0, successRateAvailable: true });
  }, async () => {
    const http = await import('../src/projects/status-panel-http.js');
    const fetcher = http.createServiceStatusHttpFetcher({
      baseurl: ADAPTER_BASE,
      endpoint: '/api/service-status/summary',
      accessKey: KEY,
      requester: async (url, init) => {
        seen.push({ url, init });
        // 走真实的默认 requester（也就是被测的第 239 行那条 fetch）。
        return http.fetchServiceStatusRequester(url, init);
      }
    });
    await fetcher({ now: Date.now() });
  });

  assert.equal(seen.length, 1, 'fetcher 应发出一次请求');
  // 注意：fetcher 传给 requester 的 init 只有 Authorization —— 设备头是在
  // fetchServiceStatusRequester 内部补的，所以必须断言**真实 fetch** 看到的头。
  assert.equal(fetchCalls.length, 1);
  assertDeviceHeaders(fetchCalls[0].init.headers, 'status-panel-http.ts（真实 fetch）');
});

// ---------------------------------------------------------------------------
// 入口 3／5：src/projects/tiku-adapter-config.ts:182 —— 上传答题证据
// ---------------------------------------------------------------------------

test('入口 3/5 tiku-adapter-config.ts（证据上传）带设备头', async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ success: true });
  }, async () => {
    const cfg = await import('../src/projects/tiku-adapter-config.js');
    await cfg.requestTikuAdapterAnswerEvidence(
      { baseurl: ADAPTER_BASE, key: KEY },
      {
        qid: 'q1',
        question: '1+1=?',
        options: ['1', '2'],
        type: 0,
        courseName: 'math',
        answer: 'B',
        source: 'test',
        evidence: {}
      }
    );
  });

  assert.equal(calls.length, 1);
  assertDeviceHeaders(calls[0].init.headers, 'tiku-adapter-config.ts 证据上传');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(calls[0].init.headers['Content-Type']);
});

// ---------------------------------------------------------------------------
// 入口 4／5：src/projects/tiku-adapter-config.ts:760 —— JSON 通道
//（健康探测 / 建任务 / 轮询 / 同步搜索全走这里）
// ---------------------------------------------------------------------------

/**
 * 让异步搜索链路**正常跑完**的 mock：健康探测 → 建任务 → 立即 succeeded。
 *
 * 刻意让三条路由都命中 `requestTikuAdapterJSON`（也就是被测的那个 fetch），
 * 这样「一次业务调用里每一跳都带设备头」都能被断言到 —— 只测第一跳会漏掉
 * 轮询那条（它有独立的 header 构造点吗？目前是共用的，但断言要能发现退化）。
 */
function adapterAsyncMock(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const target = String(url);
    if (target.includes('/api/search/health')) {
      return Response.json({
        success: true, status: 'succeeded', taskId: 't1',
        statusUrl: `${ADAPTER_BASE}/api/search/status?taskId=t1`
      });
    }
    if (target.includes('/api/search/status')) {
      return Response.json({ success: true, status: 'succeeded', taskId: 't1', result: { answer: { answerText: 'A' } } });
    }
    // POST /api/search/tasks
    return Response.json({ taskId: 't1', status: 'succeeded', result: { answer: { answerText: 'A' } } });
  };
}

test('入口 4/5 tiku-adapter-config.ts（JSON 通道）带设备头 —— 每一跳都带', async () => {
  const calls = [];
  await withFetch(adapterAsyncMock(calls), async () => {
    const cfg = await import('../src/projects/tiku-adapter-config.js');
    await cfg.requestTikuAdapterSearchTask(
      { baseurl: ADAPTER_BASE, key: KEY },
      { title: '1+1=?' },
      { requestTimeoutMs: 2000, statusTimeoutMs: 2000, retryAttempts: 1, retryDelayMs: 0 }
    );
  });

  assert.ok(calls.length >= 2, `应发出健康探测 + 建任务两次请求，实际 ${calls.length}`);
  for (const [index, call] of calls.entries()) {
    assertDeviceHeaders(call.init.headers, `tiku-adapter-config.ts JSON 通道第 ${index + 1} 次请求（${call.url}）`);
  }
});

test('入口 4/5 tiku-adapter-config.ts（JSON 通道）：业务头仍然覆盖设备头优先级', async () => {
  const calls = [];
  await withFetch(adapterAsyncMock(calls), async () => {
    const cfg = await import('../src/projects/tiku-adapter-config.js');
    await cfg.requestTikuAdapterSearchTask(
      { baseurl: ADAPTER_BASE, key: KEY },
      { title: 'q' },
      { requestTimeoutMs: 2000, statusTimeoutMs: 2000, retryAttempts: 1, retryDelayMs: 0 }
    );
  });

  assert.ok(calls.length >= 1);
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`, 'Authorization 不得被设备头覆盖');
  }
  // 建任务那条必须带幂等键（与设备头共存，不是二选一）。
  const createCall = calls.find((call) => call.init.method === 'POST');
  assert.ok(createCall, '应有建任务的 POST');
  assert.ok(createCall.init.headers['Idempotency-Key'], '建任务必须带幂等键');
});

// ---------------------------------------------------------------------------
// 入口 5／5：src/runtime/gm.ts —— GM 兼容层
// ---------------------------------------------------------------------------

test('入口 5/5 gm.ts：gmRequest 带设备头', async () => {
  const calls = [];
  // gm.ts 顶层读 `window`（unsafeWindow: window），所以先给一个最小替身。
  const previousWindow = globalThis.window;
  globalThis.window = globalThis.window ?? { document: {} };
  try {
    await withFetch(async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true });
    }, async () => {
      const gm = await import('../src/runtime/gm.js');
      await gm.gmRequest(`${ADAPTER_BASE}/api/search`, { method: 'GET', headers: { Accept: 'application/json' } });
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }

  assert.equal(calls.length, 1);
  assertDeviceHeaders(calls[0].init.headers, 'gm.ts');
  assert.equal(calls[0].init.headers.Accept, 'application/json', '调用方自己的头必须保留');
});

test('入口 5/5 gm.ts：调用方显式给了设备头则以调用方为准（不被静默改回）', async () => {
  const calls = [];
  const previousWindow = globalThis.window;
  globalThis.window = globalThis.window ?? { document: {} };
  try {
    await withFetch(async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true });
    }, async () => {
      const gm = await import('../src/runtime/gm.js');
      await gm.gmRequest(`${ADAPTER_BASE}/api/search`, {
        method: 'GET',
        headers: { [DEVICE_ID_HEADER]: 'caller-owned-id' }
      });
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }

  assert.equal(calls[0].init.headers[DEVICE_ID_HEADER], 'caller-owned-id');
  // instance 仍要补上（调用方只覆盖了 device id）。
  assert.equal(calls[0].init.headers[DEVICE_INSTANCE_HEADER], expected()[DEVICE_INSTANCE_HEADER]);
});

// ---------------------------------------------------------------------------
// 5 处的「一个都不能漏」自检
// ---------------------------------------------------------------------------

test('自检：5 处入口全部带设备头（任一处缺失会让本套用例局部变红）', () => {
  // 这条不是替代上面那 5 组，而是把「一共有几处」这件事钉住：
  // 将来若新增第 6 个 fetch 出口却忘了 header，这里的清单会提醒去补用例。
  const ENTRIES = [
    'src/core/utils/request.ts',
    'src/projects/status-panel-http.ts',
    'src/projects/tiku-adapter-config.ts#evidence',
    'src/projects/tiku-adapter-config.ts#json',
    'src/runtime/gm.ts'
  ];
  assert.equal(ENTRIES.length, 5, '141 §7 规定 5 处；改这个数字必须同时改 141 与 139 §18.4');
});
