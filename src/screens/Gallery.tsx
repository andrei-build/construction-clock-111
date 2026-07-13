import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getGalleryPhotos } from '../lib/api'
import type { GalleryPhoto } from '../lib/types'

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

// Ключ фильтра по объекту: реальный project_id либо '__none__' для фото без объекта.
const NO_PROJECT = '__none__'

export default function Gallery() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const [photos, setPhotos] = useState<GalleryPhoto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [active, setActive] = useState<GalleryPhoto | null>(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const rows = await getGalleryPhotos()
        if (mounted) setPhotos(rows)
      } catch {
        if (mounted) {
          setPhotos([])
          setError(true)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  // Список объектов для фильтра — из самих фото, по алфавиту; фото без объекта идут отдельной группой.
  const projectTabs = useMemo(() => {
    const byKey = new Map<string, string>()
    let hasNone = false
    for (const photo of photos) {
      if (photo.project_id) {
        byKey.set(photo.project_id, photo.project_name ?? t('gallery_no_project'))
      } else {
        hasNone = true
      }
    }
    const tabs = [...byKey.entries()]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
    if (hasNone) tabs.push({ key: NO_PROJECT, name: t('gallery_no_project') })
    return tabs
  }, [photos, t])

  const visible = useMemo(() => {
    if (!projectFilter) return photos
    if (projectFilter === NO_PROJECT) return photos.filter((p) => !p.project_id)
    return photos.filter((p) => p.project_id === projectFilter)
  }, [photos, projectFilter])

  const formatDate = (iso: string | null) => {
    if (!iso) return ''
    return new Intl.DateTimeFormat(localeByLang[lang], {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))
  }

  const categoryLabel = (category: string | null) =>
    category === 'task_photo' ? t('gallery_category_task_photo') : null

  // Закрытие просмотра по Escape — удобно на десктопе.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActive(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  return (
    <div className="screen">
      <h1>🖼️ {t('gallery')}</h1>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && !error && (
        <>
          {photos.length === 0 && <div className="card muted">{t('gallery_empty')}</div>}

          {photos.length > 0 && (
            <>
              <div className="tabs gallery-tabs">
                <button
                  className={projectFilter === null ? 'active' : ''}
                  onClick={() => setProjectFilter(null)}
                >
                  {t('gallery_all_projects')}
                </button>
                {projectTabs.map((tab) => (
                  <button
                    key={tab.key}
                    className={projectFilter === tab.key ? 'active' : ''}
                    onClick={() => setProjectFilter(tab.key)}
                  >
                    {tab.name}
                  </button>
                ))}
              </div>

              <p className="muted" style={{ fontSize: 13 }}>{visible.length} {t('gallery_count')}</p>

              {visible.length === 0 && <div className="card muted">{t('gallery_empty_filter')}</div>}

              <div className="gallery-grid">
                {visible.map((photo) => (
                  <button
                    key={photo.id}
                    type="button"
                    className="gallery-item"
                    onClick={() => setActive(photo)}
                    aria-label={photo.filename ?? t('gallery_open')}
                  >
                    <img src={photo.url} alt={photo.filename ?? t('gallery_open')} loading="lazy" />
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {active && (
        <div className="gallery-lightbox" onClick={() => setActive(null)}>
          <button
            type="button"
            className="gallery-lightbox-close"
            aria-label={t('gallery_close')}
            onClick={() => setActive(null)}
          >
            ✕
          </button>
          <img
            src={active.url}
            alt={active.filename ?? t('gallery_open')}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="gallery-lightbox-meta" onClick={(e) => e.stopPropagation()}>
            <span className="item-title">{active.project_name ?? t('gallery_no_project')}</span>
            <div className="muted" style={{ fontSize: 12 }}>
              {categoryLabel(active.category) ? `${categoryLabel(active.category)} · ` : ''}
              {formatDate(active.created_at)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
