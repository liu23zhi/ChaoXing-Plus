import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

const outDir = createTestDirectory('adapter-quota-cjs');
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'package.json'), '{"type":"commonjs"}');
execFileSync(process.execPath, [resolveTestPath('scripts', 'test-helpers', 'tsc-compat.mjs'),
  resolveTestPath('src', 'projects', 'tiku-adapter-config.ts'), '--outDir', outDir,
  '--module', 'commonjs', '--target', 'es2022', '--moduleResolution', 'node', '--skipLibCheck']);
const require = createRequire(import.meta.url);
const adapter = require(resolve(outDir, 'projects/tiku-adapter-config.js'));
const errors = require(resolve(outDir, 'core/utils/tiku-adapter-error.js'));
const quota = 'ACCESS_TOKEN_QUOTA_EXCEEDED';
const quotaMessage = '当前 Key 额度已用尽或本次请求将超额，请调整额度或更换 Key 后重试。';
const config = { baseurl: 'https://quota.adapter.test', key: 'synthetic-key' };
const options = { requestTimeoutMs: 500, statusTimeoutMs: 2000, pollIntervalMs: 1, retryAttempts: 3, retryDelayMs: 0 };
const failure = { success: false, error: { code: quota, message: '访问令牌累计额度不足' } };
const reject = { errCode: 401, code: quota, message: '访问令牌鉴权失败', detail: '访问令牌累计额度不足' };

test('quota machine code is distinct from wallet, generic auth and untrusted upstream wording', () => {
  for (const payload of [reject, failure]) {
    const err = errors.createTikuAdapterRequestError(payload, 401);
    assert.equal(err.code, quota);
    assert.equal(err.message, quotaMessage);
    assert.doesNotMatch(err.message, /充值|余额|登录/);
    assert.equal(errors.isTikuAdapterInsufficientBalance(payload, 401), false);
  }
  assert.equal(errors.createTikuAdapterRequestError({ code: 'INSUFFICIENT_BALANCE' }, 401).code, 'INSUFFICIENT_BALANCE');
  assert.equal(errors.createTikuAdapterRequestError({ message: 'JWT expired' }, 401).code, 'UPSTREAM_ERROR');
  assert.equal(errors.createTikuAdapterRequestError({ error: { code: 'UPSTREAM_ERROR', message: quota } }, 503).code, 'UPSTREAM_ERROR');
});

for (const status of [200, 401, 503]) {
  for (const preferAsyncTask of [false, true]) {
    test(`AI quota response HTTP${status} async=${preferAsyncTask} preserves actionable code without create/retry/fallback`, async () => {
      const previous = globalThis.fetch; const calls = [];
      const local = { ...config, key: `quota-${status}-${preferAsyncTask}` };
      globalThis.fetch = async (url, init) => { calls.push([url, init]); return Response.json(status === 200 ? failure : reject, { status }); };
      try {
        const infos = await adapter.requestTikuAdapterAIFallback(local, { title: 'q' }, { ...options, preferAsyncTask });
        assert.equal(infos[0].response.error.code, quota);
        assert.equal(infos[0].response.error.message, quotaMessage);
        assert.equal(infos[0].error, `${quota}: ${quotaMessage}`);
        assert.equal(infos[0].response.taskId, undefined);
        assert.equal(calls.length, 1);
        assert.equal(new URL(calls[0][0]).pathname, preferAsyncTask ? '/api/ai-fallback/tasks' : '/api/ai-fallback');
        assert.equal(errors.isTikuAdapterBalanceBlocked(local.baseurl, local.key), false);
      } finally { globalThis.fetch = previous; adapter.resetTikuAdapterBalanceGuard(local); }
    });
  }
}

test('ordinary legacy quota rejection is terminal and does not change body or Authorization', async () => {
  const previous = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init]); return Response.json(reject, { status: 401 }); };
  try {
    const wrapper = adapter.createTikuAdapterAnswererWrapper({ ...config, asyncSearch: false });
    const payload = { qid: '', question: 'q', options: ['A'], type: 0, courseName: '', extra: '', skipCache: false };
    await assert.rejects(wrapper.executeRequest({ data: payload, timeoutMs: 500 }), err => err.code === quota && err.status === 401 && err.message === quotaMessage);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].headers.Authorization, 'Bearer synthetic-key');
    assert.deepEqual(JSON.parse(calls[0][1].body), payload);
  } finally { globalThis.fetch = previous; }
});

