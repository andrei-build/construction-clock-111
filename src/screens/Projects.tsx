import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getProjects, getOpenTasks, getProjectProfit, getProjectClientRatings, createProject, markTaskDone, uploadTaskPhoto, validateUpload, uploadErrorCode, captureGPS } from '../lib/api'
import { isManagerWrite } from '../lib/types'
import { GPS_RADIUS_MIN, GPS_RADIUS_MAX, GPS_RADIUS_STEP, clampGpsRadius } from '../lib/geofence'
import type { Project, ProjectProfit, Task, TaskMedia } from '../lib/types'
import MediaComments from '../components/MediaComments'
import { deadlineStatus, statusDotClass } from './ProjectHub'

export default function Projects() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [profits, setProfits] = useState<ProjectProfit[]>([])
  const [clientRatings, setClientRatings] = useState<Map<string, string>>(new Map())
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [gpsRadius, setGpsRadius] = useState('')
  const [geoBusy, setGeoBusy] = useState(false)
  const [geoError, setGeoError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [taskBusy, setTaskBusy] = useState<string | null>(null)
  const [photoBusy, setPhotoBusy] = useState<string | null>(null)
  const [photoByTask, setPhotoByTask] = useState<Record<string, TaskMedia>>({})
  const [taskError, setTaskError] = useState<string | null>(null)

  const load = () => Promise.all([getProjects(), getOpenTasks(), getProjectProfit(), getProjectClientRatings()])
    .then(([p, tk, pf, cr]) => { setProjects(p); setTasks(tk); setProfits(pf); setClientRatings(cr) })
  useEffect(() => { load() }, [profile?.id])

  const canWrite = profile ? isManagerWrite(profile.role) : false

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !name.trim()) return
    setBusy(true)
    try {
      const latNum = lat.trim() === '' ? undefined : Number(lat)
      const lngNum = lng.trim() === '' ? undefined : Number(lng)
      const radiusNum = gpsRadius.trim() === '' ? undefined : clampGpsRadius(Number(gpsRadius), GPS_RADIUS_MIN)
      await createProject(profile, name.trim(), address.trim(), latNum, lngNum, radiusNum)
      setName(''); setAddress(''); setLat(''); setLng(''); setGpsRadius(''); setGeoError(false); setAdding(false)
      await load()
    } catch { /* показывается пустым — RLS не пустит не-менеджера */ }
    setBusy(false)
  }

  // Копировать проект как шаблон: переносим name (+ « (copy)»), address, gps_radius_m.
  // ЯВНО НЕ переносим геопривязку смены (lat/lng/site_point) — поля координат оставляем пустыми.
  const copyProject = (src: Project) => {
    setName(`${src.name} (copy)`)
    setAddress(src.address ?? '')
    setLat(''); setLng('')
    setGpsRadius(src.gps_radius_m != null ? String(src.gps_radius_m) : '')
    setGeoError(false)
    setAdding(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const useMyLocation = async () => {
    setGeoBusy(true)
    setGeoError(false)
    try {
      const geo = await captureGPS()
      if (geo.status === 'off' || geo.lat === null || geo.lng === null) {
        setGeoError(true)
        return
      }
      setLat(String(geo.lat)); setLng(String(geo.lng))
    } finally {
      setGeoBusy(false)
    }
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
    try {
      validateUpload(file, 'photo')
    } catch (err) {
      setTaskError(uploadErrorCode(err) ?? 'photo_upload_failed')
      return
    }
    setPhotoBusy(task.id)
    setTaskError(null)
    try {
      const media = await uploadTaskPhoto(profile, task, file)
      setPhotoByTask((current) => ({ ...current, [task.id]: media }))
    } catch (err) {
      setTaskError(uploadErrorCode(err) ?? 'photo_upload_failed')
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
          <div className="row coord-row">
            <div className="coord-field">
              <label>{t('project_lat')}</label>
              <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
            </div>
            <div className="coord-field">
              <label>{t('project_lng')}</label>
              <input inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} />
            </div>
          </div>
          <label>{t('project_gps_radius')}</label>
          <input
            type="number"
            min={GPS_RADIUS_MIN}
            max={GPS_RADIUS_MAX}
            step={GPS_RADIUS_STEP}
            inputMode="numeric"
            value={gpsRadius}
            onChange={(e) => setGpsRadius(e.target.value)}
          />
          <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>{t('gps_radius_hint')}</p>
          <button type="button" className="btn ghost small" disabled={geoBusy} onClick={useMyLocation}>
            {geoBusy ? t('locating') : t('use_my_location')}
          </button>
          {geoError && <p className="error-msg">{t('location_unavailable')}</p>}
          <button className="btn" disabled={busy || !name.trim()}>{t('create')}</button>
        </form>
      )}

      {projects.map((p) => {
        const ptasks = tasks.filter((tk) => tk.project_id === p.id)
        const profit = profitFor(p.id)
        const showProfit = profit?.margin_pct !== null && profit?.margin_pct !== undefined && profit.profit_status && profit.profit_status !== 'grey'
        const dl = deadlineStatus(p.end_date)
        const rating = (p.client_account_id ? clientRatings.get(p.client_account_id) : undefined) as 'green' | 'amber' | 'red' | undefined
        return (
          <div key={p.id} className="card">
            <div className="project-title-row">
              <span className="project-row-dots" aria-hidden="true">
                <span className={statusDotClass(dl)} title={t('hub_deadline')} />
                <span className={statusDotClass(rating ?? 'neutral')} title={t('hub_client_rating')} />
              </span>
              <button className="inline-link project-name-link" onClick={() => navigate(`/projects/${p.id}`)}>{p.name}</button>
              {canWrite && (
                <button className="btn ghost small project-copy-btn" title={t('copy_project')} aria-label={t('copy_project')} onClick={() => copyProject(p)}>📋</button>
              )}
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
