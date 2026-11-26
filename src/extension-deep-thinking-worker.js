import { AGREEMENT_VIEW_KEY } from './extension-agreement-core.js';
import {
  DEEP_THINKING_KIND, DEEP_THINKING_KEYS, DEEP_THINKING_SETTINGS_PAGE,
  deepThinkingChoice, isDeepThinkingTarget, readDeepThinkingState
} from './extension-deep-thinking.js';

const modeKeys = ['common.settings.extension-enabled', 'common.settings.device-instance',
  'common.settings.tiku-adapter.script-identity'];

export function registerDeepThinking(chrome) {
  const settingsUrl = chrome.runtime.getURL(DEEP_THINKING_SETTINGS_PAGE);
  let pending = Promise.resolve();
  async function inspect() {
    const values = await chrome.storage.local.get([...DEEP_THINKING_KEYS, AGREEMENT_VIEW_KEY, ...modeKeys]);
    const allowed = values[modeKeys[0]] !== false && !modeKeys.slice(1).some(key => values[key])
      && values[AGREEMENT_VIEW_KEY]?.phase === 'accepted';
    return { ...readDeepThinkingState(values), allowed };
  }
  function enqueue(message) {
    // The first successful explicit choice wins. A stale settings tab cannot overwrite it;
    // a later change must be based on the current, already-prompted value.
    const task = pending.then(async () => {
      const state = await inspect();
      if (!state.allowed) return { saved: false };
      if (message.operation === 'choose' && state.prompted) return { saved: true };
      if (message.operation === 'change' && (!state.prompted || message.expected !== state.enabled)) {
        return { saved: false };
      }
      await chrome.storage.local.set(deepThinkingChoice(message.enabled));
      return { saved: true };
    });
    pending = task.catch(() => ({ saved: false }));
    return pending;
  }
  async function open() {
    if (!(await inspect()).allowed) return { opened: false };
    await chrome.tabs.create({ url: settingsUrl });
    return { opened: true };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.kind !== DEEP_THINKING_KIND || sender.id !== chrome.runtime.id || sender.frameId !== 0
      || !Number.isInteger(sender.tab?.id)) return false;
    const op = message.operation;
    if (op === 'open' && isDeepThinkingTarget(sender.url) && Object.keys(message).length === 2) {
      void open().then(respond, () => respond({ opened: false }));
      return true;
    }
    // Even an isolated content script from a target website cannot inspect or write through this route.
    if (sender.url !== settingsUrl) return false;
    if (op === 'inspect') {
      void inspect().then(respond, () => respond(null));
      return true;
    }
    if (typeof message.enabled !== 'boolean' || (op !== 'choose'
      && !(op === 'change' && typeof message.expected === 'boolean'))) return false;
    void enqueue(message).then(respond);
    return true;
  });
}