test('quota task-status failure polls only existing task and never creates a replacement or sync request', async () => {
  const previous = globalThis.fetch; const methods = [];
  globalThis.fetch = async (url, init) => {
    methods.push([init.method, new URL(url).pathname]);
    return init.method === 'POST'
      ? Response.json({ success: false, status: 'pending', taskId: 'paid-task' }, { status: 202 })
      : Response.json({ ...failure, status: 'failed', taskId: 'paid-task' });
  };
  try {
    const infos = await adapter.requestTikuAdapterAIFallback({ ...config, key: 'quota-poll-key' }, { title: 'q' }, options);
    assert.equal(infos[0].response.error.code, quota);
    assert.equal(infos[0].response.taskId, 'paid-task');
    assert.deepEqual(methods.map(([method]) => method), ['POST', 'GET', 'GET', 'GET']);
  } finally { globalThis.fetch = previous; }
});

for (const kind of ['normal', 'AI']) {
  test(`${kind} already-created paid task status remains retrievable if a concurrent new request blocks wallet`, async () => {
    const previous = globalThis.fetch; const local = { ...config, key: `paid-status-${kind}` }; const methods = [];
    globalThis.fetch = async (url, init) => {
      const parsed = new URL(url); const path = parsed.pathname; methods.push([init.method, path, parsed.searchParams.get('taskId')]);
      if (path.endsWith('/health')) return Response.json({ success: true, status: 'succeeded', taskId: 'health', statusUrl: '/api/search/status?taskId=health' });
      if (parsed.searchParams.get('taskId') === 'health') return Response.json({ success: true, status: 'succeeded', taskId: 'health', result: { answer: {} } });
      if (init.method === 'POST') {
        errors.markTikuAdapterBalanceBlocked(local.baseurl, local.key);
        return Response.json({ success: false, status: 'pending', taskId: 'paid-task' }, { status: 202 });
      }
      return Response.json({ success: true, status: 'succeeded', taskId: 'paid-task', result: kind === 'AI' ? { answer: 'already-paid' } : { question: 'q', answer: { answerText: 'already-paid' } } });
    };
    try {
      const result = kind === 'AI'
        ? await adapter.requestTikuAdapterAIFallback(local, { title: 'q' }, options)
        : await adapter.requestTikuAdapterSearchTask(local, { question: 'q', type: 4 }, options);
      assert.match(JSON.stringify(result), /already-paid/);
      assert.equal(methods.filter(([m]) => m === 'POST').length, 1);
      assert.equal(methods.filter(([, p, id]) => p.endsWith('/status') && id !== 'health').length, 1);
    } finally { globalThis.fetch = previous; adapter.resetTikuAdapterBalanceGuard(local); }
  });
}

test('uncertain async create retries exact operation even if concurrent wallet block appears, then delivers paid result', async () => {
  const previous = globalThis.fetch; const local = { ...config, key: 'replay-paid-key' }; const creates = []; let statuses = 0;
  globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') {
      creates.push([url, init.headers['Idempotency-Key'], init.body]);
      if (creates.length === 1) { errors.markTikuAdapterBalanceBlocked(local.baseurl, local.key); throw new TypeError('Failed to fetch'); }
      return Response.json({ success: false, status: 'pending', taskId: 'original-paid' }, { status: 202 });
    }
    statuses++; return Response.json({ success: true, status: 'succeeded', taskId: 'original-paid', result: { answer: 'paid-replay' } });
  };
  try {
    const result = await adapter.requestTikuAdapterAIFallback(local, { title: 'q' }, { ...options, idempotencyKey: 'same-paid-operation' });
    assert.match(JSON.stringify(result), /paid-replay/);
    assert.equal(creates.length, 2); assert.deepEqual(creates[0], creates[1]); assert.equal(statuses, 1);
  } finally { globalThis.fetch = previous; adapter.resetTikuAdapterBalanceGuard(local); }
});
