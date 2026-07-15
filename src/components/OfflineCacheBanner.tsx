import { useEffect, useState } from 'react'
import { getOfflineCacheState, subscribeOfflineCache, clearOfflineCacheState } from '../lib/offlineReadCache'
import { useI18n } from '../lib/i18n'
import { fmtClock } from '../lib/time'

// OFFLINE-1 (pass 1a): yellow banner shown when a screen is being served data from the
// read-through cache because the browser is offline. "Нет связи — данные на HH:MM", where
// HH:MM is when the cached data was stored. Distinct from OfflineStatusBanner, which is about
// the outbound time-event queue (marks saved to send later).
//
// When the browser fires `online` we clear the banner and reload so every screen re-fetches
// fresh data. A full reload is the only screen-agnostic way to re-run every loader without
// touching screen code; we only do it when the banner was actually up (i.e. we served stale
// data), so a transient reconnect with nothing stale on screen never triggers a reload.
export default function OfflineCacheBanner() {
  const { t } = useI18n()
  const [state, setState] = useState(getOfflineCacheState)

  useEffect(() => {
    const sync = () => setState(getOfflineCacheState())
    const unsub = subscribeOfflineCache(sync)

    const handleOnline = () => {
      if (getOfflineCacheState()) {
        clearOfflineCacheState()
        if (typeof window !== 'undefined') window.location.reload()
      }
    }
    window.addEventListener('online', handleOnline)

    sync()
    return () => {
      unsub()
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  if (!state) return null

  return (
    <div className="offline-banner offline-banner-offline" role="status" aria-live="polite">
      <span className="offline-dot" />
      <span className="offline-banner-text">
        {t('offline_read_banner').replace('{time}', fmtClock(state.cachedAt))}
      </span>
    </div>
  )
}
