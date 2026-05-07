/// <reference path="../types.d.ts" />
import type { AnswererWrapper } from '../core/answer-wrapper/interface.js';

export const TIKU_ADAPTER_BASEURL_KEY = 'common.settings.tiku-adapter.baseurl';
export const TIKU_ADAPTER_KEY_KEY = 'common.settings.tiku-adapter.key';

export type TikuAdapterConfigProblem = 'missing-baseurl' | 'invalid-baseurl' | 'missing-key';

export type TikuAdapterConfig = {
  baseurl: string;
  key: string;
};

export const DEFAULT_TIKU_BASE_URL = normalizeTikuAdapterBaseUrl(
  typeof __DEFAULT_TIKU_BASE_URL__ === 'string' ? __DEFAULT_TIKU_BASE_URL__ : ''
);

export function normalizeTikuAdapterBaseUrl(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\/+$/, '');
}

export function isValidTikuAdapterBaseUrl(raw: string): boolean {
  const normalized = normalizeTikuAdapterBaseUrl(raw);
  if (!normalized) {
    return false;
  }

  try {
    const url = new URL(normalized);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function resolveTikuAdapterBaseUrl(raw: string, fallback = DEFAULT_TIKU_BASE_URL): string {
  const preferred = normalizeTikuAdapterBaseUrl(raw);
  const fallbackValue = normalizeTikuAdapterBaseUrl(fallback);
  const candidate = preferred || fallbackValue;
  return isValidTikuAdapterBaseUrl(candidate) ? candidate : '';
}

export function createTikuAdapterSearchUrl(baseurl: string): string {
  const normalized = resolveTikuAdapterBaseUrl(baseurl);
  return normalized ? `${normalized}/adapter-service/search` : '';
}

export function createTikuAdapterAuthorizationHeader(key: string): string {
  return `Bearer ${String(key ?? '').trim()}`;
}

export function resolveTikuAdapterQuestionType(type: string | undefined): number {
  switch (type) {
    case 'single':
      return 0;
    case 'multiple':
      return 1;
    case 'judgement':
      return 3;
    case 'completion':
    case 'fill':
    case 'line':
      return 2;
    case 'reader':
    case 'unknown':
    default:
      return 4;
  }
}

export function getTikuAdapterConfigProblem(config: TikuAdapterConfig): TikuAdapterConfigProblem | undefined {
  const baseurl = normalizeTikuAdapterBaseUrl(config.baseurl);
  const key = String(config.key ?? '').trim();

  if (!baseurl) {
    return 'missing-baseurl';
  }

  if (!isValidTikuAdapterBaseUrl(baseurl)) {
    return 'invalid-baseurl';
  }

  if (!key) {
    return 'missing-key';
  }

  return undefined;
}

export function createTikuAdapterAnswererWrapper(config: TikuAdapterConfig): AnswererWrapper {
  const baseurl = resolveTikuAdapterBaseUrl(config.baseurl);
  const key = String(config.key ?? '').trim();
  const problem = getTikuAdapterConfigProblem({ baseurl, key });

  if (problem) {
    throw new Error(problem);
  }

  return {
    url: createTikuAdapterSearchUrl(baseurl),
    name: 'tikuAdapter',
    homepage: baseurl,
    method: 'post',
    contentType: 'json',
    type: 'fetch',
    headers: {
      Authorization: createTikuAdapterAuthorizationHeader(key)
    },
    data: {
      qid: '',
      plat: -1,
      question: {
        handler: `return (env) => String(env.title ?? '').trim()`
      },
      options: {
        handler: `return (env) => String(env.options ?? '').split(/\\n+/).map((item) => item.trim()).filter(Boolean)`
      },
      type: {
        handler: `return (env) => {
          const value = String(env.type ?? 'unknown');
          return value === 'single'
            ? 0
            : value === 'multiple'
              ? 1
              : value === 'judgement'
                ? 3
                : value === 'completion' || value === 'fill' || value === 'line'
                  ? 2
                  : 4;
        }`
      },
      courseName: '',
      extra: ''
    },
    handler: `return (res) => {
      const question = typeof res?.question === 'string' ? res.question : '';
      const answerText = typeof res?.answer?.answerText === 'string' ? res.answer.answerText.trim() : '';
      if (answerText) {
        return [question, answerText, { source: 'tikuAdapter' }];
      }

      const bestAnswer = Array.isArray(res?.answer?.bestAnswer)
        ? res.answer.bestAnswer.map((item) => String(item).trim()).filter(Boolean)
        : [];
      if (bestAnswer.length > 0) {
        return [question, bestAnswer.join('#'), { source: 'tikuAdapter' }];
      }

      const firstAllAnswer = Array.isArray(res?.answer?.allAnswer)
        ? res.answer.allAnswer.find((item) => Array.isArray(item) && item.map((value) => String(value).trim()).filter(Boolean).length > 0)
        : undefined;
      if (firstAllAnswer) {
        return [question, firstAllAnswer.join('#'), { source: 'tikuAdapter' }];
      }

      return undefined;
    }`
  };
}
