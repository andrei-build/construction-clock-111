import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import {
  clampScale,
  fileViewKind,
  pdfPageSrc,
  MIN_SCALE,
} from './fileViewerCore'
import {
  PIN_KINDS,
  PIN_SEVERITIES,
  pinColor,
  pinEmoji,
  pinPercent,
  pointToBbox,
  type PinKind,
  type PinSeverity,
  type PlanPinBbox,
} from '../lib/planPinCore'
import type { PlanPin } from '../lib/api/estimate'

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
// PIN-LAYER-38: поверх области страницы кладём слой цветных пинов (plan_pins). Позиция пина —
// в ДОЛЯХ 0..1 области страницы, поэтому кружки едут вместе с зумом/паном (для изображения слой
// разделяет transform картинки; для PDF iframe заполняет всю сцену — доли = доли страницы).
// Клик по пину → карточка (title/note/kind). owner/admin получают режим «Добавить пин»: клик по
// странице → форма → createPlanPin. Данные и колбэк прокидывает вызывающий через fv.open (пины
// подгружаются там, где есть profile+project). Всё опционально — базовый просмотр #37 не ломается.

export interface ViewerPinDraft {
  page: number
  bbox: PlanPinBbox
  severity: PinSeverity
  kind: PinKind
  title: string | null
  note: string | null
}

export interface ViewerFile {
  name: string
  url: string
  mime: string | null
  // PIN-LAYER-38 (опционально, обратная совместимость с 2 вызовами #37):
  pins?: PlanPin[]
  canAddPin?: boolean
  onAddPin?: (draft: ViewerPinDraft) => Promise<PlanPin>
}

interface Props {
  file: ViewerFile
  onClose: () => void
}

