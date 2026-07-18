import { useCallback, useEffect, useRef, useState } from 'react'

// MAIL-UX-2: лайтбокс изображений письма (Gmail-стиль) — тёмный полноэкранный оверлей ВНУТРИ
// приложения (никаких отдельных вкладок/страниц). Показывает объединённый список картинок одного
// письма (inline-картинки тела + фото-вложения). Умеет: листание ← →, зум колесом и щипком (pinch),
// панораму перетаскиванием при зуме, закрытие (крестик / Esc / клик по тёмному фону), скачивание.
// Компонент api-агностичен: каждый элемент сам умеет резолвить свой URL (resolve) — для inline это
// готовый src, для вложения — подписанная r2-sign ссылка (её передаёт Mail.tsx). URL кэшируем по id.

export interface MailLightboxImage {
  id: string
  name: string | null
  // Резолвит отображаемый/скачиваемый URL картинки. Лайтбокс дёргает resolve() максимум один раз
  // на элемент (результат кэшируется по id). Для inline — Promise.resolve(src); для вложения —
  // getProjectFileDownloadUrl (r2-sign download), тот же путь скачивания, что уже есть.
  resolve: () => Promise<string>
}

interface Labels {
  close: string
  prev: string
  next: string
  download: string
  loading: string
  error: string
}

interface Props {
  images: MailLightboxImage[]
  initialIndex: number
  onClose: () => void
  labels: Labels
}

const MIN_SCALE = 1
const MAX_SCALE = 6

export default function MailImageLightbox({ images, initialIndex, onClose, labels }: Props) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, initialIndex), Math.max(0, images.length - 1)),
  )
  // Кэш резолвнутых URL по id картинки — resolve() каждой дёргаем максимум один раз.
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  // Зум/панорама текущей картинки. Сбрасываются при листании.
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)

  const current = images[index] ?? null
  const currentUrl = current ? urls[current.id] ?? null : null

  const stageRef = useRef<HTMLDivElement | null>(null)
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
    setIndex((i) => (i + delta + images.length) % images.length)
    resetView()
  }, [images.length, resetView])

  // Клавиатура: Esc — закрыть, ← → — листать между картинками письма.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, go])

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
    <div className="mail-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="mail-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        {currentUrl ? (
          // Скачать: для вложения — подписанная r2-sign ссылка (тот же путь скачивания), для inline —
          // её src. target=_blank rel=noopener — как остальные R2-скачивания приложения (не уводим
          // из приложения; при Content-Disposition:attachment вкладка не задерживается).
          <a
            className="mail-lightbox-btn"
            href={currentUrl}
            download={current?.name ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
          >
            ⬇ {labels.download}
          </a>
        ) : (
          <span className="mail-lightbox-btn disabled" aria-disabled="true">⬇ {labels.download}</span>
        )}
        <button type="button" className="mail-lightbox-btn" aria-label={labels.close} onClick={onClose}>✕</button>
      </div>

      {many && (
        <>
          <button
            type="button"
            className="mail-lightbox-nav prev"
            aria-label={labels.prev}
            onClick={(e) => { e.stopPropagation(); go(-1) }}
          >
            ‹
          </button>
          <button
            type="button"
            className="mail-lightbox-nav next"
            aria-label={labels.next}
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
        {status === 'loading' && <div className="mail-lightbox-msg">{labels.loading}</div>}
        {status === 'error' && <div className="mail-lightbox-msg">{labels.error}</div>}
        {status === 'ready' && currentUrl && (
          <img
            className="mail-lightbox-img"
            src={currentUrl}
            alt={current?.name ?? ''}
            draggable={false}
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              cursor: scale > 1 ? 'grab' : 'zoom-in',
            }}
          />
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
