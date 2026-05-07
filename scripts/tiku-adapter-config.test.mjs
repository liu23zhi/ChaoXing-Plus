import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const helperModulePath = resolve(process.cwd(), '.tmp-tests', 'projects', 'tiku-adapter-config.js');

async function loadHelperModule() {
  try {
    return await import(pathToFileURL(helperModulePath).href);
  } catch {
    return {};
  }
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
});
