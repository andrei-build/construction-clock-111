import { supabase } from '../../lib/supabase'
import type { Profile, ProjectMaterial } from '../../lib/types'
import { cabinetDisplayCode, isCabinetPlacedItem } from './cabinetCodes'
import { formatInches } from './inches'
import {
  finishCoverageRegionsFt,
  normalizeFinishes,
  normalizeTileSurface,
  type Contour,
  type SketchFinishRegion,
  type Opening,
  type SketchFinishes,
  type SketchSwitch,
  type SketchSurfaceFinish,
} from './sketchFinishes'
import {
  isOutletPlacedCatalogItem,
  isShowerPanPlacedCatalogItem,
  isSwitchPlacedCatalogItem,
  showerPanTileSurfaceStats,
  type SketchPlacedCatalogItem,
} from './sketchCatalog'
import {
  TILE_MATERIAL_SECTION,
  calculateTileMaterials,
  type TileCalcItem,
  type TileCalcPattern,
  type TileCalcResult,
} from './tileCalc'

export { TILE_MATERIAL_SECTION } from './tileCalc'

export const WALL_MATERIAL_SECTION = 'Стены-краска'
export const CABINET_MATERIAL_SECTION = 'Кабинеты'
export const ELECTRICAL_MATERIAL_SECTION = 'Электрика'
export const SKETCH_MATERIAL_SECTIONS = [
  TILE_MATERIAL_SECTION,
  WALL_MATERIAL_SECTION,
  CABINET_MATERIAL_SECTION,
  ELECTRICAL_MATERIAL_SECTION,
] as const

export type SketchMaterialSection = typeof SKETCH_MATERIAL_SECTIONS[number]

export type SketchMaterialModel = {
  cellFt?: number
  height?: number
  contours: Contour[]
  openings?: Opening[]
  finishes?: SketchFinishes
  placedItems?: SketchPlacedCatalogItem[]
  switches?: SketchSwitch[]
}

export type SketchContourStat = {
  index: number
  area: number
  perimeter: number
  closed: true
}

export type SketchTileArea = {
  key: string
  label: string
  areaSqft: number
  perimeterLnft: number | null
  tileWIn: number
  tileHIn: number
  jointIn: number
  tileThicknessIn: number
  pattern: TileCalcPattern
  catalogItemId?: string
}

export type SketchMaterialFacts = {
  wallAreaSqft: number
  openingAreaSqft: number
  tileAreaSqft: number
  paintAreaSqft: number
  patchAreaSqft: number
  tileAreas: SketchTileArea[]
  contours: SketchContourStat[]
}

export type SketchMaterialRow = {
  section: SketchMaterialSection
  name: string
  qty: number | null
  unit: string | null
  note: string | null
}

export type WallMaterialRpcInput = {
  paintAreaSqft: number
  patchAreaSqft: number
  includePrimer: boolean
  includeTexture: boolean
}

export type WallMaterialItem = {
  key: string
  name: string
  qty: number | null
  unit: string | null
  detail: string | null
}

export type WallMaterialResult = {
  items: WallMaterialItem[]
}

export type SketchMaterialLabels = {
  outletName?: string
  switchName?: string
  eachUnit?: string
}

export type SketchMaterialsResult = {
  facts: SketchMaterialFacts
  tileResults: Array<{ area: SketchTileArea; result: TileCalcResult }>
  wallResult: WallMaterialResult | null
  rows: SketchMaterialRow[]
}

const PROJECT_MATERIAL_SELECT =
  'id, org_id, project_id, section, name, qty, unit, supplier, url, note, sort_order, status, task_id, created_by, created_at, updated_at, deleted_at'
const DEFAULT_WALL_HEIGHT_FT = 8
const DEFAULT_TILE_THICKNESS_IN = 0.3125
const AREA_EPS = 0.01

