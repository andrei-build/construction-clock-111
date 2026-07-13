import { useEffect, useState } from 'react'
import { getQueuedTimeEvents } from '../lib/offlineTimeQueue'
import { useI18n } from '../lib/i18n'

// Feature-detect navigator.onLine; assume online when the browser can't tell us.
function readOnline() {
  if (typeof navigator === 'undefined' || !('onLine' in navigator)) return true
  return navigator.onLine
}

const REFRESH_MS = 7000
// While draining after coming online, hold the "syncing" tone briefly since the
// flush itself runs elsewhere (e.g. the Check-In screen) and isn't cleanly observable here.
const SYNCING_HINT_MS = 4000

type BannerState = 'offline' | 'pending' | 'syncing' | null

export default function OfflineStatusBanner() {
  const { t } = useI18n()
  const [online, setOnline] = useState(readOnline)
  const [count, setCount] = useState(0)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    let alive = true
    let syncTimer: ReturnType<typeof setTimeout> | null = null

    const refreshCount = async () => {
      try {
        const rows = await getQueuedTimeEvents()
        if (alive) setCount(rows.length)
      } catch {
        // Queue unreadable (e.g. no IndexedDB) — treat as empty, never block the UI.
        if (alive) setCount(0)
      }
    }

    const handleOnline = () => {
      if (!alive) return
      setOnline(true)
      setSyncing(true)
      void refreshCount()
      if (syncTimer) clearTimeout(syncTimer)
      syncTimer = setTimeout(() => {
        if (!alive) return
        setSyncing(false)
        void refreshCount()
      }, SYNCING_HINT_MS)
    }

    const handleOffline = () => {
      if (!alive) return
      setSyncing(false)
      setOnline(false)
      void refreshCount()
    }

    setOnline(readOnline())
    void refreshCount()
    const interval = setInterval(() => {
      if (!alive) return
      setOnline(readOnline())
      void refreshCount()
    }, REFRESH_MS)

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      alive = false
      clearInterval(interval)
      if (syncTimer) clearTimeout(syncTimer)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  let state: BannerState = null
  if (!online) state = 'offline'
  else if (syncing && count > 0) state = 'syncing'
  else if (count > 0) state = 'pending'

  if (!state) return null

  const label =
    state === 'offline'
      ? t('offline_banner_offline')
      : state === 'syncing'
        ? t('offline_banner_syncing')
        : t('offline_banner_pending').replace('{n}', String(count))

  return (
    <div className={`offline-banner offline-banner-${state}`} role="status" aria-live="polite">
      <span className={`offline-dot${state === 'syncing' ? ' syncing' : ''}`} />
      <span className="offline-banner-text">{label}</span>
    </div>
  )
}
