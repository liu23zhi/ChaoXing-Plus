import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

test('tiku adapter wrapper forwards per-request cache bypass flag', async () => {
  const mod = await loadHelperModule();
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local/',
    key: 'demo-key'
  });

  assert.ok(wrapper.data.skipCache);
  const resolveSkipCache = Function(wrapper.data.skipCache.handler)();
  assert.equal(resolveSkipCache({ skipCache: true }), true);
  assert.equal(resolveSkipCache({ skipCache: false }), false);
  assert.equal(resolveSkipCache({}), undefined);
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

test('tiku adapter AI fallback error contract includes insufficient balance', async () => {
  const source = await readFile(helperSourcePath, 'utf8');

  assert.match(source, /TikuAdapterAIFallbackErrorCode\s*=\s*[^;]*INSUFFICIENT_BALANCE/);
});

test('AI fallback preserves insufficient balance error details', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => Response.json({
    success: false,
    error: {
      code: 'INSUFFICIENT_BALANCE',
      message: '当前余额不足，AI 兜底已禁用，请充值后再使用'
    }
  });

  try {
    const result = await mod.requestTikuAdapterAIFallback(
      { baseurl: 'https://adapter.local', key: 'secret' },
      { title: '1+1=?', type: 'single', options: '1\n2' },
      { requestTimeoutMs: 1000, retryAttempts: 1, retryDelayMs: 1, preferAsyncTask: false }
    );

    assert.equal(result[0].error, 'INSUFFICIENT_BALANCE: 当前余额不足，AI 兜底已禁用，请充值后再使用');
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('AI fallback uses the async task endpoint by default', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  const urls = [];

  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('/adapter-service/ai-fallback/tasks')) {
      return Response.json({
        success: false,
        status: 'running',
        taskId: 'task-1',
        statusUrl: '/adapter-service/ai-fallback/status?taskId=task-1'
      });
    }
    if (String(url).includes('/adapter-service/ai-fallback/status')) {
      return Response.json({
        success: true,
        status: 'succeeded',
        taskId: 'task-1',
        result: {
          question: '1+1=?',
          answer: '2'
        }
      });
    }
    return Response.json({
      success: false,
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'unexpected endpoint'
      }
    });
  };

  try {
    const result = await mod.requestTikuAdapterAIFallback(
      { baseurl: 'https://adapter.local', key: 'secret' },
      { title: '1+1=?', type: 'single', options: '1\n2' },
      { requestTimeoutMs: 1000, retryAttempts: 1, retryDelayMs: 1 }
    );

    assert.deepEqual(urls, [
      'https://adapter.local/adapter-service/ai-fallback/tasks',
      'https://adapter.local/adapter-service/ai-fallback/status?taskId=task-1'
    ]);
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

test('resolves adapter warnings into a deduplicated list of texts', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.resolveTikuAdapterWarnings, 'function');
  assert.deepEqual(mod.resolveTikuAdapterWarnings(undefined), []);
  assert.deepEqual(mod.resolveTikuAdapterWarnings({}), []);
  assert.deepEqual(mod.resolveTikuAdapterWarnings({ warnings: 'not-an-array' }), []);
  assert.deepEqual(mod.resolveTikuAdapterWarnings({ warnings: ['  ', null, 'A'] }), ['A']);
  assert.deepEqual(mod.resolveTikuAdapterWarnings({ warnings: ['同一提示', '同一提示'] }), ['同一提示']);
});

test('collects adapter warnings across search infos', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.collectTikuAdapterWarnings, 'function');
  assert.deepEqual(mod.collectTikuAdapterWarnings(undefined), []);
  assert.deepEqual(
    mod.collectTikuAdapterWarnings([
      { response: { warnings: ['提示一'] } },
      { response: undefined },
      { response: { warnings: ['提示一', '提示二'] } }
    ]),
    ['提示一', '提示二']
  );
});

