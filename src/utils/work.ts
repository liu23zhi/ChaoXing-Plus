import type { SimplifyWorkResult, QuestionEvidence, QuestionImageEvidence } from '../core/index.js';
import { runtimeStore } from '../runtime/index.js';
import { $modal } from '../runtime/message.js';
import {
  DEFAULT_TIKU_BASE_URL,
  TIKU_ADAPTER_BASEURL_KEY,
  TIKU_ADAPTER_KEY_KEY,
  getTikuAdapterConfigProblem,
  resolveTikuAdapterBaseUrl
} from '../projects/tiku-adapter-config.js';

export function optimizationElementWithImage(root: HTMLElement, cloneNode = false): HTMLElement {
  const clone = cloneNode ? (root.cloneNode(true) as HTMLElement) : root;
  const originals = Array.from(root.querySelectorAll('img'));
  // Repeated extraction must not accumulate generated image evidence.
  for (const previous of Array.from(clone.querySelectorAll('[data-cx-image-reference]'))) {
    previous.remove();
  }
  for (const [index, img] of Array.from(clone.querySelectorAll('img')).entries()) {
    const original = originals[index];
    let source = '';
    for (const candidate of [img.getAttribute('data-original'), img.getAttribute('data-src'), original?.currentSrc, img.getAttribute('src')]) {
      if (!candidate?.trim()) continue;
      try {
        const url = new URL(candidate.trim(), img.ownerDocument.baseURI);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          source = url.href;
          break;
        }
      } catch { /* Ignore malformed image sources; retain any alt transcription. */ }
    }
    const evidence = [img.getAttribute('alt')?.trim(), source].filter(Boolean).join(' ');
    if (!evidence) continue;
    const src = img.ownerDocument.createElement('span');
    src.setAttribute('data-cx-image-reference', '');
    src.textContent = ` ${evidence} `;
    src.style.fontSize = '0px';
    img.after(src);
  }
  return clone;
}

export function inferQuestionTypeFromOptionElements(options: HTMLElement[]) {
  const text = options.map((option) => String(option.innerText ?? option.textContent ?? '').replace(/\s+/gu, ' ').trim().toLowerCase());
  const controlScopes = options.map((option) => option.closest('.answerBg, li') ?? option);
  const controls = controlScopes.flatMap((scope) => Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="radio"],input[type="checkbox"]')));
  if (controls.some((control) => control.type === 'checkbox')) return 'multiple' as const;
  if (options.some((option) => option.matches('textarea') || option.querySelector('textarea'))) return 'completion' as const;

  const radioCount = controls.filter((control) => control.type === 'radio').length;
  if (radioCount > 2) return 'single' as const;
  if (radioCount === 2 && text.length === 2) {
    const labels = new Set(text.map((item) => item.replace(/^[A-Da-d][.、:：)）]\s*/u, '').trim()));
    const judgementPairs = [['正确', '错误'], ['对', '错'], ['是', '否'], ['true', 'false']];
    if (judgementPairs.some((pair) => pair.every((label) => labels.has(label)))) return 'judgement' as const;
  }
  return undefined;
}

export function extractQuestionOptionTexts(options: HTMLElement[]) {
  return options.map((option) => {
    const labelScope = option.closest('.answerBg, li') ?? option;
    const visibleLabel = labelScope.querySelector<HTMLElement>('.num_option, .option-label, .optionLabel, .answer_num')?.innerText?.trim() ?? '';
    const contentRoot = option.querySelector<HTMLElement>('.answer_p, .after') ?? option;
    const content = optimizationElementWithImage(contentRoot, true).innerText.trim();
    const text = visibleLabel && content.startsWith(visibleLabel) ? content : [visibleLabel, content].filter(Boolean).join(' ');
    return text.trim();
  });
}

export function extractQuestionImageEvidence(
  stemRoots: Array<HTMLElement | undefined>,
  optionRoots: Array<HTMLElement | undefined>
): QuestionEvidence {
  const collect = (roots: Array<HTMLElement | undefined>): QuestionImageEvidence[] => {
    const evidence: QuestionImageEvidence[] = [];
    let imageIndex = 0;
    for (const root of roots) {
      if (!root) continue;
      const images = root.matches('img') ? [root as HTMLImageElement] : Array.from(root.querySelectorAll('img'));
      for (const img of images) {
        let url = '';
        for (const candidate of [img.getAttribute('data-original'), img.getAttribute('data-src'), img.currentSrc, img.getAttribute('src')]) {
          if (!candidate?.trim()) continue;
          try {
            const parsed = new URL(candidate.trim(), img.ownerDocument.baseURI);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
              url = parsed.href;
              break;
            }
          } catch { /* Keep an alt-only image as useful evidence. */ }
        }
        const alt = img.getAttribute('alt')?.trim() ?? '';
        if (url || alt) evidence.push({ url, alt, index: imageIndex });
        imageIndex++;
      }
    }
    return evidence;
  };

  return { stemImages: collect(stemRoots), optionImages: collect(optionRoots) };
}

