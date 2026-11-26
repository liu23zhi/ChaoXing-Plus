import { AGREEMENT_VIEW_KEY } from './extension-agreement-core.js';
import { DEEP_THINKING_KEYS, DEEP_THINKING_KIND, DEEP_THINKING_SETTINGS_PAGE } from './extension-deep-thinking.js';

const section = document.getElementById('deep-thinking-settings');
if (section && window === window.top && location.href === chrome.runtime.getURL(DEEP_THINKING_SETTINGS_PAGE)) {
  const status = document.getElementById('deep-thinking-status');
  const notice = document.getElementById('deep-thinking-notice');
  const enable = document.getElementById('deep-thinking-enable');
  const disable = document.getElementById('deep-thinking-disable');
  let state, generation = 0, pending = false;

  function render() {
    const available = state?.allowed === true && !pending;
    enable.disabled = !available || (state?.prompted === true && state.enabled);
    disable.disabled = !available || (state?.prompted === true && !state.enabled);
    status.textContent = !state ? '正在读取设置，或暂时无法读取。'
      : !state.allowed ? '当前无法更改。请先在扩展中确认用户协议，并确保扩展已启用。'
      : !state.prompted ? '尚未记录明确选择。'
      : state.enabled ? '深度思考已开启。' : '深度思考已关闭。';
  }
  async function refresh() {
    const request = ++generation;
    state = undefined;
    render();
    try {
      const savedState = await chrome.runtime.sendMessage({ kind: DEEP_THINKING_KIND, operation: 'inspect' });
      if (request === generation) state = savedState;
    } catch { /* No choice is available without a successful read. */ }
    render();
  }
  async function choose(event, enabled) {
    if (!event.isTrusted || pending || !state?.allowed) return;
    const record = state;
    pending = true;
    notice.textContent = '';
    render();
    let saved = false;
    try {
      const response = await chrome.runtime.sendMessage({ kind: DEEP_THINKING_KIND,
        operation: record.prompted ? 'change' : 'choose', expected: record.enabled, enabled });
      saved = response?.saved === true;
    } catch { /* Report failure and wait for another explicit choice. */ }
    pending = false;
    await refresh();
    notice.textContent = saved ? '已同步共享设置，可以关闭此页。' : '未能保存选择，请重试。';
  }
  enable.addEventListener('click', event => { void choose(event, true); });
  disable.addEventListener('click', event => { void choose(event, false); });
  const watched = [...DEEP_THINKING_KEYS, AGREEMENT_VIEW_KEY, 'common.settings.extension-enabled',
    'common.settings.device-instance', 'common.settings.tiku-adapter.script-identity'];
  const changed = (changes, area) => {
    if (area === 'local' && watched.some(key => key in changes)) void refresh();
  };
  function mount() {
    chrome.storage.onChanged.addListener(changed);
    void refresh();
  }
  window.addEventListener('focus', refresh);
  window.addEventListener('pagehide', () => {
    ++generation;
    chrome.storage.onChanged.removeListener(changed);
  });
  window.addEventListener('pageshow', event => { if (event.persisted) mount(); });
  mount();
}
