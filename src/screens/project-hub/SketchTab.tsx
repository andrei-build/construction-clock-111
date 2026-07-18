import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import Sketch3DView from './Sketch3DView'
import {
  sanitizeSketchFinishes,
  sanitizeSketchLights,
  sanitizeSketchSwitches,
  type SketchFinishes,
  type SketchLight,
  type SketchSwitch,
} from './sketchFinishes'

interface SketchTabProps {
  project: Project
  profile: Profile | null
}

// Геометрия хранится в клетках сетки. Масштаб: 1 клетка = 1 фут.
const CELL_FT = 1
const CELL_PX = 32
const SUBCELL_PX = CELL_PX / 2
const DEFAULT_GRID_COLS = 24
const DEFAULT_GRID_ROWS = 18
const VIEW_W = DEFAULT_GRID_COLS * CELL_PX
const VIEW_H = DEFAULT_GRID_ROWS * CELL_PX
const MIN_VIEW_CELLS = 4
const SUBGRID_HIDE_PX_PER_FT = 18
const CLOSE_SNAP = 0.45 // клетки — попадание в стартовую точку замыкает контур
const SEG_HIT = 0.7 // клетки — попадание в сегмент при установке двери/окна
const ROOM_SNAP = 0.6 // клетки — радиус прилипания новой комнаты к существующим вершинам/стенам
const EDGE_FT_SNAP = 0.25 // фута — прилипание проёма к ровному футу при отпускании
const HISTORY_MAX = 60
const DEFAULT_WALL_HEIGHT_FT = 8

// Дефолтные габариты проёмов в футах (законы Андрея 17.07).
const DOOR_W_FT = 3
const DOOR_H_FT = 6.8
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
type SketchModel = {
  version: 1
  cellFt: number
  height?: number
  contours: Contour[]
  openings: Opening[]
  finishes?: SketchFinishes
  lights?: SketchLight[]
  switches?: SketchSwitch[]
}
type ViewMode = '2d' | '3d'
type CanvasSize = { width: number; height: number }
type CanvasView = { x: number; y: number; width: number; height: number }

// Ширина проёма в футах с учётом дефолта по типу.
function openingWidthFt(o: Opening): number {
  return o.w ?? (o.kind === 'door' ? DOOR_W_FT : WIN_W_FT)
}

function openingHeightFt(o: Opening): number {
  return o.kind === 'door' ? DOOR_H_FT : (o.h ?? WIN_H_FT)
}

function openingFloorFt(o: Opening): number {
  return o.kind === 'door' ? 0 : (o.sill ?? WIN_SILL_FT)
}

function modelCellFt(model: SketchModel): number {
  return Number.isFinite(model.cellFt) && model.cellFt > 0 ? model.cellFt : CELL_FT
}

function wallHeightFt(model: SketchModel): number {
  return Number.isFinite(model.height) && (model.height ?? 0) > 0 ? model.height ?? DEFAULT_WALL_HEIGHT_FT : DEFAULT_WALL_HEIGHT_FT
}

function importWallHeight(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
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

function sketchBounds(model: SketchModel): { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number; hasPoints: boolean } {
  const points = model.contours.flatMap((contour) => contour.points)
  if (points.length === 0) {
    return {
      minX: 0,
      maxX: DEFAULT_GRID_COLS,
      minY: 0,
      maxY: DEFAULT_GRID_ROWS,
      width: DEFAULT_GRID_COLS,
      height: DEFAULT_GRID_ROWS,
      hasPoints: false,
    }
  }
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(maxX - minX, 0),
    height: Math.max(maxY - minY, 0),
    hasPoints: true,
  }
}

function canvasAspect(size: CanvasSize): number {
  return size.width > 0 && size.height > 0 ? size.width / size.height : VIEW_W / VIEW_H
}

