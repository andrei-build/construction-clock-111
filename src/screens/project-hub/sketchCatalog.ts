import type { CatalogCategory, CatalogItem } from '../../lib/api'
import type { Contour } from './sketchFinishes'
import { formatInches } from './inches'

export type CatalogPlacementSurface = 'floor' | 'wall' | 'ceiling'
export type SketchPlacedCatalogKind = 'TOILET' | 'SHOWER_PAN' | 'OUTLET' | 'SWITCH'
export type SketchPlacedCabinetLayer = 'base' | 'wall'
export type SketchShowerPanShape = 'rect' | 'neo-angle'

export type SketchPlacedCatalogItem = {
  id: string
  catalogItemId: string
  xFt: number
  yFt: number
  zFt: number
  rotationY: number
  surface: CatalogPlacementSurface
  c?: number
  s?: number
  t?: number
  category?: CatalogCategory
  kind?: SketchPlacedCatalogKind
  name?: string
  brand?: string
  model?: string
  code?: string
  cabinetPrefix?: string
  wallId?: string
  layer?: SketchPlacedCabinetLayer
  hinge?: 'L' | 'R'
  filler?: boolean
  panel?: boolean
  showerPanShape?: SketchShowerPanShape
  layoutWarning?: 'overflow' | 'small-filler'
  widthIn?: number
  depthIn?: number
  heightIn?: number
  photoPath?: string
}

export type CatalogDimsFt = {
  widthFt: number
  depthFt: number
  heightFt: number
}

export type CatalogResolvedPlacedItem = {
  placed: SketchPlacedCatalogItem
  catalogItem: CatalogItem | null
  missingCatalogItem: boolean
  category: CatalogCategory
  name: string
  brand: string | null
  model: string | null
  photoPath: string | null
  dims: CatalogDimsFt
  widthIn: number
  depthIn: number
  heightIn: number
}

export type CatalogWorldPoint = { x: number; z: number }

export type CatalogWallHit = {
  c: number
  s: number
  t: number
  x: number
  z: number
  yFt?: number
  ux: number
  uz: number
  nx: number
  nz: number
  side: 1 | -1
  distanceFt: number
  lengthFt: number
  rotationY: number
}

export type CatalogSceneBounds = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  width: number
  depth: number
}

const CATALOG_CATEGORIES: CatalogCategory[] = ['shower', 'vanity', 'cabinet', 'light', 'fan', 'other']
const CATALOG_CATEGORY_SET = new Set<string>(CATALOG_CATEGORIES)
export const SKETCH_CATALOG_KIND_TOILET: SketchPlacedCatalogKind = 'TOILET'
export const SKETCH_CATALOG_KIND_SHOWER_PAN: SketchPlacedCatalogKind = 'SHOWER_PAN'
export const SKETCH_CATALOG_KIND_OUTLET: SketchPlacedCatalogKind = 'OUTLET'
export const SKETCH_CATALOG_KIND_SWITCH: SketchPlacedCatalogKind = 'SWITCH'
export const BUILTIN_TOILET_CATALOG_ID = 'builtin-toilet'
export const BUILTIN_SHOWER_PAN_RECT_CATALOG_ID = 'builtin-shower-pan-60x32'
export const BUILTIN_SHOWER_PAN_NEO_CATALOG_ID = 'builtin-shower-pan-neo-36'
export const BUILTIN_OUTLET_CATALOG_ID = 'builtin-outlet'
export const BUILTIN_SWITCH_CATALOG_ID = 'builtin-switch'
export const BUILTIN_TOILET_CATALOG_ITEM: CatalogItem = {
  id: BUILTIN_TOILET_CATALOG_ID,
  org_id: '',
  category: 'other',
  name: 'Toilet',
  brand: null,
  model: SKETCH_CATALOG_KIND_TOILET,
  width_in: 15,
  depth_in: 28,
  height_in: 30,
  photo_path: null,
  price: null,
  url: null,
  note: null,
  is_active: true,
  sort_order: -100,
  created_by: null,
  created_at: '',
  updated_at: '',
}
export const BUILTIN_SHOWER_PAN_CATALOG_ITEMS: CatalogItem[] = [
  {
    id: BUILTIN_SHOWER_PAN_RECT_CATALOG_ID,
    org_id: '',
    category: 'shower',
    name: 'Shower pan 60 x 32',
    brand: null,
    model: 'SHOWER_PAN_RECT',
    width_in: 60,
    depth_in: 32,
    height_in: 4,
    photo_path: null,
    price: null,
    url: null,
    note: null,
    is_active: true,
    sort_order: -90,
    created_by: null,
    created_at: '',
    updated_at: '',
  },
  {
    id: BUILTIN_SHOWER_PAN_NEO_CATALOG_ID,
    org_id: '',
    category: 'shower',
    name: 'Neo-angle shower pan 36 x 36',
    brand: null,
    model: 'SHOWER_PAN_NEO_ANGLE',
    width_in: 36,
    depth_in: 36,
    height_in: 4,
    photo_path: null,
    price: null,
    url: null,
    note: null,
    is_active: true,
    sort_order: -89,
    created_by: null,
    created_at: '',
    updated_at: '',
  },
]
const IN_TO_FT = 1 / 12
const FLOOR_WALL_SNAP_FT = 2.25
const MAX_STORED_TEXT = 140

