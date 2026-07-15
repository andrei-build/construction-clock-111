import { useCallback, useEffect, useRef } from 'react'
import { useAuth } from '../lib/auth'
import { flushOutbox } from '../lib/offlineOutbox'

// App-wide replay for every offline write queue: field actions (F64), media uploads (F51), and
// — as of OFFLINE-1 (1b) — time events too. Mirrors the Check-In screen's time-queue mechanism
// (window 'online' + flush-when-pending), but mounted at the app root so a queued task-done /
// message / photo / clock-in replays even after the worker has navigated away from the screen
// that queued it. flushOutbox is idempotent, so running it alongside the Check-In screen's own
// time flush can never double-post. Renders nothing.
function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine
}

export default function OfflineFieldSync() {
  const { profile } = useAuth()
  const syncRef = useRef(false)

  const sync = useCallback(async () => {
    if (!profile || syncRef.current || !isOnline()) return
    syncRef.current = true
    try {
      await flushOutbox(profile)
    } catch {
      // Best-effort; unsent actions/photos/events stay queued for the next reconnect.
    } finally {
      syncRef.current = false
    }
  }, [profile])

  useEffect(() => {
    void sync()
    window.addEventListener('online', sync)
    return () => window.removeEventListener('online', sync)
  }, [sync])

  return null
}
