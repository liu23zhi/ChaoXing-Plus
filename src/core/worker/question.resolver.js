import { resolvePlainAnswer, splitAnswer } from './utils';
import { answerSimilar, removeRedundant, clearString, answerExactMatch } from '../utils/string';
function nowrap(value, replacement = '') {
    return value.replace(/\s+/g, replacement);
}
/** 默认答案题目处理器 */
export function createDefaultQuestionResolver(ctx) {
    return {
        async single(infos, options, handler) {
            const allAnswer = infos
                .map((res) => res.results.map((res) => splitAnswer(res.answer, ctx.answerSeparators)).flat())
                .flat();
            const optionStrings = options.map((o) => removeRedundant(o.innerText));
            let ratings = [];
            if (ctx.answerMatchMode === 'similar') {
                ratings = answerSimilar(allAnswer, optionStrings);
                let index = -1;
                let max = 0;
                let ans = '';
                ratings.forEach((rating, i) => {
                    if (rating.rating > max) {
                        max = rating.rating;
                        index = i;
                        ans = rating.target;
                    }
                });
                if (index !== -1 && max > 0.6) {
                    await handler('single', ans, options[index], ctx);
                    return {
                        finish: true,
                        ratings: ratings.map((r) => r.rating)
                    };
                }
            }
            else if (ctx.answerMatchMode === 'exact') {
                const result = answerExactMatch(allAnswer, optionStrings);
                const index = optionStrings.findIndex((option) => result.includes(option));
                if (result.length) {
                    await handler('single', options[index].innerText, options[index], ctx);
                    return {
                        finish: true
                    };
                }
            }
            for (const info of infos) {
                for (const res of info.results) {
                    const ans = nowrap(res.answer, '').trim();
                    if (ans.length === 1 && /[A-Z]/.test(ans)) {
                        const index = ans.charCodeAt(0) - 65;
                        if (options[index] === undefined) {
                            continue;
                        }
                        await handler('single', options[index].innerText, options[index], ctx);
                        return { finish: true, option: options[index] };
                    }
                }
            }
            return { finish: false, allAnswer, ratings: ratings.map((r) => r.rating), options: optionStrings };
        },
        async multiple(infos, options, handler) {
            const targetAnswers = [];
            const targetOptions = [];
            const similar_list = [];
            const exact_list = [];
            const results = infos.map((info) => info.results).flat();
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                const answers = splitAnswer(result.answer.trim(), ctx.answerSeparators);
                if (ctx.answerMatchMode === 'similar') {
                    const matchResult = { options: [], answers: [], ratings: [], similarSum: 0, similarCount: 0 };
                    for (const option of options) {
                        const ans = answers.find((answer) => answer.includes(removeRedundant(option.textContent || option.innerText)));
                        if (ans) {
                            matchResult.options.push(option);
                            matchResult.answers.push(ans);
                            matchResult.ratings.push(1);
                            matchResult.similarSum += 1;
                            matchResult.similarCount += 1;
                        }
                    }
                    const ratingResult = { options: [], answers: [], ratings: [], similarSum: 0, similarCount: 0 };
                    const ratings = answerSimilar(answers, options.map((o) => removeRedundant(o.innerText)));
                    for (let j = 0; j < ratings.length; j++) {
                        const rating = ratings[j];
                        if (rating.rating > 0.6) {
                            ratingResult.options.push(options[j]);
                            ratingResult.answers.push(ratings[j].target);
                            ratingResult.ratings.push(ratings[j].rating);
                            ratingResult.similarSum += rating.rating;
                            ratingResult.similarCount += 1;
                        }
                    }
                    if (matchResult.similarSum > ratingResult.similarSum) {
                        similar_list[i] = matchResult;
                    }
                    else {
                        similar_list[i] = ratingResult;
                    }
                }
                else if (ctx.answerMatchMode === 'exact') {
                    exact_list[i] = answerExactMatch(answers, options.map((o) => removeRedundant(o.innerText)))
                        .map((option) => options.find((o) => removeRedundant(o.innerText) === option))
                        .filter(Boolean);
                }
            }
            if (ctx.answerMatchMode === 'similar') {
                const sorted_similar_list = similar_list
                    .filter((i) => i.similarCount !== 0)
                    .sort((a, b) => {
                    const bsc = b.similarCount * 100;
                    const asc = a.similarCount * 100;
                    const bss = b.similarSum;
                    const ass = a.similarSum;
                    return bsc + bss - asc + ass;
                });
                if (sorted_similar_list[0]) {
                    for (let i = 0; i < sorted_similar_list[0].options.length; i++) {
                        await handler('multiple', sorted_similar_list[0].answers[i], sorted_similar_list[0].options[i], ctx);
                    }
                    return { finish: true, sorted_similar_list, targetOptions, targetAnswers };
                }
            }
            else if (ctx.answerMatchMode === 'exact') {
                const sorted_exact_list = exact_list.sort((a, b) => b.length - a.length);
                if (sorted_exact_list[0]?.length) {
                    for (let i = 0; i < sorted_exact_list[0].length; i++) {
                        await handler('multiple', sorted_exact_list[0][i].innerText, sorted_exact_list[0][i], ctx);
                    }
                    return {
                        finish: true,
                        sorted_exact_list: sorted_exact_list.map((i) => i.map((e) => e.innerText)),
                        targetOptions,
                        targetAnswers
                    };
                }
            }
            const plainOptions = [];
            for (const result of results) {
                const ans = nowrap(result.answer, '').trim();
                const plainAnswer = resolvePlainAnswer(ans);
                if (plainAnswer) {
                    for (const char of ans) {
                        const index = char.charCodeAt(0) - 65;
                        if (options[index] === undefined) {
                            continue;
                        }
                        await handler('multiple', options[index].innerText, options[index], ctx);
                        plainOptions.push(options[index]);
                    }
                }
            }
            if (plainOptions.length) {
                return { finish: true, plainOptions };
            }
            else {
                return { finish: false };
            }
        },
        async judgement(infos, options, handler) {
            for (const answers of infos.map((info) => info.results.map((res) => res.answer))) {
                const correctWords = ['是', '对', '正确', '确定', '√', '对的', '是的', '正确的', 'true', 'True', 'T', 'yes', '1'];
                const incorrectWords = [
                    '非',
                    '否',
                    '错',
                    '错误',
                    '×',
                    'X',
                    '错的',
                    '不对',
                    '不正确的',
                    '不正确',
                    '不是',
                    '不是的',
                    'false',
                    'False',
                    'F',
                    'no',
                    '0'
                ];
                const answerShowCorrect = answers.find((answer) => matches(answer, correctWords));
                const answerShowIncorrect = answers.find((answer) => matches(answer, incorrectWords));
                if (answerShowCorrect || answerShowIncorrect) {
                    let option;
                    for (const el of options) {
                        const textShowCorrect = matches(el.innerText, correctWords);
                        const textShowIncorrect = matches(el.innerText, incorrectWords);
                        if (answerShowCorrect && textShowCorrect) {
                            option = el;
                            await handler('judgement', answerShowCorrect, el, ctx);
                            break;
                        }
                        if (answerShowIncorrect && textShowIncorrect) {
                            option = el;
                            await handler('judgement', answerShowIncorrect, el, ctx);
                            break;
                        }
                    }
                    return { finish: true, option };
                }
                function matches(target, options) {
                    return options.some((option) => clearString(removeRedundant(option), '√', '×') === clearString(removeRedundant(target), '√', '×'));
                }
            }
            return { finish: false };
        },
        async completion(infos, options, handler) {
            for (const answers of infos.map((info) => info.results.map((res) => res.answer))) {
                let ans = answers.filter((ans) => ans);
                if (ans.length === 1) {
                    ans = splitAnswer(ans[0], ctx.answerSeparators);
                }
                if (ans.length !== 0 && (ans.length === options.length || options.length === 1)) {
                    if (ans.length === options.length) {
                        for (let index = 0; index < options.length; index++) {
                            const element = options[index];
                            await handler('completion', ans[index], element, ctx);
                        }
                        return { finish: true };
                    }
                    else if (options.length === 1) {
                        await handler('completion', ans.join(' '), options[0], ctx);
                        return { finish: true };
                    }
                    return { finish: false };
                }
            }
            return { finish: false };
        }
    };
}
