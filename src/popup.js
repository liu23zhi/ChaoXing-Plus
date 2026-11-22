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

// Read-only: operational policy belongs to the configured TiKuHelper administrator.
const diagnosticState = document.getElementById('diagnostics-state');
if (diagnosticState) {
  let revision = 0;
  async function refreshDiagnosticState() {
    const current = ++revision;
    const statusText = { enabled:'管理员已启用', disabled:'管理员已关闭', unconfigured:'请先配置自己的题库地址和访问密钥',
      'waiting-device':'等待扩展设备初始化', 'no-script-session':'等待宿主的合法脚本会话', 'changed-service':'服务地址已更换，请配置新服务的访问密钥', unavailable:'服务暂不可用', pending:'正在读取服务状态…' };
    try {
      const s = await chrome.runtime.sendMessage({ kind:'chaoxing-plus:extension-diagnostics', op:'inspect' });
      if (current === revision) diagnosticState.textContent = (statusText[s?.state] || statusText.unavailable) + (s?.service ? ' · ' + s.service : '');
    } catch { if (current === revision) diagnosticState.textContent = statusText.unavailable; }
  }
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && ['common.settings.tiku-adapter.key','common.settings.tiku-adapter.baseurl','common.settings.device-id'].some(k => Object.hasOwn(changes,k))) void refreshDiagnosticState();
  });
  void refreshDiagnosticState();
}
