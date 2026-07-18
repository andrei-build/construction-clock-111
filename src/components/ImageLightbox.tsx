import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'

// MARKUP-1: слой разметки грузим лениво — canvas/распознавание не раздувают основной бандл.
const MarkupLayer = lazy(() => import('./markup/MarkupLayer'))

// LIGHTBOX-1: единый лайтбокс изображений для ВСЕГО приложения (Закон Андрея: «все фотографии
// открываются сначала большим размером по центру окна, а если надо — на весь экран В ПРИЛОЖЕНИИ,
// не в отдельных ссылках»). Промоутнут из почтового MAIL-UX-2 в общий компонент. Тёмный оверлей
// ВНУТРИ приложения (никаких новых вкладок/target=_blank для картинок). Умеет: листание ← →,
// зум колесом и щипком (pinch), панораму перетаскиванием при зуме, «На весь экран» (Fullscreen API),
// скачивание, закрытие (крестик / Esc / клик по тёмному фону). Компонент api-агностичен: каждый
// элемент сам резолвит свой URL через resolve() — для готового src это Promise.resolve(src), для
// файла R2/медиа — подписанная download-ссылка. URL кэшируется по id (resolve дёргаем максимум раз).

export interface LightboxImage {
  id: string
  name: string | null
  // Резолвит отображаемый/скачиваемый URL картинки. Лайтбокс дёргает resolve() максимум один раз
  // на элемент (результат кэшируется по id). Reject → статус ошибки для этого элемента.
  resolve: () => Promise<string>
  // MARKUP-1 (необязательно): сохранить PNG-копию с разметкой рядом с оригиналом через загрузчик
  // экрана (переиспользуем существующий upload; api.ts не трогаем). Не задан → в разметке доступно
  // только «Скачать». Экран сам решает, куда класть копию (файлы проекта/клиента/…).
  saveMarkup?: (blob: Blob, name: string) => Promise<void>
}

// MAIL-UX-2 совместимость: старое имя типа сохраняем как алиас.
export type MailLightboxImage = LightboxImage

interface Props {
  images: LightboxImage[]
  initialIndex: number
  onClose: () => void
}

const MIN_SCALE = 1
const MAX_SCALE = 6

