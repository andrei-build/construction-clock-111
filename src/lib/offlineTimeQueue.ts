import { addTimeEvent, uploadSafetySignature, type Geo } from './api'
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
  // OFFLINE-FIX-1 (б): счётчик попыток реплея и карантин «ядовитой» строки — после N провалов
  // строку перестаём ретраить и НЕ удаляем данные, чтобы она не блокировала остальную очередь.
  attempts?: number
  quarantined?: boolean
  // OFFLINE-FIX-1 (г): офлайн-подпись ТБ. Подпись (PNG Blob) и версия свода едут в очереди вместе
  // с check_in; при реплее заливаются через uploadSafetySignature. sentEventId проставляется после
  // успешной вставки time_event, чтобы повторная заливка подписи НЕ пересоздавала событие смены.
  signature?: Blob
  docVersion?: string
  sentEventId?: string
}

const DB_NAME = 'construction-clock-offline'
const DB_VERSION = 1
const STORE_NAME = 'time-events'
// OFFLINE-FIX-1 (б): после стольких провальных попыток реплея строка уходит в карантин.
const MAX_FLUSH_ATTEMPTS = 5

let dbPromise: Promise<IDBDatabase> | null = null
let memoryQueue: QueuedTimeEvent[] | null = null
// OFFLINE-FIX-1 (в): последняя запись в IndexedDB упала (квота/приватный режим/недоступно).
// Раньше catch в saveToDb молча проглатывал — теперь флаг поднимается, чтобы баннер/CheckIn
// предупредили пользователя, что отметка держится только в памяти и может пропасть.
let persistError = false

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

// OFFLINE-FIX-1 (б/г): обновить одну строку очереди на месте (attempts/quarantined/sentEventId).
// Память обновляем всегда (реплей это видит), IndexedDB — best-effort (как и остальная очередь).
async function updateQueuedTimeEvent(row: QueuedTimeEvent) {
  const rows = await ensureMemoryQueue()
  memoryQueue = sortQueue([...rows.filter((r) => r.id !== row.id), row])
  try {
    await saveToDb(row)
  } catch {
    // Persistence is best-effort; the in-memory copy still drives this session's replay.
  }
}

export async function getQueuedTimeEvents(profileId?: string) {
  const rows = await ensureMemoryQueue()
  const filtered = profileId ? rows.filter((row) => row.profileId === profileId) : rows
  return sortQueue(filtered)
}

// OFFLINE-FIX-1 (в): true, если последняя попытка сохранить отметку в IndexedDB упала (квота и т.п.).
export function getTimeQueuePersistError() {
  return persistError
}

// OFFLINE-FIX-1 (б): сколько строк ушло в карантин (провалили реплей MAX_FLUSH_ATTEMPTS раз).
export async function getQuarantinedCount(profileId?: string) {
  const rows = await getQueuedTimeEvents(profileId)
  return rows.filter((row) => row.quarantined).length
}

export async function queueTimeEvent(
  profile: Profile,
  type: QueueableTimeEventType,
  projectId: string | null,
  geo: Geo,
  // OFFLINE-FIX-1 (а): стабильный client_id, сгенерённый в CheckIn ДО онлайн-попытки. row.id === он,
  // поэтому реплей шлёт client_id: row.id — тот же, что пытались отправить онлайн → дубль ловится 23505.
  clientId?: string,
  // OFFLINE-FIX-1 (г): офлайн-подпись ТБ (Blob) и версия свода — едут с офлайн check_in.
  options: { signature?: Blob; docVersion?: string } = {},
) {
  const row: QueuedTimeEvent = {
    id: clientId ?? queueId(),
    orgId: profile.org_id,
    profileId: profile.id,
    type,
    projectId,
    geo,
    queuedAt: new Date().toISOString(),
    ...(options.signature ? { signature: options.signature, docVersion: options.docVersion } : {}),
  }

  const rows = await ensureMemoryQueue()
  memoryQueue = sortQueue([...rows, row])
  try {
    await saveToDb(row)
    persistError = false
  } catch {
    // OFFLINE-FIX-1 (в): квота/приватный режим/недоступно. Строка остаётся в памяти (реплей этой
    // сессии не теряется), но при перезагрузке пропадёт — поднимаем флаг, чтобы UI предупредил.
    persistError = true
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

// OFFLINE-FIX-1: доставка одной строки очереди — вставка time_event и (если есть) заливка подписи ТБ.
// sentEventId кэшируется сразу после успешной вставки, чтобы повторная попытка залить подпись НЕ
// пересоздавала событие смены (иначе на второй заход поймали бы 23505 и потеряли подпись).
async function sendQueuedRow(profile: Profile, row: QueuedTimeEvent) {
  let eventId = row.sentEventId
  if (!eventId) {
    // F13: offline_pending_sync — контекст, что событие пришло из очереди; gps_error_kind/needs_review
    // проставит addTimeEvent из row.geo (errorKind сохранился в очереди как поле Geo).
    eventId = await addTimeEvent(
      profile,
      row.type,
      row.projectId,
      row.geo,
      row.queuedAt,
      { offline_queued: true, offline_pending_sync: true, client_id: row.id },
    )
    if (row.signature && row.projectId) {
      await updateQueuedTimeEvent({ ...row, sentEventId: eventId })
    }
  }
  if (row.signature && row.projectId) {
    await uploadSafetySignature(profile, row.projectId, eventId, row.signature, row.docVersion ?? 'v1')
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
    // OFFLINE-FIX-1 (б): карантинную строку не ретраим — она не должна блокировать остальные.
    if (row.quarantined) continue
    try {
      await sendQueuedRow(profile, row)
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      if (code === '23505') {
        // 23505: это событие уже легло на прошлом реплее — безопасно убрать из очереди.
      } else {
        // OFFLINE-FIX-1 (б): не-23505 больше НЕ роняет весь цикл (раньше `throw err` навсегда
        // блокировал реплей остальных строк). Считаем попытки, после MAX — карантин, и продолжаем
        // сливать остальные строки. Данные строки не удаляем — уходят в карантин с пометкой.
        const attempts = (row.attempts ?? 0) + 1
        await updateQueuedTimeEvent({ ...row, attempts, quarantined: attempts >= MAX_FLUSH_ATTEMPTS })
        continue
      }
    }
    await removeQueuedTimeEvent(row.id)
    sent += 1
    onSent?.(row)
  }

  return sent
}
