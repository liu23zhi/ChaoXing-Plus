import { QuestionResolver, QuestionTypes, WorkContext } from './interface';
import { resolvePlainAnswer, splitAnswer } from './utils';
import { answerSimilar, removeRedundant, clearString, answerExactMatch, Rating } from '../utils/string';

function nowrap(value: string, replacement = ''): string {
  return value.replace(/\s+/g, replacement);
}

type SimilarResultScore = {
  similarCount: number;
  similarSum: number;
};

/** Sort higher-confidence multi-choice candidates first. */
export function compareSimilarResults(a: SimilarResultScore, b: SimilarResultScore): number {
  const aScore = a.similarCount * 100 + a.similarSum;
  const bScore = b.similarCount * 100 + b.similarSum;
  return bScore - aScore;
}

function readDisplayLabel(value: string): string | undefined {
  const normalized = String(value ?? '').trim().toUpperCase();
  const match = normalized.match(/^(?:(?:答案|选项|选择)(?:是|为)?\s*[:：]?\s*)?([A-Z])(?=$|[.。、,:：])/u);
  return match?.[1];
}

/** Find an option by its visible label; Chaoxing data values may be remapped. */
export function resolveOptionByDisplayLabel(options: HTMLElement[], answer: string): HTMLElement | undefined {
  const label = readDisplayLabel(answer);
  if (!label) {
    return undefined;
  }

  const labels = options.map((option) => {
    const optionRoot = option.closest?.('.answerBg, .clearfix');
    const visibleLabel = optionRoot?.querySelector<HTMLElement>('.num_option, .option_label, [data-option-label]');
    const explicitLabel = readDisplayLabel(visibleLabel?.textContent || visibleLabel?.innerText || '');
    return explicitLabel ?? readDisplayLabel(option.textContent || option.innerText);
  });
  if (!labels.some(Boolean)) {
    return options[label.charCodeAt(0) - 65];
  }
  const matches = options.filter((_, index) => labels[index] === label);
  return matches.length === 1 ? matches[0] : undefined;
}