function cleanString(value: unknown, max = MAX_STORED_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text ? text.slice(0, max) : undefined
}

function cleanFinite(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanPositive(value: unknown): number | undefined {
  const n = cleanFinite(value)
  if (n === undefined || n <= 0) return undefined
  return Math.max(0.01, Math.min(1200, n))
}

function cleanCategory(value: unknown): CatalogCategory | undefined {
  return typeof value === 'string' && CATALOG_CATEGORY_SET.has(value) ? (value as CatalogCategory) : undefined
}

function cleanPlacedKind(value: unknown): SketchPlacedCatalogKind | undefined {
  if (value === SKETCH_CATALOG_KIND_TOILET) return SKETCH_CATALOG_KIND_TOILET
  if (value === SKETCH_CATALOG_KIND_SHOWER_PAN) return SKETCH_CATALOG_KIND_SHOWER_PAN
  if (value === SKETCH_CATALOG_KIND_OUTLET) return SKETCH_CATALOG_KIND_OUTLET
  if (value === SKETCH_CATALOG_KIND_SWITCH) return SKETCH_CATALOG_KIND_SWITCH
  return undefined
}

function cleanPlacedCabinetLayer(value: unknown): SketchPlacedCabinetLayer | undefined {
  return value === 'base' || value === 'wall' ? value : undefined
}

function cleanHinge(value: unknown): 'L' | 'R' | undefined {
  return value === 'L' || value === 'R' ? value : undefined
}

function cleanShowerPanShape(value: unknown): SketchShowerPanShape | undefined {
  return value === 'neo-angle' || value === 'rect' ? value : undefined
}

function cleanLayoutWarning(value: unknown): 'overflow' | 'small-filler' | undefined {
  return value === 'overflow' || value === 'small-filler' ? value : undefined
}

function cleanSurface(value: unknown): CatalogPlacementSurface {
  return value === 'wall' || value === 'ceiling' || value === 'floor' ? value : 'floor'
}

function normalizeAngle(value: number): number {
  const full = Math.PI * 2
  const n = Number.isFinite(value) ? value : 0
  return ((n % full) + full) % full
}

export function catalogItemHasExactDims(item: CatalogItem): boolean {
  return cleanPositive(item.width_in) !== undefined && cleanPositive(item.depth_in) !== undefined && cleanPositive(item.height_in) !== undefined
}

export function isBuiltinToiletCatalogItem(item: Pick<CatalogItem, 'id' | 'model'>): boolean {
  return item.id === BUILTIN_TOILET_CATALOG_ID || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_TOILET
}

export function isBuiltinShowerPanCatalogItem(item: Pick<CatalogItem, 'id' | 'model'>): boolean {
  const model = String(item.model ?? '').toUpperCase()
  return item.id === BUILTIN_SHOWER_PAN_RECT_CATALOG_ID
    || item.id === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID
    || model.startsWith(SKETCH_CATALOG_KIND_SHOWER_PAN)
}

export function isToiletPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return item.kind === SKETCH_CATALOG_KIND_TOILET
    || item.catalogItemId === BUILTIN_TOILET_CATALOG_ID
    || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_TOILET
}

