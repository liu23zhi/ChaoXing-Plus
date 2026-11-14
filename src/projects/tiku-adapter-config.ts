/// <reference path="../types.d.ts" />
import md5 from 'md5';
import { type SearchInformation, type QuestionEvidence } from '../core/index.js';
import type { AnswererWrapper } from '../core/answer-wrapper/interface.js';
import { pollTikuAdapterSearchTask, pollTikuAdapterTask, type TikuAdapterTaskEnvelope } from '../core/answer-wrapper/task-poller.js';
import {
  createTikuAdapterRequestError,
  claimTikuAdapterBalanceNotice as claimBalanceNotice,
  isTikuAdapterBalanceBlocked,
  isTikuAdapterInsufficientBalance,
  isTikuAdapterQuotaExceeded,
  markTikuAdapterBalanceBlocked,
  resolveTikuAdapterRequestIdentity,
  resetTikuAdapterBalanceGuard as resetBalanceGuard,
  TIKU_ADAPTER_BALANCE_FAILURE_MESSAGE,
  TIKU_ADAPTER_QUOTA_FAILURE_MESSAGE,
  TIKU_ADAPTER_UPSTREAM_FAILURE_MESSAGE
} from '../core/utils/tiku-adapter-error.js';

export const TIKU_ADAPTER_BASEURL_KEY = 'common.settings.tiku-adapter.baseurl';
export const TIKU_ADAPTER_KEY_KEY = 'common.settings.tiku-adapter.key';
export const TIKU_ADAPTER_SEARCH_TIMEOUT_SECONDS = 240;
export const TIKU_ADAPTER_SEARCH_TASK_CREATE_TIMEOUT_MS = 10000;
export const TIKU_ADAPTER_SEARCH_TASK_TIMEOUT_MS = 600000;
export const TIKU_ADAPTER_SEARCH_HEALTH_TIMEOUT_MS = 3000;
export const TIKU_ADAPTER_SEARCH_HEALTH_DELAY_MS = 1000;
export const TIKU_ADAPTER_AI_FALLBACK_REQUEST_TIMEOUT_MS = 180000;
export const TIKU_ADAPTER_AI_FALLBACK_STATUS_TIMEOUT_MS = 600000;
export const TIKU_ADAPTER_AI_FALLBACK_STATUS_POLL_INTERVAL_MS = 2500;
export const TIKU_ADAPTER_AI_FALLBACK_RETRY_ATTEMPTS = 3;
export const TIKU_ADAPTER_AI_FALLBACK_RETRY_DELAY_MS = 500;
export const TIKU_ADAPTER_AI_FALLBACK_WORKER_TIMEOUT_SECONDS = 1260;

export type TikuAdapterConfigProblem = 'missing-baseurl' | 'invalid-baseurl' | 'missing-key';

export type TikuAdapterAIFallbackErrorCode = 'AI_UNAVAILABLE' | 'NO_ANSWER' | 'UPSTREAM_ERROR' | 'INVALID_INPUT' | 'UNSAFE_TO_ANSWER' | 'INSUFFICIENT_BALANCE' | 'ACCESS_TOKEN_QUOTA_EXCEEDED';

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
  /**
   * 服务端的非阻断提示，例如「AI 正在使用未配置价格的模型」。
   * 只用于管理员排查（调试日志面板），绝不出现在面向普通用户的界面里。
   */
  warnings?: string[];
};

export type TikuAdapterAIFallbackResponse = SearchInformation & {
  error?: string;
  response?: TikuAdapterAIFallbackResult;
};

export type TikuAdapterConfig = {
  baseurl: string;
  key: string;
  asyncSearch?: boolean;
  /** Present only for a short-lived Windows script run session. */
  scriptIdentity?: string;
};

export type TikuAdapterSearchTaskOptions = {
  requestTimeoutMs?: number;
  statusTimeoutMs?: number;
  pollIntervalMs?: number;
  maxConsecutiveFailures?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  idempotencyKey?: string;
  healthProbeTimeoutMs?: number;
  healthProbeDelayMs?: number;
};

export type TikuAdapterAIFallbackRequestOptions = {
  requestTimeoutMs?: number;
  statusTimeoutMs?: number;
  pollIntervalMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  preferAsyncTask?: boolean;
  idempotencyKey?: string;
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
  return normalized ? `${normalized}/api/search` : '';
}

export function createTikuAdapterSearchTaskUrl(baseurl: string): string {
  const normalized = resolveTikuAdapterBaseUrl(baseurl);
  return normalized ? `${normalized}/api/search/tasks` : '';
}

export function createTikuAdapterSearchHealthUrl(baseurl: string): string {
  const normalized = resolveTikuAdapterBaseUrl(baseurl);
  return normalized ? `${normalized}/api/search/health` : '';
}

export function createTikuAdapterSearchStatusUrl(baseurl: string, taskId: string): string {
  const normalized = resolveTikuAdapterBaseUrl(baseurl);
  if (!normalized) {
    return '';
  }
  const url = new URL(`${normalized}/api/search/status`);
  url.searchParams.set('taskId', String(taskId ?? '').trim());
  return url.toString();
}

export function createTikuAdapterEvidenceUrl(baseurl: string): string {
  const normalized = resolveTikuAdapterBaseUrl(baseurl);
  return normalized ? `${normalized}/api/tiku/evidence` : '';
}

