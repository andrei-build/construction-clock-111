import { useMemo, useRef, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import {
  createProjectNote,
  getProjectFileDownloadUrl,
  getProjectHubFiles,
  uploadErrorCode,
  uploadProjectFileToR2,
} from '../../lib/api'
import { isManagerWrite } from '../../lib/types'
import type { Profile, Project, ProjectHubFile } from '../../lib/types'

interface SketchTabProps {
  project: Project
  profile: Profile | null
}

// Геометрия хранится в клетках сетки. Масштаб: 1 клетка = 1 фут.
const CELL_FT = 1
const CELL_PX = 32
const GRID_COLS = 24
const GRID_ROWS = 18
const VIEW_W = GRID_COLS * CELL_PX
const VIEW_H = GRID_ROWS * CELL_PX
const CLOSE_SNAP = 0.45 // клетки — попадание в стартовую точку замыкает контур
const SEG_HIT = 0.7 // клетки — попадание в сегмент при установке двери/окна
const ROOM_SNAP = 0.6 // клетки — радиус прилипания новой комнаты к существующим вершинам/стенам
const EDGE_FT_SNAP = 0.25 // фута — прилипание проёма к ровному футу при отпускании
const HISTORY_MAX = 60

// Дефолтные габариты проёмов в футах (законы Андрея 17.07).
const DOOR_W_FT = 3
const WIN_W_FT = 3
const WIN_H_FT = 4
const WIN_SILL_FT = 3

type Pt = { x: number; y: number }
type Contour = { points: Pt[]; closed: boolean }
// Габариты (w/h/sill) опциональны и аддитивны — старый JSON без них открывается с дефолтами.
type Opening = {
  kind: 'door' | 'window'
  c: number
  s: number
  t: number
  w?: number // ширина проёма в футах
  h?: number // высота окна в футах (только окно)
  sill?: number // высота окна от пола в футах (только окно)
}
type SketchModel = { version: 1; cellFt: number; contours: Contour[]; openings: Opening[] }

// Ширина проёма в футах с учётом дефолта по типу.
function openingWidthFt(o: Opening): number {
  return o.w ?? (o.kind === 'door' ? DOOR_W_FT : WIN_W_FT)
}

type Tool = 'wall' | 'door' | 'window'

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// Длина контура: сумма сегментов; для замкнутого добавляем ребро замыкания.
function contourPerimeter(c: Contour): number {
  let total = 0
  for (let i = 1; i < c.points.length; i++) total += dist(c.points[i - 1], c.points[i])
  if (c.closed && c.points.length >= 3) total += dist(c.points[c.points.length - 1], c.points[0])
  return total
}

// Площадь замкнутого контура по формуле шнурков (в клетках²).
function contourArea(c: Contour): number {
  if (!c.closed || c.points.length < 3) return 0
  let sum = 0
  const p = c.points
  for (let i = 0; i < p.length; i++) {
    const a = p[i]
    const b = p[(i + 1) % p.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

// Концы сегмента, на котором сидит проём.
function openingEnds(model: SketchModel, o: Opening): { a: Pt; b: Pt } | null {
  const c = model.contours[o.c]
  if (!c) return null
  const a = c.points[o.s]
  const b = o.s + 1 < c.points.length ? c.points[o.s + 1] : (c.closed ? c.points[0] : null)
  if (!a || !b) return null
  return { a, b }
}

// Мировая точка проёма на сегменте.
function openingPoint(model: SketchModel, o: Opening): Pt | null {
  const e = openingEnds(model, o)
  if (!e) return null
  return { x: e.a.x + (e.b.x - e.a.x) * o.t, y: e.a.y + (e.b.y - e.a.y) * o.t }
}

// Геометрия проёма: центр, единичный вектор вдоль стены, концы сегмента.
function openingGeom(model: SketchModel, o: Opening): { p: Pt; ux: number; uy: number; a: Pt; b: Pt } | null {
  const e = openingEnds(model, o)
  if (!e) return null
  const len = dist(e.a, e.b) || 1
  const ux = (e.b.x - e.a.x) / len
  const uy = (e.b.y - e.a.y) / len
  return { p: { x: e.a.x + (e.b.x - e.a.x) * o.t, y: e.a.y + (e.b.y - e.a.y) * o.t }, ux, uy, a: e.a, b: e.b }
}

// Проекция точки p на сегмент a→b, параметр t в [0,1].
function projectT(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return 0
  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
}

// Список сегментов (с индексами контура/сегмента и концами) для поиска ближайшего.
function eachSegment(model: SketchModel): { c: number; s: number; a: Pt; b: Pt }[] {
  const out: { c: number; s: number; a: Pt; b: Pt }[] = []
  model.contours.forEach((cont, c) => {
    for (let s = 0; s < cont.points.length - 1; s++) {
      out.push({ c, s, a: cont.points[s], b: cont.points[s + 1] })
    }
    if (cont.closed && cont.points.length >= 3) {
      out.push({ c, s: cont.points.length - 1, a: cont.points[cont.points.length - 1], b: cont.points[0] })
    }
  })
  return out
}

// Ближайший сегмент к точке p, с параметром t вдоль него.
function nearestSegment(model: SketchModel, p: Pt): { c: number; s: number; t: number; d: number } | null {
  let best: { c: number; s: number; t: number; d: number } | null = null
  for (const seg of eachSegment(model)) {
    const dx = seg.b.x - seg.a.x
    const dy = seg.b.y - seg.a.y
    const len2 = dx * dx + dy * dy
    if (len2 === 0) continue
    let t = ((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const proj = { x: seg.a.x + dx * t, y: seg.a.y + dy * t }
    const d = dist(p, proj)
    if (!best || d < best.d) best = { c: seg.c, s: seg.s, t, d }
  }
  return best
}

const EMPTY_MODEL: SketchModel = { version: 1, cellFt: CELL_FT, contours: [], openings: [] }

function fmtLen(cells: number): string {
  return `${(cells * CELL_FT).toFixed(1)}′`
}

function sanitizeName(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9а-я\-_]+/gi, '-').replace(/^-+|-+$/g, '')
  return clean || 'room'
}

// Отрисовка модели в canvas для PNG-превью (без внешних ресурсов — плоский canvas).
function renderPng(model: SketchModel, t: (k: string) => string): Promise<Blob | null> {
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = VIEW_W * scale
  canvas.height = VIEW_H * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  ctx.scale(scale, scale)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)
  // сетка
  ctx.strokeStyle = '#e2e6ea'
  ctx.lineWidth = 1
  for (let x = 0; x <= GRID_COLS; x++) {
    ctx.beginPath(); ctx.moveTo(x * CELL_PX, 0); ctx.lineTo(x * CELL_PX, VIEW_H); ctx.stroke()
  }
  for (let y = 0; y <= GRID_ROWS; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * CELL_PX); ctx.lineTo(VIEW_W, y * CELL_PX); ctx.stroke()
  }
  // стены
  ctx.strokeStyle = '#1f2933'
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const c of model.contours) {
    if (c.points.length < 2) continue
    ctx.beginPath()
    ctx.moveTo(c.points[0].x * CELL_PX, c.points[0].y * CELL_PX)
    for (let i = 1; i < c.points.length; i++) ctx.lineTo(c.points[i].x * CELL_PX, c.points[i].y * CELL_PX)
    if (c.closed) ctx.closePath()
    ctx.stroke()
  }
  // подписи длин
  ctx.fillStyle = '#334155'
  ctx.font = '11px sans-serif'
  ctx.textAlign = 'center'
  for (const seg of eachSegment(model)) {
    const mx = (seg.a.x + seg.b.x) / 2 * CELL_PX
    const my = (seg.a.y + seg.b.y) / 2 * CELL_PX
    ctx.fillText(fmtLen(dist(seg.a, seg.b)), mx, my - 4)
  }
  // проёмы — отрезок вдоль стены заданной ширины
  ctx.lineCap = 'butt'
  for (const o of model.openings) {
    const g = openingGeom(model, o)
    if (!g) continue
    const wCells = Math.min(openingWidthFt(o) / (model.cellFt || CELL_FT), dist(g.a, g.b))
    const hx = (g.ux * wCells) / 2
    const hy = (g.uy * wCells) / 2
    ctx.strokeStyle = o.kind === 'door' ? '#b45309' : '#2563eb'
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.moveTo((g.p.x - hx) * CELL_PX, (g.p.y - hy) * CELL_PX)
    ctx.lineTo((g.p.x + hx) * CELL_PX, (g.p.y + hy) * CELL_PX)
    ctx.stroke()
  }
  ctx.lineCap = 'round'
  // сводка
  const area = model.contours.reduce((s, c) => s + contourArea(c), 0)
  const perim = model.contours.reduce((s, c) => s + contourPerimeter(c), 0)
  ctx.fillStyle = '#0f172a'
  ctx.font = 'bold 13px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(
    `${t('hub_sketch_area')}: ${(area * CELL_FT * CELL_FT).toFixed(1)} ft²  ·  ${t('hub_sketch_perimeter')}: ${(perim * CELL_FT).toFixed(1)} ft`,
    8,
    VIEW_H - 10,
  )
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

export default function SketchTab({ project, profile }: SketchTabProps) {
  const { t } = useI18n()
  const canEdit = profile ? isManagerWrite(profile.role) : false

  const [model, setModel] = useState<SketchModel>(EMPTY_MODEL)
  const [history, setHistory] = useState<SketchModel[]>([])
  const [tool, setTool] = useState<Tool>('wall')
  const [hover, setHover] = useState<Pt | null>(null)
  const [hoverSnapped, setHoverSnapped] = useState(false)
  // Габариты проёмов (в футах), задаются перед вставкой.
  const [doorW, setDoorW] = useState(DOOR_W_FT)
  const [winW, setWinW] = useState(WIN_W_FT)
  const [winH, setWinH] = useState(WIN_H_FT)
  const [winSill, setWinSill] = useState(WIN_SILL_FT)
  // Перетаскивание проёма вдоль стены.
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const dragMovedRef = useRef(false)
  const [name, setName] = useState('room-1')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [saved, setSaved] = useState<ProjectHubFile[]>([])
  const [loadOpen, setLoadOpen] = useState(false)
  const [loadBusy, setLoadBusy] = useState(false)

  const svgRef = useRef<SVGSVGElement | null>(null)

  const stats = useMemo(() => {
    const perContour = model.contours.map((c) => ({
      area: contourArea(c) * CELL_FT * CELL_FT,
      perimeter: contourPerimeter(c) * CELL_FT,
      closed: c.closed,
    }))
    const totalArea = perContour.reduce((s, c) => s + c.area, 0)
    const totalPerimeter = perContour.reduce((s, c) => s + c.perimeter, 0)
    return { perContour, totalArea, totalPerimeter }
  }, [model])

  // Снимок в историю перед изменением; затем применяем мутатор.
  const commit = (next: SketchModel) => {
    setHistory((h) => [...h.slice(-HISTORY_MAX + 1), model])
    setModel(next)
    setStatus(null)
    setError(null)
  }

  // Координаты указателя → клетки сетки (без округления).
  const pointerCell = (e: React.PointerEvent | React.MouseEvent): Pt | null => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const x = (e.clientX - rect.left) / rect.width * GRID_COLS
    const y = (e.clientY - rect.top) / rect.height * GRID_ROWS
    return { x, y }
  }

  const snap = (p: Pt): Pt => ({
    x: Math.max(0, Math.min(GRID_COLS, Math.round(p.x))),
    y: Math.max(0, Math.min(GRID_ROWS, Math.round(p.y))),
  })

  // Прилипание новой точки к вершинам/стенам ДРУГИХ контуров (общая стена не дублируется).
  // Возвращает координату существующей геометрии, если она в радиусе ROOM_SNAP, иначе null.
  const snapToExisting = (p: Pt): Pt | null => {
    const activeIdx = model.contours.length - 1
    const active = model.contours[activeIdx]
    const drawingNew = !!active && !active.closed
    let best: Pt | null = null
    let bestD = ROOM_SNAP
    // сначала вершины
    model.contours.forEach((c, ci) => {
      if (drawingNew && ci === activeIdx) return
      c.points.forEach((v) => {
        const d = dist(p, v)
        if (d <= bestD) {
          bestD = d
          best = { x: v.x, y: v.y }
        }
      })
    })
    if (best) return best
    // затем проекция на существующие стены
    let bestSegD = ROOM_SNAP
    eachSegment(model).forEach((seg) => {
      if (drawingNew && seg.c === activeIdx) return
      const t = projectT(p, seg.a, seg.b)
      const proj = { x: seg.a.x + (seg.b.x - seg.a.x) * t, y: seg.a.y + (seg.b.y - seg.a.y) * t }
      const d = dist(p, proj)
      if (d <= bestSegD) {
        bestSegD = d
        best = proj
      }
    })
    return best
  }

  // Точка для установки угла стены: прилипание к чужой геометрии имеет приоритет над сеткой.
  const wallPoint = (raw: Pt): { p: Pt; snapped: boolean } => {
    const s = snapToExisting(raw)
    return s ? { p: s, snapped: true } : { p: snap(raw), snapped: false }
  }

  const handleMove = (e: React.PointerEvent) => {
    if (!canEdit) return
    const raw = pointerCell(e)
    if (dragIdx !== null) {
      if (!raw) return
      dragMovedRef.current = true
      setModel((m) => {
        const o = m.openings[dragIdx]
        if (!o) return m
        const ends = openingEnds(m, o)
        if (!ends) return m
        const t = projectT(raw, ends.a, ends.b)
        return { ...m, openings: m.openings.map((op, i) => (i === dragIdx ? { ...op, t } : op)) }
      })
      return
    }
    if (!raw) {
      setHover(null)
      setHoverSnapped(false)
      return
    }
    if (tool === 'wall') {
      const wp = wallPoint(raw)
      setHover(wp.p)
      setHoverSnapped(wp.snapped)
    } else {
      setHover(raw)
      setHoverSnapped(false)
    }
  }

  // Начало перетаскивания существующего проёма.
  const startDragOpening = (i: number) => (e: React.PointerEvent) => {
    if (!canEdit) return
    e.stopPropagation()
    setHistory((h) => [...h.slice(-HISTORY_MAX + 1), model])
    setStatus(null)
    setError(null)
    // любое взаимодействие с проёмом подавляет следующий click (иначе поставили бы новую точку/проём)
    dragMovedRef.current = true
    setDragIdx(i)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  // Отпускание проёма: лёгкое прилипание к ровному футу вдоль стены.
  const endDragOpening = () => {
    if (dragIdx === null) return
    setModel((m) => {
      const o = m.openings[dragIdx]
      if (!o) return m
      const ends = openingEnds(m, o)
      if (!ends) return m
      const segLen = dist(ends.a, ends.b)
      const cellFt = m.cellFt || CELL_FT
      const distFt = o.t * segLen * cellFt
      const rounded = Math.round(distFt)
      let t = o.t
      if (segLen > 0 && Math.abs(distFt - rounded) <= EDGE_FT_SNAP) {
        t = Math.max(0, Math.min(1, rounded / (segLen * cellFt)))
      }
      return { ...m, openings: m.openings.map((op, i) => (i === dragIdx ? { ...op, t } : op)) }
    })
    setDragIdx(null)
  }

  const handleClick = (e: React.MouseEvent) => {
    if (!canEdit) return
    // клик после перетаскивания проёма не должен ставить новый
    if (dragMovedRef.current) {
      dragMovedRef.current = false
      return
    }
    const raw = pointerCell(e)
    if (!raw) return

    if (tool === 'wall') {
      const p = wallPoint(raw).p
      const contours = model.contours
      const last = contours[contours.length - 1]
      // Замыкание: клик рядом со стартовой точкой активного контура (≥3 точек).
      if (last && !last.closed && last.points.length >= 3 && dist(p, last.points[0]) <= CLOSE_SNAP) {
        const next = { ...model, contours: contours.map((c, i) => (i === contours.length - 1 ? { ...c, closed: true } : c)) }
        commit(next)
        return
      }
      if (last && !last.closed && last.points.length > 0) {
        // не дублируем точку, совпадающую с предыдущей
        const prev = last.points[last.points.length - 1]
        if (dist(p, prev) < 0.01) return
        const next = { ...model, contours: contours.map((c, i) => (i === contours.length - 1 ? { ...c, points: [...c.points, p] } : c)) }
        commit(next)
      } else {
        commit({ ...model, contours: [...contours, { points: [p], closed: false }] })
      }
      return
    }

    // door / window: ставим на ближайший сегмент в пределах порога
    const near = nearestSegment(model, raw)
    if (!near || near.d > SEG_HIT) {
      setError('hub_sketch_no_segment')
      return
    }
    const opening: Opening =
      tool === 'door'
        ? { kind: 'door', c: near.c, s: near.s, t: near.t, w: Math.max(0.5, doorW) }
        : { kind: 'window', c: near.c, s: near.s, t: near.t, w: Math.max(0.5, winW), h: Math.max(0.5, winH), sill: Math.max(0, winSill) }
    commit({ ...model, openings: [...model.openings, opening] })
  }

  const finishShape = () => {
    const contours = model.contours
    const last = contours[contours.length - 1]
    if (!last || last.closed || last.points.length < 3) return
    commit({ ...model, contours: contours.map((c, i) => (i === contours.length - 1 ? { ...c, closed: true } : c)) })
  }

  const undo = () => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    setModel(prev)
    setStatus(null)
    setError(null)
  }

  const clearAll = () => {
    if (model.contours.length === 0 && model.openings.length === 0) return
    setHistory((h) => [...h.slice(-HISTORY_MAX + 1), model])
    setModel(EMPTY_MODEL)
    setStatus(null)
    setError(null)
  }

  const save = async () => {
    if (!profile || busy) return
    if (model.contours.every((c) => c.points.length < 2)) {
      setError('hub_sketch_empty')
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const base = `sketch-${sanitizeName(name)}`
      // JSON без явного type — validateUpload пропускает файлы с пустым MIME.
      const jsonFile = new File([JSON.stringify(model)], `${base}.json`)
      const png = await renderPng(model, t)
      await uploadProjectFileToR2(profile, project.id, jsonFile)
      if (png) {
        const pngFile = new File([png], `${base}.png`, { type: 'image/png' })
        await uploadProjectFileToR2(profile, project.id, pngFile)
      }
      setStatus('hub_sketch_saved')
    } catch (err) {
      setError(uploadErrorCode(err) ?? 'hub_sketch_save_failed')
    } finally {
      setBusy(false)
    }
  }

  const calcMaterial = async () => {
    if (!profile || busy) return
    if (stats.perContour.length === 0) {
      setError('hub_sketch_empty')
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const lines: string[] = [`${t('hub_sketch_material_title')} — ${name.trim() || 'room'}`, '']
      stats.perContour.forEach((c, i) => {
        lines.push(
          `${t('hub_sketch_contour')} ${i + 1}: ${t('hub_sketch_area')} ${c.area.toFixed(1)} ft² · ${t('hub_sketch_perimeter')} ${c.perimeter.toFixed(1)} ft${c.closed ? '' : ` (${t('hub_sketch_open')})`}`,
        )
      })
      lines.push('')
      lines.push(`${t('hub_sketch_total')}: ${t('hub_sketch_area')} ${stats.totalArea.toFixed(1)} ft² · ${t('hub_sketch_perimeter')} ${stats.totalPerimeter.toFixed(1)} ft`)
      await createProjectNote(profile, project.id, lines.join('\n'))
      setStatus('hub_sketch_material_saved')
    } catch {
      setError('hub_sketch_material_failed')
    } finally {
      setBusy(false)
    }
  }

  const openLoader = async () => {
    setLoadOpen((v) => !v)
    if (loadOpen) return
    setLoadBusy(true)
    try {
      const rows = await getProjectHubFiles(project.id)
      setSaved(rows.filter((r) => r.name.startsWith('sketch-') && r.name.endsWith('.json')))
    } catch {
      setSaved([])
    } finally {
      setLoadBusy(false)
    }
  }

  const importSketch = async (file: ProjectHubFile) => {
    setLoadBusy(true)
    setError(null)
    try {
      const url = await getProjectFileDownloadUrl(file)
      const res = await fetch(url)
      const data = (await res.json()) as SketchModel
      if (!data || !Array.isArray(data.contours)) throw new Error('bad')
      setHistory((h) => [...h.slice(-HISTORY_MAX + 1), model])
      setModel({ version: 1, cellFt: data.cellFt ?? CELL_FT, contours: data.contours, openings: Array.isArray(data.openings) ? data.openings : [] })
      setName(file.name.replace(/^sketch-/, '').replace(/\.json$/, ''))
      setLoadOpen(false)
      setStatus('hub_sketch_loaded')
    } catch {
      setError('hub_sketch_load_failed')
    } finally {
      setLoadBusy(false)
    }
  }

  const activeContour = model.contours[model.contours.length - 1]
  const canClose = !!activeContour && !activeContour.closed && activeContour.points.length >= 3

  return (
    <section className="hub-tab-panel hub-sketch">
      {canEdit && (
        <div className="card hub-sketch-toolbar">
          <div className="hub-sketch-tools">
            {(['wall', 'door', 'window'] as Tool[]).map((tl) => (
              <button
                key={tl}
                type="button"
                className={tool === tl ? 'btn small' : 'btn ghost small'}
                onClick={() => setTool(tl)}
              >
                {t(`hub_sketch_tool_${tl}`)}
              </button>
            ))}
          </div>
          <div className="hub-sketch-actions">
            <button type="button" className="btn ghost small" disabled={!canClose} onClick={finishShape}>
              {t('hub_sketch_finish')}
            </button>
            <button type="button" className="btn ghost small" disabled={history.length === 0} onClick={undo}>
              {t('hub_sketch_undo')}
            </button>
            <button type="button" className="btn ghost small" onClick={clearAll}>
              {t('hub_sketch_clear')}
            </button>
          </div>
          {tool === 'door' && (
            <div className="hub-sketch-dims">
              <label className="hub-sketch-dim-field">
                <span className="muted">{t('hub_sketch_width')}</span>
                <input type="number" min="0.5" step="0.5" value={doorW} onChange={(e) => setDoorW(Number(e.target.value) || 0)} />
                <span className="muted">ft</span>
              </label>
            </div>
          )}
          {tool === 'window' && (
            <div className="hub-sketch-dims">
              <label className="hub-sketch-dim-field">
                <span className="muted">{t('hub_sketch_width')}</span>
                <input type="number" min="0.5" step="0.5" value={winW} onChange={(e) => setWinW(Number(e.target.value) || 0)} />
                <span className="muted">ft</span>
              </label>
              <label className="hub-sketch-dim-field">
                <span className="muted">{t('hub_sketch_height')}</span>
                <input type="number" min="0.5" step="0.5" value={winH} onChange={(e) => setWinH(Number(e.target.value) || 0)} />
                <span className="muted">ft</span>
              </label>
              <label className="hub-sketch-dim-field">
                <span className="muted">{t('hub_sketch_sill')}</span>
                <input type="number" min="0" step="0.5" value={winSill} onChange={(e) => setWinSill(Number(e.target.value) || 0)} />
                <span className="muted">ft</span>
              </label>
            </div>
          )}
        </div>
      )}

      <div className="card hub-sketch-canvas-card">
        <svg
          ref={svgRef}
          className="hub-sketch-svg"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="img"
          aria-label={t('hub_tab_sketch')}
          onClick={handleClick}
          onPointerMove={handleMove}
          onPointerUp={endDragOpening}
          onPointerLeave={() => {
            endDragOpening()
            setHover(null)
            setHoverSnapped(false)
          }}
          style={{ touchAction: 'none' }}
        >
          {/* сетка */}
          <g className="hub-sketch-grid">
            {Array.from({ length: GRID_COLS + 1 }, (_, i) => (
              <line key={`v${i}`} x1={i * CELL_PX} y1={0} x2={i * CELL_PX} y2={VIEW_H} />
            ))}
            {Array.from({ length: GRID_ROWS + 1 }, (_, i) => (
              <line key={`h${i}`} x1={0} y1={i * CELL_PX} x2={VIEW_W} y2={i * CELL_PX} />
            ))}
          </g>

          {/* контуры */}
          {model.contours.map((c, ci) => {
            if (c.points.length === 0) return null
            const pts = c.points.map((p) => `${p.x * CELL_PX},${p.y * CELL_PX}`).join(' ')
            return c.closed && c.points.length >= 3 ? (
              <polygon key={`c${ci}`} className="hub-sketch-wall" points={pts} />
            ) : (
              <polyline key={`c${ci}`} className="hub-sketch-wall" points={pts} fill="none" />
            )
          })}

          {/* подписи длин */}
          {eachSegment(model).map((seg, i) => {
            const mx = (seg.a.x + seg.b.x) / 2 * CELL_PX
            const my = (seg.a.y + seg.b.y) / 2 * CELL_PX
            return (
              <text key={`l${i}`} className="hub-sketch-dim" x={mx} y={my - 5} textAnchor="middle">
                {fmtLen(dist(seg.a, seg.b))}
              </text>
            )
          })}

          {/* точки контуров (крупные хит-таргеты) */}
          {model.contours.map((c, ci) =>
            c.points.map((p, pi) => (
              <circle key={`n${ci}-${pi}`} className="hub-sketch-node" cx={p.x * CELL_PX} cy={p.y * CELL_PX} r={5} />
            )),
          )}

          {/* проёмы — отрезок вдоль стены заданной ширины, можно перетаскивать */}
          {model.openings.map((o, i) => {
            const g = openingGeom(model, o)
            if (!g) return null
            const wCells = Math.min(openingWidthFt(o) / (model.cellFt || CELL_FT), dist(g.a, g.b))
            const hx = (g.ux * wCells) / 2
            const hy = (g.uy * wCells) / 2
            const x1 = (g.p.x - hx) * CELL_PX
            const y1 = (g.p.y - hy) * CELL_PX
            const x2 = (g.p.x + hx) * CELL_PX
            const y2 = (g.p.y + hy) * CELL_PX
            const cls = o.kind === 'door' ? 'hub-sketch-door' : 'hub-sketch-window'
            return (
              <g
                key={`o${i}`}
                className={canEdit ? 'hub-sketch-opening' : undefined}
                onPointerDown={canEdit ? startDragOpening(i) : undefined}
              >
                <line className={cls} x1={x1} y1={y1} x2={x2} y2={y2} />
                {/* невидимый широкий хит-таргет для захвата пальцем */}
                <line className="hub-sketch-opening-hit" x1={x1} y1={y1} x2={x2} y2={y2} />
              </g>
            )
          })}

          {/* превью стены: живая длина текущего сегмента при рисовании */}
          {canEdit &&
            hover &&
            tool === 'wall' &&
            activeContour &&
            !activeContour.closed &&
            activeContour.points.length > 0 &&
            (() => {
              const last = activeContour.points[activeContour.points.length - 1]
              const mx = ((last.x + hover.x) / 2) * CELL_PX
              const my = ((last.y + hover.y) / 2) * CELL_PX
              return (
                <g>
                  <line
                    className="hub-sketch-preview"
                    x1={last.x * CELL_PX}
                    y1={last.y * CELL_PX}
                    x2={hover.x * CELL_PX}
                    y2={hover.y * CELL_PX}
                  />
                  <text className="hub-sketch-live-dim" x={mx} y={my - 6} textAnchor="middle">
                    {fmtLen(dist(last, hover))}
                  </text>
                </g>
              )
            })()}

          {/* подсказка при перетаскивании проёма: расстояния до краёв стены (+ высота от пола для окна) */}
          {dragIdx !== null &&
            (() => {
              const o = model.openings[dragIdx]
              if (!o) return null
              const g = openingGeom(model, o)
              if (!g) return null
              const segLen = dist(g.a, g.b)
              const cellFt = model.cellFt || CELL_FT
              const left = o.t * segLen * cellFt
              const right = (1 - o.t) * segLen * cellFt
              const px = g.p.x * CELL_PX
              const py = g.p.y * CELL_PX
              const sillTxt = o.kind === 'window' ? ` · ${t('hub_sketch_sill')} ${(o.sill ?? WIN_SILL_FT).toFixed(1)}′` : ''
              return (
                <text className="hub-sketch-drag-dim" x={px} y={py - 12} textAnchor="middle">
                  {`◄ ${left.toFixed(1)}′  ·  ${right.toFixed(1)}′ ►${sillTxt}`}
                </text>
              )
            })()}

          {/* превью курсора */}
          {canEdit && hover && tool === 'wall' && (
            <circle
              className={hoverSnapped ? 'hub-sketch-hover hub-sketch-hover-snap' : 'hub-sketch-hover'}
              cx={hover.x * CELL_PX}
              cy={hover.y * CELL_PX}
              r={6}
            />
          )}
        </svg>
        <p className="muted hub-sketch-scale">{t('hub_sketch_scale_note')}</p>
      </div>

      {/* сводка */}
      <div className="card hub-sketch-stats">
        <div className="hub-sketch-stat">
          <span className="muted">{t('hub_sketch_area')}</span>
          <span className="hub-sketch-stat-value">{stats.totalArea.toFixed(1)} ft²</span>
        </div>
        <div className="hub-sketch-stat">
          <span className="muted">{t('hub_sketch_perimeter')}</span>
          <span className="hub-sketch-stat-value">{stats.totalPerimeter.toFixed(1)} ft</span>
        </div>
        <div className="hub-sketch-stat">
          <span className="muted">{t('hub_sketch_contours')}</span>
          <span className="hub-sketch-stat-value">{model.contours.filter((c) => c.points.length >= 2).length}</span>
        </div>
      </div>

      {status && <p className="hub-sketch-ok">{t(status)}</p>}
      {error && <p className="error-msg">{t(error)}</p>}

      {canEdit && (
        <div className="card hub-sketch-save">
          <label className="muted hub-sketch-name-label">{t('hub_sketch_name')}</label>
          <input
            className="hub-sketch-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="room-1"
            disabled={busy}
          />
          <div className="hub-sketch-save-actions">
            <button type="button" className="btn small" disabled={busy} onClick={save}>
              {busy ? t('saving') : t('hub_sketch_save')}
            </button>
            <button type="button" className="btn ghost small" disabled={busy} onClick={calcMaterial}>
              {t('hub_sketch_material')}
            </button>
            <button type="button" className="btn ghost small" disabled={loadBusy} onClick={openLoader}>
              {t('hub_sketch_load')}
            </button>
          </div>

          {loadOpen && (
            <div className="hub-sketch-load-list">
              {loadBusy && <p className="muted">{t('loading')}</p>}
              {!loadBusy && saved.length === 0 && <p className="muted">{t('hub_sketch_load_empty')}</p>}
              {!loadBusy &&
                saved.map((f) => (
                  <button key={f.id} type="button" className="btn ghost small hub-sketch-load-item" onClick={() => importSketch(f)}>
                    {f.name.replace(/^sketch-/, '').replace(/\.json$/, '')}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
