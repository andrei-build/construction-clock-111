import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { isManagerRole } from '../lib/types'
import { getFiles, uploadFile, softDeleteFile, mediaUrl, uploadErrorCode } from '../lib/api'
import type { FileRow } from '../lib/types'
import { useImageLightbox, type LightboxImage } from '../components/ImageLightbox'

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

const DAY_MS = 24 * 60 * 60 * 1000
const EXPIRY_WARN_DAYS = 30

// Дней до истечения по локальной дате (YYYY-MM-DD). Отрицательное — уже просрочен.
function daysUntil(expiresAt: string): number {
  const target = new Date(`${expiresAt}T00:00:00`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / DAY_MS)
}

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function Files() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const manager = profile ? isManagerRole(profile.role) : false
  // LIGHTBOX-1: изображения открываем В ПРИЛОЖЕНИИ (общий лайтбокс), не в отдельной вкладке.
  const lb = useImageLightbox()

  const [files, setFiles] = useState<FileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [scope, setScope] = useState('general')
  const [folder, setFolder] = useState('')
  const [docKind, setDocKind] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [saveErrorCode, setSaveErrorCode] = useState<string | null>(null)

  useEffect(() => {
    if (!manager) { setLoading(false); return }
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const rows = await getFiles()
        if (mounted) setFiles(rows)
      } catch {
        if (mounted) { setFiles([]); setError(true) }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id, manager])

  const groups = useMemo(() => {
    const byFolder = new Map<string, FileRow[]>()
    for (const row of files) {
      const key = row.folder || ''
      const list = byFolder.get(key) ?? []
      list.push(row)
      byFolder.set(key, list)
    }
    return Array.from(byFolder.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [files])

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(localeByLang[lang], { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${iso}T00:00:00`))

  function expiryLabel(expiresAt: string): string {
    const days = daysUntil(expiresAt)
    if (days < 0) return t('files_expired')
    if (days === 0) return t('files_expires_today')
    return t('files_expires_in').replace('{n}', String(days))
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!profile || saving) return
    if (!file) { setSaveError(true); setSaveErrorCode(null); return }
    setSaving(true)
    setSaveError(false)
    setSaveErrorCode(null)
    try {
      const created = await uploadFile(profile, {
        file,
        name: name.trim() || file.name,
        scope: scope.trim() || 'general',
        folder: folder.trim(),
        doc_kind: docKind.trim() || null,
        expires_at: expiresAt || null,
        is_private: isPrivate,
      })
      setFiles((rows) => [created, ...rows])
      setFile(null)
      setName('')
      setFolder('')
      setDocKind('')
      setExpiresAt('')
      setIsPrivate(false)
    } catch (err) {
      setSaveErrorCode(uploadErrorCode(err))
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  async function handleDownload(row: FileRow) {
    // Картинки — в общий лайтбокс (просмотр по центру + «на весь экран» + «скачать» внутри него),
    // со стрелками по всем изображениям списка. Не-картинки (pdf/doc/…) — прежнее поведение (новая вкладка).
    if (row.mime?.startsWith('image/')) {
      const imageRows = files.filter((r) => r.mime?.startsWith('image/'))
      const idx = Math.max(0, imageRows.findIndex((r) => r.id === row.id))
      lb.open(
        imageRows.map<LightboxImage>((r) => ({
          id: r.id,
          name: r.name,
          resolve: async () => { const u = await mediaUrl(r.storage_path); if (!u) throw new Error('no url'); return u },
        })),
        idx,
      )
      return
    }
    try {
      const url = await mediaUrl(row.storage_path)
      if (!url) { setError(true); return }
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      setError(true)
    }
  }

  async function handleDelete(row: FileRow) {
    if (!profile || busyId) return
    if (!window.confirm(t('files_delete_confirm'))) return
    setBusyId(row.id)
    try {
      await softDeleteFile(profile, row.id)
      setFiles((rows) => rows.filter((r) => r.id !== row.id))
    } catch {
      setError(true)
    } finally {
      setBusyId(null)
    }
  }

  if (!manager) {
    return (
      <div className="screen">
        <h1>📁 {t('files')}</h1>
        <div className="card muted center">{t('files_locked')}</div>
      </div>
    )
  }

  return (
    <div className="screen">
      {lb.node}
      <h1>📁 {t('files')}</h1>
      <p className="muted" style={{ marginTop: -8 }}>{t('files_subtitle')}</p>

      <form className="card files-form" onSubmit={handleUpload}>
        <input
          type="file"
          accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/csv,text/plain"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <input
          type="text"
          placeholder={t('files_name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="row" style={{ gap: 8 }}>
          <input
            type="text"
            placeholder={t('files_scope')}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
          <input
            type="text"
            placeholder={t('files_folder')}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            type="text"
            placeholder={t('files_doc_kind')}
            value={docKind}
            onChange={(e) => setDocKind(e.target.value)}
          />
          <input
            type="date"
            aria-label={t('files_expires_at')}
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
        <label className="files-check">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
          {t('files_is_private')}
        </label>
        {saveError && <p className="error-msg">{saveErrorCode ? t(saveErrorCode) : file ? t('files_upload_failed') : t('files_file_required')}</p>}
        <button type="submit" className="btn" disabled={saving}>
          {saving ? t('files_uploading') : t('files_upload')}
        </button>
      </form>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && !error && files.length === 0 && (
        <div className="card muted">{t('files_empty')}</div>
      )}

      {!loading && !error && groups.map(([folderName, rows]) => (
        <section key={folderName || '__none__'} className="files-group">
          <h2>📂 {folderName || t('files_no_folder')}</h2>
          {rows.map((row) => {
            const days = row.expires_at ? daysUntil(row.expires_at) : null
            const warn = days !== null && days <= EXPIRY_WARN_DAYS
            const expired = days !== null && days < 0
            return (
              <div key={row.id} className={`card row files-item ${warn ? 'files-warn' : ''}`}>
                <div>
                  <span className="item-title">{row.name}</span>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {row.scope}
                    {row.doc_kind ? ` · ${row.doc_kind}` : ''}
                    {formatSize(row.size_bytes) ? ` · ${formatSize(row.size_bytes)}` : ''}
                    {row.expires_at ? ` · ${formatDate(row.expires_at)}` : ''}
                  </div>
                  <div className="files-badges">
                    {row.is_private && <span className="badge grey">{t('files_private_badge')}</span>}
                    {warn && (
                      <span className={`badge ${expired ? 'red' : 'amber'}`}>
                        {row.expires_at ? expiryLabel(row.expires_at) : ''}
                      </span>
                    )}
                  </div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn small" onClick={() => handleDownload(row)}>
                    {t('files_download')}
                  </button>
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={busyId === row.id}
                    onClick={() => handleDelete(row)}
                  >
                    {t('files_delete')}
                  </button>
                </div>
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}
