// Generic localStorage snapshot cache for offline READ fallback (F65).
// Parity with the Check Time offline-field-cache: the last-known list survives an
// offline reload so the worker sees data instead of an error. READ cache only —
// mutations go through the durable time-event queue (offlineTimeQueue), not here.

const NAMESPACE = 'ccache:'
// Skip payloads larger than this so a big list never trips the ~5MB localStorage
// quota and evicts the small time-event queue's own storage.
const MAX_BYTES = 512 * 1024

export interface Snapshot<T> {
  data: T
  cachedAt: string // ISO timestamp of the successful fetch this snapshot came from
}

// localStorage access itself can throw (Safari private mode, storage disabled),
// so every entry point routes through here and treats "unavailable" as null.
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export function saveSnapshot<T>(key: string, data: T): void {
  const store = storage()
  if (!store) return
  try {
    const snapshot: Snapshot<T> = { data, cachedAt: new Date().toISOString() }
    const serialized = JSON.stringify(snapshot)
    if (serialized.length > MAX_BYTES) {
      // Too big to cache safely — drop any stale entry rather than risk a quota throw.
      store.removeItem(NAMESPACE + key)
      return
    }
    store.setItem(NAMESPACE + key, serialized)
  } catch {
    // Quota exceeded or storage unavailable — the cache is best-effort.
  }
}

export function readSnapshot<T>(key: string): Snapshot<T> | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(NAMESPACE + key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Snapshot<T>
    if (!parsed || typeof parsed.cachedAt !== 'string' || !('data' in parsed)) return null
    return parsed
  } catch {
    return null
  }
}

// Remove every ccache:* key. Called on logout so one worker's cached list never
// leaks to the next PIN login on a shared device.
export function clearAllSnapshots(): void {
  const store = storage()
  if (!store) return
  try {
    const keys: string[] = []
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i)
      if (k && k.startsWith(NAMESPACE)) keys.push(k)
    }
    for (const k of keys) store.removeItem(k)
  } catch {
    // Best-effort clear; nothing to do if storage is unreachable.
  }
}
