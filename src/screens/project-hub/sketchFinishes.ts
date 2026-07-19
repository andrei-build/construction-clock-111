import { snapOpeningFeetToPrecision } from './inches'

export type Pt = { x: number; y: number }
export type Contour = { points: Pt[]; closed: boolean; label?: string }
export type Opening = {
  kind: 'door' | 'window'
  c: number
  s: number
  t: number
  w?: number
  h?: number
  sill?: number
}

export const DEFAULT_DOOR_WIDTH_IN = 32
export const DEFAULT_DOOR_HEIGHT_IN = 80
export const DEFAULT_WINDOW_WIDTH_IN = 36
export const DEFAULT_WINDOW_HEIGHT_IN = 48
export const DEFAULT_WINDOW_SILL_IN = 36

export const DEFAULT_DOOR_WIDTH_FT = DEFAULT_DOOR_WIDTH_IN / 12
export const DEFAULT_DOOR_HEIGHT_FT = DEFAULT_DOOR_HEIGHT_IN / 12
export const DEFAULT_WINDOW_WIDTH_FT = DEFAULT_WINDOW_WIDTH_IN / 12
export const DEFAULT_WINDOW_HEIGHT_FT = DEFAULT_WINDOW_HEIGHT_IN / 12
export const DEFAULT_WINDOW_SILL_FT = DEFAULT_WINDOW_SILL_IN / 12

export const DOOR_WIDTH_PRESETS_IN = [24, 28, 30, 32, 36]
export const BIFOLD_DOOR_WIDTH_PRESETS_IN = [48, 60, 72]
export const WINDOW_WIDTH_PRESETS_IN = [24, 36, 48, 60, 72]

export const DOOR_WIDTH_PRESETS_FT = DOOR_WIDTH_PRESETS_IN.map((value) => value / 12)
export const BIFOLD_DOOR_WIDTH_PRESETS_FT = BIFOLD_DOOR_WIDTH_PRESETS_IN.map((value) => value / 12)
export const WINDOW_WIDTH_PRESETS_FT = WINDOW_WIDTH_PRESETS_IN.map((value) => value / 12)

export const OPENING_DEFAULTS_FT = {
  doorW: DEFAULT_DOOR_WIDTH_FT,
  doorH: DEFAULT_DOOR_HEIGHT_FT,
  winW: DEFAULT_WINDOW_WIDTH_FT,
  winH: DEFAULT_WINDOW_HEIGHT_FT,
  winSill: DEFAULT_WINDOW_SILL_FT,
}

export type SketchMeasurementPoint = {
  x: number
  y: number
  z?: number
}

export type SketchMeasurement = {
  id?: string
  scope?: 'plan' | 'wall' | 'space'
  wallKey?: string
  a: SketchMeasurementPoint
  b: SketchMeasurementPoint
}

export type SketchFinishRegion = {
  id?: string
  x0Ft: number
  y0Ft: number
  x1Ft: number
  y1Ft: number
}

export type SketchFinishCoverage = {
  mode?: 'full' | 'partial'
  bottomFt?: number
  heightFt?: number
  regions?: SketchFinishRegion[]
}

export type SketchTileFinish = {
  kind: 'tile'
  tileWIn?: number
  tileHIn?: number
  groutIn?: number
  groutColor?: string
  tileColor?: string
  offsetXIn?: number
  offsetYIn?: number
  catalogItemId?: string
  catalogItemName?: string
  catalogPhotoPath?: string
  coverage?: SketchFinishCoverage
}

export type SketchPaintFinish = {
  kind: 'paint'
  color?: string
  coverage?: SketchFinishCoverage
}

export type SketchDrywallPatchFinish = {
  kind: 'drywall-patch'
  baseColor?: string
  patchColor?: string
  xFt?: number
  yFt?: number
  widthFt?: number
  heightFt?: number
  coverage?: SketchFinishCoverage
}

export type SketchSurfaceFinish = SketchPaintFinish | SketchTileFinish | SketchDrywallPatchFinish

export type SketchFinishes = {
  walls?: SketchSurfaceFinish
  floor?: SketchSurfaceFinish
  ceiling?: SketchSurfaceFinish
  wallPaint?: string
  wallFinishes?: Record<string, SketchSurfaceFinish>
}

export type SketchLightKind = 'recessed' | 'chandelier' | 'fan' | 'sconce'

export type SketchLight = {
  id: string
  kind: SketchLightKind
  name?: string
  xFt?: number
  zFt?: number
  c?: number
  s?: number
  t?: number
  heightFt?: number
}

export type SketchSwitch = {
  id: string
  c: number
  s: number
  t: number
  heightFt?: number
  controls?: string[]
  label?: string
}

export type Sketch3DModel = {
  version: 1
  cellFt: number
  height?: number
  contours: Contour[]
  openings: Opening[]
  measurements?: SketchMeasurement[]
  finishes?: SketchFinishes
  lights?: SketchLight[]
  switches?: SketchSwitch[]
}

export type SketchGeometryPlacedItem = {
  c?: number
  s?: number
  t?: number
  xFt: number
  zFt: number
  rotationY: number
}

