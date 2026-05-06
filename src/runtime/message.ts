import Swal from 'sweetalert2';

const toastEnabled = false;

function toast(icon: 'info' | 'success' | 'warning' | 'error', text: string, timer = 3000) {
  if (!toastEnabled) {
    return;
  }

  void Swal.fire({
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
  async alert(args: { content: string } | string): Promise<void> {
    const content = typeof args === 'string' ? args : args.content;
    await Swal.fire({ icon: 'info', text: content, confirmButtonText: '知道了' });
  },
  async notice(args: { content: string; duration?: number; icon?: 'info' | 'success' | 'warning' | 'error' } | string): Promise<void> {
    const content = typeof args === 'string' ? args : args.content;
    const duration = typeof args === 'string' ? 3000 : args.duration ?? 3000;
    const icon = typeof args === 'string' ? 'info' : args.icon ?? 'info';
    await Swal.fire({
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
    const content = typeof args === 'string' ? args : args.content;
    const result = await Swal.fire({
      icon: 'question',
      text: content,
      showCancelButton: true,
      confirmButtonText: '确认',
      cancelButtonText: '取消'
    });
    return result.isConfirmed;
  }
};