function constrainCanvasView(model: SketchModel, size: CanvasSize, view: CanvasView): CanvasView {
  const aspect = canvasAspect(size)
  const bounds = sketchBounds(model)
  const maxModelCells = Math.max(DEFAULT_GRID_COLS, DEFAULT_GRID_ROWS, bounds.width + 16, bounds.height + 16)
  const minWidth = MIN_VIEW_CELLS * CELL_PX
  const maxWidth = maxModelCells * CELL_PX * 4
  const width = Math.max(minWidth, Math.min(maxWidth, Number.isFinite(view.width) ? view.width : VIEW_W))
  const height = width / aspect
  const cx = Number.isFinite(view.x) ? view.x + view.width / 2 : VIEW_W / 2
  const cy = Number.isFinite(view.y) ? view.y + view.height / 2 : VIEW_H / 2
  return {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
  }
}

function fitCanvasView(model: SketchModel, size: CanvasSize): CanvasView {
  const bounds = sketchBounds(model)
  const aspect = canvasAspect(size)
  const span = Math.max(bounds.width, bounds.height)
  const padCells = bounds.hasPoints ? Math.max(2, Math.min(8, span * 0.08)) : 0
  const minX = bounds.hasPoints ? bounds.minX - padCells : 0
  const maxX = bounds.hasPoints ? bounds.maxX + padCells : DEFAULT_GRID_COLS
  const minY = bounds.hasPoints ? bounds.minY - padCells : 0
  const maxY = bounds.hasPoints ? bounds.maxY + padCells : DEFAULT_GRID_ROWS
  const boxWidth = Math.max((maxX - minX) * CELL_PX, MIN_VIEW_CELLS * CELL_PX)
  const boxHeight = Math.max((maxY - minY) * CELL_PX, MIN_VIEW_CELLS * CELL_PX)
  const boxAspect = boxWidth / boxHeight
  const width = boxAspect > aspect ? boxWidth : boxHeight * aspect
  const height = width / aspect
  const cx = ((minX + maxX) / 2) * CELL_PX
  const cy = ((minY + maxY) / 2) * CELL_PX
  return constrainCanvasView(model, size, {
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
  })
}

function canvasViewContainsModel(model: SketchModel, view: CanvasView): boolean {
  const bounds = sketchBounds(model)
  if (!bounds.hasPoints) return true
  const left = view.x / CELL_PX
  const right = (view.x + view.width) / CELL_PX
  const top = view.y / CELL_PX
  const bottom = (view.y + view.height) / CELL_PX
  return bounds.minX >= left && bounds.maxX <= right && bounds.minY >= top && bounds.maxY <= bottom
}

function gridLinePositions(startPx: number, endPx: number, stepPx: number, skipEveryOther = false): number[] {
  const start = Math.floor(startPx / stepPx) - 1
  const end = Math.ceil(endPx / stepPx) + 1
  const count = Math.min(900, Math.max(0, end - start + 1))
  return Array.from({ length: count }, (_, i) => start + i)
    .filter((n) => !skipEveryOther || n % 2 !== 0)
    .map((n) => n * stepPx)
}

function canvasGridLines(view: CanvasView, includeSubgrid: boolean) {
  const left = view.x
  const right = view.x + view.width
  const top = view.y
  const bottom = view.y + view.height
  return {
    subX: includeSubgrid ? gridLinePositions(left, right, SUBCELL_PX, true) : [],
    subY: includeSubgrid ? gridLinePositions(top, bottom, SUBCELL_PX, true) : [],
    majorX: gridLinePositions(left, right, CELL_PX),
    majorY: gridLinePositions(top, bottom, CELL_PX),
  }
}

const EMPTY_MODEL: SketchModel = { version: 1, cellFt: CELL_FT, contours: [], openings: [] }

function fmtFt(valueFt: number): string {
  const safe = Number.isFinite(valueFt) ? valueFt : 0
  return `${safe.toFixed(1)}′`
}

function fmtLen(cells: number): string {
  return fmtFt(cells * CELL_FT)
}

