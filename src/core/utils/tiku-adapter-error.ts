export const TIKU_ADAPTER_UPSTREAM_FAILURE_MESSAGE = '服务器内部错误，搜题失败。';
export const TIKU_ADAPTER_BALANCE_FAILURE_MESSAGE = '当前账号余额不足，请充值后重试。';

export type TikuAdapterFailureCode = 'INSUFFICIENT_BALANCE' | 'UPSTREAM_ERROR';

export class TikuAdapterRequestError extends Error {
  readonly code: TikuAdapterFailureCode;
  readonly status?: number;
  readonly isTikuAdapterRequestError = true;

  constructor(code: TikuAdapterFailureCode, status?: number) {
    super(code === 'INSUFFICIENT_BALANCE'
      ? TIKU_ADAPTER_BALANCE_FAILURE_MESSAGE
      : TIKU_ADAPTER_UPSTREAM_FAILURE_MESSAGE);
    this.name = 'TikuAdapterRequestError';
    this.code = code;
    this.status = status;
  }
}

const balanceBlockedScopes = new Set<string>();
const balanceNotifiedScopes = new Set<string>();

export function isTikuAdapterRequestUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).pathname.includes('/adapter-service/');
  } catch {
    return false;
  }
}

export function resolveTikuAdapterRequestIdentity(rawUrl: string, headers: Record<string, string> = {}) {
  try {
    const url = new URL(rawUrl);
    const adapterPathIndex = url.pathname.indexOf('/adapter-service/');
    const basePath = adapterPathIndex >= 0 ? url.pathname.slice(0, adapterPathIndex) : url.pathname.replace(/\/+$/, '');
    const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '';
    const key = authorization.replace(/^Bearer\s+/i, '').trim();
    return { baseurl: `${url.origin}${basePath}`, key };
  } catch {
    return { baseurl: '', key: '' };
  }
}

function getScope(baseurl: string, key: string) {
  const normalizedBaseurl = String(baseurl ?? '').trim().replace(/\/+$/, '').toLowerCase();
  const normalizedKey = String(key ?? '').trim();
  return normalizedBaseurl && normalizedKey ? `${normalizedBaseurl}\n${normalizedKey}` : '';
}

export function markTikuAdapterBalanceBlocked(baseurl: string, key: string) {
  const scope = getScope(baseurl, key);
  if (scope) balanceBlockedScopes.add(scope);
}

export function isTikuAdapterBalanceBlocked(baseurl: string, key: string) {
  const scope = getScope(baseurl, key);
  return Boolean(scope && balanceBlockedScopes.has(scope));
}

export function claimTikuAdapterBalanceNotice(baseurl: string, key: string) {
  const scope = getScope(baseurl, key);
  if (!scope || balanceNotifiedScopes.has(scope)) return false;
  balanceNotifiedScopes.add(scope);
  return true;
}

export function resetTikuAdapterBalanceGuard(baseurl: string, key: string) {
  const scope = getScope(baseurl, key);
  if (!scope) return;
  balanceBlockedScopes.delete(scope);
  balanceNotifiedScopes.delete(scope);
}

export function isTikuAdapterInsufficientBalance(value: unknown, status?: number): boolean {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const code = String((record.error as Record<string, unknown> | undefined)?.code ?? record.code ?? '').trim().toUpperCase();
    if (code === 'INSUFFICIENT_BALANCE') return true;

    if (status === 401) {
      const detail = [record.detail, record.message, (record.error as Record<string, unknown> | undefined)?.message]
        .map((item) => String(item ?? ''))
        .join(' ');
      return /当前余额不足/.test(detail);
    }
    return false;
  }

  return status === 401 && /当前余额不足/.test(String(value ?? ''));
}

export function createTikuAdapterRequestError(value: unknown, status?: number): TikuAdapterRequestError {
  const code = isTikuAdapterInsufficientBalance(value, status) ? 'INSUFFICIENT_BALANCE' : 'UPSTREAM_ERROR';
  return new TikuAdapterRequestError(code, status);
}

export function hasTikuAdapterAnswer(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const answer = (value as Record<string, unknown>).answer;
  if (!answer || typeof answer !== 'object') return false;
  const record = answer as Record<string, unknown>;
  return Boolean(
    String(record.answerKeyText ?? record.answerText ?? '').trim() ||
    (Array.isArray(record.answerIndex) && record.answerIndex.length > 0) ||
    (Array.isArray(record.bestAnswer) && record.bestAnswer.length > 0) ||
    (Array.isArray(record.allAnswer) && record.allAnswer.some((item) => Array.isArray(item) && item.length > 0))
  );
}
