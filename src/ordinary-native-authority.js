// Only the signed native build enables this path. storage.session stays
// trusted-context-only; its public connection locator is not an authorization.
const SLOT = 'cxplus.ordinary.native.v1';
const HOST_PREFIX = 'org.cxplus.ordinary_';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const deny = () => ({ allowed: false });
const pendingReads = new WeakMap();

export function isNativeContent(sender) {
  if (!Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId) || sender.frameId < 0
      || typeof sender.documentId !== 'string' || !sender.documentId || sender.documentLifecycle !== 'active') return false;
  try {
    const url = new URL(sender.url);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      && url.origin === sender.origin
      && (url.hostname === 'chaoxing.com' || url.hostname.endsWith('.chaoxing.com'));
  } catch { return false; }
}

async function query(chrome, timeoutMs) {
  if (!chrome.storage.session || typeof chrome.runtime.sendNativeMessage !== 'function') return deny();
  return new Promise(resolve => {
    let pending = true;
    const timer = setTimeout(() => finish(deny()), timeoutMs);
    const finish = value => {
      if (!pending) return;
      pending = false;
      clearTimeout(timer);
      resolve(value);
    };
    void (async () => {
      const state = (await chrome.storage.session.get(SLOT))[SLOT];
      if (!state || Object.keys(state).length !== 2 || typeof state.instance !== 'string' || !UUID.test(state.instance)
          || state.hostName !== HOST_PREFIX + state.instance.replaceAll('-', '')) return finish(deny());
      if (!pending) return;
      chrome.runtime.sendNativeMessage(state.hostName, { op: 'authorize', instance: state.instance }, result => {
        if (chrome.runtime.lastError || !result || Object.keys(result).length !== 1
            || !Object.hasOwn(result, 'allowed') || typeof result.allowed !== 'boolean') return finish(deny());
        finish({ allowed: result.allowed });
      });
    })().catch(() => finish(deny()));
  });
}

// Chrome's instance has one pipe. Share only a currently running check, not its
// completed value (an authorization or device can be revoked between calls).
export function readNativeAuthorization(chrome, timeoutMs = 18000) {
  let read = pendingReads.get(chrome);
  if (!read) {
    read = query(chrome, timeoutMs).finally(() => pendingReads.delete(chrome));
    pendingReads.set(chrome, read);
  }
  return read;
}
