import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  createProjectGrant,
  createProjectNote,
  getAccountById,
  getAccountContacts,
  getAccountRating,
  getProjectById,
  getProjectDailyReports,
  getProjectDocuments,
  getProjectFileDownloadUrl,
  getProjectFiles,
  getProjectGrants,
  getProjectIntervals,
  getProjectNotes,
  getProjectPhotos,
  getProjectProfit,
  getProjectVideos,
  getTeam,
  revokeProjectGrant,
  softDeleteFile,
  softDeleteProjectNote,
  toggleProjectNotePinned,
  uploadErrorCode,
  uploadProjectFileToR2,
} from '../lib/api'
import { buildDirectionsUrl } from '../lib/project-navigation'
import { isManagerWrite } from '../lib/types'
import { isBrowserUnsafeVideo } from '../lib/media-playback'
import type { Account, AccountRating, ClientGrant, Contact, DailyReport, DocumentRow, FileRow, GalleryPhoto, GalleryVideo, Project, ProjectNote, ProjectProfit, WorkInterval } from '../lib/types'

// Светофор дедлайна по projects.end_date — считаем на клиенте (день в день):
//   red — просрочен (сегодня > end_date), amber — до дедлайна ≤7 дней (включительно),
//   green — больше 7 дней, neutral — дедлайн не задан.
export type DeadlineStatus = 'red' | 'amber' | 'green' | 'neutral'
export function deadlineStatus(endDate: string | null | undefined): DeadlineStatus {
  if (!endDate) return 'neutral'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const end = new Date(`${endDate}T00:00:00`)
  end.setHours(0, 0, 0, 0)
  const diffDays = Math.round((end.getTime() - today.getTime()) / 86400000)
  if (diffDays < 0) return 'red'
  if (diffDays <= 7) return 'amber'
  return 'green'
}

// Класс кружка-светофора: neutral — без модификатора (серый по умолчанию).
export function statusDotClass(status: 'green' | 'amber' | 'red' | 'neutral') {
  return status === 'neutral' ? 'status-dot' : `status-dot ${status}`
}

const DEADLINE_LABEL: Record<DeadlineStatus, string> = {
  red: 'hub_deadline_overdue',
  amber: 'hub_deadline_due_soon',
  green: 'hub_deadline_on_schedule',
  neutral: 'hub_deadline_none',
}

type HubTab = 'overview' | 'time' | 'finance' | 'files' | 'reports' | 'notes' | 'client'
type MediaBucket = 'all' | 'photos' | 'videos' | 'documents'
const HUB_TABS: { key: HubTab; labelKey: string }[] = [
  { key: 'overview', labelKey: 'hub_tab_overview' },
  { key: 'time', labelKey: 'hub_tab_time' },
  { key: 'finance', labelKey: 'hub_tab_finance' },
  { key: 'files', labelKey: 'hub_tab_files' },
  { key: 'reports', labelKey: 'hub_tab_reports' },
  { key: 'notes', labelKey: 'hub_tab_notes' },
  { key: 'client', labelKey: 'hub_tab_client' },
]

function sortNotes(rows: ProjectNote[]) {
  return [...rows].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at.localeCompare(a.created_at))
}

// Человекочитаемый размер файла: B / KB / MB.
function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

// Длительность интервала в часах. Открытая смена (end_at null) — считаем до текущего момента.
function intervalHours(interval: WorkInterval): number {
  const end = interval.end_at ? new Date(interval.end_at).getTime() : Date.now()
  const start = new Date(interval.start_at).getTime()
  const hours = (end - start) / 3600000
  return hours > 0 ? hours : 0
}

function formatHours(hours: number): string {
  return `${Math.round(hours * 10) / 10}`
}

function formatMoney(value: number | null | undefined): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value ?? 0)
}

