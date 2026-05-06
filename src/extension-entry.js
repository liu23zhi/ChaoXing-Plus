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
