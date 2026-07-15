import type { ComponentType, FormEvent, SVGProps } from 'react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getTeam, getAppSettings, saveAppSettings, inviteAdmin, type AppSettingsInput } from '../lib/api'
import type { AppSettings, Profile } from '../lib/types'
import {
  STORE_RADIUS_MIN,
  STORE_RADIUS_MAX,
  STORE_RADIUS_STEP,
  STORE_RADIUS_DEFAULT,
  clampStoreRadius,
} from '../lib/geofence'
import {
  IconChart,
  IconFolder,
  IconMap,
  IconMoney,
  IconTarget,
  IconUsers,
} from '../components/icons'

type IconType = ComponentType<SVGProps<SVGSVGElement>>

// SET-1: «Центр доступа и контроля» — плитки-ссылки на существующие экраны.
// stub === true → цель ещё не построена (нет маршрута): плитка помечена «скоро», не ведёт в никуда.
type AccessTile = { key: string; to?: string; Icon: IconType; labelKey: string; stub?: boolean }
const ACCESS_TILES: AccessTile[] = [
  { key: 'roles', to: '/team', Icon: IconUsers, labelKey: 'owner_tile_roles' },
  { key: 'finance', Icon: IconMoney, labelKey: 'owner_tile_finance', stub: true },
  { key: 'audit', to: '/timeline', Icon: IconChart, labelKey: 'owner_tile_audit' },
  { key: 'archive', to: '/archive', Icon: IconFolder, labelKey: 'owner_tile_archive' },
  { key: 'ai', Icon: IconTarget, labelKey: 'owner_tile_ai', stub: true },
  { key: 'geo', to: '/map', Icon: IconMap, labelKey: 'owner_tile_geo' },
]

// Собираем полный payload из уже загруженных настроек + новое значение радиуса,
// чтобы upsert не сбросил остальные колонки (default_language/timezone/пороги/…).
function payloadFrom(source: AppSettings, storeRadius: number): AppSettingsInput {
  return {
    default_language: source.default_language,
    timezone: source.timezone,
    overlong_shift_hours: source.overlong_shift_hours,
    default_gps_radius_m: source.default_gps_radius_m,
    geo_no_signal_minutes: source.geo_no_signal_minutes,
    paid_gap_alert_hours: source.paid_gap_alert_hours,
    store_visit_radius_m: storeRadius,
  }
}

function inviteErrorKey(error?: string): string {
  if (error === 'only_owner_can_invite') return 'invite_admin_err_only_owner'
  if (error === 'create_failed') return 'invite_admin_err_create_failed'
  return 'invite_admin_err_generic'
}

