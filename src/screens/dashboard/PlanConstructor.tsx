import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../lib/auth'
import { useI18n } from '../../lib/i18n'
import {
  assignWorkerToProject,
  createMaterialRequest,
  createTask,
  getOpenTasks,
  getProjectAssignments,
  getProjects,
  getRecentDispatchPlanSends,
  getTeam,
  markMaterialStatus,
  sendDispatchPlan,
  subscribeToTaskChanges,
  unassignWorkerFromProject,
  type DispatchPlanSend,
  type MaterialStatusAction,
} from '../../lib/api'
import { isManagerRole } from '../../lib/types'
import type { Profile, Project, ProjectAssignment, Task } from '../../lib/types'
import { useEntityDrawer } from '../../components/EntityDrawer'
import MaterialStatusChain, { isMaterialFlowTask } from '../../components/MaterialStatusChain'
import VoiceMic from '../../components/VoiceMic'

type PlanConflict = {
  id: string
  tone: 'amber' | 'red'
  text: string
}

type TaskDraft = { title: string; type: Task['task_type']; assignee: string }

const CREW_ROLES = ['worker', 'driver', 'supervisor']

function dateValue(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function tomorrowValue() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return dateValue(d)
}

function template(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ''))
}

const emptyDraft: TaskDraft = { title: '', type: 'work', assignee: '' }

