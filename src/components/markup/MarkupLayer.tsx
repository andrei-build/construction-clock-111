import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { boundingBox, recognize, snapLine, type Pt, type Shape } from './markupRecognize'
import { drawElements, distanceToElement, type MarkupElement } from './markupRender'

// MARKUP-1: слой рисования поверх картинки лайтбокса. Рисуем в координатах ИЗОБРАЖЕНИЯ (canvas в натуральном
// разрешении), поэтому разметка одинаково ложится при любом зуме/панораме лайтбокса (родитель трансформируется —
// canvas.getBoundingClientRect() уже учитывает масштаб). Тулбар/тосты — через портал (fixed, не трансформируются).
// Автоисправление каждого штриха пера — recognize() из markupRecognize.ts. Лениво подгружается лайтбоксом.

export type Tool = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'eraser'

interface Props {
  imageEl: HTMLImageElement
  imageName: string | null
  // Сохранить PNG-копию рядом с оригиналом (переиспоует загрузчик экрана). Нет → доступно только «Скачать».
  saveMarkup?: (blob: Blob, name: string) => Promise<void>
  // Куда портировать тулбар/тосты: корень лайтбокса (чтобы они были видны и в полноэкранном режиме).
  portalTarget?: HTMLElement | null
  onExit: () => void
  t: (k: string) => string
}

const COLORS = ['#ef4444', '#facc15', '#ffffff', '#111827', '#3b82f6']
const TOOLS: { key: Tool; icon: string; label: string }[] = [
  { key: 'pen', icon: '✏️', label: 'markup_tool_pen' },
  { key: 'line', icon: '╱', label: 'markup_tool_line' },
  { key: 'arrow', icon: '↗', label: 'markup_tool_arrow' },
  { key: 'rect', icon: '▭', label: 'markup_tool_rect' },
  { key: 'ellipse', icon: '◯', label: 'markup_tool_ellipse' },
  { key: 'text', icon: 'T', label: 'markup_tool_text' },
  { key: 'eraser', icon: '🧽', label: 'markup_tool_eraser' },
]

function uid(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `m${performance.now()}`
}

function rectFrom(a: Pt, b: Pt): Shape {
  return { kind: 'rect', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}
function ellipseFrom(a: Pt, b: Pt): Shape {
  return { kind: 'ellipse', cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, rx: Math.abs(b.x - a.x) / 2, ry: Math.abs(b.y - a.y) / 2 }
}

function loadCrossOrigin(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('cors-load-failed'))
    img.src = src
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob-null'))), 'image/png')
  })
}

