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

// Consent is managed by the extension worker, never by a website or a content script.
const diagnosticsToggle = document.getElementById('diagnostics-enabled');
const diagnosticsState = document.getElementById('diagnostics-state');
if (diagnosticsToggle && diagnosticsState) {
  const kind = 'chaoxing-plus:extension-diagnostics';
  let stamp = '';
  let revision = 0;
  async function update(change) {
    const current = ++revision;
    diagnosticsToggle.disabled = true;
    try {
      const s = await chrome.runtime.sendMessage({ kind, ...change });
      if (current !== revision) return;
      if (!s || s.unavailable) throw Error();
      stamp = s.stamp || '';
      diagnosticsToggle.checked = s.enabled;
      diagnosticsToggle.disabled = !s.enabled && (!stamp || !s.master);
      diagnosticsState.textContent = !s.service ? '请先配置 HTTPS 题库地址（本机调试可用 HTTP）'
        : !stamp ? '未设置访问密钥 · ' + s.service
        : !s.master ? '扩展已暂停 · ' + s.service
        : (s.enabled ? '已开启 · ' : '未开启 · ') + s.service;
    } catch {
      if (current !== revision) return;
      stamp = '';
      diagnosticsToggle.checked = false;
      diagnosticsState.textContent = '暂时无法读取设置，请重新打开扩展弹窗。';
    }
  }
  diagnosticsToggle.addEventListener('change', () => {
    void update({ op: 'toggle', on: diagnosticsToggle.checked, stamp });
  });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && ['common.settings.tiku-adapter.key', 'common.settings.tiku-adapter.baseurl',
      extensionEnabledKey, 'diagnostics.upload.consent.v1'].some(k => Object.hasOwn(changes, k))) void update({ op: 'inspect' });
  });
  void update({ op: 'inspect' });
}
