export interface Rating {
  target: string;
  rating: number;
}

function tokenize(value: string): Set<string> {
  return new Set(value.split('').filter(Boolean));
}

function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;

  const setA = tokenize(a);
  const setB = tokenize(b);
  const intersection = [...setA].filter((token) => setB.has(token)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
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
  const _answers = answers.map(removeRedundant).map((a) => clearString(a));
  const _options = options.map(removeRedundant).map((o) => clearString(o));

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

export function removeRedundant(str: string) {
  return str?.trim().replace(/[A-Z]{1}[^A-Za-z0-9⺀-鿿]+([A-Za-z0-9⺀-鿿]+)/, '$1') || '';
}
