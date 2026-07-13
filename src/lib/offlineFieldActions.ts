// Generic localStorage-backed offline WRITE queue for field-worker mutations (F64).
// Parity with the old Check Time offline-field-actions: when a worker is offline,
// a task-done / message-send is stored durably and replayed on reconnect instead of
// failing. Clock in/out has its own durable queue (offlineTimeQueue) — this one is
// only for the non-time mutations that used to error offline.
//
// Storage model mirrors offlineFieldCache: a single namespaced localStorage key holds
// the JSON array, every access is wrapped so Safari private mode / disabled storage
// degrades to an in-memory no-op rather than throwing.

import type { MessageRow, Profile, Task } from './types'
import { markTaskDone, sendMessage } from './api'

const STORAGE_KEY = 'ccfieldq:v1'
// Soft cap: keep the newest N actions so a wedged queue never grows without bound or
// trips the ~5MB localStorage quota and evicts the time-event queue's own storage.
const MAX_QUEUED = 200
// Drop an action once it has failed this many replays — a permanently-rejected item
// (deleted task, revoked recipient) must not wedge everything queued behind it.
const MAX_RETRIES = 8

// task_claim is kept in the union for parity with the old Check Time queue, but CC has
// no task-claim API/column today, so no call site enqueues it (see BACKEND REQUEST).
export type FieldActionKind = 'task_claim' | 'task_status' | 'message_send'

export interface TaskClaimPayload {
  taskId: string
}

export interface TaskStatusPayload {
  task: Task
  mediaId: string | null
}

export interface MessageSendPayload {
  recipientId: string
  body: string
  priority: MessageRow['priority']
}

interface FieldActionBase {
  clientActionId: string // stable unique id for this queued action (dedupe on replay)
  dedupeKey: string // logical key — re-enqueuing the same action does not duplicate
  createdAt: string // ISO timestamp of when it was queued (replay order)
  status: 'pending'
  retries: number
}

export type QueuedFieldAction =
  | (FieldActionBase & { kind: 'task_claim'; payload: TaskClaimPayload })
  | (FieldActionBase & { kind: 'task_status'; payload: TaskStatusPayload })
  | (FieldActionBase & { kind: 'message_send'; payload: MessageSendPayload })

export type FieldActionInput =
  | { kind: 'task_claim'; dedupeKey: string; payload: TaskClaimPayload }
  | { kind: 'task_status'; dedupeKey: string; payload: TaskStatusPayload }
  | { kind: 'message_send'; dedupeKey: string; payload: MessageSendPayload }

// localStorage access itself can throw (Safari private mode, storage disabled), so every
// entry point routes through here and treats "unavailable" as null.
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

function actionId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function sortByCreatedAt(rows: QueuedFieldAction[]) {
  return [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function readAll(): QueuedFieldAction[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Tolerate a malformed / partially-written array: keep only well-formed rows.
    return parsed.filter((row): row is QueuedFieldAction =>
      row && typeof row.clientActionId === 'string' && typeof row.kind === 'string' && 'payload' in row)
  } catch {
    return []
  }
}

function writeAll(rows: QueuedFieldAction[]): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(rows))
  } catch {
    // Quota exceeded or storage unavailable — the queue is best-effort durable.
  }
}

export function getQueuedFieldActions(): QueuedFieldAction[] {
  return sortByCreatedAt(readAll())
}

// Enqueue an offline mutation. If an action with the same dedupeKey is already pending,
// the existing one is returned unchanged so a re-submit / retry never duplicates.
export function enqueueFieldAction(input: FieldActionInput): QueuedFieldAction {
  const rows = readAll()
  const existing = rows.find((row) => row.dedupeKey === input.dedupeKey)
  if (existing) return existing

  const action = {
    clientActionId: actionId(),
    dedupeKey: input.dedupeKey,
    createdAt: new Date().toISOString(),
    status: 'pending' as const,
    retries: 0,
    kind: input.kind,
    payload: input.payload,
  } as QueuedFieldAction

  // Soft cap: drop the oldest actions once we exceed the limit.
  const next = sortByCreatedAt([...rows, action]).slice(-MAX_QUEUED)
  writeAll(next)
  return action
}

function removeAction(clientActionId: string): void {
  writeAll(readAll().filter((row) => row.clientActionId !== clientActionId))
}

function bumpRetry(clientActionId: string): void {
  const rows = readAll()
  const next = rows
    .map((row) => (row.clientActionId === clientActionId ? { ...row, retries: row.retries + 1 } : row))
    .filter((row) => row.retries <= MAX_RETRIES)
  writeAll(next)
}

async function replayAction(profile: Profile, action: QueuedFieldAction): Promise<void> {
  switch (action.kind) {
    case 'task_status':
      await markTaskDone(profile, action.payload.task, action.payload.mediaId)
      return
    case 'message_send':
      await sendMessage(profile, action.payload.recipientId, action.payload.body, action.payload.priority)
      return
    case 'task_claim':
      // No task-claim API in CC yet — nothing enqueues this kind (see BACKEND REQUEST).
      // Kept exhaustive so a future backend wiring only needs the real call here.
      throw new Error('task_claim replay unsupported')
  }
}

// Replay queued actions in createdAt order while online. Succeeded items are removed;
// a failed item keeps its place (retry later) unless it exhausts MAX_RETRIES.
export async function flushFieldActions(
  profile: Profile,
  onFlushed?: (action: QueuedFieldAction) => void,
): Promise<number> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 0

  const rows = getQueuedFieldActions()
  let sent = 0

  for (const action of rows) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) break
    try {
      await replayAction(profile, action)
    } catch {
      // Keep the action for a later flush; drop it once it has failed too many times so
      // one poison mutation cannot block everything queued behind it.
      bumpRetry(action.clientActionId)
      continue
    }
    removeAction(action.clientActionId)
    sent += 1
    onFlushed?.(action)
  }

  return sent
}

// Remove every queued action. Called on logout so one worker's pending mutations never
// replay under the next PIN login on a shared device.
export function clearAllFieldActions(): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(STORAGE_KEY)
  } catch {
    // Best-effort clear; nothing to do if storage is unreachable.
  }
}
