function similarity(a, b) {
    if (!a && !b)
        return 1;
    if (!a || !b)
        return 0;
    const left = Array.from(a);
    const right = Array.from(b);
    let previous = right.map((_, index) => index + 1);
    previous.unshift(0);
    for (let i = 1; i <= left.length; i++) {
        const row = [i];
        for (let j = 1; j <= right.length; j++) {
            row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
        }
        previous = row;
    }
    return 1 - previous[right.length] / Math.max(left.length, right.length);
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
    // Keep signs, order, repetition and case: x+y, x-y, X and x may differ.
    const normalize = (value) => removeRedundant(value).normalize('NFC').replace(/\s+/gu, ' ').trim();
    const _answers = answers.map(normalize);
    const _options = options.map(normalize);
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
    return str?.trim().replace(/^[A-Z][.．、:：]\s*/u, '') || '';
}
