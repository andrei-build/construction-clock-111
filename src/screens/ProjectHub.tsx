import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  createProjectNote,
  getAccountRating,
  getProjectById,
  getProjectNotes,
  getProjectProfit,
  softDeleteProjectNote,
  toggleProjectNotePinned,
} from '../lib/api'
import type { AccountRating, Project, ProjectNote, ProjectProfit } from '../lib/types'

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

          {/* Прочие вкладки — заглушки под будущие этапы (Time/Finance/Files/Reports/Client) */}
          {tab !== 'overview' && tab !== 'notes' && (
            <section className="hub-placeholder">
              <h2>{t(HUB_TABS.find((tabDef) => tabDef.key === tab)!.labelKey)}</h2>
              <div className="card center muted">{t('hub_coming_soon')}</div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