// 管理员提示只能出现在调试通道，绝不能污染用户可见的答案或错误文案。
test('adapter warnings never leak into user-facing results or errors', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    Response.json({
      success: true,
      result: { question: '1+1=?', answer: '2' },
      warnings: ['AI 模型「gpt-no-price」尚未配置价格，本次调用按 0 元计费。']
    });

  try {
    const result = await mod.requestTikuAdapterAIFallback(
      { baseurl: 'https://adapter.local', key: 'secret' },
      { title: '1+1=?', type: 'single', options: '1\n2' },
      { requestTimeoutMs: 1000, retryAttempts: 1, retryDelayMs: 1, preferAsyncTask: false }
    );

    const info = result[0];
    // 答案照常可用，且不含任何价格提示文案。
    assert.equal(info.results[0].answer, '2');
    assert.equal(info.error, undefined);
    assert.doesNotMatch(info.results[0].answer, /价格/);
    assert.equal(info.results[0].extra_data.ai, true);

    // 警告只保留在 response 里，由调用方决定是否写进管理员可见的调试日志。
    assert.deepEqual(info.response.warnings, ['AI 模型「gpt-no-price」尚未配置价格，本次调用按 0 元计费。']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('adapter search results do not carry warning text into answers', async () => {
  const mod = await loadHelperModule();
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local/',
    key: 'demo-key'
  });
  const handler = Function(wrapper.handler)();

  const result = handler({
    question: '单选题',
    type: 0,
    answer: { answerIndex: [1], answerKeyText: 'B', answerText: 'B' },
    warnings: ['AI 模型「gpt-no-price」尚未配置价格。']
  });

  assert.deepEqual(result, ['单选题', 'B', { source: 'tikuAdapter' }]);
});

test('cx logs adapter warnings only through the admin debug log path', async () => {
  const source = await readFile(resolve(process.cwd(), 'src', 'projects', 'cx.ts'), 'utf8');

  // 必须存在一个只写调试日志的转发函数。
  assert.match(source, /function logTikuAdapterWarnings/);
  assert.match(source, /logDebug\('warn', 'tikuAdapter 管理提示'/);

  // 提示不得进入用户可见的提示/弹窗/错误通道。
  const forwardingBlock = source.slice(
    source.indexOf('function logTikuAdapterWarnings'),
    source.indexOf('function logTikuAdapterWarnings') + 400
  );
  assert.doesNotMatch(forwardingBlock, /\$message|\$console\.warn|showTopCenterNotice|throw new Error/);

  // 包装函数必须原样透传结果，绝不改写答案或错误。
  const wrapperStart = source.indexOf('async function withTikuAdapterAdminWarnings');
  const wrapperBlock = source.slice(wrapperStart, wrapperStart + 600);
  assert.match(wrapperBlock, /const resolvedInfos = await searchInfos;/);
  assert.match(wrapperBlock, /return resolvedInfos;/);
  assert.doesNotMatch(wrapperBlock, /\$message|showTopCenterNotice|throw new Error|\.error\s*=/);

  // 两条搜题链路都要走这个包装函数（普通搜题 + AI 兜底），加上包装函数自身的引用共 3 处。
  assert.equal(source.match(/withTikuAdapterAdminWarnings\(/g).length, 3);
  assert.match(source, /logTikuAdapterWarnings\(collectTikuAdapterWarnings\(resolvedInfos\), 'search'\)/);

  // appendAIFallbackSearchInfos 必须保持纯净：不引用任何日志转发函数，
  // 否则既有的行为测试（在 vm 中只注入部分声明）会直接抛 ReferenceError。
  const appendStart = source.indexOf('async function appendAIFallbackSearchInfos');
  const appendBlock = source.slice(appendStart, appendStart + 2600);
  assert.doesNotMatch(
    appendBlock,
    /logTikuAdapterWarnings|withTikuAdapterAdminWarnings|collectTikuAdapterWarnings/
  );
});
