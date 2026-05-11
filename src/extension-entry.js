(() => {
  const root = document.documentElement;
  if (!root) {
    return;
  }

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
  const sharedStoreExcludedKeys = new Set([
    'common.work-results.results',
    'common.apps.question-caches'
  ]);
  const sharedStoreSyncEvent = 'chaoxing-plus:shared-store-sync';
  const sharedStoreHydrateEvent = 'chaoxing-plus:shared-store-hydrate';
  const swalAliasKey = '__chaoxing_plus_swal__';

  const shouldShareStoreKey = (key) => (
    typeof key === 'string'
    && sharedStoreExcludedKeys.has(key) === false
    && sharedStorePrefixes.some((prefix) => key.startsWith(prefix))
  );

  const getSharedAttributeName = (key) => `data-chaoxing-plus-shared-${key.replace(/[^a-z0-9_-]/gi, '-')}`;

  const serializeSharedValue = (value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  };

  const applySharedStoreValues = (values) => {
    Object.entries(values ?? {}).forEach(([key, value]) => {
      if (!shouldShareStoreKey(key)) {
        return;
      }

      const serialized = serializeSharedValue(value);
      if (typeof serialized !== 'string') {
        return;
      }

      root.setAttribute(getSharedAttributeName(key), serialized);
      localStorage.setItem(key, serialized);
    });

    document.dispatchEvent(new CustomEvent(sharedStoreHydrateEvent, { detail: values }));
  };

  const syncSharedStoreToExtension = (detail) => {
    if (!chrome?.storage?.local?.set || !detail || typeof detail !== 'object') {
      return;
    }

    const nextValues = {};
    Object.entries(detail).forEach(([key, value]) => {
      if (!shouldShareStoreKey(key)) {
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
      chrome.storage.local.set(nextValues);
    }
  };

  document.addEventListener(sharedStoreSyncEvent, (event) => {
    syncSharedStoreToExtension(event?.detail);
  });

  if (chrome?.storage?.local?.get) {
    chrome.storage.local.get(null, (result) => {
      applySharedStoreValues(result ?? {});
    });
  }

  if (chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      const nextValues = {};
      Object.entries(changes ?? {}).forEach(([key, change]) => {
        if (!shouldShareStoreKey(key)) {
          return;
        }

        nextValues[key] = change?.newValue;
      });

      applySharedStoreValues(nextValues);
    });
  }

  document.querySelectorAll(panelSelectors).forEach((node) => {
    node.remove();
  });

  const currentUrl = location.href;
  const frameMarker = btoa(unescape(encodeURIComponent(currentUrl))).replace(/=+$/g, '');
  const injectedMarkerKey = 'cxPlusInjected';
  const swalHostId = 'chaoxing-plus-swal-host';
  const swalTargetId = 'chaoxing-plus-swal-target';

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
    if (root.dataset[injectedMarkerKey] === frameMarker) {
      return;
    }
    root.dataset[injectedMarkerKey] = frameMarker;

    injectStyle();
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
})();