export default function ImageLightbox({ images, initialIndex, onClose }: Props) {
  const { t } = useI18n()
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, initialIndex), Math.max(0, images.length - 1)),
  )
  // Кэш резолвнутых URL по id картинки — resolve() каждой дёргаем максимум один раз.
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [isFull, setIsFull] = useState(false)
  // MARKUP-1: активен ли слой разметки поверх текущей картинки.
  const [markup, setMarkup] = useState(false)

  // Зум/панорама текущей картинки. Сбрасываются при листании.
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)

  const current = images[index] ?? null
  const currentUrl = current ? urls[current.id] ?? null : null

  const rootRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  // Активные указатели (pointerId → координаты) для панорамы/пинча; pinchDist — прошлое расстояние
  // между двумя пальцами (для вычисления коэффициента масштаба).
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchDist = useRef<number | null>(null)

  const resetView = useCallback(() => { setScale(1); setTx(0); setTy(0) }, [])

  // Резолв URL текущей картинки (с кэшем). Меняем статус loading/ready/error.
  useEffect(() => {
    if (!current) return
    if (urls[current.id]) { setStatus('ready'); return }
    let cancelled = false
    setStatus('loading')
    current.resolve().then(
      (url) => { if (!cancelled) { setUrls((p) => ({ ...p, [current.id]: url })); setStatus('ready') } },
      () => { if (!cancelled) setStatus('error') },
    )
    return () => { cancelled = true }
  }, [current, urls])

  const go = useCallback((delta: number) => {
    if (images.length === 0) return
    setMarkup(false) // MARKUP-1: смена картинки закрывает слой разметки (не переносим штрихи на другое фото).
    setIndex((i) => (i + delta + images.length) % images.length)
    resetView()
  }, [images.length, resetView])

  // Вход в разметку — с чистого вида (масштаб 1, без панорамы), чтобы холст совпал с картинкой.
  const toggleMarkup = useCallback(() => {
    setMarkup((m) => {
      if (!m) resetView()
      return !m
    })
  }, [resetView])

  // Клавиатура: Esc — закрыть, ← → — листать между картинками.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // MARKUP-1: в разметке Esc выходит из слоя, а не закрывает лайтбокс.
        if (markup) { setMarkup(false); return }
        if (!document.fullscreenElement) onClose()
      } else if (markup) {
        // Не листаем картинки, пока открыт слой разметки (стрелки могут набираться в заметке).
        return
      } else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, go, markup])

  // «На весь экран» через Fullscreen API поверх оверлея. Синхронизируем локальный флаг с реальным
  // состоянием (пользователь может выйти из fullscreen системным Esc/жестом).
  useEffect(() => {
    const onFsChange = () => setIsFull(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    if (document.fullscreenElement) {
      void document.exitFullscreen?.()
    } else {
      void el.requestFullscreen?.().catch(() => {})
    }
  }, [])

  // Зум колесом мыши. React-обработчик onWheel пассивный (preventDefault не сработает и страница
  // проскроллится), поэтому вешаем нативный слушатель с { passive: false } на сцену.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setScale((s) => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s - e.deltaY * 0.0015 * s))
        if (next <= MIN_SCALE + 0.001) { setTx(0); setTy(0) }
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const pts = pointers.current
    const prev = pts.get(e.pointerId)
    if (!prev) return
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.size >= 2) {
      // Пинч: масштаб по изменению расстояния между двумя пальцами.
      const [a, b] = Array.from(pts.values())
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchDist.current != null && pinchDist.current > 0) {
        const ratio = dist / pinchDist.current
        setScale((s) => {
          const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * ratio))
          if (next <= MIN_SCALE + 0.001) { setTx(0); setTy(0) }
          return next
        })
      }
      pinchDist.current = dist
    } else if (scale > 1) {
      // Панорама одним указателем при зуме.
      setTx((x) => x + (e.clientX - prev.x))
      setTy((y) => y + (e.clientY - prev.y))
    }
  }
  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchDist.current = null
  }

  const many = images.length > 1
  return (
    <div className="mail-lightbox" role="dialog" aria-modal="true" ref={rootRef} onClick={onClose}>
      <div className="mail-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        {status === 'ready' && currentUrl && (
          <button
            type="button"
            className={`mail-lightbox-btn${markup ? ' active' : ''}`}
            aria-label={t('markup_toggle')}
            aria-pressed={markup}
            onClick={toggleMarkup}
          >
            ✏️ {t('markup_toggle')}
          </button>
        )}
        <button
          type="button"
          className="mail-lightbox-btn"
          aria-label={isFull ? t('lightbox_fullscreen_exit') : t('lightbox_fullscreen')}
          onClick={toggleFullscreen}
        >
          {isFull ? '🗕' : '⛶'} {isFull ? t('lightbox_fullscreen_exit') : t('lightbox_fullscreen')}
        </button>
        {currentUrl ? (
          // Скачать: подписанная download-ссылка (или готовый src). target=_blank rel=noopener — это
          // ЯВНОЕ действие «скачать» (Content-Disposition), а не просмотр картинки; просмотр всегда
          // остаётся внутри приложения. Как остальные R2-скачивания приложения.
          <a
            className="mail-lightbox-btn"
            href={currentUrl}
            download={current?.name ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
          >
            ⬇ {t('lightbox_download')}
          </a>
        ) : (
          <span className="mail-lightbox-btn disabled" aria-disabled="true">⬇ {t('lightbox_download')}</span>
        )}
        <button type="button" className="mail-lightbox-btn" aria-label={t('lightbox_close')} onClick={onClose}>✕</button>
      </div>

      {many && !markup && (
        <>
          <button
            type="button"
            className="mail-lightbox-nav prev"
            aria-label={t('lightbox_prev')}
            onClick={(e) => { e.stopPropagation(); go(-1) }}
          >
            ‹
          </button>
          <button
            type="button"
            className="mail-lightbox-nav next"
            aria-label={t('lightbox_next')}
            onClick={(e) => { e.stopPropagation(); go(1) }}
          >
            ›
          </button>
        </>
      )}

      <div
        className="mail-lightbox-stage"
        ref={stageRef}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        {status === 'loading' && <div className="mail-lightbox-msg">{t('lightbox_loading')}</div>}
        {status === 'error' && <div className="mail-lightbox-msg">{t('lightbox_error')}</div>}
        {status === 'ready' && currentUrl && (
          // MARKUP-1: img + слой разметки в одной трансформируемой обёртке — canvas всегда совпадает с
          // картинкой при любом зуме/панораме (родитель масштабируется, координаты берём из bounding rect).
          <div
            className="mail-lightbox-canvaswrap"
            style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
          >
            <img
              ref={imgRef}
              className="mail-lightbox-img"
              src={currentUrl}
              alt={current?.name ?? ''}
              draggable={false}
              style={{ cursor: markup ? 'crosshair' : scale > 1 ? 'grab' : 'zoom-in' }}
            />
            {markup && imgRef.current && (
              <Suspense fallback={null}>
                <MarkupLayer
                  key={current?.id}
                  imageEl={imgRef.current}
                  imageName={current?.name ?? null}
                  saveMarkup={current?.saveMarkup}
                  portalTarget={rootRef.current}
                  onExit={() => setMarkup(false)}
                  t={t}
                />
              </Suspense>
            )}
          </div>
        )}
      </div>

      {many && (
        <div className="mail-lightbox-count" onClick={(e) => e.stopPropagation()}>
          {index + 1} / {images.length}
        </div>
      )}
    </div>
  )
}

// Удобный хук: локальное состояние лайтбокса + готовый узел для рендера. Позволяет любому экрану
// подключить общий лайтбокс тремя строчками: const lb = useImageLightbox(); lb.open(imgs, i); {lb.node}
export function useImageLightbox() {
  const [state, setState] = useState<{ images: LightboxImage[]; index: number } | null>(null)
  const open = useCallback((images: LightboxImage[], index = 0) => {
    if (images.length === 0) return
    setState({ images, index: Math.min(Math.max(0, index), images.length - 1) })
  }, [])
  const close = useCallback(() => setState(null), [])
  const node = state
    ? <ImageLightbox images={state.images} initialIndex={state.index} onClose={close} />
    : null
  return { open, close, node }
}
