import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
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
  codeClearanceEntityLabel,
  codeClearanceItemIds,
  formatCodeClearanceIn,
  formatCodeClearanceMessage,
  getCodeClearanceChecks,
  type CodeClearanceCheck,
} from './code-clearances'
import {
  BIFOLD_DOOR_WIDTH_PRESETS_FT,
  DEFAULT_DOOR_HEIGHT_FT,
  DEFAULT_DOOR_WIDTH_FT,
  DEFAULT_WINDOW_HEIGHT_FT,
  DEFAULT_WINDOW_SILL_FT,
  DEFAULT_WINDOW_WIDTH_FT,
  DEFAULT_DRYWALL_PATCH_COLOR,
  DOOR_WIDTH_PRESETS_FT,
  WINDOW_WIDTH_PRESETS_FT,
  OPENING_DEFAULTS_FT,
  DEFAULT_WALL_PAINT,
  cleanColor,
  normalizeFinishes,
  sanitizeSketchFinishes,
  sanitizeSketchLights,
  sanitizeSketchMeasurements,
  sanitizeSketchOpenings,
  sanitizeSketchSwitches,
  sketchWallKey,
  type SketchFinishes,
  type SketchLight,
  type SketchMeasurement,
  type SketchSwitch,
} from './sketchFinishes'
import {
  isShowerPanPlacedCatalogItem,
  isToiletPlacedCatalogItem,
  sanitizePlacedCatalogItems,
  showerPanShapeFromPlacedItem,
  type SketchPlacedCatalogItem,
  type SketchShowerPanShape,
} from './sketchCatalog'
import { formatFeetInches, formatInches, parseFeetInches, snapFeetToPrecision, snapOpeningFeetToPrecision } from './inches'
import {
  cabinetDisplayCode,
  cabinetScheduleCsv,
  isCabinetPlacedItem,
  layoutCabinetRunOnWall,
  type CabinetLayoutResult,
} from './cabinetCodes'

interface SketchTabProps {
  project: Project
  profile: Profile | null
}

// Геометрия хранится в клетках сетки. Масштаб: 1 клетка = 1 фут.
const CELL_FT = 1
const CELL_PX = 32
const DEFAULT_GRID_COLS = 24
const DEFAULT_GRID_ROWS = 18
const VIEW_W = DEFAULT_GRID_COLS * CELL_PX
const VIEW_H = DEFAULT_GRID_ROWS * CELL_PX
const MIN_VIEW_CELLS = 4
const MAX_VIEW_CELLS = 4096
const MIN_MINOR_GRID_SCREEN_PX = 8
const CLOSE_SNAP = 0.45 // клетки — попадание в стартовую точку замыкает контур
const SEG_HIT = 0.7 // клетки — попадание в сегмент при установке двери/окна
const ROOM_SNAP = 0.6 // клетки — радиус прилипания новой комнаты к существующим вершинам/стенам
const HISTORY_MAX = 60
const DEFAULT_WALL_HEIGHT_FT = 8
const DIM_OFFSET_SCREEN_PX = 24
const DIM_LABEL_SCREEN_PX = 12
const DIM_TICK_SCREEN_PX = 8
const EIGHTH_IN_FT = 1 / 96
const EDGE_AUTO_PAN_SCREEN_PX = 40
const EDGE_AUTO_PAN_MAX_PX_PER_SEC = 620

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
  measurements?: SketchMeasurement[]
  finishes?: SketchFinishes
  lights?: SketchLight[]
  switches?: SketchSwitch[]
  placedItems?: SketchPlacedCatalogItem[]
}
type ViewMode = '2d' | '3d'
type CanvasSize = { width: number; height: number }
type CanvasView = { x: number; y: number; width: number; height: number }
type SnapMode = '1ft' | '6in' | '1in' | '1_8in'
type FeetDraftField = 'wallHeight' | 'doorW' | 'doorH' | 'winW' | 'winH' | 'winSill'

const SNAP_OPTIONS: Array<{ mode: SnapMode; stepFt: number; labelKey: string }> = [
  { mode: '1ft', stepFt: 1, labelKey: 'hub_sketch_snap_1ft' },
  { mode: '6in', stepFt: 0.5, labelKey: 'hub_sketch_snap_6in' },
  { mode: '1in', stepFt: 1 / 12, labelKey: 'hub_sketch_snap_1in' },
  { mode: '1_8in', stepFt: EIGHTH_IN_FT, labelKey: 'hub_sketch_snap_1_8in' },
]

// Ширина проёма в футах с учётом дефолта по типу.
function openingWidthFt(o: Opening): number {
  return o.w ?? (o.kind === 'door' ? DEFAULT_DOOR_WIDTH_FT : DEFAULT_WINDOW_WIDTH_FT)
}

function openingHeightFt(o: Opening): number {
  return o.kind === 'door' ? (o.h ?? DEFAULT_DOOR_HEIGHT_FT) : (o.h ?? DEFAULT_WINDOW_HEIGHT_FT)
}

function openingFloorFt(o: Opening): number {
  return o.kind === 'door' ? 0 : (o.sill ?? DEFAULT_WINDOW_SILL_FT)
}

function modelCellFt(model: SketchModel): number {
  return Number.isFinite(model.cellFt) && model.cellFt > 0 ? model.cellFt : CELL_FT
}

function wallHeightFt(model: SketchModel): number {
  return Number.isFinite(model.height) && (model.height ?? 0) > 0 ? model.height ?? DEFAULT_WALL_HEIGHT_FT : DEFAULT_WALL_HEIGHT_FT
}

function formatLengthFt(valueFt: number): string {
  return formatFeetInches((Number.isFinite(valueFt) ? valueFt : 0) * 12)
}

function formatOpeningFt(valueFt: number): string {
  return formatInches((Number.isFinite(valueFt) ? valueFt : 0) * 12)
}