export type SketchSegmentRef = { c: number; s: number }
export type SketchSegmentResizeAnchor = 'start' | 'end'
export type SketchSegmentResizeConflictReason = 'invalid-segment' | 'invalid-length' | 'degenerate' | 'self-intersection'
export type SketchSegmentResizeConflict = {
  reason: SketchSegmentResizeConflictReason
  segments: SketchSegmentRef[]
}
export type SketchSegmentResizeResult<T extends Sketch3DModel & { placedItems?: SketchGeometryPlacedItem[] }> =
  | { ok: true; model: T; changedSegments: SketchSegmentRef[] }
  | { ok: false; conflict: SketchSegmentResizeConflict }

export const DEFAULT_WALL_PAINT = '#e7ebf0'
export const DEFAULT_FLOOR_PAINT = '#b9bfc8'
export const DEFAULT_TILE_COLOR = '#d8dde5'
export const DEFAULT_GROUT_COLOR = '#56616f'
export const DEFAULT_GROUT_IN = 0.125
export const DEFAULT_DRYWALL_PATCH_COLOR = '#f8fafc'
export const DEFAULT_DRYWALL_PATCH_WIDTH_FT = 4
export const DEFAULT_DRYWALL_PATCH_HEIGHT_FT = 3

export const TILE_SIZE_OPTIONS = [
  { key: '12x24', w: 12, h: 24, label: '12 x 24 in' },
  { key: '24x24', w: 24, h: 24, label: '24 x 24 in' },
  { key: '12x12', w: 12, h: 12, label: '12 x 12 in' },
]

export const WALL_PAINT_SWATCHES = ['#f4f1ea', '#e7ebf0', '#dbe7df', '#e9ded3', '#d7e1ea', '#f1e3e0']

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i
const WALL_FINISH_KEY_RE = /^\d+:\d+$/
const tilePatternCanvasCache = new Map<string, HTMLCanvasElement>()
const MAX_FINISH_REGIONS = 200
const MIN_FINISH_REGION_SIZE_FT = 1 / 96
const LEGACY_FINISH_BAND_WIDTH_FT = 200

export function sketchWallKey(c: number, s: number): string {
  return `${c}:${s}`
}

const SKETCH_GEOMETRY_EPS = 0.000001
const MIN_SKETCH_SEGMENT_LENGTH_FT = 1 / 192

function sketchModelCellFt(model: Pick<Sketch3DModel, 'cellFt'>): number {
  return Number.isFinite(model.cellFt) && model.cellFt > 0 ? model.cellFt : 1
}

function pointDistance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function segmentPointIndexes(contour: Contour, segmentIndex: number): { start: number; end: number } | null {
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) return null
  if (segmentIndex < contour.points.length - 1) return { start: segmentIndex, end: segmentIndex + 1 }
  if (contour.closed && contour.points.length >= 3 && segmentIndex === contour.points.length - 1) return { start: segmentIndex, end: 0 }
  return null
}

function contourSegmentRefs(contour: Contour, c: number): SketchSegmentRef[] {
  const refs: SketchSegmentRef[] = []
  for (let s = 0; s < contour.points.length - 1; s++) refs.push({ c, s })
  if (contour.closed && contour.points.length >= 3) refs.push({ c, s: contour.points.length - 1 })
  return refs
}

export function sketchContourPerimeterCells(contour: Contour): number {
  let total = 0
  for (let i = 1; i < contour.points.length; i++) total += pointDistance(contour.points[i - 1], contour.points[i])
  if (contour.closed && contour.points.length >= 3) total += pointDistance(contour.points[contour.points.length - 1], contour.points[0])
  return total
}

export function sketchContourAreaCells(contour: Contour): number {
  if (!contour.closed || contour.points.length < 3) return 0
  let sum = 0
  contour.points.forEach((point, index) => {
    const next = contour.points[(index + 1) % contour.points.length]
    sum += point.x * next.y - next.x * point.y
  })
  return Math.abs(sum) / 2
}

export function sketchSegmentLengthFt(model: Pick<Sketch3DModel, 'cellFt' | 'contours'>, ref: SketchSegmentRef): number | null {
  const contour = model.contours[ref.c]
  const indexes = contour ? segmentPointIndexes(contour, ref.s) : null
  if (!contour || !indexes) return null
  return pointDistance(contour.points[indexes.start], contour.points[indexes.end]) * sketchModelCellFt(model)
}

function vectorBetween(a: Pt, b: Pt): Pt {
  return { x: b.x - a.x, y: b.y - a.y }
}

function isRectangleContour(contour: Contour): boolean {
  if (!contour.closed || contour.points.length !== 4) return false
  const vectors = contour.points.map((point, index) => vectorBetween(point, contour.points[(index + 1) % contour.points.length]))
  const lengths = vectors.map((vector) => Math.hypot(vector.x, vector.y))
  if (lengths.some((length) => length <= SKETCH_GEOMETRY_EPS)) return false
  for (let i = 0; i < vectors.length; i++) {
    const next = (i + 1) % vectors.length
    const dot = vectors[i].x * vectors[next].x + vectors[i].y * vectors[next].y
    if (Math.abs(dot) / (lengths[i] * lengths[next]) > 0.0001) return false
  }
  const cross02 = vectors[0].x * vectors[2].y - vectors[0].y * vectors[2].x
  const cross13 = vectors[1].x * vectors[3].y - vectors[1].y * vectors[3].x
  return Math.abs(cross02) / (lengths[0] * lengths[2]) <= 0.0001 && Math.abs(cross13) / (lengths[1] * lengths[3]) <= 0.0001
}