type OpeningDimLabel = {
  x: number
  y: number
  lines: string[]
  kind: Opening['kind']
}

function openingDimLabel(model: SketchModel, opening: Opening, index: number, t: (k: string) => string): OpeningDimLabel | null {
  const g = openingGeom(model, opening)
  if (!g) return null
  const segLenCells = dist(g.a, g.b)
  if (segLenCells <= 0.01) return null
  const cellFt = modelCellFt(model)
  const widthFt = openingWidthFt(opening)
  const widthCells = Math.min(widthFt / cellFt, segLenCells)
  const centerCells = Math.max(0, Math.min(segLenCells, opening.t * segLenCells))
  const leftFt = Math.max(0, (centerCells - widthCells / 2) * cellFt)
  const rightFt = Math.max(0, (segLenCells - centerCells - widthCells / 2) * cellFt)
  const side = (opening.c + opening.s + index) % 2 === 0 ? 1 : -1
  const offsetPx = 22 + (index % 2) * 14
  return {
    x: g.p.x * CELL_PX + (-g.uy) * side * offsetPx,
    y: g.p.y * CELL_PX + g.ux * side * offsetPx,
    kind: opening.kind,
    lines: [
      `${t('hub_sketch_dim_size_short')} ${fmtFt(widthFt)}×${fmtFt(openingHeightFt(opening))}`,
      `${t('hub_sketch_dim_floor_short')} ${fmtFt(openingFloorFt(opening))}`,
      `${t('hub_sketch_dim_left_short')} ${fmtFt(leftFt)} · ${t('hub_sketch_dim_right_short')} ${fmtFt(rightFt)}`,
    ],
  }
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
  const view = fitCanvasView(model, { width: VIEW_W, height: VIEW_H })
  const viewScale = VIEW_W / view.width
  const grid = canvasGridLines(view, viewScale * CELL_PX >= SUBGRID_HIDE_PX_PER_FT)
  ctx.save()
  ctx.scale(viewScale, viewScale)
  ctx.translate(-view.x, -view.y)
  // сетка
  ctx.strokeStyle = '#edf1f5'
  ctx.lineWidth = 1 / viewScale
  for (const x of grid.subX) {
    ctx.beginPath(); ctx.moveTo(x, view.y); ctx.lineTo(x, view.y + view.height); ctx.stroke()
  }
  for (const y of grid.subY) {
    ctx.beginPath(); ctx.moveTo(view.x, y); ctx.lineTo(view.x + view.width, y); ctx.stroke()
  }
  ctx.strokeStyle = '#d7dee8'
  for (const x of grid.majorX) {
    ctx.beginPath(); ctx.moveTo(x, view.y); ctx.lineTo(x, view.y + view.height); ctx.stroke()
  }
  for (const y of grid.majorY) {
    ctx.beginPath(); ctx.moveTo(view.x, y); ctx.lineTo(view.x + view.width, y); ctx.stroke()
  }
  // стены
  ctx.strokeStyle = '#1f2933'
  ctx.lineWidth = 3 / viewScale
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
  ctx.font = `${Math.max(10 / viewScale, 11)}px sans-serif`
  ctx.textAlign = 'center'
  for (const seg of eachSegment(model)) {
    const mx = (seg.a.x + seg.b.x) / 2 * CELL_PX
    const my = (seg.a.y + seg.b.y) / 2 * CELL_PX
    ctx.fillText(fmtLen(dist(seg.a, seg.b)), mx, my - 4 / viewScale)
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
    ctx.lineWidth = 6 / viewScale
    ctx.beginPath()
    ctx.moveTo((g.p.x - hx) * CELL_PX, (g.p.y - hy) * CELL_PX)
    ctx.lineTo((g.p.x + hx) * CELL_PX, (g.p.y + hy) * CELL_PX)
    ctx.stroke()
  }
  // постоянные габариты проёмов и отступы до краёв стены
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 ${Math.max(9 / viewScale, 10)}px sans-serif`
  ctx.lineWidth = Math.max(2.5 / viewScale, 3)
  model.openings.forEach((opening, index) => {
    const label = openingDimLabel(model, opening, index, t)
    if (!label) return
    const lineHeight = Math.max(11 / viewScale, 12)
    ctx.fillStyle = label.kind === 'door' ? '#7c2d12' : '#1d4ed8'
    ctx.strokeStyle = 'rgba(255, 255, 255, .92)'
    label.lines.forEach((line, lineIndex) => {
      const y = label.y + (lineIndex - 1) * lineHeight
      ctx.strokeText(line, label.x, y)
      ctx.fillText(line, label.x, y)
    })
  })
  ctx.restore()
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
  const [viewMode, setViewMode] = useState<ViewMode>('2d')
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
  const canvasAutoFitRef = useRef(true)
  const canvasSuppressClickRef = useRef(false)
  const canvasPointersRef = useRef<Map<number, { clientX: number; clientY: number }>>(new Map())
  const canvasPanRef = useRef<{ startX: number; startY: number; view: CanvasView; moved: boolean } | null>(null)
  const canvasPinchRef = useRef<{ startDistance: number; startMid: { x: number; y: number }; view: CanvasView } | null>(null)
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: VIEW_W, height: VIEW_H })
  const [canvasView, setCanvasView] = useState<CanvasView>({ x: 0, y: 0, width: VIEW_W, height: VIEW_H })

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

  useEffect(() => {
    if (viewMode !== '2d') return
    const svg = svgRef.current
    if (!svg) return
    const updateSize = () => {
      const rect = svg.getBoundingClientRect()
      setCanvasSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(svg)
    return () => observer.disconnect()
  }, [viewMode])

  useEffect(() => {
    if (viewMode !== '2d') return
    setCanvasView((current) => {
      const normalized = constrainCanvasView(model, canvasSize, current)
      if (canvasAutoFitRef.current || !canvasViewContainsModel(model, normalized)) {
        canvasAutoFitRef.current = false
        return fitCanvasView(model, canvasSize)
      }
      return normalized
    })
  }, [model, canvasSize, viewMode])

  const fitCanvasToModel = useCallback(() => {
    canvasAutoFitRef.current = false
    setCanvasView(fitCanvasView(model, canvasSize))
  }, [model, canvasSize])

  const canvasPoint = (clientX: number, clientY: number, view = canvasView): { x: number; y: number } | null => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: view.x + ((clientX - rect.left) / rect.width) * view.width,
      y: view.y + ((clientY - rect.top) / rect.height) * view.height,
    }
  }

  const zoomCanvasAt = (clientX: number, clientY: number, factor: number, baseView = canvasView) => {
    const anchor = canvasPoint(clientX, clientY, baseView)
    const svg = svgRef.current
    if (!anchor || !svg) return baseView
    const rect = svg.getBoundingClientRect()
    const nextWidth = baseView.width * factor
    const nextHeight = baseView.height * factor
    const ratioX = (clientX - rect.left) / Math.max(1, rect.width)
    const ratioY = (clientY - rect.top) / Math.max(1, rect.height)
    return constrainCanvasView(model, canvasSize, {
      x: anchor.x - ratioX * nextWidth,
      y: anchor.y - ratioY * nextHeight,
      width: nextWidth,
      height: nextHeight,
    })
  }

  // Координаты указателя → клетки сетки (без округления).
  const pointerCell = (e: React.PointerEvent | React.MouseEvent): Pt | null => {
    const point = canvasPoint(e.clientX, e.clientY)
    return point ? { x: point.x / CELL_PX, y: point.y / CELL_PX } : null
  }

  const snap = (p: Pt): Pt => ({
    x: Math.max(0, Math.round(p.x)),
    y: Math.max(0, Math.round(p.y)),
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

  const handleCanvasPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    canvasPointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY })
    e.currentTarget.setPointerCapture?.(e.pointerId)
    if (canvasPointersRef.current.size === 1) {
      canvasPanRef.current = { startX: e.clientX, startY: e.clientY, view: canvasView, moved: false }
      canvasPinchRef.current = null
      return
    }
    if (canvasPointersRef.current.size === 2) {
      const points = Array.from(canvasPointersRef.current.values())
      const [a, b] = points
      canvasPanRef.current = null
      canvasPinchRef.current = {
        startDistance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
        startMid: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
        view: canvasView,
      }
      canvasSuppressClickRef.current = true
    }
  }

  const handleCanvasPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (canvasPointersRef.current.has(e.pointerId)) {
      canvasPointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY })
    }

    if (canvasPointersRef.current.size >= 2 && canvasPinchRef.current) {
      const points = Array.from(canvasPointersRef.current.values())
      const [a, b] = points
      const currentDistance = Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY))
      const currentMid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
      const factor = canvasPinchRef.current.startDistance / currentDistance
      const anchor = canvasPoint(canvasPinchRef.current.startMid.x, canvasPinchRef.current.startMid.y, canvasPinchRef.current.view)
      const svg = svgRef.current
      if (anchor && svg) {
        const rect = svg.getBoundingClientRect()
        const nextWidth = canvasPinchRef.current.view.width * factor
        const nextHeight = canvasPinchRef.current.view.height * factor
        const ratioX = (currentMid.x - rect.left) / Math.max(1, rect.width)
        const ratioY = (currentMid.y - rect.top) / Math.max(1, rect.height)
        canvasAutoFitRef.current = false
        setCanvasView(constrainCanvasView(model, canvasSize, {
          x: anchor.x - ratioX * nextWidth,
          y: anchor.y - ratioY * nextHeight,
          width: nextWidth,
          height: nextHeight,
        }))
        setHover(null)
        setHoverSnapped(false)
      }
      e.preventDefault()
      return
    }

    const pan = canvasPanRef.current
    if (pan) {
      const dx = e.clientX - pan.startX
      const dy = e.clientY - pan.startY
      const moved = Math.hypot(dx, dy) > 4
      if (moved) {
        canvasAutoFitRef.current = false
        canvasSuppressClickRef.current = true
        canvasPanRef.current = { ...pan, moved: true }
        setCanvasView(constrainCanvasView(model, canvasSize, {
          ...pan.view,
          x: pan.view.x - dx * (pan.view.width / Math.max(1, canvasSize.width)),
          y: pan.view.y - dy * (pan.view.height / Math.max(1, canvasSize.height)),
        }))
        setHover(null)
        setHoverSnapped(false)
        e.preventDefault()
        return
      }
    }

    handleMove(e)
  }

  const handleCanvasPointerEnd = (e: React.PointerEvent<SVGSVGElement>) => {
    canvasPointersRef.current.delete(e.pointerId)
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (canvasPointersRef.current.size < 2) canvasPinchRef.current = null
    if (canvasPointersRef.current.size === 1) {
      const remaining = Array.from(canvasPointersRef.current.values())[0]
      canvasPanRef.current = { startX: remaining.clientX, startY: remaining.clientY, view: canvasView, moved: false }
    } else {
      canvasPanRef.current = null
    }
    endDragOpening()
  }

  const handleCanvasPointerLeave = () => {
    if (canvasPointersRef.current.size > 0) return
    endDragOpening()
    setHover(null)
    setHoverSnapped(false)
  }

  const handleCanvasWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault()
    const factor = Math.exp(Math.max(-0.7, Math.min(0.7, e.deltaY * 0.001)))
    canvasAutoFitRef.current = false
    setCanvasView((view) => zoomCanvasAt(e.clientX, e.clientY, factor, view))
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
    if (canvasSuppressClickRef.current) {
      canvasSuppressClickRef.current = false
      dragMovedRef.current = false
      return
    }
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
    canvasAutoFitRef.current = true
    setModel(EMPTY_MODEL)
    setStatus(null)
    setError(null)
  }

  const updateWallHeight = (value: number) => {
    const nextHeight = Number.isFinite(value) && value > 0 ? value : DEFAULT_WALL_HEIGHT_FT
    if (model.height !== undefined && Math.abs(wallHeightFt(model) - nextHeight) < 0.001) return
    commit({ ...model, height: nextHeight })
  }

  const updateModelFrom3D = useCallback((next: SketchModel) => {
    setModel(next)
    setStatus(null)
    setError(null)
  }, [])

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
      const height = importWallHeight(data.height)
      const nextModel: SketchModel = {
        version: 1,
        cellFt: data.cellFt ?? CELL_FT,
        contours: data.contours,
        openings: Array.isArray(data.openings) ? data.openings : [],
      }
      const finishes = sanitizeSketchFinishes(data.finishes)
      const lights = sanitizeSketchLights(data.lights)
      const switches = sanitizeSketchSwitches(data.switches)
      if (height !== undefined) nextModel.height = height
      if (finishes) nextModel.finishes = finishes
      if (lights.length > 0) nextModel.lights = lights
      if (switches.length > 0) nextModel.switches = switches
      setHistory((h) => [...h.slice(-HISTORY_MAX + 1), model])
      canvasAutoFitRef.current = true
      setModel(nextModel)
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
  const heightFt = wallHeightFt(model)
  const pxPerFt = (canvasSize.width * CELL_PX) / Math.max(1, canvasView.width)
  const showSubgrid = pxPerFt >= SUBGRID_HIDE_PX_PER_FT
  const gridLines = useMemo(() => canvasGridLines(canvasView, showSubgrid), [canvasView, showSubgrid])
  const screenWorldPx = canvasView.width / Math.max(1, canvasSize.width)
  const nodeRadius = Math.max(3, Math.min(18, 5 * screenWorldPx))
  const hoverRadius = Math.max(4, Math.min(20, 6 * screenWorldPx))

  return (
    <section className="hub-tab-panel hub-sketch">
      <div className="card hub-sketch-viewbar">
        <div className="hub-sketch-view-toggle" role="group" aria-label={t('hub_sketch_view_mode')}>
          {(['2d', '3d'] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={viewMode === mode ? 'btn small' : 'btn ghost small'}
              aria-pressed={viewMode === mode}
              onClick={() => {
                if (mode === '2d') canvasAutoFitRef.current = true
                setViewMode(mode)
              }}
            >
              {t(mode === '2d' ? 'hub_sketch_view_2d' : 'hub_sketch_view_3d')}
            </button>
          ))}
        </div>
        <label className="hub-sketch-height-field">
          <span className="muted">{t('hub_sketch_wall_height')}</span>
          <input
            type="number"
            min="1"
            step="0.5"
            value={heightFt}
            disabled={!canEdit}
            onChange={(e) => updateWallHeight(Number(e.target.value))}
          />
          <span className="muted">ft</span>
        </label>
      </div>

      {canEdit && viewMode === '2d' && (
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
        {viewMode === '2d' ? (
          <>
            <div className="hub-sketch-svg-shell">
              <svg
                ref={svgRef}
                className="hub-sketch-svg"
                viewBox={`${canvasView.x} ${canvasView.y} ${canvasView.width} ${canvasView.height}`}
                preserveAspectRatio="xMidYMid meet"
                role="img"
                aria-label={t('hub_tab_sketch')}
                onClick={handleClick}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerEnd}
                onPointerCancel={handleCanvasPointerEnd}
                onPointerLeave={handleCanvasPointerLeave}
                onWheel={handleCanvasWheel}
              >
          {/* сетка */}
          <g className="hub-sketch-subgrid">
            {gridLines.subX.map((x) => (
              <line key={`sv${x}`} x1={x} y1={canvasView.y} x2={x} y2={canvasView.y + canvasView.height} />
            ))}
            {gridLines.subY.map((y) => (
              <line key={`sh${y}`} x1={canvasView.x} y1={y} x2={canvasView.x + canvasView.width} y2={y} />
            ))}
          </g>
          <g className="hub-sketch-grid">
            {gridLines.majorX.map((x) => (
              <line key={`v${x}`} x1={x} y1={canvasView.y} x2={x} y2={canvasView.y + canvasView.height} />
            ))}
            {gridLines.majorY.map((y) => (
              <line key={`h${y}`} x1={canvasView.x} y1={y} x2={canvasView.x + canvasView.width} y2={y} />
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
              <circle key={`n${ci}-${pi}`} className="hub-sketch-node" cx={p.x * CELL_PX} cy={p.y * CELL_PX} r={nodeRadius} />
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
            const dimLabel = openingDimLabel(model, o, i, t)
            return (
              <g
                key={`o${i}`}
                className={canEdit ? 'hub-sketch-opening' : undefined}
                onPointerDown={canEdit ? startDragOpening(i) : undefined}
              >
                <line className={cls} x1={x1} y1={y1} x2={x2} y2={y2} />
                {/* невидимый широкий хит-таргет для захвата пальцем */}
                <line className="hub-sketch-opening-hit" x1={x1} y1={y1} x2={x2} y2={y2} />
                {dimLabel && (
                  <g
                    className={`hub-sketch-opening-dim hub-sketch-opening-dim-${dimLabel.kind}`}
                    transform={`translate(${dimLabel.x} ${dimLabel.y})`}
                  >
                    <text textAnchor="middle">
                      {dimLabel.lines.map((line, lineIndex) => (
                        <tspan key={`dim-line-${lineIndex}`} x="0" dy={lineIndex === 0 ? -12 : 12}>
                          {line}
                        </tspan>
                      ))}
                    </text>
                  </g>
                )}
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
              const cellFt = modelCellFt(model)
              const wCells = Math.min(openingWidthFt(o) / cellFt, segLen)
              const left = Math.max(0, (o.t * segLen - wCells / 2) * cellFt)
              const right = Math.max(0, ((1 - o.t) * segLen - wCells / 2) * cellFt)
              const px = g.p.x * CELL_PX
              const py = g.p.y * CELL_PX
              const floorTxt = ` · ${t('hub_sketch_dim_floor_short')} ${fmtFt(openingFloorFt(o))}`
              return (
                <text className="hub-sketch-drag-dim" x={px} y={py - 12} textAnchor="middle">
                  {`◄ ${fmtFt(left)}  ·  ${fmtFt(right)} ►${floorTxt}`}
                </text>
              )
            })()}

          {/* превью курсора */}
          {canEdit && hover && tool === 'wall' && (
            <circle
              className={hoverSnapped ? 'hub-sketch-hover hub-sketch-hover-snap' : 'hub-sketch-hover'}
              cx={hover.x * CELL_PX}
              cy={hover.y * CELL_PX}
              r={hoverRadius}
            />
          )}
              </svg>
              <div className="hub-sketch-2d-tools" role="toolbar" aria-label={t('hub_sketch_2d_canvas_tools')}>
                <button type="button" className="btn ghost small" onClick={fitCanvasToModel}>
                  {t('hub_sketch_camera_fit')}
                </button>
              </div>
            </div>
            <p className="muted hub-sketch-scale">{t('hub_sketch_scale_note')}</p>
          </>
        ) : (
          <Sketch3DView
            model={model}
            heightFt={heightFt}
            canEdit={canEdit}
            onModelChange={updateModelFrom3D}
            label={t('hub_sketch_3d_label')}
            loadingLabel={t('hub_sketch_3d_loading')}
            errorLabel={t('hub_sketch_3d_error')}
          />
        )}
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
