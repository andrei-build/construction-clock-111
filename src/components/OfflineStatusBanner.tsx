import { useEffect, useState } from 'react'
import { getPendingOutboxCount, getOutboxAlerts } from '../lib/offlineOutbox'
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
  // OFFLINE-FIX-1 (б/в): карантин ядовитых строк + отказ персиста — отдельные тревоги.
  const [quarantined, setQuarantined] = useState(0)
  const [persistError, setPersistError] = useState(false)

  useEffect(() => {
    let alive = true
    let syncTimer: ReturnType<typeof setTimeout> | null = null

    const refreshCount = async () => {
      try {
        // OFFLINE-1 (1b): count all three write queues (time events + field actions + media
        // uploads), not only time events, so a queued task-done / message / photo is reflected
        // in "{n} action(s) queued" too. getPendingOutboxCount self-guards per source.
        const n = await getPendingOutboxCount()
        if (alive) setCount(n)
      } catch {
        // Queues unreadable (e.g. no IndexedDB) — treat as empty, never block the UI.
        if (alive) setCount(0)
      }
      // OFFLINE-FIX-1 (б/в): «N отметок не синхронизированы» (карантин) и предупреждение о квоте.
      try {
        const alerts = await getOutboxAlerts()
        if (alive) {
          setQuarantined(alerts.quarantined)
          setPersistError(alerts.persistError)
        }
      } catch {
        if (alive) {
          setQuarantined(0)
          setPersistError(false)
        }
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

  const label =
    state === 'offline'
      ? t('offline_banner_offline')
      : state === 'syncing'
        ? t('offline_banner_syncing')
        : state === 'pending'
          ? t('offline_banner_pending').replace('{n}', String(count))
          : null

  // OFFLINE-FIX-1 (б/в): отдельный красный баннер-тревога. Персист-отказ (данные под угрозой)
  // важнее карантина; показываем один самый срочный. Рендерится и когда обычного статуса нет
  // (онлайн, очередь пуста, но осталась карантинная строка). Красный фон — inline (стилей нет в CSS).
  const alertLabel = persistError
    ? t('offline_banner_quota')
    : quarantined > 0
      ? t('offline_banner_quarantine').replace('{n}', String(quarantined))
      : null

  if (!state && !alertLabel) return null

  return (
    <>
      {state && label && (
        <div className={`offline-banner offline-banner-${state}`} role="status" aria-live="polite">
          <span className={`offline-dot${state === 'syncing' ? ' syncing' : ''}`} />
          <span className="offline-banner-text">{label}</span>
        </div>
      )}
      {alertLabel && (
        <div
          className="offline-banner offline-banner-offline"
          role="alert"
          aria-live="assertive"
          style={{ background: 'rgba(255,107,107,.16)', borderBottomColor: 'rgba(255,107,107,.4)' }}
        >
          <span className="offline-dot" style={{ background: '#ff6b6b' }} />
          <span className="offline-banner-text">{alertLabel}</span>
        </div>
      )}
    </>
  )
}
