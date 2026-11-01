import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

const execFileAsync = promisify(execFile);
const outDir = createTestDirectory('tiku-health-cjs');
const modulePath = resolve(outDir, 'projects', 'tiku-adapter-config.js');

async function loadModule() {
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'package.json'), '{"type":"commonjs"}\n');
  await execFileAsync(process.execPath, [
    resolveTestPath('scripts', 'test-helpers', 'tsc-compat.mjs'),
    resolveTestPath('src', 'projects', 'tiku-adapter-config.ts'),
    '--outDir', outDir, '--module', 'commonjs', '--target', 'es2022',
    '--moduleResolution', 'node', '--skipLibCheck'
  ]);
  const require = createRequire(import.meta.url);
  delete require.cache[modulePath];
  return require(modulePath);
}

const config = { baseurl: 'https://adapter.local', key: 'secret' };
const payload = { qid: '', question: 'question', options: [], type: 0, courseName: '', extra: '' };
const options = { requestTimeoutMs: 1000, statusTimeoutMs: 1000, pollIntervalMs: 1, retryAttempts: 1, retryDelayMs: 0, healthProbeDelayMs: 0 };
const health = { success: true, status: 'succeeded', taskId: 'probe-1', statusUrl: 'https://status.other.local/adapter-service/search/status?taskId=probe-1' };
const healthyStatus = { success: true, status: 'succeeded', taskId: 'probe-1', result: { answer: {} } };
const answer = { question: 'question', answer: { answerText: 'answer' } };

