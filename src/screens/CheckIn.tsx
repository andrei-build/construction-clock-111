import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getProjects, getTodayEvents, addTimeEvent, captureGPS, startProjectTravel } from '../lib/api'
import {
  flushQueuedTimeEvents,
  getQueuedTimeEvents,
  queuedTimeEventToTimeEvent,
  queueTimeEvent,
  type QueuedTimeEvent,
} from '../lib/offlineTimeQueue'
import { shiftState, workedMs, fmtHours, fmtClock } from '../lib/time'
import type { Project, TimeEvent } from '../lib/types'

interface TravelState {
  projectId: string
  startedAt: Date
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine
}

function isNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /failed to fetch|networkerror|network|fetch|load failed/i.test(message)
}

function messageClass(msg: string) {
  if (msg === 'error') return 'error-msg'
  if (msg === 'offline_saved') return 'warn-msg'
  return 'ok-msg'
}

export default function CheckIn() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [queued, setQueued] = useState<QueuedTimeEvent[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [travelBusy, setTravelBusy] = useState(false)
  const [travel, setTravel] = useState<TravelState | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const syncRef = useRef(false)
  const [, tick] = useState(0)

  const load = useCallback(async () => {
    if (!profile) return
    try {
      const [ps, evs] = await Promise.all([getProjects(), getTodayEvents(profile.id)])
      setProjects(ps)
      setEvents(evs)
    } catch {
      // Offline check-in can continue with the last in-memory state and the durable queue.
    }
    setQueued(await getQueuedTimeEvents(profile.id))
  }, [profile])

  const syncQueue = useCallback(async () => {
    if (!profile || syncRef.current || !isOnline()) return
    syncRef.current = true
    setSyncing(true)
    try {
      await flushQueuedTimeEvents(profile, (sent) => {
        setQueued((rows) => rows.filter((row) => row.id !== sent.id))
      })
      await load()
    } catch {
      setMsg('offline_saved')
    } finally {
      syncRef.current = false
      setSyncing(false)
    }
  }, [load, profile])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const i = setInterval(() => tick((x) => x + 1), 1000)
    return () => clearInterval(i)
  }, [])
  useEffect(() => {
    window.addEventListener('online', syncQueue)
    return () => window.removeEventListener('online', syncQueue)
  }, [syncQueue])
  useEffect(() => {
    if (queued.length > 0 && isOnline()) syncQueue()
  }, [queued.length, syncQueue])

  const visibleEvents = useMemo(() => (
    [...events, ...queued.map(queuedTimeEventToTimeEvent)]
      .sort((a, b) => a.event_time.localeCompare(b.event_time))
  ), [events, queued])
  const state = useMemo(() => shiftState(visibleEvents), [visibleEvents])
  const ms = useMemo(() => workedMs(visibleEvents), [visibleEvents, Date.now()])
  const selectedProject = useMemo(() => projects.find((p) => p.id === selected) ?? null, [projects, selected])

  const act = async (type: 'check_in' | 'check_out' | 'break_start' | 'break_end') => {
    if (!profile || busy) return
    if (type === 'check_in' && !selected) return
    setBusy(true)
    setMsg('gps_wait')
    const geo = await captureGPS()
    setMsg(geo.status === 'good' ? 'gps_ok' : 'gps_fail')
    const projectId = type === 'check_in' ? selected : state.projectId
    const saveOffline = async () => {
      const row = await queueTimeEvent(profile, type, projectId, geo)
      setQueued((rows) => [...rows.filter((item) => item.id !== row.id), row].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)))
      if (type === 'check_in') setTravel(null)
      setMsg('offline_saved')
    }

    try {
      if (!isOnline()) {
        await saveOffline()
        return
      }
      await addTimeEvent(profile, type, projectId, geo)
      await load()
      if (type === 'check_in') setTravel(null)
      setMsg('saved')
      setTimeout(() => setMsg(null), 2500)
    } catch (error) {
      if (isNetworkError(error)) await saveOffline()
      else setMsg('error')
    } finally {
      setBusy(false)
    }
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

      {queued.length > 0 && (
        <div className="offline-queue">
          <span className={`offline-dot ${syncing ? 'syncing' : ''}`} />
          <div>
            <div className="offline-title">{syncing ? t('offline_queue_sending') : t('offline_saved')}</div>
            <div className="muted">{t('queued_marks')}: {queued.length}</div>
          </div>
        </div>
      )}

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

      {msg && <p className={messageClass(msg)}>{t(msg)}</p>}
    </div>
  )
}
