import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { isManagerRole, hasFinanceAccess } from './lib/types'
import Login from './screens/Login'
import Dashboard from './screens/Dashboard'
import Overview from './screens/Overview'
import CheckIn from './screens/CheckIn'
import Projects from './screens/Projects'
import ProjectHub from './screens/ProjectHub'
import Team from './screens/Team'
import Tasks from './screens/Tasks'
import Schedule from './screens/Schedule'
import WorkerDetail from './screens/WorkerDetail'
import Dispatch from './screens/Dispatch'
import Calendar from './screens/Calendar'
import TeamCalendar from './screens/TeamCalendar'
import LiveMap from './screens/LiveMap'
import Sales from './screens/Sales'
import Reports from './screens/Reports'
import Timeline from './screens/Timeline'
import Consents from './screens/Consents'
import Archive from './screens/Archive'
import Trash from './screens/Trash'
import Stores from './screens/Stores'
import Clients from './screens/Clients'
import Gallery from './screens/Gallery'
import Documents from './screens/Documents'
import Files from './screens/Files'
import DailyReports from './screens/DailyReports'
import MyTime from './screens/MyTime'
import Payroll from './screens/Payroll'
import Messages from './screens/Messages'
import DriverRoute from './screens/Route'
import More from './screens/More'
import Settings from './screens/Settings'
import OwnerSettings from './screens/OwnerSettings'
import Nav from './components/Nav'
import BackButton from './components/BackButton'
import { EntityDrawerProvider } from './components/EntityDrawer'
import LocationConsentGate from './components/LocationConsentGate'
import LiveLocationPinger from './components/LiveLocationPinger'
import OfflineStatusBanner from './components/OfflineStatusBanner'
import OfflineFieldSync from './components/OfflineFieldSync'

export default function App() {
  const { loading, profile } = useAuth()
  if (loading) return <div className="spinner">…</div>
  if (!profile) return <Login />

  const manager = isManagerRole(profile.role)
  const driver = profile.role === 'driver'
  const salesOnly = profile.role === 'sales'
  const salesAccess = manager || salesOnly
  // SET-1: /settings regated to owner/admin only (plain managers/supervisors lose it).
  const adminOrOwner = profile.role === 'owner' || profile.role === 'admin'
  // A2: доступ к финансам = owner/admin ИЛИ гранта finance_access. Supervisor — manager-роль,
  // но зарплату видеть НЕ должен, поэтому /payroll гейтим финансовым предикатом, а не isManagerRole.
  const financeAccess = hasFinanceAccess(profile)
  return (
    <LocationConsentGate profile={profile}>
    <EntityDrawerProvider>
      <div className={`app ${manager ? 'manager-app' : ''}`}>
        <LiveLocationPinger profile={profile} />
        <main className="app-content">
          <OfflineStatusBanner />
          <OfflineFieldSync />
          <BackButton />
          <Routes>
            {/* NAV-2 (д): продажи приземляются в свою зону, а не на полевую «Отметку». */}
            <Route path="/" element={manager ? <Dashboard /> : driver ? <DriverRoute /> : salesOnly ? <Sales /> : <CheckIn />} />
            <Route path="/overview" element={manager ? <Overview /> : <Navigate to="/" />} />
            <Route path="/route" element={manager || driver ? <DriverRoute /> : <Navigate to="/" />} />
            <Route path="/checkin" element={<CheckIn />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:id" element={<ProjectHub />} />
            <Route path="/team" element={manager ? <Team /> : <Navigate to="/" />} />
            <Route path="/team/:id" element={manager ? <WorkerDetail /> : <Navigate to="/" />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/dispatch" element={manager ? <Dispatch /> : <Navigate to="/" />} />
            <Route path="/calendar" element={manager ? <Calendar /> : <Navigate to="/" />} />
            <Route path="/team-calendar" element={manager ? <TeamCalendar /> : <Navigate to="/" />} />
            <Route path="/map" element={manager ? <LiveMap /> : <Navigate to="/" />} />
            <Route path="/sales" element={salesAccess ? <Sales /> : <Navigate to="/" />} />
            <Route path="/reports" element={manager ? <Reports /> : <Navigate to="/" />} />
            <Route path="/timeline" element={manager ? <Timeline /> : <Navigate to="/" />} />
            <Route path="/consents" element={manager ? <Consents /> : <Navigate to="/" />} />
            <Route path="/archive" element={manager ? <Archive /> : <Navigate to="/" />} />
            <Route path="/trash" element={manager ? <Trash /> : <Navigate to="/" />} />
            <Route path="/stores" element={manager ? <Stores /> : <Navigate to="/" />} />
            <Route path="/clients" element={manager ? <Clients /> : <Navigate to="/" />} />
            <Route path="/gallery" element={manager ? <Gallery /> : <Navigate to="/" />} />
            <Route path="/documents" element={manager ? <Documents /> : <Navigate to="/" />} />
            <Route path="/files" element={manager ? <Files /> : <Navigate to="/" />} />
            <Route path="/daily" element={<DailyReports />} />
            <Route path="/settings" element={adminOrOwner ? <Settings /> : <Navigate to="/" />} />
            {/* SET-1: owner-only page renders its own friendly denied note for non-owners (no crash). */}
            <Route path="/owner-settings" element={<OwnerSettings />} />
            <Route path="/time" element={<MyTime />} />
            <Route path="/payroll" element={financeAccess ? <Payroll /> : <Navigate to="/" />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/more" element={<More />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
        <Nav manager={manager} />
      </div>
    </EntityDrawerProvider>
    </LocationConsentGate>
  )
}
