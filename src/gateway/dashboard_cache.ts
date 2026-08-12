type CacheEntry<T> = {
  data: T;
  expiresAt: number;
};

const store = new Map<string, CacheEntry<unknown>>();

export function cached<T>(key: string, ttlMs: number, fn: () => T): T {
  const now = Date.now();
  const existing = store.get(key);
  if (existing && now < existing.expiresAt) {
    return existing.data as T;
  }
  const data = fn();
  store.set(key, { data, expiresAt: now + Math.max(0, ttlMs) });
  return data;
}

export async function cachedAsync<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const existing = store.get(key);
  if (existing && now < existing.expiresAt) {
    return existing.data as T;
  }
  const data = await fn();
  store.set(key, { data, expiresAt: now + Math.max(0, ttlMs) });
  return data;
}

export function peekCached<T>(key: string): T | null {
  const existing = store.get(key);
  return existing ? (existing.data as T) : null;
}

export function clearDashboardCache(): void {
  store.clear();
}
