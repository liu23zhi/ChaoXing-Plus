import { AGREEMENT_CONFIG_KEYS, AGREEMENT_KIND, createAgreementController } from './extension-agreement-core.js';

export function registerAgreement(chrome, defaultBase) {
  const writes = chrome.storage.local;
  const controller = createAgreementController({
    read: keys => writes.get(keys), write: data => writes.set(data), remove: keys => writes.remove(keys), defaultBase
  });
  const internalPage = chrome.runtime.getURL('extension-agreement.html');
  const id = sender => [sender.tab?.id ?? -1, sender.frameId ?? 0, sender.documentId ?? sender.url].join(':');
  let refreshInProgress;
  function refresh(online) {
    refreshInProgress ??= controller.run('refresh', { online }).finally(() => { refreshInProgress = undefined; });
    return refreshInProgress;
  }
  const authorizations = new Map();
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.kind !== AGREEMENT_KIND || sender.id !== chrome.runtime.id) return false;
    const op = message.operation;
    const internal = sender.url === internalPage;
    const topContent = !internal && Number.isInteger(sender.tab?.id) && sender.frameId === 0
      && /^https?:\/\/(?:[^/]+\.)?chaoxing\.com(?::\d+)?(?:\/|$)/i.test(sender.url ?? '');
    let result;
    if (op === 'authorize' && !internal && Number.isInteger(sender.tab?.id)
      && typeof message.base === 'string' && message.base.length <= 2048
      && typeof message.keyHash === 'string' && /^[a-f0-9]{64}$/.test(message.keyHash)) {
      const check = message.base + '\n' + message.keyHash;
      result = authorizations.get(check);
      if (!result) {
        result = controller.run(op, message).finally(() => authorizations.delete(check));
        authorizations.set(check, result);
      }
    } else if (internal || topContent) {
      const reader = id(sender);
      if (op === 'refresh') {
        result = refresh(message.online === true);
      } else if (op === 'prepare' || op === 'accept') {
        if (typeof message.version !== 'string' || message.version.length > 48
          || typeof message.hash !== 'string' || !/^[a-f0-9]{64}$/.test(message.hash)) return false;
        result = controller.run(op, message, reader);
      } else if (op === 'abandon') {
        result = controller.run(op, {}, reader);
      }
    }
    if (!result) return false;
    void result.then(sendResponse, () => sendResponse(null));
    return true;
  });

  chrome.tabs.onRemoved.addListener(tab => controller.abandonTab(tab));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !AGREEMENT_CONFIG_KEYS.some(key => key in changes)) return;
    controller.changed();
    // Queue behind (not share) any in-flight refresh that used the previous configuration.
    void controller.run('refresh');
  });
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason !== 'install' && reason !== 'update') return;
    void (async () => {
      const settings = await writes.get(AGREEMENT_CONFIG_KEYS);
      if (settings['common.settings.device-instance'] || settings['common.settings.tiku-adapter.script-identity']) return;
      await controller.run('install');
      if (settings['common.settings.extension-enabled'] === false) return;
      // Incomplete remains set if Chrome refuses the tab or it is dismissed.
      await chrome.tabs.create({ url: internalPage }).catch(() => {});
    })().catch(() => {});
  });
}
