import type { ComponentType, SVGProps } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import ManagerWorkAlertBell from './ManagerWorkAlertBell'
import {
  IconBriefcase,
  IconCalendar,
  IconChart,
  IconChat,
  IconClock,
  IconDashboard,
  IconDispatch,
  IconFolder,
  IconMap,
  IconMoney,
  IconSettings,
  IconTarget,
  IconTasks,
  IconUsers,
  IconWallet,
} from './icons'

type IconType = ComponentType<SVGProps<SVGSVGElement>>

export default function Nav({ manager }: { manager: boolean }) {
  const { t } = useI18n()
  const { profile } = useAuth()
  const driver = profile?.role === 'driver'
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')
  const sideCls = ({ isActive }: { isActive: boolean }) => `side-link ${isActive ? 'active' : ''}`

  // NAV-1: закон навигации — верхнее меню КОРОТКОЕ (6 пунктов), всё остальное живёт
  // внутри «Ещё / More» (см. src/screens/More.tsx) и хабов. Экраны/маршруты не удаляются,
  // меняется только точка входа в меню. Десктоп-сайдбар (только менеджер) держит те же
  // 6 основных пунктов сверху, а полный сгруппированный список — ниже, чтобы ничего не осиротить.
  const groups: { label: string; items: { to: string; end?: boolean; Icon: IconType; label: string }[] }[] = [
    {
      label: t('nav_group_main'),
      items: [
        { to: '/', end: true, Icon: IconDashboard, label: t('dashboard') },
        { to: '/projects', Icon: IconFolder, label: t('projects') },
        { to: '/tasks', Icon: IconTasks, label: t('tasks') },
        { to: '/team', Icon: IconUsers, label: t('team') },
        { to: '/schedule', Icon: IconCalendar, label: t('schedule') },
        { to: '/more', Icon: IconSettings, label: t('more') },
      ],
    },
    {
      label: t('more_group_work'),
      items: [
        { to: '/dispatch', Icon: IconDispatch, label: t('dispatch') },
        { to: '/calendar', Icon: IconCalendar, label: t('calendar') },
        { to: '/team-calendar', Icon: IconCalendar, label: t('team_calendar') },
        { to: '/stores', Icon: IconBriefcase, label: t('stores') },
        { to: '/map', Icon: IconMap, label: t('map') },
        { to: '/timeline', Icon: IconChart, label: t('timeline') },
        { to: '/messages', Icon: IconChat, label: t('messages') },
      ],
    },
    {
      label: t('more_group_finance'),
      items: [
        { to: '/sales', Icon: IconBriefcase, label: t('sales') },
        { to: '/clients', Icon: IconUsers, label: t('clients') },
        { to: '/payroll', Icon: IconMoney, label: t('payroll') },
        { to: '/documents', Icon: IconWallet, label: t('documents') },
        { to: '/reports', Icon: IconChart, label: t('reports') },
      ],
    },
    {
      label: t('more_group_admin'),
      items: [
        { to: '/settings', Icon: IconSettings, label: t('settings') },
        { to: '/archive', Icon: IconFolder, label: t('archive') },
        // TODO WF-1: move consents into worker dossier /team/:id.
        { to: '/consents', Icon: IconTarget, label: t('consents') },
      ],
    },
  ]

  return (
    <>
      <nav className="nav bottom-nav">
        {manager ? (
          <>
            <NavLink to="/" end className={cls}>
              <span className="ico"><IconDashboard /></span>{t('dashboard')}
            </NavLink>
            <NavLink to="/projects" className={cls}>
              <span className="ico"><IconFolder /></span>{t('projects')}
            </NavLink>
            <NavLink to="/tasks" className={cls}>
              <span className="ico"><IconTasks /></span>{t('tasks')}
            </NavLink>
            <NavLink to="/team" className={cls}>
              <span className="ico"><IconUsers /></span>{t('team')}
            </NavLink>
            <NavLink to="/schedule" className={cls}>
              <span className="ico"><IconCalendar /></span>{t('schedule')}
            </NavLink>
            <NavLink to="/more" className={cls}>
              <span className="ico"><IconSettings /></span>{t('more')}
            </NavLink>
          </>
        ) : (
          <>
            {/* Водитель: «Маршрут дня» — первая вкладка. «Мои часы» — только для worker/driver. */}
            {driver && (
              <NavLink to="/route" className={cls}>
                <span className="ico"><IconDispatch /></span>{t('route_nav')}
              </NavLink>
            )}
            <NavLink to="/checkin" className={cls}>
              <span className="ico"><IconTarget /></span>{t('checkin')}
            </NavLink>
            <NavLink to="/time" className={cls}>
              <span className="ico"><IconClock /></span>{t('my_time')}
            </NavLink>
            <NavLink to="/tasks" className={cls}>
              <span className="ico"><IconTasks /></span>{t('tasks')}
            </NavLink>
            <NavLink to="/more" className={cls}>
              <span className="ico"><IconSettings /></span>{t('more')}
            </NavLink>
          </>
        )}
      </nav>

      {manager && (
        <aside className="sidebar-nav" aria-label={t('desktop_nav')}>
          <div className="side-brand">
            <div className="side-mark">CC</div>
            <div>
              <div className="side-title">{t('appName')}</div>
              <div className="side-subtitle">{t('desktop_workspace')}</div>
            </div>
          </div>

          <div className="side-profile">
            <div className="side-profile-name">{profile?.name}</div>
            <span className="side-role">{profile?.role}</span>
          </div>

          <ManagerWorkAlertBell />

          <div className="side-groups">
            {groups.map((group) => (
              <section className="side-group" key={group.label}>
                <h2>{group.label}</h2>
                {group.items.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end} className={sideCls}>
                    <span className="side-ico"><item.Icon /></span>
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </section>
            ))}
          </div>
        </aside>
      )}
    </>
  )
}
