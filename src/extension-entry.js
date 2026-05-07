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

  const sharedStoreKeys = [
    'common.settings.tiku-adapter.baseurl',
    'common.settings.tiku-adapter.key'
  ];
  const sharedStoreSyncEvent = 'chaoxing-plus:shared-store-sync';
  const sharedStoreHydrateEvent = 'chaoxing-plus:shared-store-hydrate';

  const getSharedAttributeName = (key) => `data-chaoxing-plus-shared-${key.replace(/[^a-z0-9_-]/gi, '-')}`;

  const applySharedStoreValues = (values) => {
    sharedStoreKeys.forEach((key) => {
      const value = values?.[key];
      if (typeof value !== 'string') {
        return;
      }

      root.setAttribute(getSharedAttributeName(key), value);
      localStorage.setItem(key, JSON.stringify(value));
    });

    document.dispatchEvent(new CustomEvent(sharedStoreHydrateEvent, { detail: values }));
  };

  const syncSharedStoreToExtension = (detail) => {
    if (!chrome?.storage?.local?.set || !detail || typeof detail !== 'object') {
      return;
    }

    const nextValues = {};
    sharedStoreKeys.forEach((key) => {
      const value = detail[key];
      if (typeof value === 'string') {
        nextValues[key] = value;
        root.setAttribute(getSharedAttributeName(key), value);
      }
    });

    if (Object.keys(nextValues).length > 0) {
      chrome.storage.local.set(nextValues);
    }
  };

  document.addEventListener(sharedStoreSyncEvent, (event) => {
    syncSharedStoreToExtension(event?.detail);
  });

  if (chrome?.storage?.local?.get) {
    chrome.storage.local.get(sharedStoreKeys, (result) => {
      applySharedStoreValues(result ?? {});
    });
  }

  document.querySelectorAll(panelSelectors).forEach((node) => {
    node.remove();
  });

  const currentUrl = location.href;
  const frameMarker = btoa(unescape(encodeURIComponent(currentUrl))).replace(/=+$/g, '');
  const injectedMarkerKey = 'cxPlusInjected';
  const styleInjectedMarkerKey = 'cxPlusSwalStyleInjected';

  const injectStyle = () => {
    if (root.dataset[styleInjectedMarkerKey] === frameMarker) {
      return;
    }
    root.dataset[styleInjectedMarkerKey] = frameMarker;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('vendor/sweetalert2.min.css');
    link.dataset.source = 'chaoxing-plus-extension';
    (document.head || root).appendChild(link);
  };

  const inject = () => {
    if (root.dataset[injectedMarkerKey] === frameMarker) {
      return;
    }
    root.dataset[injectedMarkerKey] = frameMarker;

    injectStyle();

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
    document.addEventListener('DOMContentLoaded', inject, { once: true });
  } else {
    inject();
  }
})();