export function isShowerPanPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId' | 'category'>): boolean {
  const model = String(item.model ?? '').toUpperCase()
  return item.kind === SKETCH_CATALOG_KIND_SHOWER_PAN
    || item.catalogItemId === BUILTIN_SHOWER_PAN_RECT_CATALOG_ID
    || item.catalogItemId === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID
    || model.startsWith(SKETCH_CATALOG_KIND_SHOWER_PAN)
    || item.category === 'shower'
}

export function isOutletPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return item.kind === SKETCH_CATALOG_KIND_OUTLET
    || item.catalogItemId === BUILTIN_OUTLET_CATALOG_ID
    || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_OUTLET
}

export function isSwitchPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return item.kind === SKETCH_CATALOG_KIND_SWITCH
    || item.catalogItemId === BUILTIN_SWITCH_CATALOG_ID
    || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_SWITCH
}

export function isElectricalPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return isOutletPlacedCatalogItem(item) || isSwitchPlacedCatalogItem(item)
}

export function showerPanShapeFromCatalogItem(item: Pick<CatalogItem, 'id' | 'model'>): SketchShowerPanShape {
  const model = String(item.model ?? '').toUpperCase()
  return item.id === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID || model.includes('NEO') ? 'neo-angle' : 'rect'
}

export function showerPanShapeFromPlacedItem(item: Pick<SketchPlacedCatalogItem, 'catalogItemId' | 'model' | 'showerPanShape'>): SketchShowerPanShape {
  const clean = cleanShowerPanShape(item.showerPanShape)
  if (clean) return clean
  const model = String(item.model ?? '').toUpperCase()
  return item.catalogItemId === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID || model.includes('NEO') ? 'neo-angle' : 'rect'
}

function isBuiltinSnapshotPlacedItem(item: Pick<SketchPlacedCatalogItem, 'catalogItemId'>): boolean {
  return item.catalogItemId === BUILTIN_TOILET_CATALOG_ID
    || item.catalogItemId === BUILTIN_SHOWER_PAN_RECT_CATALOG_ID
    || item.catalogItemId === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID
    || item.catalogItemId === BUILTIN_OUTLET_CATALOG_ID
    || item.catalogItemId === BUILTIN_SWITCH_CATALOG_ID
    || item.catalogItemId.startsWith('builtin-cabinet:')
}

export function catalogDimsFromItem(item: CatalogItem): CatalogDimsFt | null {
  const width = cleanPositive(item.width_in)
  const depth = cleanPositive(item.depth_in)
  const height = cleanPositive(item.height_in)
  if (width === undefined || depth === undefined || height === undefined) return null
  return { widthFt: width * IN_TO_FT, depthFt: depth * IN_TO_FT, heightFt: height * IN_TO_FT }
}

export function placedCatalogDims(placed: SketchPlacedCatalogItem): CatalogDimsFt | null {
  const width = cleanPositive(placed.widthIn)
  const depth = cleanPositive(placed.depthIn)
  const height = cleanPositive(placed.heightIn)
  if (width === undefined || depth === undefined || height === undefined) return null
  return { widthFt: width * IN_TO_FT, depthFt: depth * IN_TO_FT, heightFt: height * IN_TO_FT }
}

