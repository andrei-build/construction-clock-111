import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { isManagerRole, hasFinanceAccess } from './lib/types'
// PERF-1: критический путь работника/водителя грузится сразу (вход, навигация, полевые экраны).
import Login from './screens/Login'
import CheckIn from './screens/CheckIn'
import Projects from './screens/Projects'
import Tasks from './screens/Tasks'
import Schedule from './screens/Schedule'
import DailyReports from './screens/DailyReports'
import MyTime from './screens/MyTime'
import Messages from './screens/Messages'
import DriverRoute from './screens/Route'
import More from './screens/More'
import ResetPassword from './screens/ResetPassword'
// PERF-1: тяжёлые экраны владельца/менеджера — ленивые чанки, грузятся по требованию,
// чтобы полевой работник не перекачивал их после каждого деплоя (route-splitting).
const Overview = lazy(() => import('./screens/Overview'))
const ProjectHub = lazy(() => import('./screens/ProjectHub'))
const Team = lazy(() => import('./screens/Team'))
const WorkerDetail = lazy(() => import('./screens/WorkerDetail'))
const Dispatch = lazy(() => import('./screens/Dispatch'))
const Calendar = lazy(() => import('./screens/Calendar'))
const TeamCalendar = lazy(() => import('./screens/TeamCalendar'))
const LiveMap = lazy(() => import('./screens/LiveMap'))
const Sales = lazy(() => import('./screens/Sales'))
const Reports = lazy(() => import('./screens/Reports'))
const Timeline = lazy(() => import('./screens/Timeline'))
const Archive = lazy(() => import('./screens/Archive'))
const Trash = lazy(() => import('./screens/Trash'))
const Stores = lazy(() => import('./screens/Stores'))
const Clients = lazy(() => import('./screens/Clients'))
const Gallery = lazy(() => import('./screens/Gallery'))
const Documents = lazy(() => import('./screens/Documents'))
const Files = lazy(() => import('./screens/Files'))
const Payroll = lazy(() => import('./screens/Payroll'))
const Settings = lazy(() => import('./screens/Settings'))
const Broadcast = lazy(() => import('./screens/Broadcast'))
const Mail = lazy(() => import('./screens/Mail'))
const Catalog = lazy(() => import('./screens/Catalog'))
import ScreenFallback from './components/ScreenFallback'
import Nav from './components/Nav'
import BackButton from './components/BackButton'
import { EntityDrawerProvider } from './components/EntityDrawer'
import { NotificationsProvider } from './lib/notifications'
import LocationConsentGate from './components/LocationConsentGate'
import LiveLocationPinger from './components/LiveLocationPinger'
import OfflineStatusBanner from './components/OfflineStatusBanner'
import OfflineCacheBanner from './components/OfflineCacheBanner'
import OfflineFieldSync from './components/OfflineFieldSync'
import AiCommandBar from './components/AiCommandBar'

