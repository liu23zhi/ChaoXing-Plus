export interface Rating {
  target: string;
  rating: number;
}

function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const left = Array.from(a);
  const right = Array.from(b);
  let previous = right.map((_, index) => index + 1);
  previous.unshift(0);
  for (let i = 1; i <= left.length; i++) {
    const row = [i];
    for (let j = 1; j <= right.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function findBestMatch(mainString: string, targetStrings: string[]): { bestMatch: Rating } {
  let bestMatch: Rating = { target: '', rating: 0 };
  for (const target of targetStrings) {
    const rating = similarity(mainString, target);
    if (rating > bestMatch.rating) {
      bestMatch = { target, rating };
    }
  }
  return { bestMatch };
}

export function clearString(str: string, ...exclude: string[]) {
  exclude.push(...['①②③④⑤⑥⑦⑧⑨']);
  return str
    .trim()
    .toLocaleLowerCase()
    .replace(RegExp(`[^\\u2E80-\\u9FFFA-Za-z0-9${exclude.join('')}]*`, 'g'), '');
}

export function answerSimilar(answers: string[], options: string[]): Rating[] {
  // Keep signs, order, repetition and case: x+y, x-y, X and x may differ.
  const normalize = (value: string) => removeRedundant(value).normalize('NFC').replace(/\s+/gu, ' ').trim();
  const _answers = answers.map(normalize);
  const _options = options.map(normalize);

  const similar =
    _answers.length !== 0
      ? _options.map((option) => {
          if (option.trim() === '') {
            return { rating: 0, target: '' };
          }
          return findBestMatch(option, _answers).bestMatch;
        })
      : _options.map(() => ({ rating: 0, target: '' }));

  return similar;
}

export function answerExactMatch(answers: string[], options: string[]): string[] {
  const _answers = answers.map(removeRedundant);
  const _options = options.map(removeRedundant);

  const result =
    _answers.length !== 0
      ? _options.filter((option) => {
          return _answers.find((answer) => answer.trim() === option.trim());
        })
      : [];

  return result;
}

/**
 * 选项标签前缀：`A.` / `A、` / `A：` / `A．` / `A)` / `(A)` / `（A）` / `Ａ.`（全角字母）。
 *
 * 三条边界是刻意的，改动前请先看 answer-text-matching.test.mjs：
 *   - **只认单个字母**：`AB. 保留` 是多字母标签，不是标签，必须原样保留；
 *   - **只认大写**（ASCII `A-Z` + 全角 `Ａ-Ｚ`）：`a. 保留` 按既有行为不算标签；
 *   - **字母后必须有分隔符或括号**：否则裸 `A` 会被剥成空串，
 *     让 answerSimilar 把所有空选项都判成命中。
 *
 * 三种合法形态（任一）：
 *   `(A)` 带左括号   |   `A)` 只带右括号   |   `A、/A./A：` 带分隔符
 * 之后再允许补一个分隔符（`(A). 北京`），学习通这种写法也出现过。
 */
const OPTION_LABEL_PREFIX =
  /^(?:[(（][A-Z\uFF21-\uFF3A][)）]|[A-Z\uFF21-\uFF3A][)）]|[A-Z\uFF21-\uFF3A][.．、:：])[.．、:：]?\s*/u;

export function removeRedundant(str: string) {
  const trimmed = String(str ?? '').trim();
  const label = trimmed.match(OPTION_LABEL_PREFIX);
  if (!label) return trimmed;
  const rest = trimmed.slice(label[0].length).trim();
  // 只有标签没有正文（`(A)`）时，那不是标签而是选项内容本身，别剥成空串。
  return rest || trimmed;
}
