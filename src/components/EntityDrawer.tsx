import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../lib/i18n'
import {
  getEventsSince,
  getOpenTasks,
  getProjectProfit,
  getProjectRecentPhotos,
  getProjects,
  getRecentActivityForActor,
  getTeam,
  getTodayEvents,
} from '../lib/api'
import { fmtHours, shiftState, weekStartISO, workedMs } from '../lib/time'
import type { EventRow, Profile, Project, ProjectPhoto, ProjectProfit, Task, TimeEvent } from '../lib/types'

type DrawerState =
  | { type: 'worker'; worker: Profile }
  | { type: 'project'; project: Project }
  | null

interface EntityDrawerApi {
  openWorker: (worker: Profile) => void
  openProject: (project: Project) => void
}

const EntityDrawerCtx = createContext<EntityDrawerApi>({
  openWorker: () => {},
  openProject: () => {},
})

export const useEntityDrawer = () => useContext(EntityDrawerCtx)

export function EntityDrawerProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [drawer, setDrawer] = useState<DrawerState>(null)
  const close = () => setDrawer(null)

  return (
    <EntityDrawerCtx.Provider value={{
      openWorker: (worker) => setDrawer({ type: 'worker', worker }),
      openProject: (project) => setDrawer({ type: 'project', project }),
    }}>
      {children}
      {drawer && (
        <>
          <div className="entity-drawer-backdrop" onClick={close} />
          <aside className="entity-drawer" aria-modal="true" role="dialog">
            <button className="drawer-close" aria-label={t('close')} onClick={close}>×</button>
            {drawer.type === 'worker' ? (
              <WorkerPanel
                worker={drawer.worker}
                close={close}
                openProject={(project) => setDrawer({ type: 'project', project })}
              />
            ) : (
              <ProjectPanel
                project={drawer.project}
                close={close}
                openWorker={(worker) => setDrawer({ type: 'worker', worker })}
              />
            )}
          </aside>
        </>
      )}
    </EntityDrawerCtx.Provider>
  )
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'CC'
}

function roleTone(role: string) {
  return role === 'owner' || role === 'admin' ? 'red' : role === 'manager' || role === 'supervisor' ? 'amber' : role === 'driver' ? 'blue' : 'green'
}

function ActivityList({ rows }: { rows: EventRow[] }) {
  const { t } = useI18n()
  if (rows.length === 0) return <div className="muted">{t('no_activity')}</div>
  return (
    <div className="drawer-feed">
      {rows.map((event) => (
        <div className="feed-item" key={event.id}>
          <div>{event.event_type}</div>
          <div className="when">{new Date(event.created_at).toLocaleString()}</div>
        </div>
      ))}
    </div>
  )
}

function WorkerPanel({ worker, close, openProject }: {
  worker: Profile
  close: () => void
  openProject: (project: Project) => void
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [todayEvents, setTodayEvents] = useState<TimeEvent[]>([])
  const [weekEvents, setWeekEvents] = useState<TimeEvent[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [activity, setActivity] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [today, week, projectRows, activityRows] = await Promise.all([
          getTodayEvents(worker.id),
          getEventsSince(weekStartISO(), worker.id),
          getProjects(),
          getRecentActivityForActor(worker.id, worker.name),
        ])
        if (!mounted) return
        setTodayEvents(today)
        setWeekEvents(week)
        setProjects(projectRows)
        setActivity(activityRows)
      } catch {
        if (mounted) setError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [worker.id, worker.name])

  const shift = useMemo(() => shiftState(todayEvents), [todayEvents])
  const currentProject = projects.find((project) => project.id === shift.projectId) ?? null

  return (
    <>
      <div className="drawer-hero">
        <div className="drawer-avatar">{initials(worker.name)}</div>
        <div>
          <h1>{worker.name}</h1>
          <span className={`badge ${roleTone(worker.role)}`}>{worker.role}</span>
        </div>
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && (
        <>
          <div className="drawer-metrics">
            <div className="card center">
              <div className="big">{fmtHours(workedMs(todayEvents))}</div>
              <div className="muted">{t('hours_today')}</div>
            </div>
            <div className="card center">
              <div className="big">{fmtHours(workedMs(weekEvents))}</div>
              <div className="muted">{t('hours_week')}</div>
            </div>
          </div>

          <section className="drawer-section">
            <h2>{t('current_project')}</h2>
            {currentProject ? (
              <button className="drawer-row-button" onClick={() => openProject(currentProject)}>
                <span>{currentProject.name}</span>
                <span className={`badge ${shift.status === 'break' ? 'amber' : 'green'}`}>
                  {shift.status === 'break' ? t('on_break') : t('on_shift')}
                </span>
              </button>
            ) : (
              <div className="card muted">{t('not_on_shift')}</div>
            )}
          </section>

          <section className="drawer-section">
            <h2>{t('recent_activity')}</h2>
            <ActivityList rows={activity} />
          </section>

          <div className="drawer-actions">
            <button className="btn ghost small" onClick={() => { close(); navigate('/messages') }}>{t('write_message')}</button>
            <button className="btn small" onClick={() => { close(); navigate('/dispatch') }}>{t('assign_worker')}</button>
          </div>
        </>
      )}
    </>
  )
}

