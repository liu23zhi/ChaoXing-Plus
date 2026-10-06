export const VISIBLE_CONTENT_RECOVERY_STORAGE_KEY = '__chaoxing_plus_visible_content_recovery__';
export const VISIBLE_CONTENT_RECOVERY_MAX_RELOADS = 3;
export const VISIBLE_CONTENT_RECOVERY_DELAY_MS = 3000;
export const VIDEO_ROUTE_SWITCH_GRACE_MS = 10000;

export type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type VisibleContentRecoveryState = {
  signature: string;
  attempts: number;
  phase: 'waiting' | 'scanning' | 'exhausted';
  notified?: boolean;
};

type VisibleContentRecoveryOptions = {
  storage?: RecoveryStorage;
  storageKey?: string;
  signature: string;
  reload: () => void;
  notifyFinalFailure?: () => void;
  maxReloads?: number;
};

function readState(storage: RecoveryStorage | undefined, storageKey: string): VisibleContentRecoveryState | undefined {
  if (!storage) {
    return undefined;
  }

  try {
    const raw = storage.getItem(storageKey);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as Partial<VisibleContentRecoveryState>;
    if (
      typeof parsed.signature !== 'string' ||
      typeof parsed.attempts !== 'number' ||
      !['waiting', 'scanning', 'exhausted'].includes(String(parsed.phase))
    ) {
      return undefined;
    }
    return {
      signature: parsed.signature,
      attempts: Math.max(0, Math.floor(parsed.attempts)),
      phase: parsed.phase as VisibleContentRecoveryState['phase'],
      notified: parsed.notified === true
    };
  } catch {
    return undefined;
  }
}

function writeState(storage: RecoveryStorage | undefined, storageKey: string, state: VisibleContentRecoveryState) {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Storage can be unavailable in restricted frames; the scan remains usable.
  }
}

export function clearVisibleContentRecovery(storage: RecoveryStorage | undefined, storageKey = VISIBLE_CONTENT_RECOVERY_STORAGE_KEY) {
  try {
    storage?.removeItem(storageKey);
  } catch {
    // Ignore storage cleanup failures.
  }
}

export function handleVisibleContentRecovery({
  storage,
  storageKey = VISIBLE_CONTENT_RECOVERY_STORAGE_KEY,
  signature,
  reload,
  notifyFinalFailure,
  maxReloads = VISIBLE_CONTENT_RECOVERY_MAX_RELOADS
}: VisibleContentRecoveryOptions): 'reloading' | 'exhausted' | 'ignored' {
  if (!signature) {
    return 'ignored';
  }

  const current = readState(storage, storageKey);
  const state = current?.signature === signature
    ? current
    : { signature, attempts: 0, phase: 'scanning' as const, notified: false };

  if (state.phase === 'exhausted' || state.attempts >= maxReloads) {
    if (!state.notified) {
      state.phase = 'exhausted';
      state.notified = true;
      writeState(storage, storageKey, state);
      notifyFinalFailure?.();
    }
    return 'exhausted';
  }

  state.attempts += 1;
  state.phase = 'waiting';
  state.notified = false;
  writeState(storage, storageKey, state);
  reload();
  return 'reloading';
}

export async function resumeVisibleContentRecovery({
  storage,
  storageKey = VISIBLE_CONTENT_RECOVERY_STORAGE_KEY,
  signature,
  wait,
  delayMs = VISIBLE_CONTENT_RECOVERY_DELAY_MS
}: {
  storage?: RecoveryStorage;
  storageKey?: string;
  signature: string;
  wait: (delayMs: number) => Promise<void>;
  delayMs?: number;
}): Promise<boolean> {
  const state = readState(storage, storageKey);
  if (!state || state.signature !== signature || state.phase !== 'waiting') {
    return false;
  }

  state.phase = 'scanning';
  writeState(storage, storageKey, state);
  await wait(delayMs);
  return true;
}

type VideoRouteRoot = {
  innerText?: string;
  textContent?: string | null;
  querySelector?: (selector: string) => unknown;
  querySelectorAll: (selector: string) => ArrayLike<unknown>;
};

const videoFailureMessages = ['视频文件损坏', '网络错误导致视频下载中途失败', '视频因格式不支持', '网络的问题无法加载'];

export function shouldWaitAfterVideoRouteSwitch(
  switchedAt: number | undefined,
  now = Date.now(),
  graceMs = VIDEO_ROUTE_SWITCH_GRACE_MS
): boolean {
  return typeof switchedAt === 'number' && Number.isFinite(switchedAt) && now >= switchedAt && now - switchedAt < graceMs;
}

export function isVideoLoadFailure(root: VideoRouteRoot | null | undefined): boolean {
  if (!root) {
    return false;
  }

  const errorRoot = typeof root.querySelector === 'function'
    ? (root.querySelector('[id^="vjserrdisplay-"], .vjs-modal-dialog-content') as VideoRouteRoot | null) ?? root
    : root;
  const text = String(errorRoot.innerText ?? errorRoot.textContent ?? '');
  return videoFailureMessages.some((message) => text.includes(message));
}

export function trySwitchVideoRoute(root: VideoRouteRoot | null | undefined, attemptedControls?: Set<unknown>): boolean {
  if (!root || !isVideoLoadFailure(root)) {
    return false;
  }

  const controls = Array.from(root.querySelectorAll('input[type="radio"]')) as Array<{
    disabled?: boolean;
    checked?: boolean;
    value?: string;
    ariaLabel?: string;
    ariaDisabled?: string;
    click?: () => void;
  }>;
  const next = controls.find((control) => {
    const routeKey = control.value || control.ariaLabel || control;
    return !control.disabled && control.ariaDisabled !== 'true' && !control.checked && !attemptedControls?.has(routeKey);
  });
  if (next?.click) {
    attemptedControls?.add(next.value || next.ariaLabel || next);
    next.click();
    return true;
  }

  return false;
}
