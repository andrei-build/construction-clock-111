import { useI18n } from '../lib/i18n'
import { fmtClock } from '../lib/time'

// Small inline banner shown when a list is served from the offline read cache (F65).
// Additive and non-blocking — it never replaces the list, only annotates it.
export default function OfflineCacheNotice({ cachedAt }: { cachedAt: string }) {
  const { t } = useI18n()
  return (
    <div className="cache-notice" role="status" aria-live="polite">
      <span className="cache-notice-icon" aria-hidden="true">⚠️</span>
      <span className="cache-notice-text">
        {t('offline_cache_notice').replace('{time}', fmtClock(cachedAt))}
      </span>
    </div>
  )
}
