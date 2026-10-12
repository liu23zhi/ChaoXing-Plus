const memoryStore = new Map<string, unknown>();

const SHARED_RUNTIME_KEY_PREFIXES = ['common.settings.', 'cx.new.study.'];

const SHARED_STORE_HYDRATE_EVENT = 'chaoxing-plus:shared-store-hydrate';
const SHARED_STORE_SYNC_EVENT = 'chaoxing-plus:shared-store-sync';

function isSharedRuntimeKey(key: string) {
  return SHARED_RUNTIME_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function getSharedAttributeName(key: string) {
  return `data-chaoxing-plus-shared-${key.replace(/[^a-z0-9_-]/gi, '-')}`;
}

function serializeSharedValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number') {
    return undefined;
  }

  return JSON.stringify(value);
}

function readSharedBootstrapValue(key: string): unknown {
  if (!isSharedRuntimeKey(key)) {
    return undefined;
  }

  try {
    const root = document.documentElement;
    const value = root?.getAttribute(getSharedAttributeName(key));
    if (typeof value !== 'string' || value.length === 0) {
      return undefined;
    }

    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  } catch {
    return undefined;
  }
}

function readLocal<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (raw === null) {
    const bootstrapValue = readSharedBootstrapValue(key);
    if (bootstrapValue !== undefined) {
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

  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    const serialized = serializeSharedValue(value);
    if (!isSharedRuntimeKey(key) || serialized === undefined) {
      continue;
    }

    writeMemory(key, value);
    localStorage.setItem(key, serialized);
    try {
      document.documentElement?.setAttribute(getSharedAttributeName(key), serialized);
    } catch {
      // ignore attribute sync failures
    }
  }
}

function emitSharedRuntimeSync(key: string, value: unknown) {
  const serialized = serializeSharedValue(value);
  if (!isSharedRuntimeKey(key) || serialized === undefined) {
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
