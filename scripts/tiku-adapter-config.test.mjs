import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const outDir = resolve(process.cwd(), '.tmp-tests-tiku-cjs');
const helperModulePath = resolve(outDir, 'projects', 'tiku-adapter-config.js');
const helperSourcePath = resolve(process.cwd(), 'src', 'projects', 'tiku-adapter-config.ts');
const tscCliPath = resolve(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');

async function compileHelperModule() {
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'package.json'), '{"type":"commonjs"}\n');
  await execFileAsync(process.execPath, [
    tscCliPath,
    helperSourcePath,
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck'
  ]);
}

async function loadHelperModule() {
  await compileHelperModule();
  const require = createRequire(import.meta.url);
  delete require.cache[helperModulePath];
  return require(helperModulePath);
}

test('normalizes baseurl by trimming whitespace and trailing slashes', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.normalizeTikuAdapterBaseUrl, 'function');
  assert.equal(mod.normalizeTikuAdapterBaseUrl(' https://example.com/// '), 'https://example.com');
});

test('resolves search url from normalized baseurl', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.createTikuAdapterSearchUrl, 'function');
  assert.equal(
    mod.createTikuAdapterSearchUrl('https://adapter.local/'),
    'https://adapter.local/adapter-service/search'
  );
});

test('creates bearer authorization header text', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.createTikuAdapterAuthorizationHeader, 'function');
  assert.equal(mod.createTikuAdapterAuthorizationHeader('  secret-key  '), 'Bearer secret-key');
});

test('reports missing key as an unavailable config', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.getTikuAdapterConfigProblem, 'function');
  assert.equal(
    mod.getTikuAdapterConfigProblem({
      baseurl: 'https://adapter.local',
      key: ''
    }),
    'missing-key'
  );
});

test('maps current chaoxing question types to tikuAdapter numeric types', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.resolveTikuAdapterQuestionType, 'function');
  assert.equal(mod.resolveTikuAdapterQuestionType('single'), 0);
  assert.equal(mod.resolveTikuAdapterQuestionType('multiple'), 1);
  assert.equal(mod.resolveTikuAdapterQuestionType('judgement'), 3);
  assert.equal(mod.resolveTikuAdapterQuestionType('completion'), 2);
  assert.equal(mod.resolveTikuAdapterQuestionType('line'), 2);
  assert.equal(mod.resolveTikuAdapterQuestionType('unknown'), 4);
});

test('creates a post fetch wrapper with bearer auth and adapter search url', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.createTikuAdapterAnswererWrapper, 'function');
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local/',
    key: 'demo-key'
  });

  assert.equal(wrapper.url, 'https://adapter.local/adapter-service/search');
  assert.equal(wrapper.method, 'post');
  assert.equal(wrapper.type, 'fetch');
  assert.equal(wrapper.contentType, 'json');
  assert.deepEqual(wrapper.headers, {
    Authorization: 'Bearer demo-key'
  });
  assert.ok(wrapper.timeoutSeconds >= 180);
  assert.ok(wrapper.retry?.maxAttempts >= 2);
});

test('tiku adapter wrapper prefers computed choice keys for objective choice answers', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.createTikuAdapterAnswererWrapper, 'function');
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local/',
    key: 'demo-key'
  });
  const handler = Function(wrapper.handler)();
  const result = handler({
    question: '多选题',
    type: 1,
    answer: {
      answerIndex: [0, 2],
      answerKeyText: 'AC',
      answerText: '答案一#答案二',
      bestAnswer: ['答案一', '答案二']
    }
  });

  assert.deepEqual(result, ['多选题', 'AC', { source: 'tikuAdapter' }]);
});

test('tiku adapter config exposes long AI fallback timeouts and status helpers', async () => {
  const mod = await loadHelperModule();

  assert.ok(mod.TIKU_ADAPTER_AI_FALLBACK_REQUEST_TIMEOUT_MS >= 180000);
  assert.ok(mod.TIKU_ADAPTER_AI_FALLBACK_STATUS_TIMEOUT_MS >= 300000);
  assert.ok(mod.TIKU_ADAPTER_AI_FALLBACK_WORKER_TIMEOUT_SECONDS >= 600);
  assert.equal(typeof mod.createTikuAdapterAIFallbackTaskUrl, 'function');
  assert.equal(typeof mod.createTikuAdapterAIFallbackStatusUrl, 'function');
  assert.equal(
    mod.createTikuAdapterAIFallbackTaskUrl('https://adapter.local/'),
    'https://adapter.local/adapter-service/ai-fallback/tasks'
  );
  assert.equal(
    mod.createTikuAdapterAIFallbackStatusUrl('https://adapter.local/', 'task-1'),
    'https://adapter.local/adapter-service/ai-fallback/status?taskId=task-1'
  );
});

test('AI fallback retries transient failures before returning an answer', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/adapter-service/ai-fallback/tasks')) {
      return new Response('not found', { status: 404 });
    }
    if (String(url).endsWith('/adapter-service/ai-fallback') && calls.filter((item) => String(item.url).endsWith('/adapter-service/ai-fallback')).length === 1) {
      return new Response('bad gateway', { status: 502 });
    }
    return Response.json({
      success: true,
      result: {
        question: '1+1=?',
        answer: '2'
      }
    });
  };

  try {
    const result = await mod.requestTikuAdapterAIFallback(
      { baseurl: 'https://adapter.local', key: 'secret' },
      { title: '1+1=?', type: 'single', options: '1\n2' },
      { requestTimeoutMs: 1000, retryAttempts: 2, retryDelayMs: 1, preferAsyncTask: true }
    );

    assert.equal(calls.length, 3);
    assert.equal(result[0].results[0].answer, '2');
    assert.equal(result[0].error, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI fallback calls the direct endpoint by default instead of probing the unsupported task route', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  const urls = [];

  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return Response.json({
      success: true,
      result: {
        question: '1+1=?',
        answer: '2'
      }
    });
  };

  try {
    const result = await mod.requestTikuAdapterAIFallback(
      { baseurl: 'https://adapter.local', key: 'secret' },
      { title: '1+1=?', type: 'single', options: '1\n2' },
      { requestTimeoutMs: 1000, retryAttempts: 1, retryDelayMs: 1 }
    );

    assert.deepEqual(urls, ['https://adapter.local/adapter-service/ai-fallback']);
    assert.equal(result[0].results[0].answer, '2');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI fallback polls task status until the adapter reports a final answer', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  const urls = [];
  let statusCalls = 0;

  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('/adapter-service/ai-fallback/tasks')) {
      return Response.json({
        success: false,
        status: 'running',
        taskId: 'task-1'
      });
    }
    if (String(url).includes('/adapter-service/ai-fallback/status')) {
      statusCalls++;
      if (statusCalls === 1) {
        return Response.json({
          success: false,
          status: 'running',
          taskId: 'task-1'
        });
      }
      return Response.json({
        success: true,
        status: 'succeeded',
        taskId: 'task-1',
        result: {
          question: '题目',
          answer: '答案'
        }
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  try {
    const result = await mod.requestTikuAdapterAIFallback(
      { baseurl: 'https://adapter.local', key: 'secret' },
      { title: '题目', type: 'completion', options: '' },
      { requestTimeoutMs: 1000, statusTimeoutMs: 1000, pollIntervalMs: 1, retryAttempts: 1, preferAsyncTask: true }
    );

    assert.equal(urls.some((url) => url.includes('/adapter-service/ai-fallback/status?taskId=task-1')), true);
    assert.equal(statusCalls, 2);
    assert.equal(result[0].results[0].answer, '答案');
    assert.equal(result[0].response.status, 'succeeded');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