export function catalogDimsText(widthIn: number, depthIn: number, heightIn: number): string {
  return `${formatInches(widthIn)}×${formatInches(depthIn)}×${formatInches(heightIn)}`
}

export function snapshotCatalogItem(item: CatalogItem): Pick<SketchPlacedCatalogItem, 'catalogItemId' | 'category' | 'name' | 'brand' | 'model' | 'widthIn' | 'depthIn' | 'heightIn' | 'photoPath'> {
  return {
    catalogItemId: item.id,
    category: item.category,
    name: item.name,
    brand: item.brand ?? undefined,
    model: item.model ?? undefined,
    widthIn: cleanPositive(item.width_in),
    depthIn: cleanPositive(item.depth_in),
    heightIn: cleanPositive(item.height_in),
    photoPath: item.photo_path ?? undefined,
  }
}

export function sanitizePlacedCatalogItems(value: unknown): SketchPlacedCatalogItem[] {
  if (!Array.isArray(value)) return []
  return value
    .map((raw): SketchPlacedCatalogItem | null => {
      if (!raw || typeof raw !== 'object') return null
      const item = raw as Record<string, unknown>
      const id = cleanString(item.id, 100)
      const catalogItemId = cleanString(item.catalogItemId, 100)
      const xFt = cleanFinite(item.xFt ?? item.x)
      const yFt = cleanFinite(item.yFt ?? item.y)
      const zFt = cleanFinite(item.zFt ?? item.z)
      if (!id || !catalogItemId || xFt === undefined || yFt === undefined || zFt === undefined) return null
      const placed: SketchPlacedCatalogItem = {
        id,
        catalogItemId,
        xFt,
        yFt,
        zFt,
        rotationY: normalizeAngle(cleanFinite(item.rotationY ?? item.rotation) ?? 0),
        surface: cleanSurface(item.surface),
      }
      const c = cleanFinite(item.c)
      const s = cleanFinite(item.s)
      const t = cleanFinite(item.t)
      if (c !== undefined && Number.isInteger(c) && c >= 0) placed.c = c
      if (s !== undefined && Number.isInteger(s) && s >= 0) placed.s = s
      if (t !== undefined) placed.t = Math.max(0, Math.min(1, t))
      const category = cleanCategory(item.category)
      if (category) placed.category = category
      const modelUpper = String(item.model ?? '').toUpperCase()
      const kind = cleanPlacedKind(item.kind)
        ?? (modelUpper === SKETCH_CATALOG_KIND_TOILET ? SKETCH_CATALOG_KIND_TOILET : undefined)
        ?? (modelUpper.startsWith(SKETCH_CATALOG_KIND_SHOWER_PAN) ? SKETCH_CATALOG_KIND_SHOWER_PAN : undefined)
      if (kind) placed.kind = kind
      const name = cleanString(item.name)
      const brand = cleanString(item.brand)
      const model = cleanString(item.model)
      const code = cleanString(item.code)
      const cabinetPrefix = cleanString(item.cabinetPrefix, 40)
      const wallId = cleanString(item.wallId, 40)
      const layer = cleanPlacedCabinetLayer(item.layer)
      const hinge = cleanHinge(item.hinge)
      const showerPanShape = cleanShowerPanShape(item.showerPanShape ?? item.shower_pan_shape)
      const layoutWarning = cleanLayoutWarning(item.layoutWarning)
      const photoPath = cleanString(item.photoPath, 600)
      if (name) placed.name = name
      if (brand) placed.brand = brand
      if (model) placed.model = model
      if (code) placed.code = code
      if (cabinetPrefix) placed.cabinetPrefix = cabinetPrefix
      if (wallId) placed.wallId = wallId
      if (layer) placed.layer = layer
      if (hinge) placed.hinge = hinge
      if (showerPanShape) placed.showerPanShape = showerPanShape
      if (item.filler === true) placed.filler = true
      if (item.panel === true) placed.panel = true
      if (layoutWarning) placed.layoutWarning = layoutWarning
      if (photoPath) placed.photoPath = photoPath
      const widthIn = cleanPositive(item.widthIn ?? item.width_in)
      const depthIn = cleanPositive(item.depthIn ?? item.depth_in)
      const heightIn = cleanPositive(item.heightIn ?? item.height_in)
      if (widthIn !== undefined) placed.widthIn = widthIn
      if (depthIn !== undefined) placed.depthIn = depthIn
      if (heightIn !== undefined) placed.heightIn = heightIn
      return placed
    })
    .filter((item): item is SketchPlacedCatalogItem => !!item)
}

