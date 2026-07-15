// Generic localStorage-backed offline WRITE queue for field-worker mutations (F64).
// Parity with the old Check Time offline-field-actions: when a worker is offline,
// a task-done / message-send is stored durably and replayed on reconnect instead of
// failing. Clock in/out has its own durable queue (offlineTimeQueue) — this one is
// only for the non-time mutations that used to error offline.
//
// Storage model mirrors offlineFieldCache: a single namespaced localStorage key holds
// the JSON array, every access is wrapped so Safari private mode / disabled storage
// degrades to an in-memory no-op rather than throwing.

import type { MessageRow, Profile, ProjectNote, Task } from './types'
import { markTaskDone, sendMessage } from './api'
// New (pass 1b remainder) replay targets import the RAW domain writers directly (not the api.ts
// shim, whose createTask/createProjectNote/markMaterialStatus are the offline-aware wrappers that
// call back into THIS module) — importing the raw functions keeps replay from recursing into the
// enqueue path.
import { markMaterialStatus, createTask, type MaterialStatusAction, type NewTaskInput } from './api/tasks'
import { createProjectNote } from './api/projects'

const STORAGE_KEY = 'ccfieldq:v1'
// Soft cap: keep the newest N actions so a wedged queue never grows without bound or
// trips the ~5MB localStorage quota and evicts the time-event queue's own storage.
const MAX_QUEUED = 200
// Drop an action once it has failed this many replays — a permanently-rejected item
// (deleted task, revoked recipient) must not wedge everything queued behind it.
const MAX_RETRIES = 8

// task_claim is kept in the union for parity with the old Check Time queue, but CC has
// no task-claim API/column today, so no call site enqueues it (see BACKEND REQUEST).
// material_status / task_create / note_create were added in pass 1b remainder so those mutations
// degrade to a durable queue offline instead of throwing the worker's write away (DNA §14).
export type FieldActionKind =
  | 'task_claim'
  | 'task_status'
  | 'message_send'
  | 'material_status'
  | 'task_create'
  | 'note_create'

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

// Every new-kind payload carries a client-generated clientId. It is the dedupe anchor while the
// item sits in the queue; it is ALSO the seed for the optimistic offline id handed back to the UI
// (`offline-<clientId>`). NOTE: material_status is a task state-transition (RPC UPDATE) so a
// double-replay is naturally idempotent; task_create / note_create are INSERTs with no server-side
// dedup today, so exactly-once relies on remove-after-confirmed-success here — see BACKEND REQUEST
// in the summary for the unique-constraint that would make an at-least-once replay fully safe.
export interface MaterialStatusPayload {
  taskId: string
  action: MaterialStatusAction
  clientId: string
}

export interface TaskCreatePayload {
  input: NewTaskInput
  clientId: string
}

export interface NoteCreatePayload {
  projectId: string
  body: string
  clientId: string
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
  | (FieldActionBase & { kind: 'material_status'; payload: MaterialStatusPayload })
  | (FieldActionBase & { kind: 'task_create'; payload: TaskCreatePayload })
  | (FieldActionBase & { kind: 'note_create'; payload: NoteCreatePayload })

export type FieldActionInput =
  | { kind: 'task_claim'; dedupeKey: string; payload: TaskClaimPayload }
  | { kind: 'task_status'; dedupeKey: string; payload: TaskStatusPayload }
  | { kind: 'message_send'; dedupeKey: string; payload: MessageSendPayload }
  | { kind: 'material_status'; dedupeKey: string; payload: MaterialStatusPayload }
  | { kind: 'task_create'; dedupeKey: string; payload: TaskCreatePayload }
  | { kind: 'note_create'; dedupeKey: string; payload: NoteCreatePayload }

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

// ── Typed enqueue helpers (pass 1b remainder) ───────────────────────────────────────────────
// Thin wrappers over enqueueFieldAction so the api.ts offline-write shim (and any caller) enqueues
// a well-formed payload + stable dedupeKey without re-deriving the shape. Each mints its own
// clientId; material_status dedupes on task+action (re-clicking the same status offline is a
// no-op), while task_create / note_create dedupe on the fresh clientId (each submit is distinct).

// Enqueue a material pick-up / undo / delivery status change. Idempotent on replay (RPC UPDATE).
export function enqueueMaterialStatus(taskId: string, statusAction: MaterialStatusAction): void {
  enqueueFieldAction({
    kind: 'material_status',
    dedupeKey: `material_status:${taskId}:${statusAction}`,
    payload: { taskId, action: statusAction, clientId: actionId() },
  })
}

// Enqueue a task creation. Returns the optimistic offline id (`offline-<clientId>`) so the caller
// can proceed exactly as it would with the real id (e.g. attach files — those degrade separately).
export function enqueueTaskCreate(input: NewTaskInput): string {
  const clientId = actionId()
  enqueueFieldAction({
    kind: 'task_create',
    dedupeKey: `task_create:${clientId}`,
    payload: { input, clientId },
  })
  return `offline-${clientId}`
}

// Enqueue a project-note creation. Returns an optimistic ProjectNote so the notes list can render
// it immediately (mirrors createProjectNote's own offline-safe fallback shape).
export function enqueueNoteCreate(p: Profile, projectId: string, body: string): ProjectNote {
  const clientId = actionId()
  const trimmed = body.trim()
  enqueueFieldAction({
    kind: 'note_create',
    dedupeKey: `note_create:${clientId}`,
    payload: { projectId, body: trimmed, clientId },
  })
  const now = new Date().toISOString()
  return {
    id: `offline-${clientId}`,
    org_id: p.org_id,
    project_id: projectId,
    author_id: p.id,
    body: trimmed,
    pinned: false,
    created_at: now,
    updated_at: now,
    author: { name: p.name },
  }
}

function removeAction(clientActionId: string): void {
  writeAll(readAll().filter((row) => row.clientActionId !== clientActionId))
}

// A duplicate INSERT carrying a client_id that already landed on a prior replay raises Postgres
// unique_violation (23505, surfaced by PostgREST with the same code). That means the row is
// already on the server, so the replay is a SUCCESS, not a failure — the item must be removed,
// never retried. 23505 can only come from the task_create / note_create inserts (both carry a
// partial-unique client_id); no other action kind can raise it, so a blanket check is safe.
function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && 'code' in e && (e as { code?: unknown }).code === '23505'
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
    case 'material_status':
      // A task state-transition RPC — replaying the same action is idempotent (no duplicate rows).
      await markMaterialStatus(action.payload.taskId, action.payload.action)
      return
    case 'task_create':
      // Replayed under the same worker (queue is cleared on logout), so the replay-time profile is
      // the original author — mirrors how task_status replay reuses `profile`. The queued clientId
      // is threaded through as tasks.client_id so a duplicate replay raises 23505 (exactly-once).
      await createTask(profile, action.payload.input, action.payload.clientId)
      return
    case 'note_create':
      await createProjectNote(profile, action.payload.projectId, action.payload.body, action.payload.clientId)
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
    } catch (err) {
      if (!isUniqueViolation(err)) {
        // Keep the action for a later flush; drop it once it has failed too many times so
        // one poison mutation cannot block everything queued behind it.
        bumpRetry(action.clientActionId)
        continue
      }
      // 23505: the row already landed on a prior replay — exactly-once. Fall through to the
      // success path (remove + count + notify) so the duplicate is retired, not retried.
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
