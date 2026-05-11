import Swal, { type SweetAlertOptions } from 'sweetalert2';

const toastEnabled = false;
const swalAliasKey = '__chaoxing_plus_swal__';
const swalHostId = 'chaoxing-plus-swal-host';
const swalTargetId = 'chaoxing-plus-swal-target';

type SwalOwnerWindow = Window & Record<string, unknown>;
type SwalFireOptions = SweetAlertOptions;

function getSwalRuntime() {
  try {
    const topWindow = window.top as SwalOwnerWindow | null;
    const topDocument = topWindow?.document;
    const runtimeSwal = topWindow?.[swalAliasKey];
    if (runtimeSwal && typeof runtimeSwal === 'object' && 'fire' in runtimeSwal && topDocument?.documentElement) {
      return { runtimeSwal: runtimeSwal as typeof Swal, targetDocument: topDocument };
    }
  } catch {
    // ignore cross-frame access errors and fall back to local Swal runtime
  }

  return { runtimeSwal: Swal, targetDocument: document };
}

function getOrCreateSwalTarget(targetDocument: Document) {
  try {
    let host = targetDocument.getElementById(swalHostId);
    if (!host) {
      host = targetDocument.createElement('div');
      host.id = swalHostId;
      (targetDocument.body || targetDocument.documentElement).appendChild(host);
    }

    let target = targetDocument.getElementById(swalTargetId);
    if (!target) {
      target = targetDocument.createElement('div');
      target.id = swalTargetId;
      host.appendChild(target);
    }

    return target;
  } catch {
    // ignore DOM access failures and fall back to default target
  }

  return undefined;
}

function fireSwal(options: SwalFireOptions) {
  const { runtimeSwal, targetDocument } = getSwalRuntime();
  return runtimeSwal.fire({
    ...options,
    target: getOrCreateSwalTarget(targetDocument)
  });
}

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
  async alert(args: { content: string; denyButtonText?: string; onDeny?: () => Promise<void> | void } | string): Promise<void> {
    const content = typeof args === 'string' ? args : args.content;
    const denyButtonText = typeof args === 'string' ? undefined : args.denyButtonText;
    const onDeny = typeof args === 'string' ? undefined : args.onDeny;
    const result = await fireSwal({ icon: 'info', text: content, confirmButtonText: '知道了', showDenyButton: Boolean(denyButtonText), denyButtonText });

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
    timer?: number;
    timerProgressBar?: boolean;
    defaultConfirmed?: boolean;
  } | string): Promise<boolean> {
    const content = typeof args === 'string' ? args : args.content;
    const confirmButtonText = typeof args === 'string' ? '确认' : args.confirmButtonText ?? '确认';
    const cancelButtonText = typeof args === 'string' ? '取消' : args.cancelButtonText ?? '取消';
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
      timerProgressBar
    });
    return result.isConfirmed || (defaultConfirmed && result.dismiss === Swal.DismissReason.timer);
  }
};