function segmentsShareEndpoint(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start === b.start || a.start === b.end || a.end === b.start || a.end === b.end
}

function cross(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function pointOnSegment(a: Pt, b: Pt, p: Pt): boolean {
  return Math.abs(cross(a, b, p)) <= SKETCH_GEOMETRY_EPS
    && p.x >= Math.min(a.x, b.x) - SKETCH_GEOMETRY_EPS
    && p.x <= Math.max(a.x, b.x) + SKETCH_GEOMETRY_EPS
    && p.y >= Math.min(a.y, b.y) - SKETCH_GEOMETRY_EPS
    && p.y <= Math.max(a.y, b.y) + SKETCH_GEOMETRY_EPS
}

function segmentsIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1 = cross(a1, a2, b1)
  const d2 = cross(a1, a2, b2)
  const d3 = cross(b1, b2, a1)
  const d4 = cross(b1, b2, a2)
  if (((d1 > SKETCH_GEOMETRY_EPS && d2 < -SKETCH_GEOMETRY_EPS) || (d1 < -SKETCH_GEOMETRY_EPS && d2 > SKETCH_GEOMETRY_EPS))
    && ((d3 > SKETCH_GEOMETRY_EPS && d4 < -SKETCH_GEOMETRY_EPS) || (d3 < -SKETCH_GEOMETRY_EPS && d4 > SKETCH_GEOMETRY_EPS))) {
    return true
  }
  return pointOnSegment(a1, a2, b1) || pointOnSegment(a1, a2, b2) || pointOnSegment(b1, b2, a1) || pointOnSegment(b1, b2, a2)
}

function validateContourGeometry(contour: Contour, c: number, minLengthCells: number): SketchSegmentResizeConflict | null {
  const segments = contourSegmentRefs(contour, c)
    .map((ref) => {
      const indexes = segmentPointIndexes(contour, ref.s)
      return indexes ? { ...ref, ...indexes, a: contour.points[indexes.start], b: contour.points[indexes.end] } : null
    })
    .filter((segment): segment is SketchSegmentRef & { start: number; end: number; a: Pt; b: Pt } => !!segment)

  const degenerate = segments.filter((segment) => pointDistance(segment.a, segment.b) < minLengthCells)
  if (degenerate.length > 0) {
    return { reason: 'degenerate', segments: degenerate.map(({ c: contourIndex, s }) => ({ c: contourIndex, s })) }
  }

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (segmentsShareEndpoint(segments[i], segments[j])) continue
      if (segmentsIntersect(segments[i].a, segments[i].b, segments[j].a, segments[j].b)) {
        return {
          reason: 'self-intersection',
          segments: [
            { c: segments[i].c, s: segments[i].s },
            { c: segments[j].c, s: segments[j].s },
          ],
        }
      }
    }
  }

  return null
}

function normalizeRadians(value: number): number {
  const full = Math.PI * 2
  const n = Number.isFinite(value) ? value : 0
  return ((n % full) + full) % full
}

function openingWidthForResize(opening: Opening): number {
  return opening.w ?? (opening.kind === 'door' ? DEFAULT_DOOR_WIDTH_FT : DEFAULT_WINDOW_WIDTH_FT)
}

function clampOpeningResizeT(model: Sketch3DModel, opening: Opening): number {
  const lengthFt = sketchSegmentLengthFt(model, { c: opening.c, s: opening.s })
  if (!lengthFt || lengthFt <= 0.001) return Math.max(0, Math.min(1, opening.t))
  const widthFt = Math.max(0.1, Math.min(openingWidthForResize(opening), lengthFt))
  if (widthFt >= lengthFt - 0.001) return 0.5
  const padT = (widthFt / 2) / lengthFt
  return Math.max(padT, Math.min(1 - padT, Number.isFinite(opening.t) ? opening.t : 0.5))
}

function wallPoseForPlacedItem(model: Sketch3DModel, c: number, s: number) {
  const contour = model.contours[c]
  const indexes = contour ? segmentPointIndexes(contour, s) : null
  if (!contour || !indexes) return null
  const cellFt = sketchModelCellFt(model)
  const a = contour.points[indexes.start]
  const b = contour.points[indexes.end]
  const ax = a.x * cellFt
  const az = a.y * cellFt
  const bx = b.x * cellFt
  const bz = b.y * cellFt
  const dx = bx - ax
  const dz = bz - az
  const length = Math.hypot(dx, dz)
  if (length <= 0.001) return null
  const ux = dx / length
  const uz = dz / length
  return { ax, az, dx, dz, ux, uz, nx: -uz, nz: ux, angle: Math.atan2(uz, ux), length }
}