// DISP-1: конструктор плана внутри командного центра. Андрей: «не понимаю, как создать
// план; два плана и всё, добавить не могу» — старый /dispatch показывал только проекты,
// где уже есть задачи. Здесь показываем ВСЕ активные проекты + поиск, чтобы добавить любой.
export default function PlanConstructor() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const { openWorker, openProject } = useEntityDrawer()
  const manager = profile ? isManagerRole(profile.role) : false

  const [projects, setProjects] = useState<Project[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [assignments, setAssignments] = useState<ProjectAssignment[]>([])
  const [sends, setSends] = useState<DispatchPlanSend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [taskBusy, setTaskBusy] = useState<string | null>(null)

  const [date, setDate] = useState(() => tomorrowValue())
  const [manualIds, setManualIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [openForm, setOpenForm] = useState<string | null>(null)
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft)
  const [sentProject, setSentProject] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(false)
    try {
      const [projectRows, people, taskRows] = await Promise.all([getProjects(), getTeam(), getOpenTasks()])
      const [assignmentRows, sendRows] = await Promise.all([
        getProjectAssignments(projectRows.map((project) => project.id)),
        getRecentDispatchPlanSends(),
      ])
      setProjects(projectRows)
      setTeam(people.filter((person) => CREW_ROLES.includes(person.role)))
      setTasks(taskRows)
      setAssignments(assignmentRows)
      setSends(sendRows)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (manager) void load() }, [profile?.id])
  useEffect(() => {
    if (!manager || !profile?.org_id) return
    return subscribeToTaskChanges(profile.org_id, () => { void load() }, 'tasks:plan-constructor')
  }, [profile?.org_id])

  const peopleById = useMemo(() => new Map(team.map((person) => [person.id, person.name])), [team])
  const assignedIds = (projectId: string) =>
    new Set(assignments.filter((a) => a.project_id === projectId).map((a) => a.profile_id))
  const projectTasks = (projectId: string) => tasks.filter((task) => task.project_id === projectId)
  const assignedWorkers = (projectId: string) => {
    const ids = assignedIds(projectId)
    return team.filter((worker) => ids.has(worker.id))
  }

  // Проекты «в дне»: те, где уже есть бригада или задачи, плюс добавленные вручную из поиска.
  const shownProjects = useMemo(() => {
    const withAssign = new Set(assignments.map((a) => a.project_id))
    const withTask = new Set(tasks.map((task) => task.project_id))
    return projects.filter((p) => manualIds.has(p.id) || withAssign.has(p.id) || withTask.has(p.id))
  }, [projects, assignments, tasks, manualIds])

  const addableProjects = useMemo(() => {
    const shown = new Set(shownProjects.map((p) => p.id))
    const q = query.trim().toLowerCase()
    return projects
      .filter((p) => !shown.has(p.id) && (q === '' || p.name.toLowerCase().includes(q)))
      .slice(0, 8)
  }, [projects, shownProjects, query])

  const sendByProject = useMemo(() => {
    const m = new Map<string, DispatchPlanSend>()
    for (const s of sends) if (!m.has(s.project_id)) m.set(s.project_id, s) // sends отсортированы desc → первый = свежий
    return m
  }, [sends])

  const conflicts = useMemo<PlanConflict[]>(() => {
    if (!manager) return []
    const items: PlanConflict[] = []
    const projectById = new Map(projects.map((project) => [project.id, project]))
    const personById = new Map(team.map((person) => [person.id, person]))

    // Человек назначен на 2+ проекта (project_assignments не датируется по дням, поэтому
    // конфликт «на два проекта разом»). Считаем по уникальным проектам на человека.
    const projectsByPerson = new Map<string, Map<string, Project>>()
    for (const assignment of assignments) {
      const project = projectById.get(assignment.project_id)
      if (!project) continue
      if (!projectsByPerson.has(assignment.profile_id)) projectsByPerson.set(assignment.profile_id, new Map())
      projectsByPerson.get(assignment.profile_id)!.set(project.id, project)
    }
    const doubles = Array.from(projectsByPerson.entries()).sort((a, b) =>
      (personById.get(a[0])?.name ?? '').localeCompare(personById.get(b[0])?.name ?? ''))
    for (const [profileId, projectMap] of doubles) {
      const activeProjects = Array.from(projectMap.values()).sort((a, b) => a.name.localeCompare(b.name))
      if (activeProjects.length < 2) continue
      items.push({
        id: `double-${profileId}`,
        tone: 'amber',
        text: template(t('conflict_double_assignment'), {
          name: personById.get(profileId)?.name ?? t('unknown_user'),
          projectA: activeProjects[0].name,
          projectB: activeProjects[1].name,
        }),
      })
    }

    // Проект с задачами, но без назначенной бригады.
    for (const project of projects) {
      if (projectTasks(project.id).length === 0) continue
      if (assignedIds(project.id).size > 0) continue
      items.push({
        id: `nocrew-${project.id}`,
        tone: 'red',
        text: template(t('plan_conflict_no_crew'), { project: project.name }),
      })
    }

    // Доставка без водителя (сохраняем прежний конфликт из /dispatch).
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
  }, [assignments, manager, projects, t, tasks, team])

  if (!manager) return null

  const addProject = (projectId: string) => {
    setManualIds((prev) => new Set(prev).add(projectId))
    setQuery('')
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

  const submitTask = async (projectId: string) => {
    if (!profile || taskBusy) return
    const title = draft.title.trim()
    if (!title) return
    setTaskBusy(projectId)
    setError(false)
    try {
      if (draft.type === 'material') {
        await createMaterialRequest(profile, { projectId, title, description: null })
      } else {
        await createTask(profile, {
          project_id: projectId,
          title,
          task_type: draft.type,
          priority: 'medium',
          assigned_to: draft.assignee || null,
          due_date: date,
        })
      }
      setDraft(emptyDraft)
      setOpenForm(null)
      await load()
    } catch {
      setError(true)
    } finally {
      setTaskBusy(null)
    }
  }

  const updateMaterialStatus = async (task: Task, action: MaterialStatusAction) => {
    if (!profile || taskBusy) return
    setTaskBusy(task.id)
    setError(false)
    try {
      await markMaterialStatus(task.id, action)
      await load()
    } catch {
      setError(true)
    } finally {
      setTaskBusy(null)
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
      await sendDispatchPlan(profile, project, workers, projectTasks(project.id), date)
      setSentProject(project.id)
      setSends(await getRecentDispatchPlanSends())
    } catch {
      setError(true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="card plan-constructor">
      <div className="row plan-constructor-head">
        <h2>{t('plan_constructor_title')}</h2>
        <label className="plan-date-picker">
          {t('plan_date')}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value || tomorrowValue())} />
        </label>
      </div>

      {error && <p className="error-msg">{t('load_error')}</p>}
      {loading ? (
        <div className="muted">{t('loading')}</div>
      ) : (
        <>
          <div className="plan-conflicts">
            <h3>{t('conflicts_title')}</h3>
            {conflicts.length === 0 ? (
              <p className="muted">{t('conflicts_none')}</p>
            ) : (
              conflicts.map((conflict) => (
                <div className={`dispatch-conflict-row ${conflict.tone}`} key={conflict.id}>
                  <span className={`status-dot ${conflict.tone}`} />
                  <div className="item-title">{conflict.text}</div>
                </div>
              ))
            )}
          </div>

          <div className="plan-add-project">
            <input
              type="search"
              value={query}
              placeholder={t('plan_add_project_search')}
              onChange={(e) => setQuery(e.target.value)}
            />
            {(query.trim() !== '' || addableProjects.length > 0) && (
              <div className="plan-add-list">
                {addableProjects.length === 0 ? (
                  <span className="muted">{t('no_active_projects')}</span>
                ) : (
                  addableProjects.map((p) => (
                    <button key={p.id} type="button" className="btn small" onClick={() => addProject(p.id)}>
                      + {p.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {shownProjects.length === 0 && <div className="muted plan-empty">{t('plan_no_projects_for_day')}</div>}

          <div className="dispatch-board">
            {shownProjects.map((project) => {
              const ids = assignedIds(project.id)
              const workers = assignedWorkers(project.id)
              const ptasks = projectTasks(project.id)
              const sent = sendByProject.get(project.id)
              const isFormOpen = openForm === project.id
              return (
                <section className="card dispatch-card" key={project.id}>
                  <div className="row">
                    <div>
                      <button className="inline-link item-title" onClick={() => openProject(project)}>{project.name}</button>
                      <div className="muted">{project.address}</div>
                    </div>
                    <span className="badge blue">{workers.length}</span>
                  </div>

                  {sent && (
                    <div className="badge green plan-sent-badge">
                      {template(t('plan_sent_badge'), { n: sent.workers, when: new Date(sent.created_at).toLocaleString() })}
                    </div>
                  )}

                  <h3>{t('team')}</h3>
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
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openWorker(worker) }}
                          >
                            {worker.name}
                          </button>
                        </label>
                      )
                    })}
                  </div>

                  <h3>{t('tasks')}</h3>
                  {ptasks.length === 0 && <p className="muted">{t('no_tasks')}</p>}
                  {ptasks.map((task) => (
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

                  {isFormOpen ? (
                    <div className="plan-task-form">
                      <div className="plan-task-title-row">
                        <input
                          type="text"
                          value={draft.title}
                          placeholder={t('plan_task_title_ph')}
                          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                        />
                        <VoiceMic
                          lang={lang}
                          title={t('mat_voice_hint')}
                          onResult={(text) => setDraft((d) => ({ ...d, title: d.title ? `${d.title} ${text}` : text }))}
                        />
                      </div>
                      <div className="plan-task-controls">
                        <select value={draft.type} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value as Task['task_type'] }))}>
                          <option value="work">{t('task_type_work')}</option>
                          <option value="material">{t('task_type_material')}</option>
                          <option value="delivery">{t('task_type_delivery')}</option>
                        </select>
                        {draft.type !== 'material' && (
                          <select value={draft.assignee} onChange={(e) => setDraft((d) => ({ ...d, assignee: e.target.value }))}>
                            <option value="">{t('plan_assignee_none')}</option>
                            {team.map((worker) => (
                              <option key={worker.id} value={worker.id}>{worker.name}</option>
                            ))}
                          </select>
                        )}
                      </div>
                      <div className="plan-task-actions">
                        <button
                          type="button"
                          className="btn small"
                          disabled={taskBusy !== null || draft.title.trim() === ''}
                          onClick={() => submitTask(project.id)}
                        >
                          {t('save')}
                        </button>
                        <button type="button" className="btn small ghost" disabled={taskBusy !== null} onClick={() => { setOpenForm(null); setDraft(emptyDraft) }}>
                          {t('cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="inline-link plan-add-task"
                      onClick={() => { setOpenForm(project.id); setDraft(emptyDraft) }}
                    >
                      {t('plan_add_task')}
                    </button>
                  )}

                  <button className="btn" disabled={busy !== null || workers.length === 0} onClick={() => sendPlan(project)}>
                    {t('send_plan')}
                  </button>
                  {sentProject === project.id && <p className="ok-msg">{t('plan_sent')}</p>}
                </section>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
