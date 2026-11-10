// 判断题极性词表 + 选项标签归一。
//
// 这两件事决定「题库返回的答案能不能落到正确的选项上」，错了的表现是**静默填错**：
//   - 判断题只认 4 组对错写法 -> T/F、√/×、1/0 写法的页面被判成单选题，
//     然后按字母标签 A/B 去配答案，配不上就留空，用户只看到「没答」；
//   - 选项标签只认 `A.` -> `(A)`、`A、`、`Ａ`（全角）写法的选项剥不掉标签，
//     answerSimilar 拿 `(A) 北京` 和答案 `北京` 比，相似度不满分。
//
// 每条规则一个用例，规则之间不共用断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { register } from 'node:module';
import ts from '@typescript/typescript6';

register('./ci/ts-source-hooks.mjs', import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const { removeRedundant, answerSimilar, answerExactMatch, clearString } = await import(
  '../src/core/utils/string.js'
);

// ---------------------------------------------------------------------------
// A. 选项标签等价性：A / A. / (A) / A、/ Ａ 都是同一个选项
// ---------------------------------------------------------------------------
test('option label prefix A. is stripped', () => {
  assert.equal(removeRedundant('A. 北京'), '北京');
  assert.equal(removeRedundant('A.北京'), '北京');
});

test('option label prefix "(A)" and "（A）" are stripped', () => {
  assert.equal(removeRedundant('(A) 北京'), '北京');
  assert.equal(removeRedundant('（A）北京'), '北京');
  assert.equal(removeRedundant('(A). 北京'), '北京');
});

test('option label prefix "A、" and other CJK separators are stripped', () => {
  assert.equal(removeRedundant('A、北京'), '北京');
  assert.equal(removeRedundant('A：北京'), '北京');
  assert.equal(removeRedundant('A．北京'), '北京');
  assert.equal(removeRedundant('A）北京'), '北京');
});

test('full-width label Ａ is equivalent to half-width A', () => {
  assert.equal(removeRedundant('Ａ. 北京'), '北京');
  assert.equal(removeRedundant('Ａ、北京'), '北京');
  assert.equal(removeRedundant('（Ａ）北京'), '北京');
});
test('removeRedundant tolerates non-string-ish input via the String(str ?? "") fallback', () => {
  // L93 的 `String(str ?? '')` 兜底：调用方可能把 undefined 传进来（选项缺失时）。
  // 若没有这个兜底，`.trim()` 会抛 TypeError，整条匹配链断掉。
  assert.equal(removeRedundant(undefined), '');
  assert.equal(removeRedundant(null), '');
  // 数字型选项（题库偶见）也要被 String() 化后正常处理，而不是抛错。
  assert.equal(removeRedundant(123), '123');
});

test('removeRedundant keeps a bare label as content instead of stripping it to empty', () => {
  // L98 的 `rest || trimmed`：只有标签、没有正文时，那串就是选项内容本身。
  // 若剥成空串，answerSimilar 会拿 '' 去比对，任何答案都能"匹配"上。
  assert.equal(removeRedundant('(A)'), '(A)');
  assert.equal(removeRedundant('A.'), 'A.');
  assert.equal(removeRedundant('A、'), 'A、');
  // 有正文时才剥。
  assert.equal(removeRedundant('(A) 北京'), '北京');
});


test('all label spellings normalize to the same text so answer matching is identical', () => {
  // 这是这条需求的真正目的：五种写法配同一个答案必须给出完全一样的相似度。
  const spellings = ['A. 北京', '(A) 北京', '（A）北京', 'A、北京', 'Ａ. 北京'];
  const ratings = spellings.map((option) => answerSimilar(['北京'], [option])[0]);
  for (const rating of ratings) {
    assert.equal(rating.rating, 1, `「${rating.target}」应与答案「北京」满分匹配`);
    assert.equal(rating.target, '北京');
  }
  // 精确匹配同样如此。
  for (const option of spellings) {
    assert.deepEqual(answerExactMatch(['北京'], [option]), ['北京'], option);
  }
});

test('a bare letter with no separator is NOT treated as a label', () => {
  // 若把裸 `A` 当标签剥成空串，answerSimilar 会把空选项判成与空答案相等。
  assert.equal(removeRedundant('A'), 'A');
  assert.equal(removeRedundant('AB. 保留'), 'AB. 保留');
  assert.equal(removeRedundant('a. 保留'), 'a. 保留', '小写不算标签（既有行为）');
  assert.deepEqual(answerSimilar(['A'], ['A']), [{ target: 'A', rating: 1 }]);
});

// ---------------------------------------------------------------------------
// B. 判断题词表：9 组对错写法都必须能用同样的逻辑命中
// ---------------------------------------------------------------------------
//
// 这里不直接 import inferQuestionTypeFromOptionElements（它要 HTMLElement），
// 而是从源码里取出函数体 + 同文件的判定表，在 vm 里跑 —— 这样测的是**实现里的那份表**，
// 不是测试里另抄一份（抄一份的话实现改了测试照样绿，等于没测）。
const workSource = readFileSync(resolve(here, '../src/utils/work.ts'), 'utf8');
const workParsed = ts.createSourceFile('work.ts', workSource, ts.ScriptTarget.Latest, true);

/** 取出顶层 const 声明（JUDGEMENT_PAIRS）与指定顶层函数声明，拼成可执行片段。 */
function extractFromWork(names) {
  const parts = [];
  ts.forEachChild(workParsed, (node) => {
    if (ts.isVariableStatement(node)) {
      // 只取第一个声明名，避免把 `const a = ...` 里等号右边的同名标识符误判。
      const declaration = node.declarationList.declarations[0];
      const name = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : '';
      if (names.includes(name)) parts.push(node.getText(workParsed).replace(/^export /u, ''));
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
      parts.push(node.getText(workParsed).replace(/^export /u, ''));
    }
  });
  return parts.join('\n');
}

// 取出的片段是 **TypeScript**（带类型标注），不能直接丢进 new Function —— 先转译成 JS。
// 这也顺带保证测的是实现里的那份表，而不是测试里另抄一份。
const judgementSource = ts.transpileModule(
  `${extractFromWork(['JUDGEMENT_PAIRS', 'stripOptionLabelPrefix', 'isLegacyLetterLabel', 'normalizeOptionLabel'])}
export { JUDGEMENT_PAIRS, stripOptionLabelPrefix, normalizeOptionLabel };`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText;

const judgementRuntime = (() => {
  const module = { exports: {} };
  new Function('module', 'exports', judgementSource)(module, module.exports);
  return module.exports;
})();

test('judgement polarity table covers the 9 documented spellings', () => {
  const pairs = judgementRuntime.JUDGEMENT_PAIRS.map((pair) => [...pair]);
  assert.ok(pairs.length >= 9, `对错写法至少 9 组，实际 ${pairs.length}`);

  const flattened = new Set(pairs.flat());
  for (const expected of ['正确', '错误', '对', '错', '是', '否', 'true', 'false', 't', 'f', 'y', 'n', '√', '×', '✓', '✗', '1', '0']) {
    assert.ok(flattened.has(expected), `对错词表缺少「${expected}」`);
  }
});

test('each documented judgement pair is recognised from its two option labels', () => {
  // 逐组断言，不共用循环外的隐式状态：任何一组漏了都会单独红。
  const cases = [
    ['正确', '错误'],
    ['对', '错'],
    ['是', '否'],
    ['true', 'false'],
    ['t', 'f'],
    ['y', 'n'],
    ['√', '×'],
    ['✓', '✗'],
    ['1', '0']
  ];
  for (const [yes, no] of cases) {
    const labels = new Set([yes, no]);
    assert.ok(
      judgementRuntime.JUDGEMENT_PAIRS.some((pair) => pair.every((label) => labels.has(label))),
      `「${yes}/${no}」应被识别为一组判断题`
    );
  }
});

test('stripOptionLabelPrefix removes the whole label and leaves only the content', () => {
  const { stripOptionLabelPrefix } = judgementRuntime;
  const cases = [
    ['A. 正确', '正确'],
    ['(A) 正确', '正确'],
    ['（A）正确', '正确'],
    ['A、正确', '正确'],
    ['Ａ．正确', '正确'],
    // toLowerCase() 之后全角 Ａ 变成全角小写 ａ（U+FF41），也必须剥得掉。
    ['ａ．正确', '正确'],
    ['b) 错误', '错误']
  ];
  for (const [input, expected] of cases) {
    assert.equal(stripOptionLabelPrefix(input), expected, `「${input}」应剥成「${expected}」`);
  }
});

test('stripOptionLabelPrefix does not eat non-label text', () => {
  const { stripOptionLabelPrefix } = judgementRuntime;
  // 「true」不能因为首字母是 t 就被当标签剥掉 —— 判断题选项本身就是 true/false。
  assert.equal(stripOptionLabelPrefix('true'), 'true');
  assert.equal(stripOptionLabelPrefix('false'), 'false');
  assert.equal(stripOptionLabelPrefix('t'), 't');
  assert.equal(stripOptionLabelPrefix('√'), '√');
  assert.equal(stripOptionLabelPrefix('正确'), '正确');
  // 多字母不是标签。
  assert.equal(stripOptionLabelPrefix('AB. 保留'), 'AB. 保留');
});

test('normalizeOptionLabel recognises A / A. / (A) / A、/ Ａ but rejects multi-letter and CJK', () => {
  const { normalizeOptionLabel } = judgementRuntime;
  // 大小写保持原样：这个返回值会被用来重建选项前缀（`A. ` / `a. `），
  // 改成统一大写会连带改掉已上线产物里的选项文本。
  for (const label of ['A', 'A.', 'A、', '(A)', '（A）', 'A)', 'Ａ', 'Ａ.']) {
    assert.equal(normalizeOptionLabel(label), 'A', `「${label}」应归一到 A`);
  }
  for (const label of ['a', 'a.', '(a)']) {
    assert.equal(normalizeOptionLabel(label), 'a', `「${label}」应归一到 a（保持小写）`);
  }
  for (const rejected of ['AB', 'AB.', '', ' ', '正确', '(AB)', '±']) {
    assert.equal(normalizeOptionLabel(rejected), undefined, `「${rejected}」不是字母标签`);
  }
});

// ---------------------------------------------------------------------------
// C. 极性符号匹配：√ × ✓ ✗ 必须能通过 clearString 比对
// ---------------------------------------------------------------------------
test('clearString keeps the four polarity symbols when they are excluded explicitly', () => {
  // clearString 默认只保留 \u2E80-\u9FFF + 字母数字，四个符号都会被剔除。
  // 若不用 exclude 保留它们，「答案是 √」会被剔成空串，永远匹配不上任何选项。
  for (const symbol of ['√', '×', '✓', '✗']) {
    assert.equal(clearString(symbol), '', `${symbol} 默认应被剔除（这是既有行为）`);
    assert.equal(clearString(symbol, '√', '×', '✓', '✗'), symbol, `${symbol} 必须在 exclude 里被保留`);
  }
});

test('judgement resolver keeps ✓ and ✗ in its comparison (not just √ and ×)', () => {
  // resolver 的 matches() 用 clearString(..., '√', '×', '✓', '✗')。
  // 少列 ✓/✗ 时，✓/✗ 写法的页面会静默配不上 —— 这条钉子盯的就是那四个参数。
  const resolverSource = readFileSync(resolve(here, '../src/core/worker/question.resolver.ts'), 'utf8');
  const matchesBody = resolverSource.match(/function matches\(target: string, options: string\[\]\) \{[\s\S]*?\n        \}/u);
  assert.ok(matchesBody, '应能定位 matches() 实现');
  for (const symbol of ['√', '×', '✓', '✗']) {
    assert.ok(matchesBody[0].includes(`'${symbol}'`), `matches() 的 clearString exclude 参数缺少「${symbol}」`);
  }
});

test('judgement resolver polarity words cover T/F, Y/N, √/×, ✓/✗, 1/0', () => {
  const resolverSource = readFileSync(resolve(here, '../src/core/worker/question.resolver.ts'), 'utf8');
  const correctBlock = resolverSource.match(/const correctWords = \[([\s\S]*?)\];/u);
  const incorrectBlock = resolverSource.match(/const incorrectWords = \[([\s\S]*?)\];/u);
  assert.ok(correctBlock && incorrectBlock);

  const words = (block) => new Set(block[1].split(',').map((item) => item.trim().replace(/^'|'$/gu, '')).filter(Boolean));
  const correct = words(correctBlock);
  const incorrect = words(incorrectBlock);

  for (const word of ['T', 't', 'Y', 'y', '√', '✓', '1']) {
    assert.ok(correct.has(word), `correctWords 缺少「${word}」`);
  }
  for (const word of ['F', 'f', 'N', 'n', '×', '✗', 'X', 'x', '0']) {
    assert.ok(incorrect.has(word), `incorrectWords 缺少「${word}」`);
  }
});