export function resolvePlacedCatalogItem(placed: SketchPlacedCatalogItem, catalogItem: CatalogItem | null): CatalogResolvedPlacedItem | null {
  const itemDims = catalogItem ? catalogDimsFromItem(catalogItem) : null
  const snapshotDims = placedCatalogDims(placed)
  const dims = itemDims ?? snapshotDims
  if (!dims) return null
  const widthIn = catalogItem?.width_in ?? placed.widthIn
  const depthIn = catalogItem?.depth_in ?? placed.depthIn
  const heightIn = catalogItem?.height_in ?? placed.heightIn
  if (widthIn == null || depthIn == null || heightIn == null) return null
  return {
    placed,
    catalogItem,
    missingCatalogItem: !catalogItem && !isBuiltinSnapshotPlacedItem(placed),
    category: catalogItem?.category ?? placed.category ?? 'other',
    name: catalogItem?.name ?? placed.name ?? placed.catalogItemId,
    brand: catalogItem?.brand ?? placed.brand ?? null,
    model: catalogItem?.model ?? placed.model ?? null,
    photoPath: catalogItem?.photo_path ?? placed.photoPath ?? null,
    dims,
    widthIn,
    depthIn,
    heightIn,
  }
}

function modelCellFt(model: { cellFt?: number }): number {
  return Number.isFinite(model.cellFt) && (model.cellFt ?? 0) > 0 ? model.cellFt ?? 1 : 1
}

function eachWorldSegment(model: { cellFt?: number; contours: Contour[] }) {
  const cellFt = modelCellFt(model)
  const out: Array<{ c: number; s: number; ax: number; az: number; bx: number; bz: number; len: number }> = []
  model.contours.forEach((contour, c) => {
    for (let s = 0; s < contour.points.length - 1; s++) {
      const a = contour.points[s]
      const b = contour.points[s + 1]
      const ax = a.x * cellFt
      const az = a.y * cellFt
      const bx = b.x * cellFt
      const bz = b.y * cellFt
      out.push({ c, s, ax, az, bx, bz, len: Math.hypot(bx - ax, bz - az) })
    }
    if (contour.closed && contour.points.length >= 3) {
      const a = contour.points[contour.points.length - 1]
      const b = contour.points[0]
      const ax = a.x * cellFt
      const az = a.y * cellFt
      const bx = b.x * cellFt
      const bz = b.y * cellFt
      out.push({ c, s: contour.points.length - 1, ax, az, bx, bz, len: Math.hypot(bx - ax, bz - az) })
    }
  })
  return out.filter((seg) => seg.len > 0.01)
}

export function nearestCatalogWall(model: { cellFt?: number; contours: Contour[] }, point: CatalogWorldPoint): CatalogWallHit | null {
  let best: CatalogWallHit | null = null
  eachWorldSegment(model).forEach((seg) => {
    const dx = seg.bx - seg.ax
    const dz = seg.bz - seg.az
    const len2 = dx * dx + dz * dz
    if (len2 <= 0.001) return
    const t = Math.max(0, Math.min(1, ((point.x - seg.ax) * dx + (point.z - seg.az) * dz) / len2))
    const x = seg.ax + dx * t
    const z = seg.az + dz * t
    const ux = dx / seg.len
    const uz = dz / seg.len
    const nx = -uz
    const nz = ux
    const signed = (point.x - x) * nx + (point.z - z) * nz
    const distanceFt = Math.hypot(point.x - x, point.z - z)
    if (!best || distanceFt < best.distanceFt) {
      const side: 1 | -1 = signed < 0 ? -1 : 1
      best = {
        c: seg.c,
        s: seg.s,
        t,
        x,
        z,
        ux,
        uz,
        nx,
        nz,
        side,
        distanceFt,
        lengthFt: seg.len,
        rotationY: -Math.atan2(uz, ux) + (side < 0 ? Math.PI : 0),
      }
    }
  })
  return best
}

