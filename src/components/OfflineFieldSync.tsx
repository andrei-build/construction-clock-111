import { useCallback, useEffect, useRef } from 'react'
import { useAuth } from '../lib/auth'
import { flushFieldActions, getQueuedFieldActions } from '../lib/offlineFieldActions'
import { flushMediaUploads } from '../lib/offlineMediaQueue'

// App-wide replay for the offline field-action queue (F64) and media-upload queue (F51).
// Mirrors the Check-In screen's time-queue mechanism (window 'online' + flush-when-pending),
// but mounted at the app root so a queued task-done / message / photo replays even after the
// worker has navigated away from the screen that queued it. Renders nothing.
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
      if (getQueuedFieldActions().length > 0) await flushFieldActions(profile)
      // flushMediaUploads self-guards: it opens IndexedDB and no-ops when nothing is queued.
      await flushMediaUploads(profile)
    } catch {
      // Best-effort; unsent actions/photos stay queued for the next reconnect.
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
