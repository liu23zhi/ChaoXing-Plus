declare const __CXPLUS_WINDOWS_INJECTION_LOG__: boolean;

const HOST_DIAGNOSTICS_EVENT = 'chaoxing-plus:windows-host-diagnostics';
const hostDiagnosticMessages = {
  'host-started': '宿主已启动',
  'client-started': '客户端已启动',
  'endpoint-waiting': '等待调试连接；部分客户端可能需登录后才开放',
  'endpoint-ready': '调试连接已就绪',
  'session-connected': '已连接客户端页面',
  'session-reconnected': '已恢复客户端页面连接',
  'session-retry': '连接中断，正在重试',
  'bootstrap-ready': '页面引导已就绪',
  'bootstrap-failed': '页面引导失败',
  'bundle-ready': '答题功能已加载',
  'bundle-failed': '答题功能加载失败',
  'config-updated': '已接收配置更新',
  'config-failed': '配置同步失败',
  'page-error': '页面运行出现异常',
  'top-navigated': '客户端页面已跳转'
} as const;

type DiagnosticEntry = {
  sequence: number;
  elapsedMs: number;
  level: 'info' | 'warn' | 'error';
  code: keyof typeof hostDiagnosticMessages;
};

type HostDiagnosticsBridge = {
  getConfig: () => Record<string, unknown>;
  getDiagnostics: () => unknown;
};

type HostLogBinding = { root: HTMLElement; section: HTMLElement; refresh: () => void; dispose: () => void };
let activeHostLogBinding: HostLogBinding | undefined;

function currentDiagnosticsBridge(): HostDiagnosticsBridge | undefined {
  try {
    if (window.self !== window.top) return;
    const host = (window as unknown as { __CX_WIN_HOST__?: Partial<HostDiagnosticsBridge> }).__CX_WIN_HOST__;
    if (typeof host?.getDiagnostics !== 'function' || typeof host.getConfig !== 'function') return;
    const settings = host.getConfig();
    if (settings['common.settings.windows-panel-enabled'] === false || settings['common.settings.extension-enabled'] === false) return;
    return host as HostDiagnosticsBridge;
  } catch {
    return;
  }
}

function readDiagnostics(host: HostDiagnosticsBridge): DiagnosticEntry[] {
  try {
    const entries = host.getDiagnostics();
    if (!Array.isArray(entries) || entries.length > 100) return [];
    let previousSequence = 0;
    const result: DiagnosticEntry[] = [];
    for (const entry of entries) {
      if (!entry || !Number.isSafeInteger(entry.sequence) || entry.sequence <= previousSequence
        || typeof entry.elapsedMs !== 'number' || !Number.isFinite(entry.elapsedMs) || entry.elapsedMs < 0
        || entry.elapsedMs > Number.MAX_SAFE_INTEGER
        || !['info', 'warn', 'error'].includes(entry.level)
        || !Object.prototype.hasOwnProperty.call(hostDiagnosticMessages, entry.code)) return [];
      result.push({ sequence: entry.sequence, elapsedMs: entry.elapsedMs, level: entry.level, code: entry.code });
      previousSequence = entry.sequence;
    }
    return result;
  } catch {
    return [];
  }
}

/** Reuse this section when ordinary answer-result renders replace the panel body. */
export function mountWindowsHostLogPanel(root: HTMLElement, enabled: boolean): HTMLElement | undefined {
  const showInjectionLogs = typeof __CXPLUS_WINDOWS_INJECTION_LOG__ !== 'undefined' && __CXPLUS_WINDOWS_INJECTION_LOG__ === true;
  const host = showInjectionLogs && enabled ? currentDiagnosticsBridge() : undefined;
  if (!host || root.ownerDocument !== document || !root.isConnected) {
    activeHostLogBinding?.dispose();
    return;
  }
  if (activeHostLogBinding?.root === root) {
    activeHostLogBinding.refresh();
    return activeHostLogBinding.section;
  }
  activeHostLogBinding?.dispose();

  const section = document.createElement('section');
  section.dataset.windowsHostLog = 'true';
  section.setAttribute('aria-label', '连接与注入日志');
  section.style.cssText = 'padding:10px 12px;border:1px solid rgba(148,163,184,.3);border-radius:12px;background:rgba(255,255,255,.85);font-size:12px;line-height:1.5;color:#475569;';
  const title = document.createElement('div');
  title.textContent = '连接与注入日志 · 最近 100 条';
  title.style.cssText = 'font-size:12px;font-weight:700;margin-bottom:6px;';
  const list = document.createElement('div');
  list.dataset.windowsHostLogEntries = 'true';
  list.style.cssText = 'max-height:144px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;font-size:12px;line-height:1.5;';
  section.append(title, list);

  let signature = '';
  let detachedCheck: number | undefined;
  const refresh = () => {
    const currentHost = currentDiagnosticsBridge();
    if (!currentHost) {
      binding.dispose();
      return;
    }
    const entries = readDiagnostics(currentHost);
    const nextSignature = JSON.stringify(entries);
    if (nextSignature === signature) return;
    signature = nextSignature;
    const scrollTop = list.scrollTop;
    const fragment = document.createDocumentFragment();
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.textContent = '等待宿主连接记录。';
      fragment.append(empty);
    }
    for (const entry of entries.slice().reverse()) {
      const row = document.createElement('div');
      row.dataset.sequence = String(entry.sequence);
      row.dataset.level = entry.level;
      row.style.cssText = 'padding:2px 0;overflow-wrap:break-word;font-size:12px;';
      row.style.color = entry.level === 'error' ? '#b91c1c' : entry.level === 'warn' ? '#986400' : '#475569';
      row.textContent = `+${(entry.elapsedMs / 1000).toFixed(1)}s  ${hostDiagnosticMessages[entry.code]}`;
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    list.scrollTop = scrollTop;
  };
  const onDiagnostics = () => refresh();
  const observer = new MutationObserver(() => {
    if (root.isConnected || detachedCheck !== undefined) return;
    detachedCheck = window.setTimeout(() => {
      detachedCheck = undefined;
      if (!root.isConnected) binding.dispose();
    }, 0);
  });
  const binding: HostLogBinding = {
    root, section, refresh,
    dispose() {
      document.removeEventListener(HOST_DIAGNOSTICS_EVENT, onDiagnostics);
      window.removeEventListener('pagehide', binding.dispose);
      observer.disconnect();
      if (detachedCheck !== undefined) window.clearTimeout(detachedCheck);
      section.remove();
      if (activeHostLogBinding === binding) activeHostLogBinding = undefined;
    }
  };
  activeHostLogBinding = binding;
  document.addEventListener(HOST_DIAGNOSTICS_EVENT, onDiagnostics);
  window.addEventListener('pagehide', binding.dispose);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  refresh();
  return section;
}
