(() => {
  const KIND = 'chaoxing-plus:agreement';
  const VIEW = 'agreement.view.v1';
  const configKeys = ['common.settings.tiku-adapter.baseurl', 'common.settings.tiku-adapter.key', 'common.settings.device-id',
    'common.settings.device-instance', 'common.settings.tiku-adapter.script-identity', 'common.settings.extension-enabled'];
  const internal = location.href === chrome.runtime.getURL('extension-agreement.html');
  const top = window === window.top;
  let active = false;
  let view, current, poll, refreshSerial = 0;

  const send = (operation, data) => {
    try {
      return chrome.runtime.sendMessage({ kind: KIND, operation, ...data }).catch(() => null);
    } catch { return Promise.resolve(null); }
  };
  const check = async event => {
    const data = event.detail;
    if (!active || !data || typeof data.id !== 'string' || data.id.length > 96
      || typeof data.base !== 'string' || data.base.length > 2048
      || typeof data.keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.keyHash)) return;
    const result = navigator.onLine ? await send('authorize', { base: data.base, keyHash: data.keyHash }) : null;
    if (!active) return;
    document.dispatchEvent(new CustomEvent('chaoxing-plus:agreement-result', {
      detail: { id: data.id, allowed: result?.allowed === true && navigator.onLine }
    }));
  };
  function render(next) {
    current = next;
    view?.render(next);
  }
  async function refresh(online = false) {
    const serial = ++refreshSerial;
    const result = await send('refresh', { online });
    if (active && serial === refreshSerial) render(result);
  }
  function changed(changes, area) {
    if (!active || area !== 'local') return;
    if (configKeys.some(key => key in changes)) {
      refreshSerial++;
      render(null);
      // The service worker rechecks and publishes an authoritative view.
    } else if (changes[VIEW]) {
      refreshSerial++;
      render(changes[VIEW].newValue);
    }
  }
  function onOnline(event) { if (event.isTrusted) void refresh(true); }
  function onOffline(event) {
    if (!event.isTrusted) return;
    refreshSerial++;
    render(current ? { ...current, phase: 'offline', canSign: false } : null);
    void send('abandon');
  }
  function onVisible() { if (document.visibilityState === 'visible') void refresh(); }

  function mount() {
    if (active) return;
    active = true;
    if (!internal) document.addEventListener('chaoxing-plus:agreement-check', check);
    if (!top && !internal) return;
    view = mountCxAgreement({ internal, send });
    chrome.storage.onChanged.addListener(changed);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    poll = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60000);
    void refresh();
  }
  function unmount() {
    if (!active) return;
    active = false;
    refreshSerial++;
    document.removeEventListener('chaoxing-plus:agreement-check', check);
    if (!view) return;
    clearInterval(poll);
    chrome.storage.onChanged.removeListener(changed);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
    view.destroy();
    view = undefined;
  }
  window.addEventListener('pagehide', unmount);
  window.addEventListener('pageshow', mount);
  if (document.body || (!top && !internal)) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
