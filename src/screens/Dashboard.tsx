import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  getTodayEvents,
  getTeam,
  getProjects,
  getOpenTasks,
  getRecentActivity,
  getDonePhotoTasks,
  getTaskPhotoIds,
  getVisibleProfileRates,
  getSuspiciousShifts,
  approveShiftReview,
} from '../lib/api'
import { shiftState, workedMs, fmtHours, fmtClock } from '../lib/time'
import { isManagerWrite } from '../lib/types'
import type { Profile, Project, TimeEvent, Task, EventRow, ProfileRate, SuspiciousShift } from '../lib/types'
import { useEntityDrawer } from '../components/EntityDrawer'

type Risk = {
  id: string
  tone: 'amber' | 'red' | 'blue'
  title: string
  detail: string
}

const TEN_HOURS_MS = 10 * 60 * 60 * 1000

export default function Dashboard() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const { openWorker, openProject } = useEntityDrawer()
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [donePhotoTasks, setDonePhotoTasks] = useState<Task[]>([])
  const [photoTaskIds, setPhotoTaskIds] = useState<Set<string>>(new Set())
  const [rates, setRates] = useState<ProfileRate[]>([])
  const [activity, setActivity] = useState<EventRow[]>([])
  const [suspicious, setSuspicious] = useState<SuspiciousShift[]>([])
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const canReviewShifts = profile ? isManagerWrite(profile.role) : false

  useEffect(() => {
    if (!profile) return
    let mounted = true

    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [e, tm, p, tk, a, doneTk, visibleRates] = await Promise.all([
          getTodayEvents(),
          getTeam(),
          getProjects(),
          getOpenTasks(),
          getRecentActivity(),
          getDonePhotoTasks(),
          getVisibleProfileRates(),
        ])
        const photoIds = await getTaskPhotoIds(doneTk.map((task) => task.id))
        const susp = canReviewShifts ? await getSuspiciousShifts() : []
        if (!mounted) return
        setEvents(e)
        setTeam(tm)
        setProjects(p)
        setTasks(tk)
        setActivity(a)
        setDonePhotoTasks(doneTk)
        setPhotoTaskIds(photoIds)
        setRates(visibleRates)
        setSuspicious(susp)
      } catch {
        if (mounted) setError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    }

    load()
    const i = setInterval(() => {
      setNow(Date.now())
      getTodayEvents().then(setEvents).catch(() => setError(true))
    }, 30000)
    return () => { mounted = false; clearInterval(i) }
  }, [profile?.id])

  const byWorker = useMemo(() => {
    const m = new Map<string, TimeEvent[]>()
    for (const e of events) {
      if (!m.has(e.profile_id)) m.set(e.profile_id, [])
      m.get(e.profile_id)!.push(e)
    }
    return m
  }, [events])

  const onSite = useMemo(() => {
    return team.filter((w) => {
      const evs = byWorker.get(w.id) ?? []
      return evs.length > 0 && shiftState(evs).status !== 'off'
    })
  }, [team, byWorker])

  const totalMs = useMemo(
    () => Array.from(byWorker.values()).reduce((acc, evs) => acc + workedMs(evs, now), 0),
    [byWorker, now],
  )

  const rateByWorker = useMemo(() => {
    const m = new Map<string, number>()
    for (const rate of rates) {
      if (rate.hourly_rate !== null) m.set(rate.profile_id, Number(rate.hourly_rate))
    }
    return m
  }, [rates])

  const payDue = useMemo(() => {
    if (rateByWorker.size === 0) return null
    return Array.from(byWorker.entries()).reduce((acc, [workerId, evs]) => {
      const rate = rateByWorker.get(workerId)
      if (!rate) return acc
      return acc + (workedMs(evs, now) / 3600000) * rate
    }, 0)
  }, [byWorker, now, rateByWorker])

  const projectFor = (id: string | null) => projects.find((p) => p.id === id) ?? null
  const projectName = (id: string | null) => projectFor(id)?.name ?? t('unknown_project')

  const fmtHm = (hours: number) => {
    const total = Math.round((Number(hours) || 0) * 60)
    return `${Math.floor(total / 60)}${t('h')} ${total % 60}${t('min_short')}`
  }

  async function approveShift(s: SuspiciousShift) {
    if (!profile || approvingId) return
    setApprovingId(s.checkout_event_id)
    try {
      await approveShiftReview(profile, s.checkout_event_id)
      const fresh = await getSuspiciousShifts()
      setSuspicious(fresh)
    } catch {
      setError(true)
    } finally {
      setApprovingId(null)
    }
  }

  const risks = useMemo<Risk[]>(() => {
    const items: Risk[] = []

    for (const worker of team) {
      const evs = byWorker.get(worker.id) ?? []
      if (evs.length === 0) continue

      const sorted = [...evs].sort((a, b) => a.event_time.localeCompare(b.event_time))
      const last = sorted[sorted.length - 1]
      const state = shiftState(sorted)

      if (state.status !== 'off' && state.since && now - new Date(state.since).getTime() > TEN_HOURS_MS) {
        items.push({
          id: `long-${worker.id}`,
          tone: 'amber',
          title: t('risk_open_shift_long'),
          detail: `${worker.name} · ${projectName(state.projectId)} · ${fmtHours(workedMs(evs, now))}${t('h')}`,
        })
      }

      if (last?.gps_status && last.gps_status !== 'good') {
        items.push({
          id: `gps-${worker.id}-${last.id}`,
          tone: 'blue',
          title: t('risk_gps_attention'),
          detail: `${worker.name} · ${last.gps_status}`,
        })
      }
    }

    for (const task of donePhotoTasks) {
      if (!photoTaskIds.has(task.id)) {
        items.push({
          id: `photo-${task.id}`,
          tone: 'red',
          title: t('risk_task_without_photo'),
          detail: `${task.title} · ${projectName(task.project_id)}`,
        })
      }
    }

    return items
  }, [byWorker, donePhotoTasks, photoTaskIds, team, now, projects])

  const nextTask = useMemo(() => {
    const score = { urgent: 4, high: 3, medium: 2, low: 1 }
    return [...tasks].sort((a, b) => score[b.priority] - score[a.priority])[0] ?? null
  }, [tasks])

  const money = (value: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)

  const tiles = [
    { label: t('on_site_now'), value: String(onSite.length), tone: onSite.length > 0 ? 'green' : 'grey' },
    { label: t('hours_today'), value: fmtHours(totalMs), tone: totalMs > 0 ? 'blue' : 'grey' },
    { label: t('pay_due'), value: payDue === null ? '—' : money(payDue), tone: payDue === null ? 'grey' : 'green', note: payDue === null ? t('finance_locked') : '' },
    { label: t('requires_attention'), value: String(risks.length), tone: risks.length > 0 ? 'amber' : 'green' },
    { label: t('tasks'), value: String(tasks.length), tone: tasks.length > 0 ? 'blue' : 'grey' },
  ]

  if (loading) {
    return (
      <div className="screen dashboard-screen">
        <h1>{t('command_center')}</h1>
        <div className="card center muted">{t('loading')}</div>
      </div>
    )
  }

  return (
    <div className="screen dashboard-screen">
      <h1>{t('command_center')}</h1>
      {error && <p className="error-msg">{t('load_error')}</p>}

      <div className="dashboard-tiles">
        {tiles.map((tile) => (
          <div key={tile.label} className={`card metric-card ${tile.tone}`}>
            <div className="metric-value">{tile.value}</div>
            <div className="muted">{tile.label}</div>
            {tile.note && <div className="metric-note">{tile.note}</div>}
          </div>
        ))}
      </div>

      <div className="dashboard-panels">
        <section className="card command-card">
          <h2>{t('dashboard_now')}</h2>
          <div className="command-value">{onSite.length > 0 ? `${onSite.length} · ${t('on_shift')}` : t('nobody_on_site')}</div>
          <div className="muted inline-list">
            {onSite.length === 0 && t('all_clear')}
            {onSite.slice(0, 3).map((w) => (
              <button key={w.id} className="inline-link" onClick={() => openWorker(w)}>{w.name}</button>
            ))}
          </div>
        </section>

        <section className="card command-card">
          <h2>{t('dashboard_risks')}</h2>
          <div className={`command-value ${risks.length > 0 ? 'attention' : 'ok'}`}>
            {risks.length > 0 ? `${risks.length} · ${t('requires_attention')}` : t('no_risks')}
          </div>
          <p className="muted">{risks[0]?.detail ?? t('all_clear')}</p>
        </section>

        <section className="card command-card">
          <h2>{t('dashboard_next_step')}</h2>
          <div className="command-value">{nextTask ? nextTask.title : t('next_no_tasks')}</div>
          <p className="muted">
            {nextTask && projectFor(nextTask.project_id) ? (
              <button className="inline-link" onClick={() => openProject(projectFor(nextTask.project_id)!)}>{projectName(nextTask.project_id)}</button>
            ) : t('all_clear')}
          </p>
        </section>
      </div>

      {canReviewShifts && (
        <section className="card review-card">
          <h2 className="review-title">{t('suspicious_shifts_title')}</h2>
          {suspicious.length === 0 ? (
            <div className="muted">{t('suspicious_none')}</div>
          ) : (
            suspicious.map((s) => (
              <div key={s.checkout_event_id} className="review-row">
                <div className="review-main">
                  <button className="inline-link item-title" onClick={() => { const w = team.find((x) => x.id === s.profile_id); if (w) openWorker(w) }}>{s.name}</button>
                  <div className="muted">{s.project_name ?? t('unknown_project')}</div>
                  <div className="muted">
                    {new Date(s.started_at).toLocaleDateString()} · {fmtClock(s.started_at)}–{fmtClock(s.ended_at)} · {fmtHm(s.hours)}
                  </div>
                  <div className="review-chips">
                    {s.too_long && <span className="badge amber">{t('chip_too_long')}</span>}
                    {s.gps_issue && <span className="badge red">{t('chip_no_gps')}</span>}
                    {s.time_gap_issue && <span className="badge red">{t('chip_time_gap')}</span>}
                  </div>
                </div>
                <div className="review-action">
                  {s.review_status === 'approved' ? (
                    <span className="badge green">{t('chip_reviewed')}</span>
                  ) : (
                    <>
                      <span className="badge red">{t('chip_needs_review')}</span>
                      <button className="btn small" disabled={approvingId === s.checkout_event_id} onClick={() => approveShift(s)}>
                        {t('mark_reviewed')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </section>
      )}

      <section className="card pulse-card">
        <h2>{t('shift_pulse_title')}</h2>
        {onSite.length === 0 ? (
          <div className="muted">{t('shift_pulse_empty')}</div>
        ) : (
          onSite.map((w) => {
            const st = shiftState(byWorker.get(w.id) ?? [])
            return (
              <div key={w.id} className="pulse-row muted">
                <b>{w.name}</b> — {projectName(st.projectId)}{st.since ? ` — ${t('pulse_since')} ${fmtClock(st.since)}` : ''}
              </div>
            )
          })
        )}
      </section>

      <div className="dashboard-columns">
        <section>
          <h2>{t('dashboard_risks')}</h2>
          {risks.length === 0 && <div className="card muted">{t('no_risks')}</div>}
          {risks.map((risk) => (
            <div key={risk.id} className="card risk-row">
              <span className={`status-dot ${risk.tone}`} />
              <div>
                <div className="item-title">{risk.title}</div>
                <div className="muted">{risk.detail}</div>
              </div>
            </div>
          ))}
        </section>

        <section>
          <h2>{t('on_site_now')}</h2>
          {onSite.length === 0 && <div className="card muted">{t('nobody_on_site')}</div>}
          {onSite.map((w) => {
            const evs = byWorker.get(w.id) ?? []
            const st = shiftState(evs)
            return (
              <div key={w.id} className="card row dashboard-row">
                <div>
                  <button className="inline-link item-title" onClick={() => openWorker(w)}>{w.name}</button>
                  <div className="muted">
                    {projectFor(st.projectId) ? (
                      <button className="inline-link" onClick={() => openProject(projectFor(st.projectId)!)}>{projectName(st.projectId)}</button>
                    ) : projectName(st.projectId)}
                  </div>
                </div>
                <span className={`badge ${st.status === 'break' ? 'amber' : 'green'}`}>
                  {st.status === 'break' ? t('on_break') : `${fmtHours(workedMs(evs, now))}${t('h')}`}
                </span>
              </div>
            )
          })}
        </section>

        <section>
          <h2>{t('recent_activity')}</h2>
          {activity.length === 0 && <div className="card muted">{t('no_activity')}</div>}
          {activity.map((a) => (
            <div key={a.id} className="feed-item">
              <div><b>{a.actor_name ?? '—'}</b> · {a.event_type}</div>
              <div className="when">{new Date(a.created_at).toLocaleString()}</div>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
