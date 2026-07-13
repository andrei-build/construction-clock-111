import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  getGalleryPhotos,
  getGalleryVideos,
  getGalleryPdfs,
  getGalleryPdfUrl,
  getOpenMediaFlags,
  flagMedia,
  resolveMediaFlag,
  GALLERY_PAGE_SIZE,
} from '../lib/api'
import { isManagerWrite } from '../lib/types'
import type { GalleryPhoto, GalleryVideo, GalleryPdf, MediaFlag } from '../lib/types'
import MediaComments from '../components/MediaComments'

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

// Ключ фильтра по объекту: реальный project_id либо '__none__' для медиа без объекта.
const NO_PROJECT = '__none__'
// Ключ фильтра по автору: реальный uploaded_by либо '__no_uploader__' для медиа без автора.
const NO_UPLOADER = '__no_uploader__'

// Активная вкладка типа медиа поверх фильтра по объекту.
type MediaType = 'photos' | 'videos' | 'pdfs'
// Состояние ленивой подгрузки видео/PDF (фото грузим сразу вместе с флагами).
type LoadState = 'idle' | 'loading' | 'ready' | 'error'

// Что-то, что можно сгруппировать по объекту (общий контракт фото/видео/PDF).
type WithProject = { project_id: string | null; project_name: string | null }

