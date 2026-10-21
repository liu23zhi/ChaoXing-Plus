export interface TikuAdapterTaskEnvelope<T = unknown> {
  success?: boolean;
  status?: string;
  taskId?: string;
  statusUrl?: string;
  result?: T;
  error?: { code?: string; message?: string } | string;
}

export class TikuAdapterTaskPollingError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'TikuAdapterTaskPollingError';
    this.code = code;
  }
}

export interface TikuAdapterTaskPollOptions<T = unknown> {
  statusUrlBase: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxConsecutiveFailures?: number;
  getStatus: (statusUrl: string, taskId: string, timeoutMs: number) => Promise<TikuAdapterTaskEnvelope<T>>;
  isTerminalFailure?: (response: TikuAdapterTaskEnvelope<T>) => boolean;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export async function pollTikuAdapterTask<T>(
  initial: TikuAdapterTaskEnvelope<T>,
  options: TikuAdapterTaskPollOptions<T>
): Promise<TikuAdapterTaskEnvelope<T>> {
  const taskId = String(initial.taskId ?? '').trim();
  if (!taskId) {
    throw new Error('tikuAdapter task response is missing taskId');
  }

  const statusUrl = resolveStatusUrl(options.statusUrlBase, taskId, initial.statusUrl);
  const pollIntervalMs = Math.max(0, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const maxFailures = Math.max(1, Math.floor(options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES));
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  const startedAt = now();
  let consecutiveFailures = 0;
  let latestError = '';
  let latestErrorCode: string | undefined;

  while (now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (now() - startedAt);
    await wait(Math.min(pollIntervalMs, Math.max(0, remainingMs)));
    if (now() - startedAt >= timeoutMs) {
      break;
    }

    const requestTimeoutMs = timeoutMs - (now() - startedAt);
    if (requestTimeoutMs <= 0) {
      break;
    }

    let response: TikuAdapterTaskEnvelope<T>;
    try {
      response = await options.getStatus(statusUrl, taskId, requestTimeoutMs);
    } catch (error) {
      if (now() - startedAt >= timeoutMs) {
        break;
      }
      consecutiveFailures += 1;
      latestError = error instanceof Error ? error.message : String(error);
      latestErrorCode = getThrownErrorCode(error);
      if (consecutiveFailures >= maxFailures) {
        throw consecutiveFailureError(consecutiveFailures, latestError, latestErrorCode);
      }
      continue;
    }

    if (now() - startedAt >= timeoutMs) {
      break;
    }

    const status = String(response?.status ?? '').trim().toLowerCase();
    if (isWaitingStatus(status)) {
      consecutiveFailures = 0;
      latestError = '';
      latestErrorCode = undefined;
      continue;
    }

    if (isSucceededStatus(status) && response.success !== false) {
      return response;
    }

    if (options.isTerminalFailure?.(response)) {
      return response;
    }

    if (status === 'failed' || response?.success === false) {
      consecutiveFailures += 1;
      latestError = getErrorMessage(response?.error) || `task status is ${status || 'failed'}`;
      latestErrorCode = getErrorCode(response?.error);
      if (consecutiveFailures >= maxFailures) {
        throw consecutiveFailureError(consecutiveFailures, latestError, latestErrorCode);
      }
      continue;
    }

    consecutiveFailures += 1;
    latestError = `unexpected task status: ${status || 'missing'}`;
    latestErrorCode = undefined;
    if (consecutiveFailures >= maxFailures) {
      throw consecutiveFailureError(consecutiveFailures, latestError, latestErrorCode);
    }
  }

  throw new Error(`tikuAdapter task polling timed out after ${Math.round(timeoutMs / 1000)} seconds`);
}

export async function pollTikuAdapterSearchTask<T>(
  initial: TikuAdapterTaskEnvelope<T>,
  options: TikuAdapterTaskPollOptions<T>
): Promise<T> {
  const terminal = isSucceededStatus(String(initial.status ?? '').trim().toLowerCase())
    ? initial
    : await pollTikuAdapterTask(initial, options);
  if (terminal.result === undefined) {
    throw new Error('tikuAdapter search task completed without a result');
  }
  return terminal.result;
}

function resolveStatusUrl(statusUrlBase: string, taskId: string, statusUrl?: string) {
  const base = new URL(statusUrlBase);
  if (statusUrl) {
    return new URL(statusUrl, base).toString();
  }
  base.searchParams.set('taskId', taskId);
  return base.toString();
}

function isWaitingStatus(status: string) {
  return status === 'pending' || status === 'running' || status === 'processing' || status === 'queued' || status === 'created';
}

function isSucceededStatus(status: string) {
  return status === 'succeeded' || status === 'completed';
}

function getErrorMessage(error: TikuAdapterTaskEnvelope['error']) {
  if (typeof error === 'string') return error;
  return String(error?.message ?? '').trim();
}

function getErrorCode(error: TikuAdapterTaskEnvelope['error']) {
  return typeof error === 'object' ? String(error?.code ?? '').trim() || undefined : undefined;
}

function getThrownErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  return String((error as { code?: unknown }).code ?? '').trim() || undefined;
}

function consecutiveFailureError(count: number, message: string, code?: string) {
  return new TikuAdapterTaskPollingError(
    `${count} consecutive tikuAdapter task status query failures${message ? `: ${message}` : ''}`,
    code
  );
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
