import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getTeam, getTodayEvents, createWorker } from '../lib/api'
import { workedMs, fmtHours, shiftState } from '../lib/time'
import type { Profile, TimeEvent } from '../lib/types'
import { useEntityDrawer } from '../components/EntityDrawer'

export default function Team() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const { openWorker } = useEntityDrawer()
  const [team, setTeam] = useState<Profile[]>([])
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [role, setRole] = useState('worker')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const load = () => Promise.all([getTeam(), getTodayEvents()]).then(([tm, e]) => { setTeam(tm); setEvents(e) })
  useEffect(() => { load() }, [profile?.id])

  const byWorker = useMemo(() => {
    const m = new Map<string, TimeEvent[]>()
    for (const e of events) {
      if (!m.has(e.profile_id)) m.set(e.profile_id, [])
      m.get(e.profile_id)!.push(e)
    }
    return m
  }, [events])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setMsg(null)
    const r = await createWorker(name.trim(), pin.trim(), role)
    if (r.ok) { setMsg('worker_created'); setName(''); setPin(''); setAdding(false); await load() }
    else setMsg(r.error ?? 'error')
    setBusy(false)
  }

  const roleBadge = (r: string) =>
    r === 'owner' || r === 'admin' ? 'red' : r === 'manager' || r === 'supervisor' ? 'amber' : r === 'driver' ? 'blue' : 'green'

  return (
    <div className="screen">
      <h1>👷 {t('team')}</h1>

      {!adding && <button className="btn ghost small" onClick={() => setAdding(true)}>+ {t('add_worker')}</button>}
      {adding && (
        <form onSubmit={submit} className="card">
          <label>{t('name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>{t('pin')}</label>
          <input value={pin} inputMode="numeric" pattern="[0-9]*" onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          <label>{t('role')}</label>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="worker">worker</option>
            <option value="driver">driver</option>
            <option value="supervisor">supervisor</option>
            <option value="manager">manager</option>
            <option value="subcontractor">subcontractor</option>
          </select>
          <button className="btn" disabled={busy || !name.trim() || pin.length < 4}>{t('create')}</button>
        </form>
      )}
      {msg && <p className={msg === 'worker_created' ? 'ok-msg' : 'error-msg'}>{t(msg)}</p>}

      {team.map((w) => {
        const evs = byWorker.get(w.id) ?? []
        const st = shiftState(evs)
        return (
          <div key={w.id} className="card row">
            <div>
              <button className="inline-link item-title" onClick={() => openWorker(w)}>{w.name}</button>
              <span className={`badge ${roleBadge(w.role)}`}>{w.role}</span>
            </div>
            <div className="center">
              <div style={{ fontWeight: 700 }}>{fmtHours(workedMs(evs))}{t('h')}</div>
              {st.status !== 'off' && <span className="badge green">●</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
