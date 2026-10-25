export type RetryFailureSnapshot = {
  error?: string;
  result?: {
    finish?: boolean;
  };
  ctx?: {
    searchInfos?: Array<{
      error?: string;
      results?: Array<{
        answer?: string;
      }>;
    }>;
  };
};

const searchTimeoutPattern = /超时|timeout|abort/i;

type SearchInfoCacheCandidate = {
  error?: string;
  results?: readonly { answer?: string }[];
};

function hasNonEmptyError(message: string | undefined): boolean {
  return String(message ?? '').trim().length > 0;
}

export function isSearchTimeoutFailure(result: RetryFailureSnapshot): boolean {
  const messages = [
    result.error,
    ...(result.ctx?.searchInfos ?? []).map((info) => info.error)
  ];

  return messages.some((message) => searchTimeoutPattern.test(String(message ?? '')));
}

export function hasInsufficientBalanceError(value: unknown): boolean {
  if (typeof value === 'string') {
    return /INSUFFICIENT_BALANCE|当前(?:账号)?余额不足/.test(value);
  }
  if (!value || typeof value !== 'object') return false;

  const record = value as Record<string, any>;
  if (String(record.code ?? record.error?.code ?? '').toUpperCase() === 'INSUFFICIENT_BALANCE') {
    return true;
  }
  if (typeof record.error === 'string' && hasInsufficientBalanceError(record.error)) return true;
  if (record.response?.error && hasInsufficientBalanceError(record.response.error)) return true;
  if (record.ctx?.searchInfos && hasInsufficientBalanceError(record.ctx.searchInfos)) return true;
  if (Array.isArray(value)) return value.some((item) => hasInsufficientBalanceError(item));
  if (typeof record.error?.message === 'string' && hasInsufficientBalanceError(record.error.message)) return true;
  if (Array.isArray(record.searchInfos) && hasInsufficientBalanceError(record.searchInfos)) return true;
  if (record.ctx?.searchInfos && Array.isArray(record.ctx.searchInfos)) {
    return record.ctx.searchInfos.some((info: unknown) => hasInsufficientBalanceError(info));
  }
  return false;
}

export function hasSearchError(result: RetryFailureSnapshot): boolean {
  const messages = [
    result.error,
    ...(result.ctx?.searchInfos ?? []).map((info) => info.error)
  ];

  return messages.some((message) => hasNonEmptyError(message));
}

export function shouldCacheSearchInfos(searchInfos: readonly SearchInfoCacheCandidate[]): boolean {
  return searchInfos.every((info) => !hasNonEmptyError(info.error)) &&
    searchInfos.some((info) => (info.results ?? []).some((entry) => hasNonEmptyError(entry.answer)));
}

export function createSearchRequestDeduplicator<T>(): (key: string, provider: () => Promise<T>) => Promise<T> {
  const pending = new Map<string, Promise<T>>();
  return (key, provider) => {
    const existing = pending.get(key);
    if (existing) return existing;

    const request = Promise.resolve().then(provider).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}

export function hasReturnedSearchAnswer(result: RetryFailureSnapshot): boolean {
  return (result.ctx?.searchInfos ?? []).some((info) =>
    (info.results ?? []).some((entry) => String(entry.answer ?? '').trim().length > 0)
  );
}

export function shouldSkipCacheForAutomaticRetry(result: RetryFailureSnapshot): boolean | undefined {
  if ((result.ctx?.searchInfos ?? []).some((info) => hasNonEmptyError(info.error))) return undefined;
  return hasReturnedSearchAnswer(result) ? true : undefined;
}

export function shouldSkipCacheForManualRetry(result?: {
  searchInfos?: Array<{
    error?: string;
    results?: Array<readonly [unknown, unknown, ...unknown[]]>;
  }>;
}): boolean | undefined {
  return shouldSkipCacheForAutomaticRetry({
    ctx: {
      searchInfos: result?.searchInfos?.map((info) => ({
        error: info.error,
        results: info.results?.map((entry) => ({ answer: String(entry[1] ?? '') }))
      }))
    }
  });
}


export function hasAccessTokenQuotaError(value: unknown): boolean {
  if (typeof value === 'string') {
    // The generic wrapper retains only Error.message; accept our canonical text,
    // not arbitrary upstream strings mentioning an exhausted quota.
    return /^(?:ACCESS_TOKEN_QUOTA_EXCEEDED(?::|$)|当前 Key 额度已用尽或本次请求将超额[，。])/.test(value.trim());
  }
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasAccessTokenQuotaError);
  const record = value as Record<string, any>;
  const code = String(record.code ?? record.error?.code ?? '').trim().toUpperCase();
  if (code) return code === 'ACCESS_TOKEN_QUOTA_EXCEEDED';
  return hasAccessTokenQuotaError(record.error) || hasAccessTokenQuotaError(record.response?.error)
    || hasAccessTokenQuotaError(record.ctx?.searchInfos) || hasAccessTokenQuotaError(record.searchInfos);
}
