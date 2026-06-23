export async function request<T extends 'json' | 'text'>(
  url: string,
  opts: {
    type?: 'fetch' | 'GM_xmlhttpRequest';
    method?: 'get' | 'post' | 'head';
    responseType?: T;
    headers?: Record<string, string>;
    data?: Record<string, any>;
    timeoutMs?: number;
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

  const maxAttempts = Math.max(1, Math.floor(opts?.retry?.maxAttempts ?? 1));
  const delayMs = Math.max(0, Math.floor(opts?.retry?.delayMs ?? 0));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = opts?.timeoutMs && opts.timeoutMs > 0 ? new AbortController() : undefined;
    const timeout = controller
      ? setTimeout(() => controller.abort(), opts.timeoutMs)
      : undefined;

    try {
      const response = await fetch(url, {
        method: upperMethod,
        headers: Object.keys(headers).length ? headers : undefined,
        body,
        signal: controller?.signal
      });

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(text || `HTTP ${response.status}`);
        if (attempt < maxAttempts && isRetryableStatus(response.status)) {
          lastError = error;
          await waitRequestRetryDelay(delayMs, attempt);
          continue;
        }
        throw error;
      }

      if (responseType === 'text') {
        return (await response.text()) as T extends 'json' ? any : string;
      }

      return (await response.json()) as T extends 'json' ? any : string;
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isRetryableRequestError(err)) {
        throw err;
      }
      await waitRequestRetryDelay(delayMs, attempt);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'request failed'));
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableRequestError(err: unknown) {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  return /network|fetch|timeout|abort|failed/i.test(err.message);
}

async function waitRequestRetryDelay(delayMs: number, attempt: number) {
  const waitMs = delayMs > 0 ? delayMs * attempt : 0;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