export default function ProjectHub() {
  const { id } = useParams()
  const { profile } = useAuth()
  const { t } = useI18n()
  const [project, setProject] = useState<Project | null>(null)
  const [profits, setProfits] = useState<ProjectProfit[]>([])
  const [rating, setRating] = useState<AccountRating | null>(null)
  const [notes, setNotes] = useState<ProjectNote[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [tab, setTab] = useState<HubTab>('overview')

  const [noteBody, setNoteBody] = useState('')
  const [notePinned, setNotePinned] = useState(false)
  const [noteBusy, setNoteBusy] = useState(false)
  const [noteError, setNoteError] = useState<string | null>(null)

  // Вкладка «Файлы и медиа»: фото объекта (Supabase Storage) + документы (R2). Грузим лениво по id.
  const canManage = profile ? isManagerWrite(profile.role) : false
  const [photos, setPhotos] = useState<GalleryPhoto[]>([])
  const [videos, setVideos] = useState<GalleryVideo[]>([])
  const [files, setFiles] = useState<FileRow[]>([])
  // Подвкладки внутри «Файлы и медиа»: все / фото / видео / документы (паритет со старым CT).
  const [mediaBucket, setMediaBucket] = useState<MediaBucket>('all')
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesError, setFilesError] = useState(false)
  const [filesLoadedFor, setFilesLoadedFor] = useState<string | null>(null)
  const [activePhoto, setActivePhoto] = useState<GalleryPhoto | null>(null)
  const [uploading, setUploading] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

  // Вкладка «Время»: интервалы v_work_intervals + карта имён работников (getTeam). Грузим лениво.
  const [intervals, setIntervals] = useState<WorkInterval[]>([])
  const [workerNames, setWorkerNames] = useState<Map<string, string>>(new Map())
  const [timeLoading, setTimeLoading] = useState(false)
  const [timeError, setTimeError] = useState(false)
  const [timeLoadedFor, setTimeLoadedFor] = useState<string | null>(null)

  // Вкладка «Финансы» (finance-gated): документы проекта. Грузим лениво.
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [financeLoading, setFinanceLoading] = useState(false)
  const [financeError, setFinanceError] = useState(false)
  const [financeLoadedFor, setFinanceLoadedFor] = useState<string | null>(null)

  // Вкладка «Рапорты»: дневные рапорты проекта. Грузим лениво.
  const [reports, setReports] = useState<DailyReport[]>([])
  const [reportsLoading, setReportsLoading] = useState(false)
  const [reportsError, setReportsError] = useState(false)
  const [reportsLoadedFor, setReportsLoadedFor] = useState<string | null>(null)

  // Вкладка «Клиент»: аккаунт клиента + контакты + активные гранты видимости. Грузим лениво.
  const [clientAccount, setClientAccount] = useState<Account | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [grants, setGrants] = useState<ClientGrant[]>([])
  const [clientLoading, setClientLoading] = useState(false)
  const [clientError, setClientError] = useState(false)
  const [clientLoadedFor, setClientLoadedFor] = useState<string | null>(null)
  const [grantSeePresence, setGrantSeePresence] = useState(false)
  const [grantTravel, setGrantTravel] = useState(false)
  const [grantCheckin, setGrantCheckin] = useState(false)
  const [grantCheckout, setGrantCheckout] = useState(false)
  const [grantNote, setGrantNote] = useState('')
  const [grantBusy, setGrantBusy] = useState(false)
  const [grantError, setGrantError] = useState<string | null>(null)

  const load = async () => {
    if (!id) return
    setLoading(true)
    setError(false)
    try {
      const [proj, profitRows, noteRows] = await Promise.all([
        getProjectById(id),
        getProjectProfit(),
        getProjectNotes(id),
      ])
      setProject(proj)
      setProfits(profitRows)
      setNotes(noteRows)
      setRating(proj?.client_account_id ? await getAccountRating(proj.client_account_id) : null)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id, profile?.id])

  const addNote = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !id || !noteBody.trim() || noteBusy) return
    setNoteBusy(true)
    setNoteError(null)
    try {
      const created = await createProjectNote(profile, id, noteBody, notePinned)
      setNotes((rows) => sortNotes([created, ...rows]))
      setNoteBody('')
      setNotePinned(false)
    } catch {
      setNoteError('hub_note_save_failed')
    } finally {
      setNoteBusy(false)
    }
  }

  const togglePin = async (note: ProjectNote) => {
    if (noteBusy) return
    setNoteBusy(true)
    setNoteError(null)
    try {
      await toggleProjectNotePinned(note.id, !note.pinned)
      setNotes((rows) => sortNotes(rows.map((n) => (n.id === note.id ? { ...n, pinned: !n.pinned } : n))))
    } catch {
      setNoteError('hub_note_save_failed')
    } finally {
      setNoteBusy(false)
    }
  }

  const removeNote = async (note: ProjectNote) => {
    if (noteBusy) return
    setNoteBusy(true)
    setNoteError(null)
    try {
      await softDeleteProjectNote(note.id)
      setNotes((rows) => rows.filter((n) => n.id !== note.id))
    } catch {
      setNoteError('hub_note_delete_failed')
    } finally {
      setNoteBusy(false)
    }
  }

  // Ленивая загрузка содержимого вкладки «Файлы»: только когда её открыли, и один раз на проект.
  useEffect(() => {
    if (tab !== 'files' || !id || filesLoadedFor === id) return
    let mounted = true
    ;(async () => {
      setFilesLoading(true)
      setFilesError(false)
      try {
        const [ph, vd, fs] = await Promise.all([getProjectPhotos(id), getProjectVideos(id), getProjectFiles(id)])
        if (mounted) {
          setPhotos(ph)
          setVideos(vd)
          setFiles(fs)
          setFilesLoadedFor(id)
        }
      } catch {
        if (mounted) setFilesError(true)
      } finally {
        if (mounted) setFilesLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [tab, id, filesLoadedFor])

  // Ленивая загрузка вкладки «Время»: интервалы по проекту + имена работников. Один раз на проект.
  useEffect(() => {
    if (tab !== 'time' || !id || timeLoadedFor === id) return
    let mounted = true
    ;(async () => {
      setTimeLoading(true)
      setTimeError(false)
      try {
        const [rows, team] = await Promise.all([getProjectIntervals(id), getTeam()])
        if (mounted) {
          setIntervals(rows)
          setWorkerNames(new Map(team.map((p) => [p.id, p.name])))
          setTimeLoadedFor(id)
        }
      } catch {
        if (mounted) setTimeError(true)
      } finally {
        if (mounted) setTimeLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [tab, id, timeLoadedFor])

  // Ленивая загрузка вкладки «Финансы»: документы проекта. RLS сам скрывает от не-финансов.
  useEffect(() => {
    if (tab !== 'finance' || !id || financeLoadedFor === id) return
    let mounted = true
    ;(async () => {
      setFinanceLoading(true)
      setFinanceError(false)
      try {
        const rows = await getProjectDocuments(id)
        if (mounted) {
          setDocuments(rows)
          setFinanceLoadedFor(id)
        }
      } catch {
        if (mounted) setFinanceError(true)
      } finally {
        if (mounted) setFinanceLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [tab, id, financeLoadedFor])

  // Ленивая загрузка вкладки «Рапорты»: дневные рапорты проекта.
  useEffect(() => {
    if (tab !== 'reports' || !id || reportsLoadedFor === id) return
    let mounted = true
    ;(async () => {
      setReportsLoading(true)
      setReportsError(false)
      try {
        const rows = await getProjectDailyReports(id)
        if (mounted) {
          setReports(rows)
          setReportsLoadedFor(id)
        }
      } catch {
        if (mounted) setReportsError(true)
      } finally {
        if (mounted) setReportsLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [tab, id, reportsLoadedFor])

  // Ленивая загрузка вкладки «Клиент»: аккаунт + контакты + активные гранты. Один раз на проект.
  useEffect(() => {
    if (tab !== 'client' || !id || clientLoadedFor === id) return
    const accountId = project?.client_account_id
    let mounted = true
    ;(async () => {
      setClientLoading(true)
      setClientError(false)
      try {
        if (accountId) {
          const [acc, cts, grs] = await Promise.all([
            getAccountById(accountId),
            getAccountContacts(accountId),
            getProjectGrants(id),
          ])
          if (mounted) {
            setClientAccount(acc)
            setContacts(cts)
            setGrants(grs)
          }
        } else if (mounted) {
          setClientAccount(null)
          setContacts([])
          setGrants([])
        }
        if (mounted) setClientLoadedFor(id)
      } catch {
        if (mounted) setClientError(true)
      } finally {
        if (mounted) setClientLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [tab, id, clientLoadedFor, project?.client_account_id])

  const addGrant = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !id || !project?.client_account_id || grantBusy) return
    setGrantBusy(true)
    setGrantError(null)
    try {
      const created = await createProjectGrant(profile, id, project.client_account_id, {
        can_see_presence: grantSeePresence,
        notify_travel: grantTravel,
        notify_checkin: grantCheckin,
        notify_checkout: grantCheckout,
        note: grantNote.trim() || null,
      })
      setGrants((rows) => [created, ...rows])
      setGrantSeePresence(false)
      setGrantTravel(false)
      setGrantCheckin(false)
      setGrantCheckout(false)
      setGrantNote('')
    } catch {
      setGrantError('hub_grant_add_failed')
    } finally {
      setGrantBusy(false)
    }
  }

  const revokeGrant = async (grant: ClientGrant) => {
    if (!profile || grantBusy) return
    setGrantBusy(true)
    setGrantError(null)
    try {
      await revokeProjectGrant(profile, grant.id)
      setGrants((rows) => rows.filter((g) => g.id !== grant.id))
    } catch {
      setGrantError('hub_grant_revoke_failed')
    } finally {
      setGrantBusy(false)
    }
  }

  // Закрытие лайтбокса по Escape (как в «Галерее»).
  useEffect(() => {
    if (!activePhoto) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActivePhoto(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activePhoto])

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !profile || !id || uploading) return
    setUploading(true)
    setFileError(null)
    try {
      const row = await uploadProjectFileToR2(profile, id, file)
      setFiles((rows) => [row, ...rows])
    } catch (err) {
      setFileError(uploadErrorCode(err) ?? 'hub_file_upload_failed')
    } finally {
      setUploading(false)
    }
  }

  const viewFile = async (file: FileRow) => {
    if (fileBusy) return
    setFileBusy(true)
    setFileError(null)
    try {
      const url = await getProjectFileDownloadUrl(file)
      window.open(url, '_blank', 'noopener')
    } catch {
      setFileError('hub_file_open_failed')
    } finally {
      setFileBusy(false)
    }
  }

  const removeFile = async (file: FileRow) => {
    if (!profile || fileBusy) return
    setFileBusy(true)
    setFileError(null)
    try {
      await softDeleteFile(profile, file.id)
      setFiles((rows) => rows.filter((f) => f.id !== file.id))
    } catch {
      setFileError('hub_file_delete_failed')
    } finally {
      setFileBusy(false)
    }
  }

  // «Маршрут»: ссылка в карты по адресу проекта (или координатам, если заданы числами).
  const directionsUrl = project ? buildDirectionsUrl({ address: project.address, lat: project.lat, lng: project.lng }) : ''

  const dl = deadlineStatus(project?.end_date)
  const profit = profits.find((row) => row.project_id === id)
  const profitKnown = profit?.profit_status && profit.profit_status !== 'grey'
  const marginStatus = profitKnown ? (profit!.profit_status as 'green' | 'amber' | 'red') : 'neutral'
  const marginLabel = profit?.margin_pct === null || profit?.margin_pct === undefined ? '—' : `${Math.round(profit.margin_pct * 10) / 10}%`
  const ratingStatus = rating?.client_rating ?? 'neutral'

  // Вкладка «Время»: суммарные часы по проекту.
  const totalHours = intervals.reduce((sum, iv) => sum + intervalHours(iv), 0)

  // Подвкладки «Файлы и медиа»: счётчики = длины загруженных списков (паритет countProjectMediaCategories).
  const mediaBuckets: { key: MediaBucket; labelKey: string; count: number }[] = [
    { key: 'all', labelKey: 'hub_files_all', count: photos.length + videos.length + files.length },
    { key: 'photos', labelKey: 'hub_files_photos', count: photos.length },
    { key: 'videos', labelKey: 'hub_files_videos', count: videos.length },
    { key: 'documents', labelKey: 'hub_files_documents', count: files.length },
  ]
  const showPhotos = mediaBucket === 'all' || mediaBucket === 'photos'
  const showVideos = mediaBucket === 'all' || mediaBucket === 'videos'
  const showDocuments = mediaBucket === 'all' || mediaBucket === 'documents'

  // Вкладка «Финансы»: гейт (образец Documents.tsx) + суммы-итоги.
  const ownerOrAdmin = profile?.role === 'owner' || profile?.role === 'admin'
  const financeLocked = !financeLoading && !ownerOrAdmin && documents.length === 0
  const estimatesTotal = documents.filter((d) => d.doc_type === 'estimate').reduce((s, d) => s + (d.total ?? 0), 0)
  const invoicesTotal = documents.filter((d) => d.doc_type === 'invoice').reduce((s, d) => s + (d.total ?? 0), 0)
  const paidTotal = documents.filter((d) => d.status === 'paid').reduce((s, d) => s + (d.total ?? 0), 0)

  return (
    <div className="screen project-hub-screen">
      <div className="worker-detail-head">
        <div>
          <Link className="inline-link muted" to="/projects">← {t('projects')}</Link>
          <h1>{project ? project.name : t('project')}</h1>
          {project?.address && <p className="muted">{project.address}</p>}
        </div>
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {!loading && !project && <div className="card muted">{t('hub_project_not_found')}</div>}

      {!loading && project && (
        <>
          <div className="hub-tabs">
            {HUB_TABS.map((tabDef) => (
              <button
                key={tabDef.key}
                className={tab === tabDef.key ? 'active' : ''}
                onClick={() => setTab(tabDef.key)}
              >
                {t(tabDef.labelKey)}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <section className="hub-overview">
              {directionsUrl && (
                <div className="hub-directions">
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => window.open(directionsUrl, '_blank', 'noopener')}
                  >
                    {t('directions')}
                  </button>
                </div>
              )}

              <div className="card hub-indicator">
                <div className="hub-indicator-head">
                  <span className={statusDotClass(dl)} />
                  <span className="item-title">{t('hub_deadline')}</span>
                </div>
                <div className="muted">{t(DEADLINE_LABEL[dl])}</div>
                {project.end_date && (
                  <div className="muted">{new Date(`${project.end_date}T00:00:00`).toLocaleDateString()}</div>
                )}
              </div>

              <div className="card hub-indicator">
                <div className="hub-indicator-head">
                  <span className={statusDotClass(marginStatus)} />
                  <span className="item-title">{t('project_margin')}</span>
                </div>
                <div className="big num-display">{marginLabel}</div>
                <div className="muted">{profitKnown ? t(`hub_profit_${marginStatus}`) : t('hub_no_data')}</div>
              </div>

              <div className="card hub-indicator">
                <div className="hub-indicator-head">
                  <span className={statusDotClass(ratingStatus)} />
                  <span className="item-title">{t('hub_client_rating')}</span>
                </div>
                <div className="muted">{rating?.client_rating ? t(`hub_rating_${rating.client_rating}`) : t('hub_no_data')}</div>
                {rating?.rating_note && <div className="muted hub-rating-note">{rating.rating_note}</div>}
              </div>
            </section>
          )}

          {tab === 'notes' && (
            <section className="hub-notes">
              <form className="card" onSubmit={addNote}>
                <label>{t('hub_note_new')}</label>
                <textarea value={noteBody} onChange={(e) => setNoteBody(e.target.value)} rows={3} />
                <label className="check-row">
                  <input type="checkbox" checked={notePinned} onChange={(e) => setNotePinned(e.target.checked)} />
                  <span>{t('hub_note_pin')}</span>
                </label>
                {noteError && <p className="error-msg">{t(noteError)}</p>}
                <button className="btn small" disabled={noteBusy || !noteBody.trim()}>{t('hub_note_add')}</button>
              </form>

              {notes.length === 0 && <div className="card muted">{t('hub_notes_empty')}</div>}
              <div className="hub-note-list">
                {notes.map((note) => (
                  <div className={`card hub-note ${note.pinned ? 'pinned' : ''}`} key={note.id}>
                    <div className="hub-note-head">
                      <div>
                        <span className="item-title">{note.author?.name ?? t('hub_note_author_unknown')}</span>
                        <span className="muted"> · {new Date(note.created_at).toLocaleString()}</span>
                      </div>
                      {note.pinned && <span className="badge amber">{t('hub_note_pinned')}</span>}
                    </div>
                    <div className="hub-note-body">{note.body}</div>
                    <div className="row hub-note-actions">
                      <button className="btn ghost small" type="button" disabled={noteBusy} onClick={() => togglePin(note)}>
                        {note.pinned ? t('hub_note_unpin') : t('hub_note_pin_action')}
                      </button>
                      <button className="btn ghost small" type="button" disabled={noteBusy} onClick={() => removeNote(note)}>
                        {t('hub_note_delete')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {tab === 'files' && (
            <section className="hub-files">
              {filesLoading && <div className="card center muted">{t('loading')}</div>}
              {filesError && <p className="error-msg">{t('hub_files_load_error')}</p>}
              {fileError && <p className="error-msg">{t(fileError)}</p>}

              {!filesLoading && !filesError && (
                <>
                  <div className="tabs hub-media-tabs">
                    {mediaBuckets.map((b) => (
                      <button
                        key={b.key}
                        className={mediaBucket === b.key ? 'active' : ''}
                        onClick={() => setMediaBucket(b.key)}
                      >
                        {t(b.labelKey)} <span className="hub-media-count">{b.count}</span>
                      </button>
                    ))}
                  </div>

                  {showPhotos && (
                    <>
                      <h2 className="hub-files-heading">{t('hub_files_photos')}</h2>
                      {photos.length === 0 && <div className="card muted">{t('hub_photos_empty')}</div>}
                      {photos.length > 0 && (
                        <div className="gallery-grid">
                          {photos.map((photo) => (
                            <button
                              key={photo.id}
                              type="button"
                              className="gallery-item"
                              onClick={() => setActivePhoto(photo)}
                              aria-label={photo.filename ?? t('hub_file_view')}
                            >
                              <img src={photo.url} alt={photo.filename ?? ''} loading="lazy" />
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {showVideos && (
                    <>
                      <h2 className="hub-files-heading">{t('hub_files_videos')}</h2>
                      {videos.length === 0 && <div className="card muted">{t('hub_videos_empty')}</div>}
                      {videos.length > 0 && (
                        <div className="gallery-grid">
                          {videos.map((video) => (
                            <div key={video.id} className="gallery-item gallery-video">
                              <video src={video.url} controls preload="metadata" />
                              {isBrowserUnsafeVideo({ filename: video.filename }) && (
                                <p className="video-download-hint">
                                  {t('video_download_hint')}{' '}
                                  <a href={video.url} download={video.filename ?? undefined}>
                                    {t('video_download_link')}
                                  </a>
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {showDocuments && (
                    <>
                      <div className="hub-files-docs-head">
                        <h2 className="hub-files-heading">{t('hub_files_documents')}</h2>
                        {canManage && (
                          <label className="btn small hub-files-upload">
                            {uploading ? t('hub_files_uploading') : t('hub_files_upload')}
                            <input type="file" accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/csv,text/plain" hidden disabled={uploading} onChange={onUpload} />
                          </label>
                        )}
                      </div>

                      {files.length === 0 && <div className="card muted">{t('hub_files_empty')}</div>}
                      <div className="hub-files-list">
                        {files.map((file) => (
                          <div className="card hub-file-row" key={file.id}>
                            <div className="hub-file-info">
                              <span className="item-title">{file.name}</span>
                              <span className="muted">
                                {formatBytes(file.size_bytes)} · {new Date(file.created_at).toLocaleDateString()}
                              </span>
                            </div>
                            <div className="row hub-file-actions">
                              <button className="btn ghost small" type="button" disabled={fileBusy} onClick={() => viewFile(file)}>
                                {t('hub_file_view')}
                              </button>
                              {canManage && (
                                <button className="btn ghost small" type="button" disabled={fileBusy} onClick={() => removeFile(file)}>
                                  {t('hub_file_delete')}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </section>
          )}

          {tab === 'time' && (
            <section className="hub-time">
              {timeLoading && <div className="card center muted">{t('loading')}</div>}
              {timeError && <p className="error-msg">{t('hub_time_load_error')}</p>}
              {!timeLoading && !timeError && (
                <>
                  <div className="card hub-time-summary">
                    <span className="item-title">{t('hub_time_total')}</span>
                    <span className="big num-display">{formatHours(totalHours)} {t('hub_time_hours')}</span>
                  </div>
                  {intervals.length === 0 && <div className="card muted">{t('hub_time_empty')}</div>}
                  <div className="hub-time-list">
                    {intervals.map((iv) => (
                      <div className="card hub-time-row" key={iv.start_event_id}>
                        <div className="hub-time-info">
                          <span className="item-title">{workerNames.get(iv.profile_id) ?? t('hub_worker_unknown')}</span>
                          <span className="muted">
                            {new Date(iv.start_at).toLocaleString()}
                            {iv.end_at ? ` → ${new Date(iv.end_at).toLocaleTimeString()}` : ` · ${t('hub_time_ongoing')}`}
                            {iv.was_adjusted && ` · ${t('hub_time_adjusted')}`}
                          </span>
                        </div>
                        <span className="hub-time-hours">{formatHours(intervalHours(iv))} {t('hub_time_hours')}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {tab === 'finance' && (
            <section className="hub-finance">
              {financeLoading && <div className="card center muted">{t('loading')}</div>}
              {financeError && <p className="error-msg">{t('hub_finance_load_error')}</p>}
              {financeLocked && (
                <div className="card payroll-lock">
                  <div className="big">🔒</div>
                  <div className="item-title">{t('hub_finance_locked')}</div>
                </div>
              )}
              {!financeLoading && !financeError && !financeLocked && (
                <>
                  <div className="hub-finance-totals">
                    <div className="card hub-finance-stat">
                      <span className="muted">{t('hub_finance_estimates_total')}</span>
                      <span className="big num-display">{formatMoney(estimatesTotal)}</span>
                    </div>
                    <div className="card hub-finance-stat">
                      <span className="muted">{t('hub_finance_invoices_total')}</span>
                      <span className="big num-display">{formatMoney(invoicesTotal)}</span>
                    </div>
                    <div className="card hub-finance-stat">
                      <span className="muted">{t('hub_finance_paid_total')}</span>
                      <span className="big num-display">{formatMoney(paidTotal)}</span>
                    </div>
                  </div>
                  {documents.length === 0 && <div className="card muted">{t('hub_finance_empty')}</div>}
                  {documents.length > 0 && (
                    <div className="row hub-finance-link">
                      <Link className="inline-link" to="/documents">{t('hub_finance_open_documents')} →</Link>
                    </div>
                  )}
                  <div className="hub-finance-list">
                    {documents.map((doc) => (
                      <div className="card hub-finance-row" key={doc.id}>
                        <div className="hub-finance-info">
                          <span className="item-title">
                            {doc.number ? `${doc.number} · ` : ''}{doc.title ?? t(`hub_doc_type_${doc.doc_type}`)}
                          </span>
                          <span className="muted">
                            {t(`hub_doc_type_${doc.doc_type}`)} · {t(`hub_doc_status_${doc.status}`)}
                            {doc.issue_date && ` · ${new Date(`${doc.issue_date}T00:00:00`).toLocaleDateString()}`}
                          </span>
                        </div>
                        <span className="hub-finance-total num-display">{formatMoney(doc.total)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {tab === 'reports' && (
            <section className="hub-reports">
              {reportsLoading && <div className="card center muted">{t('loading')}</div>}
              {reportsError && <p className="error-msg">{t('hub_reports_load_error')}</p>}
              {!reportsLoading && !reportsError && (
                <>
                  {reports.length === 0 && <div className="card muted">{t('hub_reports_empty')}</div>}
                  <div className="hub-reports-list">
                    {reports.map((report) => (
                      <div className="card hub-report" key={report.id}>
                        <div className="hub-report-head">
                          <span className="item-title">
                            {new Date(`${report.report_date}T00:00:00`).toLocaleDateString()}
                          </span>
                          <span className="muted"> · {report.author?.name ?? t('hub_report_author_unknown')}</span>
                        </div>
                        <div className="hub-report-body">{report.body}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {/* Вкладка «Клиент»: карточка клиента + гранты видимости присутствия (задача #13). */}
          {tab === 'client' && (
            <section className="hub-client">
              {clientLoading && <div className="card center muted">{t('loading')}</div>}
              {clientError && <p className="error-msg">{t('hub_client_load_error')}</p>}
              {!clientLoading && !clientError && !project.client_account_id && (
                <div className="card muted">{t('hub_client_none')}</div>
              )}
              {!clientLoading && !clientError && project.client_account_id && (
                <>
                  <div className="card hub-client-card">
                    <div className="hub-client-head">
                      <span className={statusDotClass(ratingStatus)} />
                      <span className="item-title">{clientAccount?.name ?? t('hub_client_account')}</span>
                    </div>
                    <div className="muted">
                      {t('hub_client_rating')}: {rating?.client_rating ? t(`hub_rating_${rating.client_rating}`) : t('hub_no_data')}
                    </div>
                    {rating?.rating_note && <div className="muted hub-rating-note">{rating.rating_note}</div>}
                    {clientAccount?.email && <div className="muted">{clientAccount.email}</div>}
                    {clientAccount?.phone && <div className="muted">{clientAccount.phone}</div>}
                  </div>

                  <h2 className="hub-client-heading">{t('hub_client_contacts')}</h2>
                  {contacts.length === 0 && <div className="card muted">{t('hub_client_contacts_empty')}</div>}
                  <div className="hub-client-contacts">
                    {contacts.map((c) => (
                      <div className="card hub-contact-row" key={c.id}>
                        <div className="hub-contact-info">
                          <span className="item-title">
                            {c.name}
                            {c.is_primary && <span className="badge amber hub-contact-badge">{t('hub_client_contact_primary')}</span>}
                          </span>
                          {c.title && <span className="muted">{c.title}</span>}
                          <span className="muted">
                            {[c.email, c.phone].filter(Boolean).join(' · ') || '—'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <h2 className="hub-client-heading">{t('hub_client_notifications')}</h2>
                  {grantError && <p className="error-msg">{t(grantError)}</p>}
                  {grants.length === 0 && <div className="card muted">{t('hub_client_grants_empty')}</div>}
                  <div className="hub-grant-list">
                    {grants.map((g) => {
                      const flags = ([
                        ['can_see_presence', g.can_see_presence],
                        ['notify_travel', g.notify_travel],
                        ['notify_checkin', g.notify_checkin],
                        ['notify_checkout', g.notify_checkout],
                      ] as const).filter(([, on]) => on)
                      return (
                        <div className="card hub-grant-row" key={g.id}>
                          <div className="hub-grant-info">
                            <div className="hub-grant-flags">
                              {flags.length === 0
                                ? <span className="muted">—</span>
                                : flags.map(([key]) => (
                                    <span className="badge hub-grant-flag" key={key}>{t(`hub_grant_${key}`)}</span>
                                  ))}
                            </div>
                            <span className="muted">
                              {t('hub_grant_channel')}: {g.channel}
                              {g.note && ` · ${g.note}`}
                            </span>
                          </div>
                          {canManage && (
                            <button className="btn ghost small" type="button" disabled={grantBusy} onClick={() => revokeGrant(g)}>
                              {t('hub_grant_revoke')}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {canManage && (
                    <form className="card hub-grant-form" onSubmit={addGrant}>
                      <label className="item-title">{t('hub_grant_new')}</label>
                      <label className="check-row">
                        <input type="checkbox" checked={grantSeePresence} onChange={(e) => setGrantSeePresence(e.target.checked)} />
                        <span>{t('hub_grant_can_see_presence')}</span>
                      </label>
                      <label className="check-row">
                        <input type="checkbox" checked={grantTravel} onChange={(e) => setGrantTravel(e.target.checked)} />
                        <span>{t('hub_grant_notify_travel')}</span>
                      </label>
                      <label className="check-row">
                        <input type="checkbox" checked={grantCheckin} onChange={(e) => setGrantCheckin(e.target.checked)} />
                        <span>{t('hub_grant_notify_checkin')}</span>
                      </label>
                      <label className="check-row">
                        <input type="checkbox" checked={grantCheckout} onChange={(e) => setGrantCheckout(e.target.checked)} />
                        <span>{t('hub_grant_notify_checkout')}</span>
                      </label>
                      <label>{t('hub_grant_note')}</label>
                      <textarea value={grantNote} onChange={(e) => setGrantNote(e.target.value)} rows={2} placeholder={t('hub_grant_note_placeholder')} />
                      <button className="btn small" disabled={grantBusy}>{t('hub_grant_add')}</button>
                    </form>
                  )}
                </>
              )}
            </section>
          )}

          {activePhoto && (
            <div className="gallery-lightbox" onClick={() => setActivePhoto(null)}>
              <button
                type="button"
                className="gallery-lightbox-close"
                aria-label={t('gallery_close')}
                onClick={() => setActivePhoto(null)}
              >
                ✕
              </button>
              <img
                src={activePhoto.url}
                alt={activePhoto.filename ?? ''}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
