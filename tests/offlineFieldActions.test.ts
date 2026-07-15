import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// OFFLINE-1 (pass 1b remainder): unit-cover the three new offline write kinds added to the field-
// action queue — material_status / task_create / note_create — for enqueue-on-offline, dedupe, and
// replay-EXACTLY-ONCE on reconnect. The real queue touches localStorage + navigator + the api
// writers, so we mock the writer modules (keeps supabase out of the node env) and stub a tiny
// in-memory localStorage + navigator so the durable path actually runs instead of the no-op
// storage() fallback.

const markTaskDone = vi.fn()
const sendMessage = vi.fn()
const markMaterialStatus = vi.fn()
const createTask = vi.fn()
const createProjectNote = vi.fn()

vi.mock('../src/lib/api', () => ({
  markTaskDone: (...a: unknown[]) => markTaskDone(...a),
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}))
vi.mock('../src/lib/api/tasks', () => ({
  markMaterialStatus: (...a: unknown[]) => markMaterialStatus(...a),
  createTask: (...a: unknown[]) => createTask(...a),
}))
vi.mock('../src/lib/api/projects', () => ({
  createProjectNote: (...a: unknown[]) => createProjectNote(...a),
}))

const mod = await import('../src/lib/offlineFieldActions')

const profile = { id: 'p1', org_id: 'o1', name: 'Ann' } as unknown as Parameters<typeof mod.enqueueNoteCreate>[0]

// Minimal Map-backed Storage so the queue's storage() sees a real, isolated store per test.
function makeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => { m.clear() },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size },
  } as Storage
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', makeStorage())
  vi.stubGlobal('navigator', { onLine: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const newTask = { project_id: null, title: 'Fix rail', task_type: 'work', priority: 'medium' } as Parameters<typeof mod.enqueueTaskCreate>[0]

describe('material_status offline queue', () => {
  it('enqueues and replays the RPC exactly once, then clears', async () => {
    mod.enqueueMaterialStatus('t1', 'picked_up')
    expect(mod.getQueuedFieldActions()).toHaveLength(1)

    const sent = await mod.flushFieldActions(profile)
    expect(sent).toBe(1)
    expect(markMaterialStatus).toHaveBeenCalledTimes(1)
    expect(markMaterialStatus).toHaveBeenCalledWith('t1', 'picked_up')
    expect(mod.getQueuedFieldActions()).toHaveLength(0)

    // A second flush has nothing left — no double-replay.
    expect(await mod.flushFieldActions(profile)).toBe(0)
    expect(markMaterialStatus).toHaveBeenCalledTimes(1)
  })

  it('dedupes the same task+action so a re-click offline does not double-queue', () => {
    mod.enqueueMaterialStatus('t1', 'picked_up')
    mod.enqueueMaterialStatus('t1', 'picked_up')
    expect(mod.getQueuedFieldActions()).toHaveLength(1)
    // A different action on the same task is a distinct queue entry.
    mod.enqueueMaterialStatus('t1', 'delivered')
    expect(mod.getQueuedFieldActions()).toHaveLength(2)
  })

  it('retains the item and bumps retries when the replay fails with a network error', async () => {
    mod.enqueueMaterialStatus('t1', 'delivered')
    markMaterialStatus.mockRejectedValue(new Error('failed to fetch'))
    const sent = await mod.flushFieldActions(profile)
    expect(sent).toBe(0)
    const queued = mod.getQueuedFieldActions()
    expect(queued).toHaveLength(1)
    expect(queued[0].retries).toBe(1)
  })

  it('drops a poison item once it exhausts MAX_RETRIES so it cannot wedge the queue', async () => {
    mod.enqueueMaterialStatus('t1', 'delivered')
    markMaterialStatus.mockRejectedValue(new Error('permanent reject'))
    for (let i = 0; i < 9; i += 1) await mod.flushFieldActions(profile)
    expect(mod.getQueuedFieldActions()).toHaveLength(0)
  })
})

describe('task_create offline queue', () => {
  it('returns an optimistic offline id and replays createTask exactly once', async () => {
    const id = mod.enqueueTaskCreate(newTask)
    expect(id).toMatch(/^offline-/)
    expect(mod.getQueuedFieldActions()).toHaveLength(1)

    createTask.mockResolvedValue('server-task-1')
    const sent = await mod.flushFieldActions(profile)
    expect(sent).toBe(1)
    expect(createTask).toHaveBeenCalledTimes(1)
    // OFFLINE-2: the queued clientId is threaded through as the 3rd arg (partial-unique client_id).
    expect(createTask).toHaveBeenCalledWith(profile, expect.objectContaining({ title: 'Fix rail' }), expect.any(String))

    expect(await mod.flushFieldActions(profile)).toBe(0)
    expect(createTask).toHaveBeenCalledTimes(1)
  })
})

describe('note_create offline queue', () => {
  it('returns a synthetic note and replays createProjectNote exactly once', async () => {
    const note = mod.enqueueNoteCreate(profile, 'proj1', '  hello team  ')
    expect(note.id).toMatch(/^offline-/)
    expect(note.body).toBe('hello team')
    expect(note.project_id).toBe('proj1')
    expect(note.author).toEqual({ name: 'Ann' })
    expect(mod.getQueuedFieldActions()).toHaveLength(1)

    const sent = await mod.flushFieldActions(profile)
    expect(sent).toBe(1)
    expect(createProjectNote).toHaveBeenCalledTimes(1)
    // OFFLINE-2: the queued clientId is threaded through as the 4th arg (partial-unique client_id).
    expect(createProjectNote).toHaveBeenCalledWith(profile, 'proj1', 'hello team', expect.any(String))
    expect(mod.getQueuedFieldActions()).toHaveLength(0)
  })
})

describe('flush guards', () => {
  it('does not replay while offline (enqueue still works durably)', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    mod.enqueueMaterialStatus('t1', 'picked_up')
    expect(mod.getQueuedFieldActions()).toHaveLength(1)
    const sent = await mod.flushFieldActions(profile)
    expect(sent).toBe(0)
    expect(markMaterialStatus).not.toHaveBeenCalled()
  })

  it('clearAllFieldActions empties the queue (logout on a shared device)', () => {
    mod.enqueueMaterialStatus('t1', 'picked_up')
    mod.enqueueTaskCreate(newTask)
    expect(mod.getQueuedFieldActions().length).toBeGreaterThan(0)
    mod.clearAllFieldActions()
    expect(mod.getQueuedFieldActions()).toHaveLength(0)
  })
})
