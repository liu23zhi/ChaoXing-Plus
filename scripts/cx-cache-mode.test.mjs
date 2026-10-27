import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from '@typescript/typescript6';

const commonSourcePath = resolve('src/projects/common.ts');

async function loadCacheHarness(initial = [], { windowsNoDiskWrite = false } = {}) {
  const source = await readFile(commonSourcePath, 'utf8');
  const parsed = ts.createSourceFile('common.ts', source, ts.ScriptTarget.Latest, true);
  const functionNames = new Set([
    'applyQuestionCaches', 'saveQuestionCaches', 'isLocalQuestionCacheEnabled',
    'questionCacheMode', 'answerCacheKey',
    'addQuestionCaches', 'questionCachesToSearchInfos', 'normalizeWorkResultsPayload',
    'resultToQuestionCaches'
  ]);
  const methodNames = new Set(['searchAnswerInCaches', 'addQuestionCacheFromWorkResult']);
  const functions = [];
  const methods = [];
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && functionNames.has(node.name?.text)) {
      functions.push(node.getText(parsed));
    }
    if (ts.isMethodDeclaration(node) && methodNames.has(node.name?.getText(parsed))) {
      methods.push(node.getText(parsed));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.equal(functions.length, functionNames.size);
  assert.equal(methods.length, methodNames.size);

  const state = { apps: { localQuestionCaches: structuredClone(initial) } };
  const answerCache = new Map();
  let saved;
  const runtimeStore = { set: (_key, value) => { saved = structuredClone(value); } };
  const output = ts.transpileModule(
    `${functions.join('\n')}\nconst methods = { ${methods.join(',\n')} };\nreturn { applyQuestionCaches, ...methods };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText;
  const methodsUnderTest = Function(
    'state', 'answerCache', 'runtimeStore', 'QUESTION_CACHE_KEY', 'getStudySettingValue',
    'renderAppsPanel', 'renderWorkResultsPanel', 'shouldCacheSearchInfos', 'isWindowsNoDiskWrite', output
  )(
    state, answerCache, runtimeStore, 'common.apps.question-caches', () => true,
    () => {}, () => {}, () => true, () => windowsNoDiskWrite
  );
  return { state, answerCache, saved: () => saved, ...methodsUnderTest };
}

function completedResult(answer) {
  return [{
    question: '同一道题',
    searchInfos: [{ name: '题库', results: [['同一道题', answer, {}]] }]
  }];
}

test('legacy normal cache stays separate from deep cache across persistence and hydration', async () => {
  const legacy = [{ title: '同一道题', answer: '旧普通答案', from: '题库' }];
  const firstPage = await loadCacheHarness(legacy);
  let calls = 0;
  const deepProvider = async () => {
    calls++;
    return [{ name: '深度结果', results: [{ question: '同一道题', answer: '深度答案' }] }];
  };
  const normalProvider = async () => {
    calls++;
    return [{ name: '普通结果', results: [{ question: '同一道题', answer: '新普通答案' }] }];
  };

  assert.equal((await firstPage.searchAnswerInCaches('同一道题', normalProvider, 'normal'))[0].results[0].answer, '旧普通答案');
  assert.equal((await firstPage.searchAnswerInCaches('同一道题', deepProvider, 'deep'))[0].results[0].answer, '深度答案');
  assert.equal((await firstPage.searchAnswerInCaches('同一道题', deepProvider, 'deep'))[0].results[0].answer, '深度答案');
  assert.equal(calls, 1);

  firstPage.addQuestionCacheFromWorkResult(completedResult('深度答案'), 'deep');
  const persisted = firstPage.saved();
  assert.equal(persisted.length, 2);
  assert.equal(persisted.find((entry) => entry.answer === '旧普通答案').mode, undefined);
  assert.equal(persisted.find((entry) => entry.answer === '深度答案').mode, 'deep');

  const nextPage = await loadCacheHarness();
  assert.equal(nextPage.applyQuestionCaches(persisted), true);
  assert.equal((await nextPage.searchAnswerInCaches('同一道题', deepProvider, 'deep'))[0].results[0].answer, '深度答案');
  assert.equal((await nextPage.searchAnswerInCaches('同一道题', normalProvider, 'normal'))[0].results[0].answer, '旧普通答案');
  assert.equal(calls, 1);
});

test('same answer from normal and deep searches retains two distinct cache entries', async () => {
  const cache = await loadCacheHarness();
  cache.addQuestionCacheFromWorkResult(completedResult('相同答案'), 'normal');
  cache.addQuestionCacheFromWorkResult(completedResult('相同答案'), 'deep');
  assert.deepEqual(cache.saved().map(({ mode }) => mode), ['deep', undefined]);
});

test('Windows no-disk-write disables question cache reads, writes and hydration', async () => {
  const legacy = [{ title: '同一道题', answer: '旧普通答案', from: '题库' }];
  const cache = await loadCacheHarness(legacy, { windowsNoDiskWrite: true });
  cache.addQuestionCacheFromWorkResult(completedResult('新答案'), 'normal');
  // 写盘被禁用：addQuestionCaches 不应调用 runtimeStore.set。
  assert.equal(cache.saved(), undefined);
  // 共享配置水合进来的旧缓存也要忽略并清空。
  assert.equal(cache.applyQuestionCaches(legacy), true);
  assert.deepEqual(cache.state.apps.localQuestionCaches, []);
});
