/**
 * 设备标识（依据 141 §4.1 / §4.3 / §7）。
 *
 * 只做一件事：给出两个请求头 `X-Device-Id` / `X-Device-Instance` 的值。
 * **两个字段的生命周期刻意不同，这是整个冲突检测能成立的前提**：
 *
 * | 字段 | 生命周期 | 语义 |
 * |---|---|---|
 * | `deviceId` | **持久化**（`chrome.storage.local`） | 「这个浏览器 profile」 |
 * | `clientInstance` | **普通页面每次加载新生成；托管浏览器用宿主注入值** | 「这次运行」 |
 *
 * ⚠️ `clientInstance` 绝对不能持久化。一套系统镜像被复制成多份时，`chrome.storage`
 * 里的内容会**一起被复制**（141 §4.3 原话）。若 instance 也存在里面，镜像 A、B 的
 * instance 完全相同 ⇒ 服务端看到「同 device_id + 同 instance」，判定成「同一实例重连」
 * ⇒ **冲突检测完全失效**，两个镜像抢同一个槽位却谁也发现不了。
 * instance 每次加载新生成，镜像 A、B 首次运行各得不同 instance，服务端才能识别出
 * 「同 device_id + 不同 instance」＝冲突，让后到者换 ID。
 *
 * 为什么走 `runtimeStore` 而不是直接 `localStorage`：
 * `store.ts:100-102` 记录了 Windows 端会注入 about:blank/srcdoc 等**不透明 origin** 的
 * frame，那里访问 `localStorage` 会抛 SecurityError。`runtimeStore` 已经把
 * 「localStorage 抛错 → 内存 + documentElement 属性镜像」这条降级路径写好了。
 *
 * `common.settings.device-id` 这个 key 落在 `store.ts` 的 `SHARED_STORE_PREFIXES`
 * （`common.settings.`）里，因此 `extension-entry.js` 的 shared-store 通道会自动把它
 * 同步进 `chrome.storage.local`（`extension-entry.js:158`）—— **不需要改
 * extension-entry.js 的白名单**。除此之外下面还会显式写一次 `chrome.storage.local`，
 * 不依赖那条事件桥：设备 ID 是所有限设备请求的钥匙，值得两条独立的落盘路径。
 */

import { runtimeStore } from './store.js';
import { usesBrowserAgreementGate } from './agreement-gate.js';

/** 持久化 key。归属 `common.settings.` 前缀，才能被 shared-store 通道同步。 */
export const DEVICE_ID_STORAGE_KEY = 'common.settings.device-id';
const HOST_BROWSER_STORAGE_KEY = 'common.settings.device-instance';
const UUID_V4 = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;

/** 141 §7 规定的两个请求头名（服务端按这两个名字读）。 */
export const DEVICE_ID_HEADER = 'X-Device-Id';
export const DEVICE_INSTANCE_HEADER = 'X-Device-Instance';

/** 141 §6.3 的冲突错误码。服务端在 `device_id` 已登记但 instance 不同时返回。 */
export const DEVICE_ID_CONFLICT_CODE = 'DEVICE_ID_CONFLICT';

/**
 * 本次运行的实例标识。
 *
 * 普通扩展的模块级实例不读写 storage。每次 bundle 执行（＝每个新开的页面上下文）
 * 都会重新求值一次；托管浏览器则使用宿主为本次临时会话注入的实例。
 * 见文件头那段 ⚠️：一旦把它写进 storage，镜像复制的两份就再也分不开了。
 */
const clientInstance = createRandomId();

/** 共享存储不可用时保留本次运行的 ID。 */
let cachedDeviceId: string | undefined;

/**
 * 生成一个 UUIDv4 字符串。
 *
 * 刻意不用 `crypto.randomUUID()`：目标端包含 Windows 客户端的 CEF/Chromium 75，
 * 那是 Chromium 92 才有的 API（且要求 secure context）。`crypto.getRandomValues`
 * 在 Chromium 75 就有；再退一层到 `Math.random` 只是为了让「某个环境连
 * crypto 都没有」时不至于整个扩展崩掉 —— 设备 ID 的随机性要求是「多台机器不撞」，
 * 不是密码学强度。
 */
