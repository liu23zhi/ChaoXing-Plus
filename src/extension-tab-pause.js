(() => {
  const kind = 'chaoxing-plus:tab-answer-pause';
  const values = new Map();
  const durability = new Map();
  const queues = new Map();
  const removed = new Set();
  const storageKey = (tabId) => `answer-pause.tab:${tabId}`;
  const session = chrome.storage.session;
  const read = (tabId) => new Promise((resolve) => {
    if (values.has(tabId) || !session) {
      resolve(values.get(tabId) === true);
      return;
    }
    try {
      session.get(storageKey(tabId), (result) => {
        const failed = Boolean(chrome.runtime.lastError);
        const paused = failed || result?.[storageKey(tabId)] === true;
        values.set(tabId, paused);
        durability.set(tabId, !failed);
        resolve(paused);
      });
    } catch {
      values.set(tabId, true);
      durability.set(tabId, false);
      resolve(true);
    }
  });
  const write = (tabId, paused) => new Promise((resolve) => {
    values.set(tabId, paused);
    if (!session) { durability.set(tabId, false); resolve(); return; }
    try {
      session.set({ [storageKey(tabId)]: paused }, () => {
        durability.set(tabId, !chrome.runtime.lastError);
        resolve();
      });
    } catch {
      durability.set(tabId, false);
      resolve();
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const tabId = sender.tab?.id;
    if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId) || tabId < 0
      || message?.kind !== kind || !['read', 'write'].includes(message.operation)
      || typeof message.requestId !== 'string' || message.requestId.length > 160
      || (message.operation === 'write' && typeof message.paused !== 'boolean')) return false;

    const work = (queues.get(tabId) || Promise.resolve()).then(async () => {
      if (removed.has(tabId)) return;
      let paused = await read(tabId);
      if (removed.has(tabId)) return;
      if (message.operation === 'write') {
        paused = message.paused;
        await write(tabId, paused);
        if (removed.has(tabId)) return;
        chrome.tabs.sendMessage(tabId, { kind, paused, durable: durability.get(tabId) === true,
          tabIdentity: String(tabId), requestId: message.requestId }, () => {
          void chrome.runtime.lastError;
        });
      }
      respond({ kind, paused, durable: durability.get(tabId) === true,
        tabIdentity: String(tabId), requestId: message.requestId });
    }).catch(() => {
      values.set(tabId, true);
      durability.set(tabId, false);
      respond({ kind, paused: true, durable: false, tabIdentity: String(tabId), requestId: message.requestId });
    });
    queues.set(tabId, work);
    void work.finally(() => { if (queues.get(tabId) === work) queues.delete(tabId); });
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    removed.add(tabId);
    const cleanup = () => {
      values.delete(tabId);
      durability.delete(tabId);
      queues.delete(tabId);
      session?.remove(storageKey(tabId), () => { void chrome.runtime.lastError; });
    };
    void (queues.get(tabId) || Promise.resolve()).finally(cleanup);
  });
})();
