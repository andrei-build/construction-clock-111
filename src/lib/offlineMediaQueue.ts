// Durable offline queue for field-worker MEDIA uploads (F51). Parity with the old Check
// Time offline-photo behavior: when a worker captures a task photo offline (or the network
// drops mid-upload), the image is stored durably and the REAL upload is replayed on
// reconnect instead of being lost. This is the media analogue of the F64 write-queue
// (offlineFieldActions), but blobs are far too large for the shared ~5MB localStorage
// quota — so image bytes live in IndexedDB, with only lightweight metadata alongside.
//
// Storage hygiene mirrors offlineFieldActions' storage(): every IndexedDB access is wrapped
// so unavailable/denied storage (Safari private mode, disabled IDB) degrades to a no-op
// instead of throwing. Replay is in createdAt order; a poison item is dropped past
// MAX_RETRIES so it can't wedge everything queued behind it; total bytes/count are soft-
// capped so a wedged queue can't grow without bound.

import type { Profile, Task } from './types'
import { uploadTaskPhoto } from './api'

const DB_NAME = 'ccmediaq'
const DB_VERSION = 1
const STORE = 'uploads'
// Soft caps: keep the queue bounded so a wedged item can't grow storage without limit.
const MAX_QUEUED = 50
const MAX_TOTAL_BYTES = 80 * 1024 * 1024 // 80 MB of pending image bytes
// Drop an upload once it has failed this many replays — a permanently-rejected item
// (deleted task, revoked access) must not wedge everything queued behind it.
const MAX_RETRIES = 8

// task_photo is the only kind today (Projects task-photo capture). Kept as a union so a
// future field-photo call-site only needs its own replay branch, not a new module.
export type MediaUploadKind = 'task_photo'

export interface TaskPhotoTarget {
  task: Task
}

export interface QueuedMediaUpload {
  id: string // stable unique id for this queued upload (primary key)
  dedupeKey: string // logical key — re-enqueuing the same capture does not duplicate
  createdAt: string // ISO timestamp of when it was queued (replay order)
  retries: number
  kind: MediaUploadKind
  target: TaskPhotoTarget
  fileName: string
  fileType: string
  fileSize: number
  blob: Blob // the raw image bytes (IndexedDB stores Blob/File via structured clone)
}

export interface MediaUploadInput {
  kind: MediaUploadKind
  dedupeKey: string
  file: File
  target: TaskPhotoTarget
}

// IndexedDB access itself can throw (private mode, storage disabled), so every entry point
// routes through here and treats "unavailable" as null.
function idb(): IDBFactory | null {
  try {
    if (typeof indexedDB === 'undefined') return null
    return indexedDB
  } catch {
    return null
  }
}

function uploadId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function openDb(): Promise<IDBDatabase | null> {
  const factory = idb()
  if (!factory) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const req = factory.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' })
          store.createIndex('dedupeKey', 'dedupeKey', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function isValid(row: unknown): row is QueuedMediaUpload {
  const r = row as Partial<QueuedMediaUpload> | null
  return !!r && typeof r.id === 'string' && typeof r.kind === 'string' && r.blob instanceof Blob
    && typeof r.createdAt === 'string' && !!r.target
}

function getAll(db: IDBDatabase): Promise<QueuedMediaUpload[]> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      req.onsuccess = () => resolve((Array.isArray(req.result) ? req.result : []).filter(isValid))
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

function getByDedupeKey(db: IDBDatabase, dedupeKey: string): Promise<QueuedMediaUpload | null> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).index('dedupeKey').get(dedupeKey)
      req.onsuccess = () => resolve(isValid(req.result) ? req.result : null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function put(db: IDBDatabase, row: QueuedMediaUpload): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(row)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

function deleteById(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

function closeQuietly(db: IDBDatabase) {
  try { db.close() } catch { /* already closed */ }
}

// Soft cap: after an enqueue, drop the OLDEST uploads until we are back under both the count
// and total-bytes budget, so a wedged queue can never grow without bound.
async function enforceCaps(db: IDBDatabase): Promise<void> {
  const rows = (await getAll(db)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  let count = rows.length
  let bytes = rows.reduce((sum, r) => sum + (r.fileSize || 0), 0)
  for (const row of rows) {
    if (count <= MAX_QUEUED && bytes <= MAX_TOTAL_BYTES) break
    await deleteById(db, row.id)
    count -= 1
    bytes -= row.fileSize || 0
  }
}

// Enqueue a media upload. If an upload with the same dedupeKey is already pending, the
// existing one is returned unchanged so a re-submit / retry never duplicates the image.
export async function enqueueMediaUpload(input: MediaUploadInput): Promise<QueuedMediaUpload | null> {
  const db = await openDb()
  if (!db) return null
  try {
    const existing = await getByDedupeKey(db, input.dedupeKey)
    if (existing) return existing

    const row: QueuedMediaUpload = {
      id: uploadId(),
      dedupeKey: input.dedupeKey,
      createdAt: new Date().toISOString(),
      retries: 0,
      kind: input.kind,
      target: input.target,
      fileName: input.file.name,
      fileType: input.file.type,
      fileSize: input.file.size,
      blob: input.file,
    }
    await put(db, row)
    await enforceCaps(db)
    return row
  } catch {
    return null
  } finally {
    closeQuietly(db)
  }
}

export async function getQueuedMediaUploads(): Promise<QueuedMediaUpload[]> {
  const db = await openDb()
  if (!db) return []
  try {
    return (await getAll(db)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  } finally {
    closeQuietly(db)
  }
}

async function bumpRetry(db: IDBDatabase, row: QueuedMediaUpload): Promise<void> {
  const next = row.retries + 1
  // Drop the upload once it has failed too many times so one poison item can't block the queue.
  if (next > MAX_RETRIES) { await deleteById(db, row.id); return }
  await put(db, { ...row, retries: next })
}

async function replayUpload(profile: Profile, row: QueuedMediaUpload): Promise<void> {
  const file = new File([row.blob], row.fileName || 'photo.jpg', { type: row.fileType })
  switch (row.kind) {
    case 'task_photo':
      await uploadTaskPhoto(profile, row.target.task, file)
      return
  }
}

// Replay queued uploads in createdAt order while online. Succeeded items are removed; a
// failed item keeps its place (retry later) unless it exhausts MAX_RETRIES.
export async function flushMediaUploads(profile: Profile): Promise<number> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0
  const db = await openDb()
  if (!db) return 0
  let sent = 0
  try {
    const rows = (await getAll(db)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const row of rows) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) break
      try {
        await replayUpload(profile, row)
      } catch {
        await bumpRetry(db, row)
        continue
      }
      await deleteById(db, row.id)
      sent += 1
    }
  } finally {
    closeQuietly(db)
  }
  return sent
}

// Remove every queued upload. Called on logout so one worker's pending photos never replay
// under the next PIN login on a shared device.
export async function clearAllMediaUploads(): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
        tx.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  } finally {
    closeQuietly(db)
  }
}
