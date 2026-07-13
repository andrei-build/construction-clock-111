import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getArchivedProjects, getArchivedTasks, getArchivedMedia, restoreEntity } from '../lib/api'
import type { ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveTable } from '../lib/types'

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

export default function Archive() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const [projects, setProjects] = useState<ArchivedProject[]>([])
  const [tasks, setTasks] = useState<ArchivedTask[]>([])
  const [media, setMedia] = useState<ArchivedMedia[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState(false)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [p, tk, m] = await Promise.all([
          getArchivedProjects(),
          getArchivedTasks(),
          getArchivedMedia(),
        ])
        if (mounted) {
          setProjects(p)
          setTasks(tk)
          setMedia(m)
        }
      } catch {
        if (mounted) {
          setProjects([])
          setTasks([])
          setMedia([])
          setError(true)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(localeByLang[lang], { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso))

  async function handleRestore(table: ArchiveTable, id: string) {
    if (!profile || busyId) return
    setBusyId(id)
    setRestoreError(false)
    try {
      await restoreEntity(profile, table, id)
      if (table === 'projects') setProjects((rows) => rows.filter((r) => r.id !== id))
      else if (table === 'tasks') setTasks((rows) => rows.filter((r) => r.id !== id))
      else setMedia((rows) => rows.filter((r) => r.id !== id))
    } catch {
      setRestoreError(true)
    } finally {
      setBusyId(null)
    }
  }

  const empty = projects.length === 0 && tasks.length === 0 && media.length === 0

  return (
    <div className="screen">
      <h1>🗑️ {t('archive')}</h1>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {restoreError && <p className="error-msg">{t('restore_failed')}</p>}
      {!loading && !error && empty && <div className="card muted">{t('archive_empty')}</div>}

      {!loading && !error && projects.length > 0 && (
        <>
          <h2>{t('archive_projects')}</h2>
          {projects.map((row) => (
            <div key={row.id} className="card row">
              <div>
                <span className="item-title">{row.name}</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  {t('archive_deleted_on')}: {formatDate(row.deleted_at)}
                </div>
              </div>
              <button
                type="button"
                className="btn small"
                disabled={busyId === row.id}
                onClick={() => handleRestore('projects', row.id)}
              >
                {t('restore')}
              </button>
            </div>
          ))}
        </>
      )}

      {!loading && !error && tasks.length > 0 && (
        <>
          <h2>{t('archive_tasks')}</h2>
          {tasks.map((row) => (
            <div key={row.id} className="card row">
              <div>
                <span className="item-title">{row.title}</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  {row.project?.name ?? t('unknown_project')} · {t('archive_deleted_on')}: {formatDate(row.deleted_at)}
                </div>
              </div>
              <button
                type="button"
                className="btn small"
                disabled={busyId === row.id}
                onClick={() => handleRestore('tasks', row.id)}
              >
                {t('restore')}
              </button>
            </div>
          ))}
        </>
      )}

      {!loading && !error && media.length > 0 && (
        <>
          <h2>{t('archive_media')}</h2>
          {media.map((row) => (
            <div key={row.id} className="card row">
              <div>
                <span className="item-title">{row.filename ?? row.category ?? row.media_type ?? '—'}</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  {row.media_type && <span className="badge amber" style={{ marginRight: 6 }}>{row.media_type}</span>}
                  {row.project?.name ?? t('unknown_project')} · {t('archive_deleted_on')}: {formatDate(row.deleted_at)}
                </div>
              </div>
              <button
                type="button"
                className="btn small"
                disabled={busyId === row.id}
                onClick={() => handleRestore('media', row.id)}
              >
                {t('restore')}
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
