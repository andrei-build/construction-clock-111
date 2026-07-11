import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getTodayEvents, getTeam, getProjects, getOpenTasks, getRecentActivity } from '../lib/api'
import { shiftState, workedMs, fmtHours } from '../lib/time'
import type { Profile, Project, TimeEvent, Task, EventRow } from '../lib/types'

export default function Dashboard() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [activity, setActivity] = useState<EventRow[]>([])

  useEffect(() => {
    if (!profile) return
    Promise.all([getTodayEvents(), getTeam(), getProjects(), getOpenTasks(), getRecentActivity()])
      .then(([e, tm, p, tk, a]) => { setEvents(e); setTeam(tm); setProjects(p); setTasks(tk); setActivity(a) })
    const i = setInterval(() => getTodayEvents().then(setEvents), 30000)
    return () => clearInterval(i)
  }, [profile?.id])

  const byWorker = useMemo(() => {
    const m = new Map<string, TimeEvent[]>()
    for (const e of events) {
      if (!m.has(e.profile_id)) m.set(e.profile_id, [])
      m.get(e.profile_id)!.push(e)
    }
    return m
  }, [events])

  const onSite = useMemo(() =>
    team.filter((w) => {
      const evs = byWorker.get(w.id) ?? []
      return evs.length > 0 && shiftState(evs).status !== 'off'
    }), [team, byWorker])

  const totalMs = useMemo(
    () => Array.from(byWorker.values()).reduce((acc, evs) => acc + workedMs(evs), 0),
    [byWorker],
  )

  const projName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? '—'

  return (
    <div className="screen">
      <h1>📊 {t('dashboard')}</h1>

      <div className="grid2">
        <div className="card center">
          <div className="big">{onSite.length}</div>
          <div className="muted">{t('on_site_now')}</div>
        </div>
        <div className="card center">
          <div className="big">{fmtHours(totalMs)}</div>
          <div className="muted">{t('hours_today')}</div>
        </div>
        <div className="card center">
          <div className="big">{projects.length}</div>
          <div className="muted">{t('active_projects')}</div>
        </div>
        <div className="card center">
          <div className="big">{tasks.length}</div>
          <div className="muted">{t('open_tasks')}</div>
        </div>
      </div>

      <h2>{t('on_site_now')}</h2>
      {onSite.length === 0 && <p className="muted">{t('nobody_on_site')}</p>}
      {onSite.map((w) => {
        const st = shiftState(byWorker.get(w.id) ?? [])
        return (
          <div key={w.id} className="card row">
            <div>
              <div style={{ fontWeight: 700 }}>{w.name}</div>
              <div className="muted">{projName(st.projectId)}</div>
            </div>
            <span className={`badge ${st.status === 'break' ? 'amber' : 'green'}`}>
              {st.status === 'break' ? t('on_break') : fmtHours(workedMs(byWorker.get(w.id) ?? [])) + t('h')}
            </span>
          </div>
        )
      })}

      <h2>{t('recent_activity')}</h2>
      {activity.map((a) => (
        <div key={a.id} className="feed-item">
          <div><b>{a.actor_name ?? '—'}</b> · {a.event_type}</div>
          <div className="when">{new Date(a.created_at).toLocaleString()}</div>
        </div>
      ))}
    </div>
  )
}
