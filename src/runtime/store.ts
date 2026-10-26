const memoryStore = new Map<string, unknown>();

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

interface LocalReadResult<T> {
  value: T;
  storageUnavailable: boolean;
}

function readLocal<T>(key: string, fallback: T): LocalReadResult<T> {
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
      try {
        localStorage.setItem(key, JSON.stringify(bootstrapValue));
      } catch {
        // 不透明 origin 无法持久化，退回内存值即可。
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
  memoryStore.set(key, value);
  return value;
}

function hydrateSharedRuntimeValues(detail: unknown) {
  if (!detail || typeof detail !== 'object') {
    return;
  }

  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    if (!shouldShareStoreKey(key)) {
      continue;
    }

    const serialized = serializeSharedValue(value);
    if (typeof serialized !== 'string') {
      continue;
    }

    writeMemory(key, value);
    try {
      localStorage.setItem(key, serialized);
    } catch {
      // 不透明 origin（about:blank/srcdoc）无法持久化，仅保留内存值与属性镜像。
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
    const result = readLocal(key, fallback);
    if (result.storageUnavailable && memoryStore.has(key)) {
      return memoryStore.get(key) as T;
    }
    return writeMemory(key, result.value);
  },
  set<T>(key: string, value: T): void {
    writeMemory(key, value);
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // 不透明 origin（about:blank/srcdoc）无法持久化，仅保留内存值。
    }
    emitSharedRuntimeSync(key, value);
  },
  remove(key: string): void {
    memoryStore.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore opaque origin storage failures
    }
  }
};
