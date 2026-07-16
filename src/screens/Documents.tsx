import { useEffect, useState } from 'react'
import { getCompanyFiles, uploadFile, softDeleteFile, mediaUrl, uploadErrorCode } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import type { FileRow } from '../lib/types'

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// DOCS-2: «Документы» = собственные файлы компании (страховки, лицензии, договоры, шаблоны).
// Загрузка/удаление — только owner/admin; менеджер (supervisor/manager) видит и скачивает.
// Роут /documents остаётся manager-gated, поэтому worker/driver сюда не попадают.
export default function Documents() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const canManage = profile?.role === 'owner' || profile?.role === 'admin'

  const [files, setFiles] = useState<FileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [saveErrorCode, setSaveErrorCode] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const rows = await getCompanyFiles()
        if (mounted) setFiles(rows)
      } catch {
        if (mounted) { setFiles([]); setError(true) }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(localeByLang[lang], { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${iso.slice(0, 10)}T00:00:00`))

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!profile || !canManage || saving) return
    if (!file) { setSaveError(true); setSaveErrorCode(null); return }
    setSaving(true)
    setSaveError(false)
    setSaveErrorCode(null)
    try {
      const created = await uploadFile(profile, {
        file,
        name: name.trim() || file.name,
        scope: 'company',
        folder: '',
        is_private: false,
      })
      setFiles((rows) => [created, ...rows])
      setFile(null)
      setName('')
    } catch (err) {
      setSaveErrorCode(uploadErrorCode(err))
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  async function handleDownload(row: FileRow) {
    try {
      const url = await mediaUrl(row.storage_path)
      if (!url) { setError(true); return }
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      setError(true)
    }
  }

  async function handleDelete(row: FileRow) {
    if (!profile || !canManage || busyId) return
    if (!window.confirm(t('documents_company_delete_confirm'))) return
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

  return (
    <div className="screen documents-screen">
      <h1>{t('documents')}</h1>
      <p className="muted" style={{ marginTop: -8 }}>{t('documents_company_subtitle')}</p>

      {canManage && (
        <form className="card files-form" onSubmit={handleUpload}>
          <input
            type="file"
            accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/csv,text/plain"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <input
            type="text"
            placeholder={t('documents_company_name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {saveError && <p className="error-msg">{saveErrorCode ? t(saveErrorCode) : file ? t('documents_company_upload_failed') : t('documents_company_file_required')}</p>}
          <button type="submit" className="btn" disabled={saving}>
            {saving ? t('documents_company_uploading') : t('documents_company_upload')}
          </button>
        </form>
      )}

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && !error && files.length === 0 && (
        <div className="card muted">{t('documents_company_empty')}</div>
      )}

      {!loading && !error && files.map((row) => (
        <div key={row.id} className="card row files-item">
          <div>
            <span className="item-title">{row.name}</span>
            <div className="muted" style={{ fontSize: 12 }}>
              {row.doc_kind ? `${row.doc_kind} · ` : ''}
              {formatSize(row.size_bytes) ? `${formatSize(row.size_bytes)} · ` : ''}
              {formatDate(row.created_at)}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn small" onClick={() => handleDownload(row)}>
              {t('documents_company_download')}
            </button>
            {canManage && (
              <button
                type="button"
                className="btn small ghost"
                disabled={busyId === row.id}
                onClick={() => handleDelete(row)}
              >
                {t('documents_company_delete')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