export default function App() {
  const { loading, profile } = useAuth()
  const location = useLocation()
  // ACC-1 (b): экран восстановления пароля доступен ДО загрузки профиля —
  // по recovery-ссылке из письма профиль может ещё не подняться, а форму показать надо.
  if (location.pathname === '/reset') return <ResetPassword />
  if (loading) return <div className="spinner">…</div>
  if (!profile) return <Login />

  const manager = isManagerRole(profile.role)
  const driver = profile.role === 'driver'
  const salesOnly = profile.role === 'sales'
  const salesAccess = manager || salesOnly
  // SET-1: /settings regated to owner/admin only (plain managers/supervisors lose it).
  const adminOrOwner = profile.role === 'owner' || profile.role === 'admin'
  // AI-1-UI: «строка-командир» — только владелец (RLS ai_messages/ai_proposals гейтятся
  // app.is_owner(); у admin история пуста, а update молча затрагивает 0 строк). Оверлей + Ctrl+K
  // монтируем ниже строго для owner; кнопка «Спроси» в Nav тоже owner-only.
  const isOwner = profile.role === 'owner'
  // A2: доступ к финансам = owner/admin ИЛИ гранта finance_access. Supervisor — manager-роль,
  // но зарплату видеть НЕ должен, поэтому /payroll гейтим финансовым предикатом, а не isManagerRole.
  const financeAccess = hasFinanceAccess(profile)
  return (
    <LocationConsentGate profile={profile}>
    <EntityDrawerProvider>
    <NotificationsProvider>
      <div className={`app ${manager ? 'manager-app' : ''}`}>
        <LiveLocationPinger profile={profile} />
        <main className="app-content">
          <OfflineStatusBanner />
          <OfflineCacheBanner />
          <OfflineFieldSync />
          <BackButton />
          <Suspense fallback={<ScreenFallback />}>
          <Routes>
            {/* NAV-2 (д): продажи приземляются в свою зону, а не на полевую «Отметку».
                NAV-5: «Главная»/Dashboard убрана — менеджер с '/' уезжает в «Командный центр». */}
            <Route path="/" element={manager ? <Navigate to="/dispatch" replace /> : driver ? <DriverRoute /> : salesOnly ? <Sales /> : <CheckIn />} />
            <Route path="/overview" element={manager ? <Overview /> : <Navigate to="/" />} />
            <Route path="/route" element={manager || driver ? <DriverRoute /> : <Navigate to="/" />} />
            <Route path="/checkin" element={<CheckIn />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:id" element={<ProjectHub />} />
            <Route path="/team" element={manager ? <Team /> : <Navigate to="/" />} />
            <Route path="/team/:id" element={manager ? <WorkerDetail /> : <Navigate to="/" />} />
            {/* CC-2: standalone «Задачи» retired from manager nav. Managers now land on the
                Command Center task board; field roles (worker/driver) keep their task list. */}
            <Route path="/tasks" element={manager ? <Navigate to="/dispatch" replace /> : <Tasks />} />
            {/* CAL-3: standalone «Расписание» retired — it's now the 3rd tab of the team calendar.
                Managers redirect into that tab; non-managers (no /team-calendar access) keep the
                standalone Schedule so the role-split is preserved exactly. Old /schedule links resolve. */}
            <Route path="/schedule" element={manager ? <Navigate to="/team-calendar?tab=schedule" replace /> : <Schedule />} />
            <Route path="/dispatch" element={manager ? <Dispatch /> : <Navigate to="/" />} />
            {/* CC-2: /command-center alias for the Командный центр (/dispatch stays canonical). */}
            <Route path="/command-center" element={manager ? <Dispatch /> : <Navigate to="/" />} />
            <Route path="/calendar" element={manager ? <Calendar /> : <Navigate to="/" />} />
            <Route path="/team-calendar" element={manager ? <TeamCalendar /> : <Navigate to="/" />} />
            <Route path="/map" element={manager ? <LiveMap /> : <Navigate to="/" />} />
            <Route path="/sales" element={salesAccess ? <Sales /> : <Navigate to="/" />} />
            <Route path="/reports" element={manager ? <Reports /> : <Navigate to="/" />} />
            <Route path="/timeline" element={manager ? <Timeline /> : <Navigate to="/" />} />
            {/* SET-2 (ЗАКОН-7): standalone «Согласия» removed from nav — consents live in each
                person's dossier (/team/:id). Old /consents bookmarks redirect to the team list.
                Consents data/tables/API untouched. */}
            <Route path="/consents" element={<Navigate to="/team" replace />} />
            <Route path="/archive" element={manager ? <Archive /> : <Navigate to="/" />} />
            <Route path="/trash" element={manager ? <Trash /> : <Navigate to="/" />} />
            <Route path="/stores" element={manager ? <Stores /> : <Navigate to="/" />} />
            <Route path="/clients" element={manager ? <Clients /> : <Navigate to="/" />} />
            {/* BROADCAST-1: owner-only «Рассылка» — компонент сам рендерит дружелюбный отказ не-владельцу. */}
            <Route path="/broadcast" element={manager ? <Broadcast /> : <Navigate to="/" />} />
            <Route path="/gallery" element={manager ? <Gallery /> : <Navigate to="/" />} />
            <Route path="/documents" element={manager ? <Documents /> : <Navigate to="/" />} />
            <Route path="/files" element={manager ? <Files /> : <Navigate to="/" />} />
            <Route path="/daily" element={<DailyReports />} />
            {/* MAIL-1-UI: «Почта» — owner/admin (RLS дополнительно ограничивает чтение владельцем). */}
            <Route path="/mail" element={adminOrOwner ? <Mail /> : <Navigate to="/" />} />
            <Route path="/settings" element={adminOrOwner ? <Settings /> : <Navigate to="/" />} />
            {/* CATALOG-UI-1: «Каталог» — позиции для 3D-визуализации, manager+. */}
            <Route path="/catalog" element={manager ? <Catalog /> : <Navigate to="/" />} />
            {/* SET-2 (ЗАКОН-6): «Настройки владельца» merged into «Настройки». Old /owner-settings
                bookmarks redirect to the owner block inside /settings. A plain manager landing on
                /settings is redirected to '/' by the gate above — that's fine. */}
            <Route path="/owner-settings" element={<Navigate to="/settings#owner" replace />} />
            <Route path="/time" element={<MyTime />} />
            <Route path="/payroll" element={financeAccess ? <Payroll /> : <Navigate to="/" />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/more" element={<More />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
          </Suspense>
        </main>
        <Nav manager={manager} />
        {/* AI-1-UI: оверлей-диалог ассистента + глобальный Ctrl+K. Монтируется ТОЛЬКО владельцу;
            не автозапускается (open=false), поэтому не влияет на прочие экраны/e2e. */}
        {isOwner && <AiCommandBar profile={profile} />}
      </div>
    </NotificationsProvider>
    </EntityDrawerProvider>
    </LocationConsentGate>
  )
}
