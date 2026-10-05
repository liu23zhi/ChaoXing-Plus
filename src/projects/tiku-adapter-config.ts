/// <reference path="../types.d.ts" />
import { type SearchInformation } from '../core/index.js';
import type { AnswererWrapper } from '../core/answer-wrapper/interface.js';

export const TIKU_ADAPTER_BASEURL_KEY = 'common.settings.tiku-adapter.baseurl';
export const TIKU_ADAPTER_KEY_KEY = 'common.settings.tiku-adapter.key';
export const TIKU_ADAPTER_SEARCH_TIMEOUT_SECONDS = 240;
export const TIKU_ADAPTER_AI_FALLBACK_REQUEST_TIMEOUT_MS = 180000;
export const TIKU_ADAPTER_AI_FALLBACK_STATUS_TIMEOUT_MS = 300000;
export const TIKU_ADAPTER_AI_FALLBACK_STATUS_POLL_INTERVAL_MS = 2500;
export const TIKU_ADAPTER_AI_FALLBACK_RETRY_ATTEMPTS = 3;
export const TIKU_ADAPTER_AI_FALLBACK_RETRY_DELAY_MS = 2000;
export const TIKU_ADAPTER_AI_FALLBACK_WORKER_TIMEOUT_SECONDS = 600;

export type TikuAdapterConfigProblem = 'missing-baseurl' | 'invalid-baseurl' | 'missing-key';

export type TikuAdapterAIFallbackErrorCode = 'AI_UNAVAILABLE' | 'NO_ANSWER' | 'UPSTREAM_ERROR' | 'INVALID_INPUT' | 'UNSAFE_TO_ANSWER';

export type TikuAdapterAIFallbackResult = {
  success: boolean;
  status?: string;
  taskId?: string;
  statusUrl?: string;
  result?: {
    question?: string;
    answer?: string;
  };
  error?: {
    code?: TikuAdapterAIFallbackErrorCode;
    message?: string;
  };
};

export type TikuAdapterAIFallbackResponse = SearchInformation & {
  error?: string;
  response?: TikuAdapterAIFallbackResult;
};

export type TikuAdapterConfig = {
  baseurl: string;
  key: string;
};

export type TikuAdapterAIFallbackRequestOptions = {
  requestTimeoutMs?: number;
  statusTimeoutMs?: number;
  pollIntervalMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  preferAsyncTask?: boolean;
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

export function createTikuAdapterAIFallbackUrl(baseurl: string): string {
  const normalized = resolveTikuAdapterBaseUrl(baseurl);
  return normalized ? `${normalized}/adapter-service/ai-fallback` : '';
}

export function createTikuAdapterAIFallbackTaskUrl(baseurl: string): string {
  const normalized = resolveTikuAdapterBaseUrl(baseurl);
  return normalized ? `${normalized}/adapter-service/ai-fallback/tasks` : '';
}

export function createTikuAdapterAIFallbackStatusUrl(baseurl: string, taskId: string): string {
  const normalized = resolveTikuAdapterBaseUrl(baseurl);
  if (!normalized) {
    return '';
  }
  const url = new URL(`${normalized}/adapter-service/ai-fallback/status`);
  url.searchParams.set('taskId', String(taskId ?? '').trim());
  return url.toString();
}

export function createTikuAdapterAuthorizationHeader(key: string): string {
  return `Bearer ${String(key ?? '').trim()}`;
}

export async function requestTikuAdapterAIFallback(config: TikuAdapterConfig, payload: {
  title: string;
  type?: string;
  options?: string;
}, options: TikuAdapterAIFallbackRequestOptions = {}): Promise<TikuAdapterAIFallbackResponse[]> {
  const baseurl = resolveTikuAdapterBaseUrl(config.baseurl);
  const key = String(config.key ?? '').trim();
  const problem = getTikuAdapterConfigProblem({ baseurl, key });

  if (problem) {
    throw new Error(problem);
  }

  const requestOptions = normalizeAIFallbackRequestOptions(options);
  const requestPayload = buildTikuAdapterAIFallbackPayload(payload);
  const response = await resolveTikuAdapterAIFallbackResponse(baseurl, key, requestPayload, requestOptions);

  const question = String(response?.result?.question ?? payload.title ?? '').trim();
  const answer = String(response?.result?.answer ?? '').trim();
  const errorCode = response?.error?.code;
  const errorMessage = String(response?.error?.message ?? '').trim();

  return [
    {
      name: 'Zelly的题库 AI Fallback',
      homepage: baseurl,
      results: response?.success && answer
        ? [
            {
              question,
              answer,
              extra_data: { ai: true }
            }
          ]
        : [],
      response,
      data: payload,
      error: response?.success ? undefined : `${errorCode || 'UPSTREAM_ERROR'}${errorMessage ? `: ${errorMessage}` : ''}`
    }
  ];
}

function buildTikuAdapterAIFallbackPayload(payload: {
  title: string;
  type?: string;
  options?: string;
}) {
  return {
    question: String(payload.title ?? '').trim(),
    type: resolveTikuAdapterQuestionType(payload.type),
    options: String(payload.options ?? '')
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean)
  };
}

