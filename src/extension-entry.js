(() => {
  // In the shipped manifest the extension app itself is an isolated content script.
  // The standalone bootstrap remains usable by older non-agreement fixtures.
  const isolated = typeof mountCxAgreement === 'function';
  let finishBoot;
  if (isolated) globalThis.__CXPLUS_EXTENSION_BOOT__ = new Promise(resolve => { finishBoot = resolve; });
  if (document.documentElement) run();
  else document.addEventListener('DOMContentLoaded', run, { once: true });

  function run() {
  const root = document.documentElement;
  if (!root) { finishBoot?.(false); return; }

  // Extension-owned events only: no URL, page payload, console arguments or credentials.
  const diagnostic = (event, duration_ms) => {
    if (!chrome.runtime?.id || !chrome.runtime.sendMessage || window !== window.top) return;
    try {
      chrome.runtime.sendMessage({ kind: 'chaoxing-plus:extension-diagnostics', op: 'record', event, duration_ms },
        () => { void chrome.runtime.lastError; });
    } catch { /* A suspended/reloaded extension must not interrupt normal use. */ }
  };
  window.addEventListener('offline', () => diagnostic('network.offline'));
  window.addEventListener('online', () => {
    if (window !== window.top) return;
    try { chrome.runtime.sendMessage({ kind:'chaoxing-plus:extension-diagnostics', op:'online' }, () => { void chrome.runtime.lastError; }); } catch { /* extension unloaded */ }
  });
  const extensionScript = chrome.runtime?.getURL?.('chaoxing-plus.js');
  window.addEventListener('error', e => {
    if (extensionScript && e.filename === extensionScript) diagnostic('runtime.error');
  });

  const panelSelectors = [
    '[id="panel-cx-new-study"]',
    '[id="panel-cx-new-study-dispatcher"]',
    '[id="panel-cx-guide"]',
    '[id="panel-common-settings"]',
    '[id="panel-common-apps"]',
    '[id="panel-common-render"]'
  ].join(', ');

  const sharedStorePrefixes = [
    'common.settings.',
    'cx.new.study.',
    'cx.new.work.',
    'cx.new.auto-read.',
    'cx.new.study-dispatcher.'
  ];
  const legacyDeepThinkingKey = 'cx.new.study.deepThinking';
  const sharedStoreExcludedKeys = new Set([
    'common.work-results.results',
    ...(isolated ? [legacyDeepThinkingKey] : [])
  ]);
  const sharedStoreExactKeys = new Set([
    'common.apps.question-caches'
  ]);
  const sharedStoreSyncEvent = 'chaoxing-plus:shared-store-sync';
  const sharedStoreHydrateEvent = 'chaoxing-plus:shared-store-hydrate';
  const swalAliasKey = '__chaoxing_plus_swal__';
  const tabPauseKind = 'chaoxing-plus:tab-answer-pause';
  const pendingPauseRequests = new Set();
  const applyTabPause = (message) => {
    if (message?.kind !== tabPauseKind || typeof message.paused !== 'boolean') return;
    if (typeof message.tabIdentity === 'string' && /^\d+$/.test(message.tabIdentity)) {
      root.setAttribute('data-chaoxing-plus-tab-identity', message.tabIdentity);
    }
    root.setAttribute('data-chaoxing-plus-tab-paused', String(message.paused));
    root.setAttribute('data-chaoxing-plus-tab-pause-ready', message.durable === true ? 'extension' : 'memory');
    document.dispatchEvent(new Event('chaoxing-plus:tab-pause-change'));
  };
  const markTabPauseUnavailable = () => {
    root.setAttribute('data-chaoxing-plus-tab-pause-ready', 'unavailable');
    document.dispatchEvent(new Event('chaoxing-plus:tab-pause-change'));
  };
  if (chrome.runtime.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (sender.id === chrome.runtime.id && pendingPauseRequests.size === 0) applyTabPause(message);
    });
  }
  document.addEventListener('chaoxing-plus:tab-pause-request', (event) => {
    const detail = event.detail;
    if (!detail || typeof detail.paused !== 'boolean' || typeof detail.requestId !== 'string'
      || detail.requestId.length > 160 || !chrome.runtime.sendMessage) return;
    pendingPauseRequests.add(detail.requestId);
    root.setAttribute('data-chaoxing-plus-tab-pause-pending', 'true');
    try {
      chrome.runtime.sendMessage({ kind: tabPauseKind, operation: 'write', paused: detail.paused, requestId: detail.requestId }, (response) => {
        void chrome.runtime.lastError;
        pendingPauseRequests.delete(detail.requestId);
        if (pendingPauseRequests.size === 0) {
          root.removeAttribute('data-chaoxing-plus-tab-pause-pending');
          if (response?.requestId === detail.requestId) applyTabPause(response);
          else root.setAttribute('data-chaoxing-plus-tab-pause-ready', 'unavailable');
        }
      });
    } catch {
      pendingPauseRequests.delete(detail.requestId);
      if (pendingPauseRequests.size === 0) root.removeAttribute('data-chaoxing-plus-tab-pause-pending');
      root.setAttribute('data-chaoxing-plus-tab-pause-ready', 'unavailable');
    }
  });
  const hydrateTabPause = () => new Promise((resolve) => {
    if (!chrome.runtime.sendMessage) { resolve(); return; }
    const requestId = `init:${Date.now()}:${Math.random()}`;
    const timer = setTimeout(() => {
      markTabPauseUnavailable();
      resolve();
    }, 2000);
    try {
      chrome.runtime.sendMessage({ kind: tabPauseKind, operation: 'read', requestId }, (response) => {
        void chrome.runtime.lastError;
        clearTimeout(timer);
        if (response?.requestId === requestId) applyTabPause(response);
        else markTabPauseUnavailable();
        resolve();
      });
    } catch {
      clearTimeout(timer);
      markTabPauseUnavailable();
      resolve();
    }
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      root.setAttribute('data-chaoxing-plus-tab-paused', 'true');
      document.dispatchEvent(new Event('chaoxing-plus:tab-pause-change'));
      void hydrateTabPause();
    }
  });

  const shouldShareStoreKey = (key) => (
    typeof key === 'string'
    && sharedStoreExcludedKeys.has(key) === false
    && (sharedStoreExactKeys.has(key) || sharedStorePrefixes.some((prefix) => key.startsWith(prefix)))
  );

  const getSharedAttributeName = (key) => `data-chaoxing-plus-shared-${key.replace(/[^a-z0-9_-]/gi, '-')}`;

  if (isolated) {
    // The paid-mode preference is now read from trusted Chrome storage, never a page mirror.
    root.removeAttribute(getSharedAttributeName(legacyDeepThinkingKey));
    try { localStorage.removeItem(legacyDeepThinkingKey); } catch { /* including opaque frames */ }
  }

  const serializeSharedValue = (value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  };

  const baseKey = 'common.settings.tiku-adapter.baseurl';
  const keyKey = 'common.settings.tiku-adapter.key';
  const deviceKey = 'common.settings.device-id';
  const bindingKey = 'agreement.approved-provider.v1';
  const privateKeys = new Set([baseKey, keyKey, deviceKey, bindingKey, 'common.settings.device-instance',
    'common.settings.tiku-adapter.script-identity', 'common.settings.tiku-adapter.script-session-token']);
  const privateValues = {};
  let providerRevision = 0;
  if (isolated) {
    globalThis.__CXPLUS_PRIVATE_SETTINGS__ = {
      has: key => privateKeys.has(key),
      revision: () => providerRevision,
      get(key) {
        if (key !== keyKey) return privateValues[key];
        const binding = privateValues[bindingKey];
        return binding && binding.rawBase === (privateValues[baseKey] ?? '') && binding.key === privateValues[keyKey] ? binding.key : undefined;
      },
      set(key, value) {
        if (key !== deviceKey) return;
        privateValues[key] = value;
        chrome.storage.local.set({ [key]: value }, () => { void chrome.runtime.lastError; });
      }
    };
    // Remove stale copies left by the old MAIN-world configuration bridge.
    for (const key of privateKeys) {
      root.removeAttribute(getSharedAttributeName(key));
      try { localStorage.removeItem(key); } catch { /* including opaque frames */ }
    }
  }
  const applySharedStoreValues = (values) => {
    const shared = {};
    Object.entries(values ?? {}).forEach(([key, value]) => {
      if (isolated && privateKeys.has(key)) {
        if (key === baseKey || key === keyKey || key === bindingKey) providerRevision++;
        privateValues[key] = value;
        return;
      }
      if (!shouldShareStoreKey(key)) {
        return;
      }

      const serialized = serializeSharedValue(value);
      if (typeof serialized !== 'string') {
        return;
      }

      root.setAttribute(getSharedAttributeName(key), serialized);
      localStorage.setItem(key, serialized);
      shared[key] = value;
    });

    document.dispatchEvent(new CustomEvent(sharedStoreHydrateEvent, { detail: shared }));
  };

  const syncSharedStoreToExtension = (detail) => {
    if (!chrome?.storage?.local?.set || !detail || typeof detail !== 'object') {
      return;
    }

    const nextValues = {};
    Object.entries(detail).forEach(([key, value]) => {
      // Native-owned browser sessions write this UUID in the extension's own storage before opening the site.
      // Page settings must not manufacture/change the host's browser identity or script authorization.
      if ((isolated && (privateKeys.has(key) || key === 'common.settings.work-options'))
        || ['common.settings.device-instance','common.settings.tiku-adapter.script-identity',
        'common.settings.tiku-adapter.script-session-token'].includes(key) || !shouldShareStoreKey(key)) {
        return;
      }

      const serialized = serializeSharedValue(value);
      if (typeof serialized !== 'string') {
        return;
      }

      nextValues[key] = value;
      root.setAttribute(getSharedAttributeName(key), serialized);
    });

    if (Object.keys(nextValues).length > 0) {
      const started = Date.now();
      try {
        chrome.storage.local.set(nextValues, () => {
          diagnostic(chrome.runtime.lastError ? 'sync.failed' : 'sync.success', Date.now() - started);
        });
      } catch { diagnostic('sync.failed'); }
    }
  };

  document.addEventListener(sharedStoreSyncEvent, (event) => {
    syncSharedStoreToExtension(event?.detail);
  });

  let hydrateReady = Promise.resolve();
  if (chrome?.storage?.local?.get) {
    hydrateReady = new Promise(resolve => {
      chrome.storage.local.get(null, (result) => {
        applySharedStoreValues(result ?? {});
        resolve();
      });
    });
  }

  if (chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      const nextValues = {};
      Object.entries(changes ?? {}).forEach(([key, change]) => {
        if (!shouldShareStoreKey(key) && !(isolated && privateKeys.has(key))) {
          return;
        }

        nextValues[key] = change?.newValue;
      });

      applySharedStoreValues(nextValues);
      reloadForExtensionSwitch(changes?.[extensionEnabledKey]);
    });
  }

  document.querySelectorAll(panelSelectors).forEach((node) => {
    node.remove();
  });

  const currentUrl = location.href;
  const frameMarker = btoa(unescape(encodeURIComponent(currentUrl))).replace(/=+$/g, '');
  const injectedMarkerKey = 'cxPlusInjected';
  const injectedWindowKey = '__chaoxing_plus_injected__';
  const swalHostId = 'chaoxing-plus-swal-host';
  const swalTargetId = 'chaoxing-plus-swal-target';
  // 弹窗里的「启用 / 禁用」总开关，写在 chrome.storage.local，注入主脚本前先读它。
  const extensionEnabledKey = 'common.settings.extension-enabled';

  const isEnabledValue = (value) => value !== false;

  const readExtensionEnabled = () => new Promise((resolve) => {
    try {
      if (!chrome?.storage?.local?.get) {
        resolve(true);
        return;
      }

      chrome.storage.local.get(extensionEnabledKey, (result) => {
        resolve(isEnabledValue(result?.[extensionEnabledKey]));
      });
    } catch {
      resolve(true);
    }
  });

  const reloadForExtensionSwitch = (change) => {
    if (!change || isEnabledValue(change.oldValue) === isEnabledValue(change.newValue)) {
      return;
    }

    try {
      // 顶层刷新会带着所有子框架一起重载；子框架不单独刷新，避免重复加载。
      if (window.self === window.top) {
        window.location.reload();
      }
    } catch {
      // ignore cross-frame access errors
    }
  };

  function getSwalScriptDocument() {
    try {
      const topDocument = window.top?.document;
      if (topDocument?.documentElement) {
        return topDocument;
      }
    } catch {
      // ignore cross-frame access errors and fall back to the current document
    }

    return document;
  }

  async function ensureSwalRuntime() {
    const targetDocument = getSwalScriptDocument();
    const targetWindow = targetDocument.defaultView;
    if (!targetWindow) {
      return;
    }

    if (targetWindow[swalAliasKey] && typeof targetWindow[swalAliasKey].fire === 'function') {
      return;
    }

    const existingScript = targetDocument.querySelector('script[data-source="chaoxing-plus-extension-swal-runtime"]');
    if (existingScript) {
      await new Promise((resolve) => {
        if (targetWindow[swalAliasKey] && typeof targetWindow[swalAliasKey].fire === 'function') {
          resolve(undefined);
          return;
        }
        existingScript.addEventListener('load', () => resolve(undefined), { once: true });
        existingScript.addEventListener('error', () => resolve(undefined), { once: true });
      });
      return;
    }

    await new Promise((resolve) => {
      const script = targetDocument.createElement('script');
      script.src = chrome.runtime.getURL('vendor/sweetalert2.all.min.js');
      script.dataset.source = 'chaoxing-plus-extension-swal-runtime';
      script.onload = () => {
        targetWindow[swalAliasKey] = targetWindow.Swal;
        resolve(undefined);
      };
      script.onerror = () => resolve(undefined);
      (targetDocument.head || targetDocument.documentElement).appendChild(script);
    });
  }

  function getSwalStyleDocument() {
    return getSwalScriptDocument();
  }

  const injectStyle = () => {
    const targetDocument = getSwalStyleDocument();
    const targetRoot = targetDocument.documentElement;
    if (!targetRoot) {
      return;
    }

    let host = targetDocument.getElementById(swalHostId);
    if (!host) {
      host = targetDocument.createElement('div');
      host.id = swalHostId;
      host.dataset.source = 'chaoxing-plus-extension';
      (targetDocument.body || targetDocument.documentElement).appendChild(host);
    }

    let link = targetDocument.querySelector('link[data-source="chaoxing-plus-extension-swal-style"]');
    if (!link) {
      link = targetDocument.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('vendor/sweetalert2.min.css');
      link.dataset.source = 'chaoxing-plus-extension-swal-style';
      (targetDocument.head || targetRoot).appendChild(link);
    }

    let mount = targetDocument.getElementById(swalTargetId);
    if (!mount) {
      mount = targetDocument.createElement('div');
      mount.id = swalTargetId;
      host.appendChild(mount);
    }
  };

  const inject = async () => {
    if (root.dataset[injectedMarkerKey] === frameMarker || window[injectedWindowKey] === frameMarker) {
      return;
    }

    if (!(await readExtensionEnabled())) {
      // 总开关关闭：不启动主脚本，也不创建面板。
      finishBoot?.(false);
      return;
    }

    diagnostic('extension.ready');
    await Promise.all([hydrateTabPause(), hydrateReady]);

    root.dataset[injectedMarkerKey] = frameMarker;
    window[injectedWindowKey] = frameMarker;

    injectStyle();
    if (isolated) { finishBoot(true); return; }
    void ensureSwalRuntime();

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('chaoxing-plus.js');
    script.dataset.source = 'chaoxing-plus-extension';
    script.dataset.frameUrl = currentUrl;
    script.onload = () => {
      script.remove();
      document.querySelectorAll(panelSelectors).forEach((node) => {
        node.remove();
      });
    };
    (document.head || root).appendChild(script);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void inject();
    }, { once: true });
  } else {
    void inject();
  }
  }
})();


