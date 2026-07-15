import type { ComponentType, SVGProps } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { useNotifications } from '../lib/notifications'
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
  IconGrid,
  IconMap,
  IconMoney,
  IconSettings,
  IconTarget,
  IconTasks,
  IconUsers,
  IconWallet,
} from './icons'

type IconType = ComponentType<SVGProps<SVGSVGElement>>
type NavItem = { to: string; end?: boolean; Icon: IconType; label: string }
// NAV-4: пункт десктоп-сайдбара может быть скрыт по роли (show); undefined = виден всем менеджерам.
type SideItem = NavItem & { show?: boolean }
type SideGroup = { title: string; items: SideItem[] }

export default function Nav({ manager }: { manager: boolean }) {
  const { t } = useI18n()
  const { profile } = useAuth()
  // MSG-1: бейдж непрочитанных сообщений на пункте «Сообщения» (мобайл + десктоп-сайдбар).
  const { unreadMessages } = useNotifications()
  const unreadBadge = unreadMessages > 99 ? '99+' : String(unreadMessages)
  const driver = profile?.role === 'driver'
  const sales = profile?.role === 'sales'
  const isOwner = profile?.role === 'owner'
  // SET-1: /settings — owner/admin; /owner-settings — owner only (то же гейтирование, что в «Ещё»).
  const isAdminOrOwner = isOwner || profile?.role === 'admin'
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')
  const sideCls = ({ isActive }: { isActive: boolean }) => `side-link ${isActive ? 'active' : ''}`

  // NAV-2/NAV-4: закон навигации РАЗДВОЕН по ширине экрана.
  //   Мобайл — верхнее меню КОРОТКОЕ (managerItems), всё прочее живёт в «Ещё / More»
  //     (см. src/screens/More.tsx) и хабах. МОБАЙЛ НЕ МЕНЯЕМ.
  //   Десктоп — слева есть место: показываем ПОЛНЫЙ сгруппированный список (sideGroups ниже),
  //     без «Ещё», каждый пункт в один клик (NAV-4: «zero extra clicks»).
  // CC-2: командой рулят из «Командного центра» (/dispatch). Отдельный экран «Задачи» убран из
  // навигации менеджера — доска задач живёт внутри Командного центра (маршрут /tasks → редирект).
  const managerItems: NavItem[] = [
    { to: '/overview', Icon: IconGrid, label: t('overview') },
    { to: '/', end: true, Icon: IconDashboard, label: t('nav_home') },
    { to: '/dispatch', Icon: IconDispatch, label: t('command_center') },
    { to: '/projects', Icon: IconFolder, label: t('projects') },
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

  // NAV-4: полный сгруппированный список для ДЕСКТОП-сайдбара (как в Check Time), 4 группы.
  // Порядок и пункты фиксированы; маршруты/иконки/лейблы переиспользуют существующие ключи.
  // Ролевое гейтирование — ровно как в «Ещё»: сайдбар рендерится только для менеджеров
  // (manager && …), а внутри — settings/owner-settings скрыты по isAdminOrOwner/isOwner.
  const sideGroups: SideGroup[] = [
    {
      title: t('nav_group_main'),
      items: [
        { to: '/overview', Icon: IconGrid, label: t('overview') },
        { to: '/', end: true, Icon: IconDashboard, label: t('nav_home') },
        { to: '/dispatch', Icon: IconDispatch, label: t('command_center') },
        { to: '/projects', Icon: IconFolder, label: t('projects') },
        { to: '/team', Icon: IconUsers, label: t('team') },
      ],
    },
    {
      title: t('nav_group_work'),
      // CC-2: пункт «Задачи» убран — доска задач внутри Командного центра (/dispatch).
      items: [
        { to: '/team-calendar', Icon: IconCalendar, label: t('team_calendar') },
        { to: '/schedule', Icon: IconCalendar, label: t('schedule') },
        { to: '/map', Icon: IconMap, label: t('map') },
        { to: '/stores', Icon: IconBriefcase, label: t('stores') },
        { to: '/timeline', Icon: IconChart, label: t('timeline') },
        { to: '/messages', Icon: IconChat, label: t('messages') },
      ],
    },
    {
      title: t('more_group_finance'),
      items: [
        { to: '/sales', Icon: IconBriefcase, label: t('sales') },
        { to: '/clients', Icon: IconUsers, label: t('clients') },
        { to: '/payroll', Icon: IconMoney, label: t('payroll') },
        { to: '/documents', Icon: IconWallet, label: t('documents') },
        { to: '/reports', Icon: IconChart, label: t('reports') },
      ],
    },
    {
      title: t('nav_group_admin'),
      items: [
        { to: '/archive', Icon: IconFolder, label: t('archive') },
        { to: '/consents', Icon: IconTarget, label: t('consents') },
        { to: '/settings', Icon: IconSettings, label: t('settings'), show: isAdminOrOwner },
        { to: '/owner-settings', Icon: IconSettings, label: t('owner_settings'), show: isOwner },
      ],
    },
  ]

  return (
    <>
      <nav className="nav bottom-nav">
        {items.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={cls}>
            <span className="ico">
              <item.Icon />
              {item.to === '/messages' && unreadMessages > 0 && (
                <span className="badge red nav-unread">{unreadBadge}</span>
              )}
            </span>{item.label}
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
            {sideGroups.map((group) => (
              <section key={group.title} className="side-group">
                <h2>{group.title}</h2>
                {group.items
                  .filter((item) => item.show !== false)
                  .map((item) => (
                    <NavLink key={item.to} to={item.to} end={item.end} className={sideCls}>
                      <span className="side-ico"><item.Icon /></span>
                      <span>{item.label}</span>
                      {item.to === '/messages' && unreadMessages > 0 && (
                        <span className="badge red nav-unread">{unreadBadge}</span>
                      )}
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
