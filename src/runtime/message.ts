import Swal from 'sweetalert2';

const toastEnabled = false;
const swalAliasKey = '__chaoxing_plus_swal__';

type SwalOwnerWindow = Window & Record<string, unknown>;

function getTopWindowSwal() {
  const selfWindow = window as unknown as SwalOwnerWindow;
  if (window.self === window.top) {
    selfWindow[swalAliasKey] = selfWindow[swalAliasKey] || Swal;
    return selfWindow[swalAliasKey] as typeof Swal;
  }

  try {
    const ownerWindow = window.top as unknown as SwalOwnerWindow;
    ownerWindow[swalAliasKey] = ownerWindow[swalAliasKey] || Swal;
    return ownerWindow[swalAliasKey] as typeof Swal;
  } catch {
    // ignore cross-frame access errors and fall back to local Swal
  }

  return Swal;
}

function toast(icon: 'info' | 'success' | 'warning' | 'error', text: string, timer = 3000) {
  if (!toastEnabled) {
    return;
  }

  const runtimeSwal = getTopWindowSwal();
  void runtimeSwal.fire({
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
    const runtimeSwal = getTopWindowSwal();
    const content = typeof args === 'string' ? args : args.content;
    const denyButtonText = typeof args === 'string' ? undefined : args.denyButtonText;
    const onDeny = typeof args === 'string' ? undefined : args.onDeny;
    const result = await runtimeSwal.fire({ icon: 'info', text: content, confirmButtonText: '知道了', showDenyButton: Boolean(denyButtonText), denyButtonText });

    if (result.isDenied) {
      await onDeny?.();
    }
  },
  async notice(args: { content: string; duration?: number; icon?: 'info' | 'success' | 'warning' | 'error' } | string): Promise<void> {
    const runtimeSwal = getTopWindowSwal();
    const content = typeof args === 'string' ? args : args.content;
    const duration = typeof args === 'string' ? 3000 : args.duration ?? 3000;
    const icon = typeof args === 'string' ? 'info' : args.icon ?? 'info';
    await runtimeSwal.fire({
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
  async confirm(args: { content: string } | string): Promise<boolean> {
    const runtimeSwal = getTopWindowSwal();
    const content = typeof args === 'string' ? args : args.content;
    const result = await runtimeSwal.fire({
      icon: 'question',
      text: content,
      showCancelButton: true,
      confirmButtonText: '确认',
      cancelButtonText: '取消'
    });
    return result.isConfirmed;
  }
};

