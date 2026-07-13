import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getConsentWorkers, getActiveWorkerConsents, getSafetyAcknowledgements } from '../lib/api'
import type { Profile } from '../lib/types'

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

export default function Consents() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const [workers, setWorkers] = useState<Profile[]>([])
  const [consentByWorker, setConsentByWorker] = useState<Map<string, string>>(new Map())
  const [safetyByWorker, setSafetyByWorker] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [onlyMissing, setOnlyMissing] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const team = await getConsentWorkers()
        const ids = team.map((w) => w.id)
        const [consents, acks] = await Promise.all([
          getActiveWorkerConsents(ids),
          getSafetyAcknowledgements(ids),
        ])
        // Активное согласие: дата подписи (signed_at ?? created_at), самая свежая на работника
        const consentMap = new Map<string, string>()
        for (const row of consents) {
          const date = row.signed_at ?? row.created_at
          if (!date) continue
          const prev = consentMap.get(row.worker_id)
          if (!prev || date > prev) consentMap.set(row.worker_id, date)
        }
        // Подпись ТБ: самая свежая signed_at на работника
        const safetyMap = new Map<string, string>()
        for (const row of acks) {
          if (!row.signed_at) continue
          const prev = safetyMap.get(row.worker_id)
          if (!prev || row.signed_at > prev) safetyMap.set(row.worker_id, row.signed_at)
        }
        if (mounted) {
          setWorkers(team)
          setConsentByWorker(consentMap)
          setSafetyByWorker(safetyMap)
        }
      } catch {
        if (mounted) {
          setWorkers([])
          setConsentByWorker(new Map())
          setSafetyByWorker(new Map())
          setError(true)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(localeByLang[lang], { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso))

  const missingCount = useMemo(
    () => workers.filter((w) => !consentByWorker.has(w.id)).length,
    [workers, consentByWorker],
  )

  const visible = useMemo(
    () => (onlyMissing ? workers.filter((w) => !consentByWorker.has(w.id)) : workers),
    [workers, consentByWorker, onlyMissing],
  )

  return (
    <div className="screen">
      <h1>📝 {t('consents')}</h1>

      <div className="timeline-filters" aria-label={t('consents_filters')}>
        <button
          type="button"
          className={`timeline-chip ${onlyMissing ? 'active' : ''}`}
          onClick={() => setOnlyMissing((v) => !v)}
        >
          {t('consents_filter_missing')} ({missingCount})
        </button>
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {!loading && !error && visible.length === 0 && <div className="card muted">{t('consents_empty')}</div>}

      {!loading && !error && visible.map((w) => {
        const consentDate = consentByWorker.get(w.id)
        const safetyDate = safetyByWorker.get(w.id)
        return (
          <div key={w.id} className="card row">
            <div>
              <span className="item-title">{w.name}</span>
            </div>
            <div className="center">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="muted" style={{ fontSize: 12 }}>{t('consents_gps')}</span>
                  {consentDate
                    ? <span className="badge green">{formatDate(consentDate)}</span>
                    : <span className="badge red">{t('consents_none')}</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="muted" style={{ fontSize: 12 }}>{t('consents_safety')}</span>
                  <span>{safetyDate ? formatDate(safetyDate) : '—'}</span>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
