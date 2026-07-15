import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getAppSettings, saveAppSettings, type AppSettingsInput } from '../lib/api'
import type { AppSettings } from '../lib/types'
import { GPS_RADIUS_MIN, GPS_RADIUS_MAX, GPS_RADIUS_STEP, clampGpsRadius } from '../lib/geofence'
import { DEFAULT_PAID_GAP_ALERT_HOURS } from '../lib/time'

type OrgLanguage = 'ru' | 'en' | 'es'

// GEO-1: после скольких минут без GPS-сигнала в открытой смене риск «нет сигнала» (DB-дефолт 15).
const DEFAULT_GEO_NO_SIGNAL_MINUTES = 15

// MSG-1: час вечернего дайджеста (app_settings.digest_hour, целое 0–23, DB-дефолт 18).
const DEFAULT_DIGEST_HOUR = 18

const DEFAULT_SETTINGS: AppSettingsInput = {
  default_language: 'ru',
  timezone: 'America/Los_Angeles',
  overlong_shift_hours: 11,
  default_gps_radius_m: 150,
  geo_no_signal_minutes: DEFAULT_GEO_NO_SIGNAL_MINUTES,
  paid_gap_alert_hours: DEFAULT_PAID_GAP_ALERT_HOURS,
  digest_hour: DEFAULT_DIGEST_HOUR,
}

function supportedLanguage(value: string | null | undefined): OrgLanguage {
  return value === 'en' || value === 'es' ? value : 'ru'
}

// paid_gap_alert_hours: положительное число → оно; иначе (null/пусто/≤0) → дефолт.
function gapAlertOrDefault(value: number | null | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PAID_GAP_ALERT_HOURS
}

// geo_no_signal_minutes: положительное число → оно; иначе (null/пусто/≤0) → дефолт (15).
function geoNoSignalOrDefault(value: number | null | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GEO_NO_SIGNAL_MINUTES
}

// digest_hour: целое в диапазоне 0–23 → оно; иначе (null/пусто/вне диапазона) → дефолт (18).
function digestHourOrDefault(value: number | null | undefined): number {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : DEFAULT_DIGEST_HOUR
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
  const [geoNoSignalMinutes, setGeoNoSignalMinutes] = useState(String(DEFAULT_SETTINGS.geo_no_signal_minutes))
  const [paidGapAlertHours, setPaidGapAlertHours] = useState(String(DEFAULT_SETTINGS.paid_gap_alert_hours))
  const [digestHour, setDigestHour] = useState(String(DEFAULT_DIGEST_HOUR))

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
        // geo_no_signal_minutes может быть null в старых строках → дефолт (15).
        setGeoNoSignalMinutes(String(geoNoSignalOrDefault(source.geo_no_signal_minutes)))
        // paid_gap_alert_hours может быть null в старых строках → дефолт.
        setPaidGapAlertHours(String(gapAlertOrDefault(source.paid_gap_alert_hours)))
        // digest_hour может быть null/вне диапазона в старых строках → дефолт (18).
        setDigestHour(String(digestHourOrDefault(source.digest_hour)))
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
    geo_no_signal_minutes: geoNoSignalMinutes,
    paid_gap_alert_hours: paidGapAlertHours,
    digest_hour: digestHour,
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!profile || !canEdit || saving) return

    const hours = Number(overlongShiftHours)
    if (!timezone.trim() || !Number.isFinite(hours) || hours <= 0) {
      setMsg('settings_invalid')
      return
    }
    // Порог оповещения о разрыве: положительное число; пусто/некорректно → дефолт (не блокируем сохранение).
    const gapAlert = paidGapAlertHours.trim() === ''
      ? DEFAULT_PAID_GAP_ALERT_HOURS
      : gapAlertOrDefault(Number(paidGapAlertHours))
    // Порог «нет GPS»: положительное число минут; пусто/некорректно/≤0 → дефолт (15).
    const geoNoSignal = geoNoSignalMinutes.trim() === ''
      ? DEFAULT_GEO_NO_SIGNAL_MINUTES
      : geoNoSignalOrDefault(Number(geoNoSignalMinutes))
    // Clamp to the sane [25, 300] m geofence range; empty/NaN falls back to the default.
    const radius = defaultGpsRadius.trim() === ''
      ? DEFAULT_SETTINGS.default_gps_radius_m
      : clampGpsRadius(Number(defaultGpsRadius), DEFAULT_SETTINGS.default_gps_radius_m)
    // Час дайджеста: целое 0–23; пусто/вне диапазона → дефолт (18). Не блокируем сохранение.
    const digest = digestHour.trim() === ''
      ? DEFAULT_DIGEST_HOUR
      : digestHourOrDefault(Number(digestHour))

    const values: AppSettingsInput = {
      default_language: defaultLanguage,
      timezone: timezone.trim(),
      overlong_shift_hours: hours,
      default_gps_radius_m: radius,
      geo_no_signal_minutes: geoNoSignal,
      paid_gap_alert_hours: gapAlert,
      digest_hour: digest,
    }

    setSaving(true)
    setMsg(null)
    try {
      const saved = await saveAppSettings(profile, values)
      setSettings(saved)
      setTimezone(saved.timezone)
      setOverlongShiftHours(String(Number(saved.overlong_shift_hours)))
      setDefaultGpsRadius(String(saved.default_gps_radius_m))
      setGeoNoSignalMinutes(String(geoNoSignalOrDefault(saved.geo_no_signal_minutes)))
      setPaidGapAlertHours(String(gapAlertOrDefault(saved.paid_gap_alert_hours)))
      setDigestHour(String(digestHourOrDefault(saved.digest_hour)))
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
    { key: 'geo_no_signal', label: t('settings_geo_no_signal'), value: `${currentValues.geo_no_signal_minutes} ${t('min_short')}` },
    { key: 'paid_gap', label: t('settings_paid_gap_alert'), value: `${currentValues.paid_gap_alert_hours} ${t('h')}` },
    { key: 'digest_hour', label: t('settings_digest_hour'), value: `${currentValues.digest_hour}:00` },
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
            min={GPS_RADIUS_MIN}
            max={GPS_RADIUS_MAX}
            step={GPS_RADIUS_STEP}
            inputMode="numeric"
            value={defaultGpsRadius}
            disabled={saving}
            onChange={(e) => setDefaultGpsRadius(e.target.value)}
          />
          <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>{t('gps_radius_hint')}</p>

          <label htmlFor="settings-geo-no-signal">{t('settings_geo_no_signal')}</label>
          <input
            id="settings-geo-no-signal"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={geoNoSignalMinutes}
            disabled={saving}
            onChange={(e) => setGeoNoSignalMinutes(e.target.value)}
          />
          <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>{t('settings_geo_no_signal_hint')}</p>

          <label htmlFor="settings-paid-gap">{t('settings_paid_gap_alert')}</label>
          <input
            id="settings-paid-gap"
            type="number"
            min="0.25"
            step="0.25"
            inputMode="decimal"
            value={paidGapAlertHours}
            disabled={saving}
            onChange={(e) => setPaidGapAlertHours(e.target.value)}
          />
          <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>{t('settings_paid_gap_alert_hint')}</p>

          <label htmlFor="settings-digest-hour">{t('settings_digest_hour')}</label>
          <input
            id="settings-digest-hour"
            type="number"
            min="0"
            max="23"
            step="1"
            inputMode="numeric"
            value={digestHour}
            disabled={saving}
            onChange={(e) => setDigestHour(e.target.value)}
          />
          <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>{t('settings_digest_hour_hint')}</p>

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