function ProjectPanel({ project, close, openWorker }: {
  project: Project
  close: () => void
  openWorker: (worker: Profile) => void
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [team, setTeam] = useState<Profile[]>([])
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [profits, setProfits] = useState<ProjectProfit[]>([])
  const [photos, setPhotos] = useState<ProjectPhoto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [people, today, taskRows, profitRows, photoRows] = await Promise.all([
          getTeam(),
          getTodayEvents(),
          getOpenTasks(),
          getProjectProfit(),
          getProjectRecentPhotos(project.id),
        ])
        if (!mounted) return
        setTeam(people)
        setEvents(today)
        setTasks(taskRows.filter((task) => task.project_id === project.id))
        setProfits(profitRows)
        setPhotos(photoRows)
      } catch {
        if (mounted) setError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [project.id])

  const byWorker = useMemo(() => {
    const map = new Map<string, TimeEvent[]>()
    for (const event of events) {
      if (!map.has(event.profile_id)) map.set(event.profile_id, [])
      map.get(event.profile_id)!.push(event)
    }
    return map
  }, [events])

  const onSite = team.filter((worker) => {
    const state = shiftState(byWorker.get(worker.id) ?? [])
    return state.status !== 'off' && state.projectId === project.id
  })
  const profit = profits.find((row) => row.project_id === project.id)
  const margin = profit?.margin_pct === null || profit?.margin_pct === undefined ? '—' : `${Math.round(profit.margin_pct * 10) / 10}%`

  return (
    <>
      <div className="drawer-hero">
        <div className="drawer-avatar project">📁</div>
        <div>
          <h1>{project.name}</h1>
          <p className="muted">{project.address}</p>
        </div>
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && (
        <>
          <div className="drawer-metrics">
            <div className="card center">
              <div className="big">{margin}</div>
              <div className="muted">{t('project_margin')}</div>
            </div>
            <div className="card center">
              <div className="big">{onSite.length}</div>
              <div className="muted">{t('on_site_now')}</div>
            </div>
          </div>

          <section className="drawer-section">
            <h2>{t('on_site_now')}</h2>
            {onSite.length === 0 && <div className="card muted">{t('nobody_on_site')}</div>}
            {onSite.map((worker) => (
              <button className="drawer-row-button" key={worker.id} onClick={() => openWorker(worker)}>
                <span>{worker.name}</span>
                <span className={`badge ${roleTone(worker.role)}`}>{worker.role}</span>
              </button>
            ))}
          </section>

          <section className="drawer-section">
            <h2>{t('tasks')}</h2>
            {tasks.length === 0 && <div className="card muted">{t('no_tasks')}</div>}
            {tasks.slice(0, 5).map((task) => (
              <div className="drawer-task" key={task.id}>
                <span className={`badge ${task.priority === 'urgent' ? 'red' : task.priority === 'high' ? 'amber' : 'blue'}`}>{task.priority}</span>
                <span>{task.title}</span>
              </div>
            ))}
          </section>

          <section className="drawer-section">
            <h2>{t('recent_photos')}</h2>
            {photos.length === 0 && <div className="card muted">{t('no_photos')}</div>}
            {photos.length > 0 && (
              <div className="drawer-photo-grid">
                {photos.map((photo) => (
                  <img key={photo.id} src={photo.url} alt={photo.filename ?? t('photo_preview')} />
                ))}
              </div>
            )}
          </section>

          <div className="drawer-actions">
            <button className="btn ghost small" onClick={() => { close(); navigate('/messages') }}>{t('write_message')}</button>
            <button className="btn small" onClick={() => { close(); navigate('/dispatch') }}>{t('assign_worker')}</button>
          </div>
        </>
      )}
    </>
  )
}