/** 默认答案题目处理器 */
export function createDefaultQuestionResolver<E>(
  ctx: WorkContext<E>
): Record<'single' | 'multiple' | 'completion' | 'judgement', QuestionResolver<E>> {
  const apply = async (type: QuestionTypes, answer: string, option: HTMLElement, handler: Parameters<QuestionResolver<E>>[2]) => {
    await ctx.waitForContinue?.();
    await handler(type, answer, option, ctx);
  };

  return {
    async single(infos, options, handler) {
      const allAnswer = infos
        .map((res) => res.results.map((res) => splitAnswer(res.answer, ctx.answerSeparators)).flat())
        .flat();
      const optionStrings = options.map((o) => removeRedundant(o.innerText));
      let ratings: Rating[] = [];
      if (ctx.answerMatchMode === 'similar') {
        const exact = answerExactMatch(allAnswer, optionStrings);
        if (exact.length === 1) {
          const index = optionStrings.indexOf(exact[0]);
          await apply('single', options[index].innerText, options[index], handler);
          return { finish: true };
        }
        ratings = answerSimilar(allAnswer, optionStrings);
        const ranked = ratings
          .map((rating, index) => ({ rating, index }))
          .sort((a, b) => b.rating.rating - a.rating.rating || a.index - b.index);
        const best = ranked[0];
        const second = ranked[1];
        const margin = best ? best.rating.rating - (second?.rating.rating ?? 0) : 0;
        if (best && best.rating.rating >= 0.7 && (!second || margin >= 0.1)) {
          await apply('single', best.rating.target, options[best.index], handler);
          return {
            finish: true,
            ratings: ratings.map((r) => r.rating)
          };
        }
      } else if (ctx.answerMatchMode === 'exact') {
        const result = answerExactMatch(allAnswer, optionStrings);
        const index = optionStrings.findIndex((option) => result.includes(option));
        if (result.length === 1) {
          await apply('single', options[index].innerText, options[index], handler);
          return {
            finish: true
          };
        }
      }

      for (const info of infos) {
        for (const res of info.results) {
          const ans = nowrap(res.answer, '').trim();
          if (ans.length === 1 && /[A-Z]/.test(ans)) {
            const option = resolveOptionByDisplayLabel(options, ans);
            if (option === undefined) {
              continue;
            }
            await apply('single', option.innerText, option, handler);
            return { finish: true, option };
          }
        }
      }

      return { finish: false, allAnswer, ratings: ratings.map((r) => r.rating), options: optionStrings };
    },
    async multiple(infos, options, handler) {
      const targetAnswers: string[][] = [];
      const targetOptions: HTMLElement[][] = [];

      type SimilarResult = {
        options: HTMLElement[];
        answers: string[];
        ratings: number[];
        similarSum: number;
        similarCount: number;
      };

      const similar_list: SimilarResult[] = [];
      const exact_list: HTMLElement[][] = [];
      const results = infos.map((info) => info.results).flat();

      function limitSimilarResultToAnswerCount(result: SimilarResult, answerCount: number): SimilarResult {
        if (answerCount <= 0 || result.options.length <= answerCount) {
          return result;
        }

        const ranked = result.options
          .map((option, index) => ({
            option,
            answer: result.answers[index],
            rating: result.ratings[index],
            index
          }))
          .sort((a, b) => b.rating - a.rating || a.index - b.index);

        const selectedIndexes = new Set<number>();
        const selectedAnswerKeys = new Set<string>();
        for (const item of ranked) {
          const answerKey = clearString(removeRedundant(item.answer));
          if (answerKey && selectedAnswerKeys.has(answerKey)) {
            continue;
          }
          selectedIndexes.add(item.index);
          if (answerKey) {
            selectedAnswerKeys.add(answerKey);
          }
          if (selectedIndexes.size === answerCount) {
            break;
          }
        }

        for (const item of ranked) {
          if (selectedIndexes.size === answerCount) {
            break;
          }
          selectedIndexes.add(item.index);
        }

        const selected = [...selectedIndexes]
          .sort((a, b) => a - b)
          .map((index) => ({
            option: result.options[index],
            answer: result.answers[index],
            rating: result.ratings[index]
          }));

        return {
          options: selected.map((item) => item.option),
          answers: selected.map((item) => item.answer),
          ratings: selected.map((item) => item.rating),
          similarSum: selected.reduce((sum, item) => sum + item.rating, 0),
          similarCount: selected.length
        };
      }

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const answers = splitAnswer(result.answer.trim(), ctx.answerSeparators);

        if (ctx.answerMatchMode === 'similar') {
          const ratingResult: SimilarResult = { options: [], answers: [], ratings: [], similarSum: 0, similarCount: 0 };
          let complete = answers.length > 0;
          for (const answer of answers) {
            const ranked = answerSimilar([answer], options.map((option) => option.innerText))
              .map((rating, index) => ({ ...rating, index }))
              .sort((a, b) => b.rating - a.rating || a.index - b.index);
            const best = ranked[0];
            const second = ranked[1];
            const uniqueExact = best?.rating === 1 && second?.rating !== 1;
            if (!best || (!uniqueExact && (best.rating < 0.7 || (second && best.rating - second.rating < 0.1)))) {
              complete = false;
              break;
            }
            const option = options[best.index];
            if (!ratingResult.options.includes(option)) {
              ratingResult.options.push(option);
              ratingResult.answers.push(answer);
              ratingResult.ratings.push(best.rating);
              ratingResult.similarSum += best.rating;
              ratingResult.similarCount++;
            }
          }
          similar_list[i] = complete ? limitSimilarResultToAnswerCount(ratingResult, answers.length)
            : { options: [], answers: [], ratings: [], similarSum: 0, similarCount: 0 };
        } else if (ctx.answerMatchMode === 'exact') {
          const matched: HTMLElement[] = [];
          let complete = answers.length > 0;
          for (const answer of answers) {
            const candidates = options.filter((option) =>
              answerExactMatch([answer], [removeRedundant(option.innerText)]).length === 1);
            if (candidates.length !== 1) {
              complete = false;
              break;
            }
            if (!matched.includes(candidates[0])) matched.push(candidates[0]);
          }
          exact_list[i] = complete ? matched : [];
        }
      }

      if (ctx.answerMatchMode === 'similar') {
        const sorted_similar_list = similar_list
          .filter((i) => i.similarCount !== 0)
          .sort((a, b) => {
            return compareSimilarResults(a, b);
          });

        if (sorted_similar_list[0]) {
          for (let i = 0; i < sorted_similar_list[0].options.length; i++) {
            await apply('multiple', sorted_similar_list[0].answers[i], sorted_similar_list[0].options[i], handler);
          }

          return { finish: true, sorted_similar_list, targetOptions, targetAnswers };
        }
      } else if (ctx.answerMatchMode === 'exact') {
        const sorted_exact_list = exact_list.sort((a, b) => b.length - a.length);
        if (sorted_exact_list[0]?.length) {
          for (let i = 0; i < sorted_exact_list[0].length; i++) {
            await apply('multiple', sorted_exact_list[0][i].innerText, sorted_exact_list[0][i], handler);
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
          const resolvedOptions = [...plainAnswer].map((char) => resolveOptionByDisplayLabel(options, char));
          if (resolvedOptions.some((option) => option === undefined)) continue;
          for (const option of resolvedOptions as HTMLElement[]) {
            if (option === undefined) {
              continue;
            }
            await apply('multiple', option.innerText, option, handler);
            plainOptions.push(option);
          }
        }
      }

      if (plainOptions.length) {
        return { finish: true, plainOptions };
      } else {
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
          let option: HTMLElement | undefined;
          for (const el of options) {
            const textShowCorrect = matches(el.innerText, correctWords);
            const textShowIncorrect = matches(el.innerText, incorrectWords);

            if (answerShowCorrect && textShowCorrect) {
              option = el;
              await apply('judgement', answerShowCorrect, el, handler);
              break;
            }
            if (answerShowIncorrect && textShowIncorrect) {
              option = el;
              await apply('judgement', answerShowIncorrect, el, handler);
              break;
            }
          }

          if (option) return { finish: true, option };
        }

        function matches(target: string, options: string[]) {
          return options.some(
            (option) =>
              clearString(removeRedundant(option), '√', '×') === clearString(removeRedundant(target), '√', '×')
          );
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
              await apply('completion', ans[index], element, handler);
            }
            return { finish: true };
          } else if (options.length === 1) {
            await apply('completion', ans.join(' '), options[0], handler);
            return { finish: true };
          }

          return { finish: false };
        }
      }

      return { finish: false };
    }
  };
}
