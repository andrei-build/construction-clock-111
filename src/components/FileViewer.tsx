import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import {
  clampScale,
  fileViewKind,
  pdfPageSrc,
  MIN_SCALE,
} from './fileViewerCore'

// FILES-VIEWER-37: полноэкранный ВСТРОЕННЫЙ просмотрщик ЛЮБЫХ файлов проекта (Закон Андрея:
// «файл на весь экран», изображения/файлы открываются ВСТРОЕННО в приложении, НИКОГДА через
// window.open). Тёмный оверлей-портал в духе ImageLightbox, но для не-фото (PDF/документы) и как
// общий вход из вкладки «Файлы и медиа». Фото по-прежнему живут на ImageLightbox — его не трогаем.
//
// PDF рендерим браузерно-нативно через <iframe src=url#page=1&view=FitH> — БЕЗ новых зависимостей
// (в package.json нет pdf.js). Постраничную навигацию, зум и «вписать» даёт СОБСТВЕННЫЙ тулбар
// встроенного PDF-вьювера браузера (сам показывает «N из M»). Замер показал: Chromium/Edge внутри
// <iframe> ИГНОРИРУЕТ якорь #page=N (проверено path/blob/view=Fit/FitH/zoom), поэтому свои кнопки
// «±страница» не рисуем — они не двигали бы документ (это ложное «работает криво»). Спека прямо
// разрешает такой фолбэк: «положись на нативную прокрутку встроенного вьювера». Начальный
// #page=1&view=FitH задаёт вписывание по ширине при открытии. Изображения — свой зум/пан/колесо/пинч.
// Прочие типы (docx/xlsx/…) пытаемся показать в <iframe>; если браузер не умеет — есть «Скачать».
//
// Это ФУНДАМЕНТ серии PLAN-TO-ESTIMATE: на просмотрщик далее лягут слой пинов (#38) и переход из
// строки сметы (#39). Сейчас — только базовый просмотр.

export interface ViewerFile {
  name: string
  url: string
  mime: string | null
}

interface Props {
  file: ViewerFile
  onClose: () => void
}

export default function FileViewer({ file, onClose }: Props) {
  const { t } = useI18n()
  const kind = fileViewKind(file.mime, file.name)

  // Изображение: зум/панорама.
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchDist = useRef<number | null>(null)

  const resetView = useCallback(() => { setScale(1); setTx(0); setTy(0) }, [])

  // Esc — закрыть (когда не в системном fullscreen).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Зум колесом (только для изображений). Нативный слушатель { passive:false } — иначе preventDefault
  // не сработает и страница проскроллится (как в ImageLightbox).
  useEffect(() => {
    if (kind !== 'image') return
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setScale((s) => {
        const next = clampScale(s - e.deltaY * 0.0015 * s)
        if (next <= MIN_SCALE + 0.001) { setTx(0); setTy(0) }
        return next
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [kind])

  const onPointerDown = (e: React.PointerEvent) => {
    if (kind !== 'image') return
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (kind !== 'image') return
    const pts = pointers.current
    const prev = pts.get(e.pointerId)
    if (!prev) return
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.size >= 2) {
      const [a, b] = Array.from(pts.values())
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchDist.current != null && pinchDist.current > 0) {
        const ratio = dist / pinchDist.current
        setScale((s) => {
          const next = clampScale(s * ratio)
          if (next <= MIN_SCALE + 0.001) { setTx(0); setTy(0) }
          return next
        })
      }
      pinchDist.current = dist
    } else if (scale > 1) {
      setTx((x) => x + (e.clientX - prev.x))
      setTy((y) => y + (e.clientY - prev.y))
    }
  }
  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchDist.current = null
  }

  const zoomBy = (delta: number) => {
    setScale((s) => {
      const next = clampScale(s + delta)
      if (next <= MIN_SCALE + 0.001) { setTx(0); setTy(0) }
      return next
    })
  }

  return (
    <div className="file-viewer" role="dialog" aria-modal="true" ref={rootRef} onClick={onClose}>
      <div className="file-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="file-viewer-name" title={file.name}>{file.name}</span>

        {kind === 'image' && (
          <span className="file-viewer-pager">
            <button type="button" className="file-viewer-btn" aria-label={t('viewer_zoom_out')} onClick={() => zoomBy(-0.5)}>−</button>
            <button type="button" className="file-viewer-btn" aria-label={t('viewer_fit')} onClick={resetView}>{t('viewer_fit')}</button>
            <button type="button" className="file-viewer-btn" aria-label={t('viewer_zoom_in')} onClick={() => zoomBy(0.5)}>+</button>
          </span>
        )}

        <a
          className="file-viewer-btn"
          href={file.url}
          download={file.name}
          target="_blank"
          rel="noopener noreferrer"
        >
          ⬇ {t('viewer_download')}
        </a>
        <button type="button" className="file-viewer-btn" aria-label={t('viewer_close')} onClick={onClose}>✕</button>
      </div>

      <div
        className="file-viewer-stage"
        ref={stageRef}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        {kind === 'image' && (
          <img
            className="file-viewer-img"
            src={file.url}
            alt={file.name}
            draggable={false}
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              cursor: scale > 1 ? 'grab' : 'zoom-in',
            }}
          />
        )}

        {kind === 'pdf' && (
          <iframe
            className="file-viewer-frame"
            title={file.name}
            src={pdfPageSrc(file.url, 1)}
          />
        )}

        {kind === 'other' && (
          <iframe
            className="file-viewer-frame"
            title={file.name}
            src={file.url}
          />
        )}
      </div>

      {kind === 'other' && (
        <div className="file-viewer-hint" onClick={(e) => e.stopPropagation()}>
          {t('viewer_other_hint')}
        </div>
      )}
    </div>
  )
}

// Хук по образцу useImageLightbox: локальное состояние + готовый узел. URL резолвит вызывающий
// (как видео-оверлей) и передаёт готовым — просмотрщик сам ничего не подписывает.
export function useFileViewer() {
  const [file, setFile] = useState<ViewerFile | null>(null)
  const open = useCallback((f: ViewerFile) => setFile(f), [])
  const close = useCallback(() => setFile(null), [])
  const node = file ? <FileViewer file={file} onClose={close} /> : null
  return { open, close, node }
}
