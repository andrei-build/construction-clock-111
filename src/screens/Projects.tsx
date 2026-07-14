import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  getProjects,
  getOpenTasks,
  getProjectProfit,
  getProjectClientRatings,
  getTeam,
  getTodayEvents,
  createProject,
  updateProject,
  markMaterialStatus,
  markTaskDone,
  subscribeToTaskChanges,
  uploadTaskPhoto,
  validateUpload,
  uploadErrorCode,
  captureGPS,
  type MaterialStatusAction,
} from '../lib/api'
import { enqueueFieldAction } from '../lib/offlineFieldActions'
import { enqueueMediaUpload } from '../lib/offlineMediaQueue'
import { isManagerWrite } from '../lib/types'
import { GPS_RADIUS_MIN, GPS_RADIUS_MAX, GPS_RADIUS_STEP, clampGpsRadius } from '../lib/geofence'
import type { Profile, Project, ProjectProfit, Task, TaskMedia } from '../lib/types'
import { isEffectiveOpenTask } from '../lib/task-status'
import MediaComments from '../components/MediaComments'
import MaterialStatusChain, { isMaterialFlowTask } from '../components/MaterialStatusChain'
import { getDeadlineInfo, statusDotClass } from './project-hub/status'
import { formatProjectCountdown } from '../lib/project-schedule'

// F29: разбираем вставленную пару «широта, долгота» ("47.61, -122.33", "47.61 -122.33").
// Терпим пробелы, знак градуса и ведущую метку до двоеточия; null, если это не чистая валидная пара.
function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine
}

function isNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /failed to fetch|networkerror|network|fetch|load failed/i.test(message)
}

