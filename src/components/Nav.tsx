import type { ComponentType, SVGProps } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import ManagerWorkAlertBell from './ManagerWorkAlertBell'
import {
  IconBriefcase,
  IconCalendar,
  IconChat,
  IconClock,
  IconDashboard,
  IconDispatch,
  IconFolder,
  IconGrid,
  IconSettings,
  IconTarget,
  IconTasks,
  IconUsers,
} from './icons'

type IconType = ComponentType<SVGProps<SVGSVGElement>>
type NavItem = { to: string; end?: boolean; Icon: IconType; label: string }

export default function Nav({ manager }: { manager: boolean }) {
  const { t } = useI18n()
  const { profile } = useAuth()
  const driver = profile?.role === 'driver'
  const sales = profile?.role === 'sales'
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')
  const sideCls = ({ isActive }: { isActive: boolean }) => `side-link ${isActive ? 'active' : ''}`

  // NAV-2: закон навигации — верхнее меню КОРОТКОЕ, всё прочее живёт в «Ещё / More»
  // (см. src/screens/More.tsx) и хабах. «Обзор» первым; командный центр — оперативная база
  // (диспетчер вольётся сюда в DISP-1). Десктоп-сайдбар держит РОВНО те же пункты, что и мобайл
  // (NAV-2 б: сгруппированный список WORK/FINANCE/ADMIN из сайдбара убран — он дублировал «Ещё»).
  const managerItems: NavItem[] = [
    { to: '/overview', Icon: IconGrid, label: t('overview') },
    { to: '/', end: true, Icon: IconDashboard, label: t('command_center') },
    { to: '/projects', Icon: IconFolder, label: t('projects') },
    { to: '/tasks', Icon: IconTasks, label: t('tasks') },
    { to: '/team', Icon: IconUsers, label: t('team') },
    { to: '/schedule', Icon: IconCalendar, label: t('schedule') },
    { to: '/more', Icon: IconSettings, label: t('more') },
  ]

  // NAV-2 (д): ролевой сплит. owner/admin/менеджер → managerItems (всё). Водитель → только своё
  // (Маршрут дня, свои задачи/доставки, сообщения; «Мои часы» опционально). Продажи → только своя
  // зона (продажи + сообщения, без полевых данных и зарплаты). Работник → своё (отметка/часы/задачи).
  const driverItems: NavItem[] = [
    { to: '/route', Icon: IconDispatch, label: t('route_nav') },
    { to: '/tasks', Icon: IconTasks, label: t('tasks') },
    { to: '/messages', Icon: IconChat, label: t('messages') },
    { to: '/time', Icon: IconClock, label: t('my_time') },
    { to: '/more', Icon: IconSettings, label: t('more') },
  ]
  const salesItems: NavItem[] = [
    { to: '/sales', Icon: IconBriefcase, label: t('sales') },
    { to: '/messages', Icon: IconChat, label: t('messages') },
    { to: '/more', Icon: IconSettings, label: t('more') },
  ]
  const workerItems: NavItem[] = [
    { to: '/checkin', Icon: IconTarget, label: t('checkin') },
    { to: '/time', Icon: IconClock, label: t('my_time') },
    { to: '/tasks', Icon: IconTasks, label: t('tasks') },
    { to: '/more', Icon: IconSettings, label: t('more') },
  ]

  const items = manager ? managerItems : driver ? driverItems : sales ? salesItems : workerItems

  return (
    <>
      <nav className="nav bottom-nav">
        {items.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={cls}>
            <span className="ico"><item.Icon /></span>{item.label}
          </NavLink>
        ))}
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
            <section className="side-group">
              {managerItems.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={sideCls}>
                  <span className="side-ico"><item.Icon /></span>
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </section>
          </div>
        </aside>
      )}
    </>
  )
}