export function extractExplicitCorrectAnswerEvidence(root: HTMLElement | null | undefined) {
  if (!root) return undefined;
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('.rightAnswerContent'));
  const answers: string[] = [];
  const texts: string[] = [];
  for (const node of nodes) {
    let current: HTMLElement | null = node;
    let visible = true;
    while (current) {
      const style = current.ownerDocument.defaultView?.getComputedStyle(current);
      if (current.hidden || current.getAttribute('aria-hidden') === 'true' || current.classList.contains('element-invisible-hidden') || current.classList.contains('sr-only') || style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0') {
        visible = false;
        break;
      }
      current = current.parentElement;
    }
    if (!visible || node.getClientRects().length === 0) continue;

    const text = optimizationElementWithImage(node, true).innerText.replace(/\s+/gu, ' ').trim();
    if (/^(?:我的答案|你的答案|学生答案)\s*[:：]/u.test(text)) continue;
    const answer = text.replace(/^(?:正确答案|标准答案|参考答案)\s*[:：]\s*/u, '').trim();
    if (answer) {
      answers.push(answer);
      texts.push(text);
    }
  }
  return answers.length > 0 ? { label: 'rightAnswerContent', answer: answers.join('#'), text: texts.join('\n') } : undefined;
}

export function removeRedundantWords(text: string, words: string[]): string {
  return words.filter(Boolean).reduce((acc, word) => acc.split(word.trim()).join(''), text);
}

export function splitAnswer(answer: string): string[] {
  return answer.split(/[#,，;；\n]/).map((item) => item.trim()).filter(Boolean);
}

export function simplifyWorkResult<T extends { ctx?: any; error?: string; requested: boolean; searching?: boolean; resolved: boolean; result?: { finish?: boolean } }>(
  results: T[],
  titleTransform?: (titles: (HTMLElement | undefined)[]) => string
): SimplifyWorkResult[] {
  return results.map((item) => ({
    question: titleTransform?.(item.ctx?.elements?.title ?? []) ?? '',
    type: item.ctx?.type,
    ...(item.ctx?.searchIdentity ? { searchIdentity: item.ctx.searchIdentity } : {}),
    error: item.error,
    finish: item.result?.finish,
    requested: item.requested,
    searching: item.searching,
    resolved: item.resolved,
    searchInfos: (item.ctx?.searchInfos ?? []).map((info: any) => ({
      name: info.name,
      homepage: info.homepage,
      error: info.error,
      results: (info.results ?? []).map((result: any) => [result.question, result.answer, result.extra_data ?? {}])
    }))
  }));
}

function getTikuAdapterWarningState() {
  const storedBaseurl = runtimeStore.get(TIKU_ADAPTER_BASEURL_KEY, DEFAULT_TIKU_BASE_URL);
  const storedKey = runtimeStore.get(TIKU_ADAPTER_KEY_KEY, '');

  const baseurl = resolveTikuAdapterBaseUrl(typeof storedBaseurl === 'string' ? storedBaseurl : '', DEFAULT_TIKU_BASE_URL);
  const key = typeof storedKey === 'string' ? storedKey.trim() : '';
  const problem = getTikuAdapterConfigProblem({ baseurl, key });

  if (problem === 'missing-key') {
    return {
      message: '请先填写题库 key。',
      problem,
      baseurl
    };
  }

  if (problem === 'missing-baseurl' || problem === 'invalid-baseurl') {
    return {
      message: '请先填写正确的题库 baseurl。',
      problem,
      baseurl
    };
  }

  return {
    message: '当前未配置题库',
    problem,
    baseurl
  };
}

export function answerWrapperEmptyWarning(_duration: number) {
  const { message, problem, baseurl } = getTikuAdapterWarningState();
  console.warn(`[chaoxing-plus] ${message}`);
  void $modal.alert({
    content: message,
    denyButtonText: problem === 'missing-key' ? '跳转' : undefined,
    onDeny: async () => {
      if (!baseurl) {
        return;
      }

      window.open(baseurl, '_blank', 'noopener,noreferrer');
    }
  });
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
