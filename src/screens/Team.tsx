import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getTeam, getTodayEvents, createWorker, setWorkerCheckoutVideo } from '../lib/api'
import { workedMs, fmtHours, shiftState } from '../lib/time'
import { buildWorkerDisambiguationMap } from '../lib/worker-utils'
import { canAssignRole, isManagerWrite, type Profile, type Role, type TimeEvent } from '../lib/types'
import { useEntityDrawer } from '../components/EntityDrawer'

export default function Team() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const { openWorker } = useEntityDrawer()
  const navigate = useNavigate()
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

  // F16: same-name workers get a role / id suffix so the list stays tellable-apart.
  const workerLabels = useMemo(() => buildWorkerDisambiguationMap(team), [team])

  const onShiftCount = useMemo(
    () => team.filter((w) => shiftState(byWorker.get(w.id) ?? []).status !== 'off').length,
    [team, byWorker],
  )

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

  const canManage = profile ? isManagerWrite(profile.role) : false

  // F3: гейт создания работника — предлагаем только роли, которые актёр вправе назначить.
  // Плоский менеджер не увидит driver (его выдают только owner/admin) и не создаст роль >= своей.
  const addRoleOptions: Role[] = ['worker', 'driver', 'supervisor', 'manager', 'subcontractor']
  const creatableRoles = addRoleOptions.filter((r) => (profile ? canAssignRole(profile.role, r) : false))

  const toggleCheckoutVideo = async (worker: Profile) => {
    if (!profile) return
    const next = !worker.require_checkout_video
    // Optimistic: a DB trigger reverts self-changes by non-managers, so we roll back on error.
    setTeam((rows) => rows.map((r) => (r.id === worker.id ? { ...r, require_checkout_video: next } : r)))
    try {
      await setWorkerCheckoutVideo(profile, worker.id, next)
    } catch {
      setTeam((rows) => rows.map((r) => (r.id === worker.id ? { ...r, require_checkout_video: worker.require_checkout_video } : r)))
      setMsg('checkout_video_toggle_failed')
    }
  }

  return (
    <div className="screen">
      <h1>👷 {t('team')}</h1>

      <div className="card pulse-summary" style={{ fontWeight: 700 }}>
        <span className={`badge ${onShiftCount > 0 ? 'green' : 'grey'}`}>●</span>{' '}
        {t('team_pulse_label')}: {t('on_shift')} {onShiftCount} {t('team_pulse_of')} {team.length}
      </div>

      {!adding && <button className="btn ghost small" onClick={() => setAdding(true)}>+ {t('add_worker')}</button>}
      {adding && (
        <form onSubmit={submit} className="card">
          <label>{t('name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>{t('pin')}</label>
          <input value={pin} inputMode="numeric" pattern="[0-9]*" onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          <label>{t('role')}</label>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {creatableRoles.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
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
              <button className="inline-link item-title" onClick={() => openWorker(w)}>{workerLabels.get(w.id) ?? w.name}</button>
              <span className={`badge ${roleBadge(w.role)}`}>{w.role}</span>
            </div>
            <div className="center">
              <div style={{ fontWeight: 700 }}>{fmtHours(workedMs(evs))}{t('h')}</div>
              {st.status !== 'off' && <span className="badge green">●</span>}
              {canManage && (
                <label className="checkout-video-toggle" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(w.require_checkout_video)}
                    onChange={() => toggleCheckoutVideo(w)}
                  />
                  <span className="muted">{t('checkout_video_required')}</span>
                </label>
              )}
              <button className="btn ghost small team-details-btn" onClick={() => navigate(`/team/${w.id}`)}>
                {t('details')}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