function createRandomId(): string {
  const bytes = new Uint8Array(16);
  let filled = false;
  try {
    const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
    if (cryptoApi?.getRandomValues) {
      cryptoApi.getRandomValues(bytes);
      filled = true;
    }
  } catch {
    // 极少数环境会禁用 crypto（或在不安全上下文里抛），退回 Math.random。
  }
  if (!filled) {
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  // RFC 4122：version 4，variant 10xx。
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let index = 0; index < bytes.length; index++) {
    hex.push((bytes[index] + 0x100).toString(16).slice(1));
  }
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 直写一次 `chrome.storage.local`（存在才写）。
 *
 * 与 shared-store 事件桥是两条独立路径：桥依赖 `extension-entry.js` 在场且监听正常，
 * 直写不依赖。任一条成功就够了，所以这里全程 best-effort、绝不抛。
 */
function writeChromeStorage(key: string, value: unknown) {
  try {
    const storage = (globalThis as { chrome?: { storage?: { local?: { set?: (items: Record<string, unknown>, cb?: () => void) => undefined } } } })
      .chrome?.storage?.local;
    if (typeof storage?.set !== 'function') {
      return;
    }
    storage.set({ [key]: value }, () => {
      // 必须读一次 lastError，否则 MV3 会在控制台报未处理的写入错误。
      try {
        void (globalThis as { chrome?: { runtime?: { lastError?: unknown } } }).chrome?.runtime?.lastError;
      } catch {
        // ignore
      }
    });
  } catch {
    // storage 不可用（不透明 origin / 非扩展环境）时静默：ID 仍在内存与 localStorage 里。
  }
}

function readPersistedDeviceId(): string {
  try {
    return normalizeId(runtimeStore.get<string>(DEVICE_ID_STORAGE_KEY, ''));
  } catch {
    return '';
  }
}

function persistDeviceId(deviceId: string) {
  try {
    runtimeStore.set(DEVICE_ID_STORAGE_KEY, deviceId);
  } catch {
    // 写入失败也要让本次运行可用；下次加载会重新生成。
  }
  writeChromeStorage(DEVICE_ID_STORAGE_KEY, deviceId);
}

/**
 * 取本次运行要用的 deviceId：有持久化值就复用（＝复用槽位，不新增设备），没有才生成。
 */
function ensureDeviceId(): string {
  // The extension bridge also hydrates updates from other tabs. A live page must not
  // keep using its stale cached ID after that shared value changes.
  const persisted = readPersistedDeviceId();
  if (persisted) {
    cachedDeviceId = persisted;
    return persisted;
  }
  if (cachedDeviceId) return cachedDeviceId;
  cachedDeviceId = createRandomId();
  persistDeviceId(cachedDeviceId);
  return cachedDeviceId;
}

function hostBrowserId(): string {
  return normalizeId(runtimeStore.get(HOST_BROWSER_STORAGE_KEY, ''));
}

/**
 * 当前设备身份。
 *
 * 同步返回（5 处请求入口都在同步构造 header），因此这里只做「读缓存 / 读一次 storage」
 * 这类同步动作 —— 刻意**不**在首帧去 await `chrome.storage.local.get`：
 * 那会让第一次请求用一个临时 ID、异步回来再改，同一个运行里出现两个 ID，
 * 比直接依赖 localStorage 镜像更难排查。真实扩展里 `extension-entry.js:167` 在注入
 * 主 bundle **之前** 已把 `chrome.storage.local` 的 `common.settings.*` 全量镜像到
 * documentElement 属性与 localStorage，所以同步读得到持久化值。
 */
export function getDeviceIdentity(): { deviceId: string; clientInstance: string } {
  const browser = hostBrowserId();
  return { deviceId: ensureDeviceId(), clientInstance: UUID_V4.test(browser) ? browser : clientInstance };
}

/** 141 §7：5 处请求入口统一从这里取 header，不复制粘贴逻辑。 */
export function tikuAdapterDeviceHeaders(): Record<string, string> {
  const { deviceId, clientInstance } = getDeviceIdentity();
  return {
    [DEVICE_ID_HEADER]: deviceId,
    [DEVICE_INSTANCE_HEADER]: clientInstance
  };
}

/**
 * 服务端判 409 `DEVICE_ID_CONFLICT` 时调用：换一个新 device_id 并写回 storage。
 *
 * 仅普通扩展可换 device_id，**不动 clientInstance**：
 * instance 表示「这次运行」，换 ID 后这次运行仍然是同一次运行；服务端也只在
 * 「device_id 首次登记」时比对 instance（141 §4.3 末段），之后不再校验。
 * 顺手把 instance 也换掉会让「本次运行」这一语义自相矛盾，且没有任何收益。
 *
 * ⚠️ 调用方**只能重试一次**（141 §4.2）：第二次仍冲突说明不是镜像复制问题
 * （多半是服务端数据异常），继续换 ID 只会把设备槽位一个个耗尽。
 */
export function regenerateDeviceId(rejectedId?: string): string | undefined {
  // Only an ordinary profile owns the ID it can replace. A page cannot persist a
  // replacement in its native owner's config, so leave that explicit conflict intact.
  if (hostBrowserId() || (globalThis as { __CX_WIN_HOST__?: unknown }).__CX_WIN_HOST__) return;
  const current = ensureDeviceId();
  // The stale response may have arrived after another request already replaced this ID.
  if (rejectedId && current !== rejectedId) return current;
  const next = createRandomId();
  persistDeviceId(next);
  // If the shared mirror still reports the rejected ID (for example read-only
  // storage), do not replay the operation under the same or a transient ID.
  if (readPersistedDeviceId() !== next) return;
  cachedDeviceId = next;
  return next;
}

type DeviceChrome = {
  runtime?: { id?: string; lastError?: unknown };
  storage?: {
    local?: {
      set(items: Record<string, string>, callback: () => void): void;
      get(key: string, callback: (items: Record<string, unknown>) => void): void;
    };
    onChanged?: {
      addListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void;
      removeListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void): void;
    };
  };
};