function parseLengthFt(value: string): number {
  const parsedInches = parseFeetInches(value)
  return Number.isFinite(parsedInches) ? parsedInches / 12 : Number.NaN
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function snapLengthFt(valueFt: number, stepFt: number): number {
  const step = Number.isFinite(stepFt) && stepFt > 0 ? stepFt : 1
  return Math.round(valueFt / step) * step
}

function snapSegmentT(t: number, segLenCells: number, cellFt: number, stepFt: number): number {
  if (segLenCells <= 0 || cellFt <= 0) return Math.max(0, Math.min(1, t))
  const snappedFt = snapLengthFt(t * segLenCells * cellFt, stepFt)
  return Math.max(0, Math.min(1, snappedFt / (segLenCells * cellFt)))
}

function clampOpeningT(model: SketchModel, opening: Opening, t: number): number {
  const ends = openingEnds(model, opening)
  if (!ends) return Math.max(0, Math.min(1, t))
  const segLenFt = dist(ends.a, ends.b) * modelCellFt(model)
  if (segLenFt <= 0.001) return 0.5
  const widthFt = Math.max(0.1, Math.min(openingWidthFt(opening), segLenFt))
  if (widthFt >= segLenFt - 0.001) return 0.5
  const padT = (widthFt / 2) / segLenFt
  return Math.max(padT, Math.min(1 - padT, t))
}

function snapOpeningT(model: SketchModel, opening: Opening, t: number, stepFt: number): number {
  const ends = openingEnds(model, opening)
  if (!ends) return clampOpeningT(model, opening, t)
  const snapped = snapSegmentT(t, dist(ends.a, ends.b), modelCellFt(model), Math.max(stepFt, EIGHTH_IN_FT))
  return clampOpeningT(model, opening, snapped)
}

function snapModeStep(mode: SnapMode): number {
  return SNAP_OPTIONS.find((option) => option.mode === mode)?.stepFt ?? 1
}

function importWallHeight(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? snapFeetToPrecision(n) : undefined
}

type Tool = 'wall' | 'door' | 'window' | 'measure' | 'cabinet'
type OpeningTool = Extract<Tool, 'door' | 'window'>

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function makeId(prefix: string): string {
  const maybeCrypto = typeof crypto !== 'undefined' ? crypto : undefined
  const uuid = maybeCrypto && 'randomUUID' in maybeCrypto ? maybeCrypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${uuid}`
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

function normalizeCanvasView(size: CanvasSize, view: CanvasView): CanvasView {
  const aspect = canvasAspect(size)
  const minWidth = MIN_VIEW_CELLS * CELL_PX
  const maxWidth = MAX_VIEW_CELLS * CELL_PX
  const width = Math.max(minWidth, Math.min(maxWidth, Number.isFinite(view.width) ? view.width : VIEW_W))
  const height = width / aspect
  const cx = Number.isFinite(view.x) && Number.isFinite(view.width) ? view.x + view.width / 2 : 0
  const cy = Number.isFinite(view.y) && Number.isFinite(view.height) ? view.y + view.height / 2 : 0
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
  if (!bounds.hasPoints) {
    const width = VIEW_W
    const height = width / aspect
    return normalizeCanvasView(size, {
      x: -width / 2,
      y: -height / 2,
      width,
      height,
    })
  }
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
  return normalizeCanvasView(size, {
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

function gridLinePositions(startPx: number, endPx: number, stepPx: number): number[] {
  const start = Math.floor(startPx / stepPx) - 1
  const end = Math.ceil(endPx / stepPx) + 1
  const count = Math.max(0, end - start + 1)
  return Array.from({ length: count }, (_, i) => (start + i) * stepPx)
}

function isMajorGridLine(valuePx: number): boolean {
  return Math.abs(valuePx / CELL_PX - Math.round(valuePx / CELL_PX)) < 0.0001
}

function canvasGridLines(view: CanvasView, snapStepFt: number, pxPerFt: number) {
  const left = view.x
  const right = view.x + view.width
  const top = view.y
  const bottom = view.y + view.height
  const minorStepPx = Math.max(0.0001, snapStepFt * CELL_PX)
  const includeMinor = snapStepFt < CELL_FT && pxPerFt * snapStepFt >= MIN_MINOR_GRID_SCREEN_PX
  return {
    subX: includeMinor ? gridLinePositions(left, right, minorStepPx).filter((x) => !isMajorGridLine(x)) : [],
    subY: includeMinor ? gridLinePositions(top, bottom, minorStepPx).filter((y) => !isMajorGridLine(y)) : [],
    majorX: gridLinePositions(left, right, CELL_PX),
    majorY: gridLinePositions(top, bottom, CELL_PX),
  }
}

const EMPTY_MODEL: SketchModel = { version: 1, cellFt: CELL_FT, contours: [], openings: [] }

function normalizeOpeningForModel(model: SketchModel, opening: Opening): Opening | null {
  if (!openingEnds(model, opening)) return null
  const width = snapOpeningFeetToPrecision(openingWidthFt(opening))
  const roomHeight = wallHeightFt(model)
  const height = Math.max(0.5, Math.min(snapOpeningFeetToPrecision(openingHeightFt(opening)), roomHeight))
  const sill = Math.max(0, Math.min(snapOpeningFeetToPrecision(openingFloorFt(opening)), Math.max(0, roomHeight - height)))
  const next: Opening = {
    kind: opening.kind,
    c: opening.c,
    s: opening.s,
    t: snapOpeningT(model, { ...opening, w: width }, opening.t, EIGHTH_IN_FT),
    w: Math.max(0.5, width),
  }
  if (opening.kind === 'door') next.h = height
  else {
    next.h = height
    next.sill = sill
  }
  return next
}

function normalizeSketchModelForStorage(model: SketchModel): SketchModel {
  const measurements = sanitizeSketchMeasurements(model.measurements)
  const placedItems = sanitizePlacedCatalogItems(model.placedItems)
  const next: SketchModel = {
    ...model,
    version: 1,
    cellFt: modelCellFt(model),
    openings: model.openings
      .map((opening) => normalizeOpeningForModel(model, opening))
      .filter((opening): opening is Opening => !!opening),
  }
  if (model.height !== undefined) next.height = snapFeetToPrecision(wallHeightFt(model))
  if (measurements.length > 0) next.measurements = measurements
  else delete next.measurements
  if (placedItems.length > 0) next.placedItems = placedItems
  else delete next.placedItems
  return next
}

function fmtFt(valueFt: number): string {
  return formatLengthFt(valueFt)
}

function fmtLen(cells: number): string {
  return fmtFt(cells * CELL_FT)
}

type DimLineKind = Opening['kind'] | 'wall'

type DimLine2D = {
  x1: number
  y1: number
  x2: number
  y2: number
  ext1x1: number
  ext1y1: number
  ext1x2: number
  ext1y2: number
  ext2x1: number
  ext2y1: number
  ext2x2: number
  ext2y2: number
  tick1x1: number
  tick1y1: number
  tick1x2: number
  tick1y2: number
  tick2x1: number
  tick2y1: number
  tick2x2: number
  tick2y2: number
  labelX: number
  labelY: number
  angle: number
  text: string
  kind: DimLineKind
}

type OpeningDimLabel = DimLine2D & { kind: Opening['kind'] }
type SegmentDimLine = DimLine2D & { kind: 'wall' }
type OpeningSpan2D = {
  g: { p: Pt; ux: number; uy: number; a: Pt; b: Pt }
  segLenCells: number
  widthCells: number
  startCells: number
  endCells: number
  leftEdge: Pt
  rightEdge: Pt
  cellFt: number
}
type PlanMeasurementEntry = { measurement: SketchMeasurement; index: number }
type MeasurementLine2D = {
  x1: number
  y1: number
  x2: number
  y2: number
  labelX: number
  labelY: number
  angle: number
  text: string
}
type PlanCodeClearanceLine = MeasurementLine2D & { id: string; warning: boolean; check: CodeClearanceCheck }
type PlanCodeClearanceArc = { id: string; d: string; warning: boolean }
type PlanPlacedItem = {
  item: SketchPlacedCatalogItem
  x: number
  y: number
  angle: number
  width: number
  depth: number
  warning: boolean
  toilet: boolean
  showerPan: boolean
  showerPanShape: SketchShowerPanShape
  cabinet: boolean
  cabinetCode: string
  filler: boolean
  layer?: 'base' | 'wall'
}

function contourCenter(contour: Contour): Pt {
  if (contour.points.length === 0) return { x: 0, y: 0 }
  const sum = contour.points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 })
  return { x: sum.x / contour.points.length, y: sum.y / contour.points.length }
}

function readableSvgAngle(dx: number, dy: number): number {
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI
  if (angle > 90 || angle < -90) angle += 180
  return angle
}

function createDimLine(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  nx: number,
  ny: number,
  offsetPx: number,
  screenWorldPx: number,
  text: string,
  kind: DimLineKind,
): DimLine2D | null {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len <= 0.01) return null
  const ux = dx / len
  const uy = dy / len
  const gap = 4 * screenWorldPx
  const tick = DIM_TICK_SCREEN_PX * screenWorldPx
  const labelGap = DIM_LABEL_SCREEN_PX * screenWorldPx
  const x1 = ax + nx * offsetPx
  const y1 = ay + ny * offsetPx
  const x2 = bx + nx * offsetPx
  const y2 = by + ny * offsetPx
  const slashX = (ux + nx) * tick
  const slashY = (uy + ny) * tick
  return {
    x1,
    y1,
    x2,
    y2,
    ext1x1: ax + nx * gap,
    ext1y1: ay + ny * gap,
    ext1x2: x1 + nx * gap,
    ext1y2: y1 + ny * gap,
    ext2x1: bx + nx * gap,
    ext2y1: by + ny * gap,
    ext2x2: x2 + nx * gap,
    ext2y2: y2 + ny * gap,
    tick1x1: x1 - slashX / 2,
    tick1y1: y1 - slashY / 2,
    tick1x2: x1 + slashX / 2,
    tick1y2: y1 + slashY / 2,
    tick2x1: x2 - slashX / 2,
    tick2y1: y2 - slashY / 2,
    tick2x2: x2 + slashX / 2,
    tick2y2: y2 + slashY / 2,
    labelX: (x1 + x2) / 2 + nx * labelGap,
    labelY: (y1 + y2) / 2 + ny * labelGap,
    angle: readableSvgAngle(dx, dy),
    text,
    kind,
  }
}

function outsideNormal(model: SketchModel, c: number, ax: number, ay: number, bx: number, by: number): { nx: number; ny: number } {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  let nx = -dy / len
  let ny = dx / len
  const contour = model.contours[c]
  if (contour?.points.length) {
    const center = contourCenter(contour)
    const midX = (ax + bx) / 2 / CELL_PX
    const midY = (ay + by) / 2 / CELL_PX
    if ((center.x - midX) * nx + (center.y - midY) * ny > 0) {
      nx *= -1
      ny *= -1
    }
  }
  return { nx, ny }
}

function segmentDimLine(model: SketchModel, seg: { c: number; s: number; a: Pt; b: Pt }, screenWorldPx: number): SegmentDimLine | null {
  const ax = seg.a.x * CELL_PX
  const ay = seg.a.y * CELL_PX
  const bx = seg.b.x * CELL_PX
  const by = seg.b.y * CELL_PX
  const { nx, ny } = outsideNormal(model, seg.c, ax, ay, bx, by)
  const offset = DIM_OFFSET_SCREEN_PX * screenWorldPx
  return createDimLine(ax, ay, bx, by, nx, ny, offset, screenWorldPx, fmtFt(dist(seg.a, seg.b) * modelCellFt(model)), 'wall') as SegmentDimLine | null
}

function openingDimLabel(model: SketchModel, opening: Opening, index: number, t: (k: string) => string, screenWorldPx: number): OpeningDimLabel | null {
  const g = openingGeom(model, opening)
  if (!g) return null
  const segLenCells = dist(g.a, g.b)
  if (segLenCells <= 0.01) return null
  const cellFt = modelCellFt(model)
  const widthFt = openingWidthFt(opening)
  const widthCells = Math.min(widthFt / cellFt, segLenCells)
  const hx = (g.ux * widthCells * CELL_PX) / 2
  const hy = (g.uy * widthCells * CELL_PX) / 2
  const ax = g.p.x * CELL_PX - hx
  const ay = g.p.y * CELL_PX - hy
  const bx = g.p.x * CELL_PX + hx
  const by = g.p.y * CELL_PX + hy
  const normal = outsideNormal(model, opening.c, g.a.x * CELL_PX, g.a.y * CELL_PX, g.b.x * CELL_PX, g.b.y * CELL_PX)
  const offset = (16 + (index % 2) * 6) * screenWorldPx
  const text = opening.kind === 'door'
    ? `${t('hub_sketch_dim_size_short')} ${formatOpeningFt(widthFt)}×${formatOpeningFt(openingHeightFt(opening))}`
    : `${t('hub_sketch_dim_size_short')} ${formatOpeningFt(widthFt)}×${formatOpeningFt(openingHeightFt(opening))} · ${t('hub_sketch_dim_floor_short')} ${formatOpeningFt(openingFloorFt(opening))}`
  return createDimLine(ax, ay, bx, by, normal.nx, normal.ny, offset, screenWorldPx, text, opening.kind) as OpeningDimLabel | null
}

function openingSpan2D(model: SketchModel, opening: Opening): OpeningSpan2D | null {
  const g = openingGeom(model, opening)
  if (!g) return null
  const segLenCells = dist(g.a, g.b)
  if (segLenCells <= 0.01) return null
  const cellFt = modelCellFt(model)
  const widthCells = Math.min(openingWidthFt(opening) / cellFt, segLenCells)
  const startCells = Math.max(0, Math.min(segLenCells - widthCells, opening.t * segLenCells - widthCells / 2))
  const endCells = startCells + widthCells
  const pointAt = (cells: number): Pt => ({ x: g.a.x + g.ux * cells, y: g.a.y + g.uy * cells })
  return {
    g,
    segLenCells,
    widthCells,
    startCells,
    endCells,
    leftEdge: pointAt(startCells),
    rightEdge: pointAt(endCells),
    cellFt,
  }
}

function openingClearanceDimLines(
  model: SketchModel,
  opening: Opening,
  ignoreIndex: number | null,
  t: (k: string) => string,
  screenWorldPx: number,
): DimLine2D[] {
  const span = openingSpan2D(model, opening)
  if (!span) return []
  const normal = outsideNormal(model, opening.c, span.g.a.x * CELL_PX, span.g.a.y * CELL_PX, span.g.b.x * CELL_PX, span.g.b.y * CELL_PX)
  const lines: DimLine2D[] = []
  const push = (fromCells: number, toCells: number, offsetScreenPx: number, text: string) => {
    if (toCells - fromCells <= 0.02) return
    const ax = (span.g.a.x + span.g.ux * fromCells) * CELL_PX
    const ay = (span.g.a.y + span.g.uy * fromCells) * CELL_PX
    const bx = (span.g.a.x + span.g.ux * toCells) * CELL_PX
    const by = (span.g.a.y + span.g.uy * toCells) * CELL_PX
    const line = createDimLine(ax, ay, bx, by, normal.nx, normal.ny, offsetScreenPx * screenWorldPx, screenWorldPx, text, 'wall')
    if (line) lines.push(line)
  }

  push(0, span.startCells, 42, `${t('hub_sketch_dim_left_short')} ${formatOpeningFt(span.startCells * span.cellFt)}`)
  push(span.endCells, span.segLenCells, 42, `${t('hub_sketch_dim_right_short')} ${formatOpeningFt((span.segLenCells - span.endCells) * span.cellFt)}`)

  let leftNeighborEndCells: number | null = null
  let rightNeighborStartCells: number | null = null
  model.openings.forEach((other, index) => {
    if (ignoreIndex !== null && index === ignoreIndex) return
    if (other.c !== opening.c || other.s !== opening.s) return
    const otherSpan = openingSpan2D(model, other)
    if (!otherSpan) return
    if (otherSpan.endCells <= span.startCells + 0.001 && (leftNeighborEndCells === null || otherSpan.endCells > leftNeighborEndCells)) {
      leftNeighborEndCells = otherSpan.endCells
    }
    if (otherSpan.startCells >= span.endCells - 0.001 && (rightNeighborStartCells === null || otherSpan.startCells < rightNeighborStartCells)) {
      rightNeighborStartCells = otherSpan.startCells
    }
  })

  if (leftNeighborEndCells !== null) {
    const gap = Math.max(0, (span.startCells - leftNeighborEndCells) * span.cellFt)
    push(leftNeighborEndCells, span.startCells, 62, `${t('hub_sketch_dim_gap_short')} ${formatOpeningFt(gap)}`)
  }
  if (rightNeighborStartCells !== null) {
    const gap = Math.max(0, (rightNeighborStartCells - span.endCells) * span.cellFt)
    push(span.endCells, rightNeighborStartCells, 62, `${t('hub_sketch_dim_gap_short')} ${formatOpeningFt(gap)}`)
  }

  return lines
}

function isPlanMeasurement(measurement: SketchMeasurement): boolean {
  return !measurement.scope || measurement.scope === 'plan'
}

function planMeasurementLine(model: SketchModel, measurement: SketchMeasurement, screenWorldPx: number): MeasurementLine2D | null {
  const x1 = measurement.a.x * CELL_PX
  const y1 = measurement.a.y * CELL_PX
  const x2 = measurement.b.x * CELL_PX
  const y2 = measurement.b.y * CELL_PX
  const dx = x2 - x1
  const dy = y2 - y1
  const lenPx = Math.hypot(dx, dy)
  if (lenPx <= 0.01) return null
  const nx = -dy / lenPx
  const ny = dx / lenPx
  const labelGap = 13 * screenWorldPx
  return {
    x1,
    y1,
    x2,
    y2,
    labelX: (x1 + x2) / 2 + nx * labelGap,
    labelY: (y1 + y2) / 2 + ny * labelGap,
    angle: readableSvgAngle(dx, dy),
    text: fmtFt(dist(measurement.a, measurement.b) * modelCellFt(model)),
  }
}

function planCodeClearanceLine(model: SketchModel, check: CodeClearanceCheck, t: (k: string) => string, screenWorldPx: number): PlanCodeClearanceLine | null {
  if (!check.line) return null
  const cellFt = modelCellFt(model)
  const x1 = (check.line.a.x / cellFt) * CELL_PX
  const y1 = (check.line.a.z / cellFt) * CELL_PX
  const x2 = (check.line.b.x / cellFt) * CELL_PX
  const y2 = (check.line.b.z / cellFt) * CELL_PX
  const dx = x2 - x1
  const dy = y2 - y1
  const lenPx = Math.hypot(dx, dy)
  if (lenPx <= 0.01) return null
  const nx = -dy / lenPx
  const ny = dx / lenPx
  const labelGap = (check.ok ? 15 : 22) * screenWorldPx
  const target = codeClearanceEntityLabel(check.target, t)
  return {
    id: check.id,
    x1,
    y1,
    x2,
    y2,
    labelX: (x1 + x2) / 2 + nx * labelGap,
    labelY: (y1 + y2) / 2 + ny * labelGap,
    angle: readableSvgAngle(dx, dy),
    text: check.ok ? `${formatCodeClearanceIn(check.actualIn)} · ${target}` : formatCodeClearanceMessage(check, t),
    warning: !check.ok,
    check,
  }
}

function planCodeClearanceArc(model: SketchModel, check: CodeClearanceCheck): PlanCodeClearanceArc | null {
  if (!check.arc) return null
  const cellFt = modelCellFt(model)
  const cx = (check.arc.center.x / cellFt) * CELL_PX
  const cy = (check.arc.center.z / cellFt) * CELL_PX
  const sx = (check.arc.start.x / cellFt) * CELL_PX
  const sy = (check.arc.start.z / cellFt) * CELL_PX
  const ex = (check.arc.end.x / cellFt) * CELL_PX
  const ey = (check.arc.end.z / cellFt) * CELL_PX
  const radius = (check.arc.radiusFt / cellFt) * CELL_PX
  const start = { x: sx - cx, y: sy - cy }
  const end = { x: ex - cx, y: ey - cy }
  const sweep = start.x * end.y - start.y * end.x >= 0 ? 1 : 0
  return { id: check.id, d: `M ${sx} ${sy} A ${radius} ${radius} 0 0 ${sweep} ${ex} ${ey}`, warning: !check.ok }
}

function planPlacedItems(model: SketchModel, warningIds: Set<string>): PlanPlacedItem[] {
  const cellFt = modelCellFt(model)
  return sanitizePlacedCatalogItems(model.placedItems)
    .map((item): PlanPlacedItem | null => {
      if (item.surface === 'ceiling' || item.category === 'light' || item.category === 'fan') return null
      const widthIn = Number(item.widthIn)
      const depthIn = Number(item.depthIn)
      if (!Number.isFinite(widthIn) || !Number.isFinite(depthIn) || widthIn <= 0 || depthIn <= 0) return null
      const axesAngle = Math.atan2(-Math.sin(item.rotationY), Math.cos(item.rotationY)) * 180 / Math.PI
      const cabinet = isCabinetPlacedItem(item)
      return {
        item,
        x: (item.xFt / cellFt) * CELL_PX,
        y: (item.zFt / cellFt) * CELL_PX,
        angle: axesAngle,
        width: (widthIn / 12 / cellFt) * CELL_PX,
        depth: (depthIn / 12 / cellFt) * CELL_PX,
        warning: warningIds.has(item.id) || !!item.layoutWarning,
        toilet: isToiletPlacedCatalogItem(item),
        showerPan: isShowerPanPlacedCatalogItem(item),
        showerPanShape: showerPanShapeFromPlacedItem(item),
        cabinet,
        cabinetCode: cabinet ? cabinetDisplayCode(item) : '',
        filler: item.filler === true,
        layer: item.layer,
      }
    })
    .filter((item): item is PlanPlacedItem => !!item)
}

function sanitizeName(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9а-я\-_]+/gi, '-').replace(/^-+|-+$/g, '')
  return clean || 'room'
}

function drawCanvasDimLine(ctx: CanvasRenderingContext2D, dim: DimLine2D, viewScale: number, color: string, fontScale = 12) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.2 / viewScale
  ctx.beginPath()
  ctx.moveTo(dim.ext1x1, dim.ext1y1); ctx.lineTo(dim.ext1x2, dim.ext1y2)
  ctx.moveTo(dim.ext2x1, dim.ext2y1); ctx.lineTo(dim.ext2x2, dim.ext2y2)
  ctx.moveTo(dim.x1, dim.y1); ctx.lineTo(dim.x2, dim.y2)
  ctx.moveTo(dim.tick1x1, dim.tick1y1); ctx.lineTo(dim.tick1x2, dim.tick1y2)
  ctx.moveTo(dim.tick2x1, dim.tick2y1); ctx.lineTo(dim.tick2x2, dim.tick2y2)
  ctx.stroke()
  ctx.translate(dim.labelX, dim.labelY)
  ctx.rotate((dim.angle * Math.PI) / 180)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 ${Math.max(9 / viewScale, fontScale / viewScale)}px sans-serif`
  ctx.strokeStyle = 'rgba(255, 255, 255, .94)'
  ctx.lineWidth = 3 / viewScale
  ctx.strokeText(dim.text, 0, 0)
  ctx.fillText(dim.text, 0, 0)
  ctx.restore()
}

function drawCanvasMeasurementLine(ctx: CanvasRenderingContext2D, line: MeasurementLine2D, viewScale: number) {
  const dx = line.x2 - line.x1
  const dy = line.y2 - line.y1
  const len = Math.hypot(dx, dy)
  if (len <= 0.01) return
  const ux = dx / len
  const uy = dy / len
  const arrow = 8 / viewScale
  const wing = 4.5 / viewScale
  const drawArrow = (x: number, y: number, dir: number) => {
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x - ux * arrow * dir - uy * wing, y - uy * arrow * dir + ux * wing)
    ctx.lineTo(x - ux * arrow * dir + uy * wing, y - uy * arrow * dir - ux * wing)
    ctx.closePath()
    ctx.fill()
  }

  ctx.save()
  ctx.strokeStyle = '#047857'
  ctx.fillStyle = '#047857'
  ctx.lineWidth = 1.6 / viewScale
  ctx.beginPath()
  ctx.moveTo(line.x1, line.y1)
  ctx.lineTo(line.x2, line.y2)
  ctx.stroke()
  drawArrow(line.x1, line.y1, -1)
  drawArrow(line.x2, line.y2, 1)
  ctx.translate(line.labelX, line.labelY)
  ctx.rotate((line.angle * Math.PI) / 180)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 ${Math.max(9 / viewScale, 12 / viewScale)}px sans-serif`
  ctx.strokeStyle = 'rgba(255, 255, 255, .94)'
  ctx.lineWidth = 3 / viewScale
  ctx.strokeText(line.text, 0, 0)
  ctx.fillText(line.text, 0, 0)
  ctx.restore()
}

function drawCanvasPlanItem(ctx: CanvasRenderingContext2D, entry: PlanPlacedItem, viewScale: number) {
  ctx.save()
  ctx.translate(entry.x, entry.y)
  ctx.rotate((entry.angle * Math.PI) / 180)
  ctx.lineWidth = (entry.warning ? 2 : 1.2) / viewScale
  ctx.strokeStyle = entry.warning ? '#dc2626' : entry.cabinet ? '#395144' : '#475569'
  ctx.fillStyle = entry.warning ? 'rgba(220, 38, 38, .14)' : entry.cabinet ? (entry.layer === 'wall' ? 'rgba(129, 140, 248, .2)' : 'rgba(127, 159, 104, .28)') : 'rgba(148, 163, 184, .22)'

  if (entry.toilet) {
    ctx.fillStyle = '#f8fafc'
    const tankW = entry.width * 0.88
    const tankH = entry.depth * 0.22
    ctx.fillRect(-tankW / 2, -entry.depth * 0.46, tankW, tankH)
    ctx.beginPath()
    ctx.ellipse(0, entry.depth * 0.1, entry.width * 0.36, entry.depth * 0.28, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
    return
  }

  if (entry.showerPan) {
    ctx.fillStyle = entry.warning ? 'rgba(220, 38, 38, .14)' : 'rgba(95, 168, 211, .22)'
    ctx.strokeStyle = entry.warning ? '#dc2626' : '#256f9f'
    ctx.beginPath()
    if (entry.showerPanShape === 'neo-angle') {
      ctx.moveTo(-entry.width / 2, -entry.depth / 2)
      ctx.lineTo(entry.width / 2, -entry.depth / 2)
      ctx.lineTo(entry.width / 2, entry.depth * 0.12)
      ctx.lineTo(entry.width * 0.12, entry.depth / 2)
      ctx.lineTo(-entry.width / 2, entry.depth / 2)
      ctx.closePath()
    } else {
      ctx.rect(-entry.width / 2, -entry.depth / 2, entry.width, entry.depth)
    }
    ctx.fill()
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(-entry.width * 0.38, 0)
    ctx.lineTo(entry.width * 0.38, 0)
    ctx.stroke()
    ctx.restore()
    return
  }

  ctx.fillRect(-entry.width / 2, -entry.depth / 2, entry.width, entry.depth)
  ctx.strokeRect(-entry.width / 2, -entry.depth / 2, entry.width, entry.depth)
  if (entry.cabinet) {
    ctx.beginPath()
    ctx.moveTo(-entry.width / 2, entry.depth / 2 - Math.max(2 / viewScale, entry.depth * 0.12))
    ctx.lineTo(entry.width / 2, entry.depth / 2 - Math.max(2 / viewScale, entry.depth * 0.12))
    ctx.stroke()
    if (entry.filler) {
      ctx.beginPath()
      ctx.moveTo(-entry.width / 2, -entry.depth / 2)
      ctx.lineTo(entry.width / 2, entry.depth / 2)
      ctx.moveTo(entry.width / 2, -entry.depth / 2)
      ctx.lineTo(-entry.width / 2, entry.depth / 2)
      ctx.stroke()
    }
    const label = entry.cabinetCode
    if (label && entry.width > 12 / viewScale && entry.depth > 6 / viewScale) {
      ctx.fillStyle = entry.warning ? '#991b1b' : '#263f31'
      ctx.strokeStyle = 'rgba(255, 255, 255, .96)'
      ctx.lineWidth = 3 / viewScale
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = `800 ${Math.max(6 / viewScale, Math.min(10 / viewScale, entry.width / Math.max(5, label.length * 0.58)))}px sans-serif`
      ctx.strokeText(label, 0, 0)
      ctx.fillText(label, 0, 0)
    }
  }
  ctx.restore()
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
  const grid = canvasGridLines(view, 0.5, viewScale * CELL_PX)
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
  // размерные линии стен
  for (const seg of eachSegment(model)) {
    const dim = segmentDimLine(model, seg, 1 / viewScale)
    if (dim) drawCanvasDimLine(ctx, dim, viewScale, '#334155')
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
  // постоянные габариты проёмов
  model.openings.forEach((opening, index) => {
    const label = openingDimLabel(model, opening, index, t, 1 / viewScale)
    if (!label) return
    drawCanvasDimLine(ctx, label, viewScale, label.kind === 'door' ? '#7c2d12' : '#1d4ed8', 10.5)
  })
  planPlacedItems(model, new Set()).forEach((entry) => drawCanvasPlanItem(ctx, entry, viewScale))
  for (const measurement of model.measurements ?? []) {
    if (!isPlanMeasurement(measurement)) continue
    const line = planMeasurementLine(model, measurement, 1 / viewScale)
    if (line) drawCanvasMeasurementLine(ctx, line, viewScale)
  }
  ctx.restore()
  // сводка
  const area = model.contours.reduce((s, c) => s + contourArea(c), 0)
  const perim = model.contours.reduce((s, c) => s + contourPerimeter(c), 0)
  ctx.fillStyle = '#0f172a'
  ctx.font = 'bold 13px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(
    `${t('hub_sketch_area')}: ${(area * CELL_FT * CELL_FT).toFixed(1)} ft²  ·  ${t('hub_sketch_perimeter')}: ${fmtFt(perim * CELL_FT)}`,
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
  const [snapMode, setSnapMode] = useState<SnapMode>('1ft')
  const [showMeasurements, setShowMeasurements] = useState(true)
  const [codeCheckEnabled, setCodeCheckEnabled] = useState(true)
  const [measurementDraft, setMeasurementDraft] = useState<Pt | null>(null)
  const [selectedMeasurementIndex, setSelectedMeasurementIndex] = useState<number | null>(null)
  const [hover, setHover] = useState<Pt | null>(null)
  const [hoverSnapped, setHoverSnapped] = useState(false)
  // Габариты проёмов (в футах), задаются перед вставкой.
  const [doorW, setDoorW] = useState(OPENING_DEFAULTS_FT.doorW)
  const [doorH, setDoorH] = useState(OPENING_DEFAULTS_FT.doorH)
  const [winW, setWinW] = useState(OPENING_DEFAULTS_FT.winW)
  const [winH, setWinH] = useState(OPENING_DEFAULTS_FT.winH)
  const [winSill, setWinSill] = useState(OPENING_DEFAULTS_FT.winSill)
  const [feetDrafts, setFeetDrafts] = useState<Partial<Record<FeetDraftField, string>>>({})
  const [cabinetCodes, setCabinetCodes] = useState('B30 2DB27 W3030')
  const [selectedCabinetWallKey, setSelectedCabinetWallKey] = useState<string | null>(null)
  // NAV-FIX-2: общий выбор стены (2D-план ↔ 3D-вид). null = ничего не выбрано.
  const [selectedWallKey, setSelectedWallKey] = useState<string | null>(null)
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

  const svgShellRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const canvasAutoFitRef = useRef(true)
  const canvasSuppressClickRef = useRef(false)
  const canvasPointersRef = useRef<Map<number, { clientX: number; clientY: number }>>(new Map())
  const canvasPanRef = useRef<{ startX: number; startY: number; view: CanvasView; moved: boolean } | null>(null)
  const canvasPinchRef = useRef<{ startDistance: number; startMid: { x: number; y: number }; view: CanvasView } | null>(null)
  const edgeAutoPanPointerRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const edgeAutoPanFrameRef = useRef<number | null>(null)
  const edgeAutoPanLastTimeRef = useRef(0)
  const modelRef = useRef(model)
  const canvasSizeRef = useRef<CanvasSize>({ width: VIEW_W, height: VIEW_H })
  const canvasViewRef = useRef<CanvasView>({ x: 0, y: 0, width: VIEW_W, height: VIEW_H })
  const toolRef = useRef(tool)
  const viewModeRef = useRef(viewMode)
  const canEditRef = useRef(canEdit)
  const measurementDraftRef = useRef(measurementDraft)
  const dragIdxRef = useRef(dragIdx)
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: VIEW_W, height: VIEW_H })
  const [canvasView, setCanvasView] = useState<CanvasView>({ x: 0, y: 0, width: VIEW_W, height: VIEW_H })
  const [canvasBrowserFullscreen, setCanvasBrowserFullscreen] = useState(false)
  const [canvasFullscreenFallback, setCanvasFullscreenFallback] = useState(false)

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
  const activeSnapFt = snapModeStep(snapMode)
  const activeSnapFtRef = useRef(activeSnapFt)
  const canvasFullscreenActive = canvasBrowserFullscreen || canvasFullscreenFallback
  const openingDefaults = useMemo(() => ({ doorW, doorH, winW, winH, winSill }), [doorW, doorH, winW, winH, winSill])
  const cabinetWallOptions = useMemo(() => eachSegment(model), [model])
  const effectiveCabinetWallKey = selectedCabinetWallKey && cabinetWallOptions.some((seg) => sketchWallKey(seg.c, seg.s) === selectedCabinetWallKey)
    ? selectedCabinetWallKey
    : cabinetWallOptions[0]
      ? sketchWallKey(cabinetWallOptions[0].c, cabinetWallOptions[0].s)
      : null
  const selectedCabinetWall = effectiveCabinetWallKey
    ? cabinetWallOptions.find((seg) => sketchWallKey(seg.c, seg.s) === effectiveCabinetWallKey) ?? null
    : null
  const cabinetLayoutPreview = useMemo<CabinetLayoutResult | null>(
    () => selectedCabinetWall ? layoutCabinetRunOnWall(model, selectedCabinetWall, cabinetCodes) : null,
    [model, selectedCabinetWall, cabinetCodes],
  )

  // NAV-FIX-2: сведения о выбранной стене для панели «Стена N» (номер стены общий для 2D и 3D — eachSegment).
  const selectedWall = useMemo(() => {
    if (!selectedWallKey) return null
    const index = cabinetWallOptions.findIndex((seg) => sketchWallKey(seg.c, seg.s) === selectedWallKey)
    if (index < 0) return null
    const seg = cabinetWallOptions[index]
    return { index, seg, key: selectedWallKey, lengthFt: dist(seg.a, seg.b) * modelCellFt(model) }
  }, [selectedWallKey, cabinetWallOptions, model])
  const selectedWallFinish = useMemo(() => {
    if (!selectedWallKey) return null
    const finishes = normalizeFinishes(model.finishes)
    const override = finishes.wallFinishes[selectedWallKey]
    const surface = override ?? finishes.walls
    return {
      overridden: Boolean(override),
      kind: surface.kind,
      color: surface.kind === 'paint'
        ? cleanColor(surface.color, DEFAULT_WALL_PAINT)
        : surface.kind === 'drywall-patch'
          ? cleanColor(surface.patchColor, DEFAULT_DRYWALL_PATCH_COLOR)
          : null,
    }
  }, [selectedWallKey, model.finishes])

  useEffect(() => {
    modelRef.current = model
  }, [model])

  useEffect(() => {
    canvasSizeRef.current = canvasSize
  }, [canvasSize])

  useEffect(() => {
    canvasViewRef.current = canvasView
  }, [canvasView])

  useEffect(() => {
    toolRef.current = tool
  }, [tool])

  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])

  useEffect(() => {
    canEditRef.current = canEdit
  }, [canEdit])

  useEffect(() => {
    measurementDraftRef.current = measurementDraft
  }, [measurementDraft])

  useEffect(() => {
    dragIdxRef.current = dragIdx
  }, [dragIdx])

  useEffect(() => {
    activeSnapFtRef.current = activeSnapFt
  }, [activeSnapFt])

  // Снимок в историю перед изменением; затем применяем мутатор.
  const commit = (next: SketchModel) => {
    setHistory((h) => [...h.slice(-HISTORY_MAX + 1), model])
    setModel(next)
    setStatus(null)
    setError(null)
  }

  useEffect(() => {
    if (!effectiveCabinetWallKey) {
      if (selectedCabinetWallKey) setSelectedCabinetWallKey(null)
      return
    }
    if (selectedCabinetWallKey !== effectiveCabinetWallKey) setSelectedCabinetWallKey(effectiveCabinetWallKey)
  }, [effectiveCabinetWallKey, selectedCabinetWallKey])

  // NAV-FIX-2: снять выбор стены, если её сегмент исчез (перерисовали план).
  useEffect(() => {
    if (selectedWallKey && !cabinetWallOptions.some((seg) => sketchWallKey(seg.c, seg.s) === selectedWallKey)) {
      setSelectedWallKey(null)
    }
  }, [selectedWallKey, cabinetWallOptions])

  // NAV-FIX-2: Esc снимает выделение стены в обоих видах (2D и 3D).
  useEffect(() => {
    if (selectedWallKey === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return
      if (event.key === 'Escape') {
        setSelectedWallKey(null)
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedWallKey])

  // NAV-FIX-2: кнопки панели «Стена N» — только навигация в существующие режимы с уже выбранной стеной.
  const openWallFinish = () => {
    if (!selectedWall) return
    // выбор общий → Sketch3DView сам наведёт отделку/развёртку (SKETCH-WALL-1) на эту стену.
    setMeasurementDraft(null)
    setSelectedMeasurementIndex(null)
    setViewMode('3d')
  }
  const openWallOpenings = () => {
    if (!selectedWall) return
    canvasAutoFitRef.current = false
    setMeasurementDraft(null)
    setViewMode('2d')
    setTool('door')
  }
  const openWallCabinets = () => {
    if (!selectedWall) return
    canvasAutoFitRef.current = false
    setMeasurementDraft(null)
    setViewMode('2d')
    setTool('cabinet')
    setSelectedCabinetWallKey(selectedWall.key)
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
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === svgShellRef.current
      setCanvasBrowserFullscreen(active)
      if (active) setCanvasFullscreenFallback(false)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    if (!canvasFullscreenFallback) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCanvasFullscreenFallback(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canvasFullscreenFallback])

  useEffect(() => {
    if (viewMode !== '2d') return
    setCanvasView((current) => {
      const normalized = normalizeCanvasView(canvasSize, current)
      if (canvasAutoFitRef.current) {
        canvasAutoFitRef.current = false
        const fitted = fitCanvasView(model, canvasSize)
        canvasViewRef.current = fitted
        return fitted
      }
      canvasViewRef.current = normalized
      return normalized
    })
  }, [model, canvasSize, viewMode])

  const fitCanvasToModel = useCallback(() => {
    canvasAutoFitRef.current = false
    const nextView = fitCanvasView(model, canvasSize)
    canvasViewRef.current = nextView
    setCanvasView(nextView)
  }, [model, canvasSize])

  const toggleCanvasFullscreen = async () => {
    const shell = svgShellRef.current
    if (!shell) return
    if (canvasFullscreenActive) {
      setCanvasFullscreenFallback(false)
      if (document.fullscreenElement === shell && document.exitFullscreen) {
        try {
          await document.exitFullscreen()
        } catch {
          setCanvasBrowserFullscreen(false)
        }
      } else {
        setCanvasBrowserFullscreen(false)
      }
      return
    }
    if (shell.requestFullscreen) {
      try {
        await shell.requestFullscreen()
        return
      } catch {
        setCanvasBrowserFullscreen(false)
      }
    }
    setCanvasFullscreenFallback(true)
  }

  const feetInputValue = (field: FeetDraftField, fallbackFt: number): string => {
    return feetDrafts[field] ?? (field === 'wallHeight' ? formatLengthFt(fallbackFt) : formatOpeningFt(fallbackFt))
  }

  const setFeetDraft = (field: FeetDraftField, value: string) => {
    setFeetDrafts((current) => ({ ...current, [field]: value }))
  }

  const clearFeetDraft = (field: FeetDraftField) => {
    setFeetDrafts((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  const commitFeetDraft = (field: FeetDraftField, fallbackFt: number, minFt: number, maxFt: number, apply: (valueFt: number) => void) => {
    const raw = feetDrafts[field] ?? formatLengthFt(fallbackFt)
    clearFeetDraft(field)
    const parsed = parseLengthFt(raw)
    if (!Number.isFinite(parsed)) return
    const clamped = clampNumber(parsed, minFt, maxFt)
    apply(field === 'wallHeight' ? snapFeetToPrecision(clamped) : snapOpeningFeetToPrecision(clamped))
  }

  const handleFeetKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
    field: FeetDraftField,
    fallbackFt: number,
    minFt: number,
    maxFt: number,
    apply: (valueFt: number) => void,
  ) => {
    if (event.key === 'Enter') {
      commitFeetDraft(field, fallbackFt, minFt, maxFt, apply)
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      clearFeetDraft(field)
      event.currentTarget.blur()
    }
  }

  const lengthInput = (
    field: FeetDraftField,
    labelKey: string,
    valueFt: number,
    minFt: number,
    maxFt: number,
    apply: (valueFt: number) => void,
    className = 'hub-sketch-dim-field',
  ) => (
    <label className={className}>
      <span className="muted">{t(labelKey)}</span>
      <input
        type="text"
        inputMode="text"
        value={feetInputValue(field, valueFt)}
        disabled={!canEdit}
        onChange={(e) => setFeetDraft(field, e.target.value)}
        onBlur={() => commitFeetDraft(field, valueFt, minFt, maxFt, apply)}
        onKeyDown={(e) => handleFeetKeyDown(e, field, valueFt, minFt, maxFt, apply)}
      />
    </label>
  )

  const presetButton = (valueFt: number, apply: (valueFt: number) => void, label = formatOpeningFt(valueFt)) => (
    <button key={valueFt} type="button" className="btn ghost small" onClick={() => apply(snapOpeningFeetToPrecision(valueFt))}>
      {label}
    </button>
  )

  const bifoldPresetButton = (valueFt: number) => {
    const leafWidthIn = (valueFt * 12) / 2
    return presetButton(valueFt, setDoorW, `${t('hub_sketch_bifold')} 2x${formatInches(leafWidthIn)}`)
  }

  const openingDraftAt = (kind: OpeningTool, c: number, s: number, rawT: number): Opening => {
    const draft: Opening =
      kind === 'door'
        ? { kind: 'door', c, s, t: rawT, w: Math.max(0.5, snapOpeningFeetToPrecision(doorW)), h: Math.max(0.5, snapOpeningFeetToPrecision(doorH)) }
        : { kind: 'window', c, s, t: rawT, w: Math.max(0.5, snapOpeningFeetToPrecision(winW)), h: Math.max(0.5, snapOpeningFeetToPrecision(winH)), sill: Math.max(0, snapOpeningFeetToPrecision(winSill)) }
    return { ...draft, t: snapOpeningT(model, draft, rawT, activeSnapFt) }
  }

  const canvasPoint = (clientX: number, clientY: number, view = canvasViewRef.current): { x: number; y: number } | null => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: view.x + ((clientX - rect.left) / rect.width) * view.width,
      y: view.y + ((clientY - rect.top) / rect.height) * view.height,
    }
  }

  const pointerCellAt = (clientX: number, clientY: number, view = canvasViewRef.current): Pt | null => {
    const point = canvasPoint(clientX, clientY, view)
    return point ? { x: point.x / CELL_PX, y: point.y / CELL_PX } : null
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
    return normalizeCanvasView(canvasSize, {
      x: anchor.x - ratioX * nextWidth,
      y: anchor.y - ratioY * nextHeight,
      width: nextWidth,
      height: nextHeight,
    })
  }

  // Координаты указателя → клетки сетки (без округления).
  const pointerCell = (e: React.PointerEvent | React.MouseEvent): Pt | null => {
    return pointerCellAt(e.clientX, e.clientY)
  }

  const snapForModel = (baseModel: SketchModel, p: Pt, stepFt: number): Pt => ({
    x: snapLengthFt(p.x * modelCellFt(baseModel), stepFt) / modelCellFt(baseModel),
    y: snapLengthFt(p.y * modelCellFt(baseModel), stepFt) / modelCellFt(baseModel),
  })

  const snap = (p: Pt): Pt => snapForModel(model, p, activeSnapFt)

  // Прилипание новой точки к вершинам/стенам ДРУГИХ контуров (общая стена не дублируется).
  // Возвращает координату существующей геометрии, если она в радиусе ROOM_SNAP, иначе null.
  const snapToExistingForModel = (baseModel: SketchModel, p: Pt): Pt | null => {
    const activeIdx = baseModel.contours.length - 1
    const active = baseModel.contours[activeIdx]
    const drawingNew = !!active && !active.closed
    let best: Pt | null = null
    let bestD = ROOM_SNAP
    // сначала вершины
    baseModel.contours.forEach((c, ci) => {
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
    eachSegment(baseModel).forEach((seg) => {
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

  const snapToExisting = (p: Pt): Pt | null => snapToExistingForModel(model, p)

  // Точка для установки угла стены: прилипание к чужой геометрии имеет приоритет над сеткой.
  const wallPointForModel = (baseModel: SketchModel, raw: Pt, stepFt: number): { p: Pt; snapped: boolean } => {
    const s = snapToExistingForModel(baseModel, raw)
    return s ? { p: s, snapped: true } : { p: snapForModel(baseModel, raw, stepFt), snapped: false }
  }

  const wallPoint = (raw: Pt): { p: Pt; snapped: boolean } => wallPointForModel(model, raw, activeSnapFt)

  const measurementPointForModel = (baseModel: SketchModel, raw: Pt, stepFt: number): { p: Pt; snapped: boolean } => {
    const s = snapToExistingForModel(baseModel, raw)
    return s ? { p: s, snapped: true } : { p: snapForModel(baseModel, raw, stepFt), snapped: false }
  }

  const measurementPoint = (raw: Pt): { p: Pt; snapped: boolean } => measurementPointForModel(model, raw, activeSnapFt)

  const applyPointerMoveAt = (clientX: number, clientY: number, view = canvasViewRef.current) => {
    if (!canEditRef.current) return
    const raw = pointerCellAt(clientX, clientY, view)
    const currentDragIdx = dragIdxRef.current
    if (currentDragIdx !== null) {
      if (!raw) return
      dragMovedRef.current = true
      setModel((m) => {
        const o = m.openings[currentDragIdx]
        if (!o) return m
        const ends = openingEnds(m, o)
        if (!ends) return m
        const rawT = projectT(raw, ends.a, ends.b)
        const nextT = snapOpeningT(m, o, rawT, activeSnapFtRef.current)
        const nextModel = { ...m, openings: m.openings.map((op, i) => (i === currentDragIdx ? { ...op, t: nextT } : op)) }
        modelRef.current = nextModel
        return nextModel
      })
      return
    }
    if (!raw) {
      setHover(null)
      setHoverSnapped(false)
      return
    }
    const currentModel = modelRef.current
    const currentTool = toolRef.current
    if (currentTool === 'wall') {
      const wp = wallPointForModel(currentModel, raw, activeSnapFtRef.current)
      setHover(wp.p)
      setHoverSnapped(wp.snapped)
    } else if (currentTool === 'measure') {
      const mp = measurementPointForModel(currentModel, raw, activeSnapFtRef.current)
      setHover(mp.p)
      setHoverSnapped(mp.snapped)
    } else {
      setHover(raw)
      setHoverSnapped(false)
    }
  }

  function edgeAutoPanInteractionActive(): boolean {
    const currentTool = toolRef.current
    if (dragIdxRef.current !== null) return true
    if (currentTool === 'door' || currentTool === 'window') return true
    if (currentTool === 'measure') return !!measurementDraftRef.current
    if (currentTool !== 'wall') return false
    const currentModel = modelRef.current
    const active = currentModel.contours[currentModel.contours.length - 1]
    return !!active && !active.closed && active.points.length > 0
  }

  function edgeAutoPanAllowed(): boolean {
    if (!canEditRef.current || viewModeRef.current !== '2d') return false
    if (!edgeAutoPanInteractionActive()) return false
    if (dragIdxRef.current === null && canvasPointersRef.current.size > 0) return false
    if (canvasPinchRef.current) return false
    return true
  }

  function edgeAutoPanVelocity(): { vx: number; vy: number } | null {
    const pointer = edgeAutoPanPointerRef.current
    const svg = svgRef.current
    if (!pointer || !svg) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const pad = EDGE_AUTO_PAN_SCREEN_PX
    const left = pointer.clientX - rect.left
    const right = rect.right - pointer.clientX
    const top = pointer.clientY - rect.top
    const bottom = rect.bottom - pointer.clientY
    const strength = (distance: number) => Math.max(0, Math.min(1, (pad - distance) / pad))
    const sx = left < pad ? -strength(left) : right < pad ? strength(right) : 0
    const sy = top < pad ? -strength(top) : bottom < pad ? strength(bottom) : 0
    if (Math.abs(sx) < 0.001 && Math.abs(sy) < 0.001) return null
    return { vx: sx * EDGE_AUTO_PAN_MAX_PX_PER_SEC, vy: sy * EDGE_AUTO_PAN_MAX_PX_PER_SEC }
  }

  function stopEdgeAutoPan() {
    edgeAutoPanPointerRef.current = null
    edgeAutoPanLastTimeRef.current = 0
    if (edgeAutoPanFrameRef.current !== null) {
      window.cancelAnimationFrame(edgeAutoPanFrameRef.current)
      edgeAutoPanFrameRef.current = null
    }
  }

  function runEdgeAutoPan(time: number) {
    edgeAutoPanFrameRef.current = null
    if (!edgeAutoPanAllowed()) {
      edgeAutoPanLastTimeRef.current = 0
      return
    }
    const velocity = edgeAutoPanVelocity()
    const pointer = edgeAutoPanPointerRef.current
    if (!velocity || !pointer) {
      edgeAutoPanLastTimeRef.current = 0
      return
    }
    const dt = edgeAutoPanLastTimeRef.current
      ? Math.min(0.05, Math.max(0, (time - edgeAutoPanLastTimeRef.current) / 1000))
      : 1 / 60
    edgeAutoPanLastTimeRef.current = time
    const size = canvasSizeRef.current
    const current = canvasViewRef.current
    const nextView = normalizeCanvasView(size, {
      ...current,
      x: current.x + velocity.vx * dt * (current.width / Math.max(1, size.width)),
      y: current.y + velocity.vy * dt * (current.height / Math.max(1, size.height)),
    })
    canvasAutoFitRef.current = false
    canvasViewRef.current = nextView
    setCanvasView(nextView)
    applyPointerMoveAt(pointer.clientX, pointer.clientY, nextView)
    edgeAutoPanFrameRef.current = window.requestAnimationFrame(runEdgeAutoPan)
  }

  function updateEdgeAutoPan(clientX: number, clientY: number) {
    edgeAutoPanPointerRef.current = { clientX, clientY }
    if (!edgeAutoPanAllowed() || !edgeAutoPanVelocity()) {
      if (edgeAutoPanFrameRef.current !== null) stopEdgeAutoPan()
      return
    }
    if (edgeAutoPanFrameRef.current === null) {
      edgeAutoPanLastTimeRef.current = 0
      edgeAutoPanFrameRef.current = window.requestAnimationFrame(runEdgeAutoPan)
    }
  }

  useEffect(() => () => stopEdgeAutoPan(), [])

  const removeMeasurement = (index: number) => {
    const measurements = model.measurements ?? []
    if (!measurements[index]) return
    const nextMeasurements = measurements.filter((_, i) => i !== index)
    const next: SketchModel = { ...model }
    if (nextMeasurements.length > 0) next.measurements = nextMeasurements
    else delete next.measurements
    commit(next)
    setSelectedMeasurementIndex(null)
    setMeasurementDraft(null)
  }

  useEffect(() => {
    if (!canEdit || viewMode !== '2d') return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return
      if (event.key === 'Escape' && tool === 'measure') {
        setTool('wall')
        setMeasurementDraft(null)
        setSelectedMeasurementIndex(null)
        event.preventDefault()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedMeasurementIndex !== null) {
        removeMeasurement(selectedMeasurementIndex)
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canEdit, viewMode, tool, selectedMeasurementIndex, model])

  useEffect(() => {
    if (selectedMeasurementIndex !== null && !model.measurements?.[selectedMeasurementIndex]) {
      setSelectedMeasurementIndex(null)
    }
  }, [model.measurements, selectedMeasurementIndex])

  const handleMove = (e: React.PointerEvent) => {
    if (!canEdit) return
    applyPointerMoveAt(e.clientX, e.clientY)
    updateEdgeAutoPan(e.clientX, e.clientY)
  }

  const handleCanvasPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    stopEdgeAutoPan()
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
        const nextView = normalizeCanvasView(canvasSize, {
          x: anchor.x - ratioX * nextWidth,
          y: anchor.y - ratioY * nextHeight,
          width: nextWidth,
          height: nextHeight,
        })
        canvasAutoFitRef.current = false
        canvasViewRef.current = nextView
        setCanvasView(nextView)
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
        const nextView = normalizeCanvasView(canvasSize, {
          ...pan.view,
          x: pan.view.x - dx * (pan.view.width / Math.max(1, canvasSize.width)),
          y: pan.view.y - dy * (pan.view.height / Math.max(1, canvasSize.height)),
        })
        canvasViewRef.current = nextView
        setCanvasView(nextView)
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
    if (canvasPointersRef.current.size === 0) stopEdgeAutoPan()
    endDragOpening()
  }

  const handleCanvasPointerLeave = () => {
    if (canvasPointersRef.current.size > 0) return
    stopEdgeAutoPan()
    endDragOpening()
    setHover(null)
    setHoverSnapped(false)
  }

  const handleCanvasWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault()
    const factor = Math.exp(Math.max(-0.7, Math.min(0.7, e.deltaY * 0.001)))
    canvasAutoFitRef.current = false
    setCanvasView((view) => {
      const nextView = zoomCanvasAt(e.clientX, e.clientY, factor, view)
      canvasViewRef.current = nextView
      return nextView
    })
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
    dragIdxRef.current = i
    setDragIdx(i)
    edgeAutoPanPointerRef.current = { clientX: e.clientX, clientY: e.clientY }
    updateEdgeAutoPan(e.clientX, e.clientY)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  // Отпускание проёма: фиксируем положение на текущем шаге точности.
  const endDragOpening = () => {
    if (dragIdx === null) return
    stopEdgeAutoPan()
    setModel((m) => {
      const o = m.openings[dragIdx]
      if (!o) return m
      const ends = openingEnds(m, o)
      if (!ends) return m
      const t = snapOpeningT(m, o, o.t, activeSnapFt)
      const nextModel = { ...m, openings: m.openings.map((op, i) => (i === dragIdx ? { ...op, t } : op)) }
      modelRef.current = nextModel
      return nextModel
    })
    dragIdxRef.current = null
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
    // NAV-FIX-2: клик по пустому месту снимает выделение стены (клик по самой стене обрабатывает хит-таргет со stopPropagation).
    if (wallSelectEnabled && selectedWallKey !== null) setSelectedWallKey(null)
    const raw = pointerCell(e)
    if (!raw) return

    if (tool === 'measure') {
      const p = measurementPoint(raw).p
      setShowMeasurements(true)
      setSelectedMeasurementIndex(null)
      if (!measurementDraft) {
        setMeasurementDraft(p)
        return
      }
      if (dist(measurementDraft, p) < 0.01) return
      const nextMeasurement: SketchMeasurement = { id: makeId('measure'), scope: 'plan', a: measurementDraft, b: p }
      commit({ ...model, measurements: [...(model.measurements ?? []), nextMeasurement] })
      setMeasurementDraft(null)
      setSelectedMeasurementIndex((model.measurements ?? []).length)
      return
    }

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

    if (tool !== 'door' && tool !== 'window') return

    // door / window: ставим на ближайший сегмент в пределах порога
    const near = nearestSegment(model, raw)
    if (!near || near.d > SEG_HIT) {
      setError('hub_sketch_no_segment')
      return
    }
    const opening = openingDraftAt(tool, near.c, near.s, near.t)
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
    if (model.contours.length === 0 && model.openings.length === 0 && (model.measurements ?? []).length === 0 && (model.placedItems ?? []).length === 0) return
    setHistory((h) => [...h.slice(-HISTORY_MAX + 1), model])
    canvasAutoFitRef.current = true
    setModel(EMPTY_MODEL)
    setMeasurementDraft(null)
    setSelectedMeasurementIndex(null)
    setStatus(null)
    setError(null)
  }

  const updateWallHeight = (value: number) => {
    const nextHeight = Number.isFinite(value) && value > 0 ? value : DEFAULT_WALL_HEIGHT_FT
    if (model.height !== undefined && Math.abs(wallHeightFt(model) - nextHeight) < 0.001) return
    commit({ ...model, height: nextHeight })
  }

  const applyCabinetLayout = () => {
    if (!selectedCabinetWall) {
      setError('hub_sketch_no_segment')
      return
    }
    const layout = layoutCabinetRunOnWall(model, selectedCabinetWall, cabinetCodes)
    if (layout.items.length === 0) {
      setError(layout.invalidCodes.length > 0 ? 'hub_sketch_cabinet_invalid' : 'hub_sketch_cabinet_empty')
      setStatus(null)
      return
    }
    const wallId = sketchWallKey(selectedCabinetWall.c, selectedCabinetWall.s)
    const keptItems = sanitizePlacedCatalogItems(model.placedItems)
      .filter((item) => !(isCabinetPlacedItem(item) && item.wallId === wallId))
    const next: SketchModel = { ...model, placedItems: [...keptItems, ...layout.items] }
    commit(next)
    setStatus(layout.overflow ? 'hub_sketch_cabinet_overflow' : layout.smallFiller ? 'hub_sketch_cabinet_small_filler' : 'hub_sketch_cabinet_placed')
  }

  const updateModelFrom3D = useCallback((next: SketchModel) => {
    setModel(normalizeSketchModelForStorage(next))
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
      const modelForStorage = normalizeSketchModelForStorage(model)
      const jsonFile = new File([JSON.stringify(modelForStorage)], `${base}.json`)
      const png = await renderPng(modelForStorage, t)
      await uploadProjectFileToR2(profile, project.id, jsonFile)
      if (png) {
        const pngFile = new File([png], `${base}.png`, { type: 'image/png' })
        await uploadProjectFileToR2(profile, project.id, pngFile)
      }
      const cabinetCsv = cabinetScheduleCsv(modelForStorage.placedItems ?? [])
      if (cabinetCsv) {
        const csvFile = new File([cabinetCsv], `${base}-cabinets.csv`, { type: 'text/csv' })
        await uploadProjectFileToR2(profile, project.id, csvFile)
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
          `${t('hub_sketch_contour')} ${i + 1}: ${t('hub_sketch_area')} ${c.area.toFixed(1)} ft² · ${t('hub_sketch_perimeter')} ${fmtFt(c.perimeter)}${c.closed ? '' : ` (${t('hub_sketch_open')})`}`,
        )
      })
      lines.push('')
      lines.push(`${t('hub_sketch_total')}: ${t('hub_sketch_area')} ${stats.totalArea.toFixed(1)} ft² · ${t('hub_sketch_perimeter')} ${fmtFt(stats.totalPerimeter)}`)
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
        openings: sanitizeSketchOpenings(data.openings),
      }
      const finishes = sanitizeSketchFinishes(data.finishes)
      const lights = sanitizeSketchLights(data.lights)
      const switches = sanitizeSketchSwitches(data.switches)
      const measurements = sanitizeSketchMeasurements(data.measurements)
      const placedItems = sanitizePlacedCatalogItems(data.placedItems)
      if (height !== undefined) nextModel.height = height
      if (finishes) nextModel.finishes = finishes
      if (lights.length > 0) nextModel.lights = lights
      if (switches.length > 0) nextModel.switches = switches
      if (measurements.length > 0) nextModel.measurements = measurements
      if (placedItems.length > 0) nextModel.placedItems = placedItems
      setHistory((h) => [...h.slice(-HISTORY_MAX + 1), model])
      canvasAutoFitRef.current = true
      setMeasurementDraft(null)
      setSelectedMeasurementIndex(null)
      setModel(normalizeSketchModelForStorage(nextModel))
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
  // NAV-FIX-2: выбор стены на 2D активен, когда клики не заняты установкой проёмов/замеров и не идёт рисование контура.
  const activeContourOpen = !!activeContour && !activeContour.closed && activeContour.points.length > 0
  const wallSelectEnabled = canEdit && tool !== 'door' && tool !== 'window' && tool !== 'measure' && !activeContourOpen
  const heightFt = wallHeightFt(model)
  const pxPerFt = (canvasSize.width * CELL_PX) / Math.max(1, canvasView.width)
  const gridLines = useMemo(() => canvasGridLines(canvasView, activeSnapFt, pxPerFt), [canvasView, activeSnapFt, pxPerFt])
  const screenWorldPx = canvasView.width / Math.max(1, canvasSize.width)
  const nodeRadius = Math.max(3, Math.min(18, 5 * screenWorldPx))
  const hoverRadius = Math.max(4, Math.min(20, 6 * screenWorldPx))
  const dimFontSize = 12 * screenWorldPx
  const wallDimLines = useMemo(
    () => eachSegment(model).map((seg) => segmentDimLine(model, seg, screenWorldPx)).filter((dim): dim is SegmentDimLine => !!dim),
    [model, screenWorldPx],
  )
  const planMeasurements = useMemo<PlanMeasurementEntry[]>(
    () => (model.measurements ?? [])
      .map((measurement, index) => ({ measurement, index }))
      .filter(({ measurement }) => isPlanMeasurement(measurement)),
    [model.measurements],
  )
  const planMeasurementLines = useMemo(
    () => planMeasurements
      .map((entry) => ({ ...entry, line: planMeasurementLine(model, entry.measurement, screenWorldPx) }))
      .filter((entry): entry is PlanMeasurementEntry & { line: MeasurementLine2D } => !!entry.line),
    [model, planMeasurements, screenWorldPx],
  )
  const codeClearanceChecks = useMemo(
    () => (codeCheckEnabled ? getCodeClearanceChecks(model) : []),
    [model, codeCheckEnabled],
  )
  const codeClearanceViolations = useMemo(
    () => codeClearanceChecks.filter((check) => !check.ok),
    [codeClearanceChecks],
  )
  const codeWarningItemIds = useMemo(() => codeClearanceItemIds(codeClearanceViolations), [codeClearanceViolations])
  const planItems = useMemo(() => planPlacedItems(model, codeWarningItemIds), [model, codeWarningItemIds])
  const planCodeClearanceLines = useMemo(
    () => codeClearanceChecks
      .map((check) => planCodeClearanceLine(model, check, t, screenWorldPx))
      .filter((line): line is PlanCodeClearanceLine => !!line),
    [codeClearanceChecks, model, screenWorldPx, t],
  )
  const planCodeClearanceArcs = useMemo(
    () => codeClearanceChecks
      .filter((check) => !check.ok)
      .map((check) => planCodeClearanceArc(model, check))
      .filter((arc): arc is PlanCodeClearanceArc => !!arc),
    [codeClearanceChecks, model],
  )
  const measurePreview = measurementDraft && hover
    ? planMeasurementLine(model, { a: measurementDraft, b: hover, scope: 'plan' }, screenWorldPx)
    : null
  const openingPreview = canEdit && viewMode === '2d' && hover && (tool === 'door' || tool === 'window')
    ? (() => {
        const near = nearestSegment(model, hover)
        if (!near || near.d > SEG_HIT) return null
        return openingDraftAt(tool, near.c, near.s, near.t)
      })()
    : null
  const openingPreviewDimLabel = openingPreview ? openingDimLabel(model, openingPreview, model.openings.length, t, screenWorldPx) : null
  const openingPreviewClearanceLines = openingPreview ? openingClearanceDimLines(model, openingPreview, null, t, screenWorldPx) : []
  const dragOpeningClearanceLines = dragIdx !== null && model.openings[dragIdx]
    ? openingClearanceDimLines(model, model.openings[dragIdx], dragIdx, t, screenWorldPx)
    : []

  const renderDimLine2D = (dim: DimLine2D, key: string, className: string, fontScale = 10.5) => (
    <g key={key} className={className}>
      <line className="hub-sketch-dim-extension" x1={dim.ext1x1} y1={dim.ext1y1} x2={dim.ext1x2} y2={dim.ext1y2} />
      <line className="hub-sketch-dim-extension" x1={dim.ext2x1} y1={dim.ext2y1} x2={dim.ext2x2} y2={dim.ext2y2} />
      <line className="hub-sketch-dim-main" x1={dim.x1} y1={dim.y1} x2={dim.x2} y2={dim.y2} />
      <line className="hub-sketch-dim-tick" x1={dim.tick1x1} y1={dim.tick1y1} x2={dim.tick1x2} y2={dim.tick1y2} />
      <line className="hub-sketch-dim-tick" x1={dim.tick2x1} y1={dim.tick2y1} x2={dim.tick2x2} y2={dim.tick2y2} />
      <text
        className="hub-sketch-dim-label"
        x={dim.labelX}
        y={dim.labelY}
        textAnchor="middle"
        dominantBaseline="central"
        style={{ fontSize: fontScale * screenWorldPx }}
        transform={`rotate(${dim.angle} ${dim.labelX} ${dim.labelY})`}
      >
        {dim.text}
      </text>
    </g>
  )

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
                setMeasurementDraft(null)
                setSelectedMeasurementIndex(null)
                setViewMode(mode)
              }}
            >
              {t(mode === '2d' ? 'hub_sketch_view_2d' : 'hub_sketch_view_3d')}
            </button>
          ))}
        </div>
        <label className="hub-sketch-layer-toggle hub-sketch-code-toggle">
          <input
            type="checkbox"
            checked={codeCheckEnabled}
            onChange={(event) => setCodeCheckEnabled(event.target.checked)}
          />
          <span>{t('hub_sketch_code_check')}</span>
        </label>
        {lengthInput('wallHeight', 'hub_sketch_wall_height', heightFt, 1, 30, updateWallHeight, 'hub-sketch-height-field')}
      </div>

      {canEdit && viewMode === '2d' && (
        <div className="card hub-sketch-toolbar">
          <div className="hub-sketch-tools">
            {(['wall', 'door', 'window', 'measure', 'cabinet'] as Tool[]).map((tl) => (
              <button
                key={tl}
                type="button"
                className={tool === tl ? 'btn small' : 'btn ghost small'}
                aria-pressed={tool === tl}
                onClick={() => {
                  setSelectedMeasurementIndex(null)
                  if (tl === 'measure') {
                    setTool((current) => (current === 'measure' ? 'wall' : 'measure'))
                    setMeasurementDraft(null)
                    setShowMeasurements(true)
                    return
                  }
                  setTool(tl)
                  setMeasurementDraft(null)
                }}
              >
                {tl === 'measure' && <span aria-hidden="true">📏</span>}
                {tl === 'cabinet' && <span aria-hidden="true">▣</span>}
                <span>{t(`hub_sketch_tool_${tl}`)}</span>
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
          <div className="hub-sketch-snap" role="group" aria-label={t('hub_sketch_snap')}>
            <span className="muted">{t('hub_sketch_snap')}</span>
            {SNAP_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                className={snapMode === option.mode ? 'btn small' : 'btn ghost small'}
                aria-pressed={snapMode === option.mode}
                onClick={() => setSnapMode(option.mode)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
          <label className="hub-sketch-layer-toggle">
            <input
              type="checkbox"
              checked={showMeasurements}
              onChange={(e) => {
                setShowMeasurements(e.target.checked)
                if (!e.target.checked) setSelectedMeasurementIndex(null)
              }}
            />
            <span>{t('hub_sketch_measurements')}</span>
          </label>
          {tool === 'door' && (
            <div className="hub-sketch-dims">
              {lengthInput('doorW', 'hub_sketch_width', doorW, 0.5, 20, setDoorW)}
              {lengthInput('doorH', 'hub_sketch_height', doorH, 0.5, 20, setDoorH)}
              <div className="hub-sketch-preset-row" role="group" aria-label={t('hub_sketch_width')}>
                {DOOR_WIDTH_PRESETS_FT.map((value) => presetButton(value, setDoorW))}
              </div>
              <div className="hub-sketch-preset-row" role="group" aria-label={t('hub_sketch_bifold')}>
                {BIFOLD_DOOR_WIDTH_PRESETS_FT.map((value) => bifoldPresetButton(value))}
              </div>
            </div>
          )}
          {tool === 'window' && (
            <div className="hub-sketch-dims">
              {lengthInput('winW', 'hub_sketch_width', winW, 0.5, 20, setWinW)}
              {lengthInput('winH', 'hub_sketch_height', winH, 0.5, 20, setWinH)}
              {lengthInput('winSill', 'hub_sketch_sill', winSill, 0, 20, setWinSill)}
              <div className="hub-sketch-preset-row" role="group" aria-label={t('hub_sketch_width')}>
                {WINDOW_WIDTH_PRESETS_FT.map((value) => presetButton(value, setWinW))}
              </div>
            </div>
          )}
          {tool === 'cabinet' && (
            <div className="hub-sketch-cabinet-tools">
              <label className="hub-sketch-field hub-sketch-cabinet-wall-select">
                <span className="muted">{t('hub_sketch_cabinet_wall')}</span>
                <select
                  value={effectiveCabinetWallKey ?? ''}
                  onChange={(event) => setSelectedCabinetWallKey(event.target.value || null)}
                  disabled={cabinetWallOptions.length === 0}
                >
                  {cabinetWallOptions.length === 0 && <option value="">{t('hub_sketch_no_segment')}</option>}
                  {cabinetWallOptions.map((seg, index) => {
                    const key = sketchWallKey(seg.c, seg.s)
                    return (
                      <option key={key} value={key}>
                        {`${t('hub_sketch_3d_wall')} ${index + 1} · ${fmtFt(dist(seg.a, seg.b) * modelCellFt(model))}`}
                      </option>
                    )
                  })}
                </select>
              </label>
              <textarea
                className="hub-sketch-cabinet-code-input"
                value={cabinetCodes}
                onChange={(event) => setCabinetCodes(event.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="B30 2DB27 W3030 BEP24-3/4 BF3"
              />
              <div className="hub-sketch-cabinet-actions">
                <button type="button" className="btn small" disabled={!selectedCabinetWall || !cabinetCodes.trim()} onClick={applyCabinetLayout}>
                  {t('hub_sketch_cabinet_apply')}
                </button>
                {cabinetLayoutPreview && (
                  <span className={cabinetLayoutPreview.overflow || cabinetLayoutPreview.smallFiller || cabinetLayoutPreview.invalidCodes.length > 0 ? 'hub-sketch-cabinet-summary hub-sketch-cabinet-summary-warn' : 'hub-sketch-cabinet-summary'}>
                    {`${cabinetLayoutPreview.parsed.length} · ${t('hub_sketch_dim_length_short')} ${formatInches(cabinetLayoutPreview.wallLengthIn)}`}
                    {cabinetLayoutPreview.summaries.map((summary) => ` · ${t(summary.layer === 'base' ? 'hub_sketch_cabinet_base' : 'hub_sketch_cabinet_wall_layer')} ${formatInches(summary.totalWidthIn)}${summary.fillerWidthIn > 0 ? ` + ${formatInches(summary.fillerWidthIn)}` : ''}`).join('')}
                  </span>
                )}
              </div>
              {cabinetLayoutPreview && cabinetLayoutPreview.invalidCodes.length > 0 && (
                <div className="error-msg hub-sketch-cabinet-warning">
                  {`${t('hub_sketch_cabinet_invalid')}: ${cabinetLayoutPreview.invalidCodes.join(', ')}`}
                </div>
              )}
              {cabinetLayoutPreview?.overflow && <div className="error-msg hub-sketch-cabinet-warning">{t('hub_sketch_cabinet_overflow')}</div>}
              {cabinetLayoutPreview?.smallFiller && <div className="error-msg hub-sketch-cabinet-warning">{t('hub_sketch_cabinet_small_filler')}</div>}
            </div>
          )}
        </div>
      )}

      <div className="card hub-sketch-canvas-card">
        {viewMode === '2d' ? (
          <>
            <div
              ref={svgShellRef}
              className={canvasFullscreenActive ? 'hub-sketch-svg-shell hub-sketch-svg-shell-fullscreen' : 'hub-sketch-svg-shell'}
            >
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
          <defs>
            <marker id="hub-sketch-measure-arrow" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#047857" />
            </marker>
          </defs>
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

          {/* NAV-FIX-2: выбор стены на 2D — подсветка выбранной + невидимые хит-таргеты по сегментам */}
          {cabinetWallOptions.map((seg) => {
            const key = sketchWallKey(seg.c, seg.s)
            const x1 = seg.a.x * CELL_PX
            const y1 = seg.a.y * CELL_PX
            const x2 = seg.b.x * CELL_PX
            const y2 = seg.b.y * CELL_PX
            const selected = selectedWallKey === key
            return (
              <g key={`ws-${key}`}>
                {selected && <line className="hub-sketch-wall-selected" x1={x1} y1={y1} x2={x2} y2={y2} />}
                {wallSelectEnabled && (
                  <line
                    className="hub-sketch-wall-hit"
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    onClick={(event) => {
                      event.stopPropagation()
                      setSelectedWallKey((current) => (current === key ? null : key))
                    }}
                  />
                )}
              </g>
            )
          })}

          {/* размерные линии стен */}
          {wallDimLines.map((dim, i) => {
            return (
              <g key={`l${i}`} className="hub-sketch-dim-line">
                <line className="hub-sketch-dim-extension" x1={dim.ext1x1} y1={dim.ext1y1} x2={dim.ext1x2} y2={dim.ext1y2} />
                <line className="hub-sketch-dim-extension" x1={dim.ext2x1} y1={dim.ext2y1} x2={dim.ext2x2} y2={dim.ext2y2} />
                <line className="hub-sketch-dim-main" x1={dim.x1} y1={dim.y1} x2={dim.x2} y2={dim.y2} />
                <line className="hub-sketch-dim-tick" x1={dim.tick1x1} y1={dim.tick1y1} x2={dim.tick1x2} y2={dim.tick1y2} />
                <line className="hub-sketch-dim-tick" x1={dim.tick2x1} y1={dim.tick2y1} x2={dim.tick2x2} y2={dim.tick2y2} />
                <text
                  className="hub-sketch-dim-label"
                  x={dim.labelX}
                  y={dim.labelY}
                  textAnchor="middle"
                  dominantBaseline="central"
                  style={{ fontSize: dimFontSize }}
                  transform={`rotate(${dim.angle} ${dim.labelX} ${dim.labelY})`}
                >
                  {dim.text}
                </text>
              </g>
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
            const dimLabel = openingDimLabel(model, o, i, t, screenWorldPx)
            return (
              <g
                key={`o${i}`}
                className={canEdit && tool !== 'measure' ? 'hub-sketch-opening' : undefined}
                onPointerDown={canEdit && tool !== 'measure' ? startDragOpening(i) : undefined}
              >
                <line className={cls} x1={x1} y1={y1} x2={x2} y2={y2} />
                {/* невидимый широкий хит-таргет для захвата пальцем */}
                <line className="hub-sketch-opening-hit" x1={x1} y1={y1} x2={x2} y2={y2} />
                {dimLabel && (
                  <g className={`hub-sketch-opening-dim hub-sketch-opening-dim-${dimLabel.kind}`}>
                    <line className="hub-sketch-dim-extension" x1={dimLabel.ext1x1} y1={dimLabel.ext1y1} x2={dimLabel.ext1x2} y2={dimLabel.ext1y2} />
                    <line className="hub-sketch-dim-extension" x1={dimLabel.ext2x1} y1={dimLabel.ext2y1} x2={dimLabel.ext2x2} y2={dimLabel.ext2y2} />
                    <line className="hub-sketch-dim-main" x1={dimLabel.x1} y1={dimLabel.y1} x2={dimLabel.x2} y2={dimLabel.y2} />
                    <line className="hub-sketch-dim-tick" x1={dimLabel.tick1x1} y1={dimLabel.tick1y1} x2={dimLabel.tick1x2} y2={dimLabel.tick1y2} />
                    <line className="hub-sketch-dim-tick" x1={dimLabel.tick2x1} y1={dimLabel.tick2y1} x2={dimLabel.tick2x2} y2={dimLabel.tick2y2} />
                    <text
                      className="hub-sketch-dim-label"
                      x={dimLabel.labelX}
                      y={dimLabel.labelY}
                      textAnchor="middle"
                      dominantBaseline="central"
                      style={{ fontSize: 10.5 * screenWorldPx }}
                      transform={`rotate(${dimLabel.angle} ${dimLabel.labelX} ${dimLabel.labelY})`}
                    >
                      {dimLabel.text}
                    </text>
                  </g>
                )}
              </g>
            )
          })}

          {openingPreview &&
            (() => {
              const span = openingSpan2D(model, openingPreview)
              if (!span) return null
              const cls = openingPreview.kind === 'door' ? 'hub-sketch-door' : 'hub-sketch-window'
              return (
                <g className="hub-sketch-opening-preview">
                  <line
                    className={cls}
                    x1={span.leftEdge.x * CELL_PX}
                    y1={span.leftEdge.y * CELL_PX}
                    x2={span.rightEdge.x * CELL_PX}
                    y2={span.rightEdge.y * CELL_PX}
                  />
                </g>
              )
            })()}

          {openingPreviewDimLabel && renderDimLine2D(
            openingPreviewDimLabel,
            'opening-preview-size',
            `hub-sketch-opening-dim hub-sketch-opening-dim-${openingPreviewDimLabel.kind} hub-sketch-opening-dim-active`,
          )}

          {openingPreviewClearanceLines.map((dim, index) => renderDimLine2D(
            dim,
            `opening-preview-clearance-${index}`,
            'hub-sketch-opening-clearance-dim hub-sketch-opening-clearance-dim-active',
          ))}

          {dragOpeningClearanceLines.map((dim, index) => renderDimLine2D(
            dim,
            `opening-drag-clearance-${index}`,
            'hub-sketch-opening-clearance-dim hub-sketch-opening-clearance-dim-active',
          ))}

          {planItems.map((entry) => {
            const className = `hub-sketch-plan-item${entry.warning ? ' hub-sketch-plan-item-warn' : ''}${entry.toilet ? ' hub-sketch-plan-toilet' : ''}${entry.showerPan ? ' hub-sketch-plan-shower' : ''}${entry.cabinet ? ' hub-sketch-plan-cabinet' : ''}${entry.layer === 'wall' ? ' hub-sketch-plan-cabinet-wall' : ''}${entry.filler ? ' hub-sketch-plan-cabinet-filler' : ''}`
            const labelFontSize = Math.max(5 * screenWorldPx, Math.min(11 * screenWorldPx, entry.width / Math.max(4, entry.cabinetCode.length * 0.6)))
            return (
              <g
                key={`pi-${entry.item.id}`}
                className={className}
                transform={`translate(${entry.x} ${entry.y}) rotate(${entry.angle})`}
              >
                <title>{entry.item.name ?? (entry.toilet ? t('hub_sketch_toilet') : entry.cabinet ? entry.cabinetCode : t('hub_sketch_code_target_item'))}</title>
                {entry.toilet ? (
                  <>
                    <rect
                      className="hub-sketch-plan-toilet-tank"
                      x={-entry.width * 0.44}
                      y={-entry.depth * 0.46}
                      width={entry.width * 0.88}
                      height={entry.depth * 0.22}
                      rx={Math.max(1.5, entry.width * 0.08)}
                    />
                    <ellipse
                      className="hub-sketch-plan-toilet-bowl"
                      cx={0}
                      cy={entry.depth * 0.1}
                      rx={entry.width * 0.36}
                      ry={entry.depth * 0.28}
                    />
                    <ellipse
                      className="hub-sketch-plan-toilet-seat"
                      cx={0}
                      cy={entry.depth * 0.1}
                      rx={entry.width * 0.22}
                      ry={entry.depth * 0.17}
                    />
                    <line className="hub-sketch-plan-toilet-axis" x1={0} y1={-entry.depth * 0.48} x2={0} y2={entry.depth * 0.5} />
                  </>
                ) : entry.showerPan ? (
                  <>
                    {entry.showerPanShape === 'neo-angle' ? (
                      <path d={`M ${-entry.width / 2} ${-entry.depth / 2} H ${entry.width / 2} V ${entry.depth * 0.12} L ${entry.width * 0.12} ${entry.depth / 2} H ${-entry.width / 2} Z`} />
                    ) : (
                      <rect x={-entry.width / 2} y={-entry.depth / 2} width={entry.width} height={entry.depth} rx={Math.min(5, entry.width * 0.04, entry.depth * 0.04)} />
                    )}
                    <line className="hub-sketch-plan-shower-rim" x1={-entry.width * 0.38} y1={0} x2={entry.width * 0.38} y2={0} />
                  </>
                ) : entry.cabinet ? (
                  <>
                    <rect x={-entry.width / 2} y={-entry.depth / 2} width={entry.width} height={entry.depth} rx={Math.min(3 * screenWorldPx, entry.width * 0.04, entry.depth * 0.04)} />
                    <line className="hub-sketch-plan-cabinet-front" x1={-entry.width / 2} y1={entry.depth / 2 - Math.max(2 * screenWorldPx, entry.depth * 0.12)} x2={entry.width / 2} y2={entry.depth / 2 - Math.max(2 * screenWorldPx, entry.depth * 0.12)} />
                    {entry.filler && (
                      <path className="hub-sketch-plan-cabinet-fill-mark" d={`M ${-entry.width / 2} ${-entry.depth / 2} L ${entry.width / 2} ${entry.depth / 2} M ${entry.width / 2} ${-entry.depth / 2} L ${-entry.width / 2} ${entry.depth / 2}`} />
                    )}
                    {entry.cabinetCode && (
                      <text
                        className="hub-sketch-plan-cabinet-label"
                        x={0}
                        y={0}
                        textAnchor="middle"
                        dominantBaseline="central"
                        style={{ fontSize: labelFontSize }}
                      >
                        {entry.cabinetCode}
                      </text>
                    )}
                  </>
                ) : (
                  <rect x={-entry.width / 2} y={-entry.depth / 2} width={entry.width} height={entry.depth} rx={Math.min(5, entry.width * 0.08, entry.depth * 0.08)} />
                )}
              </g>
            )
          })}

          {codeCheckEnabled && planCodeClearanceArcs.map((arc) => (
            <path
              key={`ca-${arc.id}`}
              className={arc.warning ? 'hub-sketch-code-arc hub-sketch-code-arc-warn' : 'hub-sketch-code-arc'}
              d={arc.d}
            />
          ))}

          {codeCheckEnabled && planCodeClearanceLines.map((line) => (
            <g
              key={`cl-${line.id}`}
              className={line.warning ? 'hub-sketch-code-clearance hub-sketch-code-clearance-warn' : 'hub-sketch-code-clearance'}
            >
              <line className="hub-sketch-code-clearance-line" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
              <circle className="hub-sketch-code-clearance-dot" cx={line.x1} cy={line.y1} r={Math.max(2.2, 2.8 * screenWorldPx)} />
              <circle className="hub-sketch-code-clearance-dot" cx={line.x2} cy={line.y2} r={Math.max(2.2, 2.8 * screenWorldPx)} />
              <text
                className="hub-sketch-code-clearance-label"
                x={line.labelX}
                y={line.labelY}
                textAnchor="middle"
                dominantBaseline="central"
                style={{ fontSize: (line.warning ? 12.5 : 11) * screenWorldPx }}
                transform={`rotate(${line.angle} ${line.labelX} ${line.labelY})`}
              >
                {line.text}
              </text>
            </g>
          ))}

          {showMeasurements &&
            planMeasurementLines.map(({ index, line }) => {
              const selected = selectedMeasurementIndex === index
              const deleteSize = 18 * screenWorldPx
              const deleteX = line.labelX + 36 * screenWorldPx
              const deleteY = line.labelY - 1 * screenWorldPx
              return (
                <g
                  key={`m${index}`}
                  className={selected ? 'hub-sketch-measurement hub-sketch-measurement-selected' : 'hub-sketch-measurement'}
                  onClick={(event) => {
                    if (!canEdit) return
                    event.stopPropagation()
                    setSelectedMeasurementIndex(index)
                    setMeasurementDraft(null)
                  }}
                >
                  <line
                    className="hub-sketch-measurement-line"
                    x1={line.x1}
                    y1={line.y1}
                    x2={line.x2}
                    y2={line.y2}
                    markerStart="url(#hub-sketch-measure-arrow)"
                    markerEnd="url(#hub-sketch-measure-arrow)"
                  />
                  <line className="hub-sketch-measurement-hit" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
                  <text
                    className="hub-sketch-measurement-label"
                    x={line.labelX}
                    y={line.labelY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    style={{ fontSize: dimFontSize }}
                    transform={`rotate(${line.angle} ${line.labelX} ${line.labelY})`}
                  >
                    {line.text}
                  </text>
                  {selected && (
                    <g
                      className="hub-sketch-measurement-delete"
                      role="button"
                      tabIndex={0}
                      aria-label={t('hub_sketch_measurement_delete')}
                      onClick={(event) => {
                        event.stopPropagation()
                        removeMeasurement(index)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        event.stopPropagation()
                        removeMeasurement(index)
                      }}
                    >
                      <rect x={deleteX - deleteSize / 2} y={deleteY - deleteSize / 2} width={deleteSize} height={deleteSize} rx={3 * screenWorldPx} />
                      <text x={deleteX} y={deleteY} textAnchor="middle" dominantBaseline="central" style={{ fontSize: 13 * screenWorldPx }}>
                        ×
                      </text>
                    </g>
                  )}
                </g>
              )
            })}

          {showMeasurements && canEdit && tool === 'measure' && measurePreview && (
            <g className="hub-sketch-measurement hub-sketch-measurement-preview">
              <line
                className="hub-sketch-measurement-line"
                x1={measurePreview.x1}
                y1={measurePreview.y1}
                x2={measurePreview.x2}
                y2={measurePreview.y2}
                markerStart="url(#hub-sketch-measure-arrow)"
                markerEnd="url(#hub-sketch-measure-arrow)"
              />
              <text
                className="hub-sketch-measurement-label"
                x={measurePreview.labelX}
                y={measurePreview.labelY}
                textAnchor="middle"
                dominantBaseline="central"
                style={{ fontSize: dimFontSize }}
                transform={`rotate(${measurePreview.angle} ${measurePreview.labelX} ${measurePreview.labelY})`}
              >
                {measurePreview.text}
              </text>
            </g>
          )}

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
                    {fmtFt(dist(last, hover) * modelCellFt(model))}
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
              const sizeTxt = `${t('hub_sketch_dim_size_short')} ${formatOpeningFt(openingWidthFt(o))}×${formatOpeningFt(openingHeightFt(o))}`
              const floorTxt = o.kind === 'window' ? ` · ${t('hub_sketch_dim_floor_short')} ${formatOpeningFt(openingFloorFt(o))}` : ''
              return (
                <text className="hub-sketch-drag-dim" x={px} y={py - 12} textAnchor="middle">
                  {`${sizeTxt} · ${t('hub_sketch_dim_left_short')} ${formatOpeningFt(left)} · ${t('hub_sketch_dim_right_short')} ${formatOpeningFt(right)}${floorTxt}`}
                </text>
              )
            })()}

          {/* превью курсора */}
          {canEdit && hover && (tool === 'wall' || tool === 'measure') && (
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
                <button type="button" className="btn ghost small" aria-pressed={canvasFullscreenActive} onClick={toggleCanvasFullscreen}>
                  {t(canvasFullscreenActive ? 'hub_sketch_3d_fullscreen_exit' : 'hub_sketch_3d_fullscreen')}
                </button>
              </div>
            </div>
            <p className="muted hub-sketch-scale">{t('hub_sketch_scale_note')}</p>
          </>
        ) : (
          <Sketch3DView
            model={model}
            heightFt={heightFt}
            project={project}
            profile={profile}
            sketchName={name}
            canEdit={canEdit}
            onModelChange={updateModelFrom3D}
            snapStepFt={activeSnapFt}
            openingDefaults={openingDefaults}
            codeCheckEnabled={codeCheckEnabled}
            pickedWallKey={selectedWallKey}
            onPickWall={setSelectedWallKey}
            label={t('hub_sketch_3d_label')}
            loadingLabel={t('hub_sketch_3d_loading')}
            errorLabel={t('hub_sketch_3d_error')}
          />
        )}
      </div>

      {/* NAV-FIX-2: панель «Стена N» — общая для 2D и 3D; только навигация в существующие режимы */}
      {selectedWall && (
        <div className="card hub-sketch-wall-panel">
          <div className="hub-sketch-wall-panel-head">
            <h3>{`${t('hub_sketch_wall_panel_title')} ${selectedWall.index + 1}`}</h3>
            <button
              type="button"
              className="btn ghost small"
              aria-label={t('hub_sketch_wall_panel_close')}
              onClick={() => setSelectedWallKey(null)}
            >
              ×
            </button>
          </div>
          <div className="hub-sketch-wall-panel-facts">
            <span className="muted">{t('hub_sketch_dim_length_short')}</span>
            <span className="hub-sketch-stat-value">{fmtFt(selectedWall.lengthFt)}</span>
            <span className="muted">{t('hub_sketch_wall_height')}</span>
            <span className="hub-sketch-stat-value">{fmtFt(heightFt)}</span>
            <span className="muted">{t('hub_sketch_wall_panel_finish')}</span>
            <span className="hub-sketch-wall-panel-finish">
              {selectedWallFinish?.color && (
                <span className="hub-sketch-wall-panel-swatch" style={{ backgroundColor: selectedWallFinish.color }} aria-hidden="true" />
              )}
              {t(selectedWallFinish?.kind === 'tile' ? 'hub_sketch_3d_tile' : selectedWallFinish?.kind === 'drywall-patch' ? 'hub_sketch_3d_drywall_patch' : 'hub_sketch_3d_paint')}
              {selectedWallFinish && !selectedWallFinish.overridden ? ` · ${t('hub_sketch_wall_panel_finish_default')}` : ''}
            </span>
          </div>
          {canEdit && (
            <div className="hub-sketch-wall-panel-actions">
              <button type="button" className="btn small" onClick={openWallFinish}>
                {t('hub_sketch_wall_panel_finish_action')}
              </button>
              <button type="button" className="btn ghost small" onClick={openWallOpenings}>
                {t('hub_sketch_wall_panel_openings')}
              </button>
              <button type="button" className="btn ghost small" onClick={openWallCabinets}>
                {t('hub_sketch_wall_panel_cabinets')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* сводка */}
      <div className="card hub-sketch-stats">
        <div className="hub-sketch-stat">
          <span className="muted">{t('hub_sketch_area')}</span>
          <span className="hub-sketch-stat-value">{stats.totalArea.toFixed(1)} ft²</span>
        </div>
        <div className="hub-sketch-stat">
          <span className="muted">{t('hub_sketch_perimeter')}</span>
          <span className="hub-sketch-stat-value">{fmtFt(stats.totalPerimeter)}</span>
        </div>
        <div className="hub-sketch-stat">
          <span className="muted">{t('hub_sketch_contours')}</span>
          <span className="hub-sketch-stat-value">{model.contours.filter((c) => c.points.length >= 2).length}</span>
        </div>
        <div className="hub-sketch-stat">
          <span className="muted">{t('hub_sketch_code_check')}</span>
          <span className={codeCheckEnabled && codeClearanceViolations.length > 0 ? 'hub-sketch-stat-value hub-sketch-code-stat-warn' : 'hub-sketch-stat-value hub-sketch-code-stat-ok'}>
            {codeCheckEnabled
              ? codeClearanceViolations.length > 0
                ? t('hub_sketch_code_issues').replace('{n}', String(codeClearanceViolations.length))
                : t('hub_sketch_code_ok')
              : t('hub_sketch_code_off')}
          </span>
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
