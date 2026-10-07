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
  querySelectorAll?: (selector: string) => ArrayLike<unknown>;
};

const videoFailureMessages = ['视频文件损坏', '网络错误导致视频下载中途失败', '视频因格式不支持', '网络的问题无法加载'];

type VideoRouteControlDiagnostics = {
  key: string;
  checked: boolean;
  disabled: boolean;
};

type VideoRouteControl = {
  id?: string;
  value?: string;
  ariaLabel?: string;
  checked?: boolean;
  disabled?: boolean;
  ariaDisabled?: string;
  click?: () => void;
};

function getVideoRouteControls(root: VideoRouteRoot) {
  const controls = Array.from(root.querySelectorAll?.('input[type="radio"]') ?? []) as VideoRouteControl[];
  const identities = controls.map((control) => {
    if (control.id) return `id:${control.id}`;
    if (control.ariaLabel) return `label:${control.ariaLabel}`;
    return control.value && control.value !== 'on' ? `value:${control.value}` : '';
  });
  return controls.map((control, index) => ({
    control,
    key: identities[index] && identities.indexOf(identities[index]) === identities.lastIndexOf(identities[index])
      ? identities[index]
      : `route-${index + 1}`
  }));
}

function isVideoErrorElementVisible(element: HTMLElement | null): boolean {
  if (!element || element.isConnected === false) {
    return false;
  }
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden) {
      return false;
    }
    const style = current.ownerDocument?.defaultView?.getComputedStyle(current) ?? current.style;
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse' || style?.opacity === '0') {
      return false;
    }
  }
  return true;
}

export type VideoLoadDiagnostics = {
  failureTextDetected: boolean;
  errorText: string;
  errorElementFound: boolean;
  errorElementVisible: boolean;
  mediaFound: boolean;
  mediaPaused?: boolean;
  mediaReadyState?: number;
  mediaCurrentTime?: number;
  mediaDuration?: number;
  mediaNetworkState?: number;
  mediaErrorCode?: number;
  mediaErrorMessage?: string;
  mediaLoaded: boolean;
  mediaHasError: boolean;
  playbackHealthy: boolean;
  loadFailureDetected: boolean;
  loadFailureReason: 'media-error' | 'unloaded-error-display' | 'none';
  routeControls: VideoRouteControlDiagnostics[];
};

export function inspectVideoLoadState(root: VideoRouteRoot | null | undefined): VideoLoadDiagnostics {
  if (!root) {
    return {
      failureTextDetected: false,
      errorText: '',
      errorElementFound: false,
      errorElementVisible: false,
      mediaFound: false,
      mediaLoaded: false,
      mediaHasError: false,
      playbackHealthy: false,
      loadFailureDetected: false,
      loadFailureReason: 'none',
      routeControls: []
    };
  }

  const errorElement = typeof root.querySelector === 'function'
    ? (root.querySelector('[id^="vjserrdisplay-"], .vjs-modal-dialog-content') as HTMLElement | null) ?? null
    : null;
  const errorText = String(errorElement?.innerText ?? errorElement?.textContent ?? root.innerText ?? root.textContent ?? '');
  const media = typeof root.querySelector === 'function'
    ? (root.querySelector('video, audio') as {
      paused?: boolean;
      readyState?: number;
      currentTime?: number;
      duration?: number;
      networkState?: number;
      error?: { code?: number; message?: string } | null;
    } | null) ?? null
    : null;
  const mediaError = media?.error ?? null;
  const routeControls = getVideoRouteControls(root).map(({ control, key }) => ({
    key,
    checked: control.checked === true,
    disabled: control.disabled === true || control.ariaDisabled === 'true'
  }));
  const mediaHasError = Boolean(mediaError);
  // Pausing or buffering does not invalidate metadata already loaded for this resource.
  const mediaLoaded = Boolean(media && (media.readyState ?? 0) >= 1 && !mediaError);
  const playbackHealthy = Boolean(media && media.paused === false && (media.readyState ?? 0) >= 2 && !mediaError);
  const failureTextDetected = videoFailureMessages.some((message) => errorText.includes(message));
  const errorElementVisible = isVideoErrorElementVisible(errorElement);
  const hasUnusableSource = !media || media.networkState === 0 || media.networkState === 3 || media.networkState === undefined;
  const textFailure = failureTextDetected && (errorElement ? errorElementVisible : true) && !mediaLoaded && hasUnusableSource;
  const loadFailureReason = mediaHasError ? 'media-error' : textFailure ? 'unloaded-error-display' : 'none';

  return {
    failureTextDetected,
    errorText,
    errorElementFound: errorElement !== null,
    errorElementVisible,
    mediaFound: media !== null,
    mediaPaused: media?.paused,
    mediaReadyState: media?.readyState,
    mediaCurrentTime: media?.currentTime,
    mediaDuration: media?.duration,
    mediaNetworkState: media?.networkState,
    mediaErrorCode: mediaError?.code,
    mediaErrorMessage: mediaError?.message,
    mediaLoaded,
    mediaHasError,
    playbackHealthy,
    loadFailureDetected: loadFailureReason !== 'none',
    loadFailureReason,
    routeControls
  };
}

export function shouldWaitAfterVideoRouteSwitch(
  switchedAt: number | undefined,
  now = Date.now(),
  graceMs = VIDEO_ROUTE_SWITCH_GRACE_MS
): boolean {
  return typeof switchedAt === 'number' && Number.isFinite(switchedAt) && now >= switchedAt && now - switchedAt < graceMs;
}

export function isVideoLoadFailure(root: VideoRouteRoot | null | undefined): boolean {
  return inspectVideoLoadState(root).loadFailureDetected;
}

export function trySwitchVideoRoute(root: VideoRouteRoot | null | undefined, attemptedControls?: Set<unknown>): boolean {
  if (!root || !isVideoLoadFailure(root)) {
    return false;
  }

  const controls = getVideoRouteControls(root);
  for (const { control, key } of controls) {
    if (control.checked) {
      attemptedControls?.add(key);
    }
  }
  const next = controls.find(({ control, key }) => (
    !control.disabled && control.ariaDisabled !== 'true' && !control.checked && typeof control.click === 'function' && !attemptedControls?.has(key)
  ));
  if (next) {
    attemptedControls?.add(next.key);
    next.control.click?.();
    return true;
  }

  return false;
}
