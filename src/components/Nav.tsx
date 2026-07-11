import { NavLink } from 'react-router-dom'
import { useI18n } from '../lib/i18n'

export default function Nav({ manager }: { manager: boolean }) {
  const { t } = useI18n()
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')
  return (
    <nav className="nav">
      {manager && <NavLink to="/" end className={cls}><span className="ico">📊</span>{t('dashboard')}</NavLink>}
      <NavLink to="/checkin" className={cls}><span className="ico">⏱️</span>{t('checkin')}</NavLink>
      <NavLink to="/projects" className={cls}><span className="ico">📁</span>{t('projects')}</NavLink>
      {manager && <NavLink to="/team" className={cls}><span className="ico">👷</span>{t('team')}</NavLink>}
      <NavLink to="/time" className={cls}><span className="ico">🕐</span>{t('my_time')}</NavLink>
      <NavLink to="/more" className={cls}><span className="ico">⚙️</span>{t('more')}</NavLink>
    </nav>
  )
}
