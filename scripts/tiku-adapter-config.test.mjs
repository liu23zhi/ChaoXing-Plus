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
const tscCliPath = resolve(process.cwd(), 'scripts', 'test-helpers', 'tsc-compat.mjs');

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

test('creates async search task and status urls', async () => {
  const mod = await loadHelperModule();

  assert.equal(
    mod.createTikuAdapterSearchTaskUrl('https://adapter.local/'),
    'https://adapter.local/adapter-service/search/tasks'
  );
  assert.equal(
    mod.createTikuAdapterSearchStatusUrl('https://adapter.local/', 'task-1'),
    'https://adapter.local/adapter-service/search/status?taskId=task-1'
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

test('creates a post wrapper using async search by default', async () => {
  const mod = await loadHelperModule();

  assert.equal(typeof mod.createTikuAdapterAnswererWrapper, 'function');
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local/',
    key: 'demo-key'
  });

  assert.equal(wrapper.url, 'https://adapter.local/adapter-service/search/tasks');
  assert.equal(typeof wrapper.executeRequest, 'function');
  assert.equal(wrapper.method, 'post');
  assert.equal(wrapper.type, 'fetch');
  assert.equal(wrapper.contentType, 'json');
  assert.deepEqual(wrapper.headers, {
    Authorization: 'Bearer demo-key'
  });
  assert.ok(wrapper.timeoutSeconds >= 180);
  assert.ok(wrapper.retry?.maxAttempts >= 2);
});

test('disabling async search keeps the legacy synchronous endpoint', async () => {
  const mod = await loadHelperModule();
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local/',
    key: 'demo-key',
    asyncSearch: false
  });

  assert.equal(wrapper.url, 'https://adapter.local/adapter-service/search');
  assert.equal(typeof wrapper.executeRequest, 'function');
});

// 服务端已彻底删除 plat（历史取值恒为 -1，没有任何区分度），请求侧不得再提交该字段。
test('tiku adapter request payload no longer carries the removed plat field', async () => {
  const mod = await loadHelperModule();
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local/',
    key: 'demo-key'
  });

  assert.equal(wrapper.data.plat, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(wrapper.data, 'plat'), false);

  // 普通搜题保留兼容字段，并按需增加深度思考参数。
  assert.deepEqual(Object.keys(wrapper.data), [
    'qid',
    'question',
    'options',
    'type',
    'courseName',
    'extra',
    'skipCache',
    'deepThinking'
  ]);
});

test('async search submits once with idempotency, follows another-origin status URL, and returns empty answers', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  const calls = [];
  const result = {
    question: '题目',
    answer: { answerText: '' }
  };

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/adapter-service/search/health')) {
      return Response.json({ success: true, status: 'succeeded', taskId: 'probe-1', statusUrl: 'https://tasks.other.test/adapter-service/search/status?taskId=probe-1' });
    }
    if (String(url).includes('taskId=probe-1')) {
      return Response.json({ success: true, status: 'succeeded', taskId: 'probe-1', result: { answer: {} } });
    }
    if (String(url).endsWith('/adapter-service/search/tasks')) {
      return Response.json({
        success: false,
        status: 'running',
        taskId: 'task-1',
        statusUrl: 'https://tasks.other.test/adapter-service/search/status?taskId=task-1'
      }, { status: 202 });
    }
    return Response.json({ success: true, status: 'succeeded', taskId: 'task-1', result });
  };

  try {
    const response = await mod.requestTikuAdapterSearchTask(
      { baseurl: 'https://adapter.local', key: 'secret' },
      { qid: '', question: '题目', options: [], type: 0, courseName: '', extra: '', skipCache: undefined },
      { requestTimeoutMs: 1000, statusTimeoutMs: 1000, pollIntervalMs: 0, retryAttempts: 1, idempotencyKey: 'stable-1' }
    );

    assert.deepEqual(response, result);
    assert.equal(calls.length, 4);
    assert.equal(calls[0].url, 'https://adapter.local/adapter-service/search/health');
    assert.equal(calls[1].url, 'https://tasks.other.test/adapter-service/search/status?taskId=probe-1');
    assert.equal(calls[2].url, 'https://adapter.local/adapter-service/search/tasks');
    assert.equal(calls[2].init.headers['Idempotency-Key'], 'stable-1');
    assert.deepEqual(JSON.parse(calls[2].init.body), {
      qid: '', question: '题目', options: [], type: 0, courseName: '', extra: ''
    });
    assert.equal(calls[3].url, 'https://tasks.other.test/adapter-service/search/status?taskId=task-1');
    assert.equal(calls[3].init.headers.Authorization, 'Bearer secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('async ordinary search exposes only the standard insufficient-balance error', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  let statusCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/adapter-service/search/health')) {
      return Response.json({ success: true, status: 'succeeded', taskId: 'probe-balance', statusUrl: 'https://balance-search.adapter.local/adapter-service/search/status?taskId=probe-balance' });
    }
    if (String(url).includes('taskId=probe-balance')) {
      return Response.json({ success: true, status: 'succeeded', taskId: 'probe-balance', result: { answer: {} } });
    }
    if (String(url).endsWith('/adapter-service/search/tasks')) {
      return Response.json({ success: false, status: 'running', taskId: 'balance-search' }, { status: 202 });
    }
    statusCalls++;
    return Response.json({
      success: false,
      status: 'failed',
      taskId: 'balance-search',
      error: { code: 'INSUFFICIENT_BALANCE', message: 'internal raw provider detail' }
    });
  };

  try {
    await assert.rejects(
      mod.requestTikuAdapterSearchTask(
        { baseurl: 'https://balance-search.adapter.local', key: 'balance-search-secret' },
        { question: '题目', options: [], type: 0 },
        { requestTimeoutMs: 1000, statusTimeoutMs: 1000, pollIntervalMs: 0, retryAttempts: 1 }
      ),
      (error) => {
        assert.equal(error.code, 'INSUFFICIENT_BALANCE');
        assert.match(error.message, /当前账号余额不足，请充值后重试。/u);
        assert.doesNotMatch(error.message, /internal raw provider detail/u);
        return true;
      }
    );
    assert.equal(statusCalls, 3);
  } finally {
    mod.resetTikuAdapterBalanceGuard({ baseurl: 'https://balance-search.adapter.local', key: 'balance-search-secret' });
    globalThis.fetch = originalFetch;
  }
});

