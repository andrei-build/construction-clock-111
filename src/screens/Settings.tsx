import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getAppSettings, saveAppSettings, type AppSettingsInput } from '../lib/api'
import type { AppSettings } from '../lib/types'

type OrgLanguage = 'ru' | 'en' | 'es'

const DEFAULT_SETTINGS: AppSettingsInput = {
  default_language: 'ru',
  timezone: 'America/Los_Angeles',
  overlong_shift_hours: 11,
  default_gps_radius_m: 150,
}

function supportedLanguage(value: string | null | undefined): OrgLanguage {
  return value === 'en' || value === 'es' ? value : 'ru'
}

export default function Settings() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const [defaultLanguage, setDefaultLanguage] = useState<OrgLanguage>(DEFAULT_SETTINGS.default_language as OrgLanguage)
  const [timezone, setTimezone] = useState(DEFAULT_SETTINGS.timezone)
  const [overlongShiftHours, setOverlongShiftHours] = useState(String(DEFAULT_SETTINGS.overlong_shift_hours))
  const [defaultGpsRadius, setDefaultGpsRadius] = useState(String(DEFAULT_SETTINGS.default_gps_radius_m))

  const canEdit = profile?.role === 'owner'

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setLoadError(false)
      setMsg(null)
      try {
        const row = await getAppSettings()
        if (!mounted) return
        setSettings(row)
        const source = row ?? DEFAULT_SETTINGS
        setDefaultLanguage(supportedLanguage(source.default_language))
        setTimezone(source.timezone)
        setOverlongShiftHours(String(Number(source.overlong_shift_hours)))
        setDefaultGpsRadius(String(source.default_gps_radius_m))
      } catch {
        if (mounted) {
          setSettings(null)
          setLoadError(true)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  const languageLabel = (value: string) => {
    if (value === 'en') return t('settings_language_en')
    if (value === 'es') return t('settings_language_es')
    if (value === 'ru') return t('settings_language_ru')
    return value
  }

  const currentValues = {
    default_language: defaultLanguage,
    timezone,
    overlong_shift_hours: overlongShiftHours,
    default_gps_radius_m: defaultGpsRadius,
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!profile || !canEdit || saving) return

    const hours = Number(overlongShiftHours)
    const radius = Number(defaultGpsRadius)
    if (!timezone.trim() || !Number.isFinite(hours) || hours <= 0 || !Number.isFinite(radius) || radius <= 0 || !Number.isInteger(radius)) {
      setMsg('settings_invalid')
      return
    }

    const values: AppSettingsInput = {
      default_language: defaultLanguage,
      timezone: timezone.trim(),
      overlong_shift_hours: hours,
      default_gps_radius_m: radius,
    }

    setSaving(true)
    setMsg(null)
    try {
      const saved = await saveAppSettings(profile, values)
      setSettings(saved)
      setTimezone(saved.timezone)
      setOverlongShiftHours(String(Number(saved.overlong_shift_hours)))
      setDefaultGpsRadius(String(saved.default_gps_radius_m))
      setDefaultLanguage(supportedLanguage(saved.default_language))
      setMsg('settings_saved')
    } catch {
      setMsg('settings_save_failed')
    } finally {
      setSaving(false)
    }
  }

  const rows = [
    { key: 'language', label: t('settings_org_language'), value: languageLabel(currentValues.default_language) },
    { key: 'timezone', label: t('settings_timezone'), value: currentValues.timezone },
    { key: 'overlong', label: t('settings_overlong_shift'), value: `${currentValues.overlong_shift_hours} ${t('h')}` },
    { key: 'radius', label: t('settings_default_gps_radius'), value: currentValues.default_gps_radius_m },
  ]
  const msgClass = msg === 'settings_saved' ? 'ok-msg' : 'error-msg'

  return (
    <div className="screen">
      <h1>⚙️ {t('settings')}</h1>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('load_error')}</p>}
      {msg && <p className={msgClass}>{t(msg)}</p>}

      {!loading && !loadError && !settings && (
        <div className="card muted">{t('settings_empty')}</div>
      )}

      {!loading && !loadError && canEdit && (
        <form className="card" onSubmit={handleSave}>
          <label htmlFor="settings-language">{t('settings_org_language')}</label>
          <select
            id="settings-language"
            value={defaultLanguage}
            disabled={saving}
            onChange={(e) => setDefaultLanguage(e.target.value as OrgLanguage)}
          >
            <option value="ru">{t('settings_language_ru')}</option>
            <option value="en">{t('settings_language_en')}</option>
            <option value="es">{t('settings_language_es')}</option>
          </select>

          <label htmlFor="settings-timezone">{t('settings_timezone')}</label>
          <input
            id="settings-timezone"
            type="text"
            value={timezone}
            disabled={saving}
            onChange={(e) => setTimezone(e.target.value)}
          />
          <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>{t('settings_timezone_hint')}</p>

          <label htmlFor="settings-overlong">{t('settings_overlong_shift')}</label>
          <input
            id="settings-overlong"
            type="number"
            min="0.5"
            step="0.5"
            inputMode="decimal"
            value={overlongShiftHours}
            disabled={saving}
            onChange={(e) => setOverlongShiftHours(e.target.value)}
          />

          <label htmlFor="settings-radius">{t('settings_default_gps_radius')}</label>
          <input
            id="settings-radius"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={defaultGpsRadius}
            disabled={saving}
            onChange={(e) => setDefaultGpsRadius(e.target.value)}
          />

          <button className="btn" disabled={saving}>{saving ? t('settings_saving') : t('save')}</button>
        </form>
      )}

      {!loading && !loadError && !canEdit && (
        <>
          <div className="card muted">{t('settings_readonly')}</div>
          <section className="card">
            {rows.map((row) => (
              <div key={row.key} className="row" style={{ alignItems: 'flex-start', padding: '8px 0' }}>
                <span className="muted">{row.label}</span>
                <strong style={{ textAlign: 'right' }}>{row.value}</strong>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  )
}