export default function FileViewer({ file, onClose }: Props) {
  const { t } = useI18n()
  const kind = fileViewKind(file.mime, file.name)
  const pinnable = kind === 'pdf' || kind === 'image'

  // Изображение: зум/панорама.
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)

  // PIN-LAYER-38: локальный список пинов (сид из file.pins), режим добавления, открытая карточка,
  // черновик формы. Пересеваем при смене файла.
  const [pins, setPins] = useState<PlanPin[]>(file.pins ?? [])
  const [addMode, setAddMode] = useState(false)
  const [openPinId, setOpenPinId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ViewerPinDraft | null>(null)
  const [savingPin, setSavingPin] = useState(false)
  const [pinError, setPinError] = useState(false)

  useEffect(() => {
    setPins(file.pins ?? [])
    setAddMode(false)
    setOpenPinId(null)
    setDraft(null)
    setPinError(false)
  }, [file])

  const rootRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchDist = useRef<number | null>(null)

  const resetView = useCallback(() => { setScale(1); setTx(0); setTy(0) }, [])

  const openPin = openPinId ? pins.find((p) => p.id === openPinId) ?? null : null

  // Esc — сперва закрывает карточку/форму/режим добавления, и только потом — сам просмотрщик
  // (когда не в системном fullscreen).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.fullscreenElement) return
      if (draft) { setDraft(null); return }
      if (openPinId) { setOpenPinId(null); return }
      if (addMode) { setAddMode(false); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, draft, openPinId, addMode])

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

  // Клик по слою пинов в режиме добавления → черновик формы на позиции (доли 0..1 области слоя).
  const onLayerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!addMode || draft) return
    const rect = e.currentTarget.getBoundingClientRect()
    const bbox = pointToBbox(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height)
    setPinError(false)
    setOpenPinId(null)
    setDraft({ page: 1, bbox, severity: 'green', kind: 'estimate', title: '', note: '' })
  }

  const saveDraft = async () => {
    if (!draft || !file.onAddPin || savingPin) return
    setSavingPin(true)
    setPinError(false)
    try {
      const created = await file.onAddPin(draft)
      setPins((prev) => [...prev, created])
      setDraft(null)
    } catch {
      setPinError(true)
    } finally {
      setSavingPin(false)
    }
  }

  // Слой пинов и картинки делят одну трансформацию, чтобы кружки не «отклеивались» при зуме/пане.
  const layerTransform = kind === 'image' ? `translate(${tx}px, ${ty}px) scale(${scale})` : undefined

  const canAdd = !!(file.canAddPin && file.onAddPin && pinnable)

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

        {canAdd && (
          <button
            type="button"
            className={`file-viewer-btn plan-pin-add-toggle${addMode ? ' active' : ''}`}
            aria-pressed={addMode}
            onClick={() => { setAddMode((v) => !v); setDraft(null); setOpenPinId(null) }}
          >
            📌 {addMode ? t('pin_add_done') : t('pin_add')}
          </button>
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

        {/* PIN-LAYER-38: слой пинов поверх страницы. pointer-events:none у слоя (чтобы не мешать
            прокрутке PDF/зуму картинки), auto — у самих кружков; в режиме добавления слой ловит клик. */}
        {pinnable && (
          <div
            className={`plan-pin-layer${addMode ? ' adding' : ''}`}
            style={layerTransform ? { transform: layerTransform } : undefined}
            onClick={onLayerClick}
          >
            {pins.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`plan-pin${openPinId === p.id ? ' open' : ''}`}
                style={{ left: pinPercent(p.bbox.x), top: pinPercent(p.bbox.y), background: pinColor(p.severity) }}
                aria-label={p.title || t('pin_add')}
                onClick={(e) => {
                  e.stopPropagation()
                  if (addMode) return
                  setDraft(null)
                  setOpenPinId((cur) => (cur === p.id ? null : p.id))
                }}
              />
            ))}

            {draft && (
              <div
                className="plan-pin-marker"
                style={{ left: pinPercent(draft.bbox.x), top: pinPercent(draft.bbox.y), background: pinColor(draft.severity) }}
                aria-hidden="true"
              />
            )}
          </div>
        )}

        {/* Карточка открытого пина. */}
        {openPin && (
          <div className="plan-pin-card" onClick={(e) => e.stopPropagation()}>
            <div className="plan-pin-card-head">
              <span className="plan-pin-badge" style={{ background: pinColor(openPin.severity) }}>
                {pinEmoji(openPin.severity)}
              </span>
              <span className="plan-pin-card-title">{openPin.title || t('pin_untitled')}</span>
              <button
                type="button"
                className="file-viewer-btn plan-pin-card-close"
                aria-label={t('viewer_close')}
                onClick={() => setOpenPinId(null)}
              >
                ✕
              </button>
            </div>
            <div className="plan-pin-card-kind">{t(`pin_kind_${openPin.kind}`)}</div>
            {openPin.note && <div className="plan-pin-card-note">{openPin.note}</div>}
          </div>
        )}

        {/* Форма нового пина (owner/admin). */}
        {draft && (
          <div className="plan-pin-form" onClick={(e) => e.stopPropagation()}>
            <div className="plan-pin-form-row plan-pin-sev">
              {PIN_SEVERITIES.map((sev) => (
                <button
                  key={sev}
                  type="button"
                  className={`plan-pin-sev-btn${draft.severity === sev ? ' active' : ''}`}
                  aria-pressed={draft.severity === sev}
                  onClick={() => setDraft((d) => (d ? { ...d, severity: sev } : d))}
                >
                  {pinEmoji(sev)}
                </button>
              ))}
            </div>
            <input
              className="plan-pin-input"
              type="text"
              placeholder={t('pin_title')}
              value={draft.title ?? ''}
              onChange={(e) => setDraft((d) => (d ? { ...d, title: e.target.value } : d))}
            />
            <textarea
              className="plan-pin-input plan-pin-note"
              placeholder={t('pin_note')}
              value={draft.note ?? ''}
              onChange={(e) => setDraft((d) => (d ? { ...d, note: e.target.value } : d))}
            />
            <select
              className="plan-pin-input"
              aria-label={t('pin_kind')}
              value={draft.kind}
              onChange={(e) => setDraft((d) => (d ? { ...d, kind: e.target.value as PinKind } : d))}
            >
              {PIN_KINDS.map((k) => (
                <option key={k} value={k}>{t(`pin_kind_${k}`)}</option>
              ))}
            </select>
            {pinError && <p className="error-msg plan-pin-error">{t('pin_save_failed')}</p>}
            <div className="plan-pin-form-row plan-pin-form-actions">
              <button type="button" className="btn small ghost" onClick={() => setDraft(null)} disabled={savingPin}>
                {t('pin_cancel')}
              </button>
              <button type="button" className="btn small primary" onClick={saveDraft} disabled={savingPin}>
                {savingPin ? t('pin_saving') : t('pin_save')}
              </button>
            </div>
          </div>
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
