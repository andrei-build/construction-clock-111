import type { ComponentType, SVGProps } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { isManagerRole } from '../lib/types'
import AboutPanel from '../components/AboutPanel'
import PushToggle from '../components/PushToggle'
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

export default function More() {
  const { profile, logout } = useAuth()
  const { t, lang, setLang } = useI18n()
  const manager = profile ? isManagerRole(profile.role) : false
  const salesAccess = profile ? manager || profile.role === 'sales' : false
  const isOwner = profile?.role === 'owner'

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

      {/* РАБОТА / WORK */}
      <h2>{t('more_group_work')}</h2>
      <div className="more-group">
        {manager && <MoreLink to="/dispatch" Icon={IconDispatch} label={t('dispatch')} />}
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
            <MoreLink to="/settings" Icon={IconSettings} label={t('settings')} />
            <MoreLink to="/archive" Icon={IconFolder} label={t('archive')} />
            {/* TODO WF-1: move consents into worker dossier /team/:id. */}
            <MoreLink to="/consents" Icon={IconTarget} label={t('consents')} />
          </div>
        </>
      )}

      <h2>{t('push_section')}</h2>
      <PushToggle />

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
