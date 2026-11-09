// 答案文本归一与相似度匹配的边界行为。
//
// 这几个函数决定「题库返回的答案文本」如何落到用户的选项上 —— 归一化太狠会把
// x+y / x-y 判成同一个答案，太松会把 "A. 北京" 与 "北京" 判成两个不同答案。
// 它们此前只有间接覆盖（经由 question.resolver），边界输入没人盯。
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./ci/ts-source-hooks.mjs', import.meta.url);
const { answerSimilar, answerExactMatch, clearString, removeRedundant } = await import('../src/core/utils/string.js');

test('removeRedundant strips only a single choice label prefix', () => {
  assert.equal(removeRedundant('A. 北京'), '北京');
  assert.equal(removeRedundant('B、选项'), '选项');
  assert.equal(removeRedundant('C：值'), '值');
  assert.equal(removeRedundant('D．全角点'), '全角点');
  // 多字母标签不是标签，必须原样保留，否则题目内容会被吃掉。
  assert.equal(removeRedundant('AB. 保留'), 'AB. 保留');
  // 小写字母同样不算标签。
  assert.equal(removeRedundant('a. 保留'), 'a. 保留');
  assert.equal(removeRedundant('  两端空白  '), '两端空白');
});

test('removeRedundant tolerates missing or non-string input without throwing', () => {
  assert.equal(removeRedundant(null), '');
  assert.equal(removeRedundant(undefined), '');
  assert.equal(removeRedundant(''), '');
});

test('clearString keeps CJK, latin, digits and circled numerals but drops case and ASCII punctuation', () => {
  assert.equal(clearString(' A B ①②③ '), 'ab①②③');
  assert.equal(clearString('Hello, World!'), 'helloworld');
  // 排除符可选：默认已包含带圈数字，额外排除符按调用方传入。
  assert.equal(clearString('a-b', '-'), 'a-b');
  assert.equal(clearString('a-b'), 'ab');
  // 半角/全角 ASCII 区标点都属噪音。
  assert.equal(clearString('北，京！是？首；都：'), '北京是首都');
});

test('clearString keeps CJK punctuation that falls inside the retained ideograph range', () => {
  // 保留区间是 \u2E80-\u9FFF，因此「。」「、」「《」「》」落在区间内被保留，
  // 不会像「，」那样被剔除。这是当前实现的既有行为（题干归一化靠它保住书名号），
  // 记录在此以免后续有人"顺手统一"所有中文标点而破坏书名号匹配。
  assert.equal(clearString('a。b'), 'a。b');
  assert.equal(clearString('a、b'), 'a、b');
  assert.equal(clearString('a《b》'), 'a《b》');
  assert.equal(clearString('北京，是首都。'), '北京是首都。');
});

test('answerSimilar scores identical text at 1 and returns one rating per option', () => {
  // 结果与选项一一对应，索引即选项索引 —— 调用方据此判断哪个选项命中。
  assert.deepEqual(answerSimilar(['A'], ['A']), [{ target: 'A', rating: 1 }]);
  assert.deepEqual(answerSimilar(['北京'], ['上海', '北京']), [
    { target: '', rating: 0 },
    { target: '北京', rating: 1 }
  ]);
});

test('answerSimilar keeps signs, case and repetition significant', () => {
  // x+y 与 x-y 只差一个符号，但绝不能判成完全一致。
  const [substituted] = answerSimilar(['x+y'], ['x-y']);
  assert.ok(substituted.rating < 1, `符号不同不得满分：${substituted.rating}`);
  assert.ok(substituted.rating > 0.5, `仍是高度相似，只是不满分：${substituted.rating}`);
  // 大小写有区分度。
  const [cased] = answerSimilar(['X'], ['x']);
  assert.ok(cased.rating < 1, 'X 与 x 不等价');
});

test('answerSimilar normalizes whitespace and unicode composition before comparing', () => {
  assert.deepEqual(answerSimilar(['a  b'], ['a b']), [{ target: 'a b', rating: 1 }], '多空格折叠成单空格');
  // e + 组合重音符 与预组合字符 应视为同一文本。
  assert.deepEqual(answerSimilar(['e\u0301'], ['\u00e9']), [{ target: '\u00e9', rating: 1 }], 'NFC 归一');
});

test('answerSimilar gives blank options and empty answer sets a zero rating instead of matching', () => {
  // 带标签前缀的答案先被剥掉标签，再和选项比对。
  assert.deepEqual(answerSimilar(['A. x'], ['x']), [{ target: 'x', rating: 1 }]);
  // 空选项直接 0 分，不参与 best-match（否则空串会和空答案互相命中）。
  assert.deepEqual(answerSimilar(['A'], ['', 'A']), [{ rating: 0, target: '' }, { target: 'A', rating: 1 }]);
  // 没有答案时全部 0 分，不能凭空给出 target。
  assert.deepEqual(answerSimilar([], ['A', 'B']), [{ rating: 0, target: '' }, { rating: 0, target: '' }]);
  assert.deepEqual(answerSimilar([], []), []);
});

test('answerExactMatch compares normalized text and preserves option order', () => {
  assert.deepEqual(answerExactMatch(['A. x', 'y'], ['x', 'y', 'z']), ['x', 'y'], '顺序按选项走，标签前缀不参与比较');
  assert.deepEqual(answerExactMatch(['y', 'x'], ['x', 'y']), ['x', 'y']);
  // 完全匹配是严格相等，不是包含。
  assert.deepEqual(answerExactMatch(['北'], ['北京']), []);
  // 空白差异在两端 trim 后视为相等。
  assert.deepEqual(answerExactMatch(['  北京  '], ['北京']), ['北京']);
  // 没有答案时不得返回任何选项 —— 否则会把所有选项全选上。
  assert.deepEqual(answerExactMatch([], ['x', 'y']), []);
  assert.deepEqual(answerExactMatch(['x'], []), []);
});
