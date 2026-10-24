import {
  createTikuAdapterRequestError,
  hasTikuAdapterAnswer,
  isTikuAdapterBalanceBlocked,
  isTikuAdapterRequestUrl,
  markTikuAdapterBalanceBlocked,
  resolveTikuAdapterRequestIdentity,
  TikuAdapterRequestError
} from './tiku-adapter-error.js';

export async function request<T extends 'json' | 'text'>(
  url: string,
  opts: {
    type?: 'fetch' | 'GM_xmlhttpRequest';
    method?: 'get' | 'post' | 'head';
    responseType?: T;
    headers?: Record<string, string>;
    data?: Record<string, any>;
    timeoutMs?: number;
    signal?: AbortSignal;
    retry?: {
      maxAttempts?: number;
      delayMs?: number;
    };
  }
): Promise<T extends 'json' ? any : string> {
  const { responseType = 'json' as T, method = 'get', headers = {}, data = {} } = opts || {};
  const upperMethod = method.toUpperCase();
  const isBodyMethod = upperMethod === 'POST';
  const contentType = headers['Content-Type'] || headers['content-type'] || 'application/json';
  const body = isBodyMethod
    ? contentType === 'application/x-www-form-urlencoded'
      ? new URLSearchParams(data).toString()
      : JSON.stringify(data)
    : undefined;

  const idempotencyKey = Object.entries(headers).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1];
  const canReplay = upperMethod === 'GET' || upperMethod === 'HEAD' || Boolean(String(idempotencyKey ?? '').trim());
  const maxAttempts = canReplay ? Math.max(1, Math.floor(opts?.retry?.maxAttempts ?? 1)) : 1;
  const delayMs = Math.max(0, Math.floor(opts?.retry?.delayMs ?? 500));
  const deadlineAt = Date.now() + (opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 60000);
  let lastError: unknown;

  const isTikuAdapterRequest = isTikuAdapterRequestUrl(url);
  const tikuIdentity = isTikuAdapterRequest ? resolveTikuAdapterRequestIdentity(url, headers) : undefined;
  if (tikuIdentity && isTikuAdapterBalanceBlocked(tikuIdentity.baseurl, tikuIdentity.key)) {
    throw new TikuAdapterRequestError('INSUFFICIENT_BALANCE');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts?.signal?.aborted) throw opts.signal.reason || new DOMException('request aborted', 'AbortError');
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error('request timeout');
    const controller = new AbortController();
    let attemptTimedOut = false;
    const attemptTimeoutMs = Number.isFinite(remainingMs)
      ? Math.max(1, Math.min(30000, Math.floor(remainingMs / (maxAttempts - attempt + 1))))
      : undefined;
    const onAbort = () => controller.abort(opts.signal?.reason);
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = attemptTimeoutMs === undefined ? undefined : setTimeout(() => {
      attemptTimedOut = true;
      controller.abort();
    }, attemptTimeoutMs);

    try {
      const response = await fetch(url, {
        method: upperMethod,
        headers: Object.keys(headers).length ? headers : undefined,
        body,
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text();
        if (isTikuAdapterRequest) {
          let payload: unknown = text;
          try { payload = JSON.parse(text); } catch { /* legacy servers may return plain text */ }
          const error = createTikuAdapterRequestError(payload, response.status) as TikuAdapterRequestError & { retryAfterMs?: number };
          error.retryAfterMs = readRetryAfterMs(response.headers.get('Retry-After'));
          if (error.code === 'INSUFFICIENT_BALANCE' && tikuIdentity) {
            markTikuAdapterBalanceBlocked(tikuIdentity.baseurl, tikuIdentity.key);
          }
          throw error;
        }

        const error = new Error(text || `HTTP ${response.status}`) as Error & { status?: number; retryAfterMs?: number };
        error.status = response.status;
        error.retryAfterMs = readRetryAfterMs(response.headers.get('Retry-After'));
        throw error;
      }

      if (responseType === 'text') {
        return (await response.text()) as T extends 'json' ? any : string;
      }

      const responseData = await response.json();
      if (isTikuAdapterRequest && responseData?.error && !hasTikuAdapterAnswer(responseData)) {
        const error = createTikuAdapterRequestError(responseData);
        if (error.code === 'INSUFFICIENT_BALANCE' && tikuIdentity) {
          markTikuAdapterBalanceBlocked(tikuIdentity.baseurl, tikuIdentity.key);
        }
        throw error;
      }
      return responseData as T extends 'json' ? any : string;
    } catch (err) {
      if (opts?.signal?.aborted) throw opts.signal.reason || new DOMException('request aborted', 'AbortError');
      lastError = attemptTimedOut ? new Error('request timeout') : err;
      if (attempt >= maxAttempts || !isRetryableRequestError(lastError)) {
        throw lastError;
      }
      const errorWithStatus = lastError as { status?: number; retryAfterMs?: number };
      const backoffMs = errorWithStatus.status === 429 && errorWithStatus.retryAfterMs !== undefined
        ? errorWithStatus.retryAfterMs
        : Math.round(delayMs * (2 ** (attempt - 1)) * (1 + Math.random() * 0.25));
      if (deadlineAt - Date.now() <= backoffMs) throw lastError;
      await waitRequestRetryDelay(backoffMs, opts?.signal);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      opts?.signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'request failed'));
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;
}

function isRetryableRequestError(err: unknown) {
  if (err instanceof TikuAdapterRequestError && err.code === 'INSUFFICIENT_BALANCE') return false;
  if (err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number') {
    return isRetryableStatus((err as { status: number }).status);
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  return /network|fetch|timeout|abort|connection|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(err.message);
}

function readRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

async function waitRequestRetryDelay(waitMs: number, signal?: AbortSignal) {
  if (waitMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, waitMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason || new DOMException('request aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