function normalizeAIFallbackRequestOptions(options: TikuAdapterAIFallbackRequestOptions) {
  return {
    requestTimeoutMs: normalizePositiveInteger(options.requestTimeoutMs, TIKU_ADAPTER_AI_FALLBACK_REQUEST_TIMEOUT_MS),
    statusTimeoutMs: normalizePositiveInteger(options.statusTimeoutMs, TIKU_ADAPTER_AI_FALLBACK_STATUS_TIMEOUT_MS),
    pollIntervalMs: normalizePositiveInteger(options.pollIntervalMs, TIKU_ADAPTER_AI_FALLBACK_STATUS_POLL_INTERVAL_MS),
    retryAttempts: normalizePositiveInteger(options.retryAttempts, TIKU_ADAPTER_AI_FALLBACK_RETRY_ATTEMPTS),
    retryDelayMs: Math.max(0, Math.floor(options.retryDelayMs ?? TIKU_ADAPTER_AI_FALLBACK_RETRY_DELAY_MS)),
    preferAsyncTask: options.preferAsyncTask ?? true
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function resolveTikuAdapterAIFallbackResponse(
  baseurl: string,
  key: string,
  payload: ReturnType<typeof buildTikuAdapterAIFallbackPayload>,
  options: ReturnType<typeof normalizeAIFallbackRequestOptions>
): Promise<TikuAdapterAIFallbackResult> {
  if (options.preferAsyncTask) {
    try {
      const taskResponse = await requestTikuAdapterJSON<TikuAdapterAIFallbackResult>(createTikuAdapterAIFallbackTaskUrl(baseurl), key, {
        method: 'POST',
        data: payload,
        timeoutMs: options.requestTimeoutMs,
        retryAttempts: 1,
        retryDelayMs: 0
      });
      if (isAIFallbackPendingResponse(taskResponse)) {
        return pollTikuAdapterAIFallbackStatus(baseurl, key, taskResponse, options);
      }
      return taskResponse;
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
    }
  }

  const directResponse = await requestTikuAdapterJSON<TikuAdapterAIFallbackResult>(createTikuAdapterAIFallbackUrl(baseurl), key, {
    method: 'POST',
    data: payload,
    timeoutMs: options.requestTimeoutMs,
    retryAttempts: options.retryAttempts,
    retryDelayMs: options.retryDelayMs
  });

  if (isAIFallbackPendingResponse(directResponse)) {
    return pollTikuAdapterAIFallbackStatus(baseurl, key, directResponse, options);
  }
  return directResponse;
}

async function pollTikuAdapterAIFallbackStatus(
  baseurl: string,
  key: string,
  initialResponse: TikuAdapterAIFallbackResult,
  options: ReturnType<typeof normalizeAIFallbackRequestOptions>
): Promise<TikuAdapterAIFallbackResult> {
  const taskId = String(initialResponse.taskId ?? '').trim();
  const statusUrl = resolveAIFallbackStatusUrl(baseurl, initialResponse);
  if (!statusUrl) {
    return initialResponse;
  }

  const startedAt = Date.now();
  let latestResponse = initialResponse;
  while (Date.now() - startedAt < options.statusTimeoutMs) {
    await sleepAIFallback(options.pollIntervalMs);
    latestResponse = await requestTikuAdapterJSON<TikuAdapterAIFallbackResult>(statusUrl, key, {
      method: 'GET',
      timeoutMs: Math.min(options.requestTimeoutMs, Math.max(options.pollIntervalMs * 2, 1000)),
      retryAttempts: options.retryAttempts,
      retryDelayMs: options.retryDelayMs
    });

    if (!isAIFallbackPendingResponse(latestResponse)) {
      return latestResponse;
    }
  }

  return {
    success: false,
    status: 'timeout',
    taskId,
    error: {
      code: 'UPSTREAM_ERROR',
      message: `AI 搜题仍在处理中，等待状态超时（${Math.round(options.statusTimeoutMs / 1000)} 秒）`
    }
  };
}

function resolveAIFallbackStatusUrl(baseurl: string, response: TikuAdapterAIFallbackResult) {
  const statusUrl = String(response.statusUrl ?? '').trim();
  if (statusUrl) {
    try {
      return new URL(statusUrl, resolveTikuAdapterBaseUrl(baseurl) + '/').toString();
    } catch {
      return '';
    }
  }

  const taskId = String(response.taskId ?? '').trim();
  return taskId ? createTikuAdapterAIFallbackStatusUrl(baseurl, taskId) : '';
}

function isAIFallbackPendingResponse(response: TikuAdapterAIFallbackResult | undefined) {
  if (!response) {
    return false;
  }
  const status = String(response.status ?? '').trim().toLowerCase();
  return Boolean(response.taskId || response.statusUrl) && ['pending', 'running', 'processing', 'queued', 'created'].includes(status);
}

async function requestTikuAdapterJSON<T>(
  url: string,
  key: string,
  options: {
    method: 'GET' | 'POST';
    data?: Record<string, unknown>;
    timeoutMs: number;
    retryAttempts: number;
    retryDelayMs: number;
  }
): Promise<T> {
  let lastError: unknown;
  const maxAttempts = Math.max(1, options.retryAttempts);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          Authorization: createTikuAdapterAuthorizationHeader(key),
          ...(options.method === 'POST' ? { 'Content-Type': 'application/json' } : {})
        },
        body: options.method === 'POST' ? JSON.stringify(options.data ?? {}) : undefined,
        signal: controller.signal
      });
      if (!response.ok) {
        const message = await response.text();
        throw createHTTPError(response.status, message || `HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isRetryableTikuAdapterError(err)) {
        throw err;
      }
      await sleepAIFallback(options.retryDelayMs * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'tikuAdapter request failed'));
}

function createHTTPError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function isNotFoundError(err: unknown) {
  return Boolean(err && typeof err === 'object' && (err as { status?: number }).status === 404);
}

function isRetryableTikuAdapterError(err: unknown) {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  if (err && typeof err === 'object') {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number') {
      return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
    }
  }
  return err instanceof Error && /network|fetch|timeout|abort|failed/i.test(err.message);
}

async function sleepAIFallback(ms: number) {
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
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
    name: 'Zelly的题库',
    homepage: baseurl,
    method: 'post',
    contentType: 'json',
    type: 'fetch',
    headers: {
      Authorization: createTikuAdapterAuthorizationHeader(key)
    },
    timeoutSeconds: TIKU_ADAPTER_SEARCH_TIMEOUT_SECONDS,
    retry: {
      maxAttempts: TIKU_ADAPTER_AI_FALLBACK_RETRY_ATTEMPTS,
      delayMs: TIKU_ADAPTER_AI_FALLBACK_RETRY_DELAY_MS
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
      const isChoiceType = res?.type === 0 || res?.type === 1;
      const answerKeyText = typeof res?.answer?.answerKeyText === 'string' ? res.answer.answerKeyText.trim() : '';
      if (isChoiceType && answerKeyText) {
        return [question, answerKeyText, { source: 'tikuAdapter' }];
      }

      const answerIndex = Array.isArray(res?.answer?.answerIndex)
        ? res.answer.answerIndex.filter((item) => Number.isInteger(item) && item >= 0)
        : [];
      if (isChoiceType && answerIndex.length > 0) {
        return [question, answerIndex.map((index) => String.fromCharCode(index + 65)).join(''), { source: 'tikuAdapter' }];
      }

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
