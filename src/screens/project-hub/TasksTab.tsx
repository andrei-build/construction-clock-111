import { useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { getOpenTasks, markTaskDone, uploadErrorCode, uploadTaskPhoto, validateUpload } from '../../lib/api'
import { enqueueFieldAction } from '../../lib/offlineFieldActions'
import { enqueueMediaUpload } from '../../lib/offlineMediaQueue'
import { isEffectiveOpenTask } from '../../lib/task-status'
import type { Profile, Project, Task, TaskMedia } from '../../lib/types'
import MediaComments from '../../components/MediaComments'

interface TasksTabProps {
  project: Project
  profile: Profile | null
}

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
  const [taskError, setTaskError] = useState<string | null>(null)
  const [taskNotice, setTaskNotice] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const rows = await getOpenTasks()
      setTasks(rows.filter((task) => task.project_id === project.id && isEffectiveOpenTask(task)))
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [project.id])

  const done = async (task: Task) => {
    if (!profile) return
    const mediaId = photoByTask[task.id]?.id ?? null
    if (task.requires_photo && !mediaId) return
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

            <button
              className="btn ghost small"
              disabled={taskBusy !== null || uploading || needsPhoto}
              title={needsPhoto ? t('photo_required_hint') : undefined}
              onClick={() => done(task)}
            >
              {t('done')}
            </button>
          </div>
        )
      })}
    </section>
  )
}
