import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useI18n } from '../../lib/i18n'
import {
  createMaterialRequest,
  createTask,
  getOpenTasks,
  getProjectAssignments,
  getTeam,
  markMaterialStatus,
  markTaskDone,
  subscribeToTaskChanges,
  uploadErrorCode,
  uploadTaskPhoto,
  validateUpload,
  type MaterialStatusAction,
} from '../../lib/api'
import { enqueueFieldAction } from '../../lib/offlineFieldActions'
import { enqueueMediaUpload } from '../../lib/offlineMediaQueue'
import { isEffectiveOpenTask } from '../../lib/task-status'
import { isManagerWrite } from '../../lib/types'
import type { Profile, Project, Task, TaskMedia } from '../../lib/types'
import MediaComments from '../../components/MediaComments'
import MaterialStatusChain, { isMaterialFlowTask } from '../../components/MaterialStatusChain'

interface TasksTabProps {
  project: Project
  profile: Profile | null
}

// Тот же набор типов/приоритетов, что у КЦ (Диспетчер) и глобального экрана «Задачи».
const TASK_TYPES: Task['task_type'][] = ['work', 'material', 'delivery']
const TASK_PRIORITIES: Task['priority'][] = ['low', 'medium', 'high', 'urgent']

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine
}

function isNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /failed to fetch|networkerror|network|fetch|load failed/i.test(message)
}

function taskIcon(task: Task) {
  if (task.task_type === 'delivery') return '🚚'
  if (task.task_type === 'material') return '📦'
  return '🔨'
}

function priorityTone(priority: Task['priority']) {
  return priority === 'urgent' ? 'red' : priority === 'high' ? 'amber' : 'blue'
}

