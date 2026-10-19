import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const outDir = resolve('.tmp-tests-adapter-errors-cjs');
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, 'package.json'), '{"type":"commonjs"}');
execFileSync(process.execPath, [
  resolve('node_modules/typescript/bin/tsc'), resolve('src/core/utils/request.ts'),
  resolve('src/projects/tiku-adapter-config.ts'), '--outDir', outDir,
  '--module', 'commonjs', '--target', 'es2022', '--moduleResolution', 'node', '--skipLibCheck'
]);
const require = createRequire(import.meta.url);
const { request } = require(resolve(outDir, 'core/utils/request.js'));
const adapter = require(resolve(outDir, 'projects/tiku-adapter-config.js'));
const raw = 'AI联网搜题第1轮失败（已尝试3次）: 对方服务器异常 (HTTP 400): model requires Responses; this account only supports Chat Completions';
const config = { baseurl: 'https://adapter.local', key: 'error-test-key' };
const searchUrl = `${config.baseurl}/adapter-service/search`;
const opts = { method: 'post', headers: { Authorization: `Bearer ${config.key}` }, retry: { maxAttempts: 3, delayMs: 0 } };
const fallbackOpts = { preferAsyncTask: false, retryAttempts: 3, retryDelayMs: 0, requestTimeoutMs: 1000 };

test('ordinary search hides upstream raw HTTP failures and never retries a 400', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: { code: 'UPSTREAM_ERROR', message: raw } }, { status: 400 }); };
  try {
    await assert.rejects(request(searchUrl, opts), (err) => {
      assert.equal(err.message, '服务器内部错误，搜题失败。');
      return true;
    });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('fallback hides legacy raw error fields in both rendered error and stored response', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: false, failureDetail: raw, error: { code: 'UPSTREAM_ERROR', message: raw } });
  try {
    const infos = await adapter.requestTikuAdapterAIFallback(config, { title: 'question' }, fallbackOpts);
    assert.equal(infos[0].error, 'UPSTREAM_ERROR: 服务器内部错误，搜题失败。');
    assert.doesNotMatch(JSON.stringify(infos), /requires Responses|对方服务器|failureDetail/);
  } finally { globalThis.fetch = previous; }
});

test('legacy balance 401 blocks ordinary search and both fallback modes until explicit recovery', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ errCode: 401, message: '访问令牌鉴权失败', detail: '当前余额不足，系统题库已禁用，请充值后再使用' }, { status: 401 });
  };
  try {
    await assert.rejects(request(searchUrl, opts), /余额不足/);
    await assert.rejects(request(searchUrl, opts), /余额不足/);
    for (const preferAsyncTask of [false, true]) {
      await assert.rejects(adapter.requestTikuAdapterAIFallback(config, { title: 'another question' }, { ...fallbackOpts, preferAsyncTask }), /余额不足/);
    }
    assert.equal(calls, 1);
    await assert.rejects(request(searchUrl, { ...opts, headers: { Authorization: 'Bearer different-key' } }), /余额不足/);
    assert.equal(calls, 2, 'a different key must be independent');
    assert.equal(typeof adapter.resetTikuAdapterBalanceGuard, 'function');
    adapter.resetTikuAdapterBalanceGuard(config);
    globalThis.fetch = async () => { calls++; return Response.json({ question: 'question', answer: { answerText: 'answer' } }); };
    const response = await request(searchUrl, opts);
    assert.equal(response.answer.answerText, 'answer');
    assert.equal(calls, 3);
  } finally { globalThis.fetch = previous; }
});

test('structured fallback balance blocks later questions without network retries', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  const localConfig = { ...config, key: 'structured-balance-key' };
  globalThis.fetch = async () => { calls++; return Response.json({ success: false, error: { code: 'INSUFFICIENT_BALANCE', message: '当前余额不足，AI 兜底已禁用，请充值后再使用' } }); };
  try {
    const infos = await adapter.requestTikuAdapterAIFallback(localConfig, { title: 'first' }, fallbackOpts);
    assert.match(infos[0].error, /INSUFFICIENT_BALANCE/);
    await assert.rejects(adapter.requestTikuAdapterAIFallback(localConfig, { title: 'next' }, fallbackOpts), /余额不足/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('successful partial results remain usable and unrecognized upstream credits do not block the user', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  const localConfig = { ...config, key: 'upstream-credits-key' };
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ success: false, error: { code: 'UPSTREAM_ERROR', message: 'upstream insufficient credits 余额不足' } });
  };
  try {
    await adapter.requestTikuAdapterAIFallback(localConfig, { title: 'first' }, fallbackOpts);
    await adapter.requestTikuAdapterAIFallback(localConfig, { title: 'second' }, fallbackOpts);
    assert.equal(calls, 2, 'upstream credits must not set the customer balance block');
    const wrapper = adapter.createTikuAdapterAnswererWrapper(config);
    const handler = Function(wrapper.handler)();
    assert.deepEqual(handler({ question: 'q', type: 0, answer: { answerKeyText: 'A' }, error: { code: 'UPSTREAM_ERROR', message: raw } }), ['q', 'A', { source: 'tikuAdapter' }]);
  } finally { globalThis.fetch = previous; }
});
