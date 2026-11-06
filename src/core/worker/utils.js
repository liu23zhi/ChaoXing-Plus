/** 默认题目类型解析器 */
export function defaultWorkTypeResolver(ctx) {
    function count(selector) {
        let c = 0;
        for (const option of ctx.elements.options || []) {
            if (option?.querySelector(selector) !== null) {
                c++;
            }
        }
        return c;
    }
    return count('[type="radio"]') === 2
        ? 'judgement'
        : count('[type="radio"]') > 2
            ? 'single'
            : count('[type="checkbox"]') > 2
                ? 'multiple'
                : count('textarea') >= 1
                    ? 'completion'
                    : undefined;
}
export function isPlainAnswer(answer) {
    answer = answer.trim();
    if (!/^[A-Z]{1,8}$/.test(answer)) {
        return false;
    }
    return new Set(answer).size === answer.length;
}
export function resolvePlainAnswer(answer) {
    const resolve = answer
        .trim()
        .replace(/[,，、 #]/g, '')
        .trim()
        .toUpperCase();
    if (isPlainAnswer(resolve)) {
        return [...resolve].sort().join('');
    }
    return undefined;
}
export function splitAnswer(answer, separators = ['===', '#', '---', '###', '|', ';', '；']) {
    answer = answer.trim();
    if (answer.length === 0) {
        return [];
    }
    separators = separators.length === 0 ? ['===', '#', '---', '###', '|', ';', '；'] : separators;
    separators = separators.filter((el) => el.trim().length > 0);
    try {
        const json = JSON.parse(answer);
        if (Array.isArray(json)) {
            return json.map(String).filter((el) => el.trim().length > 0);
        }
    }
    catch {
        for (const sep of separators) {
            if (answer.split(sep).length > 1) {
                return answer.split(sep).filter((el) => el.trim().length > 0);
            }
        }
    }
    return [answer];
}
