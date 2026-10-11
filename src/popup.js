const homepage = 'https://www.chaoxing.com/';
// 总开关：内容脚本（extension-entry.js）在注入主脚本前读取同一个键。
const extensionEnabledKey = 'common.settings.extension-enabled';

const openButton = document.getElementById('open-chaoxing');
const enabledToggle = document.getElementById('extension-enabled');
const enabledState = document.getElementById('extension-enabled-state');

function renderExtensionEnabled(enabled) {
  if (enabledToggle) {
    enabledToggle.checked = enabled;
  }
  if (enabledState) {
    enabledState.textContent = enabled ? '已启用' : '已禁用';
  }
  document.body.dataset.extensionEnabled = enabled ? 'true' : 'false';
}

function readExtensionEnabled() {
  if (!chrome?.storage?.local?.get) {
    renderExtensionEnabled(true);
    return;
  }

  chrome.storage.local.get(extensionEnabledKey, (result) => {
    renderExtensionEnabled(result?.[extensionEnabledKey] !== false);
  });
}

if (openButton) {
  openButton.addEventListener('click', () => {
    chrome.tabs.create({ url: homepage });
  });
}

if (enabledToggle) {
  enabledToggle.addEventListener('change', () => {
    const enabled = Boolean(enabledToggle.checked);
    renderExtensionEnabled(enabled);
    chrome.storage.local.set({ [extensionEnabledKey]: enabled });
  });
}

readExtensionEnabled();
