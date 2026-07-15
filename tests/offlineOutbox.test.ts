import { describe, it, expect, vi, beforeEach } from 'vitest'

// OFFLINE-1 (pass 1b): unit-cover the outbox fan-out over the three offline write queues.
// The queue modules themselves touch IndexedDB / localStorage, so we mock them out and assert
// only offlineOutbox's aggregation and per-source fault tolerance (node env, no DOM).

const getQueuedTimeEvents = vi.fn()
const flushQueuedTimeEvents = vi.fn()
const getQueuedFieldActions = vi.fn()
const flushFieldActions = vi.fn()
const getQueuedMediaUploads = vi.fn()
const flushMediaUploads = vi.fn()

vi.mock('../src/lib/offlineTimeQueue', () => ({
  getQueuedTimeEvents: (...a: unknown[]) => getQueuedTimeEvents(...a),
  flushQueuedTimeEvents: (...a: unknown[]) => flushQueuedTimeEvents(...a),
}))
vi.mock('../src/lib/offlineFieldActions', () => ({
  getQueuedFieldActions: (...a: unknown[]) => getQueuedFieldActions(...a),
  flushFieldActions: (...a: unknown[]) => flushFieldActions(...a),
}))
vi.mock('../src/lib/offlineMediaQueue', () => ({
  getQueuedMediaUploads: (...a: unknown[]) => getQueuedMediaUploads(...a),
  flushMediaUploads: (...a: unknown[]) => flushMediaUploads(...a),
}))

const { getPendingOutboxCount, flushOutbox } = await import('../src/lib/offlineOutbox')

const profile = { id: 'p1', org_id: 'o1' } as unknown as Parameters<typeof flushOutbox>[0]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getPendingOutboxCount', () => {
  it('sums the lengths of all three queues', async () => {
    getQueuedTimeEvents.mockResolvedValue([{}, {}]) // 2
    getQueuedMediaUploads.mockResolvedValue([{}]) // 1
    getQueuedFieldActions.mockReturnValue([{}, {}, {}]) // 3
    expect(await getPendingOutboxCount()).toBe(6)
  })

  it('returns 0 when every queue is empty', async () => {
    getQueuedTimeEvents.mockResolvedValue([])
    getQueuedMediaUploads.mockResolvedValue([])
    getQueuedFieldActions.mockReturnValue([])
    expect(await getPendingOutboxCount()).toBe(0)
  })

  it('treats an unreadable queue as 0 rather than throwing', async () => {
    getQueuedTimeEvents.mockRejectedValue(new Error('no IndexedDB'))
    getQueuedMediaUploads.mockResolvedValue([{}, {}]) // 2
    getQueuedFieldActions.mockImplementation(() => {
      throw new Error('no localStorage')
    })
    // time -> 0 (rejected), media -> 2, field -> 0 (threw)
    expect(await getPendingOutboxCount()).toBe(2)
  })
})

describe('flushOutbox', () => {
  it('flushes all three queues and sums what was sent', async () => {
    flushQueuedTimeEvents.mockResolvedValue(2)
    flushFieldActions.mockResolvedValue(1)
    flushMediaUploads.mockResolvedValue(3)
    expect(await flushOutbox(profile)).toBe(6)
    expect(flushQueuedTimeEvents).toHaveBeenCalledWith(profile)
    expect(flushFieldActions).toHaveBeenCalledWith(profile)
    expect(flushMediaUploads).toHaveBeenCalledWith(profile)
  })

  it('keeps draining the other queues when one flush throws', async () => {
    flushQueuedTimeEvents.mockRejectedValue(new Error('poison time event'))
    flushFieldActions.mockResolvedValue(1)
    flushMediaUploads.mockResolvedValue(2)
    // time contributes 0 (threw), field + media still drain
    expect(await flushOutbox(profile)).toBe(3)
    expect(flushFieldActions).toHaveBeenCalledTimes(1)
    expect(flushMediaUploads).toHaveBeenCalledTimes(1)
  })
})