export default function TasksTab({ project, profile }: TasksTabProps) {
  const { t } = useI18n()
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [taskBusy, setTaskBusy] = useState<string | null>(null)
  const [photoBusy, setPhotoBusy] = useState<string | null>(null)
  const [photoByTask, setPhotoByTask] = useState<Record<string, TaskMedia>>({})
  const [team, setTeam] = useState<Profile[]>([])
  const [taskError, setTaskError] = useState<string | null>(null)
  const [taskNotice, setTaskNotice] = useState<string | null>(null)
  const [materialFormOpen, setMaterialFormOpen] = useState(false)
  const [materialTitle, setMaterialTitle] = useState('')
  const [materialDetails, setMaterialDetails] = useState('')
  const [materialBusy, setMaterialBusy] = useState(false)

  // HUB-TASK-ADD-1: создание задачи прямо из Хаба (reuse createTask КЦ, project_id авто).
  // Гейт менеджера, как в КЦ/Задачах — RLS tasks_insert требует is_manager_write.
  const canCreate = profile ? isManagerWrite(profile.role) : false
  const [crewIds, setCrewIds] = useState<Set<string>>(new Set())
  const [taskFormOpen, setTaskFormOpen] = useState(false)
  const [fTitle, setFTitle] = useState('')
  const [fType, setFType] = useState<Task['task_type']>('work')
  const [fPriority, setFPriority] = useState<Task['priority']>('medium')
  const [fAssignee, setFAssignee] = useState('')
  const [fDue, setFDue] = useState('')
  const [fRequiresPhoto, setFRequiresPhoto] = useState(false)
  const [taskBusyCreate, setTaskBusyCreate] = useState(false)

  const load = async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setLoadError(false)
    try {
      const [rows, people, assignments] = await Promise.all([getOpenTasks(), getTeam(), getProjectAssignments([project.id])])
      setTasks(rows.filter((task) => task.project_id === project.id && isEffectiveOpenTask(task)))
      setTeam(people)
      setCrewIds(new Set(assignments.map((a) => a.profile_id)))
    } catch {
      setLoadError(true)
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  useEffect(() => { load() }, [project.id])
  useEffect(() => {
    if (!profile?.org_id) return
    return subscribeToTaskChanges(profile.org_id, () => { void load(false) }, `tasks:project-hub:${project.id}`)
  }, [profile?.org_id, project.id])

  const peopleById = useMemo(() => new Map(team.map((person) => [person.id, person.name])), [team])

  // Исполнитель — только СОСТАВ проекта (участники project_assignments), без клиентов.
  const crew = useMemo(
    () => team.filter((person) => crewIds.has(person.id) && person.role !== 'client'),
    [team, crewIds],
  )

  const resetTaskForm = () => {
    setFTitle(''); setFType('work'); setFPriority('medium')
    setFAssignee(''); setFDue(''); setFRequiresPhoto(false)
    setTaskFormOpen(false)
  }

  const createHubTask = async (e: FormEvent) => {
    e.preventDefault()
    if (!profile || taskBusyCreate || !fTitle.trim()) return
    setTaskBusyCreate(true)
    setTaskError(null)
    setTaskNotice(null)
    try {
      // project_id подставляется автоматически из текущего проекта Хаба (reuse api КЦ).
      await createTask(profile, {
        project_id: project.id,
        title: fTitle.trim(),
        task_type: fType,
        priority: fPriority,
        assigned_to: fAssignee || null,
        due_date: fDue || null,
        requires_photo: fRequiresPhoto,
      })
      resetTaskForm()
      setTaskNotice('hub_task_created')
      await load(false)
    } catch (err) {
      setTaskError(err instanceof Error ? err.message : 'tasks_create_error')
    } finally {
      setTaskBusyCreate(false)
    }
  }

  const done = async (task: Task) => {
    if (!profile || isMaterialFlowTask(task)) return
    const mediaId = photoByTask[task.id]?.id ?? null
    // Закон Андрея: закрыть можно без фото; фото обязательно ТОЛЬКО при requires_photo === true.
    // Раньше здесь был «тихий» return — теперь причина видна работнику.
    if (task.requires_photo && !mediaId) {
      setTaskError('task_done_needs_photo')
      setTaskNotice(null)
      return
    }
    setTaskBusy(task.id)
    setTaskError(null)
    setTaskNotice(null)
    const queueOffline = () => {
      enqueueFieldAction({ kind: 'task_status', dedupeKey: `task_status:${task.id}`, payload: { task, mediaId } })
      setTasks((rows) => rows.filter((row) => row.id !== task.id))
      setTaskNotice('offline_action_queued')
    }
    try {
      if (!isOnline()) { queueOffline(); return }
      await markTaskDone(profile, task, mediaId)
      await load()
    } catch (err) {
      if (!isOnline() || isNetworkError(err)) { queueOffline(); return }
      setTaskError('error')
    } finally {
      setTaskBusy(null)
    }
  }

  const updateMaterialStatus = async (task: Task, action: MaterialStatusAction) => {
    if (!profile) return
    setTaskBusy(task.id)
    setTaskError(null)
    setTaskNotice(null)
    try {
      await markMaterialStatus(task.id, action)
      await load(false)
    } catch {
      setTaskError('material_status_failed')
    } finally {
      setTaskBusy(null)
    }
  }

  const createMaterial = async (e: FormEvent) => {
    e.preventDefault()
    if (!profile || materialBusy || !materialTitle.trim()) return
    setMaterialBusy(true)
    setTaskError(null)
    setTaskNotice(null)
    try {
      await createMaterialRequest(profile, {
        projectId: project.id,
        title: materialTitle.trim(),
        description: materialDetails.trim() || null,
      })
      setMaterialTitle('')
      setMaterialDetails('')
      setMaterialFormOpen(false)
      setTaskNotice('material_request_created')
      await load(false)
    } catch {
      setTaskError('material_request_save_failed')
    } finally {
      setMaterialBusy(false)
    }
  }

  const addPhoto = async (task: Task, file: File | undefined) => {
    if (!profile || !file || photoBusy) return
    try {
      validateUpload(file, 'photo')
    } catch (err) {
      setTaskError(uploadErrorCode(err) ?? 'photo_upload_failed')
      return
    }
    setPhotoBusy(task.id)
    setTaskError(null)
    setTaskNotice(null)
    const queueOffline = () => {
      void enqueueMediaUpload({
        kind: 'task_photo',
        dedupeKey: `task_photo:${task.id}:${crypto.randomUUID?.() ?? Date.now()}`,
        file,
        target: { task },
      })
      setTaskNotice('offline_photo_queued')
    }
    try {
      if (!isOnline()) { queueOffline(); return }
      const media = await uploadTaskPhoto(profile, task, file)
      setPhotoByTask((current) => ({ ...current, [task.id]: media }))
    } catch (err) {
      const code = uploadErrorCode(err)
      if (!code && (!isOnline() || isNetworkError(err))) { queueOffline(); return }
      setTaskError(code ?? 'photo_upload_failed')
    } finally {
      setPhotoBusy(null)
    }
  }

  return (
    <section className="hub-tab-panel hub-tasks">
      {taskError && <p className="error-msg">{t(taskError)}</p>}
      {taskNotice && <p className="warn-msg">{t(taskNotice)}</p>}
      {canCreate && (
        <div className="card hub-task-create-card">
          {!taskFormOpen ? (
            <button type="button" className="btn ghost small" onClick={() => setTaskFormOpen(true)}>
              {t('hub_task_add')}
            </button>
          ) : (
            <form className="hub-task-create-form" onSubmit={createHubTask}>
              <h2>{t('hub_task_new')}</h2>
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
                    {crew.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <span className="muted hub-task-crew-hint">{t('hub_task_crew_only')}</span>
                </div>
                <div className="coord-field">
                  <label>{t('col_due')}</label>
                  <input type="date" value={fDue} onChange={(e) => setFDue(e.target.value)} />
                </div>
              </div>

              <label className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8 }}>
                <input type="checkbox" checked={fRequiresPhoto} onChange={(e) => setFRequiresPhoto(e.target.checked)} style={{ width: 'auto' }} />
                <span>{t('task_requires_photo')}</span>
              </label>

              <div className="row material-request-actions">
                <button className="btn small" disabled={taskBusyCreate || !fTitle.trim()}>
                  {taskBusyCreate ? t('saving') : t('create')}
                </button>
                <button type="button" className="btn ghost small" disabled={taskBusyCreate} onClick={resetTaskForm}>
                  {t('cancel')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      {profile && (
        <div className="card material-request-card">
          {!materialFormOpen ? (
            <button type="button" className="btn ghost small" onClick={() => setMaterialFormOpen(true)}>
              + {t('material_request_quick')}
            </button>
          ) : (
            <form className="material-request-form" onSubmit={createMaterial}>
              <h2>{t('material_request_title')}</h2>
              <label>{t('material_request_item')}</label>
              <input
                value={materialTitle}
                placeholder={t('material_request_item_placeholder')}
                onChange={(e) => setMaterialTitle(e.target.value)}
              />
              <label>{t('material_request_details')}</label>
              <textarea
                value={materialDetails}
                placeholder={t('material_request_details_placeholder')}
                onChange={(e) => setMaterialDetails(e.target.value)}
              />
              <div className="row material-request-actions">
                <button className="btn small" disabled={materialBusy || !materialTitle.trim()}>
                  {materialBusy ? t('saving') : t('material_request_create')}
                </button>
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={materialBusy}
                  onClick={() => setMaterialFormOpen(false)}
                >
                  {t('cancel')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
      {loading && <div className="card center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('hub_tasks_load_error')}</p>}
      {!loading && !loadError && tasks.length === 0 && <div className="card muted">{t('no_tasks')}</div>}

      {tasks.map((task) => {
        const photo = photoByTask[task.id]
        const needsPhoto = Boolean(task.requires_photo && !photo)
        const uploading = photoBusy === task.id
        return (
          <div key={task.id} className="card task-card hub-task-card">
            <div className="row task-card-head">
              <div>
                <span className={`badge ${priorityTone(task.priority)}`}>{taskIcon(task)}</span>{' '}
                <span className="task-title">{task.title}</span>
              </div>
              {task.requires_photo && <span className="badge amber">{t('photo_required')}</span>}
            </div>
            {task.description && <p className="muted task-description">{task.description}</p>}

            {task.requires_photo && (
              <>
                <input
                  id={`hub-photo-${task.id}`}
                  className="photo-input"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  disabled={uploading || taskBusy !== null}
                  onChange={(e) => {
                    addPhoto(task, e.target.files?.[0])
                    e.currentTarget.value = ''
                  }}
                />
                <label className={`camera-button ${uploading ? 'disabled' : ''}`} htmlFor={`hub-photo-${task.id}`}>
                  <span className="camera-icon">📷</span>
                  <span>{uploading ? t('photo_uploading') : photo ? t('photo_replace') : t('photo_add')}</span>
                </label>
                {photo ? (
                  <>
                    <img className="task-photo-preview" src={photo.preview_url} alt={t('photo_preview')} />
                    <MediaComments mediaId={photo.id} />
                  </>
                ) : (
                  <p className="muted task-photo-hint">{t('photo_required_hint')}</p>
                )}
              </>
            )}

            {isMaterialFlowTask(task) ? (
              <MaterialStatusChain
                task={task}
                peopleById={peopleById}
                busy={taskBusy !== null}
                onStatusChange={updateMaterialStatus}
              />
            ) : (
              <>
                <button
                  className="btn ghost small"
                  disabled={taskBusy !== null || uploading || needsPhoto}
                  title={needsPhoto ? t('task_done_needs_photo') : undefined}
                  onClick={() => done(task)}
                >
                  {t('done')}
                </button>
                {needsPhoto && <p className="warn-msg task-photo-hint">{t('task_done_needs_photo')}</p>}
              </>
            )}
          </div>
        )
      })}
    </section>
  )
}
