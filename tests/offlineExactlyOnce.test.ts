import { describe, it, expect, vi, beforeEach } from 'vitest'

// OFFLINE-2: exactly-once replay for the offline WRITE queue (task_create / note_create).
// The queued clientId is threaded into the INSERT as tasks/project_notes.client_id (partial
// unique index, migration 0039). A duplicate replay therefore raises Postgres 23505
// (unique_violation); flushFieldActions must treat that as SUCCESS (the row already landed on a
// prior replay) — remove the item, NOT bumpRetry. We mock the raw api writers so the FIRST
// replay resolves and the SECOND rejects with { code: '23505' }, and assert the queue empties.
//
// localStorage is stubbed with an in-memory Map (node env, no DOM) so the real queue storage
// works; the api module is mocked to control replay outcomes.

const createTask = vi.fn()
const createProjectNote = vi.fn()
const markMaterialStatus = vi.fn()
const markTaskDone = vi.fn()
const sendMessage = vi.fn()

vi.mock('../src/lib/api/tasks', () => ({
  createTask: (...a: unknown[]) => createTask(...a),
  markMaterialStatus: (...a: unknown[]) => markMaterialStatus(...a),
}))
vi.mock('../src/lib/api/projects', () => ({
  createProjectNote: (...a: unknown[]) => createProjectNote(...a),
}))
vi.mock('../src/lib/api', () => ({
  markTaskDone: (...a: unknown[]) => markTaskDone(...a),
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}))

// Minimal in-memory localStorage so the queue can persist across flushes within a test.
function installLocalStorage() {
  const map = new Map<string, string>()
  const store = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
  vi.stubGlobal('localStorage', store)
  // navigator.onLine defaults to truthy; keep it online so flush runs.
  vi.stubGlobal('navigator', { onLine: true })
}

const {
  enqueueTaskCreate,
  enqueueNoteCreate,
  flushFieldActions,
  getQueuedFieldActions,
  clearAllFieldActions,
} = await import('../src/lib/offlineFieldActions')

const profile = { id: 'p1', org_id: 'o1', name: 'Worker' } as unknown as Parameters<typeof flushFieldActions>[0]

beforeEach(() => {
  vi.clearAllMocks()
  installLocalStorage()
  clearAllFieldActions()
})

describe('exactly-once replay (23505 → success)', () => {
  it('removes a task_create item when the second replay raises 23505 (not a retry)', async () => {
    enqueueTaskCreate({ project_id: null, title: 'T', task_type: 'todo', priority: 'normal' } as never)
    expect(getQueuedFieldActions()).toHaveLength(1)

    // First replay: succeeds (row lands). Item removed as a normal success.
    createTask.mockResolvedValueOnce('task-1')
    expect(await flushFieldActions(profile)).toBe(1)
    expect(getQueuedFieldActions()).toHaveLength(0)

    // Re-enqueue the SAME logical action and simulate a duplicate landing on the server:
    // the insert rejects with a Postgres unique_violation.
    enqueueTaskCreate({ project_id: null, title: 'T', task_type: 'todo', priority: 'normal' } as never)
    createTask.mockRejectedValueOnce({ code: '23505' })
    const sent = await flushFieldActions(profile)

    // Treated as success: counted as sent AND removed from the queue (exactly-once).
    expect(sent).toBe(1)
    expect(getQueuedFieldActions()).toHaveLength(0)
  })

  it('passes the queued clientId through to createTask as client_id anchor', async () => {
    enqueueTaskCreate({ project_id: null, title: 'T', task_type: 'todo', priority: 'normal' } as never)
    createTask.mockResolvedValueOnce('task-1')
    await flushFieldActions(profile)
    // createTask(profile, input, clientId) — third arg is the dedupe anchor, a non-empty string.
    expect(createTask).toHaveBeenCalledTimes(1)
    const clientId = createTask.mock.calls[0][2]
    expect(typeof clientId).toBe('string')
    expect(clientId).toBeTruthy()
  })

  it('removes a note_create item on a 23505 duplicate replay', async () => {
    enqueueNoteCreate(profile as never, 'proj-1', 'hello')
    expect(getQueuedFieldActions()).toHaveLength(1)
    createProjectNote.mockRejectedValueOnce({ code: '23505' })
    const sent = await flushFieldActions(profile)
    expect(sent).toBe(1)
    expect(getQueuedFieldActions()).toHaveLength(0)
    // clientId threaded as the 4th arg.
    expect(createProjectNote.mock.calls[0][3]).toBeTruthy()
  })

  it('keeps the item queued (bumpRetry) on a genuine non-23505 error', async () => {
    enqueueTaskCreate({ project_id: null, title: 'T', task_type: 'todo', priority: 'normal' } as never)
    createTask.mockRejectedValueOnce({ code: '500', message: 'network down' })
    const sent = await flushFieldActions(profile)
    // Not treated as success: nothing sent, item stays queued for a later flush.
    expect(sent).toBe(0)
    const remaining = getQueuedFieldActions()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].retries).toBe(1)
  })
})
