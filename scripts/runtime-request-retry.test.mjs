import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/core/utils/request.js';

test('runtime request retries a transient GET and returns the eventual response', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return Response.json({ ok: true });
  };
  try {
    assert.deepEqual(await request('https://example.test/data', {
      retry: { maxAttempts: 3, delayMs: 0 }, timeoutMs: 1000
    }), { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime request does not retry 404 or user cancellation', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('missing', { status: 404 });
  };
  try {
    await assert.rejects(request('https://example.test/data', { retry: { maxAttempts: 3, delayMs: 0 } }), /missing/);
    assert.equal(calls, 1);
    controller.abort();
    await assert.rejects(request('https://example.test/data', {
      retry: { maxAttempts: 3, delayMs: 0 }, signal: controller.signal
    }), (error) => error.name === 'AbortError');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime request aborts in-flight fetch on total timeout without leaving a background request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let aborted = false;
  globalThis.fetch = async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('request aborted', 'AbortError'));
      }, { once: true });
    });
  };
  try {
    await assert.rejects(request('https://example.test/data', {
      retry: { maxAttempts: 1, delayMs: 0 }, timeoutMs: 20
    }), /timeout|abort/i);
    assert.equal(aborted, true);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime request respects Retry-After on 429 within retry budget', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } })
      : Response.json({ ok: true });
  };
  try {
    assert.deepEqual(await request('https://example.test/data', {
      retry: { maxAttempts: 3, delayMs: 0 }, timeoutMs: 1000
    }), { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime request waits for a nonzero Retry-After before retrying', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.02' } })
      : Response.json({ ok: true });
  };
  try {
    const startedAt = Date.now();
    await request('https://example.test/data', {
      retry: { maxAttempts: 3, delayMs: 0 }, timeoutMs: 1000
    });
    assert.ok(Date.now() - startedAt >= 15);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime request never replays an unknown POST but retries one with an idempotency key', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return Response.json({ ok: true });
  };
  try {
    await assert.rejects(request('https://paid-provider.test/search', {
      method: 'post', data: { question: 'q' }, retry: { maxAttempts: 3, delayMs: 0 }
    }), /Failed to fetch/);
    assert.equal(calls, 1);
    calls = 0;
    assert.deepEqual(await request('https://adapter.test/search', {
      method: 'post', headers: { 'Idempotency-Key': 'same-action' },
      data: { question: 'q' }, retry: { maxAttempts: 3, delayMs: 0 }
    }), { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime request does not retry a programming TypeError and uses a finite default timeout', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let calls = 0;
  const timeoutValues = [];
  globalThis.setTimeout = (callback, timeout, ...args) => {
    timeoutValues.push(timeout);
    return originalSetTimeout(callback, timeout, ...args);
  };
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError('Invalid URL');
  };
  try {
    await assert.rejects(request('https://example.test/data', {
      retry: { maxAttempts: 3, delayMs: 0 }
    }), /Invalid URL/);
    assert.equal(calls, 1);
    assert.ok(timeoutValues.some((ms) => ms > 0 && ms <= 60000));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});