function confirmOrdinaryBrowserDeviceId(next: string, replace: boolean): Promise<boolean> {
  const chrome = (globalThis as { chrome?: DeviceChrome }).chrome;
  const storage = chrome?.storage?.local, changes = chrome?.storage?.onChanged;
  if (!chrome?.runtime?.id || !storage || !changes) return Promise.resolve(false);
  return new Promise(resolve => {
    let confirmed = false, settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { changes.removeListener(onChange); } catch { /* extension context lost */ }
      resolve(success);
    };
    // Wait for both the Chrome acknowledgement and the existing isolated settings
    // bridge to publish the value. Do not set the private mirror optimistically.
    const check = () => { if (confirmed && readPersistedDeviceId() === next) finish(true); };
    const onChange = (keys: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && keys[DEVICE_ID_STORAGE_KEY]?.newValue === next) queueMicrotask(check);
    };
    const acknowledge = () => {
      if (chrome.runtime?.lastError) { finish(false); return; }
      confirmed = true;
      check();
    };
    const timer = setTimeout(() => finish(false), 2000);
    try {
      changes.addListener(onChange);
      if (replace) storage.set({ [DEVICE_ID_STORAGE_KEY]: next }, acknowledge);
      else storage.get(DEVICE_ID_STORAGE_KEY, items => {
        if (chrome.runtime?.lastError || normalizeId(items[DEVICE_ID_STORAGE_KEY]) !== next) finish(false);
        else acknowledge();
      });
    } catch { finish(false); }
  });
}

let browserRecovery: { rejectedId: string; pending: Promise<string | undefined> } | undefined;

/** Called only after a structured HTTP conflict. Host or caller-owned IDs are not recoverable here. */
export async function recoverDeviceIdAfterConflict(rejectedId?: string): Promise<string | undefined> {
  if (!usesBrowserAgreementGate()) return regenerateDeviceId(rejectedId);
  if (!rejectedId || hostBrowserId() || (globalThis as { __CX_WIN_HOST__?: unknown }).__CX_WIN_HOST__) return;
  if (browserRecovery) return browserRecovery.rejectedId === rejectedId ? browserRecovery.pending : undefined;

  const current = ensureDeviceId(), replace = current === rejectedId;
  const next = replace ? createRandomId() : current;
  const pending = confirmOrdinaryBrowserDeviceId(next, replace).then(ok => {
    if (!ok) return undefined;
    cachedDeviceId = next;
    return next;
  });
  const flight = { rejectedId, pending };
  browserRecovery = flight;
  try { return await pending; } finally { if (browserRecovery === flight) browserRecovery = undefined; }
}

/**
 * 判断一个响应体是不是 409 `DEVICE_ID_CONFLICT`。
 *
 * 状态码与错误码**都必须**匹配：只认状态码会把 409 的其它业务冲突（例如
 * 「同一题目正在被另一会话处理」）也当成设备冲突，于是换 device_id 白跑一次；
 * 只认 code 则可能被 200 响应体里的同名字段误触发。
 */
export function isDeviceIdConflict(status: number, body: unknown): boolean {
  if (status !== 409) {
    return false;
  }
  if (!body || typeof body !== 'object') {
    return false;
  }
  const record = body as { code?: unknown; error?: unknown };
  const direct = normalizeId(record.code);
  if (direct && direct.toUpperCase() === DEVICE_ID_CONFLICT_CODE) {
    return true;
  }
  const nested = record.error;
  if (nested && typeof nested === 'object') {
    return normalizeId((nested as { code?: unknown }).code).toUpperCase() === DEVICE_ID_CONFLICT_CODE;
  }
  return false;
}

/**
 * 只给**测试**用的重置入口：忘掉缓存的 deviceId，让下一次取值重新走 storage。
 *
 * 生产代码不调用它 —— `clientInstance` 刻意不可重置，它的「一次运行一个值」正是
 * 冲突检测的判据；能重置就等于给了「在运行中伪造同一个 instance」的口子。
 */
export function __resetDeviceIdentityCacheForTests(): void {
  cachedDeviceId = undefined;
}