export function parsePastedCoordinatePair(text: string): { lat: number; lng: number } | null {
  if (!text) return null
  let s = text.trim()
  const colon = s.lastIndexOf(':')
  if (colon !== -1) s = s.slice(colon + 1).trim()
  const parts = s.replace(/°/g, ' ').split(/[\s,]+/).filter(Boolean)
  if (parts.length !== 2) return null
  const lat = Number(parts[0])
  const lng = Number(parts[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

export default function Projects() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [profits, setProfits] = useState<ProjectProfit[]>([])
  const [clientRatings, setClientRatings] = useState<Map<string, string>>(new Map())
  // PROJ-1: сколько человек сегодня отметилось на объекте (check_in за сегодня), по проекту.
  // Один общий запрос getTodayEvents() на весь список — НЕ N+1.
  const [peopleTodayByProject, setPeopleTodayByProject] = useState<Map<string, number>>(new Map())
  const [adding, setAdding] = useState(false)
  // F76: id редактируемого проекта (null — форма в режиме создания).
  const [editingId, setEditingId] = useState<string | null>(null)
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
  // F64: non-error notice for an action queued while offline (shown with a warn tone).
  const [taskNotice, setTaskNotice] = useState<string | null>(null)

  const load = async () => {
    const [p, tk, pf, people, todayEv] = await Promise.all([
      getProjects(), getOpenTasks(), getProjectProfit(), getTeam(), getTodayEvents(),
    ])
    const accountIds = p.map((project) => project.client_account_id).filter(Boolean) as string[]
    const cr = await getProjectClientRatings(accountIds)
    // Уникальные работники, отметившиеся сегодня (check_in) на каждом объекте.
    const byProject = new Map<string, Set<string>>()
    for (const ev of todayEv) {
      if (ev.event_type !== 'check_in' || !ev.project_id) continue
      const set = byProject.get(ev.project_id) ?? new Set<string>()
      set.add(ev.profile_id)
      byProject.set(ev.project_id, set)
    }
    const peopleToday = new Map<string, number>()
    for (const [projectId, set] of byProject) peopleToday.set(projectId, set.size)
    setProjects(p); setTasks(tk); setProfits(pf); setTeam(people); setClientRatings(cr)
    setPeopleTodayByProject(peopleToday)
  }
  useEffect(() => { load() }, [profile?.id])
  useEffect(() => {
    if (!profile?.org_id) return
    return subscribeToTaskChanges(profile.org_id, () => { void load() }, 'tasks:projects')
  }, [profile?.org_id])

  const canWrite = profile ? isManagerWrite(profile.role) : false
  const peopleById = useMemo(() => new Map(team.map((person) => [person.id, person.name])), [team])

  const resetForm = () => {
    setName(''); setAddress(''); setLat(''); setLng(''); setGpsRadius(''); setGeoError(false)
    setAdding(false); setEditingId(null)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !name.trim()) return
    setBusy(true)
    try {
      const latNum = lat.trim() === '' ? undefined : Number(lat)
      const lngNum = lng.trim() === '' ? undefined : Number(lng)
      const radiusNum = gpsRadius.trim() === '' ? undefined : clampGpsRadius(Number(gpsRadius), GPS_RADIUS_MIN)
      if (editingId) {
        // F76: пишем ТОЛЬКО name/address/gps_radius_m + site_point (если введены новые координаты).
        await updateProject(profile, editingId, { name: name.trim(), address: address.trim(), lat: latNum, lng: lngNum, gpsRadiusM: radiusNum })
      } else {
        await createProject(profile, name.trim(), address.trim(), latNum, lngNum, radiusNum)
      }
      resetForm()
      await load()
    } catch { /* показывается пустым — RLS не пустит не-менеджера */ }
    setBusy(false)
  }

  // F76: prefill формы из текущего проекта. Координаты НЕ префилятся: site_point на клиенте
  // лежит как PostGIS hex EWKB и надёжно не парсится — оставляем lat/lng пустыми; site_point
  // перезапишется ТОЛЬКО если менеджер введёт/захватит новые координаты (см. updateProject).
  const startEdit = (src: Project) => {
    setEditingId(src.id)
    setAdding(false)
    setName(src.name)
    setAddress(src.address ?? '')
    setLat(''); setLng('')
    setGpsRadius(src.gps_radius_m != null ? String(src.gps_radius_m) : '')
    setGeoError(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Копировать проект как шаблон: переносим name (+ « (copy)»), address, gps_radius_m.
  // ЯВНО НЕ переносим геопривязку смены (lat/lng/site_point) — поля координат оставляем пустыми.
  const copyProject = (src: Project) => {
    setName(`${src.name} (copy)`)
    setAddress(src.address ?? '')
    setLat(''); setLng('')
    setGpsRadius(src.gps_radius_m != null ? String(src.gps_radius_m) : '')
    setGeoError(false)
    setEditingId(null)
    setAdding(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // F29: если вставленный текст — валидная пара «широта, долгота», заполняем оба поля.
  // Иначе не мешаем обычной вставке (можно вставить одно число в одно поле).
  const onPasteCoords = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pair = parsePastedCoordinatePair(e.clipboardData.getData('text'))
    if (!pair) return
    e.preventDefault()
    setLat(String(pair.lat)); setLng(String(pair.lng))
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
    if (!profile || isMaterialFlowTask(task)) return
    const mediaId = photoByTask[task.id]?.id ?? null
    if (task.requires_photo && !mediaId) return
    setTaskBusy(task.id)
    setTaskError(null)
    setTaskNotice(null)
    // F64: offline / network drop — queue the status change and reflect it optimistically
    // so the task leaves the open list; it replays on reconnect. done_at is authoritative
    // for isEffectiveOpenTask, so setting it locally hides the task without a refetch.
    const queueOffline = () => {
      enqueueFieldAction({ kind: 'task_status', dedupeKey: `task_status:${task.id}`, payload: { task, mediaId } })
      setTasks((rows) => rows.map((r) => (r.id === task.id ? { ...r, status: 'done', done_at: new Date().toISOString() } : r)))
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
      await load()
    } catch {
      setTaskError('material_status_failed')
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
    // F51: offline / network drop — store the photo in the durable media queue and replay the
    // real upload on reconnect instead of losing it. No mediaId exists until replay, so this
    // deliberately does NOT populate photoByTask: a requires_photo task still cannot be marked
    // done offline (that F64 coupling is untouched). The online path below stays byte-identical.
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
      // A non-network error (validation / permission) still surfaces; never silently queue it.
      if (!code && (!isOnline() || isNetworkError(err))) { queueOffline(); return }
      setTaskError(code ?? 'photo_upload_failed')
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
      {taskNotice && <p className="warn-msg">{t(taskNotice)}</p>}

      {canWrite && !adding && !editingId && (
        <button className="btn ghost small" onClick={() => setAdding(true)}>+ {t('add_project')}</button>
      )}
      {(adding || editingId) && (
        <form onSubmit={submit} className="card">
          {editingId && <h2 style={{ marginTop: 0 }}>{t('edit_project')}</h2>}
          <label>{t('name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>{t('address')}</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
          <div className="row coord-row">
            <div className="coord-field">
              <label>{t('project_lat')}</label>
              <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} onPaste={onPasteCoords} />
            </div>
            <div className="coord-field">
              <label>{t('project_lng')}</label>
              <input inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} onPaste={onPasteCoords} />
            </div>
          </div>
          <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>{t('coord_paste_hint')}</p>
          {editingId && <p className="muted" style={{ marginTop: -6, marginBottom: 10 }}>{t('edit_coords_hint')}</p>}
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
          <div className="row">
            <button className="btn" disabled={busy || !name.trim()}>{editingId ? t('save_changes') : t('create')}</button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={resetForm}>{t('cancel')}</button>
          </div>
        </form>
      )}

      {projects.map((p) => {
        // done_at авторитетнее status: строку с проставленным done_at, но отставшим
        // status в список открытых не пускаем (паритет с Check Time, F81).
        const ptasks = tasks.filter((tk) => tk.project_id === p.id && isEffectiveOpenTask(tk))
        const profit = profitFor(p.id)
        const showProfit = profit?.margin_pct !== null && profit?.margin_pct !== undefined && profit.profit_status && profit.profit_status !== 'grey'
        const dl = getDeadlineInfo(p).status
        const countdown = p.end_date ? formatProjectCountdown(p.end_date) : ''
        const rating = (p.client_account_id ? clientRatings.get(p.client_account_id) : undefined) as 'green' | 'amber' | 'red' | undefined
        const peopleToday = peopleTodayByProject.get(p.id) ?? 0
        return (
          <div key={p.id} className="card">
            <div className="project-title-row">
              <button className="inline-link project-name-link" onClick={() => navigate(`/projects/${p.id}`)}>{p.name}</button>
              {canWrite && (
                <button className="btn ghost small project-copy-btn" title={t('copy_project')} aria-label={t('copy_project')} onClick={() => copyProject(p)}>📋</button>
              )}
              {canWrite && (
                <button className="btn ghost small project-copy-btn" title={t('edit_project')} aria-label={t('edit_project')} onClick={() => startEdit(p)}>✏️</button>
              )}
              {showProfit && (
                <span className={`profit-badge ${profit.profit_status}`}>
                  <span className="profit-dot" />
                  {formatMargin(profit.margin_pct!)}
                </span>
              )}
              <span className="project-row-dots" aria-hidden="true">
                <span className={statusDotClass(dl)} title={t('hub_deadline')} />
                <span className={statusDotClass(rating ?? 'neutral')} title={t('hub_client_rating')} />
              </span>
              {countdown && <span className={`schedule-countdown-badge ${dl}`}>{countdown}</span>}
            </div>
            <div className="project-card-meta">
              {p.address && <span className="muted project-card-address">📍 {p.address}</span>}
              <span
                className="project-card-chip"
                title={t('projects_card_open_tasks').replace('{n}', String(ptasks.length))}
              >
                🔨 {ptasks.length}
              </span>
              {peopleToday > 0 && (
                <span
                  className="project-card-chip on-site"
                  title={t('projects_card_people_today').replace('{n}', String(peopleToday))}
                >
                  👷 {peopleToday}
                </span>
              )}
            </div>
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
                  {tk.description && <p className="muted task-description">{tk.description}</p>}

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

                  {isMaterialFlowTask(tk) ? (
                    <MaterialStatusChain
                      task={tk}
                      peopleById={peopleById}
                      busy={taskBusy !== null}
                      onStatusChange={updateMaterialStatus}
                    />
                  ) : (
                    <button
                      className="btn ghost small"
                      disabled={taskBusy !== null || uploading || needsPhoto}
                      title={needsPhoto ? t('photo_required_hint') : undefined}
                      onClick={() => done(tk)}
                    >
                      {t('done')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