export function placedOnFloor(item: CatalogItem, id: string, point: CatalogWorldPoint, dims: CatalogDimsFt, model: { cellFt?: number; contours: Contour[] }, wallThicknessFt: number, rotationY = 0): SketchPlacedCatalogItem {
  const nearest = nearestCatalogWall(model, point)
  const snapDistance = Math.max(FLOOR_WALL_SNAP_FT, dims.depthFt / 2 + wallThicknessFt + 0.5)
  if (nearest && nearest.distanceFt <= snapDistance) {
    return {
      id,
      ...snapshotCatalogItem(item),
      xFt: nearest.x + nearest.nx * nearest.side * (wallThicknessFt / 2 + dims.depthFt / 2),
      yFt: dims.heightFt / 2,
      zFt: nearest.z + nearest.nz * nearest.side * (wallThicknessFt / 2 + dims.depthFt / 2),
      rotationY: normalizeAngle(nearest.rotationY),
      surface: 'floor',
      c: nearest.c,
      s: nearest.s,
      t: nearest.t,
    }
  }
  return {
    id,
    ...snapshotCatalogItem(item),
    xFt: point.x,
    yFt: dims.heightFt / 2,
    zFt: point.z,
    rotationY: normalizeAngle(rotationY),
    surface: 'floor',
  }
}

export function placedOnCeiling(item: CatalogItem, id: string, point: CatalogWorldPoint, dims: CatalogDimsFt, roomHeightFt: number, rotationY = 0): SketchPlacedCatalogItem {
  return {
    id,
    ...snapshotCatalogItem(item),
    xFt: point.x,
    yFt: Math.max(dims.heightFt / 2, roomHeightFt - dims.heightFt / 2),
    zFt: point.z,
    rotationY: normalizeAngle(rotationY),
    surface: 'ceiling',
  }
}

export function placedOnWall(item: CatalogItem, id: string, hit: CatalogWallHit, dims: CatalogDimsFt, roomHeightFt: number, wallThicknessFt: number, rotationY = hit.rotationY): SketchPlacedCatalogItem {
  const yFt = Math.max(dims.heightFt / 2, Math.min(roomHeightFt - dims.heightFt / 2, hit.yFt ?? Math.min(roomHeightFt - dims.heightFt / 2, roomHeightFt * 0.68)))
  return {
    id,
    ...snapshotCatalogItem(item),
    xFt: hit.x + hit.nx * hit.side * (wallThicknessFt / 2 + dims.depthFt / 2),
    yFt,
    zFt: hit.z + hit.nz * hit.side * (wallThicknessFt / 2 + dims.depthFt / 2),
    rotationY: normalizeAngle(rotationY),
    surface: 'wall',
    c: hit.c,
    s: hit.s,
    t: hit.t,
  }
}