export type TikuAdapterAnswerEvidencePayload = {
  qid: string;
  question: string;
  options: string[];
  type: number;
  courseName: string;
  answer: string;
  source: string;
  evidence: Record<string, unknown>;
};

export async function requestTikuAdapterAnswerEvidence(
  config: TikuAdapterConfig,
  payload: TikuAdapterAnswerEvidencePayload,
  options: { requestTimeoutMs?: number; idempotencyKey?: string } = {}
) {
  const baseurl = resolveTikuAdapterBaseUrl(config.baseurl);
  const key = String(config.key ?? '').trim();
  const scriptIdentity = String(config.scriptIdentity ?? '').trim();
  const problem = getTikuAdapterConfigProblem({ baseurl, key });
  if (problem) throw new Error(problem);

  const body = normalizeTikuAdapterAnswerEvidencePayload(payload);
  const idempotencyKey = String(options.idempotencyKey ?? createStableEvidenceIdempotencyKey(body));
  const timeoutMs = normalizePositiveInteger(options.requestTimeoutMs, 10000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(createTikuAdapterEvidenceUrl(baseurl), {
      method: 'POST',
      headers: {
        Authorization: createTikuAdapterAuthorizationHeader(key),
        ...(scriptIdentity ? { 'X-Script-Identity': scriptIdentity } : {}),
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const responseText = await response.text();
    let responseBody: unknown = {};
    try { responseBody = responseText ? JSON.parse(responseText) : {}; } catch { responseBody = { message: responseText }; }
    if (!response.ok) throw createTikuAdapterRequestError(responseBody, response.status);
    return responseBody as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeTikuAdapterAnswerEvidencePayload(payload: TikuAdapterAnswerEvidencePayload): TikuAdapterAnswerEvidencePayload {
  return {
    qid: String(payload.qid ?? '').trim(),
    question: String(payload.question ?? '').trim(),
    options: Array.isArray(payload.options) ? payload.options.map((item) => String(item ?? '')) : [],
    type: Number.isInteger(payload.type) ? payload.type : -1,
    courseName: String(payload.courseName ?? '').trim(),
    answer: String(payload.answer ?? '').trim(),
    source: String(payload.source ?? '').trim(),
    evidence: payload.evidence && typeof payload.evidence === 'object' ? payload.evidence : {}
  };
}

function createStableEvidenceIdempotencyKey(payload: TikuAdapterAnswerEvidencePayload) {
  return `chaoxing-evidence-${md5(JSON.stringify(payload))}`;
}

export function createTikuAdapterAIFallbackUrl(baseurl: string): string {
  const normalized = resolveTikuAdapterBaseUrl(baseurl);
  return normalized ? `${normalized}/api/ai-fallback` : '';
}

export function createTikuAdapterAIFallbackTaskUrl(baseurl: string): string {
  const normalized = resolveTikuAdapterBaseUrl(baseurl);
  return normalized ? `${normalized}/api/ai-fallback/tasks` : '';
}

export function createTikuAdapterAIFallbackStatusUrl(baseurl: string, taskId: string): string {
  const normalized = resolveTikuAdapterBaseUrl(baseurl);
  if (!normalized) {
    return '';
  }
  const url = new URL(`${normalized}/api/ai-fallback/status`);
  url.searchParams.set('taskId', String(taskId ?? '').trim());
  return url.toString();
}

export async function requestTikuAdapterSearchTask(
  config: TikuAdapterConfig,
  payload: Record<string, unknown>,
  options: TikuAdapterSearchTaskOptions = {}
): Promise<unknown> {
  const baseurl = resolveTikuAdapterBaseUrl(config.baseurl);
  const key = String(config.key ?? '').trim();
  const scriptIdentity = String(config.scriptIdentity ?? '').trim();
  const problem = getTikuAdapterConfigProblem({ baseurl, key });
  if (problem) throw new Error(problem);

  const phaseStartedAt = Date.now();
  const phaseDeadlineAt = phaseStartedAt + normalizePositiveInteger(options.statusTimeoutMs, TIKU_ADAPTER_SEARCH_TASK_TIMEOUT_MS);
  const requestTimeoutMs = normalizePositiveInteger(
    options.requestTimeoutMs,
    TIKU_ADAPTER_SEARCH_TASK_CREATE_TIMEOUT_MS
  );
  const taskCreateTimeoutMs = Math.min(requestTimeoutMs, TIKU_ADAPTER_SEARCH_TASK_CREATE_TIMEOUT_MS);
  const retryAttempts = normalizePositiveInteger(options.retryAttempts, TIKU_ADAPTER_AI_FALLBACK_RETRY_ATTEMPTS);
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? TIKU_ADAPTER_AI_FALLBACK_RETRY_DELAY_MS));
  const idempotencyKey = String(options.idempotencyKey ?? createTikuAdapterIdempotencyKey()).trim();
  const syncSearch = () => requestTikuAdapterLegacySearch(baseurl, key, payload, {
    requestTimeoutMs,
    retryAttempts,
    retryDelayMs,
    deadlineAt: phaseDeadlineAt,
    idempotencyKey,
    scriptIdentity
  });
  try {
    await probeTikuAdapterSearchHealth(baseurl, key, phaseDeadlineAt, options, scriptIdentity);
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    return syncSearch();
  }

  let initial: TikuAdapterTaskEnvelope<Record<string, unknown>>;
  try {
    initial = await requestTikuAdapterJSON<TikuAdapterTaskEnvelope<Record<string, unknown>>>(
      createTikuAdapterSearchTaskUrl(baseurl),
      key,
      {
        method: 'POST',
        data: payload,
        timeoutMs: taskCreateTimeoutMs,
        deadlineAt: phaseDeadlineAt,
        retryAttempts,
        retryDelayMs,
        extraHeaders: { 'Idempotency-Key': idempotencyKey },
        scriptIdentity
      }
    );
  } catch (error) {
    if (getHTTPStatus(error) === 404) return syncSearch();
    throw error;
  }

  if (String(initial.status ?? '').toLowerCase() === 'succeeded' && initial.result !== undefined) {
    return initial.result;
  }
  if (!initial.taskId && initial.result !== undefined) {
    return initial.result;
  }

  try {
    return await pollTikuAdapterSearchTask(initial, {
      statusUrlBase: createTikuAdapterSearchStatusUrl(baseurl, ''),
      pollIntervalMs: options.pollIntervalMs ?? TIKU_ADAPTER_AI_FALLBACK_STATUS_POLL_INTERVAL_MS,
      timeoutMs: Math.max(1, phaseDeadlineAt - Date.now()),
      maxConsecutiveFailures: options.maxConsecutiveFailures ?? TIKU_ADAPTER_AI_FALLBACK_RETRY_ATTEMPTS,
      getStatus: (statusUrl, _taskId, remainingMs) => requestTikuAdapterJSON<TikuAdapterTaskEnvelope<Record<string, unknown>>>(statusUrl, key, {
        method: 'GET',
        timeoutMs: Math.min(taskCreateTimeoutMs, 10000, remainingMs),
        retryAttempts: 1,
        retryDelayMs: 0,
        balanceScopeBaseurl: baseurl,
        deferBalanceBlockUntilPollingCompletes: true,
        scriptIdentity
      })
    });
  } catch (error) {
    if (isInsufficientBalancePollingError(error)) {
      markTikuAdapterBalanceBlocked(baseurl, key);
      throw createTikuAdapterRequestError({ code: 'INSUFFICIENT_BALANCE' });
    }
    if (isTikuAdapterQuotaExceeded(error)) {
      throw createTikuAdapterRequestError({ code: 'ACCESS_TOKEN_QUOTA_EXCEEDED' });
    }
    throw error;
  }
}

async function probeTikuAdapterSearchHealth(
  baseurl: string,
  key: string,
  phaseDeadlineAt: number,
  options: TikuAdapterSearchTaskOptions,
  scriptIdentity = ''
) {
  const probeTimeoutMs = normalizePositiveInteger(options.healthProbeTimeoutMs, TIKU_ADAPTER_SEARCH_HEALTH_TIMEOUT_MS);
  const probeDelayMs = Math.max(0, Math.floor(options.healthProbeDelayMs ?? TIKU_ADAPTER_SEARCH_HEALTH_DELAY_MS));
  let lastError: unknown;
  for (let attempt = 1; attempt <= TIKU_ADAPTER_AI_FALLBACK_RETRY_ATTEMPTS; attempt++) {
    const roundDeadlineAt = Math.min(phaseDeadlineAt, Date.now() + probeTimeoutMs);
    try {
      const probe = await requestTikuAdapterJSON<TikuAdapterTaskEnvelope>(createTikuAdapterSearchHealthUrl(baseurl), key, {
        method: 'GET', timeoutMs: probeTimeoutMs, deadlineAt: roundDeadlineAt,
        retryAttempts: 1, retryDelayMs: 0, scriptIdentity
      });
      const taskId = String(probe?.taskId ?? '').trim();
      const status = String(probe?.status ?? '').trim().toLowerCase();
      const statusUrl = String(probe?.statusUrl ?? '').trim();
      if (probe?.success !== true || status !== 'succeeded' || !taskId || !statusUrl) {
        throw new Error('invalid async search health response');
      }
      const statusResponse = await requestTikuAdapterJSON<TikuAdapterTaskEnvelope>(
        new URL(statusUrl, `${baseurl}/`).toString(), key, {
          method: 'GET', timeoutMs: probeTimeoutMs, deadlineAt: roundDeadlineAt,
          retryAttempts: 1, retryDelayMs: 0, balanceScopeBaseurl: baseurl, scriptIdentity
        }
      );
      const result = statusResponse?.result;
      if (statusResponse?.success !== true || String(statusResponse.status ?? '').trim().toLowerCase() !== 'succeeded'
        || String(statusResponse.taskId ?? '').trim() !== taskId
        || !result || typeof result !== 'object' || !('answer' in result)
        || !result.answer || typeof result.answer !== 'object') {
        throw new Error('async search status health check failed');
      }
      return;
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      lastError = error;
      if (attempt >= TIKU_ADAPTER_AI_FALLBACK_RETRY_ATTEMPTS || Date.now() >= phaseDeadlineAt) break;
      const retryAfterMs = getHTTPStatus(error) === 429 && error && typeof error === 'object'
        ? (error as { retryAfterMs?: number }).retryAfterMs : undefined;
      await sleepAIFallback(Math.min(
        Math.max(probeDelayMs, retryAfterMs ?? 0),
        Math.max(0, phaseDeadlineAt - Date.now())
      ));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('async search health check failed');
}

function requestTikuAdapterLegacySearch(
  baseurl: string,
  key: string,
  payload: Record<string, unknown>,
  options: { requestTimeoutMs: number; retryAttempts: number; retryDelayMs: number; deadlineAt?: number; idempotencyKey?: string; scriptIdentity?: string }
) {
  return requestTikuAdapterJSON<Record<string, unknown>>(createTikuAdapterSearchUrl(baseurl), key, {
    method: 'POST', data: payload, timeoutMs: options.requestTimeoutMs,
    deadlineAt: options.deadlineAt, retryAttempts: options.retryAttempts,
    retryDelayMs: options.retryDelayMs,
    extraHeaders: { 'Idempotency-Key': options.idempotencyKey ?? createTikuAdapterIdempotencyKey() },
    scriptIdentity: options.scriptIdentity
  });
}

function getHTTPStatus(error: unknown) {
  return error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
}

function isAuthenticationError(error: unknown) {
  return getHTTPStatus(error) === 401 || getHTTPStatus(error) === 403;
}

function notifyScriptSessionExpired() {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('chaoxing-plus:script-session-expired'));
    }
  } catch {
    // The host still receives the HTTP error; event delivery is best effort.
  }
}

export function createTikuAdapterAuthorizationHeader(key: string): string {
  return `Bearer ${String(key ?? '').trim()}`;
}

export async function requestTikuAdapterAIFallback(config: TikuAdapterConfig, payload: {
  title: string;
  type?: string;
  options?: string;
  deepThinking?: boolean;
  questionEvidence?: QuestionEvidence;
}, options: TikuAdapterAIFallbackRequestOptions = {}): Promise<TikuAdapterAIFallbackResponse[]> {
  const baseurl = resolveTikuAdapterBaseUrl(config.baseurl);
  const key = String(config.key ?? '').trim();
  const scriptIdentity = String(config.scriptIdentity ?? '').trim();
  const problem = getTikuAdapterConfigProblem({ baseurl, key });

  if (problem) {
    throw new Error(problem);
  }

  if (!scriptIdentity && isTikuAdapterBalanceBlocked(baseurl, key)) {
    throw createTikuAdapterRequestError({ code: 'INSUFFICIENT_BALANCE' });
  }

  const requestOptions = normalizeAIFallbackRequestOptions(options);
  const requestPayload = buildTikuAdapterAIFallbackPayload(payload);
  let rawResponse: TikuAdapterAIFallbackResult;
  try {
    rawResponse = await resolveTikuAdapterAIFallbackResponse(baseurl, key, requestPayload, requestOptions, scriptIdentity);
  } catch (err) {
    const requestError = err instanceof Error && (err as { isTikuAdapterRequestError?: boolean }).isTikuAdapterRequestError
      ? err as Error & { code: 'INSUFFICIENT_BALANCE' | 'ACCESS_TOKEN_QUOTA_EXCEEDED' | 'UPSTREAM_ERROR'; status?: number }
      : createTikuAdapterRequestError(err);
    if (requestError.code === 'INSUFFICIENT_BALANCE' && !scriptIdentity) {
      markTikuAdapterBalanceBlocked(baseurl, key);
    }
    rawResponse = { success: false, error: { code: requestError.code, message: requestError.message } };
  }
  if (isTikuAdapterInsufficientBalance(rawResponse) && !scriptIdentity) {
    markTikuAdapterBalanceBlocked(baseurl, key);
  }
  const response = sanitizeAIFallbackResponse(rawResponse);

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

export function resetTikuAdapterBalanceGuard(config: TikuAdapterConfig) {
  resetBalanceGuard(resolveTikuAdapterBaseUrl(config.baseurl), String(config.key ?? '').trim());
}

export function claimTikuAdapterBalanceNotice(config: TikuAdapterConfig) {
  const identity = { baseurl: resolveTikuAdapterBaseUrl(config.baseurl), key: String(config.key ?? '').trim() };
  return claimBalanceNotice(identity.baseurl, identity.key);
}

function sanitizeAIFallbackResponse(response: TikuAdapterAIFallbackResult): TikuAdapterAIFallbackResult {
  const error = response?.error;
  if (!error && response?.success) {
    return {
      success: true,
      ...(response.status ? { status: response.status } : {}),
      ...(response.taskId ? { taskId: response.taskId } : {}),
      ...(response.statusUrl ? { statusUrl: response.statusUrl } : {}),
      ...(response.result ? { result: { question: response.result.question, answer: response.result.answer } } : {}),
      ...(Array.isArray(response.warnings) ? { warnings: response.warnings.map(String) } : {})
    };
  }

  const code = error?.code === 'INSUFFICIENT_BALANCE' || error?.code === 'ACCESS_TOKEN_QUOTA_EXCEEDED' || error?.code === 'AI_UNAVAILABLE' || error?.code === 'NO_ANSWER' || error?.code === 'INVALID_INPUT' || error?.code === 'UNSAFE_TO_ANSWER'
    ? error.code
    : 'UPSTREAM_ERROR';
  const message = code === 'INSUFFICIENT_BALANCE'
    ? TIKU_ADAPTER_BALANCE_FAILURE_MESSAGE
    : code === 'ACCESS_TOKEN_QUOTA_EXCEEDED'
      ? TIKU_ADAPTER_QUOTA_FAILURE_MESSAGE
      : code === 'NO_ANSWER'
      ? 'AI 兜底未返回可用答案。'
      : code === 'AI_UNAVAILABLE'
        ? 'AI 兜底暂不可用，请联系管理员。'
        : code === 'UNSAFE_TO_ANSWER'
          ? 'AI 未能安全确认答案。'
          : code === 'INVALID_INPUT'
            ? '题目数据无效，搜题失败。'
            : TIKU_ADAPTER_UPSTREAM_FAILURE_MESSAGE;

  return {
    success: false,
    ...(response.status ? { status: response.status } : {}),
    ...(response.taskId ? { taskId: response.taskId } : {}),
    ...(response.statusUrl ? { statusUrl: response.statusUrl } : {}),
    ...(Array.isArray(response.warnings) ? { warnings: response.warnings.map(String) } : {}),
    error: { code, message }
  };
}

function buildTikuAdapterAIFallbackPayload(payload: {
  title: string;
  type?: string;
  options?: string;
  deepThinking?: boolean;
  questionEvidence?: QuestionEvidence;
}) {
  return {
    question: String(payload.title ?? '').trim(),
    type: resolveTikuAdapterQuestionType(payload.type),
    options: String(payload.options ?? '')
      .split(/\n+/)
      .map((item) => item.trim())
      .filter(Boolean),
    ...(payload.deepThinking === true ? { deepThinking: true } : {}),
    ...(payload.questionEvidence ? { questionEvidence: payload.questionEvidence } : {})
  };
}

function normalizeAIFallbackRequestOptions(options: TikuAdapterAIFallbackRequestOptions) {
  return {
    requestTimeoutMs: normalizePositiveInteger(options.requestTimeoutMs, TIKU_ADAPTER_AI_FALLBACK_REQUEST_TIMEOUT_MS),
    statusTimeoutMs: normalizePositiveInteger(options.statusTimeoutMs, TIKU_ADAPTER_AI_FALLBACK_STATUS_TIMEOUT_MS),
    pollIntervalMs: normalizePositiveInteger(options.pollIntervalMs, TIKU_ADAPTER_AI_FALLBACK_STATUS_POLL_INTERVAL_MS),
    retryAttempts: normalizePositiveInteger(options.retryAttempts, TIKU_ADAPTER_AI_FALLBACK_RETRY_ATTEMPTS),
    retryDelayMs: Math.max(0, Math.floor(options.retryDelayMs ?? TIKU_ADAPTER_AI_FALLBACK_RETRY_DELAY_MS)),
    preferAsyncTask: options.preferAsyncTask ?? true,
    idempotencyKey: String(options.idempotencyKey ?? createTikuAdapterIdempotencyKey()).trim()
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createTikuAdapterIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function resolveTikuAdapterAIFallbackResponse(
  baseurl: string,
  key: string,
  payload: ReturnType<typeof buildTikuAdapterAIFallbackPayload>,
  options: ReturnType<typeof normalizeAIFallbackRequestOptions>,
  scriptIdentity = ''
): Promise<TikuAdapterAIFallbackResult> {
  const phaseStartedAt = Date.now();
  const phaseDeadlineAt = phaseStartedAt + options.statusTimeoutMs;
  if (options.preferAsyncTask) {
    const taskResponse = await requestTikuAdapterJSON<TikuAdapterAIFallbackResult>(createTikuAdapterAIFallbackTaskUrl(baseurl), key, {
      method: 'POST',
      data: payload,
      timeoutMs: Math.min(options.requestTimeoutMs, TIKU_ADAPTER_SEARCH_TASK_CREATE_TIMEOUT_MS),
      deadlineAt: phaseDeadlineAt,
      retryAttempts: options.retryAttempts,
      retryDelayMs: options.retryDelayMs,
      extraHeaders: { 'Idempotency-Key': options.idempotencyKey },
      scriptIdentity
    });
    if (shouldPollAIFallbackTask(taskResponse)) {
      return pollTikuAdapterAIFallbackStatus(baseurl, key, taskResponse, {
        ...options,
        statusTimeoutMs: Math.max(1, options.statusTimeoutMs - (Date.now() - phaseStartedAt))
      }, scriptIdentity);
    }
    return taskResponse;
  }

  const directResponse = await requestTikuAdapterJSON<TikuAdapterAIFallbackResult>(createTikuAdapterAIFallbackUrl(baseurl), key, {
    method: 'POST',
    data: payload,
    timeoutMs: options.requestTimeoutMs,
    deadlineAt: phaseDeadlineAt,
    retryAttempts: 1,
    retryDelayMs: 0,
    scriptIdentity
  });

  if (isAIFallbackPendingResponse(directResponse)) {
    return pollTikuAdapterAIFallbackStatus(baseurl, key, directResponse, {
      ...options,
      statusTimeoutMs: Math.max(1, options.statusTimeoutMs - (Date.now() - phaseStartedAt))
    }, scriptIdentity);
  }
  return directResponse;
}

async function pollTikuAdapterAIFallbackStatus(
  baseurl: string,
  key: string,
  initialResponse: TikuAdapterAIFallbackResult,
  options: ReturnType<typeof normalizeAIFallbackRequestOptions>,
  scriptIdentity = ''
): Promise<TikuAdapterAIFallbackResult> {
  const statusUrl = resolveAIFallbackStatusUrl(baseurl, initialResponse);
  const taskId = String(initialResponse.taskId ?? '').trim();
  if (!statusUrl) {
    return initialResponse;
  }

  const startedAt = Date.now();
  try {
    const terminal = await pollTikuAdapterTask<{ question?: string; answer?: string }>(initialResponse, {
      statusUrlBase: statusUrl || createTikuAdapterAIFallbackStatusUrl(baseurl, taskId),
      pollIntervalMs: options.pollIntervalMs,
      timeoutMs: options.statusTimeoutMs,
      maxConsecutiveFailures: 3,
      isTerminalFailure: (response) =>
        typeof response.error === 'object' && response.error?.code === 'NO_ANSWER',
      getStatus: (url, _taskId, remainingMs) => requestTikuAdapterJSON<TikuAdapterAIFallbackResult>(url, key, {
        method: 'GET',
        timeoutMs: Math.min(options.requestTimeoutMs, 10000, remainingMs),
        retryAttempts: 1,
        retryDelayMs: 0,
        balanceScopeBaseurl: baseurl,
        deferBalanceBlockUntilPollingCompletes: true,
        scriptIdentity
      })
    });
    return {
      success: terminal.success === true,
      status: terminal.status,
      taskId,
      ...(terminal.result ? { result: terminal.result } : {}),
      ...(terminal.error ? { error: terminal.error as TikuAdapterAIFallbackResult['error'] } : {}),
      ...(Array.isArray((terminal as TikuAdapterAIFallbackResult).warnings)
        ? { warnings: (terminal as TikuAdapterAIFallbackResult).warnings }
        : {})
    };
  } catch (error) {
    const insufficientBalance = isInsufficientBalancePollingError(error);
    const quotaExceeded = isTikuAdapterQuotaExceeded(error);
    if (insufficientBalance && !scriptIdentity) {
      markTikuAdapterBalanceBlocked(baseurl, key);
    }
    return {
      success: false,
      status: Date.now() - startedAt >= options.statusTimeoutMs ? 'timeout' : 'failed',
      taskId,
      error: {
        code: insufficientBalance ? 'INSUFFICIENT_BALANCE' : quotaExceeded ? 'ACCESS_TOKEN_QUOTA_EXCEEDED' : 'UPSTREAM_ERROR',
        message: insufficientBalance
          ? TIKU_ADAPTER_BALANCE_FAILURE_MESSAGE
          : quotaExceeded ? TIKU_ADAPTER_QUOTA_FAILURE_MESSAGE
            : error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function isInsufficientBalancePollingError(error: unknown) {
  return error instanceof Error && (error as Error & { code?: string }).code === 'INSUFFICIENT_BALANCE';
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

function shouldPollAIFallbackTask(response: TikuAdapterAIFallbackResult | undefined) {
  return isAIFallbackPendingResponse(response)
    || Boolean(response?.taskId && response?.status === 'succeeded' && !response.result && !response.error);
}

async function requestTikuAdapterJSON<T>(
  url: string,
  key: string,
  options: {
    method: 'GET' | 'POST';
    data?: Record<string, unknown>;
    timeoutMs: number;
    deadlineAt?: number;
    retryAttempts: number;
    retryDelayMs: number;
    extraHeaders?: Record<string, string>;
    scriptIdentity?: string;
    balanceScopeBaseurl?: string;
    deferBalanceBlockUntilPollingCompletes?: boolean;
  }
): Promise<T> {
  const requestIdentity = resolveTikuAdapterRequestIdentity(url, {
    Authorization: createTikuAdapterAuthorizationHeader(key)
  });
  const scriptIdentity = String(options.scriptIdentity ?? '').trim();
  const identity = { ...requestIdentity, baseurl: options.balanceScopeBaseurl ?? requestIdentity.baseurl };
  // Polling an existing task only delivers its original result; it creates no new fee.
  const existingTaskDelivery = options.method === 'GET' && options.deferBalanceBlockUntilPollingCompletes === true;
  if (!scriptIdentity && !existingTaskDelivery && isTikuAdapterBalanceBlocked(identity.baseurl, identity.key)) {
    throw createTikuAdapterRequestError({ code: 'INSUFFICIENT_BALANCE' });
  }

  let lastError: unknown;
  const maxAttempts = Math.max(1, options.retryAttempts);
  const requestBody = options.method === 'POST' ? JSON.stringify(options.data ?? {}) : undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A transport retry replays the same server idempotency key/body, never a replacement operation.
    const sameOperationRetry = attempt > 1 && Boolean(options.extraHeaders?.['Idempotency-Key']?.trim());
    if (!scriptIdentity && !existingTaskDelivery && !sameOperationRetry && isTikuAdapterBalanceBlocked(identity.baseurl, identity.key)) {
      throw createTikuAdapterRequestError({ code: 'INSUFFICIENT_BALANCE' });
    }
    const remainingMs = options.deadlineAt === undefined ? Infinity : options.deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error('tikuAdapter request timed out');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(options.timeoutMs, remainingMs));
    try {
      const response = await fetch(url, {
        method: options.method,
        headers: {
          Authorization: createTikuAdapterAuthorizationHeader(key),
          ...(scriptIdentity ? { 'X-Script-Identity': scriptIdentity } : {}),
          ...options.extraHeaders,
          ...(options.method === 'POST' ? { 'Content-Type': 'application/json' } : {})
        },
        body: requestBody,
        signal: controller.signal
      });
      if (!response.ok) {
        const message = await response.text();
        let responseBody: unknown = message;
        try { responseBody = JSON.parse(message); } catch { /* old versions can return plain text */ }
        const requestError = createTikuAdapterRequestError(responseBody, response.status) as ReturnType<typeof createTikuAdapterRequestError> & {
          retryAfterMs?: number;
        };
        if (scriptIdentity && (response.status === 401 || response.status === 403)) notifyScriptSessionExpired();
        requestError.retryAfterMs = readRetryAfterMs(response.headers.get('Retry-After'));
        if (requestError.code === 'INSUFFICIENT_BALANCE') {
          if (!options.deferBalanceBlockUntilPollingCompletes) {
            markTikuAdapterBalanceBlocked(identity.baseurl, identity.key);
          }
          throw requestError;
        }
        if (response.status === 404) {
          throw createHTTPError(404, 'Not found');
        }
        throw requestError;
      }
      const responseData = await response.json();
      if (!options.deferBalanceBlockUntilPollingCompletes && isTikuAdapterInsufficientBalance(responseData)) {
        markTikuAdapterBalanceBlocked(identity.baseurl, identity.key);
      }
      return responseData as T;
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isRetryableTikuAdapterError(err)) {
        throw err;
      }
      const retryAfterMs = getHTTPStatus(err) === 429 && err && typeof err === 'object'
        ? (err as { retryAfterMs?: number }).retryAfterMs : undefined;
      const backoffMs = retryAfterMs ?? Math.round(options.retryDelayMs * (2 ** (attempt - 1)) * (1 + Math.random() * 0.25));
      const budgetMs = options.deadlineAt === undefined ? Infinity : options.deadlineAt - Date.now();
      if (budgetMs <= backoffMs) throw err;
      await sleepAIFallback(backoffMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'tikuAdapter request failed'));
}

function readRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function createHTTPError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function isRetryableTikuAdapterError(err: unknown) {
  if (isTikuAdapterQuotaExceeded(err) || isInsufficientBalancePollingError(err)) return false;
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  if (err && typeof err === 'object') {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number') {
      return status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;
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
      return 4;
    case 'unknown':
    default:
      return -1;
  }
}

/**
 * 读取 tikuAdapter 返回的非阻断提示（例如「AI 模型未配置价格」）。
 *
 * 这些提示只面向部署方的管理员，普通用户不应看到，因此这里只做「提取」，
 * 由调用方决定写进管理员可见的调试日志面板，绝不进入题目结果或用户提示。
 */
export function resolveTikuAdapterWarnings(response: unknown): string[] {
  if (!response || typeof response !== 'object') {
    return [];
  }

  const rawWarnings = (response as { warnings?: unknown }).warnings;
  if (!Array.isArray(rawWarnings)) {
    return [];
  }

  const warnings: string[] = [];
  rawWarnings.forEach((item) => {
    const text = String(item ?? '').trim();
    if (text && !warnings.includes(text)) {
      warnings.push(text);
    }
  });
  return warnings;
}

/** 从一批查题结果里收集 tikuAdapter 的管理员提示。 */
export function collectTikuAdapterWarnings(searchInfos: unknown): string[] {
  if (!Array.isArray(searchInfos)) {
    return [];
  }

  const warnings: string[] = [];
  searchInfos.forEach((info) => {
    resolveTikuAdapterWarnings((info as { response?: unknown } | undefined)?.response).forEach((warning) => {
      if (!warnings.includes(warning)) {
        warnings.push(warning);
      }
    });
  });
  return warnings;
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
  const scriptIdentity = String(config.scriptIdentity ?? '').trim();
  const problem = getTikuAdapterConfigProblem({ baseurl, key });

  if (problem) {
    throw new Error(problem);
  }

  return {
    url: config.asyncSearch === false ? createTikuAdapterSearchUrl(baseurl) : createTikuAdapterSearchTaskUrl(baseurl),
    name: 'Zelly的题库',
    homepage: baseurl,
    method: 'post',
    contentType: 'json',
    type: 'fetch',
    headers: {
      Authorization: createTikuAdapterAuthorizationHeader(key),
      ...(scriptIdentity ? { 'X-Script-Identity': scriptIdentity } : {})
    },
    executeRequest: ({ data, timeoutMs }) => config.asyncSearch === false
      ? requestTikuAdapterLegacySearch(baseurl, key, data, {
          requestTimeoutMs: timeoutMs,
          retryAttempts: TIKU_ADAPTER_AI_FALLBACK_RETRY_ATTEMPTS,
          retryDelayMs: TIKU_ADAPTER_AI_FALLBACK_RETRY_DELAY_MS,
          deadlineAt: Date.now() + TIKU_ADAPTER_SEARCH_TASK_TIMEOUT_MS,
          scriptIdentity
        })
      : requestTikuAdapterSearchTask({ baseurl, key, scriptIdentity }, data, { requestTimeoutMs: timeoutMs }),
    timeoutSeconds: TIKU_ADAPTER_SEARCH_TIMEOUT_SECONDS,
    retry: {
      maxAttempts: TIKU_ADAPTER_AI_FALLBACK_RETRY_ATTEMPTS,
      delayMs: TIKU_ADAPTER_AI_FALLBACK_RETRY_DELAY_MS
    },
    data: {
      qid: '',
      question: {
        // 内置 handler 是运行期用 Function(...) 求值的字符串，不经过构建期转译；
        // 目标 Windows 客户端是 CEF/Chromium 75（不支持 ?. 与 ??），因此这里保持 ES2019 语法。
        handler: `return (env) => { const title = env.title == null ? '' : env.title; return String(title).trim(); }`
      },
      options: {
        // 抓取页面选项时会把富文本编辑器（UEditor）与 jQuery 初始化源码一起带进来：线上实测一次请求 55 条 options 里绝大多数是源码。
        // 这些噪音会挤掉真实选项、让 AI 分心、显著拉长响应（单次 36.9 秒），进而触发客户端超时重发，所以在提交前按行剔除。
        // 判定依据：编辑器/框架源码行必然命中代码符号（function( / function foo( / => / $( / .parent( / .removeClass( / .css( 等）、
        // 或以上述关键字开头（var / let / const / if / else / window. / document. / editor1. 等）、或是纯符号行、以 // 开头的注释行，
        // 或是以 ASCII 分号 `;` 结尾的 JS 语句行（截断后的片段如 `wordNum = "";` 会绕过前几条规则，而选项文本不会以 `;` 收尾）；
        // 正常选项是自然语言或公式，不会以这些 token 开头或收尾，也不会只由符号组成，因此不会被误删。
        // 结果按首次出现顺序去重；若过滤后一条不剩（整题选项恰好长得像代码），回退为原始列表，绝不返回空数组。
        handler: `return (env) => { const raw = String(env.options == null ? '' : env.options).split(/\\n+/).map((item) => item.trim()).filter(Boolean); const isNoise = (item) => /function\\s*[$\\w]*\\s*\\(|=>|\\$\\(|\\.parent\\(|\\.find\\(|\\.removeClass\\(|\\.addClass\\(|\\.css\\(|UEDITOR_CONFIG|\\.edui-|addListener\\(|contentChange|;$/.test(item) || /^(var|let|const|if|else|window\\.|document\\.|editor\\d*\\.|\\$\\.|\\/\\/|\\/\\*|\\} else|\\.\\w+\\()/.test(item) || !/[\\p{L}\\p{N}]/u.test(item); const kept = []; for (const item of raw) { if (!isNoise(item) && !kept.includes(item)) kept.push(item); } return kept.length > 0 ? kept : raw; }`
      },
      type: {
        handler: `return (env) => {
          const value = String(env.type == null ? 'unknown' : env.type);
          return value === 'single'
            ? 0
            : value === 'multiple'
              ? 1
              : value === 'judgement'
                ? 3
                : value === 'completion' || value === 'fill' || value === 'line'
                  ? 2
                  : value === 'reader' ? 4 : -1;
        }`
      },
      courseName: '',
      extra: '',
      skipCache: {
        handler: `return (env) => typeof env.skipCache === 'boolean' ? env.skipCache : undefined`
      },
      deepThinking: {
        handler: `return (env) => env.deepThinking === true ? true : undefined`
      },
      questionEvidence: {
        handler: `return (env) => { const value = env.questionEvidence; if (!value || typeof value !== 'object') return undefined; const normalize = (items) => Array.isArray(items) ? items.map((item, index) => ({ url: String(item && item.url || ''), alt: String(item && item.alt || ''), index: Number.isInteger(item && item.index) ? item.index : index })).filter((item) => item.url || item.alt) : []; return { stemImages: normalize(value.stemImages), optionImages: normalize(value.optionImages) }; }`
      }
    },
    handler: `return (res) => {
      const data = res == null ? {} : res;
      const answer = data.answer == null ? {} : data.answer;
      const question = typeof data.question === 'string' ? data.question : '';
      const isChoiceType = data.type === 0 || data.type === 1;
      const answerKeyText = typeof answer.answerKeyText === 'string' ? answer.answerKeyText.trim() : '';
      if (isChoiceType && answerKeyText) {
        return [question, answerKeyText, { source: 'tikuAdapter' }];
      }

      const answerIndex = Array.isArray(answer.answerIndex)
        ? answer.answerIndex.filter((item) => Number.isInteger(item) && item >= 0)
        : [];
      if (isChoiceType && answerIndex.length > 0) {
        return [question, answerIndex.map((index) => String.fromCharCode(index + 65)).join(''), { source: 'tikuAdapter' }];
      }

      const answerText = typeof answer.answerText === 'string' ? answer.answerText.trim() : '';
      if (answerText) {
        return [question, answerText, { source: 'tikuAdapter' }];
      }

      const bestAnswer = Array.isArray(answer.bestAnswer)
        ? answer.bestAnswer.map((item) => String(item).trim()).filter(Boolean)
        : [];
      if (bestAnswer.length > 0) {
        return [question, bestAnswer.join('#'), { source: 'tikuAdapter' }];
      }

      const firstAllAnswer = Array.isArray(answer.allAnswer)
        ? answer.allAnswer.find((item) => Array.isArray(item) && item.map((value) => String(value).trim()).filter(Boolean).length > 0)
        : undefined;
      if (firstAllAnswer) {
        return [question, firstAllAnswer.join('#'), { source: 'tikuAdapter' }];
      }

      return undefined;
    }`
  };
}
