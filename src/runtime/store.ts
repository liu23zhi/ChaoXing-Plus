const memoryStore = new Map<string, unknown>();
const memoryRemovedKeys = new Set<string>();

const SHARED_STORE_PREFIXES = [
  'common.settings.',
  'cx.new.study.',
  'cx.new.work.',
  'cx.new.auto-read.',
  'cx.new.study-dispatcher.'
];
const SHARED_STORE_EXCLUDED_KEYS = new Set([
  'common.work-results.results',
]);
const SHARED_STORE_EXACT_KEYS = new Set([
  'common.apps.question-caches'
]);

const SHARED_STORE_HYDRATE_EVENT = 'chaoxing-plus:shared-store-hydrate';
const SHARED_STORE_SYNC_EVENT = 'chaoxing-plus:shared-store-sync';
const WINDOWS_NO_DISK_WRITE_KEY = 'common.settings.windows-no-disk-write';

function isWindowsHostRuntime() {
  try {
    return Boolean((window as unknown as { __CX_WIN_HOST__?: unknown }).__CX_WIN_HOST__);
  } catch {
    return false;
  }
}

function shouldShareStoreKey(key: string) {
  return SHARED_STORE_EXCLUDED_KEYS.has(key) === false
    && (SHARED_STORE_EXACT_KEYS.has(key) || SHARED_STORE_PREFIXES.some((prefix) => key.startsWith(prefix)));
}

function getSharedAttributeName(key: string) {
  return `data-chaoxing-plus-shared-${key.replace(/[^a-z0-9_-]/gi, '-')}`;
}

function serializeSharedValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function readSharedBootstrapValue<T>(key: string): T | undefined {
  if (!shouldShareStoreKey(key)) {
    return undefined;
  }

  try {
    const root = document.documentElement;
    const value = root?.getAttribute(getSharedAttributeName(key));
    if (typeof value !== 'string' || value.length === 0) {
      return undefined;
    }
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function isWindowsNoDiskWrite() {
  if (!isWindowsHostRuntime()) {
    return false;
  }
  if (memoryStore.has(WINDOWS_NO_DISK_WRITE_KEY)) {
    return memoryStore.get(WINDOWS_NO_DISK_WRITE_KEY) === true;
  }

  const bootstrapValue = readSharedBootstrapValue<boolean>(WINDOWS_NO_DISK_WRITE_KEY);
  if (bootstrapValue !== undefined) {
    writeMemory(WINDOWS_NO_DISK_WRITE_KEY, bootstrapValue);
    return bootstrapValue === true;
  }

  try {
    const raw = localStorage.getItem(WINDOWS_NO_DISK_WRITE_KEY);
    if (raw !== null) {
      const storedValue = JSON.parse(raw) as unknown;
      writeMemory(WINDOWS_NO_DISK_WRITE_KEY, storedValue);
      return storedValue === true;
    }
  } catch {
    // Opaque origins may not expose localStorage.
  }
  return false;
}

interface LocalReadResult<T> {
  value: T;
  storageUnavailable: boolean;
}

function readLocal<T>(key: string, fallback: T, persistBootstrapValue = true): LocalReadResult<T> {
  let raw: string | null | undefined;
  try {
    raw = localStorage.getItem(key);
  } catch {
    // Windows 端会注入 about:blank/srcdoc 等不透明 origin 的 frame，访问 localStorage 会抛 SecurityError。
    raw = undefined;
  }
  if (raw === undefined) {
    const bootstrapValue = readSharedBootstrapValue<T>(key);
    return {
      value: bootstrapValue === undefined ? fallback : bootstrapValue,
      storageUnavailable: true
    };
  }
  if (raw === null) {
    const bootstrapValue = readSharedBootstrapValue<T>(key);
    if (bootstrapValue !== undefined) {
      if (persistBootstrapValue) {
        try {
          localStorage.setItem(key, JSON.stringify(bootstrapValue));
        } catch {
          // 不透明 origin 无法持久化，退回内存值即可。
        }
      }
      return { value: bootstrapValue, storageUnavailable: false };
    }
    return { value: fallback, storageUnavailable: false };
  }
  try {
    return { value: JSON.parse(raw) as T, storageUnavailable: false };
  } catch {
    return { value: fallback, storageUnavailable: false };
  }
}

function writeMemory<T>(key: string, value: T) {
  memoryRemovedKeys.delete(key);
  memoryStore.set(key, value);
  return value;
}

function hydrateSharedRuntimeValues(detail: unknown) {
  if (!detail || typeof detail !== 'object') {
    return;
  }

  const values = detail as Record<string, unknown>;
  if (isWindowsHostRuntime() && Object.prototype.hasOwnProperty.call(values, WINDOWS_NO_DISK_WRITE_KEY)) {
    // Determine the write policy before hydrating any other key in this payload.
    writeMemory(WINDOWS_NO_DISK_WRITE_KEY, values[WINDOWS_NO_DISK_WRITE_KEY]);
  }

  for (const [key, value] of Object.entries(values)) {
    if (!shouldShareStoreKey(key)) {
      continue;
    }

    const serialized = serializeSharedValue(value);
    if (typeof serialized !== 'string') {
      continue;
    }

    writeMemory(key, value);
    if (!isWindowsNoDiskWrite()) {
      try {
        localStorage.setItem(key, serialized);
      } catch {
        // 不透明 origin（about:blank/srcdoc）无法持久化，仅保留内存值与属性镜像。
      }
    }
    try {
      document.documentElement?.setAttribute(getSharedAttributeName(key), serialized);
    } catch {
      // ignore attribute sync failures
    }
  }
}

function emitSharedRuntimeSync(key: string, value: unknown) {
  if (!shouldShareStoreKey(key)) {
    return;
  }

  const serialized = serializeSharedValue(value);
  if (typeof serialized !== 'string') {
    return;
  }

  try {
    document.documentElement?.setAttribute(getSharedAttributeName(key), serialized);
    document.dispatchEvent(
      new CustomEvent(SHARED_STORE_SYNC_EVENT, {
        detail: {
          [key]: value
        }
      })
    );
  } catch {
    // ignore cross-context sync failures
  }
}

try {
  document.addEventListener(SHARED_STORE_HYDRATE_EVENT, (event) => {
    const detail = typeof event === 'object' && event && 'detail' in event ? (event as { detail?: unknown }).detail : undefined;
    hydrateSharedRuntimeValues(detail);
  });
} catch {
  // ignore non-browser environments
}

export const runtimeStore = {
  get<T>(key: string, fallback: T): T {
    if (memoryRemovedKeys.has(key)) {
      return fallback;
    }
    const noDiskWrite = isWindowsNoDiskWrite();
    if (noDiskWrite && memoryStore.has(key)) {
      return memoryStore.get(key) as T;
    }
    if (noDiskWrite) {
      const bootstrapValue = readSharedBootstrapValue<T>(key);
      if (bootstrapValue !== undefined) {
        return writeMemory(key, bootstrapValue);
      }
      const existing = readLocal(key, fallback, false);
      return writeMemory(key, existing.value);
    }
    const result = readLocal(key, fallback);
    if (result.storageUnavailable && memoryStore.has(key)) {
      return memoryStore.get(key) as T;
    }
    return writeMemory(key, result.value);
  },
  set<T>(key: string, value: T): void {
    writeMemory(key, value);
    if (!isWindowsNoDiskWrite()) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // 不透明 origin（about:blank/srcdoc）无法持久化，仅保留内存值。
      }
    }
    emitSharedRuntimeSync(key, value);
  },
  remove(key: string): void {
    const noDiskWrite = isWindowsNoDiskWrite();
    memoryStore.delete(key);
    if (noDiskWrite) {
      memoryRemovedKeys.add(key);
      if (shouldShareStoreKey(key)) {
        try {
          document.documentElement?.removeAttribute(getSharedAttributeName(key));
        } catch {
          // Ignore attribute cleanup failures in opaque or incomplete documents.
        }
      }
    } else {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore opaque origin storage failures
      }
    }
  }
};
