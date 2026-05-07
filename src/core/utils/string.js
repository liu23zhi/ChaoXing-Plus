function tokenize(value) {
    return new Set(value.split('').filter(Boolean));
}
function similarity(a, b) {
    if (!a && !b)
        return 1;
    if (!a || !b)
        return 0;
    const setA = tokenize(a);
    const setB = tokenize(b);
    const intersection = [...setA].filter((token) => setB.has(token)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}
function findBestMatch(mainString, targetStrings) {
    let bestMatch = { target: '', rating: 0 };
    for (const target of targetStrings) {
        const rating = similarity(mainString, target);
        if (rating > bestMatch.rating) {
            bestMatch = { target, rating };
        }
    }
    return { bestMatch };
}
export function clearString(str, ...exclude) {
    exclude.push(...['①②③④⑤⑥⑦⑧⑨']);
    return str
        .trim()
        .toLocaleLowerCase()
        .replace(RegExp(`[^\\u2E80-\\u9FFFA-Za-z0-9${exclude.join('')}]*`, 'g'), '');
}
export function answerSimilar(answers, options) {
    const _answers = answers.map(removeRedundant).map((a) => clearString(a));
    const _options = options.map(removeRedundant).map((o) => clearString(o));
    const similar = _answers.length !== 0
        ? _options.map((option) => {
            if (option.trim() === '') {
                return { rating: 0, target: '' };
            }
            return findBestMatch(option, _answers).bestMatch;
        })
        : _options.map(() => ({ rating: 0, target: '' }));
    return similar;
}
export function answerExactMatch(answers, options) {
    const _answers = answers.map(removeRedundant);
    const _options = options.map(removeRedundant);
    const result = _answers.length !== 0
        ? _options.filter((option) => {
            return _answers.find((answer) => answer.trim() === option.trim());
        })
        : [];
    return result;
}
export function removeRedundant(str) {
    return str?.trim().replace(/[A-Z]{1}[^A-Za-z0-9⺀-鿿]+([A-Za-z0-9⺀-鿿]+)/, '$1') || '';
}
