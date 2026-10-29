const REQUEST_TIMEOUT_MS = 30000;

export async function fetchJson(port, pathname, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${Number(port)}${pathname}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${pathname}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function decodeMessageData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return null;
}

export class CdpConnection {
  static async open(wsUrl, { timeoutMs = 10000 } = {}) {
    if (typeof WebSocket !== 'function') {
      throw new Error('当前 Node.js 没有内置 WebSocket；Windows 宿主需要 Node.js >= 22');
    }
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try { socket.close(); } catch { /* ignore */ }
        reject(new Error(`WebSocket 连接超时：${wsUrl}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(new Error(`WebSocket 连接失败：${(event && event.message) || wsUrl}`));
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
    });
    return new CdpConnection(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.handleMessage = (event) => this.dispatchMessage(event);
    this.handleClose = () => this.finishClose({ notify: true });
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);
  }

  async dispatchMessage(event) {
    if (this.closed) return;
    const text = decodeMessageData(event && event.data);
    if (typeof text !== 'string') return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message && message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`CDP ${message.error.message || 'error'}${message.error.code ? ` (code ${message.error.code})` : ''}`));
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(message, false);
      } catch {
        // 单个监听器异常不能中断事件分发
      }
    }
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(method, params = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    // WebSocket.send silently drops data in CLOSING before a close event arrives.
    if (!this.closed && this.socket.readyState !== 1) {
      this.finishClose({ notify: true, closeSocket: true });
    }
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      try {
        this.socket.send(payload);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  finishClose({ notify = false, closeSocket = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    const listeners = Array.from(this.listeners);
    this.listeners.clear();
    this.socket.removeEventListener('message', this.handleMessage);
    this.socket.removeEventListener('close', this.handleClose);
    try {
      if (closeSocket) this.socket.close();
    } catch {
      // ignore
    }
    for (const entry of this.pending.values()) {
      entry.reject(new Error('CDP 连接已关闭'));
    }
    this.pending.clear();
    if (notify) {
      for (const listener of listeners) {
        try { listener({ method: 'cx.disconnected', params: {} }, true); } catch { /* ignore */ }
      }
    }
  }

  close() {
    this.finishClose({ closeSocket: true });
  }
}