export default function MarkupLayer({ imageEl, imageName, saveMarkup, portalTarget, onExit, t }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(COLORS[0])
  const [widthLevel, setWidthLevel] = useState(1) // 0..2

  // Модель элементов + история — через ref (быстрая императивная перерисовка) + force для ререндера тулбара.
  const elementsRef = useRef<MarkupElement[]>([])
  const pastRef = useRef<MarkupElement[][]>([])
  const futureRef = useRef<MarkupElement[][]>([])
  const [, force] = useReducer((x: number) => x + 1, 0)

  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ name: string; url: string; note?: string } | null>(null)
  const [keep, setKeep] = useState<{ id: string; raw: MarkupElement } | null>(null)
  const keepTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [textDraft, setTextDraft] = useState<{ x: number; y: number; sx: number; sy: number; value: string } | null>(null)

  // Ход рисования (императивный — без per-move ререндеров React).
  const drawing = useRef<{ id: number; raw: Pt[]; start: Pt; type: Tool } | null>(null)
  const penActive = useRef(false)

  // Натуральный размер картинки → бэкинг-стор canvas. Ждём загрузки, если ещё не готова.
  useEffect(() => {
    const apply = () => {
      if (imageEl.naturalWidth > 0) setDims({ w: imageEl.naturalWidth, h: imageEl.naturalHeight })
    }
    if (imageEl.complete) apply()
    imageEl.addEventListener('load', apply)
    return () => imageEl.removeEventListener('load', apply)
  }, [imageEl])

  // Толщина/размер текста — доля от меньшей стороны, чтобы вид не зависел от разрешения картинки.
  const strokeWidth = useCallback(() => {
    const base = dims ? Math.min(dims.w, dims.h) : 400
    return [Math.max(2, base * 0.006), Math.max(3, base * 0.012), Math.max(5, base * 0.02)][widthLevel]
  }, [dims, widthLevel])
  const textSize = useCallback(() => {
    const base = dims ? Math.min(dims.w, dims.h) : 400
    return Math.max(14, base * 0.045)
  }, [dims])

  const redraw = useCallback((preview?: MarkupElement) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    drawElements(ctx, elementsRef.current)
    if (preview) drawElements(ctx, [preview])
  }, [])

  useEffect(() => { redraw() }, [dims, redraw])
  // Перерисовка после каждого force (undo/redo/commit/keep).
  useEffect(() => { redraw() })

  const setElements = (next: MarkupElement[]) => { elementsRef.current = next; force() }
  const commit = (next: MarkupElement[]) => {
    pastRef.current.push(elementsRef.current)
    futureRef.current = []
    setElements(next)
  }
  const undo = () => {
    if (!pastRef.current.length) return
    futureRef.current.unshift(elementsRef.current)
    setElements(pastRef.current.pop() as MarkupElement[])
  }
  const redo = () => {
    if (!futureRef.current.length) return
    pastRef.current.push(elementsRef.current)
    setElements(futureRef.current.shift() as MarkupElement[])
  }

  const showKeep = useCallback((id: string, raw: MarkupElement) => {
    if (keepTimer.current) clearTimeout(keepTimer.current)
    setKeep({ id, raw })
    keepTimer.current = setTimeout(() => setKeep(null), 3000)
  }, [])
  const acceptKeep = () => {
    if (!keep) return
    commit(elementsRef.current.map((e) => (e.id === keep.id ? keep.raw : e)))
    if (keepTimer.current) clearTimeout(keepTimer.current)
    setKeep(null)
  }

  const pointFromEvent = (e: React.PointerEvent): Pt => {
    const canvas = canvasRef.current as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    const sx = rect.width > 0 ? canvas.width / rect.width : 1
    const sy = rect.height > 0 ? canvas.height / rect.height : 1
    return {
      x: Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * sx)),
      y: Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * sy)),
    }
  }

  const eraseAt = (p: Pt) => {
    const thr = Math.max(12, strokeWidth() * 2.5)
    const els = elementsRef.current
    for (let i = els.length - 1; i >= 0; i--) {
      if (distanceToElement(p, els[i]) <= thr) {
        commit([...els.slice(0, i), ...els.slice(i + 1)])
        return
      }
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (saving) return
    // Palm rejection: пока идёт штрих пером — игнорируем касания ладонью/пальцем.
    if (e.pointerType === 'touch' && penActive.current) return
    if (drawing.current) return
    const p = pointFromEvent(e)
    if (keep) { if (keepTimer.current) clearTimeout(keepTimer.current); setKeep(null) }

    if (tool === 'text') {
      setTextDraft({ x: p.x, y: p.y, sx: e.clientX, sy: e.clientY, value: '' })
      return
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    if (tool === 'eraser') {
      drawing.current = { id: e.pointerId, raw: [p], start: p, type: 'eraser' }
      eraseAt(p)
      return
    }
    if (e.pointerType === 'pen') penActive.current = true
    drawing.current = { id: e.pointerId, raw: [p], start: p, type: tool }
  }

  const previewFor = (type: Tool, start: Pt, cur: Pt, raw: Pt[]): MarkupElement | undefined => {
    const base = { id: 'preview', color, width: strokeWidth() }
    switch (type) {
      case 'pen': return { ...base, shape: { kind: 'path', points: raw } }
      case 'line': return { ...base, shape: { kind: 'line', a: start, b: cur } }
      case 'arrow': return { ...base, shape: { kind: 'arrow', a: start, b: cur } }
      case 'rect': return { ...base, shape: rectFrom(start, cur) }
      case 'ellipse': return { ...base, shape: ellipseFrom(start, cur) }
      default: return undefined
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drawing.current
    if (!d || e.pointerId !== d.id) return
    e.stopPropagation()
    const p = pointFromEvent(e)
    if (d.type === 'eraser') { eraseAt(p); return }
    d.raw.push(p)
    redraw(previewFor(d.type, d.start, p, d.raw))
  }

  const finishStroke = (e: React.PointerEvent) => {
    const d = drawing.current
    if (!d || e.pointerId !== d.id) return
    drawing.current = null
    if (e.pointerType === 'pen') penActive.current = false
    if (d.type === 'eraser') return

    const end = d.raw[d.raw.length - 1] ?? d.start
    const width = strokeWidth()
    const id = uid()

    if (d.type === 'pen') {
      const moved = boundingBox(d.raw)
      if (Math.hypot(moved.w, moved.h) < 2 && d.raw.length < 2) {
        commit([...elementsRef.current, { id, color, width, shape: { kind: 'path', points: d.raw } }])
        return
      }
      const shape = recognize(d.raw)
      commit([...elementsRef.current, { id, color, width, shape }])
      // Автоисправление сработало (не «path») → предложить «оставить как нарисовано».
      if (shape.kind !== 'path') {
        showKeep(id, { id, color, width, shape: { kind: 'path', points: d.raw } })
      }
      return
    }

    // Инструменты-фигуры: без распознавания, точная фигура по перетаскиванию (вырожденные пропускаем).
    if (Math.hypot(end.x - d.start.x, end.y - d.start.y) < 3) { redraw(); return }
    let shape: Shape
    if (d.type === 'line') shape = snapLine(d.start, end)
    else if (d.type === 'arrow') shape = { kind: 'arrow', a: d.start, b: end }
    else if (d.type === 'rect') shape = rectFrom(d.start, end)
    else shape = ellipseFrom(d.start, end)
    commit([...elementsRef.current, { id, color, width, shape }])
  }

  const onPointerCancel = (e: React.PointerEvent) => {
    if (drawing.current && e.pointerId === drawing.current.id) {
      drawing.current = null
      if (e.pointerType === 'pen') penActive.current = false
      redraw()
    }
  }

  const commitText = () => {
    if (!textDraft) return
    const text = textDraft.value.trim()
    if (text) {
      commit([...elementsRef.current, { id: uid(), color, width: strokeWidth(), shape: { kind: 'text', x: textDraft.x, y: textDraft.y, text, size: textSize() } }])
    }
    setTextDraft(null)
  }

  // Компоновка PNG: картинка (через CORS-изображение, чтобы canvas не «протух») + слой разметки.
  // Если CORS запрещён (напр. R2-бакет без CORS) — сохраняем прозрачный слой разметки и помечаем это.
  const compose = async (): Promise<{ blob: Blob; note?: string }> => {
    const w = dims?.w ?? imageEl.naturalWidth
    const h = dims?.h ?? imageEl.naturalHeight
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const octx = out.getContext('2d') as CanvasRenderingContext2D
    try {
      const corsImg = await loadCrossOrigin(imageEl.src)
      octx.drawImage(corsImg, 0, 0, w, h)
      drawElements(octx, elementsRef.current)
      return { blob: await canvasToBlob(out) }
    } catch {
      // Фон недоступен из-за CORS → чистый слой аннотаций (прозрачный фон), честно помечаем в тосте.
      const only = document.createElement('canvas')
      only.width = w
      only.height = h
      drawElements(only.getContext('2d') as CanvasRenderingContext2D, elementsRef.current)
      return { blob: await canvasToBlob(only), note: t('markup_saved_overlay_only') }
    }
  }

  const copyName = (n: number): string => {
    const base = (imageName ?? 'image').replace(/\.[a-z0-9]{1,5}$/i, '')
    return `${base}-markup-${n}.png`
  }
  const saveCounter = useRef(0)

  const onSaveCopy = async () => {
    if (saving || !dims) return
    setSaving(true)
    try {
      const { blob, note } = await compose()
      const name = copyName(++saveCounter.current)
      if (saveMarkup) await saveMarkup(blob, name)
      const url = URL.createObjectURL(blob)
      setToast({ name, url, note: saveMarkup ? note : t('markup_download_only') })
    } catch {
      setToast({ name: '', url: '', note: t('markup_save_failed') })
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => () => {
    if (keepTimer.current) clearTimeout(keepTimer.current)
  }, [])

  const canUndo = pastRef.current.length > 0
  const canRedo = futureRef.current.length > 0

  const toolbar = createPortal(
    <>
      <div className="markup-toolbar" role="toolbar" aria-label={t('markup_toolbar')} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <div className="markup-group">
          {TOOLS.map((tl) => (
            <button
              key={tl.key}
              type="button"
              className={`markup-btn${tool === tl.key ? ' active' : ''}`}
              aria-pressed={tool === tl.key}
              aria-label={t(tl.label)}
              title={t(tl.label)}
              onClick={() => setTool(tl.key)}
            >
              <span aria-hidden="true">{tl.icon}</span>
            </button>
          ))}
        </div>
        <div className="markup-group">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`markup-swatch${color === c ? ' active' : ''}`}
              style={{ background: c }}
              aria-label={c}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <div className="markup-group">
          {[0, 1, 2].map((lvl) => (
            <button
              key={lvl}
              type="button"
              className={`markup-btn markup-width${widthLevel === lvl ? ' active' : ''}`}
              aria-label={t('markup_width')}
              aria-pressed={widthLevel === lvl}
              onClick={() => setWidthLevel(lvl)}
            >
              <span className="markup-width-dot" style={{ width: 4 + lvl * 5, height: 4 + lvl * 5 }} />
            </button>
          ))}
        </div>
        <div className="markup-group">
          <button type="button" className="markup-btn" disabled={!canUndo} aria-label={t('markup_undo')} onClick={undo}>↶</button>
          <button type="button" className="markup-btn" disabled={!canRedo} aria-label={t('markup_redo')} onClick={redo}>↷</button>
        </div>
        <div className="markup-group">
          {saveMarkup && (
            <button type="button" className="markup-btn markup-save" disabled={saving || elementsRef.current.length === 0} onClick={onSaveCopy}>
              {saving ? t('markup_saving') : t('markup_save_copy')}
            </button>
          )}
          {!saveMarkup && (
            <button type="button" className="markup-btn markup-save" disabled={saving || elementsRef.current.length === 0} onClick={onSaveCopy}>
              {saving ? t('markup_saving') : t('markup_download')}
            </button>
          )}
          <button type="button" className="markup-btn markup-done" onClick={onExit}>{t('markup_done')}</button>
        </div>
      </div>

      {keep && (
        <div className="markup-keep" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <span>{t('markup_corrected')}</span>
          <button type="button" onClick={acceptKeep}>{t('markup_keep_as_drawn')}</button>
        </div>
      )}

      {toast && (
        <div className="markup-toast" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <span>{toast.name ? t('markup_saved') : ''}{toast.note ? ` · ${toast.note}` : ''}</span>
          {toast.url && (
            <a className="markup-btn" href={toast.url} download={toast.name} target="_blank" rel="noopener noreferrer">⬇ {t('markup_download')}</a>
          )}
          <button type="button" className="markup-btn" onClick={() => { if (toast.url) URL.revokeObjectURL(toast.url); setToast(null) }}>✕</button>
        </div>
      )}

      {textDraft && (
        <input
          className="markup-text-input"
          autoFocus
          value={textDraft.value}
          style={{ left: textDraft.sx, top: textDraft.sy, color }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') commitText(); else if (e.key === 'Escape') setTextDraft(null) }}
          onBlur={commitText}
          placeholder={t('markup_text_placeholder')}
        />
      )}
    </>,
    portalTarget ?? document.body,
  )

  return (
    <>
      <canvas
        ref={canvasRef}
        className="markup-canvas"
        width={dims?.w ?? 0}
        height={dims?.h ?? 0}
        style={{ cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={onPointerCancel}
      />
      {toolbar}
    </>
  )
}
