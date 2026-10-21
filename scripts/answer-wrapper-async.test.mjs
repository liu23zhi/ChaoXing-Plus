import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';

async function loadRuntimeHandler() {
  const path = resolve(process.cwd(), 'src/core/answer-wrapper/answer.wrapper.handler.js');
  const source = (await readFile(path, 'utf8'))
    .replace(/^import \{ request \} from '\.\.\/utils\/request';\r?\n/m, '')
    .replace(/^import \{ sleep \} from '\.\.\/\.\.\/runtime\/dom\.js';\r?\n/m, '')
    .replace(/^export /gm, '');
  const context = {
    AnswerWrapperHandlerConfig: { timeout_seconds: 60 },
    console,
    request: async () => ({ question: '题目', answer: 'fetch-result' }),
    sleep: async () => new Promise(() => {}),
    URL
  };
  vm.runInNewContext(`${source}\nglobalThis.handler = defaultAnswerWrapperHandler;`, context);
  return context.handler;
}

test('runtime answer wrapper invokes executeRequest for async task polling', async () => {
  const defaultAnswerWrapperHandler = await loadRuntimeHandler();
  let executeOptions;

  const infos = await defaultAnswerWrapperHandler([{
      name: 'adapter',
      homepage: 'https://adapter.local',
      url: 'https://adapter.local/adapter-service/search/tasks',
      method: 'post',
      type: 'fetch',
      contentType: 'json',
      headers: { Authorization: 'Bearer secret' },
      data: { question: '题目' },
      executeRequest: async (options) => {
        executeOptions = options;
        return { question: '题目', answer: 'async-result' };
      },
      handler: 'return (response) => [response.question, response.answer]'
    }], {});

  assert.equal(executeOptions.url, 'https://adapter.local/adapter-service/search/tasks');
  assert.equal(executeOptions.method, 'post');
  assert.equal(executeOptions.timeoutMs, 60000);
  assert.equal(infos[0].results[0].answer, 'async-result');
});

test('runtime answer wrapper keeps the safe insufficient-balance text recognizable', async () => {
  const defaultAnswerWrapperHandler = await loadRuntimeHandler();
  const infos = await defaultAnswerWrapperHandler([{
    name: 'adapter',
    homepage: 'https://adapter.local',
    url: 'https://adapter.local/adapter-service/search/tasks',
    method: 'post',
    type: 'fetch',
    contentType: 'json',
    headers: { Authorization: 'Bearer secret' },
    data: { question: '题目' },
    executeRequest: async () => {
      const error = new Error('当前账号余额不足，请充值后重试。');
      error.code = 'INSUFFICIENT_BALANCE';
      throw error;
    },
    handler: 'return (response) => [response.question, response.answer]'
  }], {});

  assert.match(infos[0].error, /INSUFFICIENT_BALANCE|当前(?:账号)?余额不足/u);
  assert.doesNotMatch(infos[0].error, /provider detail|internal raw/iu);
});
