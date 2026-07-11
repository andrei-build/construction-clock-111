import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  assignWorkerToProject,
  getOpenTasks,
  getProjectAssignments,
  getProjects,
  getTeam,
  sendDispatchPlan,
  unassignWorkerFromProject,
} from '../lib/api'
import type { Profile, Project, ProjectAssignment, Task } from '../lib/types'

function dateValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export default function Dispatch() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [assignments, setAssignments] = useState<ProjectAssignment[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [sentProject, setSentProject] = useState<string | null>(null)

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
      const assignmentRows = await getProjectAssignments(projectRows.map((project) => project.id))
      setProjects(projectRows)
      setTeam(people.filter((person) => ['worker', 'driver', 'supervisor'].includes(person.role)))
      setTasks(taskRows)
      setAssignments(assignmentRows)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [profile?.id])

  const assignedIds = (projectId: string) =>
    new Set(assignments.filter((a) => a.project_id === projectId).map((a) => a.profile_id))
  const projectTasks = (projectId: string) => tasks.filter((task) => task.project_id === projectId)
  const assignedWorkers = (projectId: string) => {
    const ids = assignedIds(projectId)
    return team.filter((worker) => ids.has(worker.id))
  }

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

  return (
    <div className="screen dispatch-screen">
      <h1>🧭 {t('dispatch')}</h1>
      <p className="muted dispatch-date">{t('tomorrow')}: {tomorrow.toLocaleDateString()}</p>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
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
                  <div className="item-title">{project.name}</div>
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
                      <span>{worker.name}</span>
                    </label>
                  )
                })}
              </div>

              <h2>{t('tasks')}</h2>
              {ptasks.length === 0 && <p className="muted">{t('no_tasks')}</p>}
              {ptasks.slice(0, 4).map((task) => (
                <div className="dispatch-task" key={task.id}>{task.title}</div>
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
