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
    'questionCacheMode', 'normalizeCacheText', 'normalizeQuestionCacheIdentity',
    'questionCacheIdentityKey', 'answerCacheKey',
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

function completedResult(answer, question = '同一道题') {
  return [{
    question,
    searchInfos: [{ name: '题库', results: [[question, answer, {}]] }]
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

test('identity cache requires the same type and ordered options', async () => {
  const cache = await loadCacheHarness();
  const identity = { type: 'single', options: ['A. 甲', 'B. 乙'] };
  cache.addQuestionCacheFromWorkResult(completedResult('甲'), 'normal', identity);

  let calls = 0;
  const provider = async () => {
    calls++;
    return [{ name: '新结果', results: [{ question: '同一道题', answer: '提供方答案' }] }];
  };

  const same = await cache.searchAnswerInCaches('同一道题', provider, 'normal', {
    type: 'single', options: ['A. 甲', 'B. 乙']
  });
  assert.equal(same[0].results[0].answer, '甲');

  for (const differentIdentity of [
    { type: 'multiple', options: ['A. 甲', 'B. 乙'] },
    { type: 'single', options: ['A. 甲', 'C. 丙'] },
    { type: 'single', options: ['B. 乙', 'A. 甲'] },
    { type: 'single', options: ['a. 甲', 'B. 乙'] }
  ]) {
    const result = await cache.searchAnswerInCaches('同一道题', provider, 'normal', differentIdentity);
    assert.equal(result[0].results[0].answer, '提供方答案');
  }

  assert.equal(calls, 4);
});

test('identity cache normalizes stem, type and option text while preserving option order', async () => {
  const cache = await loadCacheHarness();
  cache.addQuestionCacheFromWorkResult(completedResult('规范化答案', 'Ａ　同一道题'), 'normal', {
    type: 'single', options: ['A. 选项一', 'B. 选项二']
  });
  let calls = 0;
  const result = await cache.searchAnswerInCaches('A 同一道题', async () => {
    calls++;
    return [];
  }, 'normal', {
    type: ' SINGLE ', options: ['Ａ． 选项一', 'B.   选项二']
  });

  assert.equal(result[0].results[0].answer, '规范化答案');
  assert.equal(calls, 0);
  assert.deepEqual(cache.state.apps.localQuestionCaches[0].identity, {
    title: 'A 同一道题', type: 'single', options: ['A. 选项一', 'B. 选项二']
  });
});

test('identity lookup does not fall back to a legacy cache without identity', async () => {
  const cache = await loadCacheHarness([{ title: '同一道题', answer: '旧缓存答案', from: '旧题库' }]);
  let calls = 0;
  const result = await cache.searchAnswerInCaches('同一道题', async () => {
    calls++;
    return [{ name: '当前结果', results: [{ question: '同一道题', answer: '当前答案' }] }];
  }, 'normal', { type: 'single', options: ['A. 甲', 'B. 乙'] });

  assert.equal(result[0].results[0].answer, '当前答案');
  assert.equal(calls, 1);
});

test('identity records survive persistence without merging different option identities', async () => {
  const firstPage = await loadCacheHarness();
  firstPage.addQuestionCacheFromWorkResult(completedResult('相同答案'), 'normal', {
    type: 'single', options: ['A. 甲', 'B. 乙']
  });
  firstPage.addQuestionCacheFromWorkResult(completedResult('相同答案'), 'normal', {
    type: 'single', options: ['A. 甲', 'C. 丙']
  });
  const persisted = firstPage.saved();
  assert.equal(persisted.length, 2);

  const nextPage = await loadCacheHarness();
  assert.equal(nextPage.applyQuestionCaches(persisted), true);
  let calls = 0;
  const result = await nextPage.searchAnswerInCaches('同一道题', async () => {
    calls++;
    return [];
  }, 'normal', { type: 'single', options: ['A. 甲', 'C. 丙'] });
  assert.equal(result[0].results[0].answer, '相同答案');
  assert.equal(calls, 0);
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

test('batch writes persist each question search snapshot rather than an unset work type', async () => {
  const cache = await loadCacheHarness();
  const results = ['甲', '乙'].map((answer, index) => ({
    ...completedResult(answer)[0],
    type: undefined,
    searchIdentity: { type: 'single', options: ['含\n换行的选项', index ? '丙' : '丁'] }
  }));
  cache.addQuestionCacheFromWorkResult(results);
  const nextPage = await loadCacheHarness(cache.saved());
  let calls = 0;
  for (const [index, result] of results.entries()) {
    const infos = await nextPage.searchAnswerInCaches(result.question, async () => { calls++; return []; },
      'normal', result.searchIdentity);
    assert.equal(infos[0].results[0].answer, index ? '乙' : '甲');
  }
  assert.equal(calls, 0);
  assert.deepEqual(cache.saved().map((entry) => entry.identity.options), [
    ['含 换行的选项', '丙'], ['含 换行的选项', '丁']
  ]);
});

test('cache normalization preserves mathematical superscripts and letter case', async () => {
  const cache = await loadCacheHarness();
  cache.addQuestionCacheFromWorkResult(completedResult('公式答案', 'x²'), 'normal', { type: 'single', options: ['X', 'x'] });
  let calls = 0;
  const provider = async () => { calls++; return []; };
  await cache.searchAnswerInCaches('x2', provider, 'normal', { type: 'single', options: ['X', 'x'] });
  await cache.searchAnswerInCaches('x²', provider, 'normal', { type: 'single', options: ['x', 'x'] });
  assert.equal(calls, 2);
});

test('image evidence keeps cache identities separate across alt text, image order and persistence', async () => {
  const cache = await loadCacheHarness();
  const identity = {
    type: 'single', options: ['A', 'B'],
    questionEvidence: { stemImages: [{ url: 'https://img.test/formula.png', alt: 'x²', index: 0 }], optionImages: [] }
  };
  cache.addQuestionCacheFromWorkResult(completedResult('带图答案'), 'normal', identity);
  let calls = 0;
  const provider = async () => { calls++; return []; };
  assert.equal((await cache.searchAnswerInCaches('同一道题', provider, 'normal', identity))[0].results[0].answer, '带图答案');
  for (const changed of [
    { type: 'single', options: ['A', 'B'] },
    { ...identity, questionEvidence: { stemImages: [{ url: 'https://img.test/formula.png', alt: 'x2', index: 0 }], optionImages: [] } },
    { ...identity, questionEvidence: { stemImages: [{ url: 'https://img.test/other.png', alt: 'x²', index: 0 }], optionImages: [] } },
    { ...identity, questionEvidence: { stemImages: [{ url: 'https://img.test/formula.png', alt: 'x²', index: 1 }], optionImages: [] } }
  ]) await cache.searchAnswerInCaches('同一道题', provider, 'normal', changed);
  assert.equal(calls, 4);

  const hydrated = await loadCacheHarness(cache.saved());
  assert.equal((await hydrated.searchAnswerInCaches('同一道题', provider, 'normal', identity))[0].results[0].answer, '带图答案');
  assert.equal(calls, 4);
});
