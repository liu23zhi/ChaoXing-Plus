const memoryStore = new Map<string, unknown>();

const SHARED_RUNTIME_KEYS = new Set([
  'common.settings.tiku-adapter.baseurl',
  'common.settings.tiku-adapter.key'
]);

const SHARED_STORE_HYDRATE_EVENT = 'chaoxing-plus:shared-store-hydrate';
const SHARED_STORE_SYNC_EVENT = 'chaoxing-plus:shared-store-sync';

function getSharedAttributeName(key: string) {
  return `data-chaoxing-plus-shared-${key.replace(/[^a-z0-9_-]/gi, '-')}`;
}

function readSharedBootstrapValue(key: string): string | undefined {
  if (!SHARED_RUNTIME_KEYS.has(key)) {
    return undefined;
  }

  try {
    const root = document.documentElement;
    const value = root?.getAttribute(getSharedAttributeName(key));
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function readLocal<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (raw === null) {
    const bootstrapValue = readSharedBootstrapValue(key);
    if (typeof bootstrapValue === 'string') {
      localStorage.setItem(key, JSON.stringify(bootstrapValue));
      return bootstrapValue as T;
    }
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
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

  for (const key of SHARED_RUNTIME_KEYS) {
    const value = (detail as Record<string, unknown>)[key];
    if (typeof value !== 'string') {
      continue;
    }

    writeMemory(key, value);
    localStorage.setItem(key, JSON.stringify(value));
    try {
      document.documentElement?.setAttribute(getSharedAttributeName(key), value);
    } catch {
      // ignore attribute sync failures
    }
  }
}

function emitSharedRuntimeSync(key: string, value: unknown) {
  if (!SHARED_RUNTIME_KEYS.has(key) || typeof value !== 'string') {
    return;
  }

  try {
    document.documentElement?.setAttribute(getSharedAttributeName(key), value);
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
    return writeMemory(key, readLocal(key, fallback));
  },
  set<T>(key: string, value: T): void {
    writeMemory(key, value);
    localStorage.setItem(key, JSON.stringify(value));
    emitSharedRuntimeSync(key, value);
  },
  remove(key: string): void {
    memoryStore.delete(key);
    localStorage.removeItem(key);
  }
};
