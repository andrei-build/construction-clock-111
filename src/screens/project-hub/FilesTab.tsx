import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import {
  getProjectHubFiles,
  uploadProjectFileToR2,
  getProjectFileDownloadUrl,
  mediaUrl,
  uploadErrorCode,
} from '../../lib/api'
import type { Profile, Project, ProjectHubFile } from '../../lib/types'

interface FilesTabProps {
  project: Project
  profile: Profile | null
}

// Категория файла по MIME — основа фильтра-чипов и превью.
type FileCategory = 'photos' | 'videos' | 'documents'
type FilterKey = 'all' | FileCategory

function fileCategory(mime: string | null): FileCategory {
  if (mime?.startsWith('image/')) return 'photos'
  if (mime?.startsWith('video/')) return 'videos'
  return 'documents'
}

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Открытая ссылка в R2 — для project-файлов через r2-sign, иначе media bucket (как getGalleryPdfUrl).
function fileUrl(file: ProjectHubFile): Promise<string> {
  return file.scope === 'project' ? getProjectFileDownloadUrl(file) : mediaUrl(file.storage_path)
}

const FILTERS: { key: FilterKey; labelKey: string }[] = [
  { key: 'all', labelKey: 'hub_files_all' },
  { key: 'photos', labelKey: 'hub_files_photos' },
  { key: 'videos', labelKey: 'hub_files_videos' },
  { key: 'documents', labelKey: 'hub_files_documents' },
]

export default function FilesTab({ project, profile }: FilesTabProps) {
  const { t } = useI18n()
  const [files, setFiles] = useState<ProjectHubFile[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [filter, setFilter] = useState<FilterKey>('all')
  // Подписанные превью-URL для изображений (id → url), резолвим после загрузки списка.
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [openBusyId, setOpenBusyId] = useState<string | null>(null)
  const [openError, setOpenError] = useState(false)
  // Лайтбокс для изображений/видео; прочие файлы открываем в новой вкладке.
  const [lightbox, setLightbox] = useState<{ url: string; kind: 'image' | 'video'; name: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const rows = await getProjectHubFiles(project.id)
        if (!mounted) return
        setFiles(rows)
        // Превью только для изображений — по одному подписанному URL, ошибки тихо пропускаем.
        const images = rows.filter((row) => fileCategory(row.mime) === 'photos')
        const entries = await Promise.all(images.map(async (row) => {
          try {
            return [row.id, await fileUrl(row)] as const
          } catch {
            return null
          }
        }))
        if (mounted) setThumbs(Object.fromEntries(entries.filter((e): e is readonly [string, string] => e !== null)))
      } catch {
        if (mounted) setLoadError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [project.id])

  const counts = useMemo(() => {
    const acc = { all: files.length, photos: 0, videos: 0, documents: 0 }
    for (const file of files) acc[fileCategory(file.mime)] += 1
    return acc
  }, [files])

  const visible = useMemo(
    () => (filter === 'all' ? files : files.filter((file) => fileCategory(file.mime) === filter)),
    [files, filter],
  )

  const formatDate = (iso: string) => new Date(iso).toLocaleDateString()

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0]
    // Сбрасываем input, чтобы повторный выбор того же файла снова триггерил onChange.
    e.target.value = ''
    if (!picked || !profile || uploading) return
    setUploading(true)
    setUploadError(null)
    try {
      const created = await uploadProjectFileToR2(profile, project.id, picked)
      const row: ProjectHubFile = { ...created, uploader_name: profile.name ?? null }
      setFiles((rows) => [row, ...rows])
      if (fileCategory(row.mime) === 'photos') {
        try {
          const url = await fileUrl(row)
          setThumbs((prev) => ({ ...prev, [row.id]: url }))
        } catch {
          // превью не критично
        }
      }
    } catch (err) {
      setUploadError(uploadErrorCode(err) ?? 'hub_file_upload_failed')
    } finally {
      setUploading(false)
    }
  }

  const openFile = async (file: ProjectHubFile) => {
    if (openBusyId) return
    setOpenBusyId(file.id)
    setOpenError(false)
    try {
      const url = await fileUrl(file)
      const category = fileCategory(file.mime)
      if (category === 'photos') setLightbox({ url, kind: 'image', name: file.name })
      else if (category === 'videos') setLightbox({ url, kind: 'video', name: file.name })
      else window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      setOpenError(true)
    } finally {
      setOpenBusyId(null)
    }
  }

  return (
    <section className="hub-tab-panel hub-files">
      <div className="card hub-file-upload">
        <input
          ref={fileInputRef}
          type="file"
          className="hub-file-input"
          onChange={handleUpload}
          disabled={uploading || !profile}
        />
        <button
          type="button"
          className="btn small"
          disabled={uploading || !profile}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? t('hub_files_uploading') : t('hub_files_upload')}
        </button>
        {uploadError && <p className="error-msg">{t(uploadError)}</p>}
      </div>

      <div className="tabs hub-file-filters">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={filter === item.key ? 'active' : ''}
            onClick={() => setFilter(item.key)}
          >
            {t(item.labelKey)} ({counts[item.key]})
          </button>
        ))}
      </div>

      {openError && <p className="error-msg">{t('hub_file_open_failed')}</p>}
      {loading && <div className="card center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('hub_files_load_error')}</p>}
      {!loading && !loadError && files.length === 0 && <div className="card muted">{t('hub_files_empty')}</div>}
      {!loading && !loadError && files.length > 0 && visible.length === 0 && (
        <div className="card muted">{t('hub_files_filter_empty')}</div>
      )}

      {!loading && !loadError && visible.length > 0 && (
        <div className="hub-file-grid">
          {visible.map((file) => {
            const category = fileCategory(file.mime)
            const thumb = thumbs[file.id]
            return (
              <button
                key={file.id}
                type="button"
                className="card hub-file-card"
                disabled={openBusyId === file.id}
                onClick={() => openFile(file)}
              >
                <div className="hub-file-preview">
                  {category === 'photos' && thumb ? (
                    <img src={thumb} alt={file.name} loading="lazy" />
                  ) : (
                    <span className="hub-file-icon" aria-hidden="true">
                      {category === 'photos' ? '🖼️' : category === 'videos' ? '🎬' : '📄'}
                    </span>
                  )}
                  {category === 'videos' && <span className="hub-file-badge">{t('hub_file_video_badge')}</span>}
                </div>
                <div className="hub-file-meta">
                  <span className="item-title hub-file-name">{file.name}</span>
                  <span className="muted hub-file-sub">
                    {file.uploader_name ?? t('hub_file_uploader_unknown')}
                    {formatSize(file.size_bytes) ? ` · ${formatSize(file.size_bytes)}` : ''}
                    {` · ${formatDate(file.created_at)}`}
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {lightbox && (
        <div className="gallery-lightbox" onClick={() => setLightbox(null)}>
          <button
            type="button"
            className="gallery-lightbox-close"
            aria-label={t('hub_files_close')}
            onClick={() => setLightbox(null)}
          >
            ✕
          </button>
          {lightbox.kind === 'image' ? (
            <img src={lightbox.url} alt={lightbox.name} onClick={(e) => e.stopPropagation()} />
          ) : (
            <video src={lightbox.url} controls autoPlay onClick={(e) => e.stopPropagation()} />
          )}
        </div>
      )}
    </section>
  )
}
