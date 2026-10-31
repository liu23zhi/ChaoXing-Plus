import Swal, { type SweetAlertOptions, type SweetAlertResult } from 'sweetalert2';

const toastEnabled = false;
const swalAliasKey = '__chaoxing_plus_swal__';
const swalHostId = 'chaoxing-plus-swal-host';
const swalTargetId = 'chaoxing-plus-swal-target';
const swalStyleId = 'chaoxing-plus-swal-style-reset';
const swalFireKey = '__chaoxing_plus_fire_swal__';
const swalBridgeNamespace = 'chaoxing-plus:swal';
const swalBridgeWaitMs = 2500;
// 弹窗必须严格高于所有面板：z-index 上限是 2147483647，
// 因此把面板栈整体压到 2147483646 及以下（见 panel.ts / common.ts / cx.ts），
// 只把最高位留给弹窗，保证弹窗永远压在主面板之上。
const swalContainerZIndex = 2147483647;

type SwalOwnerWindow = Window & Record<string, unknown>;
type SwalFireOptions = SweetAlertOptions;
type SwalFire = (options: SwalFireOptions) => Promise<SweetAlertResult>;

function isSwalRuntime(value: unknown): value is typeof Swal {
  return Boolean(value)
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as typeof Swal).fire === 'function';
}

function getSwalRuntime() {
  try {
    const topWindow = window.top as SwalOwnerWindow | null;
    const topDocument = topWindow?.document;
    const runtimeSwal = topWindow?.[swalAliasKey];
    if (isSwalRuntime(runtimeSwal) && topDocument?.documentElement) {
      return { runtimeSwal, targetDocument: topDocument };
    }
  } catch {
    // ignore cross-frame access errors and fall back to local Swal runtime
  }

  return { runtimeSwal: Swal, targetDocument: document };
}

function ensureSwalStyleReset(targetDocument: Document) {
  try {
    let style = targetDocument.getElementById(swalStyleId) as HTMLStyleElement | null;
    if (!style) {
      style = targetDocument.createElement('style');
      style.id = swalStyleId;
      style.textContent = `
#${swalTargetId} .swal2-container {
  z-index: ${swalContainerZIndex} !important;
  font-size: 16px !important;
  line-height: 1.5 !important;
  --swal2-container-padding: 10px;
}

#${swalTargetId} .swal2-popup {
  font-size: 16px !important;
  line-height: 1.5 !important;
  --swal2-border-radius: 5px;
}
`;
      (targetDocument.head || targetDocument.documentElement).appendChild(style);
    }
  } catch {
    // ignore style injection failures and fall back to default SweetAlert styling
  }
}

// 兜底：页面自身也可能使用最高 z-index，把弹窗宿主移动到 body 末尾，
// 同层级时按文档顺序绘制，弹窗仍然压在上面。
function pinSwalHostToPaintTop(targetDocument: Document, host: HTMLElement) {
  try {
    const parent = targetDocument.body || targetDocument.documentElement;
    if (parent && parent.lastElementChild !== host) {
      parent.appendChild(host);
    }
  } catch {
    // ignore DOM access failures and keep the previously mounted host position
  }
}

function getOrCreateSwalTarget(targetDocument: Document) {
  try {
    let host = targetDocument.getElementById(swalHostId);
    if (!host) {
      host = targetDocument.createElement('div');
      host.id = swalHostId;
      (targetDocument.body || targetDocument.documentElement).appendChild(host);
    }
    host.style.fontSize = '16px';
    host.style.lineHeight = '1.5';

    let target = targetDocument.getElementById(swalTargetId);
    if (!target) {
      target = targetDocument.createElement('div');
      target.id = swalTargetId;
      host.appendChild(target);
    }
    target.style.fontSize = '16px';
    target.style.lineHeight = '1.5';

    pinSwalHostToPaintTop(targetDocument, host);

    return target;
  } catch {
    // ignore DOM access failures and fall back to default target
  }

  return undefined;
}

function fireLocalSwal(options: SwalFireOptions) {
  const { runtimeSwal, targetDocument } = getSwalRuntime();
  ensureSwalStyleReset(targetDocument);
  return runtimeSwal.fire({
    ...options,
    target: getOrCreateSwalTarget(targetDocument)
  });
}

