import {
  DEEP_THINKING_KIND, DEEP_THINKING_KEYS, isDeepThinkingTarget, readDeepThinkingState
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
    sendMessage(message: Record<string, unknown>): Promise<{ saved?: boolean } | undefined>;
  } };
  __CXPLUS_AGREEMENT_PRESENTATION__?: AgreementPresentation;
};

const globals = globalThis as GuideGlobals;
let state = readDeepThinkingState();
let refreshCurrent = () => Promise.resolve();
let reopenGuide = () => {};
const observers = new Set<() => void>();

export const browserDeepThinkingEnabled = () => state.enabled;
export const browserDeepThinkingPrompted = () => state.prompted;
export const openBrowserDeepThinkingGuide = () => reopenGuide();
export const onBrowserDeepThinkingChanged = (callback: () => void) => { observers.add(callback); };

export async function writeBrowserDeepThinking(operation: 'choose' | 'change', enabled: boolean, expected?: boolean) {
  if (!browserExtensionRuntime() || !globals.__CXPLUS_AGREEMENT_PRESENTATION__?.isAccepted()) return false;
  try {
    const answer = await globals.chrome?.runtime?.sendMessage({ kind: DEEP_THINKING_KIND, operation, enabled, expected });
    await refreshCurrent();
    return answer?.saved === true;
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
  let loaded = false;
  let generation = 0;
  let dismissed = false;
  let manualEnable = false;
  let dialog: ReturnType<typeof mountDeepThinkingDialog> | undefined;
  let displayed: 'choose' | 'change' | undefined;

  function render() {
    let mode: typeof displayed;
    if (active && loaded && presentation?.isAccepted()) {
      if (!state.prompted && !dismissed) mode = 'choose';
      else if (manualEnable && state.prompted && !state.enabled) mode = 'change';
    }
    if (mode === displayed) return;
    displayed = mode;
    dialog?.destroy();
    dialog = undefined;
    if (mode !== 'change') manualEnable = false;
    if (!mode) return;
    dialog = mountDeepThinkingDialog({
      dismiss() { dismissed = true; manualEnable = false; render(); },
      choose: enabled => {
        if (mode === 'choose') return writeBrowserDeepThinking('choose', enabled);
        if (enabled) return writeBrowserDeepThinking('change', true, false);
        manualEnable = false;
        render();
        return Promise.resolve(true);
      }
    });
  }
  async function refresh() {
    const request = ++generation;
    try {
      const values = await storage?.local.get(DEEP_THINKING_KEYS);
      if (!active || request !== generation) return;
      const next = readDeepThinkingState(values);
      const changed = next.enabled !== state.enabled || next.prompted !== state.prompted;
      state = next;
      loaded = true;
      render();
      if (changed) for (const listener of observers) listener();
    } catch { /* On read failure keep the last verified value; a later change or explicit retry rereads. */ }
  }
  const changed: StorageChanged = (changes, areaName) => {
    if (active && areaName === 'local' && DEEP_THINKING_KEYS.some(key => key in changes)) void refresh();
  };
  async function mount() {
    if (active) return;
    active = true;
    loaded = false;
    try { storage?.onChanged.addListener(changed); } catch { /* Extension context invalidated. */ }
    presentation?.addEventListener('change', render);
    await refresh();
    render();
  }
  function unmount() {
    active = false;
    ++generation;
    try { storage?.onChanged.removeListener(changed); } catch { /* Extension context invalidated. */ }
    presentation?.removeEventListener('change', render);
    render();
  }
  refreshCurrent = refresh;
  reopenGuide = () => {
    dismissed = false;
    manualEnable = state.prompted;
    if (loaded) render();
    else void refresh();
  };
  window.addEventListener('pagehide', unmount);
  window.addEventListener('pageshow', mount);
  await mount();
}