export default function OwnerSettings() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const isOwner = profile?.role === 'owner'

  const [team, setTeam] = useState<Profile[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [storeRadius, setStoreRadius] = useState(STORE_RADIUS_DEFAULT)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'owner' | 'admin'>('admin')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [resultLink, setResultLink] = useState('')
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [inviteCopied, setInviteCopied] = useState(false)

  useEffect(() => {
    if (!isOwner) { setLoading(false); return }
    let mounted = true
    async function load() {
      setLoading(true)
      // Переиспользуем существующий team-fetch (getTeam) и getAppSettings.
      const [tm, row] = await Promise.all([getTeam(), getAppSettings()])
      if (!mounted) return
      setTeam(tm)
      setSettings(row)
      setStoreRadius(clampStoreRadius(Number(row?.store_visit_radius_m ?? STORE_RADIUS_DEFAULT)))
      setLoading(false)
    }
    load().catch(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [profile?.id, isOwner])

  // Владельцы / администраторы организации (у CC их двое: Andrew + Serge).
  const admins = team.filter((m) => m.role === 'owner' || m.role === 'admin')

  async function handleSave() {
    if (!profile || !isOwner || saving) return
    setSaving(true)
    setMsg(null)
    try {
      // Если строки настроек ещё нет — стартуем от текущих значений формы (радиус) поверх
      // загруженного row; getAppSettings обычно уже вернул строку организации.
      const base: AppSettings = settings ?? {
        org_id: profile.org_id,
        default_language: profile.language || 'ru',
        timezone: 'America/Los_Angeles',
        overlong_shift_hours: 11,
        default_gps_radius_m: 150,
        geo_no_signal_minutes: 15,
        paid_gap_alert_hours: 4,
        store_visit_radius_m: STORE_RADIUS_DEFAULT,
        digest_hour: 18,
        settings: {},
        updated_by: null,
        updated_at: '',
      }
      const saved = await saveAppSettings(profile, payloadFrom(base, clampStoreRadius(storeRadius)))
      setSettings(saved)
      setStoreRadius(clampStoreRadius(Number(saved.store_visit_radius_m ?? STORE_RADIUS_DEFAULT)))
      setMsg('settings_saved')
    } catch {
      setMsg('settings_save_failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleInviteSubmit(e: FormEvent) {
    e.preventDefault()
    if (!isOwner || inviteBusy) return
    const trimmedName = inviteName.trim()
    const trimmedEmail = inviteEmail.trim()
    if (!trimmedName || !trimmedEmail) return
    setInviteBusy(true)
    setResultLink('')
    setErrorKey(null)
    setInviteCopied(false)
    try {
      const result = await inviteAdmin(trimmedName, trimmedEmail, inviteRole)
      if (result.ok && result.invite_link) {
        setResultLink(result.invite_link)
        setInviteName('')
        setInviteEmail('')
      } else {
        setErrorKey(inviteErrorKey(result.error))
      }
    } catch {
      setErrorKey('invite_admin_err_generic')
    } finally {
      setInviteBusy(false)
    }
  }

  async function copyInviteLink() {
    if (!resultLink) return
    setInviteCopied(false)
    try {
      await navigator.clipboard.writeText(resultLink)
      setInviteCopied(true)
    } catch {
      setInviteCopied(false)
    }
  }

  const roleBadge = (r: string) =>
    r === 'owner' ? 'red' : r === 'admin' ? 'amber' : 'blue'

  if (!isOwner) {
    // Дружелюбный отказ — не падаем, показываем понятную заметку.
    return (
      <div className="screen">
        <h1>🔐 {t('owner_settings')}</h1>
        <div className="card muted">{t('owner_settings_denied')}</div>
      </div>
    )
  }

  const msgClass = msg === 'settings_saved' ? 'ok-msg' : 'error-msg'
  const inviteDisabled = !inviteName.trim() || !inviteEmail.trim() || inviteBusy

  return (
    <div className="screen">
      <h1>🔐 {t('owner_settings')}</h1>
      <p className="muted" style={{ marginTop: -6 }}>{t('owner_settings_sub')}</p>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {msg && <p className={msgClass}>{t(msg)}</p>}

      {!loading && (
        <>
          {/* Владельцы / администраторы */}
          <h2>{t('owner_admins_title')}</h2>
          <div className="owner-admin-list">
            {admins.length === 0 && <div className="card muted">{t('owner_admins_empty')}</div>}
            {admins.map((m) => (
              <div key={m.id} className="card owner-admin-card">
                <div>
                  <div style={{ fontWeight: 700 }}>{m.name}</div>
                  <span className="badge green" style={{ marginTop: 4 }}>{t('owner_status_active')}</span>
                </div>
                <span className={`badge ${roleBadge(m.role)}`}>{t(`role_${m.role}`)}</span>
              </div>
            ))}
          </div>
          <Link to="/team" className="btn ghost small">{t('owner_manage_admins')}</Link>

          {/* ACC-2: владелец приглашает owner/admin через edge invite-admin. */}
          <h2 style={{ marginTop: 24 }}>{t('invite_admin_title')}</h2>
          <form onSubmit={handleInviteSubmit} className="card">
            <p className="muted" style={{ marginTop: 0 }}>{t('invite_admin_desc')}</p>
            <label htmlFor="invite-admin-name">{t('invite_admin_name')}</label>
            <input
              id="invite-admin-name"
              value={inviteName}
              disabled={inviteBusy}
              autoComplete="name"
              onChange={(e) => setInviteName(e.target.value)}
            />
            <label htmlFor="invite-admin-email">{t('invite_admin_email')}</label>
            <input
              id="invite-admin-email"
              type="email"
              value={inviteEmail}
              disabled={inviteBusy}
              autoComplete="email"
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <label htmlFor="invite-admin-role">{t('invite_admin_role')}</label>
            <select
              id="invite-admin-role"
              value={inviteRole}
              disabled={inviteBusy}
              onChange={(e) => setInviteRole(e.target.value as 'owner' | 'admin')}
            >
              <option value="admin">{t('invite_admin_role_admin')}</option>
              <option value="owner">{t('invite_admin_role_owner')}</option>
            </select>
            <button className="btn" disabled={inviteDisabled}>
              {inviteBusy ? t('settings_saving') : t('invite_admin_submit')}
            </button>
            {errorKey && <p className="error-msg">{t(errorKey)}</p>}
            {resultLink && (
              <div style={{ marginTop: 12 }}>
                <p className="muted">{t('invite_admin_link_intro')}</p>
                <input
                  readOnly
                  value={resultLink}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ fontFamily: 'monospace' }}
                />
                <button type="button" className="btn ghost small" onClick={copyInviteLink}>
                  {t('invite_admin_copy')}
                </button>
                {inviteCopied && <p className="ok-msg">{t('invite_admin_copied')}</p>}
              </div>
            )}
          </form>

          {/* Центр доступа и контроля */}
          <h2 style={{ marginTop: 24 }}>{t('owner_access_center')}</h2>
          <div className="owner-tiles">
            {ACCESS_TILES.map((tile) => {
              const inner = (
                <>
                  <span className="owner-tile-ico"><tile.Icon /></span>
                  <span className="owner-tile-label">{t(tile.labelKey)}</span>
                  {tile.stub && <span className="badge grey owner-tile-stub">{t('owner_soon')}</span>}
                </>
              )
              return tile.stub || !tile.to ? (
                <div key={tile.key} className="owner-tile owner-tile-disabled" aria-disabled="true">{inner}</div>
              ) : (
                <Link key={tile.key} to={tile.to} className="owner-tile">{inner}</Link>
              )
            })}
          </div>

          {/* Радиус геозоны магазинов */}
          <h2 style={{ marginTop: 24 }}>{t('owner_store_radius_title')}</h2>
          <div className="card">
            <label htmlFor="store-radius" className="row" style={{ justifyContent: 'space-between' }}>
              <span>{t('owner_store_radius_label')}</span>
              <strong>{storeRadius} {t('m_short')}</strong>
            </label>
            <input
              id="store-radius"
              type="range"
              min={STORE_RADIUS_MIN}
              max={STORE_RADIUS_MAX}
              step={STORE_RADIUS_STEP}
              value={storeRadius}
              disabled={saving}
              onChange={(e) => setStoreRadius(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <p className="muted" style={{ marginTop: 4 }}>{t('owner_store_radius_hint')}</p>
            <button className="btn" disabled={saving} onClick={handleSave}>
              {saving ? t('settings_saving') : t('owner_save_settings')}
            </button>
          </div>

          {/* Данные геолокации (экспорт/удаление для юр. запросов) */}
          <h2 style={{ marginTop: 24 }}>{t('owner_geo_data_title')}</h2>
          <div className="card">
            <p className="muted" style={{ marginTop: 0 }}>{t('owner_geo_data_note')}</p>
            <button className="btn ghost" onClick={() => setMsg('owner_geo_data_backend')}>
              {t('owner_geo_data_request')}
            </button>
            {msg === 'owner_geo_data_backend' && (
              <p className="muted" style={{ marginTop: 8 }}>{t('owner_geo_data_backend')}</p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
