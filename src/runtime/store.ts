const memoryStore = new Map<string, unknown>();

function readLocal<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const runtimeStore = {
  get<T>(key: string, fallback: T): T {
    if (memoryStore.has(key)) {
      return memoryStore.get(key) as T;
    }
    const value = readLocal(key, fallback);
    memoryStore.set(key, value);
    return value;
  },
  set<T>(key: string, value: T): void {
    memoryStore.set(key, value);
    localStorage.setItem(key, JSON.stringify(value));
  },
  remove(key: string): void {
    memoryStore.delete(key);
    localStorage.removeItem(key);
  }
};
