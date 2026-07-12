import { NavLink } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'

export default function Nav({ manager }: { manager: boolean }) {
  const { t } = useI18n()
  const { profile } = useAuth()
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')
  const sideCls = ({ isActive }: { isActive: boolean }) => `side-link ${isActive ? 'active' : ''}`
  const roleBadge = (role?: string) =>
    role === 'owner' || role === 'admin' ? 'red' : role === 'manager' || role === 'supervisor' ? 'amber' : 'blue'

  const groups = [
    {
      label: t('nav_group_main'),
      items: [
        { to: '/', end: true, icon: '📊', label: t('dashboard') },
        { to: '/checkin', icon: '⏱️', label: t('checkin') },
        { to: '/messages', icon: '💬', label: t('messages') },
      ],
    },
    {
      label: t('nav_group_work'),
      items: [
        { to: '/projects', icon: '📁', label: t('projects') },
        { to: '/team', icon: '👷', label: t('team') },
        { to: '/dispatch', icon: '🧭', label: t('dispatch') },
        { to: '/calendar', icon: '📅', label: t('calendar') },
        { to: '/map', icon: '🗺️', label: t('map') },
      ],
    },
    {
      label: t('nav_group_finance_clients'),
      items: [
        { to: '/time', icon: '🕐', label: t('my_time') },
        { to: '/payroll', icon: '💵', label: t('payroll') },
        { to: '/reports', icon: '📈', label: t('reports') },
        { to: '/sales', icon: '🤝', label: t('sales') },
      ],
    },
    {
      label: t('nav_group_admin'),
      items: [
        { to: '/more', icon: '⚙️', label: t('more') },
      ],
    },
  ]

  return (
    <>
      <nav className="nav bottom-nav">
        {manager && <NavLink to="/" end className={cls}><span className="ico">📊</span>{t('dashboard')}</NavLink>}
        <NavLink to="/checkin" className={cls}><span className="ico">⏱️</span>{t('checkin')}</NavLink>
        <NavLink to="/projects" className={cls}><span className="ico">📁</span>{t('projects')}</NavLink>
        {manager && <NavLink to="/team" className={cls}><span className="ico">👷</span>{t('team')}</NavLink>}
        <NavLink to="/time" className={cls}><span className="ico">🕐</span>{t('my_time')}</NavLink>
        <NavLink to="/more" className={cls}><span className="ico">⚙️</span>{t('more')}</NavLink>
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
            <span className={`badge ${roleBadge(profile?.role)}`}>{profile?.role}</span>
          </div>

          <div className="side-groups">
            {groups.map((group) => (
              <section className="side-group" key={group.label}>
                <h2>{group.label}</h2>
                {group.items.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end} className={sideCls}>
                    <span className="side-ico">{item.icon}</span>
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
