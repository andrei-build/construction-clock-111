import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getProjects, getOpenTasks, getProjectProfit, createProject, markTaskDone, uploadTaskPhoto } from '../lib/api'
import { isManagerWrite } from '../lib/types'
import type { Project, ProjectProfit, Task, TaskMedia } from '../lib/types'
import { useEntityDrawer } from '../components/EntityDrawer'

export default function Projects() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const { openProject } = useEntityDrawer()
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [profits, setProfits] = useState<ProjectProfit[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [taskBusy, setTaskBusy] = useState<string | null>(null)
  const [photoBusy, setPhotoBusy] = useState<string | null>(null)
  const [photoByTask, setPhotoByTask] = useState<Record<string, TaskMedia>>({})
  const [taskError, setTaskError] = useState<string | null>(null)

  const load = () => Promise.all([getProjects(), getOpenTasks(), getProjectProfit()])
    .then(([p, tk, pf]) => { setProjects(p); setTasks(tk); setProfits(pf) })
  useEffect(() => { load() }, [profile?.id])

  const canWrite = profile ? isManagerWrite(profile.role) : false

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !name.trim()) return
    setBusy(true)
    try {
      await createProject(profile, name.trim(), address.trim())
      setName(''); setAddress(''); setAdding(false)
      await load()
    } catch { /* показывается пустым — RLS не пустит не-менеджера */ }
    setBusy(false)
  }

  const done = async (task: Task) => {
    if (!profile) return
    const mediaId = photoByTask[task.id]?.id ?? null
    if (task.requires_photo && !mediaId) return
    setTaskBusy(task.id)
    setTaskError(null)
    try {
      await markTaskDone(profile, task, mediaId)
      await load()
    } catch {
      setTaskError('error')
    } finally {
      setTaskBusy(null)
    }
  }

  const addPhoto = async (task: Task, file: File | undefined) => {
    if (!profile || !file || photoBusy) return
    if (!file.type.startsWith('image/')) {
      setTaskError('photo_upload_failed')
      return
    }
    setPhotoBusy(task.id)
    setTaskError(null)
    try {
      const media = await uploadTaskPhoto(profile, task, file)
      setPhotoByTask((current) => ({ ...current, [task.id]: media }))
    } catch {
      setTaskError('photo_upload_failed')
    } finally {
      setPhotoBusy(null)
    }
  }

  const prio = (p: Task['priority']) => p === 'urgent' ? 'red' : p === 'high' ? 'amber' : 'blue'
  const profitFor = (projectId: string) => profits.find((p) => p.project_id === projectId)
  const formatMargin = (value: number) => `${Math.round(value * 10) / 10}%`

  return (
    <div className="screen">
      <h1>📁 {t('projects')}</h1>
      {taskError && <p className="error-msg">{t(taskError)}</p>}

      {canWrite && !adding && (
        <button className="btn ghost small" onClick={() => setAdding(true)}>+ {t('add_project')}</button>
      )}
      {adding && (
        <form onSubmit={submit} className="card">
          <label>{t('name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>{t('address')}</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
          <button className="btn" disabled={busy || !name.trim()}>{t('create')}</button>
        </form>
      )}

      {projects.map((p) => {
        const ptasks = tasks.filter((tk) => tk.project_id === p.id)
        const profit = profitFor(p.id)
        const showProfit = profit?.margin_pct !== null && profit?.margin_pct !== undefined && profit.profit_status && profit.profit_status !== 'grey'
        return (
          <div key={p.id} className="card">
            <div className="project-title-row">
              <button className="inline-link project-name-link" onClick={() => openProject(p)}>{p.name}</button>
              {showProfit && (
                <span className={`profit-badge ${profit.profit_status}`}>
                  <span className="profit-dot" />
                  {formatMargin(profit.margin_pct!)}
                </span>
              )}
            </div>
            <div className="muted">{p.address}</div>
            {ptasks.length > 0 && <h2>{t('tasks')}</h2>}
            {ptasks.map((tk) => {
              const photo = photoByTask[tk.id]
              const needsPhoto = Boolean(tk.requires_photo && !photo)
              const uploading = photoBusy === tk.id
              return (
                <div key={tk.id} className="task-card">
                  <div className="row task-card-head">
                    <div>
                      <span className={`badge ${prio(tk.priority)}`}>{tk.task_type === 'delivery' ? '🚚' : tk.task_type === 'material' ? '📦' : '🔨'}</span>{' '}
                      <span className="task-title">{tk.title}</span>
                    </div>
                    {tk.requires_photo && <span className="badge amber">{t('photo_required')}</span>}
                  </div>

                  {tk.requires_photo && (
                    <>
                      <input
                        id={`photo-${tk.id}`}
                        className="photo-input"
                        type="file"
                        accept="image/*"
                        capture="environment"
                        disabled={uploading || taskBusy !== null}
                        onChange={(e) => {
                          addPhoto(tk, e.target.files?.[0])
                          e.currentTarget.value = ''
                        }}
                      />
                      <label className={`camera-button ${uploading ? 'disabled' : ''}`} htmlFor={`photo-${tk.id}`}>
                        <span className="camera-icon">📷</span>
                        <span>{uploading ? t('photo_uploading') : photo ? t('photo_replace') : t('photo_add')}</span>
                      </label>
                      {photo ? (
                        <img className="task-photo-preview" src={photo.preview_url} alt={t('photo_preview')} />
                      ) : (
                        <p className="muted task-photo-hint">{t('photo_required_hint')}</p>
                      )}
                    </>
                  )}

                  <button
                    className="btn ghost small"
                    disabled={taskBusy !== null || uploading || needsPhoto}
                    title={needsPhoto ? t('photo_required_hint') : undefined}
                    onClick={() => done(tk)}
                  >
                    {t('done')}
                  </button>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
