import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { createTestDirectory, resolveTestPath } from './test-helpers/temp-directory.mjs';

const execFileAsync = promisify(execFile);
const resolverSourcePath = resolveTestPath('src', 'core', 'worker', 'question.resolver.ts');
const outDir = createTestDirectory('question-resolver-cjs');
const tscCliPath = resolveTestPath('scripts', 'test-helpers', 'tsc-compat.mjs');

// tsc infers rootDir from the whole import graph, so the emitted directory depth
// changes whenever the resolver gains an import from another top-level folder.
// Locate the artifact instead of hard-coding a depth.
async function findCompiledFile(root, fileName) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findCompiledFile(full, fileName);
      if (nested) return nested;
    } else if (entry.name === fileName) {
      return full;
    }
  }
  return undefined;
}

async function compileResolverHelper() {
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'package.json'), '{"type":"commonjs"}\n');
  await execFileAsync(process.execPath, [
    tscCliPath,
    resolverSourcePath,
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

async function loadResolverModule() {
  await compileResolverHelper();
  const compiledModulePath = await findCompiledFile(outDir, 'question.resolver.js');
  assert.ok(compiledModulePath, `编译产物 question.resolver.js 未生成于 ${outDir}`);
  const require = createRequire(import.meta.url);
  delete require.cache[compiledModulePath];
  return require(compiledModulePath);
}

/** Capture the runtime log lines the resolver emits while a callback runs. */
async function captureWarnings(run) {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return lines;
}

function createOption(text) {
  return {
    innerText: text,
    textContent: text
  };
}

function createLabeledOption(label, text) {
  const option = createOption(text);
  const labelNode = createOption(label);
  option.closest = (selector) => selector.includes('.answerBg, .clearfix')
    ? { querySelector: () => labelNode }
    : undefined;
  return option;
}

test('multiple choice similar matching does not select more options than returned answers', async () => {
  const mod = await loadResolverModule();
  const selected = [];
  const options = [
    createOption('ABCDE'),
    createOption('WXYZ'),
    createOption('ABCDEF')
  ];
  const ctx = {
    answerSeparators: ['#'],
    answerMatchMode: 'similar',
    elements: { options },
    root: {},
    searchInfos: [],
    type: 'multiple'
  };

  const resolver = mod.createDefaultQuestionResolver(ctx);
  const result = await resolver.multiple(
    [
      {
        name: 'fixture',
        results: [{ question: '题目', answer: 'ABCDE#WXYZ', extra_data: {} }]
      }
    ],
    options,
    (_type, _answer, option) => {
      selected.push(option.innerText);
    }
  );

  assert.equal(result.finish, true);
  assert.deepEqual(selected, ['ABCDE', 'WXYZ']);
});

test('multiple choice waits before applying the next option while paused', async () => {
  const mod = await loadResolverModule();
  const options = [createOption('ABCDE'), createOption('WXYZ')];
  const selected = [];
  let paused = false;
  let releasePause;
  const pauseReleased = new Promise((resolve) => { releasePause = resolve; });
  const ctx = {
    answerSeparators: ['#'],
    answerMatchMode: 'similar',
    elements: { options },
    root: {},
    searchInfos: [],
    type: 'multiple',
    waitForContinue: async () => {
      if (paused) await pauseReleased;
    }
  };

  const work = mod.createDefaultQuestionResolver(ctx).multiple(
    [{ name: 'fixture', results: [{ question: '题目', answer: 'ABCDE#WXYZ', extra_data: {} }] }],
    options,
    (_type, _answer, option) => {
      selected.push(option.innerText);
      paused = true;
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(selected, ['ABCDE']);

  paused = false;
  releasePause();
  const result = await work;
  assert.equal(result.finish, true);
  assert.deepEqual(selected, ['ABCDE', 'WXYZ']);
});

test('multiple choice ranking prefers the higher similarity sum when answer counts tie', async () => {
  const mod = await loadResolverModule();

  const higher = { similarCount: 1, similarSum: 0.95 };
  const lower = { similarCount: 1, similarSum: 0.65 };

  assert.ok(mod.compareSimilarResults(higher, lower) < 0);
  assert.ok(mod.compareSimilarResults(lower, higher) > 0);
});

test('single choice maps a plain answer to the visible option label instead of array position', async () => {
  const mod = await loadResolverModule();
  const options = [createOption('C. third'), createOption('A. first'), createOption('B. second')];

  assert.equal(mod.resolveOptionByDisplayLabel(options, 'A')?.innerText, 'A. first');
  assert.equal(mod.resolveOptionByDisplayLabel(options, '答案：C')?.innerText, 'C. third');

  const selected = [];
  const result = await mod.createDefaultQuestionResolver({
    answerSeparators: ['#'],
    answerMatchMode: 'similar',
    elements: { options },
    root: {},
    searchInfos: [],
    type: 'single'
  }).single(
    [{ name: 'fixture', results: [{ question: '题目', answer: 'A', extra_data: {} }] }],
    options,
    (_type, _answer, option) => selected.push(option.innerText)
  );

  assert.equal(result.finish, true);
  assert.deepEqual(selected, ['A. first']);
});

test('work and exam option mapping reads the visible label from its answerBg sibling', async () => {
  const mod = await loadResolverModule();
  const makeAnswerBgOption = (label, text) => {
    const option = createOption(text);
    const labelNode = createOption(label);
    option.closest = (selector) => selector.includes('.answerBg')
      ? { querySelector: (query) => query.includes('.num_option') ? labelNode : undefined }
      : undefined;
    return option;
  };
  const options = [makeAnswerBgOption('C', 'third'), makeAnswerBgOption('A', 'first'), makeAnswerBgOption('B', 'second')];
  const selected = [];

  const result = await mod.createDefaultQuestionResolver({
    answerSeparators: ['#'],
    answerMatchMode: 'exact',
    elements: { options },
    root: {},
    searchInfos: [],
    type: 'single'
  }).single(
    [{ name: 'fixture', results: [{ question: '题目', answer: 'A', extra_data: {} }] }],
    options,
    (_type, _answer, option) => selected.push(option.innerText)
  );

  assert.equal(result.finish, true);
  assert.deepEqual(selected, ['first']);
});

test('single choice does not apply an ambiguous similar match without a confidence margin', async () => {
  const mod = await loadResolverModule();
  const options = [createOption('alpha'), createOption('alph')];
  const ctx = {
    answerSeparators: ['#'],
    answerMatchMode: 'similar',
    elements: { options },
    root: {},
    searchInfos: [],
    type: 'single'
  };
  const selected = [];

  const result = await mod.createDefaultQuestionResolver(ctx).single(
    [{ name: 'fixture', results: [{ question: '题目', answer: 'alphio', extra_data: {} }] }],
    options,
    (_type, _answer, option) => selected.push(option.innerText)
  );

  assert.equal(result.finish, false);
  assert.deepEqual(selected, []);
});

for (const fixture of [
  { name: 'formula signs', type: 'single', answer: 'x+y', options: ['x-y', 'z'], selected: [] },
  { name: 'character order and repetition', type: 'single', answer: 'aba', options: ['aab', 'aba'], selected: ['aba'] },
  { name: 'short substrings', type: 'multiple', answer: 'CAT', options: ['C', 'CATfish'], selected: [] },
  { name: 'ambiguous multiple choices', type: 'multiple', answer: 'alphabeta00', options: ['alphabeta0x', 'alphabeta0y'], selected: [] },
  { name: 'unique exact multiple choices beside similar options', type: 'multiple', answer: 'abcdefghijklmnop#somethingelse', options: ['abcdefghijklmnop', 'abcdefghijklmnoq', 'somethingelse'], selected: ['abcdefghijklmnop', 'somethingelse'] },
  { name: 'missing judgement polarity option', type: 'judgement', answer: '正确', options: ['unknown'], selected: [] }
]) {
  test(`resolver preserves ${fixture.name}`, async () => {
    const mod = await loadResolverModule();
    const options = fixture.options.map(createOption);
    const selected = [];
    const result = await mod.createDefaultQuestionResolver({ answerMatchMode: 'similar', answerSeparators: ['#'] })[fixture.type](
      [{ results: [{ answer: fixture.answer }] }], options, (_type, _answer, option) => selected.push(option.innerText));
    assert.deepEqual(selected, fixture.selected);
    assert.equal(result.finish, fixture.selected.length > 0);
  });
}

test('letter mapping does not interpret English content as a label or bypass missing explicit labels', async () => {
  const mod = await loadResolverModule();
  assert.equal(mod.resolveOptionByDisplayLabel([createOption('B. Beta'), createOption('C. Gamma')], 'A'), undefined);
});

test('label-less options are never mapped by array position, and the refusal is logged', async () => {
  const mod = await loadResolverModule();
  // Option text without an A–Z label prefix used to fall through to
  // `options[letter - 65]`, silently picking whatever sat in that slot.
  const options = [createOption('Beta'), createOption('A variable')];
  let resolved;
  const warnings = await captureWarnings(() => {
    resolved = mod.resolveOptionByDisplayLabel(options, 'A');
  });

  assert.equal(resolved, undefined, '无可见标签时不得按下标硬映射');
  assert.equal(warnings.length, 1, `应产生一条可观测告警，实际: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /\[option-label\]/u);
  assert.match(warnings[0], /positional fallback/u);
  assert.match(warnings[0], /label=A/u);
});

test('a label that matches no option, or several, abstains with a distinct reason', async () => {
  const mod = await loadResolverModule();

  const noMatch = [createOption('B. Beta'), createOption('C. Gamma')];
  let missing;
  const missingWarnings = await captureWarnings(() => {
    missing = mod.resolveOptionByDisplayLabel(noMatch, 'A');
  });
  assert.equal(missing, undefined);
  assert.equal(missingWarnings.length, 1);
  assert.match(missingWarnings[0], /no option carries the answer letter/u);

  const duplicates = [createLabeledOption('A', '甲'), createLabeledOption('A', '乙')];
  let ambiguous;
  const duplicateWarnings = await captureWarnings(() => {
    ambiguous = mod.resolveOptionByDisplayLabel(duplicates, 'A');
  });
  assert.equal(ambiguous, undefined);
  assert.equal(duplicateWarnings.length, 1);
  assert.match(duplicateWarnings[0], /several options carry the answer letter/u);
});

test('a readable label still resolves without emitting a warning', async () => {
  const mod = await loadResolverModule();
  const options = [createLabeledOption('A', '甲'), createLabeledOption('B', '乙')];
  let resolved;
  const warnings = await captureWarnings(() => {
    resolved = mod.resolveOptionByDisplayLabel(options, 'B');
  });
  assert.equal(resolved?.innerText, '乙');
  assert.deepEqual(warnings, []);
});

test('a single letter answer only accepts one A–Z character', async () => {
  const mod = await loadResolverModule();
  const options = [createLabeledOption('A', '甲'), createLabeledOption('B', '乙')];

  // Anything that is not exactly one letter is not a label request at all; the
  // resolver returns undefined without touching the option list.
  for (const answer of ['', '   ', 'AB', 'A1', '1', '选项', '答案：']) {
    assert.equal(mod.resolveOptionByDisplayLabel(options, answer), undefined, `不应把 ${JSON.stringify(answer)} 当标签`);
  }

  // Single letters outside A–Z (e.g. Chinese option numbers) are not letters.
  assert.equal(mod.resolveOptionByDisplayLabel(options, '甲'), undefined);

  for (const [answer, expected] of [['A', '甲'], ['B', '乙'], ['a', '甲'], ['答案：B', '乙'], ['B.', '乙'], ['B、', '乙'], ['B：', '乙']]) {
    assert.equal(mod.resolveOptionByDisplayLabel(options, answer)?.innerText, expected, answer);
  }
});

test('exact mode rejects incomplete multiple answer groups and conflicting single answers', async () => {
  const mod = await loadResolverModule();
  for (const fixture of [
    { type: 'multiple', answer: 'apple#unrelated', options: ['apple', 'banana'] },
    { type: 'single', answer: 'apple#banana', options: ['apple', 'banana'] },
    { type: 'multiple', answer: 'same', options: ['same', 'same'] }
  ]) {
    const selected = [];
    const result = await mod.createDefaultQuestionResolver({ answerMatchMode: 'exact', answerSeparators: ['#'] })[fixture.type](
      [{ results: [{ answer: fixture.answer }] }], fixture.options.map(createOption),
      (_type, _answer, option) => selected.push(option.innerText));
    assert.equal(result.finish, false, fixture.answer);
    assert.deepEqual(selected, [], fixture.answer);
  }
});

test('multiple choice resolves a plain label group before matching option text', async () => {
  const mod = await loadResolverModule();
  const options = [createLabeledOption('A', 'AC'), createLabeledOption('B', '钠'), createLabeledOption('C', '镁')];
  const selected = [];
  const result = await mod.createDefaultQuestionResolver({ answerMatchMode: 'similar', answerSeparators: ['#'] }).multiple(
    [{ results: [{ answer: 'AC' }] }], options,
    (_type, _answer, option) => selected.push(option.innerText)
  );

  assert.equal(result.finish, true);
  assert.deepEqual(selected, ['AC', '镁']);
});

test('multiple choice does not treat unlabelled option text as a label group', async () => {
  const mod = await loadResolverModule();
  const options = [createOption('AC'), createOption('钠'), createOption('镁')];
  const selected = [];
  const result = await mod.createDefaultQuestionResolver({ answerMatchMode: 'similar', answerSeparators: ['#'] }).multiple(
    [{ results: [{ answer: 'AC' }] }], options,
    (_type, _answer, option) => selected.push(option.innerText)
  );

  assert.equal(result.finish, true);
  assert.deepEqual(selected, ['AC']);
});

test('multiple choice does not union conflicting plain-label groups', async () => {
  const mod = await loadResolverModule();
  const options = [
    createLabeledOption('A', '甲'), createLabeledOption('B', '乙'),
    createLabeledOption('C', '丙'), createLabeledOption('D', '丁')
  ];
  const selected = [];
  const result = await mod.createDefaultQuestionResolver({ answerMatchMode: 'exact', answerSeparators: ['#'] }).multiple(
    [
      { name: 'provider-a', results: [{ answer: 'AC' }] },
      { name: 'provider-b', results: [{ answer: 'BD' }] }
    ], options,
    (_type, _answer, option) => selected.push(option.innerText)
  );

  assert.equal(result.finish, false);
  assert.deepEqual(selected, []);
});

test('multiple choice treats reordered plain-label groups as the same set', async () => {
  const mod = await loadResolverModule();
  const options = [
    createLabeledOption('A', '甲'), createLabeledOption('B', '乙'),
    createLabeledOption('C', '丙'), createLabeledOption('D', '丁')
  ];
  const selected = [];
  const result = await mod.createDefaultQuestionResolver({ answerMatchMode: 'exact', answerSeparators: ['#'] }).multiple(
    [
      { name: 'provider-a', results: [{ answer: 'AC' }] },
      { name: 'provider-b', results: [{ answer: 'CA' }] }
    ], options,
    (_type, _answer, option) => selected.push(option.innerText)
  );

  assert.equal(result.finish, true);
  assert.deepEqual(selected, ['甲', '丙']);
});

test('multiple choice abstains when one provider returns conflicting groups', async () => {
  const mod = await loadResolverModule();
  const options = [
    createLabeledOption('A', 'AC'), createLabeledOption('B', '乙'),
    createLabeledOption('C', '丙'), createLabeledOption('D', '丁')
  ];
  const selected = [];
  const result = await mod.createDefaultQuestionResolver({ answerMatchMode: 'exact', answerSeparators: ['#'] }).multiple(
    [{ name: 'provider-a', results: [{ answer: 'AC' }, { answer: 'BD' }] }], options,
    (_type, _answer, option) => selected.push(option.innerText)
  );

  assert.equal(result.finish, false);
  assert.deepEqual(selected, []);
});

test('multiple choice follows the majority of agreeing label sets', async () => {
  const mod = await loadResolverModule();
  const options = [
    createLabeledOption('A', '甲'), createLabeledOption('B', '乙'),
    createLabeledOption('C', '丙'), createLabeledOption('D', '丁')
  ];
  const selected = [];
  const result = await mod.createDefaultQuestionResolver({ answerMatchMode: 'exact', answerSeparators: ['#'] }).multiple(
    [
      { name: 'provider-a', results: [{ answer: 'AC' }] },
      { name: 'provider-b', results: [{ answer: 'CA' }] },
      { name: 'provider-c', results: [{ answer: 'BD' }] }
    ], options,
    (_type, _answer, option) => selected.push(option.innerText)
  );

  assert.equal(result.finish, true);
  assert.deepEqual(selected, ['甲', '丙']);
});

test('multiple choice abstains when the leading set lacks a strict majority', async () => {
  const mod = await loadResolverModule();
  const options = [
    createLabeledOption('A', '甲'), createLabeledOption('B', '乙'),
    createLabeledOption('C', '丙'), createLabeledOption('D', '丁')
  ];
  const selected = [];
  const result = await mod.createDefaultQuestionResolver({ answerMatchMode: 'exact', answerSeparators: ['#'] }).multiple(
    [
      { name: 'provider-a', results: [{ answer: 'AC' }] },
      { name: 'provider-b', results: [{ answer: 'CA' }] },
      { name: 'provider-c', results: [{ answer: 'BD' }] },
      { name: 'provider-d', results: [{ answer: 'AB' }] }
    ], options,
    (_type, _answer, option) => selected.push(option.innerText)
  );

  assert.equal(result.finish, false);
  assert.deepEqual(selected, []);
});
