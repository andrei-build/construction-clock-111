import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getGalleryPhotos, getOpenMediaFlags, flagMedia, resolveMediaFlag } from '../lib/api'
import { isManagerWrite } from '../lib/types'
import type { GalleryPhoto, MediaFlag } from '../lib/types'
import MediaComments from '../components/MediaComments'

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
  const [flags, setFlags] = useState<MediaFlag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [active, setActive] = useState<GalleryPhoto | null>(null)
  // Состояние формы флага в лайтбоксе.
  const [flagReason, setFlagReason] = useState('')
  const [flagBusy, setFlagBusy] = useState(false)
  const [flagError, setFlagError] = useState<string | null>(null)

  const canResolve = profile ? isManagerWrite(profile.role) : false

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [rows, openFlags] = await Promise.all([getGalleryPhotos(), getOpenMediaFlags()])
        if (mounted) {
          setPhotos(rows)
          setFlags(openFlags)
        }
      } catch {
        if (mounted) {
          setPhotos([])
          setFlags([])
          setError(true)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  // Обновить только список флагов (после постановки/снятия) — фото перечитывать не нужно.
  const reloadFlags = async () => {
    try {
      setFlags(await getOpenMediaFlags())
    } catch {
      // тихо: бейджи не критичны для просмотра
    }
  }

  // media_id → открытый флаг, для быстрого поиска по фото.
  const flagByMedia = useMemo(() => {
    const map = new Map<string, MediaFlag>()
    for (const f of flags) if (!map.has(f.media_id)) map.set(f.media_id, f)
    return map
  }, [flags])

  const activeFlag = active ? flagByMedia.get(active.id) ?? null : null

  const submitFlag = async () => {
    if (!profile || !active || flagBusy) return
    setFlagBusy(true)
    setFlagError(null)
    try {
      await flagMedia(profile, active.id, flagReason.trim())
      setFlagReason('')
      await reloadFlags()
    } catch {
      setFlagError(t('gallery_flag_error'))
    } finally {
      setFlagBusy(false)
    }
  }

  const resolveFlag = async () => {
    if (!profile || !activeFlag || flagBusy) return
    setFlagBusy(true)
    setFlagError(null)
    try {
      await resolveMediaFlag(profile, activeFlag.id)
      await reloadFlags()
    } catch {
      setFlagError(t('gallery_resolve_error'))
    } finally {
      setFlagBusy(false)
    }
  }

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

  // Сброс формы флага при смене/закрытии просматриваемого фото.
  useEffect(() => {
    setFlagReason('')
    setFlagError(null)
  }, [active?.id])

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
                    {flagByMedia.has(photo.id) && (
                      <span className="gallery-flag-badge" title={t('gallery_flagged')}>🚩</span>
                    )}
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

            {activeFlag ? (
              // Фото уже отмечено на проверку — показываем причину; менеджер может снять флаг.
              <div className="gallery-flag-box">
                <div className="gallery-flag-title">🚩 {t('gallery_flagged')}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {t('gallery_flag_reason_label')}: {activeFlag.reason?.trim() || t('gallery_flag_no_reason')}
                </div>
                {canResolve && (
                  <button type="button" className="btn small" disabled={flagBusy} onClick={resolveFlag}>
                    {t('gallery_resolve')}
                  </button>
                )}
              </div>
            ) : (
              // Флага нет — любой пользователь может поставить.
              <div className="gallery-flag-box">
                <input
                  type="text"
                  value={flagReason}
                  onChange={(e) => setFlagReason(e.target.value)}
                  placeholder={t('gallery_flag_reason')}
                  disabled={flagBusy}
                />
                <button type="button" className="btn small" disabled={flagBusy} onClick={submitFlag}>
                  🚩 {t('gallery_flag_submit')}
                </button>
              </div>
            )}
            {flagError && <p className="error-msg" style={{ fontSize: 12 }}>{flagError}</p>}

            <MediaComments mediaId={active.id} />
          </div>
        </div>
      )}
    </div>
  )
}
