import { addTimeEvent, type Geo } from './api'
import type { Profile, TimeEvent, TimeEventType } from './types'

type QueueableTimeEventType = Exclude<TimeEventType, 'adjustment'>

export interface QueuedTimeEvent {
  id: string
  orgId: string
  profileId: string
  type: QueueableTimeEventType
  projectId: string | null
  geo: Geo
  queuedAt: string
}

const DB_NAME = 'construction-clock-offline'
const DB_VERSION = 1
const STORE_NAME = 'time-events'

let dbPromise: Promise<IDBDatabase> | null = null
let memoryQueue: QueuedTimeEvent[] | null = null

function isBrowser() {
  return typeof window !== 'undefined' && 'indexedDB' in window
}

function openDb() {
  if (!isBrowser()) return Promise.reject(new Error('IndexedDB unavailable'))
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('profileId', 'profileId', { unique: false })
        store.createIndex('queuedAt', 'queuedAt', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    request.onblocked = () => reject(new Error('IndexedDB blocked'))
  })

  return dbPromise
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function sortQueue(rows: QueuedTimeEvent[]) {
  return [...rows].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
}

function queueId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function readAllFromDb(): Promise<QueuedTimeEvent[]> {
  const db = await openDb()
  const tx = db.transaction(STORE_NAME, 'readonly')
  const rows = await requestToPromise<QueuedTimeEvent[]>(tx.objectStore(STORE_NAME).getAll())
  return sortQueue(rows)
}

async function saveToDb(row: QueuedTimeEvent) {
  const db = await openDb()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  tx.objectStore(STORE_NAME).put(row)
  await transactionDone(tx)
}

async function deleteFromDb(id: string) {
  const db = await openDb()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  tx.objectStore(STORE_NAME).delete(id)
  await transactionDone(tx)
}

async function ensureMemoryQueue() {
  if (memoryQueue) return memoryQueue
  try {
    memoryQueue = await readAllFromDb()
  } catch {
    memoryQueue = []
  }
  return memoryQueue
}

export async function getQueuedTimeEvents(profileId?: string) {
  const rows = await ensureMemoryQueue()
  const filtered = profileId ? rows.filter((row) => row.profileId === profileId) : rows
  return sortQueue(filtered)
}

export async function queueTimeEvent(
  profile: Profile,
  type: QueueableTimeEventType,
  projectId: string | null,
  geo: Geo,
) {
  const row: QueuedTimeEvent = {
    id: queueId(),
    orgId: profile.org_id,
    profileId: profile.id,
    type,
    projectId,
    geo,
    queuedAt: new Date().toISOString(),
  }

  const rows = await ensureMemoryQueue()
  memoryQueue = sortQueue([...rows, row])
  try {
    await saveToDb(row)
  } catch {
    // Keep the in-memory queue alive even if the browser refuses persistent storage.
  }
  return row
}

export async function removeQueuedTimeEvent(id: string) {
  const rows = await ensureMemoryQueue()
  memoryQueue = rows.filter((row) => row.id !== id)
  try {
    await deleteFromDb(id)
  } catch {
    // The queue has already been removed from memory; retrying a missing row is harmless.
  }
}

export function queuedTimeEventToTimeEvent(row: QueuedTimeEvent): TimeEvent {
  // F13: geo уже несёт errorKind (доп. поле Geo); пробрасываем причину и needs_review в локальный слепок.
  const unverified = row.geo.status !== 'good'
  return {
    id: `offline-${row.id}`,
    org_id: row.orgId,
    profile_id: row.profileId,
    project_id: row.projectId,
    event_type: row.type,
    event_time: row.queuedAt,
    gps_status: row.geo.status,
    metadata: {
      lat: row.geo.lat,
      lng: row.geo.lng,
      offline: true,
      offline_pending_sync: true,
      ...(row.geo.errorKind ? { gps_error_kind: row.geo.errorKind } : {}),
      ...(unverified ? { location_unverified: true, needs_review: true } : {}),
    },
  }
}

export async function flushQueuedTimeEvents(
  profile: Profile,
  onSent?: (row: QueuedTimeEvent) => void,
) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0

  const rows = await getQueuedTimeEvents(profile.id)
  let sent = 0

  for (const row of rows) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) break
    try {
      // F13: offline_pending_sync — контекст, что событие пришло из очереди; gps_error_kind/needs_review
      // проставит addTimeEvent из row.geo (errorKind сохранился в очереди как поле Geo).
      await addTimeEvent(profile, row.type, row.projectId, row.geo, row.queuedAt, { offline_queued: true, offline_pending_sync: true, client_id: row.id })
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      if (code !== '23505') throw err
      // 23505: this exact event already landed on a previous flush — safe to drop from queue
    }
    await removeQueuedTimeEvent(row.id)
    sent += 1
    onSent?.(row)
  }

  return sent
}
