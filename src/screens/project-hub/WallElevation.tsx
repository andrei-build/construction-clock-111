import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useI18n } from '../../lib/i18n'
import {
  DEFAULT_DOOR_HEIGHT_FT,
  DEFAULT_DOOR_WIDTH_FT,
  DEFAULT_WINDOW_HEIGHT_FT,
  DEFAULT_WINDOW_SILL_FT,
  DEFAULT_WINDOW_WIDTH_FT,
  DEFAULT_GROUT_COLOR,
  DEFAULT_TILE_COLOR,
  DEFAULT_WALL_PAINT,
  cleanColor,
  finishCoverageBoundsFt,
  finishCoverageRegionsFt,
  normalizeFinishRegions,
  normalizeDrywallPatchSurface,
  normalizeFinishes,
  normalizeTileSurface,
  resizeSketchSegmentToLength,
  type Opening,
  type Pt,
  type Sketch3DModel,
  type SketchFinishRegion,
  type SketchMeasurement,
  type SketchSegmentResizeAnchor,
  type SketchSegmentResizeConflict,
  type SketchSurfaceFinish,
} from './sketchFinishes'
import { formatFeetInches, formatInches, parseFeetInches, snapFeetToPrecision } from './inches'
import {
  codeClearanceItemIds,
  formatCodeClearanceMessage,
  getCodeClearanceChecks,
  type CodeClearanceCheck,
} from './code-clearances'
import {
  isShowerPanPlacedCatalogItem,
  isToiletPlacedCatalogItem,
  sanitizePlacedCatalogItems,
  showerPanShapeFromPlacedItem,
  type SketchPlacedCatalogItem,
  type SketchShowerPanShape,
} from './sketchCatalog'
import {
  CABINET_COUNTERTOP_HEIGHT_IN,
  CABINET_TOE_KICK_IN,
  CABINET_WALL_BOTTOM_IN,
  cabinetDisplayCode,
  isCabinetPlacedItem,
} from './cabinetCodes'
import {
  CABINET_CATALOG_STANDARD_WIDTHS_IN,
  CABINET_CATALOG_WALL_HEIGHTS_IN,
} from './cabinetCatalog'
import { resolveOpeningTrim, trimProfileById } from './trimCatalog'

const CELL_FT = 1

type WallElevationWall = {
  c: number
  s: number
  a: Pt
  b: Pt
}

interface WallElevationProps {
  model: Sketch3DModel & { placedItems?: SketchPlacedCatalogItem[] }
  wall: WallElevationWall
  heightFt: number
  finish: SketchSurfaceFinish
  canEdit?: boolean
  compact?: boolean
  snapStepFt?: number
  codeCheckEnabled?: boolean
  onMeasurementsChange?: (measurements: SketchMeasurement[]) => void
  onModelChange?: (model: Sketch3DModel & { placedItems?: SketchPlacedCatalogItem[] }) => void
  onCabinetResize?: (item: SketchPlacedCatalogItem, widthIn: number, wallHeightIn?: number) => void
  onCabinetRemove?: (item: SketchPlacedCatalogItem) => void
  onBack?: () => void
  toolbarExtras?: ReactNode
  toolbarEnd?: ReactNode
  sidePanel?: ReactNode
}

type ElevationPoint = { x: number; y: number }
type ElevationMeasurementLine = {
  x1: number
  y1: number
  x2: number
  y2: number
  labelX: number
  labelY: number
  angle: number
  text: string
}
type ElevationOpeningBox = {
  x: number
  y: number
  width: number
  openingHeight: number
  floor: number
}
type ElevationOpeningDim = {
  x1: number
  x2: number
  y: number
  text: string
  gap: boolean
}
type ElevationPlacedItem = {
  item: SketchPlacedCatalogItem
  x: number
  y: number
  width: number
  height: number
  warning: boolean
  toilet: boolean
  showerPan: boolean
  showerPanShape: SketchShowerPanShape
  cabinet: boolean
  cabinetCode: string
  filler: boolean
  layer?: 'base' | 'wall'
}
type FinishRegionHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type FinishRegionDraftField = 'left' | 'bottom' | 'width' | 'height'
type FinishRegionDrag =
  | { type: 'draw'; pointerId: number; start: ElevationPoint; current: ElevationPoint }
  | { type: 'move'; pointerId: number; index: number; start: ElevationPoint; current: ElevationPoint; original: SketchFinishRegion }
  | { type: 'resize'; pointerId: number; index: number; handle: FinishRegionHandle; start: ElevationPoint; current: ElevationPoint; original: SketchFinishRegion }

const FINISH_REGION_MIN_FT = 1 / 96
const FINISH_REGION_HANDLES: FinishRegionHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