export default function Gallery() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const [mediaType, setMediaType] = useState<MediaType>('photos')

  const [photos, setPhotos] = useState<GalleryPhoto[]>([])
  const [flags, setFlags] = useState<MediaFlag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  // Видео и PDF грузятся лениво при первом переходе на вкладку.
  const [videos, setVideos] = useState<GalleryVideo[]>([])
  const [videosState, setVideosState] = useState<LoadState>('idle')
  const [pdfs, setPdfs] = useState<GalleryPdf[]>([])
  const [pdfsState, setPdfsState] = useState<LoadState>('idle')

  // Кумулятивная подгрузка «Показать ещё» по каждой вкладке: есть ли ещё страница (последняя страница
  // вернула ровно GALLERY_PAGE_SIZE) и идёт ли догрузка следующей. Аккумулируем поверх текущего списка.
  const [photosHasMore, setPhotosHasMore] = useState(false)
  const [photosLoadingMore, setPhotosLoadingMore] = useState(false)
  const [videosHasMore, setVideosHasMore] = useState(false)
  const [videosLoadingMore, setVideosLoadingMore] = useState(false)
  const [pdfsHasMore, setPdfsHasMore] = useState(false)
  const [pdfsLoadingMore, setPdfsLoadingMore] = useState(false)
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null)
  const [pdfError, setPdfError] = useState(false)

  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  // Дополнительные фильтры поверх объекта/типа: автор загрузки и диапазон дат (локальные дни, YYYY-MM-DD).
  const [uploaderFilter, setUploaderFilter] = useState<string | null>(null)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
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
          setPhotosHasMore(rows.length === GALLERY_PAGE_SIZE)
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

  // Переключение вкладки типа: сбрасываем фильтр по объекту (набор объектов у разных типов свой)
  // и лениво подгружаем видео/PDF при первом открытии.
  const selectType = (next: MediaType) => {
    setMediaType(next)
    setProjectFilter(null)
    // Набор объектов/авторов у разных типов свой — сбрасываем дополнительные фильтры при смене вкладки.
    setUploaderFilter(null)
    setFromDate('')
    setToDate('')
    if (next === 'videos' && videosState === 'idle') {
      setVideosState('loading')
      getGalleryVideos()
        .then((rows) => { setVideos(rows); setVideosHasMore(rows.length === GALLERY_PAGE_SIZE); setVideosState('ready') })
        .catch(() => { setVideos([]); setVideosState('error') })
    }
    if (next === 'pdfs' && pdfsState === 'idle') {
      setPdfsState('loading')
      getGalleryPdfs()
        .then((rows) => { setPdfs(rows); setPdfsHasMore(rows.length === GALLERY_PAGE_SIZE); setPdfsState('ready') })
        .catch(() => { setPdfs([]); setPdfsState('error') })
    }
  }

  // «Показать ещё»: догружаем следующую страницу от длины уже накопленного списка и дописываем в конец.
  // Уже загруженное остаётся видимым при ошибке; кнопку скрываем, когда пришло меньше страницы.
  const loadMorePhotos = async () => {
    if (photosLoadingMore) return
    setPhotosLoadingMore(true)
    try {
      const rows = await getGalleryPhotos(photos.length)
      setPhotos((prev) => [...prev, ...rows])
      setPhotosHasMore(rows.length === GALLERY_PAGE_SIZE)
    } catch {
      // тихо: накопленное остаётся, кнопку можно нажать повторно
    } finally {
      setPhotosLoadingMore(false)
    }
  }

  const loadMoreVideos = async () => {
    if (videosLoadingMore) return
    setVideosLoadingMore(true)
    try {
      const rows = await getGalleryVideos(videos.length)
      setVideos((prev) => [...prev, ...rows])
      setVideosHasMore(rows.length === GALLERY_PAGE_SIZE)
    } catch {
      // тихо
    } finally {
      setVideosLoadingMore(false)
    }
  }

  const loadMorePdfs = async () => {
    if (pdfsLoadingMore) return
    setPdfsLoadingMore(true)
    try {
      const rows = await getGalleryPdfs(pdfs.length)
      setPdfs((prev) => [...prev, ...rows])
      setPdfsHasMore(rows.length === GALLERY_PAGE_SIZE)
    } catch {
      // тихо
    } finally {
      setPdfsLoadingMore(false)
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

  // Открыть PDF: ссылку резолвим по клику (R2 или media bucket — решает getGalleryPdfUrl по scope).
  const openPdf = async (pdf: GalleryPdf) => {
    if (pdfBusyId) return
    setPdfBusyId(pdf.id)
    setPdfError(false)
    try {
      const url = await getGalleryPdfUrl(pdf)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      setPdfError(true)
    } finally {
      setPdfBusyId(null)
    }
  }

  // Список объектов для фильтра — из элементов активной вкладки, по алфавиту;
  // элементы без объекта идут отдельной группой. Работает поверх любого типа медиа.
  const buildProjectTabs = (items: WithProject[]) => {
    const byKey = new Map<string, string>()
    let hasNone = false
    for (const item of items) {
      if (item.project_id) {
        byKey.set(item.project_id, item.project_name ?? t('gallery_no_project'))
      } else {
        hasNone = true
      }
    }
    const tabs = [...byKey.entries()]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
    if (hasNone) tabs.push({ key: NO_PROJECT, name: t('gallery_no_project') })
    return tabs
  }

  const filterByProject = <T extends WithProject>(items: T[]): T[] => {
    if (!projectFilter) return items
    if (projectFilter === NO_PROJECT) return items.filter((i) => !i.project_id)
    return items.filter((i) => i.project_id === projectFilter)
  }

  // Что можно отфильтровать по автору: id загрузившего и его имя (если пришло embed-ом из profiles).
  type WithUploader = { uploaded_by?: string | null; uploader_name?: string | null }

  // Ярлык автора: имя из profiles, иначе — «Пользователь <8 симв. id>» (имя не пришло, но id есть).
  const uploaderLabel = (id: string, name?: string | null) =>
    name?.trim() ? name.trim() : `${t('gallery_uploader_prefix')} ${id.slice(0, 8)}`

  // Опции выпадающего списка авторов — только из уже загруженных элементов активной вкладки,
  // по алфавиту; элементы без автора идут отдельной группой. Без дополнительных запросов к сети.
  const buildUploaderOptions = (items: WithUploader[]) => {
    const byId = new Map<string, string>()
    let hasNone = false
    for (const item of items) {
      if (item.uploaded_by) {
        if (!byId.has(item.uploaded_by)) byId.set(item.uploaded_by, uploaderLabel(item.uploaded_by, item.uploader_name))
      } else {
        hasNone = true
      }
    }
    const opts = [...byId.entries()]
      .map(([key, name]) => ({ key, name }))
      .sort((a, b) => a.name.localeCompare(b.name))
    if (hasNone) opts.push({ key: NO_UPLOADER, name: t('gallery_uploader_none') })
    return opts
  }

  const filterByUploader = <T extends WithUploader>(items: T[]): T[] => {
    if (!uploaderFilter) return items
    if (uploaderFilter === NO_UPLOADER) return items.filter((i) => !i.uploaded_by)
    return items.filter((i) => i.uploaded_by === uploaderFilter)
  }

  // Локальный «день» ISO-даты как YYYY-MM-DD (getFullYear/Month/Date — по локальной зоне),
  // чтобы границы from/to сравнивались в терминах локального дня и совпадали со значениями <input type="date">.
  const localDayKey = (iso: string) => {
    const d = new Date(iso)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  // Диапазон дат включительно по локальному дню; пустая граница — без ограничения.
  // Лексикографическое сравнение YYYY-MM-DD совпадает с хронологическим.
  const filterByDate = <T extends { created_at: string | null }>(items: T[]): T[] => {
    if (!fromDate && !toDate) return items
    return items.filter((i) => {
      if (!i.created_at) return false
      const key = localDayKey(i.created_at)
      if (fromDate && key < fromDate) return false
      if (toDate && key > toDate) return false
      return true
    })
  }

  const applyFilters = <T extends WithProject & WithUploader & { created_at: string | null }>(items: T[]): T[] =>
    filterByDate(filterByUploader(filterByProject(items)))

  // Элементы активной вкладки для построения фильтров по объекту и автору.
  const activeItems: (WithProject & WithUploader)[] = mediaType === 'photos' ? photos : mediaType === 'videos' ? videos : pdfs
  const projectTabs = useMemo(() => buildProjectTabs(activeItems), [activeItems, t]) // eslint-disable-line react-hooks/exhaustive-deps
  const uploaderOptions = useMemo(() => buildUploaderOptions(activeItems), [activeItems, t]) // eslint-disable-line react-hooks/exhaustive-deps

  const visiblePhotos = useMemo(() => applyFilters(photos), [photos, projectFilter, uploaderFilter, fromDate, toDate]) // eslint-disable-line react-hooks/exhaustive-deps
  const visibleVideos = useMemo(() => applyFilters(videos), [videos, projectFilter, uploaderFilter, fromDate, toDate]) // eslint-disable-line react-hooks/exhaustive-deps
  const visiblePdfs = useMemo(() => applyFilters(pdfs), [pdfs, projectFilter, uploaderFilter, fromDate, toDate]) // eslint-disable-line react-hooks/exhaustive-deps

  const formatDate = (iso: string | null) => {
    if (!iso) return ''
    return new Intl.DateTimeFormat(localeByLang[lang], {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))
  }

  const categoryLabel = (category: string | null) =>
    category === 'task_photo' ? t('gallery_category_task_photo') : null

  // Перелистывание лайтбокса по текущему видимому списку фото (с учётом вкладки/фильтров), с закольцовкой.
  const navigate = (delta: number) => {
    if (visiblePhotos.length === 0) { setActive(null); return }
    const idx = active ? visiblePhotos.findIndex((p) => p.id === active.id) : -1
    // Если текущее фото отфильтровано/не найдено — прыгаем к краю в сторону движения (без падения).
    const nextIdx = idx === -1
      ? (delta > 0 ? 0 : visiblePhotos.length - 1)
      : (idx + delta + visiblePhotos.length) % visiblePhotos.length
    setActive(visiblePhotos[nextIdx])
  }

  // Сброс формы флага при смене/закрытии просматриваемого фото.
  useEffect(() => {
    setFlagReason('')
    setFlagError(null)
  }, [active?.id])

  // Клавиатура в лайтбоксе: Escape закрывает, стрелки листают текущий видимый список.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActive(null)
      else if (e.key === 'ArrowLeft') navigate(-1)
      else if (e.key === 'ArrowRight') navigate(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, visiblePhotos]) // eslint-disable-line react-hooks/exhaustive-deps

  // Общий ряд вкладок «объекты» — рендерим для каждого типа, если объекты есть.
  const projectTabsRow = projectTabs.length > 0 && (
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
  )

  const hasSecondaryFilter = uploaderFilter !== null || fromDate !== '' || toDate !== ''
  const resetSecondaryFilters = () => {
    setUploaderFilter(null)
    setFromDate('')
    setToDate('')
  }

  // Ряд дополнительных фильтров (автор + диапазон дат) — клиентские, поверх объекта/типа.
  const secondaryFiltersRow = (
    <div className="gallery-filters">
      {uploaderOptions.length > 0 && (
        <label className="gallery-filter">
          <span className="gallery-filter-label">{t('gallery_filter_uploader')}</span>
          <select value={uploaderFilter ?? ''} onChange={(e) => setUploaderFilter(e.target.value || null)}>
            <option value="">{t('gallery_filter_all_uploaders')}</option>
            {uploaderOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>{opt.name}</option>
            ))}
          </select>
        </label>
      )}
      <label className="gallery-filter">
        <span className="gallery-filter-label">{t('gallery_filter_from')}</span>
        <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} />
      </label>
      <label className="gallery-filter">
        <span className="gallery-filter-label">{t('gallery_filter_to')}</span>
        <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} />
      </label>
      {hasSecondaryFilter && (
        <button type="button" className="btn small gallery-filter-reset" onClick={resetSecondaryFilters}>
          {t('gallery_filter_reset')}
        </button>
      )}
    </div>
  )

  // Общий блок фильтров для каждого типа: вкладки объектов + автор/даты.
  const filtersBar = (
    <>
      {projectTabsRow}
      {secondaryFiltersRow}
    </>
  )

  // Кнопка «Показать ещё» — грузит следующую страницу всего набора вкладки (фильтры клиентские, поверх накопленного).
  const loadMoreButton = (hasMore: boolean, busy: boolean, onClick: () => void) =>
    hasMore && (
      <div className="gallery-load-more">
        <button type="button" className="btn" disabled={busy} onClick={onClick}>
          {busy ? t('loading') : t('gallery_load_more')}
        </button>
      </div>
    )

  return (
    <div className="screen">
      <h1>🖼️ {t('gallery')}</h1>

      <div className="tabs gallery-type-tabs">
        <button className={mediaType === 'photos' ? 'active' : ''} onClick={() => selectType('photos')}>
          {t('gallery_tab_photos')}
        </button>
        <button className={mediaType === 'videos' ? 'active' : ''} onClick={() => selectType('videos')}>
          {t('gallery_tab_videos')}
        </button>
        <button className={mediaType === 'pdfs' ? 'active' : ''} onClick={() => selectType('pdfs')}>
          {t('gallery_tab_pdfs')}
        </button>
      </div>

      {mediaType === 'photos' && (
        <>
          {loading && <div className="card center muted">{t('loading')}</div>}
          {error && <p className="error-msg">{t('load_error')}</p>}

          {!loading && !error && (
            <>
              {photos.length === 0 && <div className="card muted">{t('gallery_empty')}</div>}

              {photos.length > 0 && (
                <>
                  {filtersBar}

                  <p className="muted" style={{ fontSize: 13 }}>{visiblePhotos.length} {t('gallery_count')}</p>

                  {visiblePhotos.length === 0 && <div className="card muted">{t('gallery_empty_filter')}</div>}

                  <div className="gallery-grid">
                    {visiblePhotos.map((photo) => (
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

                  {loadMoreButton(photosHasMore, photosLoadingMore, loadMorePhotos)}
                </>
              )}
            </>
          )}
        </>
      )}

      {mediaType === 'videos' && (
        <>
          {(videosState === 'idle' || videosState === 'loading') && (
            <div className="card center muted">{t('loading')}</div>
          )}
          {videosState === 'error' && <p className="error-msg">{t('load_error')}</p>}

          {videosState === 'ready' && (
            <>
              {videos.length === 0 && <div className="card muted">{t('gallery_empty_videos')}</div>}

              {videos.length > 0 && (
                <>
                  {filtersBar}

                  <p className="muted" style={{ fontSize: 13 }}>{visibleVideos.length} {t('gallery_count_videos')}</p>

                  {visibleVideos.length === 0 && <div className="card muted">{t('gallery_empty_filter_videos')}</div>}

                  <div className="gallery-grid">
                    {visibleVideos.map((video) => (
                      <div key={video.id} className="gallery-item gallery-video">
                        <video src={video.url} controls preload="metadata" />
                      </div>
                    ))}
                  </div>

                  {loadMoreButton(videosHasMore, videosLoadingMore, loadMoreVideos)}
                </>
              )}
            </>
          )}
        </>
      )}

      {mediaType === 'pdfs' && (
        <>
          {(pdfsState === 'idle' || pdfsState === 'loading') && (
            <div className="card center muted">{t('loading')}</div>
          )}
          {pdfsState === 'error' && <p className="error-msg">{t('load_error')}</p>}

          {pdfsState === 'ready' && (
            <>
              {pdfs.length === 0 && <div className="card muted">{t('gallery_empty_pdfs')}</div>}

              {pdfs.length > 0 && (
                <>
                  {filtersBar}

                  <p className="muted" style={{ fontSize: 13 }}>{visiblePdfs.length} {t('gallery_count_pdfs')}</p>
                  {pdfError && <p className="error-msg" style={{ fontSize: 12 }}>{t('gallery_pdf_error')}</p>}

                  {visiblePdfs.length === 0 && <div className="card muted">{t('gallery_empty_filter_pdfs')}</div>}

                  {visiblePdfs.map((pdf) => (
                    <div key={pdf.id} className="card row files-item gallery-pdf-item">
                      <div>
                        <span className="item-title">📄 {pdf.name}</span>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {pdf.project_name ?? t('gallery_no_project')}
                          {pdf.created_at ? ` · ${formatDate(pdf.created_at)}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn small"
                        disabled={pdfBusyId === pdf.id}
                        onClick={() => openPdf(pdf)}
                      >
                        {t('gallery_pdf_open')}
                      </button>
                    </div>
                  ))}

                  {loadMoreButton(pdfsHasMore, pdfsLoadingMore, loadMorePdfs)}
                </>
              )}
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
          {visiblePhotos.length > 1 && (
            <>
              <button
                type="button"
                className="gallery-lightbox-nav prev"
                aria-label={t('gallery_prev')}
                onClick={(e) => { e.stopPropagation(); navigate(-1) }}
              >
                ‹
              </button>
              <button
                type="button"
                className="gallery-lightbox-nav next"
                aria-label={t('gallery_next')}
                onClick={(e) => { e.stopPropagation(); navigate(1) }}
              >
                ›
              </button>
            </>
          )}
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
