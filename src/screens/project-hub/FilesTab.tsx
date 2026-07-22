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
import { useImageLightbox, type LightboxImage } from '../../components/ImageLightbox'
import { useFileViewer } from '../../components/FileViewer'
import { buildStoreZip, dedupeNames, watermarkGeometry } from './photoExport'

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
// A5: mediaUrl может вернуть null (приватный bucket, подпись не удалась) — тип отражает это,
// вызывающие рендерят «нет ссылки» вместо битого превью/окна.
function fileUrl(file: ProjectHubFile): Promise<string | null> {
  return file.scope === 'project' ? getProjectFileDownloadUrl(file) : mediaUrl(file.storage_path)
}

// PHOTO-EXPORT: паттерн canvas-композиции — как в MarkupLayer (не импортируем приватное, копируем логику).
// Грузим кросс-ориджин Image; здесь источник — локальный blob:-URL (байты фото уже у нас) + same-origin /icon.svg,
// поэтому canvas не «тейнтится». crossOrigin='anonymous' оставлен для единообразия и безопасного случая R2-URL.
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('img-load-failed'))
    img.src = src
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob-null'))), type)
  })
}

// Безопасное имя для download-архива из названия проекта.
function zipBaseName(projectName: string): string {
  const cleaned = projectName.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'photos'
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
  // PHOTO-EXPORT: режим выбора фото + опция водяного знака + подборка.
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [watermark, setWatermark] = useState(false)
  const [exporting, setExporting] = useState(false)
  // Ключ i18n сообщения об экспорте (ошибка/предупреждение) или null.
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  // LIGHTBOX-1: изображения — через общий лайтбокс (зум/листание/на весь экран/скачать В ПРИЛОЖЕНИИ).
  const lb = useImageLightbox()
  // FILES-VIEWER-37: прочие файлы (PDF/документы) — во ВСТРОЕННОМ полноэкранном просмотрщике, а не
  // через window.open (Закон Андрея: «файл на весь экран» В ПРИЛОЖЕНИИ). Видео остаётся в своём оверлее.
  const fv = useFileViewer()
  const [videoLightbox, setVideoLightbox] = useState<{ url: string; name: string } | null>(null)
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
            const url = await fileUrl(row)
            return url ? ([row.id, url] as const) : null
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
          if (url) setThumbs((prev) => ({ ...prev, [row.id]: url }))
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

  // MARKUP-1: сохранить копию с разметкой рядом с оригиналом через существующий R2-загрузчик проекта
  // (сигнатуры api.ts не трогаем). Новая строка сразу попадает в список файлов и превью.
  const saveMarkupCopy = async (blob: Blob, name: string) => {
    if (!profile) throw new Error('no profile')
    const copy = new File([blob], name, { type: 'image/png' })
    const created = await uploadProjectFileToR2(profile, project.id, copy)
    const row: ProjectHubFile = { ...created, uploader_name: profile.name ?? null }
    setFiles((rows) => [row, ...rows])
    try {
      const url = await fileUrl(row)
      if (url) setThumbs((prev) => ({ ...prev, [row.id]: url }))
    } catch {
      // превью не критично
    }
  }

  const openFile = async (file: ProjectHubFile) => {
    const category = fileCategory(file.mime)
    // Изображения: общий лайтбокс со стрелками по всем фото текущего вида (URL резолвит сам лайтбокс).
    if (category === 'photos') {
      const photoFiles = visible.filter((f) => fileCategory(f.mime) === 'photos')
      const idx = Math.max(0, photoFiles.findIndex((f) => f.id === file.id))
      lb.open(
        photoFiles.map<LightboxImage>((f) => ({
          id: f.id,
          name: f.name,
          resolve: async () => { const u = await fileUrl(f); if (!u) throw new Error('no url'); return u },
          saveMarkup: profile ? saveMarkupCopy : undefined,
        })),
        idx,
      )
      return
    }
    if (openBusyId) return
    setOpenBusyId(file.id)
    setOpenError(false)
    try {
      const url = await fileUrl(file)
      if (!url) { setOpenError(true); return }
      if (category === 'videos') setVideoLightbox({ url, name: file.name })
      else fv.open({ url, name: file.name, mime: file.mime })
    } catch {
      setOpenError(true)
    } finally {
      setOpenBusyId(null)
    }
  }

  // --- PHOTO-EXPORT ---
  const exitSelect = () => {
    setSelectMode(false)
    setSelected(new Set())
  }
  const toggleSelectMode = () => {
    setExportMsg(null)
    if (selectMode) exitSelect()
    else setSelectMode(true)
  }
  const toggleSelect = (id: string) => {
    setExportMsg(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Наложить полупрозрачный логотип в правый-нижний угол. Источник фото — локальный blob:-URL
  // (байты уже получены fetch'ем), поэтому canvas не «тейнтится»; на любой сбой — бросаем, вызывающий оставит оригинал.
  const composeWatermark = async (blob: Blob, logo: HTMLImageElement): Promise<Blob> => {
    const url = URL.createObjectURL(blob)
    try {
      const img = await loadImage(url)
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (!w || !h) throw new Error('no-dims')
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no-ctx')
      ctx.drawImage(img, 0, 0, w, h)
      const g = watermarkGeometry(w, h)
      ctx.globalAlpha = 0.75
      ctx.drawImage(logo, g.x, g.y, g.size, g.size)
      ctx.globalAlpha = 1
      // Экспорт как PNG у прозрачных, иначе JPEG — сохраняем исходный тип, где можем.
      return await canvasToBlob(canvas, blob.type === 'image/png' ? 'image/png' : 'image/jpeg')
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  const runExport = async () => {
    if (exporting) return
    const chosen = files.filter((f) => fileCategory(f.mime) === 'photos' && selected.has(f.id))
    if (chosen.length === 0) return
    setExporting(true)
    setExportMsg(null)
    try {
      // Логотип грузим один раз; не загрузился → просто без водяного знака (graceful).
      let logo: HTMLImageElement | null = null
      if (watermark) {
        try {
          logo = await loadImage('/icon.svg')
        } catch {
          logo = null
        }
      }

      const items: { name: string; blob: Blob }[] = []
      let watermarkFailed = false
      for (const f of chosen) {
        let url: string | null
        try {
          url = await fileUrl(f)
        } catch {
          continue
        }
        if (!url) continue
        let blob: Blob
        try {
          // Программное чтение подписанного R2-URL может упереться в CORS — тогда мягко пропускаем это фото.
          const res = await fetch(url)
          if (!res.ok) continue
          blob = await res.blob()
        } catch {
          continue
        }
        if (watermark && logo) {
          try {
            blob = await composeWatermark(blob, logo)
          } catch {
            // canvas «затейнился»/сбой → оставляем оригинал, помечаем, не крашим экспорт.
            watermarkFailed = true
          }
        }
        items.push({ name: f.name, blob })
      }

      if (items.length === 0) {
        // Ни одно фото не удалось прочитать программно — честная ошибка, без ложного успеха.
        setExportMsg('hub_files_export_cors')
        return
      }

      const names = dedupeNames(items.map((it) => it.name))
      const shareFiles = items.map(
        (it, i) => new File([it.blob], names[i], { type: it.blob.type || 'image/jpeg' }),
      )

      // Главный путь для телефона: нативный share-sheet (Instagram / Google Business).
      const nav = typeof navigator !== 'undefined' ? navigator : null
      if (nav?.canShare && nav.canShare({ files: shareFiles })) {
        try {
          await nav.share({ files: shareFiles, title: project.name })
          if (watermarkFailed) setExportMsg('hub_files_export_no_watermark')
          exitSelect()
          return
        } catch (err) {
          // Пользователь отменил share → тихо, без ошибки. Иначе — падаем в zip-путь.
          if ((err as { name?: string })?.name === 'AbortError') return
        }
      }

      // Десктоп/фолбэк: один STORE-only .zip ссылкой на скачивание.
      const entries = await Promise.all(
        items.map(async (it, i) => ({ name: names[i], bytes: new Uint8Array(await it.blob.arrayBuffer()) })),
      )
      const zip = buildStoreZip(entries)
      const zipBlob = new Blob([zip as BlobPart], { type: 'application/zip' })
      const zipUrl = URL.createObjectURL(zipBlob)
      const a = document.createElement('a')
      a.href = zipUrl
      a.download = `${zipBaseName(project.name)}-photos.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(zipUrl), 10000)
      if (watermarkFailed) setExportMsg('hub_files_export_no_watermark')
      exitSelect()
    } catch {
      setExportMsg('hub_files_export_failed')
    } finally {
      setExporting(false)
    }
  }

  const selectedCount = selected.size

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

      {counts.photos > 0 && (
        <div className="hub-file-export-bar">
          <button
            type="button"
            className={`btn small hub-file-export-toggle${selectMode ? ' active' : ''}`}
            onClick={toggleSelectMode}
            aria-pressed={selectMode}
          >
            {selectMode ? t('hub_files_export_cancel') : t('hub_files_export_select')}
          </button>
          {selectMode && (
            <>
              <label className="hub-file-export-wm">
                <input
                  type="checkbox"
                  checked={watermark}
                  onChange={(e) => setWatermark(e.target.checked)}
                />
                {t('hub_files_export_watermark')}
              </label>
              <button
                type="button"
                className="btn small primary hub-file-export-go"
                disabled={selectedCount < 1 || exporting}
                onClick={runExport}
              >
                {exporting
                  ? t('hub_files_export_working')
                  : `${t('hub_files_export_do')} (${selectedCount})`}
              </button>
            </>
          )}
        </div>
      )}
      {exportMsg && <p className="error-msg hub-file-export-msg">{t(exportMsg)}</p>}

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
            // В режиме выбора выбираемы только фото; клик по фото переключает выбор, а не открывает лайтбокс.
            const selectable = selectMode && category === 'photos'
            const isSelected = selectable && selected.has(file.id)
            return (
              <button
                key={file.id}
                type="button"
                className={`card hub-file-card${isSelected ? ' selected' : ''}`}
                disabled={openBusyId === file.id}
                aria-pressed={selectable ? isSelected : undefined}
                onClick={() => (selectable ? toggleSelect(file.id) : openFile(file))}
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
                  {selectable && (
                    <span className={`hub-file-check${isSelected ? ' on' : ''}`} aria-hidden="true">
                      {isSelected ? '✓' : ''}
                    </span>
                  )}
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

      {lb.node}
      {fv.node}

      {videoLightbox && (
        <div className="gallery-lightbox" onClick={() => setVideoLightbox(null)}>
          <button
            type="button"
            className="gallery-lightbox-close"
            aria-label={t('hub_files_close')}
            onClick={() => setVideoLightbox(null)}
          >
            ✕
          </button>
          <video src={videoLightbox.url} controls autoPlay onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  )
}