function repositionWallBoundItems<T extends SketchGeometryPlacedItem>(items: T[] | undefined, before: Sketch3DModel, after: Sketch3DModel): T[] | undefined {
  if (!items) return undefined
  return items.map((item) => {
    if (!Number.isInteger(item.c) || !Number.isInteger(item.s) || !Number.isFinite(item.t)) return item
    const c = item.c ?? 0
    const s = item.s ?? 0
    const oldPose = wallPoseForPlacedItem(before, c, s)
    const nextPose = wallPoseForPlacedItem(after, c, s)
    if (!oldPose || !nextPose) return item
    const t = Math.max(0, Math.min(1, item.t ?? 0.5))
    const oldX = oldPose.ax + oldPose.dx * t
    const oldZ = oldPose.az + oldPose.dz * t
    const offset = (item.xFt - oldX) * oldPose.nx + (item.zFt - oldZ) * oldPose.nz
    const nextX = nextPose.ax + nextPose.dx * t
    const nextZ = nextPose.az + nextPose.dz * t
    return {
      ...item,
      t,
      xFt: nextX + nextPose.nx * offset,
      zFt: nextZ + nextPose.nz * offset,
      rotationY: normalizeRadians(item.rotationY + nextPose.angle - oldPose.angle),
    }
  })
}

export function resizeSketchSegmentToLength<T extends Sketch3DModel & { placedItems?: SketchGeometryPlacedItem[] }>(
  model: T,
  ref: SketchSegmentRef,
  targetLengthFt: number,
  options: { anchor?: SketchSegmentResizeAnchor; minLengthFt?: number } = {},
): SketchSegmentResizeResult<T> {
  const contour = model.contours[ref.c]
  const indexes = contour ? segmentPointIndexes(contour, ref.s) : null
  if (!contour || !indexes) return { ok: false, conflict: { reason: 'invalid-segment', segments: [ref] } }

  const cellFt = sketchModelCellFt(model)
  const minLengthFt = Math.max(MIN_SKETCH_SEGMENT_LENGTH_FT, options.minLengthFt ?? MIN_SKETCH_SEGMENT_LENGTH_FT)
  if (!Number.isFinite(targetLengthFt) || targetLengthFt < minLengthFt) {
    return { ok: false, conflict: { reason: 'invalid-length', segments: [ref] } }
  }

  const start = contour.points[indexes.start]
  const end = contour.points[indexes.end]
  const currentLengthCells = pointDistance(start, end)
  if (currentLengthCells <= SKETCH_GEOMETRY_EPS) return { ok: false, conflict: { reason: 'degenerate', segments: [ref] } }

  const targetLengthCells = targetLengthFt / cellFt
  const deltaCells = targetLengthCells - currentLengthCells
  if (Math.abs(deltaCells) <= SKETCH_GEOMETRY_EPS) return { ok: true, model, changedSegments: [ref] }

  const ux = (end.x - start.x) / currentLengthCells
  const uy = (end.y - start.y) / currentLengthCells
  const anchor = options.anchor ?? 'start'
  const moveIndexes = new Set<number>()
  let dx = ux * deltaCells
  let dy = uy * deltaCells

  if (isRectangleContour(contour)) {
    if (anchor === 'start') {
      moveIndexes.add(indexes.end)
      moveIndexes.add((indexes.end + 1) % contour.points.length)
    } else {
      moveIndexes.add(indexes.start)
      moveIndexes.add((indexes.start - 1 + contour.points.length) % contour.points.length)
      dx *= -1
      dy *= -1
    }
  } else if (anchor === 'start') {
    moveIndexes.add(indexes.end)
  } else {
    moveIndexes.add(indexes.start)
    dx *= -1
    dy *= -1
  }

  const nextPoints = contour.points.map((point, index) => (
    moveIndexes.has(index) ? { x: point.x + dx, y: point.y + dy } : { ...point }
  ))
  const nextContour: Contour = { ...contour, points: nextPoints }
  const conflict = validateContourGeometry(nextContour, ref.c, minLengthFt / cellFt)
  if (conflict) {
    const segments = new Map<string, SketchSegmentRef>()
    ;[ref, ...conflict.segments].forEach((segment) => segments.set(sketchWallKey(segment.c, segment.s), segment))
    return { ok: false, conflict: { reason: conflict.reason, segments: Array.from(segments.values()) } }
  }

  const nextContours = model.contours.map((item, index) => (index === ref.c ? nextContour : item))
  const nextBaseModel: Sketch3DModel = {
    ...model,
    contours: nextContours,
    openings: model.openings.map((opening) => {
      if (opening.c !== ref.c) return opening
      return { ...opening, t: clampOpeningResizeT({ ...model, contours: nextContours }, opening) }
    }),
  }
  const nextPlacedItems = repositionWallBoundItems(model.placedItems, model, nextBaseModel)
  const nextModel = {
    ...nextBaseModel,
    ...(nextPlacedItems ? { placedItems: nextPlacedItems } : {}),
  } as T

  const changedSegments = isRectangleContour(contour)
    ? [
        ref,
        { c: ref.c, s: (ref.s + 2) % contour.points.length },
      ]
    : [ref]

  return { ok: true, model: nextModel, changedSegments }
}

function cleanNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function cleanOptionalNumber(value: unknown, min: number, max: number): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return Math.max(min, Math.min(max, n))
}

export function cleanColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value : fallback
}

function cleanRegionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : undefined
}