export function movePlacedOnFloor(placed: SketchPlacedCatalogItem, point: CatalogWorldPoint, dims: CatalogDimsFt, model: { cellFt?: number; contours: Contour[] }, wallThicknessFt: number, rotationY = placed.rotationY): SketchPlacedCatalogItem {
  const nearest = nearestCatalogWall(model, point)
  const snapDistance = Math.max(FLOOR_WALL_SNAP_FT, dims.depthFt / 2 + wallThicknessFt + 0.5)
  if (nearest && nearest.distanceFt <= snapDistance) {
    return {
      ...placed,
      xFt: nearest.x + nearest.nx * nearest.side * (wallThicknessFt / 2 + dims.depthFt / 2),
      yFt: dims.heightFt / 2,
      zFt: nearest.z + nearest.nz * nearest.side * (wallThicknessFt / 2 + dims.depthFt / 2),
      rotationY: normalizeAngle(nearest.rotationY),
      surface: 'floor',
      c: nearest.c,
      s: nearest.s,
      t: nearest.t,
    }
  }
  const next: SketchPlacedCatalogItem = {
    ...placed,
    xFt: point.x,
    yFt: dims.heightFt / 2,
    zFt: point.z,
    rotationY: normalizeAngle(rotationY),
    surface: 'floor',
  }
  delete next.c
  delete next.s
  delete next.t
  return next
}

export function movePlacedOnCeiling(placed: SketchPlacedCatalogItem, point: CatalogWorldPoint, dims: CatalogDimsFt, roomHeightFt: number, rotationY = placed.rotationY): SketchPlacedCatalogItem {
  const next: SketchPlacedCatalogItem = {
    ...placed,
    xFt: point.x,
    yFt: Math.max(dims.heightFt / 2, roomHeightFt - dims.heightFt / 2),
    zFt: point.z,
    rotationY: normalizeAngle(rotationY),
    surface: 'ceiling',
  }
  delete next.c
  delete next.s
  delete next.t
  return next
}

export function movePlacedOnWall(placed: SketchPlacedCatalogItem, hit: CatalogWallHit, dims: CatalogDimsFt, roomHeightFt: number, wallThicknessFt: number, rotationY = hit.rotationY): SketchPlacedCatalogItem {
  const yFt = Math.max(dims.heightFt / 2, Math.min(roomHeightFt - dims.heightFt / 2, hit.yFt ?? Math.min(roomHeightFt - dims.heightFt / 2, roomHeightFt * 0.68)))
  return {
    ...placed,
    xFt: hit.x + hit.nx * hit.side * (wallThicknessFt / 2 + dims.depthFt / 2),
    yFt,
    zFt: hit.z + hit.nz * hit.side * (wallThicknessFt / 2 + dims.depthFt / 2),
    rotationY: normalizeAngle(rotationY),
    surface: 'wall',
    c: hit.c,
    s: hit.s,
    t: hit.t,
  }
}

export function rotatePlacedCatalogItem(placed: SketchPlacedCatalogItem): SketchPlacedCatalogItem {
  return { ...placed, rotationY: normalizeAngle(placed.rotationY + Math.PI / 2) }
}

export function placedCatalogFootprint(placed: SketchPlacedCatalogItem, dims: CatalogDimsFt) {
  const c = Math.cos(placed.rotationY)
  const s = Math.sin(placed.rotationY)
  const width = Math.abs(c) * dims.widthFt + Math.abs(s) * dims.depthFt
  const depth = Math.abs(s) * dims.widthFt + Math.abs(c) * dims.depthFt
  return {
    minX: placed.xFt - width / 2,
    maxX: placed.xFt + width / 2,
    minZ: placed.zFt - depth / 2,
    maxZ: placed.zFt + depth / 2,
    width,
    depth,
  }
}

export function placedCatalogDoesNotFit(placed: SketchPlacedCatalogItem, dims: CatalogDimsFt, bounds: CatalogSceneBounds, roomHeightFt: number, wallLengthFt?: number): boolean {
  if (dims.heightFt > roomHeightFt + 0.001) return true
  if (placed.surface === 'wall') {
    return wallLengthFt !== undefined && dims.widthFt > wallLengthFt + 0.001
  }
  if (dims.widthFt > bounds.width + 0.001 || dims.depthFt > bounds.depth + 0.001) return true
  const footprint = placedCatalogFootprint(placed, dims)
  return footprint.minX < bounds.minX - 0.001 || footprint.maxX > bounds.maxX + 0.001 || footprint.minZ < bounds.minZ - 0.001 || footprint.maxZ > bounds.maxZ + 0.001
}
