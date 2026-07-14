import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  assignWorkerToProject,
  getOpenTasks,
  getProjectAssignments,
  getProjects,
  getTeam,
  markMaterialStatus,
  sendDispatchPlan,
  subscribeToTaskChanges,
  unassignWorkerFromProject,
  type MaterialStatusAction,
} from '../lib/api'
import { supabase } from '../lib/supabase'
import { isManagerRole } from '../lib/types'
import type { Profile, Project, ProjectAssignment, Task, WorkInterval } from '../lib/types'
import { useEntityDrawer } from '../components/EntityDrawer'
import MaterialStatusChain, { isMaterialFlowTask } from '../components/MaterialStatusChain'

type DispatchConflict = {
  id: string
  tone: 'amber' | 'red'
  text: string
}

function dateValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function startOfWeekMonday(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - day)
  return d
}

function template(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

function intervalHours(interval: WorkInterval, nowMs: number) {
  const startMs = new Date(interval.start_at).getTime()
  const endMs = interval.end_at ? new Date(interval.end_at).getTime() : nowMs
  return Math.max(0, endMs - startMs) / 3600000
}

function formatConflictHours(hours: number) {
  const rounded = Math.round(hours * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export default function Dispatch() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const { openWorker, openProject } = useEntityDrawer()
  const [projects, setProjects] = useState<Project[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [assignments, setAssignments] = useState<ProjectAssignment[]>([])
  const [workIntervals, setWorkIntervals] = useState<WorkInterval[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [taskBusy, setTaskBusy] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [taskError, setTaskError] = useState(false)
  const [sentProject, setSentProject] = useState<string | null>(null)
  const manager = profile ? isManagerRole(profile.role) : false

  const tomorrow = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d
  }, [])
  const tomorrowISO = useMemo(() => dateValue(tomorrow), [tomorrow])

  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      const [projectRows, people, taskRows] = await Promise.all([getProjects(), getTeam(), getOpenTasks()])
      const mondayISO = startOfWeekMonday(new Date()).toISOString()
      const [assignmentRows, intervalResult] = await Promise.all([
        getProjectAssignments(projectRows.map((project) => project.id)),
        manager
          ? supabase.from('v_work_intervals').select('*').gte('start_at', mondayISO)
          : Promise.resolve({ data: [] as WorkInterval[], error: null }),
      ])
      if (intervalResult.error) throw intervalResult.error
      setProjects(projectRows)
      setTeam(people.filter((person) => ['worker', 'driver', 'supervisor'].includes(person.role)))
      setTasks(taskRows)
      setAssignments(assignmentRows)
      setWorkIntervals((intervalResult.data as WorkInterval[]) ?? [])
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [profile?.id])
  useEffect(() => {
    if (!profile?.org_id) return
    return subscribeToTaskChanges(profile.org_id, () => { void load() }, 'tasks:dispatch')
  }, [profile?.org_id])

  const assignedIds = (projectId: string) =>
    new Set(assignments.filter((a) => a.project_id === projectId).map((a) => a.profile_id))
  const projectTasks = (projectId: string) => tasks.filter((task) => task.project_id === projectId)
  const peopleById = useMemo(() => new Map(team.map((person) => [person.id, person.name])), [team])
  const assignedWorkers = (projectId: string) => {
    const ids = assignedIds(projectId)
    return team.filter((worker) => ids.has(worker.id))
  }

  const conflicts = useMemo<DispatchConflict[]>(() => {
    if (!manager) return []

    const items: DispatchConflict[] = []
    const projectById = new Map(projects.map((project) => [project.id, project]))
    const personById = new Map(team.map((person) => [person.id, person]))
    const assignedProjectsByPerson = new Map<string, Map<string, Project>>()

    for (const assignment of assignments) {
      const project = projectById.get(assignment.project_id)
      if (!project) continue
      if (!assignedProjectsByPerson.has(assignment.profile_id)) {
        assignedProjectsByPerson.set(assignment.profile_id, new Map())
      }
      assignedProjectsByPerson.get(assignment.profile_id)!.set(project.id, project)
    }

    const doubleAssigned = Array.from(assignedProjectsByPerson.entries()).sort((a, b) => {
      const aName = personById.get(a[0])?.name ?? ''
      const bName = personById.get(b[0])?.name ?? ''
      return aName.localeCompare(bName)
    })
    for (const [profileId, projectMap] of doubleAssigned) {
      const activeProjects = Array.from(projectMap.values()).sort((a, b) => a.name.localeCompare(b.name))
      if (activeProjects.length < 2) continue
      const person = personById.get(profileId)
      items.push({
        id: `double-${profileId}`,
        tone: 'amber',
        text: template(t('conflict_double_assignment'), {
          name: person?.name ?? t('unknown_user'),
          projectA: activeProjects[0].name,
          projectB: activeProjects[1].name,
        }),
      })
    }

    const nowMs = Date.now()
    const hoursByPerson = new Map<string, number>()
    for (const interval of workIntervals) {
      hoursByPerson.set(interval.profile_id, (hoursByPerson.get(interval.profile_id) ?? 0) + intervalHours(interval, nowMs))
    }

    const overworked = Array.from(hoursByPerson.entries())
      .filter(([, hours]) => hours > 40)
      .sort((a, b) => {
        const aName = personById.get(a[0])?.name ?? ''
        const bName = personById.get(b[0])?.name ?? ''
        return aName.localeCompare(bName)
      })
    for (const [profileId, hours] of overworked) {
      const person = personById.get(profileId)
      items.push({
        id: `overwork-${profileId}`,
        tone: 'red',
        text: template(t('conflict_overwork'), {
          name: person?.name ?? t('unknown_user'),
          hours: formatConflictHours(hours),
        }),
      })
    }

    for (const task of tasks) {
      if (task.task_type !== 'delivery' || !['open', 'in_progress'].includes(task.status)) continue
      const assignee = task.assigned_to ? personById.get(task.assigned_to) : null
      if (task.assigned_to && assignee?.role === 'driver') continue
      items.push({
        id: `delivery-${task.id}`,
        tone: 'amber',
        text: template(t('conflict_delivery_without_driver'), { title: task.title }),
      })
    }

    return items
  }, [assignments, manager, projects, t, tasks, team, workIntervals])

  const toggleWorker = async (projectId: string, workerId: string, checked: boolean) => {
    if (!profile || busy) return
    setBusy(`${projectId}-${workerId}`)
    setError(false)
    try {
      if (checked) await assignWorkerToProject(profile, projectId, workerId)
      else await unassignWorkerFromProject(profile, projectId, workerId)
      await load()
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }

  const sendPlan = async (project: Project) => {
    if (!profile || busy) return
    const workers = assignedWorkers(project.id)
    if (workers.length === 0) return
    setBusy(project.id)
    setError(false)
    setSentProject(null)
    try {
      await sendDispatchPlan(profile, project, workers, projectTasks(project.id), tomorrowISO)
      setSentProject(project.id)
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }

  const updateMaterialStatus = async (task: Task, action: MaterialStatusAction) => {
    if (!profile || taskBusy) return
    setTaskBusy(task.id)
    setTaskError(false)
    try {
      await markMaterialStatus(task.id, action)
      await load()
    } catch {
      setTaskError(true)
    } finally {
      setTaskBusy(null)
    }
  }

  return (
    <div className="screen dispatch-screen">
      <h1>🧭 {t('dispatch')}</h1>
      <p className="muted dispatch-date">{t('tomorrow')}: {tomorrow.toLocaleDateString()}</p>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {taskError && <p className="error-msg">{t('material_status_failed')}</p>}
      {manager && !loading && !error && (
        <section className="card dispatch-conflicts-card">
          <h2>{t('conflicts_title')}</h2>
          {conflicts.length === 0 ? (
            <p className="muted">{t('conflicts_none')}</p>
          ) : (
            <div className="dispatch-conflicts-list">
              {conflicts.map((conflict) => (
                <div className={`dispatch-conflict-row ${conflict.tone}`} key={conflict.id}>
                  <span className={`status-dot ${conflict.tone}`} />
                  <div className="item-title">{conflict.text}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {!loading && projects.length === 0 && <div className="card muted">{t('no_active_projects')}</div>}

      <div className="dispatch-board">
        {projects.map((project) => {
          const ids = assignedIds(project.id)
          const workers = assignedWorkers(project.id)
          const ptasks = projectTasks(project.id)
          return (
            <section className="card dispatch-card" key={project.id}>
              <div className="row">
                <div>
                  <button className="inline-link item-title" onClick={() => openProject(project)}>{project.name}</button>
                  <div className="muted">{project.address}</div>
                </div>
                <span className="badge blue">{workers.length}</span>
              </div>

              <h2>{t('team')}</h2>
              <div className="dispatch-workers">
                {team.map((worker) => {
                  const checked = ids.has(worker.id)
                  return (
                    <label key={worker.id} className="check-row">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy !== null}
                        onChange={(e) => toggleWorker(project.id, worker.id, e.target.checked)}
                      />
                      <button
                        type="button"
                        className="inline-link"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          openWorker(worker)
                        }}
                      >
                        {worker.name}
                      </button>
                    </label>
                  )
                })}
              </div>

              <h2>{t('tasks')}</h2>
              {ptasks.length === 0 && <p className="muted">{t('no_tasks')}</p>}
              {ptasks.slice(0, 4).map((task) => (
                <div className="dispatch-task" key={task.id}>
                  <div className="item-title">{task.title}</div>
                  {task.description && <div className="muted task-description">{task.description}</div>}
                  {isMaterialFlowTask(task) && (
                    <MaterialStatusChain
                      task={task}
                      peopleById={peopleById}
                      busy={taskBusy !== null}
                      compact
                      onStatusChange={updateMaterialStatus}
                    />
                  )}
                </div>
              ))}

              <button className="btn" disabled={busy !== null || workers.length === 0} onClick={() => sendPlan(project)}>
                {t('send_plan')}
              </button>
              {sentProject === project.id && <p className="ok-msg">{t('plan_sent')}</p>}
            </section>
          )
        })}
      </div>
    </div>
  )
}
