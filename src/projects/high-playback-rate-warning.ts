export const HIGH_PLAYBACK_RATE_THRESHOLD = 2;
export const HIGH_PLAYBACK_RATE_FALLBACK = 1;

export const HIGH_PLAYBACK_RATE_WARNING_CONTENT =
  '当前倍速已达到或超过 2 倍。超星存在较强风控，高倍速可能导致进度清空、回退或学习异常，请谨慎使用。';
export const HIGH_PLAYBACK_RATE_WARNING_CONFIRM_TEXT = '继续使用';
export const HIGH_PLAYBACK_RATE_WARNING_CANCEL_TEXT = '降到 1 倍';

export interface HighPlaybackRateWarningPrompt {
  content: string;
  confirmButtonText: string;
  cancelButtonText: string;
  defaultConfirmed: boolean;
}

export interface HighPlaybackRateWarningHandlers {
  confirm: (prompt: HighPlaybackRateWarningPrompt) => Promise<boolean>;
  restorePlaybackRate: (rate: number) => void | Promise<void>;
}

export interface HighPlaybackRateWarningState {
  /** 用户选择「继续使用」后置为 true，当前页面内不再提示。 */
  acknowledged: boolean;
  /** 提示框打开期间置为 true，避免连续调节倍速时弹出多个提示框。 */
  pending: boolean;
}

export type HighPlaybackRateWarningOutcome =
  | 'acknowledged'
  | 'restored'
  | 'deduped'
  | 'skipped'
  | 'failed';

export function createHighPlaybackRateWarningState(): HighPlaybackRateWarningState {
  return { acknowledged: false, pending: false };
}

export function shouldWarnHighPlaybackRate(state: HighPlaybackRateWarningState, value: unknown): boolean {
  if (state.acknowledged || state.pending) {
    return false;
  }

  const rate = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(rate) && rate >= HIGH_PLAYBACK_RATE_THRESHOLD;
}

export function buildHighPlaybackRateWarningPrompt(): HighPlaybackRateWarningPrompt {
  return {
    content: HIGH_PLAYBACK_RATE_WARNING_CONTENT,
    confirmButtonText: HIGH_PLAYBACK_RATE_WARNING_CONFIRM_TEXT,
    cancelButtonText: HIGH_PLAYBACK_RATE_WARNING_CANCEL_TEXT,
    defaultConfirmed: true
  };
}

/**
 * 高倍速提示状态机：
 * - 只有用户明确选择「继续使用」，才会在当前页面内停止提示；
 * - 选择「降到 1 倍」只把倍速恢复到 1 倍，之后再次调到 2 倍及以上仍会继续提示。
 */
export async function warnOnHighPlaybackRate(
  state: HighPlaybackRateWarningState,
  value: unknown,
  handlers: HighPlaybackRateWarningHandlers
): Promise<HighPlaybackRateWarningOutcome> {
  if (state.pending) {
    return 'deduped';
  }

  if (!shouldWarnHighPlaybackRate(state, value)) {
    return 'skipped';
  }

  state.pending = true;

  let confirmed = false;
  try {
    confirmed = await handlers.confirm(buildHighPlaybackRateWarningPrompt());
  } catch {
    // 提示框自身失败时不打断学习流程，下次高倍速仍会重新提示。
    return 'failed';
  } finally {
    state.pending = false;
  }

  if (confirmed) {
    state.acknowledged = true;
    return 'acknowledged';
  }

  await handlers.restorePlaybackRate(HIGH_PLAYBACK_RATE_FALLBACK);
  return 'restored';
}
