import { snapOpeningFeetToPrecision } from './inches'

export type Pt = { x: number; y: number }
export type Contour = { points: Pt[]; closed: boolean }
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

export type SketchFinishCoverage = {
  mode?: 'full' | 'partial'
  bottomFt?: number
  heightFt?: number
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
}

export type SketchSurfaceFinish = SketchPaintFinish | SketchTileFinish | SketchDrywallPatchFinish

export type SketchFinishes = {
  walls?: SketchSurfaceFinish
  floor?: SketchSurfaceFinish
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

export function sketchWallKey(c: number, s: number): string {
  return `${c}:${s}`
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

function sanitizeCoverage(value: unknown): SketchFinishCoverage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Partial<SketchFinishCoverage>
  const mode = raw.mode === 'partial' ? 'partial' : raw.mode === 'full' ? 'full' : undefined
  if (!mode) return undefined
  if (mode === 'full') return { mode: 'full' }
  return {
    mode: 'partial',
    bottomFt: cleanOptionalNumber(raw.bottomFt, 0, 30) ?? 0,
    heightFt: cleanOptionalNumber(raw.heightFt, 0.25, 30) ?? 4,
  }
}

export function finishCoverageBoundsFt(surface: SketchSurfaceFinish, wallHeightFt: number): { bottomFt: number; topFt: number; full: boolean } {
  const roomHeight = Number.isFinite(wallHeightFt) && wallHeightFt > 0 ? wallHeightFt : 8
  const coverage = surface.kind === 'drywall-patch' ? undefined : surface.coverage
  if (!coverage || coverage.mode !== 'partial') return { bottomFt: 0, topFt: roomHeight, full: true }
  const bottom = Math.max(0, Math.min(roomHeight, coverage.bottomFt ?? 0))
  const height = Math.max(0.25, Math.min(roomHeight - bottom, coverage.heightFt ?? roomHeight))
  const top = Math.max(bottom, Math.min(roomHeight, bottom + height))
  return { bottomFt: bottom, topFt: top, full: bottom <= 0.001 && top >= roomHeight - 0.001 }
}

export function normalizeDrywallPatchSurface(surface?: SketchSurfaceFinish): SketchDrywallPatchFinish {
  const patch = surface?.kind === 'drywall-patch' ? surface : undefined
  return {
    kind: 'drywall-patch',
    baseColor: cleanColor(patch?.baseColor, DEFAULT_WALL_PAINT),
    patchColor: cleanColor(patch?.patchColor, DEFAULT_DRYWALL_PATCH_COLOR),
    xFt: cleanOptionalNumber(patch?.xFt, 0, 200) ?? 0,
    yFt: cleanOptionalNumber(patch?.yFt, 0, 30) ?? 2,
    widthFt: cleanOptionalNumber(patch?.widthFt, 0.25, 200) ?? DEFAULT_DRYWALL_PATCH_WIDTH_FT,
    heightFt: cleanOptionalNumber(patch?.heightFt, 0.25, 30) ?? DEFAULT_DRYWALL_PATCH_HEIGHT_FT,
  }
}

function cleanId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 80 ? trimmed : undefined
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
  const raw = value as { walls?: unknown; floor?: unknown; wallPaint?: unknown; wallFinishes?: unknown }
  const finishes: SketchFinishes = {}
  const wallPaint = typeof raw.wallPaint === 'string' ? cleanColor(raw.wallPaint, DEFAULT_WALL_PAINT) : undefined
  const walls = sanitizeSurface(raw.walls)
  const floor = sanitizeSurface(raw.floor)
  const wallFinishes = sanitizeWallFinishes(raw.wallFinishes)
  if (wallPaint) finishes.wallPaint = wallPaint
  if (walls) finishes.walls = walls
  if (floor) finishes.floor = floor
  if (Object.keys(wallFinishes).length > 0) finishes.wallFinishes = wallFinishes
  return finishes.wallPaint || finishes.walls || finishes.floor || finishes.wallFinishes ? finishes : undefined
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