function modelCellFt(model: Sketch3DModel): number {
  return Number.isFinite(model.cellFt) && model.cellFt > 0 ? model.cellFt : CELL_FT
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function openingWidthFt(opening: Opening): number {
  return opening.w ?? (opening.kind === 'door' ? DEFAULT_DOOR_WIDTH_FT : DEFAULT_WINDOW_WIDTH_FT)
}

function openingHeightFt(opening: Opening): number {
  return opening.kind === 'door' ? (opening.h ?? DEFAULT_DOOR_HEIGHT_FT) : (opening.h ?? DEFAULT_WINDOW_HEIGHT_FT)
}

function openingFloorFt(opening: Opening): number {
  return opening.kind === 'door' ? 0 : (opening.sill ?? DEFAULT_WINDOW_SILL_FT)
}

function formatLength(valueFt: number): string {
  return formatFeetInches((Number.isFinite(valueFt) ? valueFt : 0) * 12)
}

function snapLengthFt(valueFt: number, stepFt: number): number {
  const step = Number.isFinite(stepFt) && stepFt > 0 ? stepFt : 1 / 96
  return Math.round(valueFt / step) * step
}

function ticks(max: number, step: number): number[] {
  const count = Math.min(240, Math.floor(max / step) + 1)
  return Array.from({ length: count }, (_, index) => index * step).filter((value) => value <= max + 0.0001)
}

function readableSvgAngle(dx: number, dy: number): number {
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI
  if (angle > 90 || angle < -90) angle += 180
  return angle
}

function wallKey(wall: WallElevationWall): string {
  return `${wall.c}:${wall.s}`
}

function finishRegionId(): string {
  return `finish-region-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function finishRegionKey(region: SketchFinishRegion, index: number): string {
  return region.id ?? `${index}:${region.x0Ft}:${region.y0Ft}:${region.x1Ft}:${region.y1Ft}`
}

function finishRegionFromPoints(a: ElevationPoint, b: ElevationPoint, id?: string): SketchFinishRegion {
  const region: SketchFinishRegion = {
    x0Ft: Math.min(a.x, b.x),
    y0Ft: Math.min(a.y, b.y),
    x1Ft: Math.max(a.x, b.x),
    y1Ft: Math.max(a.y, b.y),
  }
  if (id) region.id = id
  return region
}

function finishRegionArea(region: SketchFinishRegion): number {
  return Math.max(0, region.x1Ft - region.x0Ft) * Math.max(0, region.y1Ft - region.y0Ft)
}

function formatRegionInches(valueFt: number): string {
  return formatInches(Math.max(0, Number.isFinite(valueFt) ? valueFt : 0) * 12)
}

function formatRegionAreaSqft(areaSqft: number): string {
  const area = Math.max(0, Number.isFinite(areaSqft) ? areaSqft : 0)
  if (area >= 10) return `${Math.round(area)}`
  if (area >= 1) return area.toFixed(1).replace(/\.0$/, '')
  return area.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')
}

function finishRegionLabel(region: SketchFinishRegion) {
  const regionWidth = Math.max(0.001, region.x1Ft - region.x0Ft)
  const regionHeight = Math.max(0.001, region.y1Ft - region.y0Ft)
  const text = `${formatRegionInches(regionWidth)}×${formatRegionInches(regionHeight)}, ${formatRegionAreaSqft(finishRegionArea(region))} sqft`
  const inset = Math.max(0.006, Math.min(0.08, Math.min(regionWidth, regionHeight) * 0.12))
  const maxTextWidth = Math.max(0.001, regionWidth - inset * 2)
  const maxTextHeight = Math.max(0.001, regionHeight - inset * 2)
  const fontSize = Math.max(0.01, Math.min(0.24, maxTextHeight * 0.58, maxTextWidth / Math.max(1, text.length * 0.58)))
  const padX = Math.max(0.003, Math.min(inset, fontSize * 0.55))
  const padY = Math.max(0.002, Math.min(inset, fontSize * 0.32))
  const textLength = Math.max(0.001, Math.min(text.length * fontSize * 0.58, Math.max(0.001, regionWidth - padX * 2)))
  const rectWidth = Math.max(0.001, Math.min(regionWidth, textLength + padX * 2))
  const rectHeight = Math.max(0.001, Math.min(regionHeight, fontSize * 1.45 + padY * 2))
  return {
    text,
    x: (region.x0Ft + region.x1Ft) / 2,
    y: (region.y0Ft + region.y1Ft) / 2,
    fontSize,
    textLength,
    rectWidth,
    rectHeight,
  }
}

function moveFinishRegion(region: SketchFinishRegion, dx: number, dy: number, wallLengthFt: number, wallHeightFt: number): SketchFinishRegion {
  const width = Math.max(FINISH_REGION_MIN_FT, region.x1Ft - region.x0Ft)
  const height = Math.max(FINISH_REGION_MIN_FT, region.y1Ft - region.y0Ft)
  const x0 = Math.max(0, Math.min(Math.max(0, wallLengthFt - width), region.x0Ft + dx))
  const y0 = Math.max(0, Math.min(Math.max(0, wallHeightFt - height), region.y0Ft + dy))
  const out: SketchFinishRegion = { x0Ft: x0, y0Ft: y0, x1Ft: x0 + width, y1Ft: y0 + height }
  if (region.id) out.id = region.id
  return out
}

function resizeFinishRegion(region: SketchFinishRegion, handle: FinishRegionHandle, dx: number, dy: number): SketchFinishRegion {
  const out: SketchFinishRegion = { ...region }
  if (handle.includes('w')) out.x0Ft = region.x0Ft + dx
  if (handle.includes('e')) out.x1Ft = region.x1Ft + dx
  if (handle.includes('s')) out.y0Ft = region.y0Ft + dy
  if (handle.includes('n')) out.y1Ft = region.y1Ft + dy
  return out
}

function finishRegionHandlePoint(region: SketchFinishRegion, handle: FinishRegionHandle): ElevationPoint {
  const x = handle.includes('w') ? region.x0Ft : handle.includes('e') ? region.x1Ft : (region.x0Ft + region.x1Ft) / 2
  const y = handle.includes('s') ? region.y0Ft : handle.includes('n') ? region.y1Ft : (region.y0Ft + region.y1Ft) / 2
  return { x, y }
}

function itemAxes(item: SketchPlacedCatalogItem): { side: { x: number; z: number }; forward: { x: number; z: number } } {
  const c = Math.cos(item.rotationY)
  const s = Math.sin(item.rotationY)
  return {
    side: { x: c, z: -s },
    forward: { x: s, z: c },
  }
}

function itemFootprintCorners(item: SketchPlacedCatalogItem, widthFt: number, depthFt: number) {
  const axes = itemAxes(item)
  const halfW = widthFt / 2
  const halfD = depthFt / 2
  return [
    { x: item.xFt - axes.side.x * halfW - axes.forward.x * halfD, z: item.zFt - axes.side.z * halfW - axes.forward.z * halfD },
    { x: item.xFt + axes.side.x * halfW - axes.forward.x * halfD, z: item.zFt + axes.side.z * halfW - axes.forward.z * halfD },
    { x: item.xFt + axes.side.x * halfW + axes.forward.x * halfD, z: item.zFt + axes.side.z * halfW + axes.forward.z * halfD },
    { x: item.xFt - axes.side.x * halfW + axes.forward.x * halfD, z: item.zFt - axes.side.z * halfW + axes.forward.z * halfD },
  ]
}

function elevationPlacedItems(
  model: Sketch3DModel & { placedItems?: SketchPlacedCatalogItem[] },
  wall: WallElevationWall,
  lengthFt: number,
  height: number,
  warningIds: Set<string>,
): ElevationPlacedItem[] {
  const cellFt = modelCellFt(model)
  const ax = wall.a.x * cellFt
  const az = wall.a.y * cellFt
  const bx = wall.b.x * cellFt
  const bz = wall.b.y * cellFt
  const wallLen = Math.hypot(bx - ax, bz - az)
  if (wallLen <= 0.001) return []
  const ux = (bx - ax) / wallLen
  const uz = (bz - az) / wallLen
  return sanitizePlacedCatalogItems(model.placedItems)
    .map((item): ElevationPlacedItem | null => {
      if (item.surface === 'ceiling' || item.category === 'light' || item.category === 'fan') return null
      if (item.c !== wall.c || item.s !== wall.s) return null
      const widthIn = Number(item.widthIn)
      const depthIn = Number(item.depthIn)
      const heightIn = Number(item.heightIn)
      if (!Number.isFinite(widthIn) || !Number.isFinite(depthIn) || !Number.isFinite(heightIn) || widthIn <= 0 || depthIn <= 0 || heightIn <= 0) return null
      const widthFt = widthIn / 12
      const depthFt = depthIn / 12
      const heightFt = Math.min(height, heightIn / 12)
      const projections = itemFootprintCorners(item, widthFt, depthFt).map((point) => (point.x - ax) * ux + (point.z - az) * uz)
      const minX = Math.max(0, Math.min(lengthFt, Math.min(...projections)))
      const maxX = Math.max(0, Math.min(lengthFt, Math.max(...projections)))
      const projectedWidth = Math.max(0.12, maxX - minX)
      const centerX = Number.isFinite(item.t) ? Math.max(0, Math.min(lengthFt, (item.t ?? 0.5) * lengthFt)) : (minX + maxX) / 2
      const bottomFt = Math.max(0, Math.min(height, Number.isFinite(item.yFt) ? item.yFt - heightFt / 2 : 0))
      const drawnHeight = Math.min(heightFt, Math.max(0.08, height - bottomFt))
      const cabinet = isCabinetPlacedItem(item)
      return {
        item,
        x: Math.max(0, Math.min(lengthFt - projectedWidth, centerX - projectedWidth / 2)),
        y: Math.max(0, height - bottomFt - drawnHeight),
        width: projectedWidth,
        height: drawnHeight,
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
    .filter((item): item is ElevationPlacedItem => !!item)
}

function elevationMeasurementLine(measurement: SketchMeasurement, height: number): ElevationMeasurementLine | null {
  const x1 = measurement.a.x
  const y1 = height - measurement.a.y
  const x2 = measurement.b.x
  const y2 = height - measurement.b.y
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy)
  if (len <= 0.001) return null
  return {
    x1,
    y1,
    x2,
    y2,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2,
    angle: readableSvgAngle(dx, dy),
    text: formatLength(len),
  }
}

function elevationOpeningBox(opening: Opening, lengthFt: number, height: number): ElevationOpeningBox {
  const width = Math.min(openingWidthFt(opening), lengthFt)
  const openingHeight = Math.min(openingHeightFt(opening), height)
  const floor = Math.min(openingFloorFt(opening), Math.max(0, height - openingHeight))
  const x = Math.max(0, Math.min(lengthFt - width, opening.t * lengthFt - width / 2))
  const y = height - floor - openingHeight
  return { x, y, width, openingHeight, floor }
}

function elevationOpeningDims(
  openings: Opening[],
  opening: Opening,
  index: number,
  lengthFt: number,
  height: number,
  t: (key: string) => string,
): ElevationOpeningDim[] {
  const box = elevationOpeningBox(opening, lengthFt, height)
  const above = box.y > 0.55
  const baseY = above
    ? box.y - 0.28 - (index % 2) * 0.18
    : Math.min(height + 0.34 + (index % 2) * 0.18, height + 0.82)
  const gapY = above ? baseY - 0.22 : baseY + 0.22
  const dims: ElevationOpeningDim[] = []
  const push = (x1: number, x2: number, y: number, text: string, gap: boolean) => {
    if (x2 - x1 <= 0.05) return
    dims.push({ x1, x2, y, text, gap })
  }

  push(0, box.x, baseY, `${t('hub_sketch_dim_left_short')} ${formatLength(box.x)}`, false)
  push(box.x + box.width, lengthFt, baseY, `${t('hub_sketch_dim_right_short')} ${formatLength(lengthFt - box.x - box.width)}`, false)

  const boxes = openings.map((item, itemIndex) => ({ index: itemIndex, box: elevationOpeningBox(item, lengthFt, height) }))
  const left = boxes
    .filter((item) => item.index !== index && item.box.x + item.box.width <= box.x + 0.001)
    .sort((a, b) => (b.box.x + b.box.width) - (a.box.x + a.box.width))[0]
  const right = boxes
    .filter((item) => item.index !== index && item.box.x >= box.x + box.width - 0.001)
    .sort((a, b) => a.box.x - b.box.x)[0]
  if (left) {
    const from = left.box.x + left.box.width
    push(from, box.x, gapY, `${t('hub_sketch_dim_gap_short')} ${formatLength(box.x - from)}`, true)
  }
  if (right) {
    const to = right.box.x
    push(box.x + box.width, to, gapY, `${t('hub_sketch_dim_gap_short')} ${formatLength(to - box.x - box.width)}`, true)
  }

  return dims
}

export default function WallElevation({ model, wall, heightFt, finish, canEdit = false, compact = false, snapStepFt = 1 / 96, codeCheckEnabled = true, onMeasurementsChange, onModelChange, onCabinetResize, onCabinetRemove, onBack, toolbarExtras, toolbarEnd, sidePanel }: WallElevationProps) {
  const { t } = useI18n()
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [measureTool, setMeasureTool] = useState(false)
  const [zoneTool, setZoneTool] = useState(false)
  const [selectedCabinetId, setSelectedCabinetId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [showMeasurements, setShowMeasurements] = useState(true)
  const [draft, setDraft] = useState<ElevationPoint | null>(null)
  const [hover, setHover] = useState<ElevationPoint | null>(null)
  const [selectedMeasurementIndex, setSelectedMeasurementIndex] = useState<number | null>(null)
  const [selectedRegionIndex, setSelectedRegionIndex] = useState<number | null>(null)
  const [regionDrag, setRegionDrag] = useState<FinishRegionDrag | null>(null)
  const [regionDrafts, setRegionDrafts] = useState<Partial<Record<FinishRegionDraftField, string>>>({})
  const [wallLengthDraft, setWallLengthDraft] = useState<string | null>(null)
  const [wallLengthConflict, setWallLengthConflict] = useState<SketchSegmentResizeConflict | null>(null)
  const cellFt = modelCellFt(model)
  const lengthFt = Math.max(0.01, dist(wall.a, wall.b) * cellFt)
  const height = Math.max(1, heightFt)
  const wallLengthText = formatLength(lengthFt)
  const openings = useMemo(
    () => model.openings.filter((opening) => opening.c === wall.c && opening.s === wall.s),
    [model.openings, wall.c, wall.s],
  )
  const pad = Math.max(0.5, Math.min(1.2, Math.max(lengthFt, height) * 0.08))
  const zoomLevel = Math.max(1, Math.min(6, zoom))
  const viewBoxW = (lengthFt + pad * 2) / zoomLevel
  const viewBoxH = (height + pad * 2) / zoomLevel
  const viewBox = `${lengthFt / 2 - viewBoxW / 2} ${height / 2 - viewBoxH / 2} ${viewBoxW} ${viewBoxH}`
  const isTile = finish.kind === 'tile'
  const tile = isTile ? normalizeTileSurface(finish) : null
  const patternId = `wall-elevation-tile-${wall.c}-${wall.s}`
  const patch = finish.kind === 'drywall-patch' ? normalizeDrywallPatchSurface(finish) : null
  const finishCoverage = finishCoverageBoundsFt(finish, height)
  const surfaceFill = isTile ? `url(#${patternId})` : cleanColor(finish.kind === 'paint' ? finish.color : patch?.patchColor, DEFAULT_WALL_PAINT)
  const baseFill = patch ? cleanColor(patch.baseColor, DEFAULT_WALL_PAINT) : DEFAULT_WALL_PAINT
  const groutColor = cleanColor(tile?.groutColor, DEFAULT_GROUT_COLOR)
  const tileColor = cleanColor(tile?.tileColor, DEFAULT_TILE_COLOR)
  const tileW = Math.max(1, tile?.tileWIn ?? 12) / 12
  const tileH = Math.max(1, tile?.tileHIn ?? 24) / 12
  const grout = Math.max(0, tile?.groutIn ?? 0.125) / 12
  const currentWallKey = wallKey(wall)
  const explicitFinishRegions = finish.coverage?.mode === 'partial'
    ? normalizeFinishRegions(finish.coverage.regions, lengthFt, height)
    : null
  const editableFinishRegions = explicitFinishRegions ?? []
  const regionEditingEnabled = canEdit && !compact && !measureTool && zoneTool && finish.coverage?.mode === 'partial'
  const dragPreviewRegions = useMemo(() => {
    if (!regionDrag) return editableFinishRegions
    if (regionDrag.type === 'draw') {
      const region = normalizeFinishRegions([finishRegionFromPoints(regionDrag.start, regionDrag.current)], lengthFt, height)[0]
      return region ? [...editableFinishRegions, region] : editableFinishRegions
    }
    const dx = regionDrag.current.x - regionDrag.start.x
    const dy = regionDrag.current.y - regionDrag.start.y
    const nextRegion = regionDrag.type === 'move'
      ? moveFinishRegion(regionDrag.original, dx, dy, lengthFt, height)
      : resizeFinishRegion(regionDrag.original, regionDrag.handle, dx, dy)
    const normalized = normalizeFinishRegions([nextRegion], lengthFt, height)[0]
    if (!normalized) return editableFinishRegions
    return editableFinishRegions.map((region, index) => (index === regionDrag.index ? normalized : region))
  }, [editableFinishRegions, height, lengthFt, regionDrag])
  const finishRegions = regionEditingEnabled && (explicitFinishRegions !== null || regionDrag)
    ? dragPreviewRegions
    : finishCoverageRegionsFt(finish, lengthFt, height)
  const selectedRegion = selectedRegionIndex !== null ? editableFinishRegions[selectedRegionIndex] ?? null : null
  const finishRegionSqft = finishRegions.reduce((sum, region) => sum + finishRegionArea(region), 0)
  const finishLabel = t(finish.kind === 'tile' ? 'hub_sketch_3d_tile' : finish.kind === 'drywall-patch' ? 'hub_sketch_3d_drywall_patch' : 'hub_sketch_3d_paint')
  const showRegionHint = regionEditingEnabled && explicitFinishRegions !== null && editableFinishRegions.length === 0 && !regionDrag
  const showFinishRegionLabels = finish.coverage?.mode === 'partial' && finishRegions.length > 0
  const codeClearanceChecks = useMemo(
    () => (codeCheckEnabled ? getCodeClearanceChecks(model) : []),
    [model, codeCheckEnabled],
  )
  const codeClearanceViolations = useMemo(
    () => codeClearanceChecks.filter((check) => !check.ok),
    [codeClearanceChecks],
  )
  const codeWarningItemIds = useMemo(() => codeClearanceItemIds(codeClearanceViolations), [codeClearanceViolations])
  const wallPlacedItems = useMemo(
    () => elevationPlacedItems(model, wall, lengthFt, height, codeWarningItemIds),
    [model, wall, lengthFt, height, codeWarningItemIds],
  )
  const wallCabinetCount = wallPlacedItems.filter((entry) => entry.cabinet).length
  // CABINETS-PLACE-13: живая размерная цепочка над рядом — посегментно + общий габарит.
  // Презентация поверх уже посчитанных ширин (item.widthIn); модель не меняется.
  const cabinetDimChains = useMemo(() => (
    (['base', 'wall'] as const)
      .map((layer) => ({
        layer,
        segs: wallPlacedItems
          .filter((entry) => entry.cabinet && entry.layer === layer)
          .sort((a, b) => a.x - b.x),
      }))
      .filter((group) => group.segs.length > 0)
  ), [wallPlacedItems])
  const cabinetEditEnabled = canEdit && !compact && !measureTool && !zoneTool && (!!onCabinetResize || !!onCabinetRemove)
  const selectedCabinet = selectedCabinetId
    ? wallPlacedItems.find((entry) => entry.cabinet && !entry.filler && entry.item.id === selectedCabinetId) ?? null
    : null
  const wallCodeViolations = useMemo(
    () => codeClearanceViolations.filter((check) => {
      const onWall = (entity: CodeClearanceCheck['subject']) => entity.wall && `${entity.wall.c}:${entity.wall.s}` === currentWallKey
      return onWall(check.subject) || onWall(check.target) || wallPlacedItems.some((entry) => entry.item.id === check.subject.id || entry.item.id === check.target.id)
    }),
    [codeClearanceViolations, currentWallKey, wallPlacedItems],
  )
  const wallMeasurements = useMemo(
    () => (model.measurements ?? [])
      .map((measurement, index) => ({ measurement, index }))
      .filter(({ measurement }) => measurement.scope === 'wall' && measurement.wallKey === currentWallKey),
    [model.measurements, currentWallKey],
  )
  const measurementLines = useMemo(
    () => wallMeasurements
      .map((entry) => ({ ...entry, line: elevationMeasurementLine(entry.measurement, height) }))
      .filter((entry): entry is { measurement: SketchMeasurement; index: number; line: ElevationMeasurementLine } => !!entry.line),
    [wallMeasurements, height],
  )
  const previewLine = draft && hover ? elevationMeasurementLine({ scope: 'wall', wallKey: currentWallKey, a: draft, b: hover }, height) : null
  const wallLengthConflictActive = wallLengthConflict?.segments.some((segment) => segment.c === wall.c && segment.s === wall.s) ?? false
  const wallDimY = height + Math.min(0.32, pad * 0.55)
  const wallDimLabelY = Math.min(height + pad - 0.12, wallDimY + 0.18)
  const wallDimInputW = Math.min(Math.max(1.55, lengthFt * 0.24), Math.max(1.2, lengthFt))
  const wallDimInputH = 0.42

  const snapToGuide = (value: number, guides: number[], threshold: number): number => {
    let best = value
    let bestDistance = threshold
    guides.forEach((guide) => {
      const distance = Math.abs(value - guide)
      if (distance <= bestDistance) {
        best = guide
        bestDistance = distance
      }
    })
    return best
  }

  const snapPointToGuides = (point: ElevationPoint): ElevationPoint => {
    const threshold = Math.max(snapStepFt * 2, 1 / 24)
    const openingBoxes = openings.map((opening) => elevationOpeningBox(opening, lengthFt, height))
    const xGuides = [0, lengthFt, ...openingBoxes.flatMap((box) => [box.x, box.x + box.width])]
    const yGuides = [0, height, ...openingBoxes.flatMap((box) => [box.floor, box.floor + box.openingHeight])]
    return {
      x: snapToGuide(point.x, xGuides, threshold),
      y: snapToGuide(point.y, yGuides, threshold),
    }
  }

  const svgPoint = (clientX: number, clientY: number): ElevationPoint | null => {
    const svg = svgRef.current
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return null
    const point = svg.createSVGPoint()
    point.x = clientX
    point.y = clientY
    const local = point.matrixTransform(matrix.inverse())
    return snapPointToGuides({
      x: snapLengthFt(Math.max(0, Math.min(lengthFt, local.x)), snapStepFt),
      y: snapLengthFt(Math.max(0, Math.min(height, height - local.y)), snapStepFt),
    })
  }

  const updateMeasurements = (nextMeasurements: SketchMeasurement[]) => {
    onMeasurementsChange?.(nextMeasurements)
  }

  const updateFinishRegions = (regions: SketchFinishRegion[], nextSelectedIndex: number | null = selectedRegionIndex) => {
    if (!onModelChange) return
    const normalizedRegions = normalizeFinishRegions(regions, lengthFt, height)
    const currentCoverage = finish.coverage?.mode === 'partial'
      ? finish.coverage
      : { mode: 'partial' as const, bottomFt: 0, heightFt: Math.min(4, height) }
    const nextSurface = {
      ...finish,
      coverage: {
        ...currentCoverage,
        mode: 'partial' as const,
        regions: normalizedRegions,
      },
    } as SketchSurfaceFinish
    const nextFinishes = normalizeFinishes(model.finishes)
    onModelChange({
      ...model,
      finishes: {
        ...nextFinishes,
        wallFinishes: {
          ...nextFinishes.wallFinishes,
          [currentWallKey]: nextSurface,
        },
      },
    })
    setSelectedRegionIndex(nextSelectedIndex !== null && normalizedRegions[nextSelectedIndex] ? nextSelectedIndex : null)
    setRegionDrafts({})
  }

  const applyRegionDrag = (drag: FinishRegionDrag): { regions: SketchFinishRegion[]; selectedIndex: number | null } | null => {
    if (drag.type === 'draw') {
      const region = normalizeFinishRegions([finishRegionFromPoints(drag.start, drag.current, finishRegionId())], lengthFt, height)[0]
      if (!region) return null
      return { regions: [...editableFinishRegions, region], selectedIndex: editableFinishRegions.length }
    }
    const dx = drag.current.x - drag.start.x
    const dy = drag.current.y - drag.start.y
    const nextRegion = drag.type === 'move'
      ? moveFinishRegion(drag.original, dx, dy, lengthFt, height)
      : resizeFinishRegion(drag.original, drag.handle, dx, dy)
    const normalized = normalizeFinishRegions([nextRegion], lengthFt, height)[0]
    if (!normalized || !editableFinishRegions[drag.index]) return null
    return {
      regions: editableFinishRegions.map((region, index) => (index === drag.index ? normalized : region)),
      selectedIndex: drag.index,
    }
  }

  const removeSelectedRegion = () => {
    if (selectedRegionIndex === null || !editableFinishRegions[selectedRegionIndex]) return
    updateFinishRegions(editableFinishRegions.filter((_, index) => index !== selectedRegionIndex), null)
  }

  const ensurePartialCoverage = () => {
    if (finish.coverage?.mode === 'partial') return
    updateFinishRegions(editableFinishRegions)
  }

  const toggleMeasureTool = () => {
    const next = !measureTool
    setMeasureTool(next)
    if (next) {
      setZoneTool(false)
      setRegionDrag(null)
      setSelectedRegionIndex(null)
    } else {
      setDraft(null)
    }
  }

  const toggleZoneTool = () => {
    const next = !zoneTool
    setZoneTool(next)
    if (next) {
      setMeasureTool(false)
      setDraft(null)
      ensurePartialCoverage()
    } else {
      setRegionDrag(null)
    }
  }

  const clearWallMeasurements = () => {
    const measurements = model.measurements ?? []
    setDraft(null)
    setSelectedMeasurementIndex(null)
    if (!measurements.some((measurement) => measurement.scope === 'wall' && measurement.wallKey === currentWallKey)) return
    updateMeasurements(measurements.filter((measurement) => !(measurement.scope === 'wall' && measurement.wallKey === currentWallKey)))
  }

  const zoomIn = () => setZoom((current) => Math.min(6, Math.round(current * 125) / 100))
  const zoomOut = () => setZoom((current) => Math.max(1, Math.round((current / 1.25) * 100) / 100))
  const zoomFit = () => setZoom(1)

  const regionDraftValue = (field: FinishRegionDraftField, fallbackFt: number): string => regionDrafts[field] ?? formatLength(fallbackFt)

  const commitRegionDraft = (field: FinishRegionDraftField) => {
    if (!selectedRegion || selectedRegionIndex === null) return
    const fallback = field === 'left'
      ? selectedRegion.x0Ft
      : field === 'bottom'
        ? selectedRegion.y0Ft
        : field === 'width'
          ? selectedRegion.x1Ft - selectedRegion.x0Ft
          : selectedRegion.y1Ft - selectedRegion.y0Ft
    const raw = regionDrafts[field] ?? formatLength(fallback)
    const parsedIn = parseFeetInches(raw)
    setRegionDrafts((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
    if (!Number.isFinite(parsedIn)) return
    const parsed = parsedIn / 12
    const width = Math.max(FINISH_REGION_MIN_FT, selectedRegion.x1Ft - selectedRegion.x0Ft)
    const regionHeight = Math.max(FINISH_REGION_MIN_FT, selectedRegion.y1Ft - selectedRegion.y0Ft)
    let nextRegion: SketchFinishRegion = { ...selectedRegion }
    if (field === 'left') {
      const x0 = Math.max(0, Math.min(Math.max(0, lengthFt - width), parsed))
      nextRegion = { ...nextRegion, x0Ft: x0, x1Ft: x0 + width }
    } else if (field === 'bottom') {
      const y0 = Math.max(0, Math.min(Math.max(0, height - regionHeight), parsed))
      nextRegion = { ...nextRegion, y0Ft: y0, y1Ft: y0 + regionHeight }
    } else if (field === 'width') {
      const nextWidth = Math.max(FINISH_REGION_MIN_FT, Math.min(Math.max(FINISH_REGION_MIN_FT, lengthFt - selectedRegion.x0Ft), parsed))
      nextRegion = { ...nextRegion, x1Ft: selectedRegion.x0Ft + nextWidth }
    } else {
      const nextHeight = Math.max(FINISH_REGION_MIN_FT, Math.min(Math.max(FINISH_REGION_MIN_FT, height - selectedRegion.y0Ft), parsed))
      nextRegion = { ...nextRegion, y1Ft: selectedRegion.y0Ft + nextHeight }
    }
    updateFinishRegions(editableFinishRegions.map((region, index) => (index === selectedRegionIndex ? nextRegion : region)), selectedRegionIndex)
  }

  const regionDraftKeyDown = (field: FinishRegionDraftField) => (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitRegionDraft(field)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setRegionDrafts((current) => {
        const next = { ...current }
        delete next[field]
        return next
      })
    }
  }

  const beginWallLengthEdit = () => {
    if (!canEdit || !onModelChange) return
    setWallLengthDraft(wallLengthText)
    setWallLengthConflict(null)
    setSelectedMeasurementIndex(null)
    setDraft(null)
    setSelectedRegionIndex(null)
  }

  const cancelWallLengthEdit = () => {
    setWallLengthDraft(null)
    setWallLengthConflict(null)
  }

  const applyWallLengthDraft = (anchor: SketchSegmentResizeAnchor = 'start') => {
    if (wallLengthDraft === null || !onModelChange) return
    const parsed = parseFeetInches(wallLengthDraft)
    if (!Number.isFinite(parsed)) {
      setWallLengthConflict({ reason: 'invalid-length', segments: [{ c: wall.c, s: wall.s }] })
      return
    }
    const result = resizeSketchSegmentToLength(model, { c: wall.c, s: wall.s }, snapFeetToPrecision(parsed / 12), { anchor })
    if (!result.ok) {
      setWallLengthConflict(result.conflict)
      return
    }
    onModelChange(result.model)
    setWallLengthDraft(null)
    setWallLengthConflict(null)
  }

  const removeMeasurement = (index: number) => {
    const measurements = model.measurements ?? []
    if (!measurements[index]) return
    updateMeasurements(measurements.filter((_, i) => i !== index))
    setSelectedMeasurementIndex(null)
    setSelectedRegionIndex(null)
    setDraft(null)
  }

  useEffect(() => {
    setDraft(null)
    setHover(null)
    setSelectedMeasurementIndex(null)
    setSelectedRegionIndex(null)
    setRegionDrafts({})
    setRegionDrag(null)
    setWallLengthDraft(null)
    setWallLengthConflict(null)
    setZoneTool(false)
    setZoom(1)
  }, [currentWallKey])

  useEffect(() => {
    if (!measureTool) {
      setDraft(null)
      setHover(null)
    }
  }, [measureTool])

  useEffect(() => {
    if (selectedRegionIndex !== null && !editableFinishRegions[selectedRegionIndex]) {
      setSelectedRegionIndex(null)
      setRegionDrafts({})
    }
  }, [editableFinishRegions, selectedRegionIndex])

  useEffect(() => {
    if (selectedCabinetId && !selectedCabinet) setSelectedCabinetId(null)
  }, [selectedCabinet, selectedCabinetId])

  useEffect(() => {
    if (!cabinetEditEnabled && selectedCabinetId) setSelectedCabinetId(null)
  }, [cabinetEditEnabled, selectedCabinetId])

  useEffect(() => {
    if (!canEdit) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return
      if (event.key === 'Escape') {
        if (selectedCabinet) {
          setSelectedCabinetId(null)
          event.preventDefault()
          return
        }
        if (measureTool) {
          if (draft) setDraft(null)
          else setMeasureTool(false)
          event.preventDefault()
          return
        }
        if (zoneTool) {
          setZoneTool(false)
          setRegionDrag(null)
          setSelectedRegionIndex(null)
          event.preventDefault()
          return
        }
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedCabinet && onCabinetRemove) {
        onCabinetRemove(selectedCabinet.item)
        setSelectedCabinetId(null)
        event.preventDefault()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedRegionIndex !== null) {
        removeSelectedRegion()
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
  }, [canEdit, measureTool, zoneTool, draft, selectedMeasurementIndex, selectedRegionIndex, selectedCabinet, onCabinetRemove, model, onMeasurementsChange, editableFinishRegions])

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!regionEditingEnabled || !onModelChange) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const point = svgPoint(event.clientX, event.clientY)
    if (!point) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setSelectedRegionIndex(null)
    setSelectedMeasurementIndex(null)
    setDraft(null)
    setRegionDrag({ type: 'draw', pointerId: event.pointerId, start: point, current: point })
    event.preventDefault()
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (regionDrag && regionDrag.pointerId === event.pointerId) {
      const point = svgPoint(event.clientX, event.clientY)
      if (point) setRegionDrag({ ...regionDrag, current: point })
      event.preventDefault()
      return
    }
    if (!canEdit || !measureTool) return
    setHover(svgPoint(event.clientX, event.clientY))
  }

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!regionDrag || regionDrag.pointerId !== event.pointerId) return
    const point = svgPoint(event.clientX, event.clientY)
    const finalDrag = point ? { ...regionDrag, current: point } : regionDrag
    const applied = applyRegionDrag(finalDrag)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    setRegionDrag(null)
    if (applied) updateFinishRegions(applied.regions, applied.selectedIndex)
    event.preventDefault()
  }

  const startRegionMove = (index: number, region: SketchFinishRegion) => (event: ReactPointerEvent<SVGRectElement>) => {
    if (!regionEditingEnabled || !onModelChange) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const point = svgPoint(event.clientX, event.clientY)
    if (!point) return
    svgRef.current?.setPointerCapture?.(event.pointerId)
    setSelectedRegionIndex(index)
    setSelectedMeasurementIndex(null)
    setDraft(null)
    setRegionDrag({ type: 'move', pointerId: event.pointerId, index, start: point, current: point, original: region })
    event.preventDefault()
    event.stopPropagation()
  }

  const startRegionResize = (index: number, region: SketchFinishRegion, handle: FinishRegionHandle) => (event: ReactPointerEvent<SVGRectElement>) => {
    if (!regionEditingEnabled || !onModelChange) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const point = svgPoint(event.clientX, event.clientY)
    if (!point) return
    svgRef.current?.setPointerCapture?.(event.pointerId)
    setSelectedRegionIndex(index)
    setSelectedMeasurementIndex(null)
    setDraft(null)
    setRegionDrag({ type: 'resize', pointerId: event.pointerId, index, handle, start: point, current: point, original: region })
    event.preventDefault()
    event.stopPropagation()
  }

  const handleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (!canEdit || !measureTool) return
    const point = svgPoint(event.clientX, event.clientY)
    if (!point) return
    setShowMeasurements(true)
    setSelectedMeasurementIndex(null)
    setSelectedRegionIndex(null)
    if (!draft) {
      setDraft(point)
      return
    }
    if (Math.hypot(point.x - draft.x, point.y - draft.y) <= 0.001) return
    const nextMeasurement: SketchMeasurement = {
      id: `measure-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      scope: 'wall',
      wallKey: currentWallKey,
      a: draft,
      b: point,
    }
    updateMeasurements([...(model.measurements ?? []), nextMeasurement])
    setSelectedMeasurementIndex((model.measurements ?? []).length)
    setDraft(null)
  }

  const deleteButtonKeyDown = (index: number) => (event: ReactKeyboardEvent<SVGGElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    removeMeasurement(index)
  }

  return (
    <div className={compact ? 'hub-sketch-elevation hub-sketch-elevation-compact' : 'hub-sketch-elevation'}>
      {!compact && (
        <div className="hub-sketch-elevation-toolbar" role="toolbar" aria-label={t('hub_sketch_elevation_toolbar')}>
          {onBack && (
            <button type="button" className="hub-sketch-elevation-toolbar-back" onClick={onBack}>
              <span aria-hidden="true">←</span>
              <span>{t('hub_sketch_elevation_back')}</span>
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className={measureTool ? 'btn small' : 'btn ghost small'}
              aria-pressed={measureTool}
              onClick={toggleMeasureTool}
            >
              <span aria-hidden="true">📏</span>
              <span>{t('hub_sketch_tool_measure')}</span>
            </button>
          )}
          {canEdit && onModelChange && (
            <button
              type="button"
              className={zoneTool ? 'btn small' : 'btn ghost small'}
              aria-pressed={zoneTool}
              onClick={toggleZoneTool}
            >
              <span aria-hidden="true">▭</span>
              <span>{t('hub_sketch_tool_zone')}</span>
            </button>
          )}
          {toolbarExtras}
          {canEdit && measureTool && (
            <button type="button" className="btn ghost small" onClick={clearWallMeasurements}>
              {t('hub_sketch_measure_clear')}
            </button>
          )}
          <label className="hub-sketch-layer-toggle hub-sketch-elevation-toolbar-toggle">
            <input
              type="checkbox"
              checked={showMeasurements}
              onChange={(event) => {
                setShowMeasurements(event.target.checked)
                if (!event.target.checked) setSelectedMeasurementIndex(null)
              }}
            />
            <span>{t('hub_sketch_measurements')}</span>
          </label>
          <span className="hub-sketch-elevation-toolbar-spacer" />
          <div className="hub-sketch-elevation-zoom" role="group" aria-label={t('hub_sketch_elevation_zoom_fit')}>
            <button type="button" className="hub-sketch-elevation-zoom-btn" aria-label={t('hub_sketch_elevation_zoom_out')} onClick={zoomOut} disabled={zoom <= 1}>−</button>
            <button type="button" className="hub-sketch-elevation-zoom-btn" aria-label={t('hub_sketch_elevation_zoom_in')} onClick={zoomIn} disabled={zoom >= 6}>+</button>
            <button type="button" className="btn ghost small hub-sketch-elevation-zoom-fit" onClick={zoomFit} disabled={zoom <= 1}>{t('hub_sketch_elevation_zoom_fit')}</button>
          </div>
          {toolbarEnd}
        </div>
      )}
      <div className={compact ? 'hub-sketch-elevation-body hub-sketch-elevation-body-compact' : 'hub-sketch-elevation-body'}>
        <div className="hub-sketch-elevation-canvas">
          {!compact && measureTool && (
            <div className="hub-sketch-elevation-hint" role="status">
              {t(draft ? 'hub_sketch_measure_hint_end' : 'hub_sketch_measure_hint_start')}
            </div>
          )}
          {!compact && !measureTool && zoneTool && regionEditingEnabled && editableFinishRegions.length === 0 && !regionDrag && (
            <div className="hub-sketch-elevation-hint" role="status">
              {t('hub_sketch_zone_hint')}
            </div>
          )}
          {!compact && wallLengthConflict && wallLengthDraft !== null && (
            <div className="hub-sketch-elevation-conflict" role="alertdialog" aria-live="polite">
              <span>{t('hub_sketch_dimension_conflict_prompt')}</span>
              <button type="button" className="btn small" onMouseDown={(event) => event.preventDefault()} onClick={() => applyWallLengthDraft('end')}>
                {t('hub_sketch_dimension_move_start')}
              </button>
              <button type="button" className="btn small" onMouseDown={(event) => event.preventDefault()} onClick={() => applyWallLengthDraft('start')}>
                {t('hub_sketch_dimension_move_end')}
              </button>
              <button type="button" className="btn ghost small" onMouseDown={(event) => event.preventDefault()} onClick={cancelWallLengthEdit}>
                {t('cancel')}
              </button>
            </div>
          )}
          {!compact && codeCheckEnabled && wallCodeViolations.length > 0 && (
            <div className="hub-sketch-elevation-code-list" role="status" aria-live="polite">
              {wallCodeViolations.slice(0, 3).map((check) => (
                <span key={check.id} className="hub-sketch-code-chip">
                  {formatCodeClearanceMessage(check, t)}
                </span>
              ))}
            </div>
          )}
      <svg
        ref={svgRef}
        className={[
          'hub-sketch-elevation-svg',
          compact ? 'hub-sketch-elevation-svg-compact' : '',
          regionEditingEnabled ? 'hub-sketch-elevation-svg-region-draw' : '',
          canEdit && measureTool ? 'hub-sketch-elevation-svg-measure' : '',
        ].filter(Boolean).join(' ')}
        viewBox={viewBox}
        role="img"
        aria-label={t('hub_sketch_3d_wall_elevation')}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => {
          if (!regionDrag) setHover(null)
        }}
        onClick={handleClick}
      >
        <defs>
          <marker id={`hub-sketch-elevation-measure-arrow-${wall.c}-${wall.s}`} viewBox="0 0 8 8" refX="4" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="#047857" />
          </marker>
          {isTile && (
            <pattern id={patternId} width={tileW + grout} height={tileH + grout} patternUnits="userSpaceOnUse">
              <rect width={tileW + grout} height={tileH + grout} fill={groutColor} />
              <rect width={tileW} height={tileH} fill={tileColor} />
            </pattern>
          )}
        </defs>
        <rect className="hub-sketch-elevation-wall" x={0} y={0} width={lengthFt} height={height} fill={baseFill} />
        {finishRegions.map((region, index) => (
          <rect
            key={`finish-${finishRegionKey(region, index)}`}
            className={[
              patch ? 'hub-sketch-elevation-drywall-patch' : 'hub-sketch-elevation-finish',
              finishCoverage.full && finishRegions.length === 1 ? '' : 'hub-sketch-elevation-finish-partial',
            ].filter(Boolean).join(' ')}
            x={region.x0Ft}
            y={height - region.y1Ft}
            width={Math.max(0.001, region.x1Ft - region.x0Ft)}
            height={Math.max(0.001, region.y1Ft - region.y0Ft)}
            fill={surfaceFill}
          />
        ))}
        <g className="hub-sketch-elevation-grid">
          {ticks(lengthFt, 0.5).map((x) => (
            <line key={`x${x}`} x1={x} y1={0} x2={x} y2={height} className={Math.abs(x - Math.round(x)) < 0.001 ? 'major' : undefined} />
          ))}
          {ticks(height, 0.5).map((y) => (
            <line key={`y${y}`} x1={0} y1={height - y} x2={lengthFt} y2={height - y} className={Math.abs(y - Math.round(y)) < 0.001 ? 'major' : undefined} />
          ))}
        </g>
        {showRegionHint && (
          <g className="hub-sketch-elevation-region-hint" pointerEvents="none">
            <rect x={Math.max(0.2, lengthFt * 0.08)} y={Math.max(0.2, height * 0.38)} width={Math.max(1.4, lengthFt * 0.84)} height={Math.max(0.55, height * 0.16)} rx={0.08} />
            <text x={lengthFt / 2} y={height / 2} textAnchor="middle" dominantBaseline="central">
              {t('hub_sketch_finish_region_hint').replace('{finish}', finishLabel.toLocaleLowerCase())}
            </text>
          </g>
        )}
        <g className="hub-sketch-elevation-cabinet-guides">
          {[
            { key: 'toe', value: CABINET_TOE_KICK_IN / 12, label: t('hub_sketch_cabinet_toe_guide') },
            { key: 'counter', value: CABINET_COUNTERTOP_HEIGHT_IN / 12, label: t('hub_sketch_cabinet_counter_guide') },
            { key: 'wall', value: CABINET_WALL_BOTTOM_IN / 12, label: t('hub_sketch_cabinet_wall_guide') },
          ].filter((guide) => guide.value < height).map((guide) => (
            <g key={guide.key}>
              <line x1={0} y1={height - guide.value} x2={lengthFt} y2={height - guide.value} />
              <text x={0.08} y={height - guide.value - 0.05} textAnchor="start">{guide.label}</text>
            </g>
          ))}
        </g>
        <rect className={wallLengthConflictActive ? 'hub-sketch-elevation-outline hub-sketch-elevation-outline-conflict' : 'hub-sketch-elevation-outline'} x={0} y={0} width={lengthFt} height={height} />
        <g className={wallLengthConflictActive ? 'hub-sketch-elevation-wall-dim hub-sketch-elevation-wall-dim-conflict' : 'hub-sketch-elevation-wall-dim'}>
          <line x1={0} y1={wallDimY} x2={lengthFt} y2={wallDimY} />
          <line x1={0} y1={wallDimY - 0.1} x2={0} y2={wallDimY + 0.1} />
          <line x1={lengthFt} y1={wallDimY - 0.1} x2={lengthFt} y2={wallDimY + 0.1} />
          {wallLengthDraft !== null ? (
            <foreignObject x={Math.max(0, lengthFt / 2 - wallDimInputW / 2)} y={wallDimLabelY - wallDimInputH / 2} width={wallDimInputW} height={wallDimInputH}>
              <input
                className="hub-sketch-elevation-dim-input"
                value={wallLengthDraft}
                inputMode="text"
                autoFocus
                aria-label={t('hub_sketch_dimension_edit_label')}
                onChange={(event) => setWallLengthDraft(event.target.value)}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => applyWallLengthDraft()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    applyWallLengthDraft()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelWallLengthEdit()
                  }
                }}
              />
            </foreignObject>
          ) : (
            <text
              x={lengthFt / 2}
              y={wallDimLabelY}
              textAnchor="middle"
              role={canEdit && onModelChange ? 'button' : undefined}
              tabIndex={canEdit && onModelChange ? 0 : undefined}
              aria-label={canEdit && onModelChange ? t('hub_sketch_dimension_edit_label') : undefined}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                beginWallLengthEdit()
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                beginWallLengthEdit()
              }}
            >
              {wallLengthText}
            </text>
          )}
        </g>
        {openings.map((opening, index) => {
          const box = elevationOpeningBox(opening, lengthFt, height)
          const label = opening.kind === 'door'
            ? `${formatLength(box.width)} x ${formatLength(box.openingHeight)}`
            : `${formatLength(box.width)} x ${formatLength(box.openingHeight)} / ${formatLength(box.floor)}`
          const dims = elevationOpeningDims(openings, opening, index, lengthFt, height, t)
          return (
            <g key={`${opening.kind}-${index}`}>
              <rect
                className={opening.kind === 'door' ? 'hub-sketch-elevation-door' : 'hub-sketch-elevation-window'}
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.openingHeight}
              >
                <title>{label}</title>
              </rect>
              {/* TRIM-OPENINGS-21: обводка проёма тримами — толщина/цвет линии по профилю каждой стороны. */}
              <g className="hub-sketch-elevation-trim" pointerEvents="none">
                {resolveOpeningTrim(opening.kind, opening.trim).map((side) => {
                  if (!side.enabled) return null
                  const profile = trimProfileById(side.profileId)
                  if (!profile) return null
                  const strokeWidth = Math.max(0.03, Math.min(profile.widthIn / 12, Math.min(box.width, box.openingHeight) * 0.6))
                  const half = strokeWidth / 2
                  const left = box.x
                  const right = box.x + box.width
                  const top = box.y
                  const bottom = box.y + box.openingHeight
                  const line = side.side === 'top'
                    ? { x1: left - half, y1: top, x2: right + half, y2: top }
                    : side.side === 'bottom'
                      ? { x1: left - half, y1: bottom, x2: right + half, y2: bottom }
                      : side.side === 'left'
                        ? { x1: left, y1: top - half, x2: left, y2: bottom + half }
                        : { x1: right, y1: top - half, x2: right, y2: bottom + half }
                  return (
                    <line
                      key={`trim-${side.side}`}
                      x1={line.x1}
                      y1={line.y1}
                      x2={line.x2}
                      y2={line.y2}
                      stroke={profile.color}
                      strokeWidth={strokeWidth}
                      strokeLinecap="butt"
                      opacity={0.92}
                    />
                  )
                })}
              </g>
              <text x={box.x + box.width / 2} y={Math.max(0.28, box.y - 0.14)} textAnchor="middle">
                {label}
              </text>
              {dims.map((dim, dimIndex) => {
                const tick = 0.09
                const labelY = dim.y - 0.07
                return (
                  <g
                    key={`od-${dimIndex}`}
                    className={dim.gap ? 'hub-sketch-elevation-opening-dim hub-sketch-elevation-opening-dim-gap' : 'hub-sketch-elevation-opening-dim'}
                  >
                    <line x1={dim.x1} y1={dim.y} x2={dim.x2} y2={dim.y} />
                    <line x1={dim.x1} y1={dim.y - tick} x2={dim.x1} y2={dim.y + tick} />
                    <line x1={dim.x2} y1={dim.y - tick} x2={dim.x2} y2={dim.y + tick} />
                    <text x={(dim.x1 + dim.x2) / 2} y={labelY} textAnchor="middle">
                      {dim.text}
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })}
        {wallPlacedItems.map((entry) => {
          const editableCabinet = cabinetEditEnabled && entry.cabinet && !entry.filler
          const selectedCab = editableCabinet && selectedCabinetId === entry.item.id
          const cls = `hub-sketch-elevation-item${entry.warning ? ' hub-sketch-elevation-item-warn' : ''}${entry.toilet ? ' hub-sketch-elevation-toilet' : ''}${entry.showerPan ? ' hub-sketch-elevation-shower' : ''}${entry.cabinet ? ' hub-sketch-elevation-cabinet' : ''}${entry.layer === 'wall' ? ' hub-sketch-elevation-cabinet-wall' : ''}${entry.filler ? ' hub-sketch-elevation-cabinet-filler' : ''}${editableCabinet ? ' hub-sketch-elevation-cabinet-editable' : ''}${selectedCab ? ' hub-sketch-elevation-cabinet-selected' : ''}`
          return (
            <g
              key={`ei-${entry.item.id}`}
              className={cls}
              onClick={editableCabinet ? (event) => {
                event.stopPropagation()
                setSelectedCabinetId((current) => current === entry.item.id ? null : entry.item.id)
              } : undefined}
            >
              <title>{entry.item.name ?? (entry.toilet ? t('hub_sketch_toilet') : entry.cabinet ? entry.cabinetCode : t('hub_sketch_code_target_item'))}</title>
              {entry.toilet ? (
                <>
                  <rect x={entry.x + entry.width * 0.08} y={entry.y + entry.height * 0.02} width={entry.width * 0.84} height={entry.height * 0.36} rx={0.05} />
                  <path d={`M ${entry.x + entry.width * 0.18} ${entry.y + entry.height * 0.38} C ${entry.x + entry.width * 0.2} ${entry.y + entry.height * 0.78}, ${entry.x + entry.width * 0.8} ${entry.y + entry.height * 0.78}, ${entry.x + entry.width * 0.82} ${entry.y + entry.height * 0.38} Z`} />
                  <ellipse cx={entry.x + entry.width / 2} cy={entry.y + entry.height * 0.56} rx={entry.width * 0.22} ry={entry.height * 0.13} />
                </>
              ) : entry.showerPan ? (
                <>
                  {entry.showerPanShape === 'neo-angle' ? (
                    <path d={`M ${entry.x} ${entry.y} H ${entry.x + entry.width} V ${entry.y + entry.height * 0.62} L ${entry.x + entry.width * 0.62} ${entry.y + entry.height} H ${entry.x} Z`} />
                  ) : (
                    <rect x={entry.x} y={entry.y} width={entry.width} height={entry.height} rx={0.03} />
                  )}
                  <line className="hub-sketch-elevation-shower-rim" x1={entry.x + entry.width * 0.08} y1={entry.y + entry.height * 0.48} x2={entry.x + entry.width * 0.92} y2={entry.y + entry.height * 0.48} />
                </>
              ) : entry.cabinet ? (
                <>
                  <rect x={entry.x} y={entry.y} width={entry.width} height={entry.height} rx={0.025} />
                  {entry.layer === 'base' && !entry.filler && (
                    <>
                      <rect
                        className="hub-sketch-elevation-cabinet-toe"
                        x={entry.x + entry.width * 0.08}
                        y={entry.y + entry.height - Math.min(entry.height * 0.3, CABINET_TOE_KICK_IN / 12)}
                        width={entry.width * 0.84}
                        height={Math.min(entry.height * 0.3, CABINET_TOE_KICK_IN / 12)}
                        rx={0.015}
                      />
                      <line className="hub-sketch-elevation-cabinet-counter" x1={entry.x - 0.02} y1={Math.max(0, height - CABINET_COUNTERTOP_HEIGHT_IN / 12)} x2={entry.x + entry.width + 0.02} y2={Math.max(0, height - CABINET_COUNTERTOP_HEIGHT_IN / 12)} />
                    </>
                  )}
                  <line className="hub-sketch-elevation-cabinet-face" x1={entry.x + entry.width * 0.1} y1={entry.y + entry.height * 0.28} x2={entry.x + entry.width * 0.9} y2={entry.y + entry.height * 0.28} />
                  <line className="hub-sketch-elevation-cabinet-face" x1={entry.x + entry.width / 2} y1={entry.y + entry.height * 0.28} x2={entry.x + entry.width / 2} y2={entry.y + entry.height * 0.9} />
                  {entry.filler && (
                    <path className="hub-sketch-elevation-cabinet-fill-mark" d={`M ${entry.x} ${entry.y} L ${entry.x + entry.width} ${entry.y + entry.height} M ${entry.x + entry.width} ${entry.y} L ${entry.x} ${entry.y + entry.height}`} />
                  )}
                  {entry.cabinetCode && (
                    <text x={entry.x + entry.width / 2} y={entry.y + entry.height / 2} textAnchor="middle" dominantBaseline="central">
                      {entry.cabinetCode}
                    </text>
                  )}
                </>
              ) : (
                <rect x={entry.x} y={entry.y} width={entry.width} height={entry.height} rx={0.05} />
              )}
            </g>
          )
        })}
        {/* CABINETS-PLACE-13: живая размерная цепочка над рядом (посегментно + общий габарит). */}
        {!measureTool && !zoneTool && cabinetDimChains.map(({ layer, segs }) => {
          const topY = Math.min(...segs.map((seg) => seg.y))
          const startX = segs[0].x
          const endX = segs[segs.length - 1].x + segs[segs.length - 1].width
          const segLineY = Math.max(0.16, topY - 0.18)
          const totalLineY = Math.max(0.06, segLineY - 0.26)
          const tick = 0.07
          const totalIn = segs.reduce((sum, seg) => sum + (Number(seg.item.widthIn) || 0), 0)
          return (
            <g key={`cabinet-dim-${layer}`} className="hub-sketch-elevation-cabinet-dim" pointerEvents="none">
              <line x1={startX} y1={segLineY} x2={endX} y2={segLineY} />
              {segs.map((seg, index) => {
                const x1 = seg.x
                const x2 = seg.x + seg.width
                return (
                  <g key={`cabinet-dim-seg-${index}`}>
                    <line className="hub-sketch-elevation-cabinet-dim-tick" x1={x1} y1={segLineY - tick} x2={x1} y2={segLineY + tick} />
                    {index === segs.length - 1 && (
                      <line className="hub-sketch-elevation-cabinet-dim-tick" x1={x2} y1={segLineY - tick} x2={x2} y2={segLineY + tick} />
                    )}
                    <text x={(x1 + x2) / 2} y={segLineY - 0.07} textAnchor="middle">
                      {formatInches(Number(seg.item.widthIn) || 0)}
                    </text>
                  </g>
                )
              })}
              {segs.length > 1 && (
                <g className="hub-sketch-elevation-cabinet-dim-total">
                  <line x1={startX} y1={totalLineY} x2={endX} y2={totalLineY} />
                  <line className="hub-sketch-elevation-cabinet-dim-tick" x1={startX} y1={totalLineY - tick} x2={startX} y2={totalLineY + tick} />
                  <line className="hub-sketch-elevation-cabinet-dim-tick" x1={endX} y1={totalLineY - tick} x2={endX} y2={totalLineY + tick} />
                  <text x={(startX + endX) / 2} y={totalLineY - 0.07} textAnchor="middle">
                    {formatInches(totalIn)}
                  </text>
                </g>
              )}
            </g>
          )
        })}
        {showFinishRegionLabels && finishRegions.map((region, index) => {
          const label = finishRegionLabel(region)
          return (
            <g key={`fr-label-${finishRegionKey(region, index)}`} className="hub-sketch-elevation-region-label" pointerEvents="none">
              <rect
                x={label.x - label.rectWidth / 2}
                y={height - label.y - label.rectHeight / 2}
                width={label.rectWidth}
                height={label.rectHeight}
                rx={Math.min(0.08, label.rectHeight * 0.32)}
              />
              <text
                x={label.x}
                y={height - label.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={label.fontSize}
                textLength={label.textLength}
                lengthAdjust="spacingAndGlyphs"
              >
                {label.text}
              </text>
            </g>
          )
        })}
        {regionEditingEnabled && dragPreviewRegions.map((region, index) => {
          const selected = selectedRegionIndex === index
          const handleSize = Math.max(0.12, Math.min(0.22, Math.min(lengthFt, height) * 0.03))
          return (
            <g
              key={`fr-edit-${finishRegionKey(region, index)}`}
              className={selected ? 'hub-sketch-elevation-region hub-sketch-elevation-region-selected' : 'hub-sketch-elevation-region'}
              onClick={(event) => {
                event.stopPropagation()
                setSelectedRegionIndex(index)
                setSelectedMeasurementIndex(null)
              }}
            >
              <rect
                className="hub-sketch-elevation-region-hit"
                x={region.x0Ft}
                y={height - region.y1Ft}
                width={Math.max(0.001, region.x1Ft - region.x0Ft)}
                height={Math.max(0.001, region.y1Ft - region.y0Ft)}
                onPointerDown={startRegionMove(index, region)}
              />
              <rect
                className="hub-sketch-elevation-region-outline"
                x={region.x0Ft}
                y={height - region.y1Ft}
                width={Math.max(0.001, region.x1Ft - region.x0Ft)}
                height={Math.max(0.001, region.y1Ft - region.y0Ft)}
              />
              {selected && FINISH_REGION_HANDLES.map((handle) => {
                const point = finishRegionHandlePoint(region, handle)
                return (
                  <rect
                    key={handle}
                    className={`hub-sketch-elevation-region-handle hub-sketch-elevation-region-handle-${handle}`}
                    x={point.x - handleSize / 2}
                    y={height - point.y - handleSize / 2}
                    width={handleSize}
                    height={handleSize}
                    rx={handleSize * 0.18}
                    onPointerDown={startRegionResize(index, region, handle)}
                  />
                )
              })}
            </g>
          )
        })}
        {showMeasurements && measurementLines.map(({ index, line }) => {
          const selected = selectedMeasurementIndex === index
          const chipH = 0.42
          const chipW = Math.max(0.62, line.text.length * 0.17 + 0.22)
          const deleteSize = 0.34
          const deleteX = line.labelX + chipW / 2 + deleteSize / 2 + 0.04
          return (
            <g
              key={`em${index}`}
              className={selected ? 'hub-sketch-elevation-measurement hub-sketch-elevation-measurement-selected' : 'hub-sketch-elevation-measurement'}
              onClick={(event) => {
                if (!canEdit) return
                event.stopPropagation()
                setSelectedMeasurementIndex(index)
                setSelectedRegionIndex(null)
                setDraft(null)
              }}
            >
              <line
                className="hub-sketch-elevation-measurement-line"
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                markerStart={`url(#hub-sketch-elevation-measure-arrow-${wall.c}-${wall.s})`}
                markerEnd={`url(#hub-sketch-elevation-measure-arrow-${wall.c}-${wall.s})`}
              />
              <line className="hub-sketch-elevation-measurement-hit" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
              <g transform={`rotate(${line.angle} ${line.labelX} ${line.labelY})`}>
                <rect
                  className="hub-sketch-elevation-measurement-chip"
                  x={line.labelX - chipW / 2}
                  y={line.labelY - chipH / 2}
                  width={chipW}
                  height={chipH}
                  rx={0.1}
                />
                <text x={line.labelX} y={line.labelY} textAnchor="middle" dominantBaseline="central">
                  {line.text}
                </text>
                {selected && (
                  <g
                    className="hub-sketch-elevation-measurement-delete"
                    role="button"
                    tabIndex={0}
                    aria-label={t('hub_sketch_measurement_delete')}
                    onClick={(event) => {
                      event.stopPropagation()
                      removeMeasurement(index)
                    }}
                    onKeyDown={deleteButtonKeyDown(index)}
                  >
                    <rect x={deleteX - deleteSize / 2} y={line.labelY - deleteSize / 2} width={deleteSize} height={deleteSize} rx={0.06} />
                    <text x={deleteX} y={line.labelY} textAnchor="middle" dominantBaseline="central">×</text>
                  </g>
                )}
              </g>
            </g>
          )
        })}
        {showMeasurements && canEdit && measureTool && previewLine && (
          <g className="hub-sketch-elevation-measurement hub-sketch-elevation-measurement-preview">
            <line
              className="hub-sketch-elevation-measurement-line"
              x1={previewLine.x1}
              y1={previewLine.y1}
              x2={previewLine.x2}
              y2={previewLine.y2}
              markerStart={`url(#hub-sketch-elevation-measure-arrow-${wall.c}-${wall.s})`}
              markerEnd={`url(#hub-sketch-elevation-measure-arrow-${wall.c}-${wall.s})`}
            />
            <g transform={`rotate(${previewLine.angle} ${previewLine.labelX} ${previewLine.labelY})`}>
              <rect
                className="hub-sketch-elevation-measurement-chip"
                x={previewLine.labelX - Math.max(0.62, previewLine.text.length * 0.17 + 0.22) / 2}
                y={previewLine.labelY - 0.21}
                width={Math.max(0.62, previewLine.text.length * 0.17 + 0.22)}
                height={0.42}
                rx={0.1}
              />
              <text x={previewLine.labelX} y={previewLine.labelY} textAnchor="middle" dominantBaseline="central">
                {previewLine.text}
              </text>
            </g>
          </g>
        )}
      </svg>
        {selectedCabinet && (
          <div className="hub-sketch-elevation-cabinet-editor" role="group" aria-label={t('hub_sketch_cabinet_edit')}>
            <div className="hub-sketch-elevation-cabinet-editor-head">
              <strong>{cabinetDisplayCode(selectedCabinet.item) || t('hub_sketch_tool_cabinet')}</strong>
              <button
                type="button"
                className="hub-sketch-elevation-cabinet-editor-close"
                aria-label={t('lightbox_close')}
                onClick={() => setSelectedCabinetId(null)}
              >
                ×
              </button>
            </div>
            {onCabinetResize && (
              <div className="hub-sketch-elevation-cabinet-editor-row" role="group" aria-label={t('hub_sketch_width')}>
                <span className="muted">{t('hub_sketch_width')}</span>
                {CABINET_CATALOG_STANDARD_WIDTHS_IN.map((w) => {
                  const current = Math.round(selectedCabinet.item.widthIn ?? 0) === w
                  return (
                    <button
                      key={w}
                      type="button"
                      className={current ? 'btn small' : 'btn ghost small'}
                      aria-pressed={current}
                      onClick={() => onCabinetResize(selectedCabinet.item, w)}
                    >
                      {`${w}"`}
                    </button>
                  )
                })}
              </div>
            )}
            {onCabinetResize && selectedCabinet.layer === 'wall' && (
              <div className="hub-sketch-elevation-cabinet-editor-row" role="group" aria-label={t('hub_sketch_cabinet_wall_height')}>
                <span className="muted">{t('hub_sketch_cabinet_wall_height')}</span>
                {CABINET_CATALOG_WALL_HEIGHTS_IN.map((h) => {
                  const current = Math.round(selectedCabinet.item.heightIn ?? 0) === h
                  return (
                    <button
                      key={h}
                      type="button"
                      className={current ? 'btn small' : 'btn ghost small'}
                      aria-pressed={current}
                      onClick={() => onCabinetResize(selectedCabinet.item, Math.round(selectedCabinet.item.widthIn ?? 0), h)}
                    >
                      {`${h}"`}
                    </button>
                  )
                })}
              </div>
            )}
            {onCabinetRemove && (
              <button
                type="button"
                className="btn ghost small hub-sketch-elevation-cabinet-editor-delete"
                onClick={() => {
                  onCabinetRemove(selectedCabinet.item)
                  setSelectedCabinetId(null)
                }}
              >
                {t('hub_sketch_cabinet_remove')}
              </button>
            )}
          </div>
        )}
        </div>
        {!compact && (
          <aside className="hub-sketch-elevation-side" aria-label={t('hub_sketch_elevation_properties')}>
            <div className="hub-sketch-elevation-meta">
              <button
                type="button"
                className={wallLengthConflictActive ? 'hub-sketch-elevation-meta-button hub-sketch-elevation-meta-button-conflict' : 'hub-sketch-elevation-meta-button'}
                disabled={!canEdit || !onModelChange}
                onClick={beginWallLengthEdit}
              >
                {`${t('hub_sketch_dim_length_short')}: ${wallLengthText}`}
              </button>
              <span>{`${t('hub_sketch_dim_height_short')}: ${formatLength(height)}`}</span>
              <span>{`${t('hub_sketch_3d_openings')}: ${openings.length}`}</span>
              {!finishCoverage.full && <span>{`${t('hub_sketch_finish_coverage')}: ${formatLength(finishCoverage.topFt - finishCoverage.bottomFt)}`}</span>}
              {finishRegions.length > 0 && <span>{`${t('hub_sketch_finish_region_area')}: ${finishRegionSqft.toFixed(1)} ft²`}</span>}
              {wallCabinetCount > 0 && <span>{`${t('hub_sketch_tool_cabinet')}: ${wallCabinetCount}`}</span>}
            </div>
            {selectedRegion && (
              <div className="hub-sketch-elevation-region-controls" aria-label={t('hub_sketch_finish_region_controls')}>
                <span className="hub-sketch-elevation-region-title">{t('hub_sketch_finish_region_controls')}</span>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_drywall_x')}</span>
                  <input
                    type="text"
                    inputMode="text"
                    value={regionDraftValue('left', selectedRegion.x0Ft)}
                    onChange={(event) => setRegionDrafts((current) => ({ ...current, left: event.target.value }))}
                    onBlur={() => commitRegionDraft('left')}
                    onKeyDown={regionDraftKeyDown('left')}
                  />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_finish_from_floor')}</span>
                  <input
                    type="text"
                    inputMode="text"
                    value={regionDraftValue('bottom', selectedRegion.y0Ft)}
                    onChange={(event) => setRegionDrafts((current) => ({ ...current, bottom: event.target.value }))}
                    onBlur={() => commitRegionDraft('bottom')}
                    onKeyDown={regionDraftKeyDown('bottom')}
                  />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_width')}</span>
                  <input
                    type="text"
                    inputMode="text"
                    value={regionDraftValue('width', selectedRegion.x1Ft - selectedRegion.x0Ft)}
                    onChange={(event) => setRegionDrafts((current) => ({ ...current, width: event.target.value }))}
                    onBlur={() => commitRegionDraft('width')}
                    onKeyDown={regionDraftKeyDown('width')}
                  />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_height')}</span>
                  <input
                    type="text"
                    inputMode="text"
                    value={regionDraftValue('height', selectedRegion.y1Ft - selectedRegion.y0Ft)}
                    onChange={(event) => setRegionDrafts((current) => ({ ...current, height: event.target.value }))}
                    onBlur={() => commitRegionDraft('height')}
                    onKeyDown={regionDraftKeyDown('height')}
                  />
                </label>
                <button type="button" className="btn ghost small" onClick={removeSelectedRegion}>
                  {t('hub_sketch_finish_region_delete')}
                </button>
              </div>
            )}
            {sidePanel}
          </aside>
        )}
      </div>
    </div>
  )
}
