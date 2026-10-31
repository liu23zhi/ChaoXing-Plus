export interface TabAnswerPauseController {
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  subscribe(listener: () => void): () => void;
  canReload(): boolean;
}

const controllerKey = '__chaoxing_plus_tab_answer_pause__';
const pausedAttribute = 'data-chaoxing-plus-tab-paused';
const readyAttribute = 'data-chaoxing-plus-tab-pause-ready';
const requestEvent = 'chaoxing-plus:tab-pause-request';
const changedEvent = 'chaoxing-plus:tab-pause-change';

export function getTabAnswerPauseController(frameWindow: Window = window): TabAnswerPauseController {
  let owner = frameWindow;
  try {
    if (frameWindow.top?.document.documentElement) owner = frameWindow.top;
  } catch { /* Cross-origin frames receive the extension's tab broadcasts directly. */ }
  const shared = owner as unknown as Record<string, TabAnswerPauseController | undefined>;
  if (shared[controllerKey]) return shared[controllerKey]!;
  const root = owner.document.documentElement;
  let paused = root?.getAttribute(pausedAttribute) === 'true';
  let serial = 0;
  const listeners = new Set<() => void>();
  const update = () => {
    const next = root?.getAttribute(pausedAttribute) === 'true';
    if (next === paused) return;
    paused = next;
    for (const listener of listeners) listener();
  };
  owner.document.addEventListener(changedEvent, update);
  const controller: TabAnswerPauseController = {
    isPaused() { return paused; },
    setPaused(value) {
      if (typeof value !== 'boolean') return;
      const changed = paused !== value;
      paused = value;
      root?.setAttribute(pausedAttribute, String(value));
      owner.document.dispatchEvent(new CustomEvent(requestEvent, {
        detail: { paused: value, requestId: `${Date.now()}:${Math.random()}:${++serial}` }
      }));
      if (changed) for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    canReload() {
      return !paused || (root?.getAttribute(readyAttribute) === 'extension'
        && root.getAttribute('data-chaoxing-plus-tab-pause-pending') !== 'true');
    }
  };
  shared[controllerKey] = controller;
  return controller;
}