function sanitizeCoverageRegion(value: unknown): SketchFinishRegion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<SketchFinishRegion>
  const x0 = cleanOptionalNumber(raw.x0Ft, 0, 200)
  const x1 = cleanOptionalNumber(raw.x1Ft, 0, 200)
  const y0 = cleanOptionalNumber(raw.y0Ft, 0, 30)
  const y1 = cleanOptionalNumber(raw.y1Ft, 0, 30)
  if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) return null
  const region: SketchFinishRegion = {
    x0Ft: Math.min(x0, x1),
    y0Ft: Math.min(y0, y1),
    x1Ft: Math.max(x0, x1),
    y1Ft: Math.max(y0, y1),
  }
  if (region.x1Ft - region.x0Ft < MIN_FINISH_REGION_SIZE_FT || region.y1Ft - region.y0Ft < MIN_FINISH_REGION_SIZE_FT) return null
  const id = cleanRegionId(raw.id)
  if (id) region.id = id
  return region
}

function sanitizeCoverageRegions(value: unknown): SketchFinishRegion[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .slice(0, MAX_FINISH_REGIONS)
    .map(sanitizeCoverageRegion)
    .filter((region): region is SketchFinishRegion => !!region)
}

function sanitizeCoverage(value: unknown): SketchFinishCoverage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Partial<SketchFinishCoverage>
  const mode = raw.mode === 'partial' ? 'partial' : raw.mode === 'full' ? 'full' : undefined
  if (!mode) return undefined
  if (mode === 'full') return { mode: 'full' }
  const bottomFt = cleanOptionalNumber(raw.bottomFt, 0, 30) ?? 0
  const heightFt = cleanOptionalNumber(raw.heightFt, 0.25, 30) ?? 4
  const coverage: SketchFinishCoverage = {
    mode: 'partial',
    bottomFt,
    heightFt,
  }
  const regions = sanitizeCoverageRegions(raw.regions)
  if (regions !== undefined) coverage.regions = regions
  else if (raw.bottomFt !== undefined || raw.heightFt !== undefined) {
    coverage.regions = normalizeFinishRegions([{
      x0Ft: 0,
      y0Ft: bottomFt,
      x1Ft: LEGACY_FINISH_BAND_WIDTH_FT,
      y1Ft: bottomFt + heightFt,
    }], LEGACY_FINISH_BAND_WIDTH_FT, 30)
  }
  return coverage
}

export function finishCoverageBoundsFt(surface: SketchSurfaceFinish, wallHeightFt: number): { bottomFt: number; topFt: number; full: boolean } {
  const roomHeight = Number.isFinite(wallHeightFt) && wallHeightFt > 0 ? wallHeightFt : 8
  const coverage = surface.coverage
  if (!coverage || coverage.mode !== 'partial') return { bottomFt: 0, topFt: roomHeight, full: true }
  if (coverage.regions !== undefined) {
    const normalized = normalizeFinishRegions(coverage.regions, 200, roomHeight)
    if (normalized.length === 0) return { bottomFt: 0, topFt: 0, full: false }
    const bottom = Math.min(...normalized.map((region) => region.y0Ft))
    const top = Math.max(...normalized.map((region) => region.y1Ft))
    return { bottomFt: bottom, topFt: top, full: bottom <= 0.001 && top >= roomHeight - 0.001 }
  }
  return { bottomFt: 0, topFt: 0, full: false }
}

export function normalizeFinishRegions(regions: SketchFinishRegion[] | undefined, wallLengthFt: number, wallHeightFt: number): SketchFinishRegion[] {
  const length = Number.isFinite(wallLengthFt) && wallLengthFt > 0 ? wallLengthFt : 0
  const height = Number.isFinite(wallHeightFt) && wallHeightFt > 0 ? wallHeightFt : 8
  if (!regions || length <= 0 || height <= 0) return []
  return regions
    .map((region): SketchFinishRegion | null => {
      const x0Raw = Number(region.x0Ft)
      const x1Raw = Number(region.x1Ft)
      const y0Raw = Number(region.y0Ft)
      const y1Raw = Number(region.y1Ft)
      if (![x0Raw, x1Raw, y0Raw, y1Raw].every(Number.isFinite)) return null
      const x0 = Math.max(0, Math.min(length, Math.min(x0Raw, x1Raw)))
      const x1 = Math.max(0, Math.min(length, Math.max(x0Raw, x1Raw)))
      const y0 = Math.max(0, Math.min(height, Math.min(y0Raw, y1Raw)))
      const y1 = Math.max(0, Math.min(height, Math.max(y0Raw, y1Raw)))
      if (x1 - x0 < MIN_FINISH_REGION_SIZE_FT || y1 - y0 < MIN_FINISH_REGION_SIZE_FT) return null
      const out: SketchFinishRegion = { x0Ft: x0, y0Ft: y0, x1Ft: x1, y1Ft: y1 }
      if (region.id) out.id = region.id
      return out
    })
    .filter((region): region is SketchFinishRegion => !!region)
}

export function finishCoverageRegionsFt(surface: SketchSurfaceFinish, wallLengthFt: number, wallHeightFt: number): SketchFinishRegion[] {
  const length = Number.isFinite(wallLengthFt) && wallLengthFt > 0 ? wallLengthFt : 0
  const height = Number.isFinite(wallHeightFt) && wallHeightFt > 0 ? wallHeightFt : 8
  if (length <= 0 || height <= 0) return []
  if (surface.kind === 'drywall-patch') {
    if (surface.coverage?.mode === 'partial' && surface.coverage.regions !== undefined) {
      return normalizeFinishRegions(surface.coverage.regions, length, height)
    }
    const patch = normalizeDrywallPatchSurface(surface)
    return normalizeFinishRegions([{
      x0Ft: patch.xFt ?? 0,
      y0Ft: patch.yFt ?? 0,
      x1Ft: (patch.xFt ?? 0) + (patch.widthFt ?? 0),
      y1Ft: (patch.yFt ?? 0) + (patch.heightFt ?? 0),
    }], length, height)
  }
  const coverage = surface.coverage
  if (!coverage || coverage.mode !== 'partial') {
    return [{ x0Ft: 0, y0Ft: 0, x1Ft: length, y1Ft: height }]
  }
  if (coverage.regions !== undefined) return normalizeFinishRegions(coverage.regions, length, height)
  return []
}