function isSwalBridgeChild(event: MessageEvent) {
  try {
    if (!event.source || event.source === window || (event.source as Window).top !== window) {
      return false;
    }
    const origin = new URL(event.origin);
    return event.origin === window.location.origin
      || ((origin.protocol === 'https:' || origin.protocol === 'http:')
        && (origin.hostname === 'chaoxing.com' || origin.hostname.endsWith('.chaoxing.com')));
  } catch {
    return false;
  }
}

function isSwalBridgeOptions(options: unknown): options is SwalFireOptions {
  if (!options || typeof options !== 'object') return false;
  const fields: Record<string, string> = {
    icon: 'string', text: 'string', confirmButtonText: 'string', cancelButtonText: 'string', denyButtonText: 'string',
    showConfirmButton: 'boolean', showCancelButton: 'boolean', showDenyButton: 'boolean',
    allowOutsideClick: 'boolean', allowEscapeKey: 'boolean', timer: 'number', timerProgressBar: 'boolean'
  };
  return Object.entries(options).every(([key, value]) =>
    Object.prototype.hasOwnProperty.call(fields, key) && (value === undefined || typeof value === fields[key])
  );
}

function installSwalBridge() {
  if (window.top !== window) return;
  const owner = window as unknown as SwalOwnerWindow;
  if (!isSwalRuntime(owner[swalAliasKey])) {
    owner[swalAliasKey] = Swal;
  }
  if (typeof owner[swalFireKey] === 'function') return;
  owner[swalFireKey] = fireLocalSwal;
  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data;
    if (!message || message.namespace !== swalBridgeNamespace || typeof message.id !== 'string'
      || !isSwalBridgeChild(event)) return;
    const source = event.source as Window;
    if (message.kind === 'hello') {
      source.postMessage({ namespace: swalBridgeNamespace, kind: 'ready', id: message.id }, event.origin);
    } else if (message.kind === 'fire' && isSwalBridgeOptions(message.options)) {
      void Promise.resolve().then(() => fireLocalSwal(message.options)).then(
        (result) => source.postMessage({ namespace: swalBridgeNamespace, kind: 'result', id: message.id, result }, event.origin),
        () => source.postMessage({ namespace: swalBridgeNamespace, kind: 'result', id: message.id, error: true }, event.origin)
      );
    }
  });
}

function requestTopSwal(options: SwalFireOptions): Promise<SweetAlertResult | undefined> {
  const targetWindow = window.top;
  if (!targetWindow || targetWindow === window) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let sent = false;
    let targetOrigin: string | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(retry);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== targetWindow || !message || message.namespace !== swalBridgeNamespace || message.id !== id) return;
      if (message.kind === 'ready' && !sent) {
        sent = true;
        targetOrigin = event.origin;
        // 顶层接管后只等待用户操作，不能超时后再弹第二个本地窗口。
        clearTimeout(timeout);
        clearInterval(retry);
        try {
          targetWindow.postMessage({ namespace: swalBridgeNamespace, kind: 'fire', id, options }, targetOrigin);
        } catch {
          cleanup();
          resolve(undefined);
        }
      } else if (sent && message.kind === 'result' && event.origin === targetOrigin) {
        cleanup();
        if (message.error) reject(new Error('无法显示顶层弹窗。'));
        else resolve(message.result as SweetAlertResult);
      }
    };
    const hello = () => {
      try {
        targetWindow.postMessage({ namespace: swalBridgeNamespace, kind: 'hello', id }, '*');
      } catch {
        cleanup();
        resolve(undefined);
      }
    };
    const timeout = setTimeout(() => { cleanup(); resolve(undefined); }, swalBridgeWaitMs);
    const retry = setInterval(hello, 100);
    window.addEventListener('message', onMessage);
    hello();
  });
}

function fireSwal(options: SwalFireOptions): Promise<SweetAlertResult> {
  try {
    const topWindow = window.top as SwalOwnerWindow | null;
    const topFire = topWindow?.[swalFireKey];
    if (typeof topFire === 'function') return (topFire as SwalFire)(options);
    if (isSwalRuntime(topWindow?.[swalAliasKey])) return fireLocalSwal(options);
  } catch {
    // Cross-origin frames delegate to the top runtime through the message bridge.
  }
  if (window.top && window.top !== window) {
    return requestTopSwal(options).then((result) => result ?? fireLocalSwal(options));
  }
  return fireLocalSwal(options);
}

installSwalBridge();

function toast(icon: 'info' | 'success' | 'warning' | 'error', text: string, timer = 3000) {
  if (!toastEnabled) {
    return;
  }

  void fireSwal({
    toast: true,
    position: 'top-end',
    timer,
    showConfirmButton: false,
    icon,
    title: text
  });
}

