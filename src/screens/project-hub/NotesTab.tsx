import { useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import VoiceMic from '../../components/VoiceMic'
import { createProjectNote, getProjectNotes, setNotePinned, softDeleteNote } from '../../lib/api'
import { isManagerWrite } from '../../lib/types'
import type { Profile, Project, ProjectNote } from '../../lib/types'

interface NotesTabProps {
  project: Project
  profile: Profile | null
}

function sortNotes(rows: ProjectNote[]) {
  return [...rows].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at.localeCompare(a.created_at))
}

export default function NotesTab({ project, profile }: NotesTabProps) {
  const { t, lang } = useI18n()
  const [notes, setNotes] = useState<ProjectNote[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const canManageNotes = profile ? isManagerWrite(profile.role) : false

  useEffect(() => {
    let mounted = true
    ;(async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const rows = await getProjectNotes(project.id)
        if (mounted) setNotes(sortNotes(rows))
      } catch {
        if (mounted) setLoadError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [project.id])

  const addNote = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || busy || !body.trim()) return
    setBusy(true)
    setError(null)
    try {
      const created = await createProjectNote(profile, project.id, body)
      setNotes((rows) => sortNotes([created, ...rows]))
      setBody('')
    } catch {
      setError('hub_note_save_failed')
    } finally {
      setBusy(false)
    }
  }

  const togglePinned = async (note: ProjectNote) => {
    if (busy || !canManageNotes) return
    setBusy(true)
    setError(null)
    try {
      await setNotePinned(note.id, !note.pinned)
      setNotes((rows) => sortNotes(rows.map((row) => (row.id === note.id ? { ...row, pinned: !row.pinned } : row))))
    } catch {
      setError('hub_note_save_failed')
    } finally {
      setBusy(false)
    }
  }

  const deleteNote = async (note: ProjectNote) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await softDeleteNote(note.id)
      setNotes((rows) => rows.filter((row) => row.id !== note.id))
      setConfirmDeleteId(null)
    } catch {
      setError('hub_note_delete_failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="hub-tab-panel hub-notes">
      <form className="card hub-note-form" onSubmit={addNote}>
        <div className="message-body-label">
          <label>{t('hub_note_new')}</label>
          <VoiceMic lang={lang} title={t('voice_input')} onResult={(text) => setBody((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))} />
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder={t('hub_note_placeholder')} />
        {error && <p className="error-msg">{t(error)}</p>}
        <button className="btn small" disabled={busy || !body.trim()}>{busy ? t('saving') : t('hub_note_add')}</button>
      </form>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('hub_notes_load_error')}</p>}
      {!loading && !loadError && notes.length === 0 && <div className="card muted">{t('hub_notes_empty')}</div>}

      <div className="hub-note-list">
        {notes.map((note) => {
          const canDelete = canManageNotes || note.author_id === profile?.id
          return (
            <div className={`card hub-note ${note.pinned ? 'pinned' : ''}`} key={note.id}>
              <div className="hub-note-head">
                <div>
                  <span className="item-title">{note.author?.name ?? t('hub_note_author_unknown')}</span>
                  <span className="muted"> | {new Date(note.created_at).toLocaleString()}</span>
                </div>
                {note.pinned && <span className="badge amber">{t('hub_note_pinned')}</span>}
              </div>
              <div className="hub-note-body">{note.body}</div>
              <div className="row hub-note-actions">
                {canManageNotes && (
                  <button className="btn ghost small" type="button" disabled={busy} onClick={() => togglePinned(note)}>
                    {note.pinned ? t('hub_note_unpin') : t('hub_note_pin_action')}
                  </button>
                )}
                {canDelete && confirmDeleteId !== note.id && (
                  <button className="btn ghost small" type="button" disabled={busy} onClick={() => setConfirmDeleteId(note.id)}>
                    {t('hub_note_delete')}
                  </button>
                )}
              </div>
              {canDelete && confirmDeleteId === note.id && (
                <div className="hub-confirm-inline">
                  <span className="muted">{t('hub_note_delete_confirm')}</span>
                  <div className="row hub-confirm-actions">
                    <button className="btn red small" type="button" disabled={busy} onClick={() => deleteNote(note)}>
                      {t('hub_note_delete_confirm_yes')}
                    </button>
                    <button className="btn ghost small" type="button" disabled={busy} onClick={() => setConfirmDeleteId(null)}>
                      {t('cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
