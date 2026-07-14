import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getAllTasks, getProjects, getTeam, createTask } from '../lib/api'
import { isManagerRole, isManagerWrite } from '../lib/types'
import type { Profile, Project, Task } from '../lib/types'

// Глобальный экран «Задачи» — все задачи по всем проектам (паритет со старым Check Time).
// Данные и механика создания зеркалят вкладку задач Хаба (TasksTab) и getOpenTasks/createTask.

const TASK_TYPES: Task['task_type'][] = ['work', 'material', 'delivery']
const TASK_STATUSES: Task['status'][] = ['open', 'in_progress', 'done', 'cancelled']
const TASK_PRIORITIES: Task['priority'][] = ['low', 'medium', 'high', 'urgent']

// Ранг приоритета для сортировки: срочный → низкий. Зеркалит порядок enum task_priority.
const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 }

function typeIcon(type: Task['task_type']) {
  if (type === 'delivery') return '🚚'
  if (type === 'material') return '📦'
  return '🔨'
}

function priorityTone(priority: Task['priority']) {
  return priority === 'urgent' ? 'red' : priority === 'high' ? 'amber' : priority === 'medium' ? 'blue' : 'grey'
}

interface FilterState {
  project: string
  type: string
  status: string
  assignee: string
}

const EMPTY_FILTERS: FilterState = { project: 'all', type: 'all', status: 'all', assignee: 'all' }

