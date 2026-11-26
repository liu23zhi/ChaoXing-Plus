import { AGREEMENT_VIEW_KEY } from './extension-agreement-core.js';
import {
  DEEP_THINKING_KIND, DEEP_THINKING_KEYS, deepThinkingChoice, isDeepThinkingTarget, readDeepThinkingState
} from './extension-deep-thinking.js';

const modeKeys = ['common.settings.extension-enabled', 'common.settings.device-instance',
  'common.settings.tiku-adapter.script-identity'];

export function registerDeepThinking(chrome) {
  let pending = Promise.resolve();
  function enqueue(message) {
    // The first successful explicit choice wins. A stale guide button in another tab cannot
    // overwrite it; later, the existing real switch can update the same record deliberately.
    const task = pending.then(async () => {
      const local = chrome.storage.local;
      const values = await local.get([...DEEP_THINKING_KEYS, AGREEMENT_VIEW_KEY, ...modeKeys]);
      if (values[modeKeys[0]] === false || modeKeys.slice(1).some(key => values[key])
        || values[AGREEMENT_VIEW_KEY]?.phase !== 'accepted') return { saved: false };
      const state = readDeepThinkingState(values);
      if (message.operation === 'choose' && state.prompted) return { saved: true };
      if (message.operation === 'change' && (!state.prompted || message.expected !== state.enabled)) {
        return { saved: false };
      }
      await local.set(deepThinkingChoice(message.enabled));
      return { saved: true };
    });
    pending = task.catch(() => ({ saved: false }));
    return pending;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.kind !== DEEP_THINKING_KIND || sender.id !== chrome.runtime.id || sender.frameId !== 0
      || !Number.isInteger(sender.tab?.id) || !isDeepThinkingTarget(sender.url)
      || typeof message.enabled !== 'boolean' || (message.operation !== 'choose'
        && !(message.operation === 'change' && typeof message.expected === 'boolean'))) return false;
    void enqueue(message).then(respond);
    return true;
  });
}