function finite(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function positive(value: unknown): number | null {
  const n = finite(value)
  return n !== null && n > 0 ? n : null
}

function modelCellFt(model: Pick<SketchMaterialModel, 'cellFt'>): number {
  const cell = positive(model.cellFt)
  return cell ?? 1
}

function wallHeightFt(model: Pick<SketchMaterialModel, 'height'>): number {
  const height = positive(model.height)
  return height ?? DEFAULT_WALL_HEIGHT_FT
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function contourAreaCells(contour: Contour): number {
  if (!contour.closed || contour.points.length < 3) return 0
  let sum = 0
  const points = contour.points
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

function contourPerimeterCells(contour: Contour): number {
  if (!contour.closed || contour.points.length < 3) return 0
  let total = 0
  for (let i = 1; i < contour.points.length; i++) total += dist(contour.points[i - 1], contour.points[i])
  total += dist(contour.points[contour.points.length - 1], contour.points[0])
  return total
}

export function buildSketchContourStats(model: SketchMaterialModel): { perContour: SketchContourStat[]; totalArea: number; totalPerimeter: number } {
  const cellFt = modelCellFt(model)
  const perContour = model.contours
    .map((contour, index): SketchContourStat | null => {
      const area = contourAreaCells(contour) * cellFt * cellFt
      const perimeter = contourPerimeterCells(contour) * cellFt
      if (!contour.closed || area <= AREA_EPS || perimeter <= AREA_EPS) return null
      return { index, area, perimeter, closed: true }
    })
    .filter((item): item is SketchContourStat => !!item)
  return {
    perContour,
    totalArea: perContour.reduce((sum, contour) => sum + contour.area, 0),
    totalPerimeter: perContour.reduce((sum, contour) => sum + contour.perimeter, 0),
  }
}

function eachValidSegment(model: SketchMaterialModel): Array<{ c: number; s: number; lengthFt: number }> {
  const cellFt = modelCellFt(model)
  const validContourIndexes = new Set(buildSketchContourStats(model).perContour.map((contour) => contour.index))
  const out: Array<{ c: number; s: number; lengthFt: number }> = []
  model.contours.forEach((contour, c) => {
    if (!validContourIndexes.has(c)) return
    for (let s = 0; s < contour.points.length - 1; s++) {
      const lengthFt = dist(contour.points[s], contour.points[s + 1]) * cellFt
      if (lengthFt > AREA_EPS) out.push({ c, s, lengthFt })
    }
    const last = contour.points[contour.points.length - 1]
    const first = contour.points[0]
    const closingLengthFt = dist(last, first) * cellFt
    if (closingLengthFt > AREA_EPS) out.push({ c, s: contour.points.length - 1, lengthFt: closingLengthFt })
  })
  return out
}

function segmentLengthFt(model: SketchMaterialModel, c: number, s: number): number | null {
  const contour = model.contours[c]
  if (!contour?.closed || contour.points.length < 3) return null
  const a = contour.points[s]
  const b = s + 1 < contour.points.length ? contour.points[s + 1] : contour.points[0]
  if (!a || !b) return null
  const length = dist(a, b) * modelCellFt(model)
  return length > AREA_EPS ? length : null
}

function openingWidthFt(model: SketchMaterialModel, opening: Opening): number {
  const segLen = segmentLengthFt(model, opening.c, opening.s)
  if (segLen === null) return 0
  const fallback = opening.kind === 'door' ? 32 / 12 : 36 / 12
  return Math.max(0, Math.min(positive(opening.w) ?? fallback, segLen))
}

function openingHeightFt(model: SketchMaterialModel, opening: Opening): number {
  const roomHeight = wallHeightFt(model)
  const fallback = opening.kind === 'door' ? 80 / 12 : 48 / 12
  return Math.max(0, Math.min(positive(opening.h) ?? fallback, roomHeight))
}

function openingFloorFt(opening: Opening): number {
  return opening.kind === 'door' ? 0 : Math.max(0, finite(opening.sill) ?? 36 / 12)
}

function openingAreaSqft(model: SketchMaterialModel, opening: Opening): number {
  const width = openingWidthFt(model, opening)
  const height = openingHeightFt(model, opening)
  if (width <= AREA_EPS || height <= AREA_EPS) return 0
  return width * height
}

function openingRectFt(model: SketchMaterialModel, opening: Opening): SketchFinishRegion | null {
  const width = openingWidthFt(model, opening)
  const height = openingHeightFt(model, opening)
  const lengthFt = segmentLengthFt(model, opening.c, opening.s)
  if (!lengthFt || width <= AREA_EPS || height <= AREA_EPS) return null
  const openingWidth = Math.min(width, lengthFt)
  const x0 = Math.max(0, Math.min(lengthFt - openingWidth, opening.t * lengthFt - openingWidth / 2))
  const x1 = x0 + openingWidth
  const y0 = openingFloorFt(opening)
  return {
    x0Ft: x0,
    y0Ft: y0,
    x1Ft: x1,
    y1Ft: y0 + height,
  }
}

function rectOverlapSqft(a: SketchFinishRegion, b: SketchFinishRegion): number {
  const width = Math.max(0, Math.min(a.x1Ft, b.x1Ft) - Math.max(a.x0Ft, b.x0Ft))
  const height = Math.max(0, Math.min(a.y1Ft, b.y1Ft) - Math.max(a.y0Ft, b.y0Ft))
  return width > AREA_EPS && height > AREA_EPS ? width * height : 0
}

function openingRegionOverlapSqft(model: SketchMaterialModel, opening: Opening, region: SketchFinishRegion): number {
  const openingRect = openingRectFt(model, opening)
  return openingRect ? rectOverlapSqft(region, openingRect) : 0
}

function surfaceTileArea(
  model: SketchMaterialModel,
  surface: SketchSurfaceFinish,
  areaSqft: number,
  perimeterLnft: number | null,
  key: string,
  label: string,
): SketchTileArea | null {
  if (surface.kind !== 'tile' || areaSqft <= AREA_EPS) return null
  const tile = normalizeTileSurface(surface)
  return {
    key,
    label,
    areaSqft,
    perimeterLnft,
    tileWIn: positive(tile.tileWIn) ?? 12,
    tileHIn: positive(tile.tileHIn) ?? 24,
    jointIn: Math.max(0, finite(tile.groutIn) ?? 0.125),
    tileThicknessIn: DEFAULT_TILE_THICKNESS_IN,
    pattern: 'straight',
    catalogItemId: tile.catalogItemId,
  }
}

function showerPanTileArea(item: SketchPlacedCatalogItem, index: number): SketchTileArea | null {
  if (!isShowerPanPlacedCatalogItem(item) || item.panFinish?.kind !== 'tile') return null
  const stats = showerPanTileSurfaceStats(item)
  if (!stats || stats.areaSqft <= AREA_EPS) return null
  const tile = normalizeTileSurface(item.panFinish)
  return {
    key: `shower-pan:${item.id}`,
    label: item.name?.trim() || `Shower pan ${index + 1}`,
    areaSqft: stats.areaSqft,
    perimeterLnft: stats.perimeterLnft,
    tileWIn: positive(tile.tileWIn) ?? 12,
    tileHIn: positive(tile.tileHIn) ?? 24,
    jointIn: Math.max(0, finite(tile.groutIn) ?? 0.125),
    tileThicknessIn: DEFAULT_TILE_THICKNESS_IN,
    pattern: 'straight',
    catalogItemId: tile.catalogItemId,
  }
}

function collectTileAreas(model: SketchMaterialModel): SketchTileArea[] {
  const height = wallHeightFt(model)
  const finishes = normalizeFinishes(model.finishes)
  const contours = buildSketchContourStats(model)
  const tileAreas: SketchTileArea[] = []

  eachValidSegment(model).forEach((seg, index) => {
    const wallKey = `${seg.c}:${seg.s}`
    const surface = finishes.wallFinishes[wallKey] ?? finishes.walls
    if (surface.kind !== 'tile') return
    const regions = finishCoverageRegionsFt(surface, seg.lengthFt, height)
    if (regions.length === 0) return
    const openings = (model.openings ?? []).filter((opening) => opening.c === seg.c && opening.s === seg.s)
    const grossArea = regions.reduce((sum, region) => sum + (region.x1Ft - region.x0Ft) * (region.y1Ft - region.y0Ft), 0)
    const openingOverlap = regions.reduce(
      (sum, region) => sum + openings.reduce((inner, opening) => inner + openingRegionOverlapSqft(model, opening, region), 0),
      0,
    )
    const areaSqft = Math.max(0, grossArea - openingOverlap)
    const perimeterLnft = areaSqft > AREA_EPS
      ? regions.reduce((sum, region) => sum + 2 * ((region.x1Ft - region.x0Ft) + (region.y1Ft - region.y0Ft)), 0)
      : null
    const area = surfaceTileArea(model, surface, areaSqft, perimeterLnft, `wall:${wallKey}`, `Wall ${index + 1}`)
    if (area) tileAreas.push(area)
  })

  const floorTile = surfaceTileArea(
    model,
    finishes.floor,
    contours.totalArea,
    contours.totalPerimeter > AREA_EPS ? contours.totalPerimeter : null,
    'floor',
    'Floor',
  )
  if (floorTile) tileAreas.push(floorTile)

  const ceiling = (finishes as { ceiling?: SketchSurfaceFinish }).ceiling
  const ceilingTile = ceiling
    ? surfaceTileArea(
        model,
        ceiling,
        contours.totalArea,
        contours.totalPerimeter > AREA_EPS ? contours.totalPerimeter : null,
        'ceiling',
        'Ceiling',
      )
    : null
  if (ceilingTile) tileAreas.push(ceilingTile)

  ;(model.placedItems ?? []).forEach((item, index) => {
    const area = showerPanTileArea(item, index)
    if (area) tileAreas.push(area)
  })

  return tileAreas
}

function collectPatchArea(model: SketchMaterialModel): number {
  const height = wallHeightFt(model)
  const finishes = normalizeFinishes(model.finishes)
  return eachValidSegment(model).reduce((sum, seg) => {
    const wallKey = `${seg.c}:${seg.s}`
    const surface = finishes.wallFinishes[wallKey] ?? finishes.walls
    if (surface.kind !== 'drywall-patch') return sum
    const regions = finishCoverageRegionsFt(surface, seg.lengthFt, height)
    const openings = (model.openings ?? []).filter((opening) => opening.c === seg.c && opening.s === seg.s)
    const area = regions.reduce((regionSum, region) => {
      const gross = (region.x1Ft - region.x0Ft) * (region.y1Ft - region.y0Ft)
      const openingOverlap = openings.reduce((inner, opening) => inner + openingRegionOverlapSqft(model, opening, region), 0)
      return regionSum + Math.max(0, gross - openingOverlap)
    }, 0)
    return sum + area
  }, 0)
}

export function collectSketchMaterialFacts(model: SketchMaterialModel): SketchMaterialFacts {
  const height = wallHeightFt(model)
  const wallAreaSqft = eachValidSegment(model).reduce((sum, seg) => sum + seg.lengthFt * height, 0)
  const openingArea = (model.openings ?? []).reduce((sum, opening) => sum + openingAreaSqft(model, opening), 0)
  const tileAreas = collectTileAreas(model)
  const tileAreaSqft = tileAreas.reduce((sum, area) => sum + area.areaSqft, 0)
  const wallTileAreaSqft = tileAreas
    .filter((area) => area.key.startsWith('wall:'))
    .reduce((sum, area) => sum + area.areaSqft, 0)
  const patchAreaSqft = collectPatchMaterialArea(model)
  const paintAreaSqft = Math.max(0, wallAreaSqft - wallTileAreaSqft - openingArea)
  return {
    wallAreaSqft,
    openingAreaSqft: openingArea,
    tileAreaSqft,
    paintAreaSqft,
    patchAreaSqft,
    tileAreas,
    contours: buildSketchContourStats(model).perContour,
  }
}

export function collectPatchMaterialArea(model: SketchMaterialModel): number {
  return collectPatchArea(model)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function buildWallMaterialsRpcArgs(input: WallMaterialRpcInput) {
  return {
    p_paint_area_sqft: input.paintAreaSqft,
    p_patch_area_sqft: input.patchAreaSqft,
    p_include_primer: input.includePrimer,
    p_include_texture: input.includeTexture,
  }
}

export function normalizeWallMaterialsResult(value: unknown): WallMaterialResult {
  const root = asRecord(value)
  const rawItems = Array.isArray(root.items) ? root.items : []
  return {
    items: rawItems
      .map((raw) => {
        const row = asRecord(raw)
        return {
          key: stringOrNull(row.key) ?? stringOrNull(row.name) ?? 'item',
          name: stringOrNull(row.name) ?? '',
          qty: numOrNull(row.qty),
          unit: stringOrNull(row.unit),
          detail: stringOrNull(row.detail),
        }
      })
      .filter((row) => row.name),
  }
}

export async function calculateWallMaterials(input: WallMaterialRpcInput): Promise<WallMaterialResult> {
  const { data, error } = await supabase.rpc('calc_wall_materials', buildWallMaterialsRpcArgs(input))
  if (error) throw error
  return normalizeWallMaterialsResult(data)
}

function rowKey(row: SketchMaterialRow): string {
  return [row.section, row.name.trim().toLowerCase(), row.unit ?? ''].join('|')
}

export function aggregateSketchMaterialRows(rows: SketchMaterialRow[]): SketchMaterialRow[] {
  const byKey = new Map<string, SketchMaterialRow>()
  rows.forEach((row) => {
    if (!row.name.trim()) return
    const key = rowKey(row)
    const current = byKey.get(key)
    if (!current) {
      byKey.set(key, { ...row })
      return
    }
    const qty = current.qty != null && row.qty != null ? current.qty + row.qty : current.qty ?? row.qty
    const notes = [current.note, row.note].filter((note): note is string => !!note?.trim())
    current.qty = qty
    current.note = Array.from(new Set(notes)).join('; ') || null
  })
  return Array.from(byKey.values())
}

function tileItemsToRows(tileResults: Array<{ area: SketchTileArea; result: TileCalcResult }>): SketchMaterialRow[] {
  const rows: SketchMaterialRow[] = []
  tileResults.forEach(({ area, result }) => {
    result.items.forEach((item: TileCalcItem) => {
      const detail = [item.detail, `${area.label}: ${area.areaSqft.toFixed(1)} ft²`].filter(Boolean).join(' · ')
      rows.push({
        section: TILE_MATERIAL_SECTION,
        name: item.name,
        qty: item.qty,
        unit: item.unit,
        note: detail || null,
      })
    })
  })
  return rows
}

function wallItemsToRows(result: WallMaterialResult | null): SketchMaterialRow[] {
  return (result?.items ?? []).map((item) => ({
    section: WALL_MATERIAL_SECTION,
    name: item.name,
    qty: item.qty,
    unit: item.unit,
    note: item.detail,
  }))
}

function cabinetDimsNote(item: SketchPlacedCatalogItem): string | null {
  const width = positive(item.widthIn)
  const height = positive(item.heightIn)
  const depth = positive(item.depthIn)
  if (!width || !height || !depth) return null
  return `${formatInches(width)} W × ${formatInches(height)} H × ${formatInches(depth)} D`
}

export function buildCabinetMaterialRows(model: SketchMaterialModel, labels: SketchMaterialLabels = {}): SketchMaterialRow[] {
  const eachUnit = labels.eachUnit ?? 'ea'
  const groups = new Map<string, { code: string; count: number; note: string | null }>()
  ;(model.placedItems ?? []).filter(isCabinetPlacedItem).forEach((item) => {
    const code = cabinetDisplayCode(item).trim()
    if (!code) return
    const existing = groups.get(code)
    if (existing) {
      existing.count += 1
      return
    }
    groups.set(code, { code, count: 1, note: cabinetDimsNote(item) })
  })
  return Array.from(groups.values()).map((group) => ({
    section: CABINET_MATERIAL_SECTION,
    name: group.code,
    qty: group.count,
    unit: eachUnit,
    note: group.note,
  }))
}

export function buildElectricalMaterialRows(model: SketchMaterialModel, labels: SketchMaterialLabels = {}): SketchMaterialRow[] {
  const outletCount = (model.placedItems ?? []).filter(isOutletPlacedCatalogItem).length
  const placedSwitchCount = (model.placedItems ?? []).filter(isSwitchPlacedCatalogItem).length
  const legacySwitchCount = (model.switches ?? []).length
  const eachUnit = labels.eachUnit ?? 'ea'
  const rows: SketchMaterialRow[] = []
  if (outletCount > 0) {
    rows.push({
      section: ELECTRICAL_MATERIAL_SECTION,
      name: labels.outletName ?? 'Outlet',
      qty: outletCount,
      unit: eachUnit,
      note: null,
    })
  }
  if (placedSwitchCount + legacySwitchCount > 0) {
    rows.push({
      section: ELECTRICAL_MATERIAL_SECTION,
      name: labels.switchName ?? 'Switch',
      qty: placedSwitchCount + legacySwitchCount,
      unit: eachUnit,
      note: null,
    })
  }
  return rows
}

export async function calculateSketchMaterials(
  model: SketchMaterialModel,
  options: {
    includePrimer: boolean
    includeTexture: boolean
    labels?: SketchMaterialLabels
  },
): Promise<SketchMaterialsResult> {
  const facts = collectSketchMaterialFacts(model)
  const tileResults: Array<{ area: SketchTileArea; result: TileCalcResult }> = []
  for (const area of facts.tileAreas) {
    const result = await calculateTileMaterials({
      areaSqft: area.areaSqft,
      tileWIn: area.tileWIn,
      tileHIn: area.tileHIn,
      jointIn: area.jointIn,
      tileThicknessIn: area.tileThicknessIn,
      pattern: area.pattern,
      boxSqft: null,
      pricePerBox: null,
      catalogItemId: area.catalogItemId ?? null,
      perimeterLnft: area.perimeterLnft,
      includeSubstrate: false,
      includeWaterproofing: false,
    })
    tileResults.push({ area, result })
  }

  const wallResult = facts.paintAreaSqft > AREA_EPS || facts.patchAreaSqft > AREA_EPS
    ? await calculateWallMaterials({
        paintAreaSqft: facts.paintAreaSqft,
        patchAreaSqft: facts.patchAreaSqft,
        includePrimer: options.includePrimer,
        includeTexture: options.includeTexture,
      })
    : null

  const rows = aggregateSketchMaterialRows([
    ...tileItemsToRows(tileResults),
    ...wallItemsToRows(wallResult),
    ...buildCabinetMaterialRows(model, options.labels),
    ...buildElectricalMaterialRows(model, options.labels),
  ])

  return { facts, tileResults, wallResult, rows }
}

async function nextMaterialSortOrder(projectId: string): Promise<number> {
  const { data } = await supabase.from('project_materials')
    .select('sort_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  const max = (data as { sort_order: number | null } | null)?.sort_order
  return (typeof max === 'number' ? max : -1) + 1
}

export async function appendSketchMaterialRows(
  profile: Profile,
  projectId: string,
  rows: SketchMaterialRow[],
): Promise<ProjectMaterial[]> {
  const inputs = rows.filter((row) => row.name.trim())
  if (inputs.length === 0) return []
  const base = await nextMaterialSortOrder(projectId)
  const payload = inputs.map((row, idx) => ({
    org_id: profile.org_id,
    project_id: projectId,
    section: row.section,
    name: row.name,
    qty: row.qty,
    unit: row.unit,
    status: 'plan',
    note: row.note,
    sort_order: base + idx,
    created_by: profile.id,
  }))
  const { data, error } = await supabase.from('project_materials')
    .insert(payload)
    .select(PROJECT_MATERIAL_SELECT)
    .order('sort_order', { ascending: true })
  if (error) throw error
  return (data as unknown as ProjectMaterial[]) ?? []
}