test('health probe checks the returned status URL before creating a normal task', async () => {
  const mod = await loadModule();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/search/health')) return Response.json(health);
    if (String(url) === health.statusUrl) return Response.json(healthyStatus);
    if (String(url).endsWith('/search/tasks')) return Response.json({ success: true, status: 'succeeded', taskId: 'task-1', result: answer });
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    assert.equal(mod.createTikuAdapterSearchHealthUrl(config.baseurl), 'https://adapter.local/adapter-service/search/health');
    assert.deepEqual(await mod.requestTikuAdapterSearchTask(config, payload, options), answer);
    assert.deepEqual(calls.map((call) => call.url), [
      'https://adapter.local/adapter-service/search/health', health.statusUrl,
      'https://adapter.local/adapter-service/search/tasks'
    ]);
    assert.equal(calls[1].init.headers.Authorization, 'Bearer secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed health handshake falls back to sync without creating an async task', async () => {
  const mod = await loadModule();
  const originalFetch = globalThis.fetch;
  for (const brokenHealth of [
    () => Response.json({ message: 'missing route' }, { status: 404 }),
    () => Response.json({ message: 'temporarily unavailable' }, { status: 503 }),
    () => new Response('<html>old server</html>', { status: 200 }),
    () => Response.json({ ...health, statusUrl: 'https://unreachable.local/status' }),
    () => Response.json({ ...health, taskId: 'mismatched-id' })
  ]) {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/search/health')) return brokenHealth();
      if (String(url).includes('unreachable.local')) throw new TypeError('Failed to fetch');
      if (String(url) === health.statusUrl) return Response.json(healthyStatus);
      if (String(url).endsWith('/adapter-service/search')) return Response.json(answer);
      throw new Error(`unexpected URL ${url}`);
    };
    try {
      assert.deepEqual(await mod.requestTikuAdapterSearchTask(config, payload, options), answer);
      assert.equal(calls.filter((url) => url.endsWith('/search/health')).length, 3);
      assert.equal(calls.some((url) => url.endsWith('/search/tasks')), false);
      assert.equal(calls.at(-1), 'https://adapter.local/adapter-service/search');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('health status returning HTML is not mistaken for a usable async endpoint', async () => {
  const mod = await loadModule();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/search/health')) return Response.json(health);
    if (String(url) === health.statusUrl) return new Response('<html>proxy page</html>', { status: 200 });
    if (String(url).endsWith('/adapter-service/search')) return Response.json(answer);
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    assert.deepEqual(await mod.requestTikuAdapterSearchTask(config, payload, options), answer);
    assert.equal(calls.filter((url) => url === health.statusUrl).length, 3);
    assert.equal(calls.at(-1), 'https://adapter.local/adapter-service/search');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('health status without a search result selects the legacy endpoint', async () => {
  const mod = await loadModule();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/search/health')) return Response.json(health);
    if (String(url) === health.statusUrl) return Response.json({ success: true, status: 'succeeded', taskId: 'probe-1' });
    if (String(url).endsWith('/adapter-service/search')) return Response.json(answer);
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    assert.deepEqual(await mod.requestTikuAdapterSearchTask(config, payload, options), answer);
    assert.equal(calls.filter((url) => url === health.statusUrl).length, 3);
    assert.equal(calls.at(-1), 'https://adapter.local/adapter-service/search');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('explicit legacy sync mode retries a transient failure with one stable idempotency key', async () => {
  const mod = await loadModule();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) throw new TypeError('Failed to fetch');
    return Response.json(answer);
  };
  try {
    const wrapper = mod.createTikuAdapterAnswererWrapper({ ...config, asyncSearch: false });
    assert.deepEqual(await wrapper.executeRequest({ data: payload, timeoutMs: 1000 }), answer);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.url === 'https://adapter.local/adapter-service/search'));
    assert.ok(calls[0].init.headers['Idempotency-Key']);
    assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key']);
    assert.equal(calls[0].init.body, calls[1].init.body);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('health authentication failure does not select sync search', async () => {
  const mod = await loadModule();
  const originalFetch = globalThis.fetch;
  for (const status of [401, 403]) {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return Response.json({ message: 'unauthorized' }, { status });
    };
    try {
      await assert.rejects(mod.requestTikuAdapterSearchTask(config, payload, options), (error) => error.status === status);
      assert.deepEqual(calls, ['https://adapter.local/adapter-service/search/health']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('create 404 falls back to sync, but status 404 after creation does not', async () => {
  const mod = await loadModule();
  const originalFetch = globalThis.fetch;
  for (const failingPath of ['create', 'status']) {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/search/health')) return Response.json(health);
      if (String(url) === health.statusUrl) return Response.json(healthyStatus);
      if (String(url).endsWith('/search/tasks')) {
        return failingPath === 'create'
          ? Response.json({ message: 'missing route' }, { status: 404 })
          : Response.json({ success: true, status: 'running', taskId: 'task-1' });
      }
      if (String(url).includes('taskId=task-1')) return Response.json({ message: 'missing route' }, { status: 404 });
      if (String(url).endsWith('/adapter-service/search')) return Response.json(answer);
      throw new Error(`unexpected URL ${url}`);
    };
    try {
      if (failingPath === 'create') {
        assert.deepEqual(await mod.requestTikuAdapterSearchTask(config, payload, options), answer);
        assert.equal(calls.at(-1), 'https://adapter.local/adapter-service/search');
      } else {
        await assert.rejects(mod.requestTikuAdapterSearchTask(config, payload, options), /3 consecutive/);
        assert.equal(calls.filter((url) => url.endsWith('/adapter-service/search')).length, 0);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('AI task creation retries a transient failure with the same idempotency key', async () => {
  const mod = await loadModule();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) throw new TypeError('Failed to fetch');
    return Response.json({ success: true, result: { question: 'question', answer: 'answer' } });
  };
  try {
    const infos = await mod.requestTikuAdapterAIFallback(config, { title: 'question' }, {
      preferAsyncTask: true, requestTimeoutMs: 1000, retryAttempts: 3, retryDelayMs: 0
    });
    assert.equal(infos[0].results[0].answer, 'answer');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://adapter.local/adapter-service/ai-fallback/tasks');
    assert.ok(calls[0].init.headers['Idempotency-Key']);
    assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key']);
    assert.equal(calls[0].init.body, calls[1].init.body);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AI task replay with a terminal id fetches the completed task result', async () => {
  const mod = await loadModule();
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (urls.length === 1) throw new TypeError('Failed to fetch');
    if (String(url).endsWith('/ai-fallback/tasks')) {
      return Response.json({ success: true, status: 'succeeded', taskId: 'replayed', statusUrl: '/adapter-service/ai-fallback/status?taskId=replayed' });
    }
    return Response.json({ success: true, status: 'succeeded', taskId: 'replayed', result: { question: 'question', answer: 'answer' } });
  };
  try {
    const infos = await mod.requestTikuAdapterAIFallback(config, { title: 'question' }, {
      preferAsyncTask: true, requestTimeoutMs: 1000, statusTimeoutMs: 10000,
      retryAttempts: 3, retryDelayMs: 0, pollIntervalMs: 1
    });
    assert.equal(infos[0].results[0].answer, 'answer');
    assert.equal(urls.length, 3);
    assert.equal(urls.at(-1), 'https://adapter.local/adapter-service/ai-fallback/status?taskId=replayed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('local HTTP integration preserves health, creation, polling and sync fallback order', async () => {
  const mod = await loadModule();
  for (const scenario of ['async-success', 'health-failed', 'create-404', 'status-failed']) {
    const calls = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');
      calls.push({ method: request.method, path: url.pathname, taskId: url.searchParams.get('taskId'), authorization: request.headers.authorization });
      const send = (status, body) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === '/adapter-service/search/health') {
        send(scenario === 'health-failed' ? 503 : 200, scenario === 'health-failed'
          ? { message: 'unavailable' }
          : { success: true, status: 'succeeded', taskId: 'probe', statusUrl: '/adapter-service/search/status?taskId=probe' });
      } else if (url.pathname === '/adapter-service/search/status' && url.searchParams.get('taskId') === 'probe') {
        send(200, { success: true, status: 'succeeded', taskId: 'probe', result: { answer: {} } });
      } else if (url.pathname === '/adapter-service/search/tasks') {
        send(scenario === 'create-404' ? 404 : 202, scenario === 'create-404'
          ? { message: 'missing' }
          : { success: false, status: 'running', taskId: 'job' });
      } else if (url.pathname === '/adapter-service/search/status' && url.searchParams.get('taskId') === 'job') {
        send(scenario === 'status-failed' ? 404 : 200, scenario === 'status-failed'
          ? { message: 'missing' }
          : { success: true, status: 'succeeded', taskId: 'job', result: answer });
      } else if (url.pathname === '/adapter-service/search') {
        send(200, answer);
      } else {
        send(500, { message: 'unexpected path' });
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const baseurl = `http://127.0.0.1:${server.address().port}`;
      const search = mod.requestTikuAdapterSearchTask({ baseurl, key: 'local-secret' }, payload, {
        ...options, statusTimeoutMs: 2000, healthProbeTimeoutMs: 500
      });
      if (scenario === 'status-failed') {
        await assert.rejects(search, /3 consecutive/);
      } else {
        assert.deepEqual(await search, answer);
      }
      assert.ok(calls.every((call) => call.authorization === 'Bearer local-secret'));
      const paths = calls.map((call) => call.path);
      if (scenario === 'async-success') {
        assert.deepEqual(paths, [
          '/adapter-service/search/health', '/adapter-service/search/status',
          '/adapter-service/search/tasks', '/adapter-service/search/status'
        ]);
      } else if (scenario === 'health-failed') {
        assert.deepEqual(paths, [
          '/adapter-service/search/health', '/adapter-service/search/health',
          '/adapter-service/search/health', '/adapter-service/search'
        ]);
      } else if (scenario === 'create-404') {
        assert.deepEqual(paths, [
          '/adapter-service/search/health', '/adapter-service/search/status',
          '/adapter-service/search/tasks', '/adapter-service/search'
        ]);
      } else {
        assert.deepEqual(paths, [
          '/adapter-service/search/health', '/adapter-service/search/status',
          '/adapter-service/search/tasks', '/adapter-service/search/status',
          '/adapter-service/search/status', '/adapter-service/search/status'
        ]);
        assert.equal(paths.includes('/adapter-service/search'), false);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
