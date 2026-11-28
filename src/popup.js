import { DIAGNOSTICS_OPT_OUT } from './extension-agreement-core.js';

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

const diagnosticState = document.getElementById('diagnostics-state');
const diagnosticsToggle = document.getElementById('diagnostics-enabled');
const ordinaryNative = chrome.runtime.getManifest?.()?.version_name === '普通 Windows 原生通道 v1';
if (diagnosticState && diagnosticsToggle && ordinaryNative) {
  diagnosticsToggle.hidden = true;
  const hint = document.getElementById('diagnostics-hint');
  if (hint) hint.hidden = true;
  diagnosticState.textContent = '普通 Windows 诊断回传请在宿主窗口管理；浏览器不发送诊断。';
} else if (diagnosticState && diagnosticsToggle) {
  let revision = 0;
  const statusText = {
    checking: '正在确认协议及服务策略…', enabled: '已启用，尚无待传日志', received: '已接收日志',
    pending: '日志待回传', unconfirmed: '尚未确认接收，将重试', 'opted-out': '已关闭诊断回传',
    'policy-disabled': '管理员已关闭或当前协议尚未授权回传',
    'waiting-agreement': '等待当前协议确认', 'host-unavailable': '当前宿主未提供可信诊断授权',
    unconfigured: '尚未配置题库服务或扩展已禁用', unavailable: '暂时无法确认服务状态'
  };
  async function refreshDiagnosticState() {
    const current = ++revision;
    try {
      const saved = await chrome.storage.local.get(DIAGNOSTICS_OPT_OUT);
      if (current !== revision) return;
      diagnosticsToggle.checked = saved[DIAGNOSTICS_OPT_OUT] !== false;
      diagnosticsToggle.disabled = false;
      const result = await chrome.runtime.sendMessage({kind:'chaoxing-plus:extension-diagnostics', op:'inspect'});
      if (current === revision) diagnosticState.textContent = statusText[result?.state] ?? statusText.unavailable;
    } catch { if (current === revision) diagnosticState.textContent = statusText.unavailable; }
  }
  diagnosticsToggle.addEventListener('change', async () => {
    try { await chrome.storage.local.set({[DIAGNOSTICS_OPT_OUT]: diagnosticsToggle.checked}); }
    finally { void refreshDiagnosticState(); }
  });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && [DIAGNOSTICS_OPT_OUT, 'agreement.view.v1', 'common.settings.tiku-adapter.baseurl',
      'common.settings.tiku-adapter.key', 'common.settings.device-id'].some(k => Object.hasOwn(changes,k))) {
      void refreshDiagnosticState();
    }
  });
  void refreshDiagnosticState();
}
