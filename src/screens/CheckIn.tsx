import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getProjects, getTodayEvents, addTimeEvent, captureGPS, startProjectTravel } from '../lib/api'
import { shiftState, workedMs, fmtHours, fmtClock } from '../lib/time'
import type { Project, TimeEvent } from '../lib/types'

interface TravelState {
  projectId: string
  startedAt: Date
}

export default function CheckIn() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [travelBusy, setTravelBusy] = useState(false)
  const [travel, setTravel] = useState<TravelState | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [, tick] = useState(0)

  const load = async () => {
    if (!profile) return
    const [ps, evs] = await Promise.all([getProjects(), getTodayEvents(profile.id)])
    setProjects(ps)
    setEvents(evs)
  }

  useEffect(() => { load() }, [profile?.id])
  useEffect(() => {
    const i = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(i)
  }, [])

  const state = useMemo(() => shiftState(events), [events])
  const ms = useMemo(() => workedMs(events), [events, Date.now()])
  const selectedProject = useMemo(() => projects.find((p) => p.id === selected) ?? null, [projects, selected])

  const act = async (type: 'check_in' | 'check_out' | 'break_start' | 'break_end') => {
    if (!profile || busy) return
    setBusy(true)
    setMsg('gps_wait')
    const geo = await captureGPS()
    setMsg(geo.status === 'good' ? 'gps_ok' : 'gps_fail')
    try {
      const projectId = type === 'check_in' ? selected : state.projectId
      await addTimeEvent(profile, type, projectId, geo)
      await load()
      if (type === 'check_in') setTravel(null)
      setMsg('saved')
      setTimeout(() => setMsg(null), 2500)
    } catch {
      setMsg('error')
    }
    setBusy(false)
  }

  const startTravel = async (project: Project) => {
    if (!profile || travelBusy || !project.address) return
    const startedAt = new Date()
    const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(project.address)}`
    setTravel({ projectId: project.id, startedAt })
    window.open(url, '_blank')
    setTravelBusy(true)
    try {
      await startProjectTravel(profile, project, startedAt.toISOString())
    } catch {
      setMsg('error')
    } finally {
      setTravelBusy(false)
    }
  }

  const projName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? ''

  return (
    <div className="screen">
      <h1>⏱️ {t('checkin')}</h1>

      <div className="card center">
        {state.status === 'off' && <p className="muted">{t('not_on_shift')}</p>}
        {state.status !== 'off' && (
          <>
            <p className="muted">
              {state.status === 'break' ? t('on_break') : `${t('on_shift_since')} ${state.since ? fmtClock(state.since) : ''}`}
              {state.projectId ? ` · ${projName(state.projectId)}` : ''}
            </p>
            <div className="timer">{fmtHours(ms)} {t('h')}</div>
          </>
        )}
      </div>

      {state.status === 'off' && (
        <>
          <h2>{t('select_project')}</h2>
          {projects.map((p) => (
            <div key={p.id} className={`card tap ${selected === p.id ? 'selected' : ''}`} onClick={() => setSelected(p.id)}>
              <div className="row">
                <div>
                  <div style={{ fontWeight: 700 }}>{p.name}</div>
                  <div className="muted">{p.address}</div>
                </div>
                {selected === p.id && <span className="badge amber">✓</span>}
              </div>
              {selected === p.id && (
                <div className="travel-action" onClick={(e) => e.stopPropagation()}>
                  {travel?.projectId === p.id ? (
                    <p className="ok-msg">{t('travel_started')} {fmtClock(travel.startedAt.toISOString())}</p>
                  ) : (
                    <button className="btn ghost small" disabled={travelBusy || !selectedProject?.address} onClick={() => startTravel(p)}>
                      {t('travel_start')}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          <button className="btn green" style={{ marginTop: 12 }} disabled={!selected || busy} onClick={() => act('check_in')}>
            {t('check_in')}
          </button>
        </>
      )}

      {state.status === 'on' && (
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <button className="btn ghost" disabled={busy} onClick={() => act('break_start')}>{t('break_start')}</button>
          <button className="btn red" disabled={busy} onClick={() => act('check_out')}>{t('check_out')}</button>
        </div>
      )}

      {state.status === 'break' && (
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <button className="btn" disabled={busy} onClick={() => act('break_end')}>{t('break_end')}</button>
          <button className="btn red" disabled={busy} onClick={() => act('check_out')}>{t('check_out')}</button>
        </div>
      )}

      {msg && <p className={msg === 'error' ? 'error-msg' : 'ok-msg'}>{t(msg)}</p>}
    </div>
  )
}
