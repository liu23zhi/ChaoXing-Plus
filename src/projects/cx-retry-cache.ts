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

export function hasSearchError(result: RetryFailureSnapshot): boolean {
  const messages = [
    result.error,
    ...(result.ctx?.searchInfos ?? []).map((info) => info.error)
  ];

  return messages.some((message) => hasNonEmptyError(message));
}

export function shouldCacheSearchInfos(searchInfos: readonly SearchInfoCacheCandidate[]): boolean {
  return searchInfos.every((info) => !hasNonEmptyError(info.error));
}

export function hasReturnedSearchAnswer(result: RetryFailureSnapshot): boolean {
  return (result.ctx?.searchInfos ?? []).some((info) =>
    (info.results ?? []).some((entry) => String(entry.answer ?? '').trim().length > 0)
  );
}

export function shouldSkipCacheForAutomaticRetry(result: RetryFailureSnapshot): boolean | undefined {
  if (hasSearchError(result)) {
    return true;
  }
  return hasReturnedSearchAnswer(result) ? true : undefined;
}
