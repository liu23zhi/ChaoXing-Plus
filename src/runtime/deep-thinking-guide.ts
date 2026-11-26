import {
  DEEP_THINKING_KIND, DEEP_THINKING_KEYS, isDeepThinkingTarget, readDeepThinkingState, type DeepThinkingState
} from '../extension-deep-thinking.js';
import { browserExtensionRuntime } from './agreement-gate.js';
import { mountDeepThinkingDialog } from './deep-thinking-view.js';

type StorageChanged = (changes: Record<string, unknown>, areaName: string) => void;
type LocalStorage = {
  local: { get(keys: string[]): Promise<Record<string, unknown>> };
  onChanged: { addListener(listener: StorageChanged): void; removeListener(listener: StorageChanged): void };
};
type AgreementPresentation = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { isAccepted(): boolean };
type GuideGlobals = {
  chrome?: { storage?: LocalStorage; runtime?: {
    sendMessage(message: Record<string, unknown>): Promise<{ opened?: boolean } | undefined>;
  } };
  __CXPLUS_AGREEMENT_PRESENTATION__?: AgreementPresentation;
};

const globals = globalThis as GuideGlobals;
// Undefined is not a fresh/no-choice record: do not offer the guide or consume historical true until read succeeds.
let state: DeepThinkingState | undefined;
const observers = new Set<() => void>();

export const browserDeepThinkingEnabled = () => state?.enabled === true;
export const onBrowserDeepThinkingChanged = (callback: () => void) => { observers.add(callback); };

export async function openBrowserDeepThinkingSettings() {
  if (!browserExtensionRuntime() || !globals.__CXPLUS_AGREEMENT_PRESENTATION__?.isAccepted()) return false;
  try {
    // Website UI can only request navigation. The extension-owned document makes the choice.
    const answer = await globals.chrome?.runtime?.sendMessage({ kind: DEEP_THINKING_KIND, operation: 'open' });
    return answer?.opened === true;
  } catch {
    return false;
  }
}

export async function startBrowserDeepThinking() {
  const storage = globals.chrome?.storage;
  if (!browserExtensionRuntime() || !storage) return;
  const presentation = window === window.top && isDeepThinkingTarget(location.href)
    ? globals.__CXPLUS_AGREEMENT_PRESENTATION__ : undefined;
  let active = false;
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let dismissed = false;
  let dialog: ReturnType<typeof mountDeepThinkingDialog> | undefined;

  function render() {
    if (active && state && !state.prompted && !dismissed && presentation?.isAccepted()) {
      dialog ??= mountDeepThinkingDialog({
        dismiss() { dismissed = true; render(); },
        open: openBrowserDeepThinkingSettings
      });
    } else {
      dialog?.destroy();
      dialog = undefined;
    }
  }
  function publish(next: DeepThinkingState | undefined) {
    const previousEnabled = browserDeepThinkingEnabled();
    state = next;
    render();
    if (previousEnabled !== browserDeepThinkingEnabled()) for (const listener of observers) listener();
  }
  function clearRetry() {
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
  }
  async function refresh(retryOnce = true) {
    clearRetry();
    const request = ++generation;
    publish(undefined);
    try {
      const values = await storage?.local.get(DEEP_THINKING_KEYS);
      if (!active || request !== generation) return;
      publish(readDeepThinkingState(values));
    } catch {
      if (active && request === generation && retryOnce) retry = setTimeout(() => { void refresh(false); }, 350);
    }
  }
  const changed: StorageChanged = (changes, areaName) => {
    if (active && areaName === 'local' && DEEP_THINKING_KEYS.some(key => key in changes)) void refresh();
  };
  function onFocus() {
    if (active && !state) void refresh();
  }
  async function mount() {
    if (active) return;
    active = true;
    try { storage?.onChanged.addListener(changed); } catch { /* Extension context invalidated. */ }
    presentation?.addEventListener('change', render);
    window.addEventListener('focus', onFocus);
    await refresh();
  }
  function unmount() {
    active = false;
    ++generation;
    clearRetry();
    try { storage?.onChanged.removeListener(changed); } catch { /* Extension context invalidated. */ }
    presentation?.removeEventListener('change', render);
    window.removeEventListener('focus', onFocus);
    publish(undefined);
  }
  window.addEventListener('pagehide', unmount);
  window.addEventListener('pageshow', mount);
  await mount();
}
