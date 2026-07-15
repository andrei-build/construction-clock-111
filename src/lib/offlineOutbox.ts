// OFFLINE-1 (pass 1b): a single "outbox" view over the three independent offline write queues —
// time events (IndexedDB: construction-clock-offline), field actions (localStorage: task_done /
// message_send), and media uploads (IndexedDB: task photos). Pass 1a gave READS a unified
// read-through cache + banner; this gives WRITES a unified pending count + reconnect replay so
// DNA §14 ("loss of connection does not take data away") holds for every queued mutation, not
// only clock-ins replayed on the Check-In screen.
//
// Deliberately thin: it does NOT reimplement any queue. Each source keeps owning its own storage,
// dedup and retry rules; this module only fans a count/flush across all three and tolerates any
// one of them being unreachable (no IndexedDB, quota, private mode) without breaking the others.
import type { Profile } from './types'
import { getQueuedTimeEvents, flushQueuedTimeEvents } from './offlineTimeQueue'
import { getQueuedFieldActions, flushFieldActions } from './offlineFieldActions'
import { getQueuedMediaUploads, flushMediaUploads } from './offlineMediaQueue'

// Total number of queued offline mutations across all three queues. Isolated per source: a
// failure reading one store contributes 0 rather than throwing, so the pending banner never
// breaks (or hides real pending work in the other queues) just because one store is unreadable.
// No profile filter — parity with the pre-1b banner, which counted every queued time event.
export async function getPendingOutboxCount(): Promise<number> {
  const [time, media] = await Promise.all([
    getQueuedTimeEvents().catch(() => []),
    getQueuedMediaUploads().catch(() => []),
  ])
  let field = 0
  try {
    field = getQueuedFieldActions().length
  } catch {
    field = 0
  }
  return time.length + media.length + field
}

// Replay every queue while online and return how many items were sent. Each underlying flush
// self-guards on navigator.onLine and is idempotent — time events dedupe by client_id (23505),
// field actions by dedupeKey, media uploads by clientActionId/id — so running this at the app
// root alongside the Check-In screen's own time flush can never double-post. One queue throwing
// (e.g. a poison item) leaves the others to drain; the failed queue stays pending for next time.
export async function flushOutbox(profile: Profile): Promise<number> {
  let sent = 0
  try {
    sent += await flushQueuedTimeEvents(profile)
  } catch {
    // Unsent time events stay queued for the next reconnect.
  }
  try {
    sent += await flushFieldActions(profile)
  } catch {
    // Unsent field actions stay queued for the next reconnect.
  }
  try {
    sent += await flushMediaUploads(profile)
  } catch {
    // Unsent media uploads stay queued for the next reconnect.
  }
  return sent
}
