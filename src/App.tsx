import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { isManagerRole } from './lib/types'
import Login from './screens/Login'
import Dashboard from './screens/Dashboard'
import CheckIn from './screens/CheckIn'
import Projects from './screens/Projects'
import Team from './screens/Team'
import WorkerDetail from './screens/WorkerDetail'
import Dispatch from './screens/Dispatch'
import Calendar from './screens/Calendar'
import LiveMap from './screens/LiveMap'
import Sales from './screens/Sales'
import Reports from './screens/Reports'
import Timeline from './screens/Timeline'
import Consents from './screens/Consents'
import Archive from './screens/Archive'
import MyTime from './screens/MyTime'
import Payroll from './screens/Payroll'
import Messages from './screens/Messages'
import More from './screens/More'
import Nav from './components/Nav'
import { EntityDrawerProvider } from './components/EntityDrawer'
import LocationConsentGate from './components/LocationConsentGate'

export default function App() {
  const { loading, profile } = useAuth()
  if (loading) return <div className="spinner">…</div>
  if (!profile) return <Login />

  const manager = isManagerRole(profile.role)
  const salesAccess = manager || profile.role === 'sales'
  return (
    <LocationConsentGate profile={profile}>
    <EntityDrawerProvider>
      <div className={`app ${manager ? 'manager-app' : ''}`}>
        <main className="app-content">
          <Routes>
            <Route path="/" element={manager ? <Dashboard /> : <CheckIn />} />
            <Route path="/checkin" element={<CheckIn />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/team" element={manager ? <Team /> : <Navigate to="/" />} />
            <Route path="/team/:id" element={manager ? <WorkerDetail /> : <Navigate to="/" />} />
            <Route path="/dispatch" element={manager ? <Dispatch /> : <Navigate to="/" />} />
            <Route path="/calendar" element={manager ? <Calendar /> : <Navigate to="/" />} />
            <Route path="/map" element={manager ? <LiveMap /> : <Navigate to="/" />} />
            <Route path="/sales" element={salesAccess ? <Sales /> : <Navigate to="/" />} />
            <Route path="/reports" element={manager ? <Reports /> : <Navigate to="/" />} />
            <Route path="/timeline" element={manager ? <Timeline /> : <Navigate to="/" />} />
            <Route path="/consents" element={manager ? <Consents /> : <Navigate to="/" />} />
            <Route path="/archive" element={manager ? <Archive /> : <Navigate to="/" />} />
            <Route path="/time" element={<MyTime />} />
            <Route path="/payroll" element={manager ? <Payroll /> : <Navigate to="/" />} />
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