export function finishCoverageAreaSqft(surface: SketchSurfaceFinish, wallLengthFt: number, wallHeightFt: number): number {
  return finishCoverageRegionsFt(surface, wallLengthFt, wallHeightFt)
    .reduce((sum, region) => sum + Math.max(0, region.x1Ft - region.x0Ft) * Math.max(0, region.y1Ft - region.y0Ft), 0)
}

export function normalizeDrywallPatchSurface(surface?: SketchSurfaceFinish): SketchDrywallPatchFinish {
  const patch = surface?.kind === 'drywall-patch' ? surface : undefined
  const out: SketchDrywallPatchFinish = {
    kind: 'drywall-patch',
    baseColor: cleanColor(patch?.baseColor, DEFAULT_WALL_PAINT),
    patchColor: cleanColor(patch?.patchColor, DEFAULT_DRYWALL_PATCH_COLOR),
    xFt: cleanOptionalNumber(patch?.xFt, 0, 200) ?? 0,
    yFt: cleanOptionalNumber(patch?.yFt, 0, 30) ?? 2,
    widthFt: cleanOptionalNumber(patch?.widthFt, 0.25, 200) ?? DEFAULT_DRYWALL_PATCH_WIDTH_FT,
    heightFt: cleanOptionalNumber(patch?.heightFt, 0.25, 30) ?? DEFAULT_DRYWALL_PATCH_HEIGHT_FT,
  }
  const coverage = sanitizeCoverage(patch?.coverage)
  if (coverage) out.coverage = coverage
  return out
}

function cleanId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : undefined
}

function cleanText(value: unknown, max = 140): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined
}

export function normalizeTileSurface(surface?: SketchSurfaceFinish): SketchTileFinish {
  const tile = surface?.kind === 'tile' ? surface : undefined
  const out: SketchTileFinish = {
    kind: 'tile',
    tileWIn: cleanNumber(tile?.tileWIn, 12, 1, 96),
    tileHIn: cleanNumber(tile?.tileHIn, 24, 1, 96),
    groutIn: cleanNumber(tile?.groutIn, DEFAULT_GROUT_IN, 0, 2),
    groutColor: cleanColor(tile?.groutColor, DEFAULT_GROUT_COLOR),
    tileColor: cleanColor(tile?.tileColor, DEFAULT_TILE_COLOR),
    offsetXIn: cleanNumber(tile?.offsetXIn, 0, -96, 96),
    offsetYIn: cleanNumber(tile?.offsetYIn, 0, -96, 96),
  }
  const catalogItemId = cleanId(tile?.catalogItemId)
  const catalogItemName = cleanText(tile?.catalogItemName)
  const catalogPhotoPath = cleanText(tile?.catalogPhotoPath, 600)
  if (catalogItemId) out.catalogItemId = catalogItemId
  if (catalogItemName) out.catalogItemName = catalogItemName
  if (catalogPhotoPath) out.catalogPhotoPath = catalogPhotoPath
  const coverage = sanitizeCoverage(tile?.coverage)
  if (coverage) out.coverage = coverage
  return out
}

function normalizeSurface(surface: SketchSurfaceFinish | undefined, fallbackColor: string): SketchSurfaceFinish {
  if (surface?.kind === 'tile') return normalizeTileSurface(surface)
  if (surface?.kind === 'drywall-patch') return normalizeDrywallPatchSurface(surface)
  const paint: SketchPaintFinish = { kind: 'paint', color: cleanColor(surface?.kind === 'paint' ? surface.color : undefined, fallbackColor) }
  const coverage = sanitizeCoverage(surface?.kind === 'paint' ? surface.coverage : undefined)
  if (coverage) paint.coverage = coverage
  return paint
}

export function normalizeFinishes(finishes?: SketchFinishes): Required<SketchFinishes> {
  const wallPaint = cleanColor(finishes?.wallPaint, DEFAULT_WALL_PAINT)
  const wallFinishes = sanitizeWallFinishes(finishes?.wallFinishes)
  return {
    wallPaint,
    walls: normalizeSurface(finishes?.walls, wallPaint),
    floor: normalizeSurface(finishes?.floor, DEFAULT_FLOOR_PAINT),
    ceiling: normalizeSurface(finishes?.ceiling, DEFAULT_WALL_PAINT),
    wallFinishes,
  }
}

