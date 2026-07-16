import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getAppSettings, saveAppSettings, getTeam, reportGpsExport, purgeGpsFeeds, type AppSettingsInput } from '../lib/api'
import type { AppSettings, Profile } from '../lib/types'
import { GPS_RADIUS_MIN, GPS_RADIUS_MAX, GPS_RADIUS_STEP, clampGpsRadius } from '../lib/geofence'
import { DEFAULT_PAID_GAP_ALERT_HOURS } from '../lib/time'
// SET-2: «Настройки владельца» merged into «Настройки» — owner-only sections rendered inline below.
import OwnerSettingsSections from './OwnerSettings'

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

      {!loading && !loadError && canEdit && <GpsDataSection />}

      {/* SET-2: owner-only «Настройки владельца» sections (ЗАКОН-6). canEdit === role 'owner',
          so this is the isOwner gate; the sub-component also guards internally. /owner-settings
          redirects here to #owner. Non-owner admins keep the read-only view below and never see this. */}
      {!loading && !loadError && canEdit && <OwnerSettingsSections />}

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

// SET-1-GPS: owner-only «GPS-данные» — экспорт GPS в CSV + очистка трекинг-фидов. Обе операции идут
// через owner-only RPC в схеме `app` (см. src/lib/api/geo.ts). Ошибку RPC (напр. only_owner) показываем
// как есть. Компонент рендерится только для owner (гейтит родитель по canEdit).
type GpsPeriod = '7' | '30' | '90' | 'custom'
type GpsToast = { kind: 'ok' | 'error'; text: string } | null

// RFC-4180: любое поле в кавычках, внутренние кавычки удваиваются.
function gpsCsvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

