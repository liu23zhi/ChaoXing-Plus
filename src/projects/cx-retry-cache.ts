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

export function isSearchTimeoutFailure(result: RetryFailureSnapshot): boolean {
  const messages = [
    result.error,
    ...(result.ctx?.searchInfos ?? []).map((info) => info.error)
  ];

  return messages.some((message) => searchTimeoutPattern.test(String(message ?? '')));
}

export function hasReturnedSearchAnswer(result: RetryFailureSnapshot): boolean {
  return (result.ctx?.searchInfos ?? []).some((info) =>
    (info.results ?? []).some((entry) => String(entry.answer ?? '').trim().length > 0)
  );
}

export function shouldSkipCacheForAutomaticRetry(result: RetryFailureSnapshot): boolean | undefined {
  if (isSearchTimeoutFailure(result)) {
    return undefined;
  }
  return hasReturnedSearchAnswer(result) ? true : undefined;
}
