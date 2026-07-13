import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  createProjectNote,
  getAccountRating,
  getProjectById,
  getProjectFileDownloadUrl,
  getProjectFiles,
  getProjectNotes,
  getProjectPhotos,
  getProjectProfit,
  softDeleteFile,
  softDeleteProjectNote,
  toggleProjectNotePinned,
  uploadProjectFileToR2,
} from '../lib/api'
import { isManagerWrite } from '../lib/types'
import type { AccountRating, FileRow, GalleryPhoto, Project, ProjectNote, ProjectProfit } from '../lib/types'

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
  const [files, setFiles] = useState<FileRow[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesError, setFilesError] = useState(false)
  const [filesLoadedFor, setFilesLoadedFor] = useState<string | null>(null)
  const [activePhoto, setActivePhoto] = useState<GalleryPhoto | null>(null)
  const [uploading, setUploading] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)

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
        const [ph, fs] = await Promise.all([getProjectPhotos(id), getProjectFiles(id)])
        if (mounted) {
          setPhotos(ph)
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
    } catch {
      setFileError('hub_file_upload_failed')
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

  const dl = deadlineStatus(project?.end_date)
  const profit = profits.find((row) => row.project_id === id)
  const profitKnown = profit?.profit_status && profit.profit_status !== 'grey'
  const marginStatus = profitKnown ? (profit!.profit_status as 'green' | 'amber' | 'red') : 'neutral'
  const marginLabel = profit?.margin_pct === null || profit?.margin_pct === undefined ? '—' : `${Math.round(profit.margin_pct * 10) / 10}%`
  const ratingStatus = rating?.client_rating ?? 'neutral'

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

                  <div className="hub-files-docs-head">
                    <h2 className="hub-files-heading">{t('hub_files_documents')}</h2>
                    {canManage && (
                      <label className="btn small hub-files-upload">
                        {uploading ? t('hub_files_uploading') : t('hub_files_upload')}
                        <input type="file" hidden disabled={uploading} onChange={onUpload} />
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
            </section>
          )}

          {/* Прочие вкладки — заглушки под будущие этапы (Time/Finance/Reports/Client) */}
          {tab !== 'overview' && tab !== 'notes' && tab !== 'files' && (
            <section className="hub-placeholder">
              <h2>{t(HUB_TABS.find((tabDef) => tabDef.key === tab)!.labelKey)}</h2>
              <div className="card center muted">{t('hub_coming_soon')}</div>
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
