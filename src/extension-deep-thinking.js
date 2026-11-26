// One storage policy for the isolated runtime and MV3 worker. Never read a page's DOM/localStorage.
export const DEEP_THINKING_KIND = 'chaoxing-plus:deep-thinking';
export const DEEP_THINKING_SETTINGS_PAGE = 'popup.html#deep-thinking';
export const DEEP_THINKING_KEYS = [
  'deepThinkingEnabled', 'hasPromptedDeepThinking', 'cx.new.study.deepThinking', 'common.settings.work-options'
];
const [enabledKey, promptedKey, legacyKey, optionsKey] = DEEP_THINKING_KEYS;

export function readDeepThinkingState(values = {}) {
  const enabled = values[enabledKey];
  const prompted = values[promptedKey];
  if (prompted === true && typeof enabled === 'boolean') return { enabled, prompted: true };
  // Legacy Chrome settings may still have an enabled switch, but not the explicit-choice marker.
  // A malformed/out-of-order new record cannot opt the user into a potentially costlier mode.
  const legacy = values[legacyKey] === undefined ? values[optionsKey]?.deepThinking : values[legacyKey];
  return { enabled: enabled === undefined && (prompted === undefined || prompted === false) && legacy === true, prompted: false };
}

export function deepThinkingChoice(enabled) {
  return { [enabledKey]: enabled, [promptedKey]: true, [legacyKey]: enabled };
}

export function isDeepThinkingTarget(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol)
      && (url.hostname === 'chaoxing.com' || url.hostname.endsWith('.chaoxing.com'));
  } catch { return false; }
}