function sanitizeSurface(value: unknown): SketchSurfaceFinish | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<SketchTileFinish> & Partial<SketchPaintFinish> & Partial<SketchDrywallPatchFinish> & { kind?: string; color?: unknown }
  if (raw.kind === 'tile') return normalizeTileSurface({ ...raw, kind: 'tile' })
  if (raw.kind === 'drywall-patch') return normalizeDrywallPatchSurface({ ...raw, kind: 'drywall-patch' })
  if (raw.kind === 'paint' || typeof raw.color === 'string') {
    const paint: SketchPaintFinish = { kind: 'paint', color: cleanColor(raw.color, DEFAULT_WALL_PAINT) }
    const coverage = sanitizeCoverage(raw.coverage)
    if (coverage) paint.coverage = coverage
    return paint
  }
  return undefined
}

function sanitizeWallFinishes(value: unknown): Record<string, SketchSurfaceFinish> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, SketchSurfaceFinish> = {}
  Object.entries(value as Record<string, unknown>).slice(0, 500).forEach(([key, raw]) => {
    if (!WALL_FINISH_KEY_RE.test(key)) return
    const surface = sanitizeSurface(raw)
    if (surface) out[key] = surface
  })
  return out
}

export function sanitizeSketchFinishes(value: unknown): SketchFinishes | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { walls?: unknown; floor?: unknown; ceiling?: unknown; wallPaint?: unknown; wallFinishes?: unknown }
  const finishes: SketchFinishes = {}
  const wallPaint = typeof raw.wallPaint === 'string' ? cleanColor(raw.wallPaint, DEFAULT_WALL_PAINT) : undefined
  const walls = sanitizeSurface(raw.walls)
  const floor = sanitizeSurface(raw.floor)
  const ceiling = sanitizeSurface(raw.ceiling)
  const wallFinishes = sanitizeWallFinishes(raw.wallFinishes)
  if (wallPaint) finishes.wallPaint = wallPaint
  if (walls) finishes.walls = walls
  if (floor) finishes.floor = floor
  if (ceiling) finishes.ceiling = ceiling
  if (Object.keys(wallFinishes).length > 0) finishes.wallFinishes = wallFinishes
  return finishes.wallPaint || finishes.walls || finishes.floor || finishes.ceiling || finishes.wallFinishes ? finishes : undefined
}

export function sanitizeSketchOpenings(value: unknown): Opening[] {
  if (!Array.isArray(value)) return []
  return value
    .map((raw): Opening | null => {
      if (!raw || typeof raw !== 'object') return null
      const item = raw as Partial<Opening>
      const kind = item.kind
      if (kind !== 'door' && kind !== 'window') return null
      if (!Number.isInteger(item.c) || !Number.isInteger(item.s)) return null
      const opening: Opening = {
        kind,
        c: Math.max(0, Number(item.c)),
        s: Math.max(0, Number(item.s)),
        t: cleanNumber(item.t, 0.5, 0, 1),
      }
      const width = cleanOptionalNumber(item.w, 0.5, 100)
      const height = cleanOptionalNumber(item.h, 0.5, 100)
      const sill = cleanOptionalNumber(item.sill, 0, 100)
      if (width !== undefined) opening.w = snapOpeningFeetToPrecision(width)
      if (height !== undefined) opening.h = snapOpeningFeetToPrecision(height)
      if (kind === 'window' && sill !== undefined) opening.sill = snapOpeningFeetToPrecision(sill)
      return opening
    })
    .filter((item): item is Opening => !!item)
}

function sanitizeMeasurementPoint(value: unknown): SketchMeasurementPoint | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<SketchMeasurementPoint>
  const x = cleanOptionalNumber(item.x, -10000, 10000)
  const y = cleanOptionalNumber(item.y, -10000, 10000)
  if (x === undefined || y === undefined) return null
  const z = cleanOptionalNumber(item.z, -10000, 10000)
  const point: SketchMeasurementPoint = { x, y }
  if (z !== undefined) point.z = z
  return point
}

export function sanitizeSketchMeasurements(value: unknown): SketchMeasurement[] {
  if (!Array.isArray(value)) return []
  return value
    .map((raw): SketchMeasurement | null => {
      if (!raw || typeof raw !== 'object') return null
      const item = raw as Partial<SketchMeasurement>
      const a = sanitizeMeasurementPoint(item.a)
      const b = sanitizeMeasurementPoint(item.b)
      if (!a || !b) return null
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = (b.z ?? 0) - (a.z ?? 0)
      if (Math.hypot(dx, dy, dz) <= 0.001) return null
      const scope = item.scope === 'wall' || item.scope === 'space' || item.scope === 'plan' ? item.scope : undefined
      const id = cleanId(item.id)
      const wallKey = typeof item.wallKey === 'string' && WALL_FINISH_KEY_RE.test(item.wallKey) ? item.wallKey : undefined
      if (scope === 'wall' && !wallKey) return null
      const measurement: SketchMeasurement = { a, b }
      if (id) measurement.id = id
      if (scope) measurement.scope = scope
      if (scope === 'wall' && wallKey) measurement.wallKey = wallKey
      return measurement
    })
    .filter((item): item is SketchMeasurement => !!item)
}

