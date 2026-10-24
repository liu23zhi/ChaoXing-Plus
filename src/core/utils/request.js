export async function request(url, opts = {}) {
    const { responseType = 'json', method = 'get', headers = {}, data = {}, signal } = opts;
    const upperMethod = method.toUpperCase();
    const contentType = headers['Content-Type'] || headers['content-type'] || 'application/json';
    const body = upperMethod === 'POST'
        ? contentType === 'application/x-www-form-urlencoded'
            ? new URLSearchParams(data).toString()
            : JSON.stringify(data)
        : undefined;
    const idempotencyKey = Object.entries(headers).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1];
    const canReplay = upperMethod === 'GET' || upperMethod === 'HEAD' || Boolean(String(idempotencyKey || '').trim());
    const maxAttempts = canReplay ? Math.max(1, Math.floor(opts.retry?.maxAttempts ?? 1)) : 1;
    const delayMs = Math.max(0, Math.floor(opts.retry?.delayMs ?? 500));
    const deadlineAt = Date.now() + (opts.timeoutMs > 0 ? opts.timeoutMs : 60000);
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted) throw signal.reason || new DOMException('request aborted', 'AbortError');
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) throw new Error('request timeout');
        const controller = new AbortController();
        let attemptTimedOut = false;
        const attemptsLeft = maxAttempts - attempt + 1;
        const attemptTimeoutMs = Number.isFinite(remainingMs)
            ? Math.max(1, Math.min(30000, Math.floor(remainingMs / attemptsLeft)))
            : undefined;
        const onAbort = () => controller.abort(signal.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
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
                const error = new Error((await response.text()) || `HTTP ${response.status}`);
                error.status = response.status;
                error.retryAfterMs = readRetryAfterMs(response.headers.get('Retry-After'));
                throw error;
            }
            return responseType === 'text' ? await response.text() : await response.json();
        } catch (error) {
            if (signal?.aborted) throw signal.reason || new DOMException('request aborted', 'AbortError');
            lastError = attemptTimedOut ? new Error('request timeout') : error;
            if (attempt >= maxAttempts || !isRetryableError(lastError)) throw lastError;
            const backoffMs = lastError.status === 429 && lastError.retryAfterMs !== undefined
                ? lastError.retryAfterMs
                : Math.round(delayMs * (2 ** (attempt - 1)) * (1 + Math.random() * 0.25));
            if (deadlineAt - Date.now() <= backoffMs) throw lastError;
            await wait(backoffMs, signal);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
        }
    }
    throw lastError || new Error('request failed');
}

function isRetryableError(error) {
    if (typeof error?.status === 'number') {
        return error.status === 408 || error.status === 425 || error.status === 429
            || error.status >= 500 && error.status <= 599;
    }
    return error instanceof Error && /network|fetch|timeout|abort|connection|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(error.message)
        || error instanceof TypeError && /^(?:Failed to fetch|fetch failed)$/i.test(error.message);
}

function readRetryAfterMs(value) {
    if (value === null) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(value);
    return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function wait(ms, signal) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason || new DOMException('request aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