export default function Tasks() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)

  // Форма создания (только менеджер — RLS tasks_insert требует is_manager_write).
  const canCreate = profile ? isManagerWrite(profile.role) : false
  const isManager = profile ? isManagerRole(profile.role) : false
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState(false)
  const [fProject, setFProject] = useState('')
  const [fTitle, setFTitle] = useState('')
  const [fType, setFType] = useState<Task['task_type']>('work')
  const [fPriority, setFPriority] = useState<Task['priority']>('medium')
  const [fAssignee, setFAssignee] = useState('')
  const [fDue, setFDue] = useState('')
  const [fDescription, setFDescription] = useState('')
  const [fRequiresPhoto, setFRequiresPhoto] = useState(false)

  const load = async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [taskRows, projectRows, teamRows] = await Promise.all([getAllTasks(), getProjects(), getTeam()])
      setTasks(taskRows)
      setProjects(projectRows)
      setTeam(teamRows)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [profile?.id])

  const projectName = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of projects) map.set(p.id, p.name)
    return map
  }, [projects])

  const personName = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of team) map.set(p.id, p.name)
    return map
  }, [team])

  // Роль-гейт (паритет со списками поля): менеджер/супервайзер видят все задачи,
  // работник — только назначенные ему. RLS уже держит org-скоуп и прячет чужие орг-данные.
  const visibleTasks = useMemo(() => {
    if (isManager) return tasks
    if (!profile) return []
    return tasks.filter((task) => task.assigned_to === profile.id)
  }, [tasks, isManager, profile])

  const filtered = useMemo(() => {
    const rows = visibleTasks.filter((task) => {
      if (filters.project !== 'all' && task.project_id !== filters.project) return false
      if (filters.type !== 'all' && task.task_type !== filters.type) return false
      if (filters.status !== 'all' && task.status !== filters.status) return false
      if (filters.assignee !== 'all') {
        if (filters.assignee === 'unassigned' ? task.assigned_to !== null : task.assigned_to !== filters.assignee) return false
      }
      return true
    })
    // Сортировка: приоритет (срочный→низкий), затем срок (ближайший первым, без срока — в конец).
    return rows.slice().sort((a, b) => {
      const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      if (pr !== 0) return pr
      const da = a.due_date ?? ''
      const db = b.due_date ?? ''
      if (da && db) return da < db ? -1 : da > db ? 1 : 0
      if (da) return -1
      if (db) return 1
      return 0
    })
  }, [visibleTasks, filters])

  const resetCreateForm = () => {
    setFProject(''); setFTitle(''); setFType('work'); setFPriority('medium')
    setFAssignee(''); setFDue(''); setFDescription(''); setFRequiresPhoto(false)
    setAdding(false); setCreateError(false)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !fProject || !fTitle.trim()) return
    setBusy(true)
    setCreateError(false)
    try {
      await createTask(profile, {
        project_id: fProject,
        title: fTitle.trim(),
        task_type: fType,
        priority: fPriority,
        assigned_to: fAssignee || null,
        due_date: fDue || null,
        description: fDescription,
        requires_photo: fRequiresPhoto,
      })
      resetCreateForm()
      await load()
    } catch {
      setCreateError(true)
    } finally {
      setBusy(false)
    }
  }

  const filtersActive = filters.project !== 'all' || filters.type !== 'all' || filters.status !== 'all' || filters.assignee !== 'all'

  return (
    <div className="screen">
      <h1>✅ {t('tasks_all_title')}</h1>

      {canCreate && !adding && (
        <button className="btn ghost small" onClick={() => setAdding(true)}>+ {t('tasks_new')}</button>
      )}

      {canCreate && adding && (
        <form onSubmit={submit} className="card">
          <label>{t('col_project')}</label>
          <select value={fProject} onChange={(e) => setFProject(e.target.value)}>
            <option value="">{t('task_select_project')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <label>{t('task_title_label')}</label>
          <input value={fTitle} onChange={(e) => setFTitle(e.target.value)} />

          <div className="row coord-row">
            <div className="coord-field">
              <label>{t('col_type')}</label>
              <select value={fType} onChange={(e) => setFType(e.target.value as Task['task_type'])}>
                {TASK_TYPES.map((tp) => <option key={tp} value={tp}>{t(`task_type_${tp}`)}</option>)}
              </select>
            </div>
            <div className="coord-field">
              <label>{t('col_priority')}</label>
              <select value={fPriority} onChange={(e) => setFPriority(e.target.value as Task['priority'])}>
                {TASK_PRIORITIES.map((pr) => <option key={pr} value={pr}>{t(`task_priority_${pr}`)}</option>)}
              </select>
            </div>
          </div>

          <div className="row coord-row">
            <div className="coord-field">
              <label>{t('col_assignee')}</label>
              <select value={fAssignee} onChange={(e) => setFAssignee(e.target.value)}>
                <option value="">{t('task_unassigned')}</option>
                {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div className="coord-field">
              <label>{t('col_due')}</label>
              <input type="date" value={fDue} onChange={(e) => setFDue(e.target.value)} />
            </div>
          </div>

          <label>{t('task_description_label')}</label>
          <input value={fDescription} onChange={(e) => setFDescription(e.target.value)} />

          <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input type="checkbox" checked={fRequiresPhoto} onChange={(e) => setFRequiresPhoto(e.target.checked)} />
            <span>{t('task_requires_photo')}</span>
          </label>

          {createError && <p className="error-msg">{t('tasks_create_error')}</p>}
          <p className="muted" style={{ marginTop: 4 }}>{t('tasks_create_hint')}</p>
          <div className="row">
            <button className="btn" disabled={busy || !fProject || !fTitle.trim()}>{t('create')}</button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={resetCreateForm}>{t('cancel')}</button>
          </div>
        </form>
      )}

      <div className="card reports-filter">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{t('tasks_filters')}</strong>
          {filtersActive && (
            <button className="btn ghost small" onClick={() => setFilters(EMPTY_FILTERS)}>{t('tasks_reset_filters')}</button>
          )}
        </div>
        <div className="grid2">
          <div>
            <label>{t('col_project')}</label>
            <select value={filters.project} onChange={(e) => setFilters((f) => ({ ...f, project: e.target.value }))}>
              <option value="all">{t('filter_all')}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label>{t('col_type')}</label>
            <select value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}>
              <option value="all">{t('filter_all')}</option>
              {TASK_TYPES.map((tp) => <option key={tp} value={tp}>{t(`task_type_${tp}`)}</option>)}
            </select>
          </div>
          <div>
            <label>{t('col_status')}</label>
            <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
              <option value="all">{t('filter_all')}</option>
              {TASK_STATUSES.map((st) => <option key={st} value={st}>{t(`task_status_${st}`)}</option>)}
            </select>
          </div>
          <div>
            <label>{t('col_assignee')}</label>
            <select value={filters.assignee} onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}>
              <option value="all">{t('filter_all')}</option>
              <option value="unassigned">{t('task_unassigned')}</option>
              {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('tasks_load_error')}</p>}
      {!loading && !loadError && visibleTasks.length === 0 && <div className="card muted">{t('no_tasks')}</div>}
      {!loading && !loadError && visibleTasks.length > 0 && filtered.length === 0 && (
        <div className="card muted">{t('tasks_none_match')}</div>
      )}

      {!loading && !loadError && filtered.length > 0 && (
        <div className="card reports-table-wrap">
          <table className="reports-table">
            <thead>
              <tr>
                <th>{t('col_task')}</th>
                <th>{t('col_project')}</th>
                <th>{t('col_type')}</th>
                <th>{t('col_status')}</th>
                <th>{t('col_assignee')}</th>
                <th>{t('col_priority')}</th>
                <th>{t('col_due')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((task) => (
                <tr key={task.id}>
                  <td>
                    <span className="task-title">{task.title}</span>
                    {task.requires_photo && <span className="badge amber" style={{ marginLeft: 6 }}>📷</span>}
                  </td>
                  <td>{task.project_id ? projectName.get(task.project_id) ?? '—' : '—'}</td>
                  <td>{typeIcon(task.task_type)} {t(`task_type_${task.task_type}`)}</td>
                  <td>{t(`task_status_${task.status}`)}</td>
                  <td>{task.assigned_to ? personName.get(task.assigned_to) ?? '—' : t('task_unassigned')}</td>
                  <td><span className={`badge ${priorityTone(task.priority)}`}>{t(`task_priority_${task.priority}`)}</span></td>
                  <td>{task.due_date || t('task_no_due')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