// Локальная дата yyyy-mm-dd для <input type="date"> и имени файла.
function toDateInputValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function GpsDataSection() {
  const { t } = useI18n()
  const [team, setTeam] = useState<Profile[]>([])

  // Экспорт
  const [period, setPeriod] = useState<GpsPeriod>('30')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [exportWorker, setExportWorker] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportToast, setExportToast] = useState<GpsToast>(null)

  // Очистка фидов
  const [purgeBefore, setPurgeBefore] = useState('')
  const [purgeWorker, setPurgeWorker] = useState('')
  const [purgeStage, setPurgeStage] = useState<'idle' | 'confirm1' | 'confirm2'>('idle')
  const [purging, setPurging] = useState(false)
  const [purgeToast, setPurgeToast] = useState<GpsToast>(null)

  useEffect(() => {
    let mounted = true
    getTeam().then((rows) => { if (mounted) setTeam(rows) }).catch(() => {})
    // «Старше чем» по умолчанию = сейчас − 90 дней.
    const d = new Date()
    d.setDate(d.getDate() - 90)
    setPurgeBefore(toDateInputValue(d))
    return () => { mounted = false }
  }, [])

  const nameById = new Map(team.map((p) => [p.id, p.name]))

  // Диапазон экспорта: пресет 7/30/90 → [сейчас−N, сейчас]; свой → [from 00:00, to 23:59.999].
  function exportRange(): { from: string; to: string } | null {
    if (period === 'custom') {
      if (!fromDate || !toDate) return null
      const from = new Date(`${fromDate}T00:00:00`)
      const to = new Date(`${toDate}T23:59:59.999`)
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null
      return { from: from.toISOString(), to: to.toISOString() }
    }
    const days = Number(period)
    const from = new Date()
    from.setDate(from.getDate() - days)
    return { from: from.toISOString(), to: new Date().toISOString() }
  }

  async function handleExport() {
    if (exporting) return
    const range = exportRange()
    if (!range) { setExportToast({ kind: 'error', text: t('settings_gps_range_invalid') }); return }
    setExporting(true)
    setExportToast(null)
    try {
      const rows = await reportGpsExport(range.from, range.to, exportWorker || null)
      if (rows.length === 0) {
        setExportToast({ kind: 'ok', text: t('settings_gps_export_empty') })
        return
      }
      const header = ['source', 'profile', 'at', 'lat', 'lng', 'accuracy', 'detail']
      const lines = [header.map(gpsCsvCell).join(',')]
      for (const row of rows) {
        // profile-колонка = имя из команды, иначе сам profile_id.
        const profile = (row.profile_id ? nameById.get(row.profile_id) : null) ?? row.profile_id ?? ''
        lines.push([row.source, profile, row.at, row.lat, row.lng, row.accuracy_m, row.detail].map(gpsCsvCell).join(','))
      }
      const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `gps_export_${toDateInputValue(new Date())}.csv`
      a.click()
      URL.revokeObjectURL(url)
      setExportToast({ kind: 'ok', text: `${t('settings_gps_export_ok')}: ${rows.length}` })
    } catch (err) {
      setExportToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setExporting(false)
    }
  }

  async function handlePurge() {
    if (purging) return
    if (!purgeBefore) { setPurgeToast({ kind: 'error', text: t('settings_gps_purge_before_required') }); return }
    const before = new Date(`${purgeBefore}T00:00:00`)
    if (Number.isNaN(before.getTime())) { setPurgeToast({ kind: 'error', text: t('settings_gps_purge_before_required') }); return }
    setPurging(true)
    setPurgeToast(null)
    try {
      const counts = await purgeGpsFeeds(before.toISOString(), purgeWorker || null)
      const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')
      setPurgeToast({ kind: 'ok', text: summary ? `${t('settings_gps_purge_ok')} — ${summary}` : t('settings_gps_purge_ok') })
    } catch (err) {
      setPurgeToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setPurging(false)
      setPurgeStage('idle')
    }
  }

  const workerOptions = (
    <>
      <option value="">{t('settings_gps_all_workers')}</option>
      {team.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </>
  )

  return (
    <>
      <h2 style={{ marginTop: 24 }}>📍 {t('settings_gps_section')}</h2>

      {/* Экспорт GPS */}
      <section className="card">
        <h3 style={{ marginTop: 0 }}>{t('settings_gps_export_title')}</h3>
        <p className="muted" style={{ marginTop: -4 }}>{t('settings_gps_export_desc')}</p>

        <label htmlFor="gps-export-period">{t('settings_gps_period')}</label>
        <select
          id="gps-export-period"
          value={period}
          disabled={exporting}
          onChange={(e) => setPeriod(e.target.value as GpsPeriod)}
        >
          <option value="7">{t('settings_gps_period_7')}</option>
          <option value="30">{t('settings_gps_period_30')}</option>
          <option value="90">{t('settings_gps_period_90')}</option>
          <option value="custom">{t('settings_gps_period_custom')}</option>
        </select>

        {period === 'custom' && (
          <div className="row" style={{ gap: 12, marginTop: 10 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="gps-export-from">{t('settings_gps_from')}</label>
              <input id="gps-export-from" type="date" value={fromDate} disabled={exporting} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="gps-export-to">{t('settings_gps_to')}</label>
              <input id="gps-export-to" type="date" value={toDate} disabled={exporting} onChange={(e) => setToDate(e.target.value)} />
            </div>
          </div>
        )}

        <label htmlFor="gps-export-worker">{t('settings_gps_worker')}</label>
        <select id="gps-export-worker" value={exportWorker} disabled={exporting} onChange={(e) => setExportWorker(e.target.value)}>
          {workerOptions}
        </select>

        <button className="btn" style={{ marginTop: 12 }} disabled={exporting} onClick={handleExport}>
          {exporting ? t('settings_gps_exporting') : t('settings_gps_export_btn')}
        </button>
        {exportToast && <p className={exportToast.kind === 'ok' ? 'ok-msg' : 'error-msg'}>{exportToast.text}</p>}
      </section>

      {/* Очистить трекинг-фиды */}
      <section className="card">
        <h3 style={{ marginTop: 0 }}>{t('settings_gps_purge_title')}</h3>
        <p className="muted" style={{ marginTop: -4 }}>{t('settings_gps_purge_desc')}</p>

        <label htmlFor="gps-purge-before">{t('settings_gps_purge_before')}</label>
        <input
          id="gps-purge-before"
          type="date"
          value={purgeBefore}
          disabled={purging || purgeStage !== 'idle'}
          onChange={(e) => setPurgeBefore(e.target.value)}
        />

        <label htmlFor="gps-purge-worker">{t('settings_gps_worker')}</label>
        <select
          id="gps-purge-worker"
          value={purgeWorker}
          disabled={purging || purgeStage !== 'idle'}
          onChange={(e) => setPurgeWorker(e.target.value)}
        >
          {workerOptions}
        </select>

        {purgeStage === 'idle' && (
          <button className="btn red" style={{ marginTop: 12 }} disabled={purging} onClick={() => { setPurgeToast(null); setPurgeStage('confirm1') }}>
            {t('settings_gps_purge_btn')}
          </button>
        )}

        {purgeStage !== 'idle' && (
          <div className="card" style={{ marginTop: 12, background: 'var(--bg)', borderColor: 'var(--red)' }}>
            <p style={{ fontWeight: 600, marginTop: 0 }}>⚠️ {t('settings_gps_purge_warning')}</p>
            {purgeStage === 'confirm2' && <p className="muted" style={{ marginTop: -4 }}>{t('settings_gps_purge_confirm2_hint')}</p>}
            <div className="row" style={{ gap: 8 }}>
              {purgeStage === 'confirm1' ? (
                <button className="btn red" disabled={purging} onClick={() => setPurgeStage('confirm2')}>
                  {t('settings_gps_purge_continue')}
                </button>
              ) : (
                <button className="btn red" disabled={purging} onClick={handlePurge}>
                  {purging ? t('settings_gps_purging') : t('settings_gps_purge_confirm')}
                </button>
              )}
              <button className="btn ghost" disabled={purging} onClick={() => setPurgeStage('idle')}>
                {t('settings_gps_cancel')}
              </button>
            </div>
          </div>
        )}
        {purgeToast && <p className={purgeToast.kind === 'ok' ? 'ok-msg' : 'error-msg'}>{purgeToast.text}</p>}
      </section>
    </>
  )
}
