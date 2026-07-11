import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { isManagerRole } from './lib/types'
import Login from './screens/Login'
import Dashboard from './screens/Dashboard'
import CheckIn from './screens/CheckIn'
import Projects from './screens/Projects'
import Team from './screens/Team'
import MyTime from './screens/MyTime'
import More from './screens/More'
import Nav from './components/Nav'

export default function App() {
  const { loading, profile } = useAuth()
  if (loading) return <div className="spinner">…</div>
  if (!profile) return <Login />

  const manager = isManagerRole(profile.role)
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={manager ? <Dashboard /> : <CheckIn />} />
        <Route path="/checkin" element={<CheckIn />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/team" element={manager ? <Team /> : <Navigate to="/" />} />
        <Route path="/time" element={<MyTime />} />
        <Route path="/more" element={<More />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
      <Nav manager={manager} />
    </div>
  )
}