export const $message = {
  info(args: { content: string; duration?: number } | string) {
    const content = typeof args === 'string' ? args : args.content;
    const duration = typeof args === 'string' ? 3000 : args.duration ?? 3000;
    toast('info', content, duration);
  },
  success(args: { content: string; duration?: number } | string) {
    const content = typeof args === 'string' ? args : args.content;
    const duration = typeof args === 'string' ? 3000 : args.duration ?? 3000;
    toast('success', content, duration);
  },
  warn(args: { content: string; duration?: number } | string) {
    const content = typeof args === 'string' ? args : args.content;
    const duration = typeof args === 'string' ? 5000 : args.duration ?? 5000;
    toast('warning', content, duration);
  },
  error(args: { content: string; duration?: number } | string) {
    const content = typeof args === 'string' ? args : args.content;
    const duration = typeof args === 'string' ? 5000 : args.duration ?? 5000;
    toast('error', content, duration);
  }
};

export const $modal = {
  async alert(args: {
    content: string;
    icon?: SweetAlertOptions['icon'];
    allowOutsideClick?: SweetAlertOptions['allowOutsideClick'];
    allowEscapeKey?: SweetAlertOptions['allowEscapeKey'];
    denyButtonText?: string;
    onDeny?: () => Promise<void> | void;
  } | string): Promise<void> {
    const content = typeof args === 'string' ? args : args.content;
    const icon = typeof args === 'string' ? 'info' : args.icon ?? 'info';
    const allowOutsideClick = typeof args === 'string' ? undefined : args.allowOutsideClick;
    const allowEscapeKey = typeof args === 'string' ? undefined : args.allowEscapeKey;
    const denyButtonText = typeof args === 'string' ? undefined : args.denyButtonText;
    const onDeny = typeof args === 'string' ? undefined : args.onDeny;
    const result = await fireSwal({ icon, text: content, confirmButtonText: '知道了', showConfirmButton: true, showDenyButton: Boolean(denyButtonText), denyButtonText, allowOutsideClick, allowEscapeKey });

    if (result.isDenied) {
      await onDeny?.();
    }
  },
  async notice(args: { content: string; duration?: number; icon?: 'info' | 'success' | 'warning' | 'error' } | string): Promise<void> {
    const content = typeof args === 'string' ? args : args.content;
    const duration = typeof args === 'string' ? 3000 : args.duration ?? 3000;
    const icon = typeof args === 'string' ? 'info' : args.icon ?? 'info';
    await fireSwal({
      icon,
      text: content,
      timer: duration > 0 ? duration : undefined,
      timerProgressBar: duration > 0,
      showConfirmButton: duration <= 0,
      confirmButtonText: '知道了',
      allowOutsideClick: duration > 0,
      allowEscapeKey: true
    });
  },
  async confirm(args: {
    content: string;
    confirmButtonText?: string;
    cancelButtonText?: string;
    allowOutsideClick?: SweetAlertOptions['allowOutsideClick'];
    allowEscapeKey?: SweetAlertOptions['allowEscapeKey'];
    timer?: number;
    timerProgressBar?: boolean;
    defaultConfirmed?: boolean;
  } | string): Promise<boolean> {
    const content = typeof args === 'string' ? args : args.content;
    const confirmButtonText = typeof args === 'string' ? '确认' : args.confirmButtonText ?? '确认';
    const cancelButtonText = typeof args === 'string' ? '取消' : args.cancelButtonText ?? '取消';
    const allowOutsideClick = typeof args === 'string' ? undefined : args.allowOutsideClick;
    const allowEscapeKey = typeof args === 'string' ? undefined : args.allowEscapeKey;
    const timer = typeof args === 'string' ? undefined : args.timer;
    const timerProgressBar = typeof args === 'string' ? false : args.timerProgressBar ?? false;
    const defaultConfirmed = typeof args === 'string' ? false : args.defaultConfirmed ?? false;
    const result = await fireSwal({
      icon: 'question',
      text: content,
      showCancelButton: true,
      confirmButtonText,
      cancelButtonText,
      timer,
      timerProgressBar,
      ...(allowOutsideClick === undefined ? {} : { allowOutsideClick }),
      ...(allowEscapeKey === undefined ? {} : { allowEscapeKey })
    });
    return result.isConfirmed || (defaultConfirmed && result.dismiss === Swal.DismissReason.timer);
  }
};




