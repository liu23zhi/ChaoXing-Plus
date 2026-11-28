// Copied only into the temporary, owned MV3 test package; never imported by the normal build.
export const AGREEMENT_KIND = 'chaoxing-plus:agreement';

export function isOnlyAllowed(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && Object.hasOwn(value, 'allowed')
    && typeof value.allowed === 'boolean';
}

export function authorizeOwnedHostRequest(runtime, scope, message, sender, timeoutMs = 5000) {
  if (!sender || sender.id !== runtime.id || sender.frameId !== 0
    || !Number.isInteger(sender.tab?.id) || sender.tab.id < 0
    || typeof sender.documentId !== 'string' || !sender.documentId
    || sender.url !== scope.url || sender.origin !== scope.origin
    || !message || Object.keys(message).length !== 4
    || message.kind !== AGREEMENT_KIND || message.operation !== 'authorize'
    || message.base !== scope.shapeBase || message.keyHash !== scope.shapeHash
    || typeof runtime.sendNativeMessage !== 'function') return Promise.resolve({ allowed: false });

  return new Promise(resolve => {
    const finish = allowed => {
      clearTimeout(timer);
      resolve({ allowed });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      // Do not forward the message, a browser/profile ID, configuration, or any credential.
      runtime.sendNativeMessage(scope.hostName, { operation: 'agreement-status' }, reply => {
        try {
          finish(!runtime.lastError && isOnlyAllowed(reply) && reply.allowed);
        } catch {
          finish(false);
        }
      });
    } catch {
      finish(false);
    }
  });
}

export function instrumentOwnedWorker(stock, scope) {
  const marker = '    const op = message.operation;';
  if (stock.split(marker).length !== 2) throw new Error('Owned authorization test seam changed');
  const fencedBranch = `${marker}
    if (op === 'authorize') {
      void authorizeOwnedHostRequest(chrome.runtime, ownedScope, message, sender)
        .then(sendResponse, () => sendResponse({ allowed: false }));
      return true;
    }`;
  return `import { authorizeOwnedHostRequest } from './host-result.js';\nconst ownedScope = Object.freeze(${JSON.stringify(scope)});\n` + stock.replace(marker, fencedBranch);
}