test('tiku adapter config source no longer mentions plat at all', async () => {
  const source = await readFile(helperSourcePath, 'utf8');

  assert.doesNotMatch(source, /\bplat\b/);
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

/** 线上一次请求携带 55 条 options，其中绝大多数是 UEditor / jQuery 源码，这里复刻其中的典型行。 */
const NOISY_OPTIONS_SAMPLE = [
  'A. 正确',
  'var wordNum = "";',
  'B. 错误',
  'if (wordNum == "") {',
  'window.UEDITOR_CONFIG.wordCount = false;',
  "editor1.addListener('contentChange', function() {",
  '$( "#answer406157359" ).parent().find(".edui-editor.edui-default").removeClass("borblue");',
  '}',
  '// 编辑器脚本注释',
  'wordNum = "";',
  'editorInstance = null;',
  'C. 不确定'
].join('\n');

function createOptionsResolver(mod) {
  const wrapper = mod.createTikuAdapterAnswererWrapper({
    baseurl: 'https://adapter.local/',
    key: 'demo-key'
  });

  // handler 必须是单行字符串，因为它会被 Function(...) 直接求值。
  assert.equal(wrapper.data.options.handler.split('\n').length, 1);
  const resolveOptions = Function(wrapper.data.options.handler)();
  assert.equal(typeof resolveOptions, 'function');
  return resolveOptions;
}

test('tiku adapter options drop editor script noise while keeping real options in order', async () => {
  const mod = await loadHelperModule();
  const resolveOptions = createOptionsResolver(mod);

  assert.deepEqual(resolveOptions({ options: NOISY_OPTIONS_SAMPLE }), [
    'A. 正确',
    'B. 错误',
    'C. 不确定'
  ]);
});

test('tiku adapter options deduplicate repeated entries preserving first-seen order', async () => {
  const mod = await loadHelperModule();
  const resolveOptions = createOptionsResolver(mod);

  assert.deepEqual(
    resolveOptions({ options: 'A. 正确\nB. 错误\nA. 正确\nC. 不确定\nB. 错误' }),
    ['A. 正确', 'B. 错误', 'C. 不确定']
  );
});

test('tiku adapter options fall back to the raw list when every entry looks like noise', async () => {
  const mod = await loadHelperModule();
  const resolveOptions = createOptionsResolver(mod);

  const rawOptions = [
    'var wordNum = "";',
    '}',
    'function setupEditor() {',
    '// 注释行'
  ].join('\n');

  // 过滤后一条不剩时必须回退，绝不能把整题选项全丢掉。
  assert.deepEqual(resolveOptions({ options: rawOptions }), [
    'var wordNum = "";',
    '}',
    'function setupEditor() {',
    '// 注释行'
  ]);
});

test('tiku adapter options do not false-positive on natural language or formulas', async () => {
  const mod = await loadHelperModule();
  const resolveOptions = createOptionsResolver(mod);

  assert.deepEqual(
    resolveOptions({ options: 'A. (1, 2)\nB. 3x + 2\nC. 变量 var 的值\nD. f(x) 的定义域\nE. 正确\nF. 分号; 位于句子中间' }),
    ['A. (1, 2)', 'B. 3x + 2', 'C. 变量 var 的值', 'D. f(x) 的定义域', 'E. 正确', 'F. 分号; 位于句子中间']
  );

  // 无选项时保持既有行为：返回空数组而不是抛错。
  assert.deepEqual(resolveOptions({}), []);
  assert.deepEqual(resolveOptions({ options: '' }), []);
  assert.deepEqual(resolveOptions({ options: '   \n  \n' }), []);
});

test('tiku adapter config exposes long AI fallback timeouts and status helpers', async () => {
  const mod = await loadHelperModule();
  const source = await readFile(helperSourcePath, 'utf8');

  assert.ok(mod.TIKU_ADAPTER_AI_FALLBACK_REQUEST_TIMEOUT_MS >= 180000);
  assert.equal(mod.TIKU_ADAPTER_AI_FALLBACK_STATUS_TIMEOUT_MS, 600000);
  assert.ok(mod.TIKU_ADAPTER_AI_FALLBACK_WORKER_TIMEOUT_SECONDS >= 1220);
  assert.match(source, /timeoutMs: Math\.min\(taskCreateTimeoutMs, 10000, remainingMs\)/);
  assert.match(source, /timeoutMs: Math\.min\(options\.requestTimeoutMs, 10000, remainingMs\)/);
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

    assert.equal(result[0].error, 'INSUFFICIENT_BALANCE: 当前账号余额不足，请充值后重试。');
  } finally {
    mod.resetTikuAdapterBalanceGuard({ baseurl: 'https://adapter.local', key: 'secret' });
    globalThis.fetch = originalFetch;
  }
});

test('AI fallback task endpoint 404 does not silently downgrade to the synchronous endpoint', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response('not found', { status: 404 });
  };

  try {
    const result = await mod.requestTikuAdapterAIFallback(
      { baseurl: 'https://adapter.local', key: 'secret' },
      { title: '1+1=?', type: 'single', options: '1\n2' },
      { requestTimeoutMs: 1000, retryAttempts: 2, retryDelayMs: 1, preferAsyncTask: true }
    );

    assert.deepEqual(calls.map(({ url }) => url), [
      'https://adapter.local/adapter-service/ai-fallback/tasks'
    ]);
    assert.deepEqual(result[0].results, []);
    assert.match(result[0].error, /UPSTREAM_ERROR/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI fallback defaults to async and follows an absolute status URL from another origin', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  const urls = [];
  const statusAuthorizations = [];

  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith('/adapter-service/ai-fallback/tasks')) {
      return Response.json({
        success: false,
        status: 'running',
        taskId: 'task-1',
        statusUrl: 'https://jobs.other.test/adapter-service/ai-fallback/status?taskId=task-1'
      });
    }
    if (String(url).includes('/adapter-service/ai-fallback/status')) {
      statusAuthorizations.push(init.headers.Authorization);
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
      'https://jobs.other.test/adapter-service/ai-fallback/status?taskId=task-1'
    ]);
    assert.deepEqual(statusAuthorizations, ['Bearer secret']);
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

test('AI fallback treats terminal NO_ANSWER as complete without repeated status queries', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  const urls = [];

  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).endsWith('/adapter-service/ai-fallback/tasks')) {
      return Response.json({ success: false, status: 'running', taskId: 'task-no-answer' });
    }
    return Response.json({
      success: false,
      status: 'failed',
      taskId: 'task-no-answer',
      error: { code: 'NO_ANSWER', message: '未找到可用答案' }
    });
  };

  try {
    const result = await mod.requestTikuAdapterAIFallback(
      { baseurl: 'https://adapter.local', key: 'secret' },
      { title: '题目', type: 'completion', options: '' },
      { requestTimeoutMs: 1000, statusTimeoutMs: 1000, pollIntervalMs: 1, retryAttempts: 1, preferAsyncTask: true }
    );

    assert.equal(urls.length, 2);
    assert.equal(urls[1], 'https://adapter.local/adapter-service/ai-fallback/status?taskId=task-no-answer');
    assert.deepEqual(result[0].results, []);
    assert.equal(result[0].response.error.code, 'NO_ANSWER');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI fallback async polling preserves insufficient balance code with a safe message', async () => {
  const mod = await loadHelperModule();
  const originalFetch = globalThis.fetch;
  let statusCalls = 0;

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/adapter-service/ai-fallback/tasks')) {
      return Response.json({ success: false, status: 'running', taskId: 'balance-fallback' });
    }
    statusCalls++;
    return Response.json({
      success: false,
      status: 'failed',
      taskId: 'balance-fallback',
      error: { code: 'INSUFFICIENT_BALANCE', message: 'internal raw provider detail' }
    });
  };

  try {
    const result = await mod.requestTikuAdapterAIFallback(
      { baseurl: 'https://balance-fallback.adapter.local', key: 'balance-fallback-secret' },
      { title: '题目', type: 'completion', options: '' },
      { requestTimeoutMs: 1000, statusTimeoutMs: 10000, pollIntervalMs: 1, retryAttempts: 1, preferAsyncTask: true }
    );

    assert.equal(result[0].response.error.code, 'INSUFFICIENT_BALANCE', JSON.stringify(result[0].response));
    assert.equal(result[0].response.error.message, '当前账号余额不足，请充值后重试。');
    assert.equal(result[0].error, 'INSUFFICIENT_BALANCE: 当前账号余额不足，请充值后重试。');
    assert.equal(statusCalls, 3);
  } finally {
    mod.resetTikuAdapterBalanceGuard({ baseurl: 'https://balance-fallback.adapter.local', key: 'balance-fallback-secret' });
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
