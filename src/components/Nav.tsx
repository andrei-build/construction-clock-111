import type { ComponentType, SVGProps } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
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
  IconUsers,
} from './icons'

type IconType = ComponentType<SVGProps<SVGSVGElement>>

export default function Nav({ manager }: { manager: boolean }) {
  const { t } = useI18n()
  const { profile } = useAuth()
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')
  const sideCls = ({ isActive }: { isActive: boolean }) => `side-link ${isActive ? 'active' : ''}`

  const groups: { label: string; items: { to: string; end?: boolean; Icon: IconType; label: string }[] }[] = [
    {
      label: t('nav_group_main'),
      items: [
        { to: '/', end: true, Icon: IconDashboard, label: t('dashboard') },
        { to: '/timeline', Icon: IconChart, label: t('timeline') },
        { to: '/checkin', Icon: IconTarget, label: t('checkin') },
        { to: '/messages', Icon: IconChat, label: t('messages') },
      ],
    },
    {
      label: t('nav_group_work'),
      items: [
        { to: '/projects', Icon: IconFolder, label: t('projects') },
        { to: '/team', Icon: IconUsers, label: t('team') },
        { to: '/consents', Icon: IconTarget, label: t('consents') },
        { to: '/dispatch', Icon: IconDispatch, label: t('dispatch') },
        { to: '/calendar', Icon: IconCalendar, label: t('calendar') },
        { to: '/map', Icon: IconMap, label: t('map') },
      ],
    },
    {
      label: t('nav_group_finance_clients'),
      items: [
        { to: '/time', Icon: IconClock, label: t('my_time') },
        { to: '/payroll', Icon: IconMoney, label: t('payroll') },
        { to: '/reports', Icon: IconChart, label: t('reports') },
        { to: '/sales', Icon: IconBriefcase, label: t('sales') },
      ],
    },
    {
      label: t('nav_group_admin'),
      items: [
        { to: '/more', Icon: IconSettings, label: t('more') },
      ],
    },
  ]

  return (
    <>
      <nav className="nav bottom-nav">
        {manager && (
          <NavLink to="/" end className={cls}>
            <span className="ico"><IconDashboard /></span>{t('dashboard')}
          </NavLink>
        )}
        {manager && (
          <NavLink to="/timeline" className={cls}>
            <span className="ico"><IconChart /></span>{t('timeline')}
          </NavLink>
        )}
        <NavLink to="/checkin" className={cls}>
          <span className="ico"><IconTarget /></span>{t('checkin')}
        </NavLink>
        <NavLink to="/projects" className={cls}>
          <span className="ico"><IconFolder /></span>{t('projects')}
        </NavLink>
        {manager && (
          <NavLink to="/team" className={cls}>
            <span className="ico"><IconUsers /></span>{t('team')}
          </NavLink>
        )}
        <NavLink to="/time" className={cls}>
          <span className="ico"><IconClock /></span>{t('my_time')}
        </NavLink>
        <NavLink to="/more" className={cls}>
          <span className="ico"><IconSettings /></span>{t('more')}
        </NavLink>
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
