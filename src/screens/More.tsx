import { useEffect, useRef, useState, type ComponentType, type SVGProps } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { isManagerRole, notifPrefs } from '../lib/types'
import { updateNotifMode } from '../lib/api'
import AboutPanel from '../components/AboutPanel'
import PushToggle from '../components/PushToggle'
import ChangePasswordForm from '../components/ChangePasswordForm'
import {
  IconBriefcase,
  IconCalendar,
  IconChart,
  IconChat,
  IconDispatch,
  IconFolder,
  IconMap,
  IconMoney,
  IconSettings,
  IconTarget,
  IconUsers,
  IconWallet,
} from '../components/icons'

type IconType = ComponentType<SVGProps<SVGSVGElement>>

// NAV-2 (в): иконка рядом с каждым пунктом меню (тот же лёгкий inline-SVG набор, что и в Nav).
function MoreLink({ to, Icon, label }: { to: string; Icon: IconType; label: string }) {
  return (
    <Link to={to} className="btn ghost small more-link">
      <span className="more-ico"><Icon /></span>
      <span>{label}</span>
    </Link>
  )
}

// M11: «Беззвучный режим» — личное предпочтение уведомлений (profiles.notif_mode) для ЛЮБОЙ роли.
// ВКЛ = тишина (notif_mode='off', полная тишина по notifPrefs); ВЫКЛ = обычный режим ('default').
// Текущее состояние читаем из профиля (источник правды) через notifPrefs; после записи зовём
// refresh(), чтобы notifications.tsx сразу подхватил новый режим. Живёт в секции «Уведомления».
function SilentModeToggle() {
  const { profile, refresh } = useAuth()
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<'ok' | 'err' | null>(null)
  const timer = useRef<number | null>(null)
  const silent = !notifPrefs(profile?.notif_mode).sound

  const flash = (kind: 'ok' | 'err') => {
    setToast(kind)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { setToast(null); timer.current = null }, 3000)
  }
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])

  const toggle = async () => {
    if (busy) return
    setBusy(true)
    try {
      await updateNotifMode(silent ? 'default' : 'off')
      await refresh()
      flash('ok')
    } catch {
      flash('err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div style={{ fontWeight: 600 }}>{t('silent_mode_toggle')}</div>
      <p className="muted" style={{ marginTop: 4 }}>{t('silent_mode_hint')}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <span className={`badge ${silent ? 'amber' : 'green'}`}>
          {silent ? t('silent_state_on') : t('silent_state_off')}
        </span>
        <button className={silent ? 'btn small' : 'btn ghost small'} onClick={toggle} disabled={busy}>
          {busy ? t('push_working') : silent ? t('silent_disable') : t('silent_enable')}
        </button>
      </div>
      {toast === 'ok' && <p className="muted" style={{ marginTop: 8 }}>{t('silent_saved')}</p>}
      {toast === 'err' && <p className="error-msg" style={{ marginTop: 8 }}>{t('silent_failed')}</p>}
    </div>
  )
}

export default function More() {
  const { profile, logout } = useAuth()
  const { t, lang, setLang } = useI18n()
  const manager = profile ? isManagerRole(profile.role) : false
  const salesAccess = profile ? manager || profile.role === 'sales' : false
  const isOwner = profile?.role === 'owner'
  // SET-1: /settings regated to owner/admin only (plain managers no longer see it).
  const isAdminOrOwner = isOwner || profile?.role === 'admin'
  // ACC-4 (c): пароль выдаёт владелец. Форму смены пароля показываем ТОЛЬКО владельцу ИЛИ сотруднику,
  // которому владелец выдал право can_change_password (грузится в auth.fetchProfile как capabilities[]).
  const canChangeOwnPassword = isOwner || (profile?.capabilities?.includes('can_change_password') ?? false)

  // NAV-1/NAV-2: «Ещё / More» — три сгруппированные секции (РАБОТА / ФИНАНСЫ / АДМИН).
  // Верхнее меню держим коротким (см. src/components/Nav.tsx); всё остальное — здесь.
  // Экраны /daily, /gallery, /files больше не имеют пункта в меню (живут в хабе проекта),
  // но маршруты в src/App.tsx сохранены (глубокие ссылки продолжают работать).
  return (
    <div className="screen">
      <h1>⚙️ {t('more')}</h1>

      <div className="card">
        <div style={{ fontWeight: 700, fontSize: 18 }}>{profile?.name}</div>
        <span className="badge amber">{profile?.role}</span>
      </div>

      {/* ACC-4 (c): «Мой аккаунт» — смена пароля только владельцу ИЛИ сотруднику с правом
          can_change_password. Иначе форму прячем и объясняем, что пароль выдаёт владелец. */}
      <h2>{t('account_section')}</h2>
      <div className="card">
        {canChangeOwnPassword ? <ChangePasswordForm /> : <p className="muted">{t('password_owner_managed')}</p>}
      </div>

      {/* РАБОТА / WORK */}
      <h2>{t('more_group_work')}</h2>
      <div className="more-group">
        {manager && <MoreLink to="/dispatch" Icon={IconDispatch} label={t('command_center')} />}
        {manager && <MoreLink to="/calendar" Icon={IconCalendar} label={t('calendar')} />}
        {manager && <MoreLink to="/team-calendar" Icon={IconCalendar} label={t('team_calendar')} />}
        {manager && <MoreLink to="/stores" Icon={IconBriefcase} label={t('stores')} />}
        {manager && <MoreLink to="/map" Icon={IconMap} label={t('map')} />}
        {manager && <MoreLink to="/timeline" Icon={IconChart} label={t('timeline')} />}
        <MoreLink to="/messages" Icon={IconChat} label={t('messages')} />
      </div>

      {/* ФИНАНСЫ / FINANCE */}
      {salesAccess && (
        <>
          <h2>{t('more_group_finance')}</h2>
          <div className="more-group">
            <MoreLink to="/sales" Icon={IconBriefcase} label={t('sales')} />
            {manager && <MoreLink to="/clients" Icon={IconUsers} label={t('clients')} />}
            {manager && <MoreLink to="/payroll" Icon={IconMoney} label={t('payroll')} />}
            {manager && <MoreLink to="/documents" Icon={IconWallet} label={t('documents')} />}
            {manager && <MoreLink to="/reports" Icon={IconChart} label={t('reports')} />}
          </div>
        </>
      )}

      {/* АДМИН / ADMIN — role-gated (NAV-2 г: цели SET-1/ARCH-1 могут ещё не существовать,
          пункты запаркованы за менеджером/владельцем; глубокие ссылки не ломаем). */}
      {manager && (
        <>
          <h2>{t('more_group_admin')}</h2>
          <div className="more-group">
            {/* SET-2 (ЗАКОН-6): «Настройки владельца» merged into «Настройки» (/settings#owner). */}
            {isAdminOrOwner && <MoreLink to="/settings" Icon={IconSettings} label={t('settings')} />}
            <MoreLink to="/archive" Icon={IconFolder} label={t('archive')} />
            {/* SET-2 (ЗАКОН-7): «Согласия» removed — now inside the person dossier (/team/:id). */}
          </div>
        </>
      )}

      <h2>{t('push_section')}</h2>
      <PushToggle />
      <SilentModeToggle />

      <h2>{t('language')}</h2>
      <div className="tabs">
        {(['ru', 'en', 'es'] as const).map((l) => (
          <button key={l} className={lang === l ? 'active' : ''} onClick={() => setLang(l)}>
            {l === 'ru' ? 'Русский' : l === 'en' ? 'English' : 'Español'}
          </button>
        ))}
      </div>

      <button className="btn red" style={{ marginTop: 24 }} onClick={logout}>{t('logout')}</button>

      {isOwner && <AboutPanel />}

      <p className="muted center" style={{ marginTop: 24 }}>
        Construction Clock v0.1 · Foundation
      </p>
    </div>
  )
}