export function sanitizeSketchLights(value: unknown): SketchLight[] {
  if (!Array.isArray(value)) return []
  return value
    .map((raw): SketchLight | null => {
      if (!raw || typeof raw !== 'object') return null
      const item = raw as Partial<SketchLight>
      const id = cleanId(item.id)
      const kind = item.kind
      if (!id || !kind || !['recessed', 'chandelier', 'fan', 'sconce'].includes(kind)) return null
      const light: SketchLight = { id, kind }
      if (typeof item.name === 'string' && item.name.trim()) light.name = item.name.trim().slice(0, 80)
      if (Number.isFinite(item.xFt)) light.xFt = Number(item.xFt)
      if (Number.isFinite(item.zFt)) light.zFt = Number(item.zFt)
      if (Number.isInteger(item.c) && Number(item.c) >= 0) light.c = Number(item.c)
      if (Number.isInteger(item.s) && Number(item.s) >= 0) light.s = Number(item.s)
      if (Number.isFinite(item.t)) light.t = cleanNumber(item.t, 0.5, 0, 1)
      if (Number.isFinite(item.heightFt)) light.heightFt = cleanNumber(item.heightFt, 5.5, 0.5, 20)
      return light
    })
    .filter((item): item is SketchLight => !!item)
}

export function sanitizeSketchSwitches(value: unknown): SketchSwitch[] {
  if (!Array.isArray(value)) return []
  return value
    .map((raw): SketchSwitch | null => {
      if (!raw || typeof raw !== 'object') return null
      const item = raw as Partial<SketchSwitch>
      const id = cleanId(item.id)
      if (!id || !Number.isInteger(item.c) || !Number.isInteger(item.s)) return null
      const controls = Array.isArray(item.controls) ? item.controls.map(cleanId).filter((v): v is string => !!v) : []
      return {
        id,
        c: Math.max(0, Number(item.c)),
        s: Math.max(0, Number(item.s)),
        t: cleanNumber(item.t, 0.5, 0, 1),
        heightFt: cleanNumber(item.heightFt, 4, 0.5, 12),
        controls,
        label: typeof item.label === 'string' ? item.label.trim().slice(0, 80) : undefined,
      }
    })
    .filter((item): item is SketchSwitch => !!item)
}

export type TileCutSummary = {
  rows: number
  columns: number
  bottomIn: number
  topIn: number
  leftIn: number
  rightIn: number
}

function visibleTileCuts(lengthIn: number, tileIn: number, groutIn: number, offsetIn: number): { count: number; startIn: number; endIn: number } {
  const length = Math.max(0, lengthIn)
  const tile = Math.max(0.01, tileIn)
  const pitch = tile + Math.max(0, groutIn)
  const offset = Number.isFinite(offsetIn) ? offsetIn : 0
  const pieces: number[] = []
  const firstK = Math.floor((0 - offset - tile - pitch) / pitch)
  const lastK = Math.ceil((length - offset + pitch) / pitch)
  for (let k = firstK; k <= lastK; k++) {
    const start = offset + k * pitch
    const end = start + tile
    const clippedStart = Math.max(0, start)
    const clippedEnd = Math.min(length, end)
    if (clippedEnd - clippedStart > 0.001) pieces.push(clippedEnd - clippedStart)
  }
  return { count: pieces.length, startIn: pieces[0] ?? 0, endIn: pieces[pieces.length - 1] ?? 0 }
}

export function calculateTileCuts(surface: SketchSurfaceFinish | undefined, heightIn: number, widthIn: number): TileCutSummary {
  const tile = normalizeTileSurface(surface)
  const vertical = visibleTileCuts(heightIn, tile.tileHIn ?? 24, tile.groutIn ?? DEFAULT_GROUT_IN, tile.offsetYIn ?? 0)
  const horizontal = visibleTileCuts(widthIn, tile.tileWIn ?? 12, tile.groutIn ?? DEFAULT_GROUT_IN, tile.offsetXIn ?? 0)
  return {
    rows: vertical.count,
    columns: horizontal.count,
    bottomIn: vertical.startIn,
    topIn: vertical.endIn,
    leftIn: horizontal.startIn,
    rightIn: horizontal.endIn,
  }
}

export { formatInches } from './inches'

export function createTilePatternCanvas(surface: SketchSurfaceFinish | undefined): HTMLCanvasElement {
  const tile = normalizeTileSurface(surface)
  const key = [
    tile.tileWIn ?? 12,
    tile.tileHIn ?? 24,
    tile.groutIn ?? DEFAULT_GROUT_IN,
    cleanColor(tile.groutColor, DEFAULT_GROUT_COLOR),
    cleanColor(tile.tileColor, DEFAULT_TILE_COLOR),
    tile.catalogPhotoPath ?? '',
  ].join('|')
  const cached = tilePatternCanvasCache.get(key)
  if (cached) return cached
  const tileW = Math.max(0.01, tile.tileWIn ?? 12)
  const tileH = Math.max(0.01, tile.tileHIn ?? 24)
  const grout = Math.max(0, tile.groutIn ?? DEFAULT_GROUT_IN)
  const pitchW = tileW + grout
  const pitchH = tileH + grout
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.fillStyle = cleanColor(tile.groutColor, DEFAULT_GROUT_COLOR)
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const pad = 1
  const w = Math.max(1, Math.round((tileW / pitchW) * canvas.width) - pad)
  const h = Math.max(1, Math.round((tileH / pitchH) * canvas.height) - pad)
  ctx.fillStyle = cleanColor(tile.tileColor, DEFAULT_TILE_COLOR)
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = 'rgba(255,255,255,.22)'
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, Math.max(1, w - 2), Math.max(1, h - 2))
  tilePatternCanvasCache.set(key, canvas)
  return canvas
}
