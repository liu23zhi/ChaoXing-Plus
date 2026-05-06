import type { SimplifyWorkResult } from '../core/index.js';

export function optimizationElementWithImage(root: HTMLElement, cloneNode = false): HTMLElement {
  const clone = cloneNode ? (root.cloneNode(true) as HTMLElement) : root;
  for (const img of Array.from(clone.querySelectorAll('img'))) {
    const src = document.createElement('span');
    src.innerText = img.src;
    src.style.fontSize = '0px';
    img.after(src);
  }
  return clone;
}

export function removeRedundantWords(text: string, words: string[]): string {
  return words.filter(Boolean).reduce((acc, word) => acc.split(word.trim()).join(''), text);
}

export function splitAnswer(answer: string): string[] {
  return answer.split(/[#,，;；\n]/).map((item) => item.trim()).filter(Boolean);
}

export function simplifyWorkResult<T extends { ctx?: any; error?: string; requested: boolean; resolved: boolean; result?: { finish?: boolean } }>(
  results: T[],
  titleTransform?: (titles: (HTMLElement | undefined)[]) => string
): SimplifyWorkResult[] {
  return results.map((item) => ({
    question: titleTransform?.(item.ctx?.elements?.title ?? []) ?? '',
    type: item.ctx?.type,
    error: item.error,
    finish: item.result?.finish,
    requested: item.requested,
    resolved: item.resolved,
    searchInfos: (item.ctx?.searchInfos ?? []).map((info: any) => ({
      name: info.name,
      homepage: info.homepage,
      error: info.error,
      results: (info.results ?? []).map((result: any) => [result.question, result.answer, result.extra_data ?? {}])
    }))
  }));
}

export function answerWrapperEmptyWarning(_duration: number) {
  console.warn('[chaoxing-plus] 当前未配置题库');
}

export interface CommonWorkStarterOptions<T> {
  workerProvider: (opts: T) => unknown;
  enable_control_panel?: boolean;
  start_delay_seconds?: number;
}

export function commonWork<T extends { answererWrappers: unknown[] }>(
  _script: unknown,
  options: CommonWorkStarterOptions<T>,
  workOptions: T
): void {
  if (!workOptions.answererWrappers.length) {
    answerWrapperEmptyWarning(0);
    return;
  }

  const startDelay = Math.max(0, options.start_delay_seconds ?? 0);
  if (startDelay === 0) {
    options.workerProvider(workOptions);
    return;
  }

  window.setTimeout(() => {
    options.workerProvider(workOptions);
  }, startDelay * 1000);
}
