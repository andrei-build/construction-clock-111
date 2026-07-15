// OFFLINE-1 (pass 1a): read-through IndexedDB cache for the API layer.
// DNA law §14 — "loss of connection does not take data away": every successful READ is
// snapshotted to IndexedDB keyed by (function name + serialized args). When the browser is
// offline (or a read fails with a network error) the last snapshot is served instead of an
// empty list, and a yellow "нет связи" banner is surfaced with the time the data was stored.
//
// Scope: READ cache only. Writes/mutations are NOT queued here (that is pass 1b — see the
// existing offlineTimeQueue). This layer only wraps reads and never swallows access errors
// (A5): a 42501/PGRST failure is re-thrown so "no access" stays distinct from "no data".
//
// Raw IndexedDB, zero new dependencies. A dedicated database keeps this isolated from the
// time-event queue's DB (construction-clock-offline) so neither has to know the other's version.

const DB_NAME = 'construction-clock-read-cache'
const DB_VERSION = 1
const STORE_NAME = 'reads'

interface CacheRecord {
  key: string
  value: unknown
  cachedAt: string // ISO timestamp of the successful fetch this snapshot came from
}

// ── IndexedDB plumbing (mirrors offlineTimeQueue's idioms) ──────────────────────
let dbPromise: Promise<IDBDatabase> | null = null

function isBrowser(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window
}

function openDb(): Promise<IDBDatabase> {
  if (!isBrowser()) return Promise.reject(new Error('IndexedDB unavailable'))
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onblocked = () => reject(new Error('IndexedDB blocked'))
  })
  return dbPromise
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

// IndexedDB stores values via structured clone, so Map/Set/Date results (getProjectCrewCounts,
// getTaskPhotoIds, …) round-trip natively — no JSON flattening. Best-effort throughout: any
// storage failure (no IndexedDB, quota, private mode) degrades to "no cache", never throws.
async function readSnap<T>(key: string): Promise<{ value: T; cachedAt: string } | null> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const row = await requestToPromise<CacheRecord | undefined>(tx.objectStore(STORE_NAME).get(key))
    if (!row || typeof row.cachedAt !== 'string' || !('value' in row)) return null
    return { value: row.value as T, cachedAt: row.cachedAt }
  } catch {
    return null
  }
}

async function writeSnap(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put({ key, value, cachedAt: new Date().toISOString() } as CacheRecord)
    await transactionDone(tx)
  } catch {
    // Best-effort cache; a write failure must never change what the caller sees.
  }
}

// Clears every cached read. Wired into logout so one worker's cached lists never leak to the
// next PIN login on a shared device.
export async function clearReadCache(): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).clear()
    await transactionDone(tx)
  } catch {
    // Nothing to clear if storage is unreachable.
  }
}

// ── Finance gate ────────────────────────────────────────────────────────────────
// FINANCE DATA (payroll, profit/margin/cost, pay periods, rates) may only be persisted for
// roles that pass hasFinanceAccess. auth.tsx sets this flag from the loaded profile; it stays
// false until proven true and is reset on logout/session-loss. Finance-tagged reads are neither
// written nor served from cache while this is false.
let financeAllowed = false

export function setFinanceCacheAllowed(allowed: boolean): void {
  financeAllowed = allowed
}

// ── Offline-banner observable ────────────────────────────────────────────────────
// A minimal store the OfflineCacheBanner subscribes to. Holds the freshest cachedAt served
// from cache while offline (the time shown in "данные на HH:MM"), or null when nothing stale
// is on screen.
type OfflineCacheState = { cachedAt: string } | null
let offlineState: OfflineCacheState = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getOfflineCacheState(): OfflineCacheState {
  return offlineState
}

export function subscribeOfflineCache(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

// Reset by the banner once the browser is back online (before it refetches).
export function clearOfflineCacheState(): void {
  if (offlineState) {
    offlineState = null
    emit()
  }
}

function noteServedFromCache(cachedAt: string): void {
  // Show the freshest snapshot time among everything served this offline stretch.
  if (!offlineState || cachedAt > offlineState.cachedAt) {
    offlineState = { cachedAt }
    emit()
  }
}

// ── Network / error classification ────────────────────────────────────────────────
function isOnline(): boolean {
  if (typeof navigator === 'undefined' || !('onLine' in navigator)) return true
  return navigator.onLine
}

// A5 parity with _shared.warnReadError: a permission/RLS failure must NOT be treated as offline
// (we must not paper over "no access" with stale data). PostgREST puts the code in error.code.
function isAccessError(err: unknown): boolean {
  const code = String((err as { code?: string | null } | null)?.code ?? '')
  return code === '42501' || code === 'PGRST301' || code === 'PGRST116' || code.startsWith('PGRST3')
}

// A read that threw because the request never reached the server. supabase-js surfaces fetch
// failures as a TypeError ("Failed to fetch" / "Load failed" / "NetworkError"). Anything with a
// PostgREST access code is explicitly excluded.
function isNetworkError(err: unknown): boolean {
  if (isAccessError(err)) return false
  const e = err as { name?: string; message?: string; code?: string } | null
  if (e?.name === 'TypeError') return true
  const msg = (e?.message ?? '').toLowerCase()
  return (
    msg.includes('failed to fetch') ||
    msg.includes('load failed') ||
    msg.includes('networkerror') ||
    msg.includes('network error') ||
    msg.includes('fetch')
  )
}

// ── The wrapper ───────────────────────────────────────────────────────────────────
// Wrap a domain read so successful responses are cached and, while offline, the last snapshot
// is served (with the banner). The wrapped function keeps the exact signature of the original,
// so screens importing it from '../lib/api' are unaffected.
export function withReadCache<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R>,
  opts: { finance?: boolean } = {},
): (...args: A) => Promise<R> {
  const finance = opts.finance ?? false
  return async (...args: A): Promise<R> => {
    const cacheAllowed = !finance || financeAllowed
    const key = `${name}(${JSON.stringify(args)})`

    if (!isOnline()) {
      // Offline: serve the last good snapshot if we have one. Otherwise fall through to the
      // live call — it will typically resolve to [] (the domain modules swallow the fetch
      // error into an empty result), which we deliberately do NOT cache over a good snapshot.
      if (cacheAllowed) {
        const snap = await readSnap<R>(key)
        if (snap) {
          noteServedFromCache(snap.cachedAt)
          return snap.value
        }
      }
      return fn(...args)
    }

    try {
      const value = await fn(...args)
      // Fire-and-forget persist; the caller never waits on the write and never sees its errors.
      if (cacheAllowed) void writeSnap(key, value)
      return value
    } catch (err) {
      // Only fall back to cache on a genuine network failure — access errors (A5) re-throw.
      if (cacheAllowed && isNetworkError(err)) {
        const snap = await readSnap<R>(key)
        if (snap) {
          noteServedFromCache(snap.cachedAt)
          return snap.value
        }
      }
      throw err
    }
  }
}
