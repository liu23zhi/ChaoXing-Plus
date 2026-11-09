// request.ts 的适配器错误分类与重试边界。
//
// 这里的每一条都对应线上真实故障形态：
//   - 适配器 200 响应里带 error 且没有答案 —— 不抛就会把空答案当成功写进缓存；
//   - 钱包/额度错误被当成网络抖动重试 —— 只会重复计费，必须立刻停；
//   - Retry-After 可能是 HTTP-date 而不是秒数 —— 只按 Number() 解析会退化成固定退避；
//   - 剩余预算不够一次退避时 —— 继续等只会把总超时撑爆，应直接抛出最后一次错误。
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./ci/ts-source-hooks.mjs', import.meta.url);
const { request } = await import('../src/core/utils/request.js');
const errors = await import('../src/core/utils/tiku-adapter-error.js');

const adapterUrl = 'https://retry.adapter.test/adapter-service/search';
const authHeaders = (key) => ({ Authorization: `Bearer ${key}` });

async function withFetch(handler, body) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

test('adapter 200 carrying an error and no answer fails instead of caching an empty answer', async () => {
  await withFetch(async () => Response.json({
    success: false,
    error: { code: 'UPSTREAM_ERROR', message: 'model requires Responses' }
  }), async () => {
    await assert.rejects(
      request(adapterUrl, { method: 'post', headers: { ...authHeaders('empty-answer-key'), 'Idempotency-Key': 'x' } }),
      (error) => {
        assert.equal(error.code, 'UPSTREAM_ERROR', '必须按分类抛，而不是返回空对象');
        assert.doesNotMatch(error.message, /requires Responses/u, '上游原文不能透给用户');
        return true;
      }
    );
  });
});

test('a 200 adapter response with an error but a real answer stays usable', async () => {
  await withFetch(async () => Response.json({
    error: { code: 'UPSTREAM_ERROR' },
    answer: { answerKeyText: 'A' }
  }), async () => {
    const result = await request(adapterUrl, { method: 'post', headers: authHeaders('partial-key') });
    assert.equal(result.answer.answerKeyText, 'A');
  });
});

test('wallet balance reported on a 200 response blocks that scope without further requests', async () => {
  const key = 'wallet-200-key';
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return Response.json({ error: { code: 'INSUFFICIENT_BALANCE' } });
  }, async () => {
    await assert.rejects(request(adapterUrl, { method: 'post', headers: authHeaders(key) }), /余额不足/u);
    await assert.rejects(request(adapterUrl, { method: 'post', headers: authHeaders(key) }), /余额不足/u);
    assert.equal(calls, 1, '第二次必须在本地就短路，不能再打网络');
  });
  // 别的 Key 不受影响。
  await withFetch(async () => { calls++; return Response.json({ answer: { answerText: 'B' } }); }, async () => {
    const result = await request(adapterUrl, { method: 'post', headers: authHeaders('wallet-other-key') });
    assert.equal(result.answer.answerText, 'B');
  });
  errors.resetTikuAdapterBalanceGuard('https://retry.adapter.test', key);
});

test('a 4xx adapter response never retries, a 5xx one does', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return Response.json({ error: { code: 'UPSTREAM_ERROR' } }, { status: 500 });
  }, async () => {
    await assert.rejects(request(adapterUrl, {
      method: 'post', headers: { ...authHeaders('5xx-key'), 'Idempotency-Key': 'k' }, retry: { maxAttempts: 2, delayMs: 0 }
    }));
    assert.equal(calls, 2, '5xx 属于可重试状态');
  });

  calls = 0;
  await withFetch(async () => {
    calls++;
    return Response.json({ error: { code: 'INVALID_INPUT' } }, { status: 400 });
  }, async () => {
    await assert.rejects(request(adapterUrl, {
      method: 'post', headers: { ...authHeaders('4xx-key'), 'Idempotency-Key': 'k' }, retry: { maxAttempts: 3, delayMs: 0 }
    }));
    assert.equal(calls, 1, '400 重试也只会再错一次');
  });
});

test('Retry-After as an HTTP-date is honoured as a delay, not ignored', async () => {
  let calls = 0;
  // HTTP-date 只精确到秒，toUTCString() 会把毫秒抹掉 —— 若只给 +200ms，解析结果可能落到
  // 「已过期」而被 clamp 成 0，测试就会假失败。这里留出足够跨秒的余量。
  const retryAt = new Date(Date.now() + 2000).toUTCString();
  await withFetch(async () => {
    calls++;
    return calls === 1
      ? new Response('slow down', { status: 429, headers: { 'Retry-After': retryAt } })
      : Response.json({ ok: true });
  }, async () => {
    const startedAt = Date.now();
    assert.deepEqual(await request('https://example.test/data', {
      retry: { maxAttempts: 2, delayMs: 0 }, timeoutMs: 8000
    }), { ok: true });
    assert.ok(Date.now() - startedAt >= 500, `HTTP-date 形式的 Retry-After 必须真的等待，实际 ${Date.now() - startedAt}ms`);
    assert.equal(calls, 2);
  });
});

test('a retry whose backoff exceeds the remaining budget throws instead of stalling past the deadline', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response('rate limited', { status: 429, headers: { 'Retry-After': '5' } });
  }, async () => {
    const startedAt = Date.now();
    await assert.rejects(request('https://example.test/data', {
      retry: { maxAttempts: 5, delayMs: 0 }, timeoutMs: 300
    }), /rate limited/u);
    assert.equal(calls, 1, '等待 5s 超过 300ms 预算，不该再发请求');
    assert.ok(Date.now() - startedAt < 3000, `不应真的睡满 Retry-After：${Date.now() - startedAt}ms`);
  });
});

test('text response type returns the raw body and still classifies non-ok responses', async () => {
  await withFetch(async () => new Response('plain body', { status: 200 }), async () => {
    const body = await request('https://example.test/text', { responseType: 'text' });
    assert.equal(body, 'plain body');
  });
  await withFetch(async () => new Response('missing', { status: 404 }), async () => {
    await assert.rejects(request('https://example.test/text', { responseType: 'text' }), (error) => {
      assert.equal(error.status, 404, '非适配器请求保留状态码，供上层区分');
      return true;
    });
  });
});

test('an already aborted signal fails before any network call', async () => {
  const controller = new AbortController();
  controller.abort(new Error('user cancelled'));
  let calls = 0;
  await withFetch(async () => { calls++; return Response.json({}); }, async () => {
    await assert.rejects(
      request('https://example.test/data', { signal: controller.signal }),
      /user cancelled/u
    );
    assert.equal(calls, 0, '取消后不该有任何在途请求');
  });
});

test('aborting during the retry delay stops waiting and surfaces the abort reason', async () => {
  const controller = new AbortController();
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } });
  }, async () => {
    const pending = request('https://example.test/data', {
      retry: { maxAttempts: 3, delayMs: 0 }, timeoutMs: 10000, signal: controller.signal
    });
    setTimeout(() => controller.abort(new Error('cancelled while waiting')), 20);
    await assert.rejects(pending, /cancelled while waiting/u);
    assert.equal(calls, 1);
  });
});
