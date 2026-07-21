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
import WallElevation from './WallElevation'
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
  DEFAULT_TILE_COLOR,
  DOOR_WIDTH_PRESETS_FT,
  WINDOW_WIDTH_PRESETS_FT,
  OPENING_DEFAULTS_FT,
  DEFAULT_WALL_PAINT,
  TILE_SIZE_OPTIONS,
  cleanColor,
  normalizeDrywallPatchSurface,
  normalizeFinishes,
  normalizeTileSurface,
  resizeSketchSegmentToLength,
  sanitizeSketchFinishes,
  sanitizeSketchLights,
  sanitizeSketchMeasurements,
  sanitizeSketchOpenings,
  sanitizeSketchSwitches,
  sketchWallKey,
  type SketchFinishes,
  type SketchLight,
  type SketchMeasurement,
  type SketchSegmentRef,
  type SketchSegmentResizeAnchor,
  type SketchSegmentResizeConflict,
  type SketchSurfaceFinish,
  type SketchSwitch,
} from './sketchFinishes'
import {
  BUILTIN_OUTLET_CATALOG_ID,
  BUILTIN_SWITCH_CATALOG_ID,
  SKETCH_CATALOG_KIND_OUTLET,
  SKETCH_CATALOG_KIND_SWITCH,
  isOutletPlacedCatalogItem,
  isShowerPanPlacedCatalogItem,
  isSwitchPlacedCatalogItem,
  isToiletPlacedCatalogItem,
  sanitizePlacedCatalogItems,
  showerPanShapeFromPlacedItem,
  type SketchPlacedCatalogItem,
  type SketchShowerPanShape,
} from './sketchCatalog'
import { formatFeetInches, formatInches, parseFeetInches, snapFeetToPrecision, snapOpeningFeetToPrecision } from './inches'
import {
  centerOpeningT,
  openingEdgeOffsetsFt,
  openingTForOffset,
  softOpeningPlacement,
  type OpeningOffsetSide,
  type OpeningPlacementMagnet,
} from './sketchOpeningPlacement'
import {
  cabinetDisplayCode,
  cabinetScheduleCsv,
  isCabinetPlacedItem,
  layoutCabinetRunOnWall,
  normalizeCabinetCodeInput,
  parseCabinetCode,
  suggestCabinetCodes,
  type CabinetLayoutResult,
} from './cabinetCodes'
import {
  CABINET_CATALOG_CATEGORIES,
  CABINET_CATALOG_ENTRIES,
  CABINET_CATALOG_STANDARD_WIDTHS_IN,
  CABINET_CATALOG_WALL_HEIGHTS_IN,
  cabinetCatalogDefaultWidth,
  cabinetCatalogEntryCode,
  type CabinetCatalogEntry,
  type CabinetCatalogIcon,
} from './cabinetCatalog'
import {
  ELECTRICAL_MATERIAL_SECTION,
  SKETCH_MATERIAL_SECTIONS,
  TILE_MATERIAL_SECTION,
  WALL_MATERIAL_SECTION,
  CABINET_MATERIAL_SECTION,
  appendSketchMaterialRows,
  buildSketchContourStats,
  calculateSketchMaterials,
  type SketchMaterialRow,
  type SketchMaterialsResult,
} from './sketchMaterials'
import {
  emptySketchHistory,
  recordSketchHistory,
  redoSketchHistory,
  undoSketchHistory,
  SKETCH_HISTORY_LIMIT,
  type SketchHistory,
} from './sketchHistory'
import {
  BUILTIN_SKETCH_ROOM_TEMPLATES,
  duplicateSketchSelection,
  insertSketchTemplate,
  mirrorSketchSelection,
  repositionWallBoundTemplateItems,
  sketchContourAreaSqft,
  sketchContourPerimeterFt,
  suggestedSketchTemplateOrigin,
  templateFromSketchModel,
  type SketchCopySelection,
  type SketchRoomTemplate,
} from './sketchTemplates'
import {
  finishLastOpenContour,
  hasClearableSketchContent,
  resolveWallDraftAfterContourFinish,
  screenPointerMovedBeyondThreshold,
  shouldCloseOpenContourFromPoint,
  shouldResetWallDraftAfterContourFinish,
  shouldTrackWallDraftPointer,
  snapCornerSquare,
  snapToExistingGeometry,
  snapPointWithSmartGuides,
  smartGuideLabelKey,
  type SketchExistingSnapResult,
  type SketchSmartGuide,
} from './sketchGuides'
import {
  CELL_FT,
  CELL_PX,
  VIEW_W,
  VIEW_H,
  canvasGridLines,
  fitCanvasView,
  normalizeCanvasView,
  sketchBounds,
  type CanvasSize,
  type CanvasView,
} from './sketchViewport'
import {
  contourArea,
  contourCenter,
  contourPerimeter,
  dist,
  pointInContour,
  projectT,
} from './sketchPlanGeometry'
import {
  eachSegment,
  nearestSegment,
  openingEnds,
  openingGeom,
  type WallSegment,
} from './sketchOpeningGeometry'

interface SketchTabProps {
  project: Project
  profile: Profile | null
}

// Геометрия/масштаб вьюпорта (CELL_FT, CELL_PX, VIEW_W, VIEW_H и пр.) — в ./sketchViewport.
const CLOSE_SNAP = 0.45 // клетки — попадание в стартовую точку замыкает контур
const SEG_HIT = 0.7 // клетки — попадание в сегмент при установке двери/окна
const ROOM_SNAP = 0.6 // клетки — радиус прилипания новой комнаты к существующим вершинам/стенам
const NODE_DRAG_THRESHOLD_PX = 6
const ZOOM_BUTTON_STEP = 1.2
const DEFAULT_WALL_HEIGHT_FT = 8
const DIM_OFFSET_SCREEN_PX = 24
const DIM_LABEL_SCREEN_PX = 12
const DIM_TICK_SCREEN_PX = 8
const EIGHTH_IN_FT = 1 / 96
const EDGE_AUTO_PAN_SCREEN_PX = 40
const EDGE_AUTO_PAN_MAX_PX_PER_SEC = 620
const OPENING_MAGNET_SCREEN_PX = 5
const OPENING_MAGNET_MAX_FT = 1.5 / 12
const OPENING_MAGNET_MIN_FT = EIGHTH_IN_FT
const SMART_GUIDE_SCREEN_PX = 7
const SMART_GUIDE_MAX_CELLS = 0.55
const DUPLICATE_OFFSET_CELLS = 2
const CUSTOM_TEMPLATE_LIMIT = 24
// Ф3 адаптив (планшет): грубый указатель (палец/стилус). Определяем один раз на маунт модуля —
// без подписки на смену; для шага1 этого достаточно. Визуальный размер элементов НЕ меняется.
const COARSE_POINTER =
  typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches
// Мин. экранный радиус невидимого хит-круга узла контура: 24px (диаметр 48) на точном указателе,
// 28px (диаметр 56) на грубом — тач-цель ≥44px, при этом видимый узел (nodeRadius) не трогаем.
const NODE_HIT_MIN_SCREEN_PX = COARSE_POINTER ? 28 : 24

type Pt = { x: number; y: number }
type Contour = { points: Pt[]; closed: boolean; label?: string }
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
type SketchCameraPreset = 'fit' | 'top' | 'angle' | 'inside'
type SnapMode = '1ft' | '6in' | '1in' | '1_8in'
type SketchMode = 'wall' | 'opening' | 'finish' | 'cabinet' | 'light' | 'measure' | 'markup'
type FeetDraftField = 'wallHeight' | 'doorW' | 'doorH' | 'winW' | 'winH' | 'winSill'
type SegmentLengthEdit = { ref: SketchSegmentRef; value: string }
type OpeningOffsetEdit = { index: number; side: OpeningOffsetSide; value: string }
type DragNode = { c: number; p: number }
type NodeDragCandidate = DragNode & { pointerId: number; pointerType: string; origin: { clientX: number; clientY: number } }
type WallClickAppend = { contourIndex: number; pointIndex: number; point: Pt; clientX: number; clientY: number; time: number }
type CanvasPointer = { clientX: number; clientY: number; pointerType: string }
type CanvasTapGesture = {
  id: number
  startX: number
  startY: number
  pointerType: string
  moved: boolean
  longPressed: boolean
  longPressTimer: number | null
}
type SketchSheetKind = 'context' | 'properties'
type SheetSwipe = { kind: SketchSheetKind; pointerId: number; startX: number; startY: number; lastY: number }

const SNAP_OPTIONS: Array<{ mode: SnapMode; stepFt: number; labelKey: string }> = [
  { mode: '1ft', stepFt: 1, labelKey: 'hub_sketch_snap_1ft' },
  { mode: '6in', stepFt: 0.5, labelKey: 'hub_sketch_snap_6in' },
  { mode: '1in', stepFt: 1 / 12, labelKey: 'hub_sketch_snap_1in' },
  { mode: '1_8in', stepFt: EIGHTH_IN_FT, labelKey: 'hub_sketch_snap_1_8in' },
]

const SKETCH_MODE_OPTIONS: Array<{ mode: SketchMode; labelKey: string; icon: string }> = [
  { mode: 'wall', labelKey: 'hub_sketch_mode_wall', icon: '▰' },
  { mode: 'opening', labelKey: 'hub_sketch_mode_opening', icon: '▯' },
  { mode: 'finish', labelKey: 'hub_sketch_mode_finish', icon: '◧' },
  { mode: 'cabinet', labelKey: 'hub_sketch_mode_cabinet', icon: '▣' },
  { mode: 'light', labelKey: 'hub_sketch_mode_light', icon: '✦' },
  { mode: 'measure', labelKey: 'hub_sketch_mode_measure', icon: '⌖' },
  { mode: 'markup', labelKey: 'hub_sketch_mode_markup', icon: '✎' },
]

const MODES_WITH_3D_CONTEXT = new Set<SketchMode>(['opening', 'finish', 'light', 'measure'])

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

function isEditableKeyTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
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

function openingSegmentLengthFt(model: SketchModel, opening: Opening): number {
  const ends = openingEnds(model, opening)
  return ends ? dist(ends.a, ends.b) * modelCellFt(model) : 0
}

function openingMagnetThresholdFt(model: SketchModel, screenWorldPx: number): number {
  const thresholdFt = (OPENING_MAGNET_SCREEN_PX * Math.max(0.0001, screenWorldPx) * modelCellFt(model)) / CELL_PX
  return Math.max(OPENING_MAGNET_MIN_FT, Math.min(OPENING_MAGNET_MAX_FT, thresholdFt))
}

function openingPlacementNeighbors(model: SketchModel, opening: Opening, openingIndex: number) {
  return model.openings
    .filter((other, index) => index !== openingIndex && other.c === opening.c && other.s === opening.s)
    .map((other) => ({ t: other.t, widthFt: openingWidthFt(other) }))
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

function sanitizeRoomTemplate(value: unknown): SketchRoomTemplate | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const model = raw.model
  if (!model || typeof model !== 'object') return null
  const rawModel = model as Record<string, unknown>
  if (!Array.isArray(rawModel.contours)) return null
  const contours = rawModel.contours
    .map((contour): Contour | null => {
      if (!contour || typeof contour !== 'object') return null
      const rawContour = contour as Record<string, unknown>
      if (!Array.isArray(rawContour.points)) return null
      const points = rawContour.points
        .map((point): Pt | null => {
          if (!point || typeof point !== 'object') return null
          const rawPoint = point as Record<string, unknown>
          const x = Number(rawPoint.x)
          const y = Number(rawPoint.y)
          return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
        })
        .filter((point): point is Pt => !!point)
      return points.length >= 2 ? { points, closed: rawContour.closed === true } : null
    })
    .filter((contour): contour is Contour => !!contour)
  if (contours.length === 0) return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.slice(0, 120) : makeId('template')
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : undefined
  const labelKey = typeof raw.labelKey === 'string' && raw.labelKey.trim() ? raw.labelKey.trim().slice(0, 120) : undefined
  const cellFt = Number(rawModel.cellFt)
  const height = importWallHeight(rawModel.height)
  const placedItems = sanitizePlacedCatalogItems(rawModel.placedItems)
  const template: SketchRoomTemplate = {
    id,
    name,
    labelKey,
    builtin: raw.builtin === true,
    model: {
      version: 1,
      cellFt: Number.isFinite(cellFt) && cellFt > 0 ? cellFt : CELL_FT,
      contours,
      openings: sanitizeSketchOpenings(rawModel.openings),
    },
  }
  if (height !== undefined) template.model.height = height
  if (placedItems.length > 0) template.model.placedItems = placedItems
  if (typeof raw.createdAt === 'string') template.createdAt = raw.createdAt
  return template
}

function sanitizeRoomTemplates(value: unknown): SketchRoomTemplate[] {
  if (!Array.isArray(value)) return []
  return value
    .map(sanitizeRoomTemplate)
    .filter((template): template is SketchRoomTemplate => !!template)
    .slice(0, CUSTOM_TEMPLATE_LIMIT)
}

type Tool = 'wall' | 'door' | 'window' | 'measure' | 'cabinet' | 'outlet' | 'switch'
type OpeningTool = Extract<Tool, 'door' | 'window'>
type CabinetBuilderKind = 'base' | 'sink' | 'drawers' | 'wall' | 'vanity' | 'filler' | 'appliance'
type CabinetAppliancePrefix = 'DW' | 'RANGE' | 'REF' | 'HOOD'

const CABINET_STANDARD_WIDTHS_IN = CABINET_CATALOG_STANDARD_WIDTHS_IN
const CABINET_WALL_HEIGHTS_IN = CABINET_CATALOG_WALL_HEIGHTS_IN

// CABINETS-PLACE-13: при перетаскивании кабинета вдоль стены ограничиваем его центр (доля t)
// так, чтобы он не заходил внутрь соседа того же слоя/стены и не выходил за концы стены (угол).
// Скольжение с bump-упором — как у Chief Architect / 2020, без свободного «сквозь соседа».
function clampCabinetTAlongWall(
  placedItems: SketchPlacedCatalogItem[],
  dragged: SketchPlacedCatalogItem,
  wallLengthIn: number,
  targetWallId: string,
  desiredT: number,
): number {
  const clamped01 = Math.max(0, Math.min(1, desiredT))
  if (!(wallLengthIn > 0)) return clamped01
  const halfFrac = ((dragged.widthIn ?? 0) / 2) / wallLengthIn
  if (halfFrac * 2 >= 1) return 0.5
  let minT = halfFrac
  let maxT = 1 - halfFrac
  // сторону соседа определяем по прежнему положению (dragged.t) — так слот стабилен между кадрами
  const currentCenter = dragged.wallId === targetWallId && typeof dragged.t === 'number' ? dragged.t : clamped01
  placedItems.forEach((neighbor) => {
    if (neighbor.id === dragged.id) return
    if (neighbor.wallId !== targetWallId || neighbor.layer !== dragged.layer) return
    if (!isCabinetPlacedItem(neighbor)) return
    const neighborCenter = typeof neighbor.t === 'number' ? neighbor.t : 0
    const neighborHalf = ((neighbor.widthIn ?? 0) / 2) / wallLengthIn
    if (neighborCenter <= currentCenter) minT = Math.max(minT, neighborCenter + neighborHalf + halfFrac)
    else maxT = Math.min(maxT, neighborCenter - neighborHalf - halfFrac)
  })
  if (minT > maxT) return Math.max(halfFrac, Math.min(1 - halfFrac, currentCenter))
  return Math.max(minT, Math.min(maxT, clamped01))
}
const CABINET_BUILDER_KINDS: CabinetBuilderKind[] = ['base', 'sink', 'drawers', 'wall', 'vanity', 'filler', 'appliance']
const CABINET_APPLIANCE_PREFIXES: CabinetAppliancePrefix[] = ['DW', 'RANGE', 'REF', 'HOOD']
const CABINET_HELP_ITEMS = [
  { code: 'B', labelKey: 'hub_sketch_cabinet_type_base_help' },
  { code: 'SB', labelKey: 'hub_sketch_cabinet_type_sink_short' },
  { code: '1DB/2DB/3DB', labelKey: 'hub_sketch_cabinet_type_drawers_short' },
  { code: 'W', labelKey: 'hub_sketch_cabinet_type_wall_help' },
  { code: 'U', labelKey: 'hub_sketch_cabinet_type_tall_short' },
  { code: 'V', labelKey: 'hub_sketch_cabinet_type_vanity_short' },
  { code: 'BF', labelKey: 'hub_sketch_cabinet_type_filler_short' },
  { code: 'BEP/REP', labelKey: 'hub_sketch_cabinet_type_panel_short' },
  { code: 'DW24/RANGE30/REF36/HOOD30', labelKey: 'hub_sketch_cabinet_type_appliance_short' },
]
const CABINET_BUILDER_LABEL_KEYS: Record<CabinetBuilderKind, string> = {
  base: 'hub_sketch_cabinet_builder_base',
  sink: 'hub_sketch_cabinet_builder_sink',
  drawers: 'hub_sketch_cabinet_builder_drawers',
  wall: 'hub_sketch_cabinet_builder_wall',
  vanity: 'hub_sketch_cabinet_builder_vanity',
  filler: 'hub_sketch_cabinet_builder_filler',
  appliance: 'hub_sketch_cabinet_builder_appliance',
}
const CABINET_APPLIANCE_LABEL_KEYS: Record<CabinetAppliancePrefix, string> = {
  DW: 'hub_sketch_cabinet_appliance_dw',
  RANGE: 'hub_sketch_cabinet_appliance_range',
  REF: 'hub_sketch_cabinet_appliance_ref',
  HOOD: 'hub_sketch_cabinet_appliance_hood',
}

function appendCabinetCodeText(input: string, code: string): string {
  const base = input.trimEnd()
  return base ? `${base} ${code}` : code
}

function replaceCabinetInputToken(input: string, invalidCode: string, replacement: string): string {
  const normalizedInvalid = normalizeCabinetCodeInput(invalidCode)
  const parts = input.split(/([,;\s]+)/)
  const index = parts.findIndex((part) => part.trim() && normalizeCabinetCodeInput(part) === normalizedInvalid)
  if (index < 0) return appendCabinetCodeText(input, replacement)
  parts[index] = replacement
  return parts.join('')
}

function cabinetBuilderCode(kind: CabinetBuilderKind, widthIn: number, wallHeightIn: number, appliancePrefix: CabinetAppliancePrefix): string {
  if (kind === 'base') return `B${widthIn}`
  if (kind === 'sink') return `SB${widthIn}`
  if (kind === 'drawers') return `DB${widthIn}`
  if (kind === 'wall') return `W${String(widthIn).padStart(2, '0')}${String(wallHeightIn).padStart(2, '0')}`
  if (kind === 'vanity') return `V${widthIn}`
  if (kind === 'filler') return `BF${widthIn}`
  return `${appliancePrefix}${widthIn}`
}

function cabinetTypeLabelKey(prefix: string): string {
  if (prefix === 'SB') return 'hub_sketch_cabinet_type_sink_short'
  if (prefix === 'DB' || prefix === '1DB' || prefix === '2DB' || prefix === '3DB') return 'hub_sketch_cabinet_type_drawers_short'
  if (prefix === 'W') return 'hub_sketch_cabinet_type_wall_short'
  if (prefix === 'U') return 'hub_sketch_cabinet_type_tall_short'
  if (prefix === 'V') return 'hub_sketch_cabinet_type_vanity_short'
  if (prefix === 'BF' || prefix === 'F') return 'hub_sketch_cabinet_type_filler_short'
  if (prefix === 'BEP' || prefix === 'REP') return 'hub_sketch_cabinet_type_panel_short'
  if (prefix === 'DW' || prefix === 'RANGE' || prefix === 'REF' || prefix === 'HOOD') return 'hub_sketch_cabinet_type_appliance_short'
  return 'hub_sketch_cabinet_type_base_short'
}

function CabinetGalleryIcon({ icon }: { icon: CabinetCatalogIcon }) {
  const frame = (
    <rect className="hub-sketch-cabinet-icon-face" x={22} y={10} width={52} height={48} rx={3} />
  )
  const toe = <line className="hub-sketch-cabinet-icon-line" x1={26} y1={53} x2={70} y2={53} />

  return (
    <svg className="hub-sketch-cabinet-icon" viewBox="0 0 96 72" aria-hidden="true" focusable="false">
      {icon === 'base' && (
        <>
          {frame}
          <line className="hub-sketch-cabinet-icon-line" x1={48} y1={12} x2={48} y2={53} />
          <circle className="hub-sketch-cabinet-icon-dot" cx={44} cy={35} r={1.9} />
          <circle className="hub-sketch-cabinet-icon-dot" cx={52} cy={35} r={1.9} />
          {toe}
        </>
      )}
      {icon === 'sink' && (
        <>
          {frame}
          <path className="hub-sketch-cabinet-icon-accent" d="M 32 22 Q 48 14 64 22 L 61 33 Q 48 39 35 33 Z" />
          <circle className="hub-sketch-cabinet-icon-dot" cx={48} cy={28} r={2.1} />
          <line className="hub-sketch-cabinet-icon-line" x1={48} y1={38} x2={48} y2={53} />
          {toe}
        </>
      )}
      {icon === 'drawer1' && (
        <>
          {frame}
          <rect className="hub-sketch-cabinet-icon-panel" x={29} y={18} width={38} height={30} rx={2} />
          <line className="hub-sketch-cabinet-icon-line" x1={38} y1={26} x2={58} y2={26} />
          {toe}
        </>
      )}
      {icon === 'drawer2' && (
        <>
          {frame}
          <rect className="hub-sketch-cabinet-icon-panel" x={29} y={15} width={38} height={18} rx={2} />
          <rect className="hub-sketch-cabinet-icon-panel" x={29} y={36} width={38} height={15} rx={2} />
          <line className="hub-sketch-cabinet-icon-line" x1={38} y1={23} x2={58} y2={23} />
          <line className="hub-sketch-cabinet-icon-line" x1={38} y1={43} x2={58} y2={43} />
          {toe}
        </>
      )}
      {icon === 'drawer3' && (
        <>
          {frame}
          {[15, 29, 43].map((y) => (
            <g key={y}>
              <rect className="hub-sketch-cabinet-icon-panel" x={29} y={y} width={38} height={11} rx={1.8} />
              <line className="hub-sketch-cabinet-icon-line" x1={39} y1={y + 5.5} x2={57} y2={y + 5.5} />
            </g>
          ))}
          {toe}
        </>
      )}
      {icon === 'lazySusan' && (
        <>
          <path className="hub-sketch-cabinet-icon-face" d="M 24 12 H 72 V 58 H 36 L 24 46 Z" />
          <path className="hub-sketch-cabinet-icon-accent" d="M 37 23 A 17 17 0 0 1 61 47" />
          <path className="hub-sketch-cabinet-icon-accent" d="M 61 23 A 17 17 0 0 1 37 47" />
          <line className="hub-sketch-cabinet-icon-line" x1={36} y1={58} x2={70} y2={58} />
        </>
      )}
      {icon === 'blindCorner' && (
        <>
          {frame}
          <rect className="hub-sketch-cabinet-icon-panel" x={30} y={18} width={24} height={30} rx={2} />
          <line className="hub-sketch-cabinet-icon-dash" x1={60} y1={15} x2={60} y2={51} />
          <path className="hub-sketch-cabinet-icon-line" d="M 61 23 H 70 M 61 36 H 70 M 61 49 H 70" />
          {toe}
        </>
      )}
      {icon === 'wall' && (
        <>
          <rect className="hub-sketch-cabinet-icon-face" x={24} y={8} width={48} height={40} rx={3} />
          <line className="hub-sketch-cabinet-icon-line" x1={48} y1={10} x2={48} y2={48} />
          <circle className="hub-sketch-cabinet-icon-dot" cx={44} cy={30} r={1.7} />
          <circle className="hub-sketch-cabinet-icon-dot" cx={52} cy={30} r={1.7} />
          <line className="hub-sketch-cabinet-icon-accent" x1={30} y1={58} x2={66} y2={58} />
        </>
      )}
      {icon === 'tallPantry' && (
        <>
          <rect className="hub-sketch-cabinet-icon-face" x={30} y={6} width={36} height={58} rx={3} />
          <line className="hub-sketch-cabinet-icon-line" x1={48} y1={8} x2={48} y2={64} />
          <line className="hub-sketch-cabinet-icon-line" x1={34} y1={36} x2={62} y2={36} />
          <circle className="hub-sketch-cabinet-icon-dot" cx={44} cy={28} r={1.8} />
          <circle className="hub-sketch-cabinet-icon-dot" cx={52} cy={44} r={1.8} />
        </>
      )}
      {icon === 'ovenTower' && (
        <>
          <rect className="hub-sketch-cabinet-icon-face" x={30} y={6} width={36} height={58} rx={3} />
          <rect className="hub-sketch-cabinet-icon-panel" x={36} y={25} width={24} height={20} rx={2} />
          <line className="hub-sketch-cabinet-icon-line" x1={40} y1={30} x2={56} y2={30} />
          <circle className="hub-sketch-cabinet-icon-dot" cx={40} cy={38} r={1.5} />
          <circle className="hub-sketch-cabinet-icon-dot" cx={56} cy={38} r={1.5} />
        </>
      )}
      {icon === 'vanity' && (
        <>
          {frame}
          <path className="hub-sketch-cabinet-icon-accent" d="M 34 20 H 62 Q 60 33 48 33 Q 36 33 34 20 Z" />
          <line className="hub-sketch-cabinet-icon-line" x1={48} y1={36} x2={48} y2={53} />
          <path className="hub-sketch-cabinet-icon-line" d="M 43 18 Q 48 13 53 18" />
          {toe}
        </>
      )}
      {icon === 'filler' && (
        <>
          <rect className="hub-sketch-cabinet-icon-face" x={40} y={10} width={16} height={48} rx={2} />
          <path className="hub-sketch-cabinet-icon-line" d="M 44 16 L 52 24 M 44 28 L 52 36 M 44 40 L 52 48" />
        </>
      )}
      {icon === 'baseEndPanel' && (
        <>
          <rect className="hub-sketch-cabinet-icon-face" x={36} y={12} width={24} height={46} rx={2} />
          <path className="hub-sketch-cabinet-icon-line" d="M 42 18 V 52 M 48 18 V 52 M 54 18 V 52" />
        </>
      )}
      {icon === 'refrigeratorEndPanel' && (
        <>
          <rect className="hub-sketch-cabinet-icon-face" x={36} y={6} width={24} height={58} rx={2} />
          <path className="hub-sketch-cabinet-icon-line" d="M 42 12 V 58 M 48 12 V 58 M 54 12 V 58" />
        </>
      )}
      {icon === 'dishwasher' && (
        <>
          <rect className="hub-sketch-cabinet-icon-appliance" x={26} y={12} width={44} height={46} rx={4} />
          <line className="hub-sketch-cabinet-icon-line" x1={32} y1={22} x2={64} y2={22} />
          <circle className="hub-sketch-cabinet-icon-dot" cx={36} cy={17} r={1.6} />
          <circle className="hub-sketch-cabinet-icon-dot" cx={42} cy={17} r={1.6} />
        </>
      )}
      {icon === 'range' && (
        <>
          <rect className="hub-sketch-cabinet-icon-appliance" x={24} y={10} width={48} height={50} rx={4} />
          <circle className="hub-sketch-cabinet-icon-line-fill" cx={39} cy={23} r={5} />
          <circle className="hub-sketch-cabinet-icon-line-fill" cx={57} cy={23} r={5} />
          <rect className="hub-sketch-cabinet-icon-panel" x={33} y={35} width={30} height={15} rx={2} />
        </>
      )}
      {icon === 'refrigerator' && (
        <>
          <rect className="hub-sketch-cabinet-icon-appliance" x={28} y={6} width={40} height={58} rx={4} />
          <line className="hub-sketch-cabinet-icon-line" x1={48} y1={8} x2={48} y2={64} />
          <line className="hub-sketch-cabinet-icon-line" x1={34} y1={32} x2={62} y2={32} />
          <line className="hub-sketch-cabinet-icon-line" x1={43} y1={20} x2={43} y2={29} />
          <line className="hub-sketch-cabinet-icon-line" x1={53} y1={36} x2={53} y2={50} />
        </>
      )}
      {icon === 'hood' && (
        <>
          <path className="hub-sketch-cabinet-icon-appliance" d="M 35 14 H 61 L 69 39 H 27 Z" />
          <rect className="hub-sketch-cabinet-icon-panel" x={31} y={39} width={34} height={9} rx={2} />
          <path className="hub-sketch-cabinet-icon-accent" d="M 39 57 Q 43 51 39 47 M 49 58 Q 53 51 49 47 M 59 57 Q 63 51 59 47" />
        </>
      )}
      {icon === 'wine' && (
        <>
          {frame}
          <path className="hub-sketch-cabinet-icon-line" d="M 31 18 L 65 50 M 65 18 L 31 50 M 48 14 V 54 M 29 34 H 67" />
          {toe}
        </>
      )}
    </svg>
  )
}

function makeId(prefix: string): string {
  const maybeCrypto = typeof crypto !== 'undefined' ? crypto : undefined
  const uuid = maybeCrypto && 'randomUUID' in maybeCrypto ? maybeCrypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${uuid}`
}

function roomDisplayName(contour: Contour | undefined, index: number, roomWord: string): string {
  const label = contour?.label?.trim()
  return label || `${roomWord} ${index + 1}`
}

function shortRoomLabel(label: string): string {
  return label.length > 24 ? `${label.slice(0, 23)}...` : label
}

const EMPTY_MODEL: SketchModel = { version: 1, cellFt: CELL_FT, contours: [], openings: [] }

function sanitizeContourLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const label = value.trim().slice(0, 80)
  return label || undefined
}

function sanitizeSketchContours(value: unknown): Contour[] {
  if (!Array.isArray(value)) return []
  return value
    .map((contour): Contour | null => {
      if (!contour || typeof contour !== 'object') return null
      const rawContour = contour as Record<string, unknown>
      if (!Array.isArray(rawContour.points)) return null
      const points = rawContour.points
        .map((point): Pt | null => {
          if (!point || typeof point !== 'object') return null
          const rawPoint = point as Record<string, unknown>
          const x = Number(rawPoint.x)
          const y = Number(rawPoint.y)
          return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
        })
        .filter((point): point is Pt => !!point)
      if (points.length === 0) return null
      const next: Contour = { points, closed: rawContour.closed === true && points.length >= 3 }
      const label = sanitizeContourLabel(rawContour.label)
      if (label) next.label = label
      return next
    })
    .filter((contour): contour is Contour => !!contour)
}

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
    contours: sanitizeSketchContours(model.contours),
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
  if (!Number.isFinite(valueFt) || Math.abs(valueFt) < 1 / 192) return '0 in'
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
type SegmentDimLine = DimLine2D & { kind: 'wall'; c: number; s: number; lengthFt: number }
type OpeningClearanceDimLine = DimLine2D & { metric: OpeningOffsetSide | 'gap'; valueFt: number }
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
type OpeningSnapGuide2D = {
  x1: number
  y1: number
  x2: number
  y2: number
  dotX: number
  dotY: number
  labelX: number
  labelY: number
  text: string
}
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
  electrical?: 'outlet' | 'switch'
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
  const lengthFt = dist(seg.a, seg.b) * modelCellFt(model)
  const line = createDimLine(ax, ay, bx, by, nx, ny, offset, screenWorldPx, fmtFt(lengthFt), 'wall')
  return line ? { ...line, kind: 'wall', c: seg.c, s: seg.s, lengthFt } : null
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
): OpeningClearanceDimLine[] {
  const span = openingSpan2D(model, opening)
  if (!span) return []
  const normal = outsideNormal(model, opening.c, span.g.a.x * CELL_PX, span.g.a.y * CELL_PX, span.g.b.x * CELL_PX, span.g.b.y * CELL_PX)
  const lines: OpeningClearanceDimLine[] = []
  const push = (fromCells: number, toCells: number, offsetScreenPx: number, text: string, metric: OpeningClearanceDimLine['metric'], valueFt: number) => {
    if (toCells - fromCells <= 0.02) return
    const ax = (span.g.a.x + span.g.ux * fromCells) * CELL_PX
    const ay = (span.g.a.y + span.g.uy * fromCells) * CELL_PX
    const bx = (span.g.a.x + span.g.ux * toCells) * CELL_PX
    const by = (span.g.a.y + span.g.uy * toCells) * CELL_PX
    const line = createDimLine(ax, ay, bx, by, normal.nx, normal.ny, offsetScreenPx * screenWorldPx, screenWorldPx, text, 'wall')
    if (line) lines.push({ ...line, metric, valueFt })
  }

  push(0, span.startCells, 42, `${t('hub_sketch_dim_left_short')} ${formatOpeningFt(span.startCells * span.cellFt)}`, 'left', span.startCells * span.cellFt)
  push(span.endCells, span.segLenCells, 42, `${t('hub_sketch_dim_right_short')} ${formatOpeningFt((span.segLenCells - span.endCells) * span.cellFt)}`, 'right', (span.segLenCells - span.endCells) * span.cellFt)

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
    push(leftNeighborEndCells, span.startCells, 62, `${t('hub_sketch_dim_gap_short')} ${formatOpeningFt(gap)}`, 'gap', gap)
  }
  if (rightNeighborStartCells !== null) {
    const gap = Math.max(0, (rightNeighborStartCells - span.endCells) * span.cellFt)
    push(span.endCells, rightNeighborStartCells, 62, `${t('hub_sketch_dim_gap_short')} ${formatOpeningFt(gap)}`, 'gap', gap)
  }

  return lines
}

function openingMagnetLabelKey(kind: OpeningPlacementMagnet['kind']): string {
  if (kind === 'center') return 'hub_sketch_opening_magnet_center'
  if (kind === 'edge-start' || kind === 'edge-end') return 'hub_sketch_opening_magnet_edge'
  if (kind === 'neighbor') return 'hub_sketch_opening_magnet_neighbor'
  return 'hub_sketch_opening_magnet_precision'
}

function openingSnapGuide2D(
  model: SketchModel,
  opening: Opening,
  magnet: OpeningPlacementMagnet,
  t: (k: string) => string,
  screenWorldPx: number,
): OpeningSnapGuide2D | null {
  const g = openingGeom(model, opening)
  if (!g) return null
  const segLenCells = dist(g.a, g.b)
  const cellFt = modelCellFt(model)
  if (segLenCells <= 0.01 || cellFt <= 0) return null
  const guideCells = clampNumber(magnet.guideFt / cellFt, 0, segLenCells)
  const x = (g.a.x + g.ux * guideCells) * CELL_PX
  const y = (g.a.y + g.uy * guideCells) * CELL_PX
  const normal = outsideNormal(model, opening.c, g.a.x * CELL_PX, g.a.y * CELL_PX, g.b.x * CELL_PX, g.b.y * CELL_PX)
  const inner = 10 * screenWorldPx
  const outer = 28 * screenWorldPx
  return {
    x1: x - normal.nx * inner,
    y1: y - normal.ny * inner,
    x2: x + normal.nx * outer,
    y2: y + normal.ny * outer,
    dotX: x,
    dotY: y,
    labelX: x + normal.nx * (outer + 14 * screenWorldPx),
    labelY: y + normal.ny * (outer + 14 * screenWorldPx),
    text: t(openingMagnetLabelKey(magnet.kind)),
  }
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

function planElectricalItem(model: SketchModel, item: SketchPlacedCatalogItem): PlanPlacedItem | null {
  const cellFt = modelCellFt(model)
  const electrical = isOutletPlacedCatalogItem(item) ? 'outlet' : isSwitchPlacedCatalogItem(item) ? 'switch' : null
  if (!electrical) return null
  const seg = Number.isInteger(item.c) && Number.isInteger(item.s)
    ? eachSegment(model).find((candidate) => candidate.c === item.c && candidate.s === item.s)
    : null
  if (seg) {
    const t = Math.max(0, Math.min(1, Number.isFinite(item.t) ? item.t ?? 0.5 : 0.5))
    const x = (seg.a.x + (seg.b.x - seg.a.x) * t) * CELL_PX
    const y = (seg.a.y + (seg.b.y - seg.a.y) * t) * CELL_PX
    return {
      item,
      x,
      y,
      angle: readableSvgAngle(seg.b.x - seg.a.x, seg.b.y - seg.a.y),
      width: (0.58 / cellFt) * CELL_PX,
      depth: (0.58 / cellFt) * CELL_PX,
      warning: false,
      toilet: false,
      showerPan: false,
      showerPanShape: 'rect',
      cabinet: false,
      cabinetCode: '',
      filler: false,
      electrical,
    }
  }
  if (!Number.isFinite(item.xFt) || !Number.isFinite(item.zFt)) return null
  return {
    item,
    x: (item.xFt / cellFt) * CELL_PX,
    y: (item.zFt / cellFt) * CELL_PX,
    angle: 0,
    width: (0.58 / cellFt) * CELL_PX,
    depth: (0.58 / cellFt) * CELL_PX,
    warning: false,
    toilet: false,
    showerPan: false,
    showerPanShape: 'rect',
    cabinet: false,
    cabinetCode: '',
    filler: false,
    electrical,
  }
}

function planPlacedItems(model: SketchModel, warningIds: Set<string>): PlanPlacedItem[] {
  const cellFt = modelCellFt(model)
  return sanitizePlacedCatalogItems(model.placedItems)
    .map((item): PlanPlacedItem | null => {
      if (item.surface === 'ceiling' || item.category === 'light' || item.category === 'fan') return null
      const electrical = planElectricalItem(model, item)
      if (electrical) return electrical
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

  if (entry.electrical) {
    const size = Math.max(10 / viewScale, entry.width)
    ctx.fillStyle = entry.electrical === 'outlet' ? 'rgba(59, 130, 246, .14)' : 'rgba(245, 158, 11, .16)'
    ctx.strokeStyle = entry.electrical === 'outlet' ? '#1d4ed8' : '#b45309'
    ctx.lineWidth = 1.7 / viewScale
    ctx.beginPath()
    ctx.roundRect(-size / 2, -size / 2, size, size, Math.max(2 / viewScale, size * 0.18))
    ctx.fill()
    ctx.stroke()
    if (entry.electrical === 'outlet') {
      ctx.beginPath()
      ctx.arc(-size * 0.14, -size * 0.07, Math.max(1.1 / viewScale, size * 0.045), 0, Math.PI * 2)
      ctx.arc(size * 0.14, -size * 0.07, Math.max(1.1 / viewScale, size * 0.045), 0, Math.PI * 2)
      ctx.moveTo(-size * 0.18, size * 0.18)
      ctx.lineTo(size * 0.18, size * 0.18)
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.moveTo(0, -size * 0.24)
      ctx.lineTo(size * 0.12, size * 0.22)
      ctx.stroke()
    }
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
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 ${12 / viewScale}px sans-serif`
  ctx.lineWidth = 3.5 / viewScale
  ctx.strokeStyle = 'rgba(255, 255, 255, .96)'
  ctx.fillStyle = '#0f172a'
  model.contours.forEach((contour, index) => {
    if (!contour.closed || contour.points.length < 3) return
    const center = contourCenter(contour)
    if (!center) return
    const label = shortRoomLabel(roomDisplayName(contour, index, t('hub_sketch_room_panel_title')))
    ctx.strokeText(label, center.x * CELL_PX, center.y * CELL_PX)
    ctx.fillText(label, center.x * CELL_PX, center.y * CELL_PX)
  })
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
  const stats = buildSketchContourStats(model)
  ctx.fillStyle = '#0f172a'
  ctx.font = 'bold 13px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(
    `${t('hub_sketch_area')}: ${stats.totalArea.toFixed(1)} ft²  ·  ${t('hub_sketch_perimeter')}: ${fmtFt(stats.totalPerimeter)}`,
    8,
    VIEW_H - 10,
  )
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

export default function SketchTab({ project, profile }: SketchTabProps) {
  const { t } = useI18n()
  const canEdit = profile ? isManagerWrite(profile.role) : false

  const [model, setModel] = useState<SketchModel>(EMPTY_MODEL)
  const [history, setHistory] = useState<SketchHistory<SketchModel>>(() => emptySketchHistory())
  const [viewMode, setViewMode] = useState<ViewMode>('2d')
  const [tool, setTool] = useState<Tool>('wall')
  const [activeMode, setActiveMode] = useState<SketchMode>('wall')
  const [contextSheetOpen, setContextSheetOpen] = useState(false)
  // SKETCH-CANVAS-12: контекст-панель по умолчанию свёрнута — канвасу сразу максимум ширины.
  const [contextPanelCollapsed, setContextPanelCollapsed] = useState(true)
  const [snapMode, setSnapMode] = useState<SnapMode>('1ft')
  const [showMeasurements, setShowMeasurements] = useState(true)
  const [codeCheckEnabled, setCodeCheckEnabled] = useState(true)
  const [measurementDraft, setMeasurementDraft] = useState<Pt | null>(null)
  const [selectedMeasurementIndex, setSelectedMeasurementIndex] = useState<number | null>(null)
  const [hover, setHover] = useState<Pt | null>(null)
  const [hoverSnapped, setHoverSnapped] = useState(false)
  const [hoverSnapGuide, setHoverSnapGuide] = useState<SketchExistingSnapResult | null>(null)
  const [newRoomDraftPending, setNewRoomDraftPending] = useState(false)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [recentlyClosedContourIndex, setRecentlyClosedContourIndex] = useState<number | null>(null)
  const [segmentLengthEdit, setSegmentLengthEdit] = useState<SegmentLengthEdit | null>(null)
  const [segmentResizeConflict, setSegmentResizeConflict] = useState<SketchSegmentResizeConflict | null>(null)
  // Габариты проёмов (в футах), задаются перед вставкой.
  const [doorW, setDoorW] = useState(OPENING_DEFAULTS_FT.doorW)
  const [doorH, setDoorH] = useState(OPENING_DEFAULTS_FT.doorH)
  const [winW, setWinW] = useState(OPENING_DEFAULTS_FT.winW)
  const [winH, setWinH] = useState(OPENING_DEFAULTS_FT.winH)
  const [winSill, setWinSill] = useState(OPENING_DEFAULTS_FT.winSill)
  const [feetDrafts, setFeetDrafts] = useState<Partial<Record<FeetDraftField, string>>>({})
  const [cabinetCodes, setCabinetCodes] = useState('B30 2DB27 W3030')
  const [cabinetBuilderKind, setCabinetBuilderKind] = useState<CabinetBuilderKind>('base')
  const [cabinetBuilderWallHeight, setCabinetBuilderWallHeight] = useState(30)
  const [cabinetBuilderAppliance, setCabinetBuilderAppliance] = useState<CabinetAppliancePrefix>('DW')
  const [cabinetGallerySearch, setCabinetGallerySearch] = useState('')
  const [selectedCabinetGalleryEntryId, setSelectedCabinetGalleryEntryId] = useState<string | null>(null)
  const [cabinetGalleryWallHeight, setCabinetGalleryWallHeight] = useState(30)
  const [selectedCabinetWallKey, setSelectedCabinetWallKey] = useState<string | null>(null)
  const [includePrimer, setIncludePrimer] = useState(true)
  const [includeTexture, setIncludeTexture] = useState(true)
  const [sketchMaterials, setSketchMaterials] = useState<SketchMaterialsResult | null>(null)
  const [sketchMaterialsBusy, setSketchMaterialsBusy] = useState(false)
  const [sketchMaterialsAppendBusy, setSketchMaterialsAppendBusy] = useState(false)
  const [sketchMaterialsAdded, setSketchMaterialsAdded] = useState<number | null>(null)
  // NAV-FIX-2: общий выбор стены (2D-план ↔ 3D-вид). null = ничего не выбрано.
  const [selectedWallKey, setSelectedWallKey] = useState<string | null>(null)
  const [selectedContourIndex, setSelectedContourIndex] = useState<number | null>(null)
  const [wallElevationFullscreen, setWallElevationFullscreen] = useState(false)
  const [wallElevationFinishPanelOpen, setWallElevationFinishPanelOpen] = useState(false)
  // Перетаскивание проёма вдоль стены.
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragNode, setDragNode] = useState<DragNode | null>(null)
  const [selectedNode, setSelectedNode] = useState<DragNode | null>(null)
  const [dragPlacedId, setDragPlacedId] = useState<string | null>(null)
  const [selectedOpeningIndex, setSelectedOpeningIndex] = useState<number | null>(null)
  const [openingOffsetEdit, setOpeningOffsetEdit] = useState<OpeningOffsetEdit | null>(null)
  const [openingSnapGuide, setOpeningSnapGuide] = useState<OpeningPlacementMagnet | null>(null)
  const [smartGuides, setSmartGuides] = useState<SketchSmartGuide[]>([])
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [customRoomTemplates, setCustomRoomTemplates] = useState<SketchRoomTemplate[]>([])
  const dragMovedRef = useRef(false)
  const armedDragNodeRef = useRef<NodeDragCandidate | null>(null)
  const nodeTapClickHandledRef = useRef<DragNode | null>(null)
  const lastWallClickAppendRef = useRef<WallClickAppend | null>(null)
  const [name, setName] = useState('room-1')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [saved, setSaved] = useState<ProjectHubFile[]>([])
  const [loadOpen, setLoadOpen] = useState(false)
  const [loadBusy, setLoadBusy] = useState(false)

  const svgShellRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  // CABINETS-PLACE-13: клик (не drag) по шкафу на плане открывает тот же поповер, что на развёртке.
  const [planCabinetEditor, setPlanCabinetEditor] = useState<{ id: string; x: number; y: number } | null>(null)
  const canvasAutoFitRef = useRef(true)
  const canvasSuppressClickRef = useRef(false)
  const canvasPointersRef = useRef<Map<number, CanvasPointer>>(new Map())
  const canvasTapRef = useRef<CanvasTapGesture | null>(null)
  const canvasPanRef = useRef<{ startX: number; startY: number; view: CanvasView; moved: boolean } | null>(null)
  const canvasPinchRef = useRef<{ startDistance: number; startMid: { x: number; y: number }; view: CanvasView } | null>(null)
  const penActiveRef = useRef(false)
  const activePenPointerIdRef = useRef<number | null>(null)
  const sheetSwipeRef = useRef<SheetSwipe | null>(null)
  const edgeAutoPanPointerRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const edgeAutoPanFrameRef = useRef<number | null>(null)
  const edgeAutoPanLastTimeRef = useRef(0)
  const closedContourFlashTimerRef = useRef<number | null>(null)
  const modelRef = useRef(model)
  const canvasSizeRef = useRef<CanvasSize>({ width: VIEW_W, height: VIEW_H })
  const canvasViewRef = useRef<CanvasView>({ x: 0, y: 0, width: VIEW_W, height: VIEW_H })
  const toolRef = useRef(tool)
  const newRoomDraftPendingRef = useRef(newRoomDraftPending)
  const viewModeRef = useRef(viewMode)
  const canEditRef = useRef(canEdit)
  const measurementDraftRef = useRef(measurementDraft)
  const dragIdxRef = useRef(dragIdx)
  const dragNodeRef = useRef<DragNode | null>(dragNode)
  const dragPlacedIdRef = useRef<string | null>(dragPlacedId)
  const selectedOpeningIndexRef = useRef(selectedOpeningIndex)
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: VIEW_W, height: VIEW_H })
  const [canvasView, setCanvasView] = useState<CanvasView>({ x: 0, y: 0, width: VIEW_W, height: VIEW_H })
  const [canvasBrowserFullscreen, setCanvasBrowserFullscreen] = useState(false)
  const [canvasFullscreenFallback, setCanvasFullscreenFallback] = useState(false)
  const [threeDFullscreenRequest, setThreeDFullscreenRequest] = useState(0)
  const [threeDCameraPresetRequest, setThreeDCameraPresetRequest] = useState<{ mode: SketchCameraPreset; key: number } | null>(null)

  const stats = useMemo(() => buildSketchContourStats(model), [model])
  const activeSnapFt = snapModeStep(snapMode)
  const activeSnapFtRef = useRef(activeSnapFt)
  const canvasFullscreenActive = canvasBrowserFullscreen || canvasFullscreenFallback
  const canUndo = history.undo.length > 0
  const canRedo = history.redo.length > 0
  const setNewRoomPending = (pending: boolean) => {
    newRoomDraftPendingRef.current = pending
    setNewRoomDraftPending(pending)
  }
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
  const cabinetWallGroups = useMemo(() => {
    const cellFt = modelCellFt(model)
    const groups: Array<{
      c: number
      label: string
      options: Array<{ key: string; label: string }>
    }> = []
    cabinetWallOptions.forEach((seg, index) => {
      let group = groups.find((item) => item.c === seg.c)
      if (!group) {
        group = {
          c: seg.c,
          label: roomDisplayName(model.contours[seg.c], seg.c, t('hub_sketch_room_panel_title')),
          options: [],
        }
        groups.push(group)
      }
      const key = sketchWallKey(seg.c, seg.s)
      group.options.push({
        key,
        label: `${t('hub_sketch_3d_wall')} ${index + 1} · ${fmtFt(dist(seg.a, seg.b) * cellFt)}`,
      })
    })
    return groups
  }, [cabinetWallOptions, model, t])
  const cabinetLayoutPreview = useMemo<CabinetLayoutResult | null>(
    () => selectedCabinetWall ? layoutCabinetRunOnWall(model, selectedCabinetWall, cabinetCodes) : null,
    [model, selectedCabinetWall, cabinetCodes],
  )
  const cabinetGalleryQuery = cabinetGallerySearch.trim().toLocaleLowerCase()
  const cabinetGalleryEntries = useMemo(() => {
    if (!cabinetGalleryQuery) return CABINET_CATALOG_ENTRIES
    return CABINET_CATALOG_ENTRIES.filter((entry) => {
      const category = CABINET_CATALOG_CATEGORIES.find((item) => item.id === entry.categoryId)
      const haystack = [
        entry.codePrefix,
        t(entry.labelKey),
        category ? t(category.labelKey) : '',
      ].join(' ').toLocaleLowerCase()
      return haystack.includes(cabinetGalleryQuery)
    })
  }, [cabinetGalleryQuery, t])
  const cabinetGalleryGroups = useMemo(() => (
    CABINET_CATALOG_CATEGORIES
      .map((category) => ({
        category,
        entries: cabinetGalleryEntries.filter((entry) => entry.categoryId === category.id),
      }))
      .filter((group) => group.entries.length > 0)
  ), [cabinetGalleryEntries])
  const appendCabinetCode = useCallback((code: string) => {
    setCabinetCodes((current) => appendCabinetCodeText(current, code))
    setStatus(null)
    setError(null)
  }, [])
  const addCabinetGalleryCode = useCallback((entry: CabinetCatalogEntry, widthIn: number) => {
    appendCabinetCode(cabinetCatalogEntryCode(entry, widthIn, cabinetGalleryWallHeight))
  }, [appendCabinetCode, cabinetGalleryWallHeight])
  const addCabinetBuilderWidth = useCallback((widthIn: number) => {
    appendCabinetCode(cabinetBuilderCode(cabinetBuilderKind, widthIn, cabinetBuilderWallHeight, cabinetBuilderAppliance))
  }, [appendCabinetCode, cabinetBuilderAppliance, cabinetBuilderKind, cabinetBuilderWallHeight])
  const applyCabinetSuggestion = useCallback((invalidCode: string, replacement: string) => {
    setCabinetCodes((current) => replaceCabinetInputToken(current, invalidCode, replacement))
    setStatus(null)
    setError(null)
  }, [])
  const cabinetSuggestionLabel = useCallback((code: string): string => {
    const parsed = parseCabinetCode(code)
    return parsed ? `${code} (${t(cabinetTypeLabelKey(parsed.prefix))} ${formatInches(parsed.widthIn)})` : code
  }, [t])

  // NAV-FIX-2: сведения о выбранной стене для панели «Стена N» (номер стены общий для 2D и 3D — eachSegment).
  const selectedWall = useMemo(() => {
    if (!selectedWallKey) return null
    const index = cabinetWallOptions.findIndex((seg) => sketchWallKey(seg.c, seg.s) === selectedWallKey)
    if (index < 0) return null
    const seg = cabinetWallOptions[index]
    return { index, seg, key: selectedWallKey, lengthFt: dist(seg.a, seg.b) * modelCellFt(model) }
  }, [selectedWallKey, cabinetWallOptions, model])
  const selectedContour = useMemo(() => {
    if (selectedContourIndex === null) return null
    const contour = model.contours[selectedContourIndex]
    if (!contour || contour.points.length < 2) return null
    return {
      index: selectedContourIndex,
      contour,
      areaSqft: sketchContourAreaSqft(contour, modelCellFt(model)),
      perimeterFt: sketchContourPerimeterFt(contour, modelCellFt(model)),
    }
  }, [selectedContourIndex, model])
  const customTemplateStorageKey = useMemo(() => {
    const ownerKey = profile?.org_id || `project-${project.id}`
    return `construction-clock:sketch-room-templates:${ownerKey}`
  }, [profile?.org_id, project.id])
  const roomTemplates = useMemo(
    () => [...BUILTIN_SKETCH_ROOM_TEMPLATES, ...customRoomTemplates],
    [customRoomTemplates],
  )
  const selectedWallSurface = useMemo<SketchSurfaceFinish | null>(() => {
    if (!selectedWallKey) return null
    const finishes = normalizeFinishes(model.finishes)
    return finishes.wallFinishes[selectedWallKey] ?? finishes.walls
  }, [selectedWallKey, model.finishes])
  const selectedWallFinish = useMemo(() => {
    if (!selectedWallKey) return null
    const finishes = normalizeFinishes(model.finishes)
    const override = finishes.wallFinishes[selectedWallKey]
    const surface = selectedWallSurface ?? finishes.walls
    return {
      overridden: Boolean(override),
      kind: surface.kind,
      color: surface.kind === 'paint'
        ? cleanColor(surface.color, DEFAULT_WALL_PAINT)
        : surface.kind === 'drywall-patch'
          ? cleanColor(surface.patchColor, DEFAULT_DRYWALL_PATCH_COLOR)
          : null,
    }
  }, [selectedWallKey, selectedWallSurface, model.finishes])

  const segmentResizeConflictKeys = useMemo(
    () => new Set((segmentResizeConflict?.segments ?? []).map((segment) => sketchWallKey(segment.c, segment.s))),
    [segmentResizeConflict],
  )

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
    newRoomDraftPendingRef.current = newRoomDraftPending
  }, [newRoomDraftPending])

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
    dragNodeRef.current = dragNode
  }, [dragNode])

  useEffect(() => {
    dragPlacedIdRef.current = dragPlacedId
  }, [dragPlacedId])

  useEffect(() => {
    selectedOpeningIndexRef.current = selectedOpeningIndex
  }, [selectedOpeningIndex])

  useEffect(() => {
    if (selectedOpeningIndex !== null && !model.openings[selectedOpeningIndex]) {
      setSelectedOpeningIndex(null)
      setOpeningOffsetEdit(null)
      setOpeningSnapGuide(null)
    }
  }, [model.openings, selectedOpeningIndex])

  useEffect(() => {
    if (selectedContourIndex !== null && !model.contours[selectedContourIndex]) {
      setSelectedContourIndex(null)
    }
    if (selectedNode && !model.contours[selectedNode.c]?.points[selectedNode.p]) {
      setSelectedNode(null)
    }
  }, [model.contours, selectedContourIndex, selectedNode])

  useEffect(() => {
    activeSnapFtRef.current = activeSnapFt
  }, [activeSnapFt])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(customTemplateStorageKey)
      setCustomRoomTemplates(raw ? sanitizeRoomTemplates(JSON.parse(raw)) : [])
    } catch {
      setCustomRoomTemplates([])
    }
  }, [customTemplateStorageKey])

  const clearModelChangeState = useCallback(() => {
    setSketchMaterials(null)
    setSketchMaterialsAdded(null)
    setStatus(null)
    setError(null)
    setSegmentLengthEdit(null)
    setSegmentResizeConflict(null)
    setOpeningOffsetEdit(null)
    setOpeningSnapGuide(null)
    setHoverSnapGuide(null)
    setClearConfirmOpen(false)
    setSmartGuides([])
  }, [])

  // Снимок в историю перед изменением; затем применяем мутатор.
  const commit = useCallback((next: SketchModel) => {
    const current = modelRef.current
    setHistory((h) => recordSketchHistory(h, current, SKETCH_HISTORY_LIMIT))
    modelRef.current = next
    setModel(next)
    clearModelChangeState()
  }, [clearModelChangeState])

  const recordHistoryStep = useCallback(() => {
    setHistory((h) => recordSketchHistory(h, modelRef.current, SKETCH_HISTORY_LIMIT))
    clearModelChangeState()
  }, [clearModelChangeState])

  const applyCopySelection = (selection: SketchCopySelection) => {
    setSelectedMeasurementIndex(null)
    setSelectedOpeningIndex(null)
    setOpeningOffsetEdit(null)
    setMeasurementDraft(null)
    setDragNode(null)
    setSelectedNode(null)
    setDragPlacedId(null)
    if (selection.kind === 'contour') {
      setSelectedContourIndex(selection.c)
      setSelectedWallKey(null)
    } else {
      setSelectedContourIndex(null)
      setSelectedWallKey(sketchWallKey(selection.c, selection.s))
    }
  }

  const activeCopySelection = (): SketchCopySelection | null => {
    if (selectedContour) return { kind: 'contour', c: selectedContour.index }
    if (selectedWall) return { kind: 'wall', c: selectedWall.seg.c, s: selectedWall.seg.s }
    return null
  }

  const persistCustomRoomTemplates = (templates: SketchRoomTemplate[]) => {
    const next = templates.slice(0, CUSTOM_TEMPLATE_LIMIT)
    setCustomRoomTemplates(next)
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(customTemplateStorageKey, JSON.stringify(next))
    } catch {
      setError('hub_sketch_template_save_failed')
    }
  }

  const templateDisplayName = (template: SketchRoomTemplate): string => {
    if (template.labelKey) return t(template.labelKey)
    return template.name?.trim() || t('hub_sketch_template_custom')
  }

  const templateStatsText = (template: SketchRoomTemplate): string => {
    const contour = template.model.contours[0]
    if (!contour) return ''
    const cellFt = Number.isFinite(template.model.cellFt) && template.model.cellFt > 0 ? template.model.cellFt : CELL_FT
    return `${sketchContourAreaSqft(contour, cellFt).toFixed(0)} ft² · ${fmtFt(sketchContourPerimeterFt(contour, cellFt))}`
  }

  const addRoomTemplate = (template: SketchRoomTemplate) => {
    if (!canEdit) return
    const origin = suggestedSketchTemplateOrigin(model, template.model)
    const result = insertSketchTemplate(model, template, origin, makeId)
    if (!result) return
    canvasAutoFitRef.current = true
    commit(normalizeSketchModelForStorage(result.model))
    applyCopySelection(result.selection)
    setTemplatePickerOpen(false)
    setStatus('hub_sketch_template_inserted')
  }

  const duplicateSelectedSketch = () => {
    const selection = activeCopySelection()
    if (!canEdit || !selection) return
    const result = duplicateSketchSelection(model, selection, { x: DUPLICATE_OFFSET_CELLS, y: DUPLICATE_OFFSET_CELLS }, makeId)
    if (!result) return
    canvasAutoFitRef.current = true
    commit(normalizeSketchModelForStorage(result.model))
    applyCopySelection(result.selection)
    setStatus('hub_sketch_duplicated')
  }

  const mirrorSelectedSketch = () => {
    const selection = activeCopySelection()
    if (!canEdit || !selection) return
    const contour = model.contours[selection.c]
    if (!contour) return
    const bounds = sketchBounds({ ...model, contours: [contour] })
    const axisX = (bounds.minX + bounds.maxX) / 2
    const result = mirrorSketchSelection(model, selection, axisX, { x: Math.max(DUPLICATE_OFFSET_CELLS, bounds.width + DUPLICATE_OFFSET_CELLS), y: 0 }, makeId)
    if (!result) return
    canvasAutoFitRef.current = true
    commit(normalizeSketchModelForStorage(result.model))
    applyCopySelection(result.selection)
    setStatus('hub_sketch_mirrored')
  }

  const saveCurrentAsTemplate = () => {
    if (!canEdit) return
    const selection = selectedContour
      ? { kind: 'contour' as const, c: selectedContour.index }
      : selectedWall
        ? { kind: 'contour' as const, c: selectedWall.seg.c }
        : null
    const hasClosedRoom = selection
      ? model.contours[selection.c]?.closed
      : model.contours.some((contour) => contour.closed && contour.points.length >= 3)
    if (!hasClosedRoom) {
      setError('hub_sketch_template_need_room')
      return
    }
    const templateName = selection
      ? `${name.trim() || t('hub_sketch_template_custom')} · ${t('hub_sketch_contour')} ${selection.c + 1}`
      : name.trim() || t('hub_sketch_template_custom')
    const template = templateFromSketchModel(makeId('template'), templateName, model, selection ?? undefined)
    if (!template) {
      setError('hub_sketch_template_need_room')
      return
    }
    persistCustomRoomTemplates([template, ...customRoomTemplates.filter((item) => item.id !== template.id)])
    setTemplatePickerOpen(true)
    setStatus('hub_sketch_template_saved')
  }

  const addCornerToSelectedWall = () => {
    if (!canEdit || !selectedWall) return
    const contour = model.contours[selectedWall.seg.c]
    if (!contour) return
    const indexes = selectedWall.seg.s < contour.points.length - 1
      ? { insertAt: selectedWall.seg.s + 1, a: contour.points[selectedWall.seg.s], b: contour.points[selectedWall.seg.s + 1] }
      : contour.closed && selectedWall.seg.s === contour.points.length - 1
        ? { insertAt: contour.points.length, a: contour.points[contour.points.length - 1], b: contour.points[0] }
        : null
    if (!indexes) return
    const midpoint = { x: (indexes.a.x + indexes.b.x) / 2, y: (indexes.a.y + indexes.b.y) / 2 }
    const nextPoints = [
      ...contour.points.slice(0, indexes.insertAt),
      midpoint,
      ...contour.points.slice(indexes.insertAt),
    ]
    const nextContours = model.contours.map((item, index) => (index === selectedWall.seg.c ? { ...item, points: nextPoints } : item))
    const shiftedOpenings = model.openings.map((opening) => (
      opening.c === selectedWall.seg.c && opening.s >= indexes.insertAt
        ? { ...opening, s: opening.s + 1 }
        : opening
    ))
    const shiftedPlacedItems = (model.placedItems ?? []).map((item) => (
      item.c === selectedWall.seg.c && Number.isInteger(item.s) && (item.s ?? 0) >= indexes.insertAt
        ? { ...item, s: (item.s ?? 0) + 1, wallId: sketchWallKey(item.c ?? 0, (item.s ?? 0) + 1) }
        : item
    ))
    const nextModel = normalizeSketchModelForStorage({
      ...model,
      contours: nextContours,
      openings: shiftedOpenings,
      ...(shiftedPlacedItems.length > 0 ? { placedItems: shiftedPlacedItems } : {}),
    })
    canvasAutoFitRef.current = false
    commit(nextModel)
    setSelectedWallKey(sketchWallKey(selectedWall.seg.c, selectedWall.seg.s))
  }

  const removeSelectedCorner = () => {
    if (!canEdit || !selectedNode) return
    const contour = model.contours[selectedNode.c]
    if (!contour || contour.points.length <= (contour.closed ? 3 : 2)) return
    const removedIndex = selectedNode.p
    const nextPoints = contour.points.filter((_, index) => index !== removedIndex)
    const nextContours = model.contours.map((item, index) => (index === selectedNode.c ? { ...item, points: nextPoints } : item))
    const maxSegment = nextPoints.length - (contour.closed ? 1 : 2)
    const nextOpenings = model.openings
      .filter((opening) => !(opening.c === selectedNode.c && (opening.s === removedIndex || opening.s === removedIndex - 1)))
      .map((opening) => (
        opening.c === selectedNode.c && opening.s > removedIndex
          ? { ...opening, s: Math.max(0, Math.min(maxSegment, opening.s - 1)) }
          : opening
      ))
    const nextPlacedItems = (model.placedItems ?? [])
      .filter((item) => !(item.c === selectedNode.c && (item.s === removedIndex || item.s === removedIndex - 1)))
      .map((item) => (
        item.c === selectedNode.c && Number.isInteger(item.s) && (item.s ?? 0) > removedIndex
          ? { ...item, s: Math.max(0, Math.min(maxSegment, (item.s ?? 0) - 1)), wallId: sketchWallKey(item.c ?? 0, Math.max(0, Math.min(maxSegment, (item.s ?? 0) - 1))) }
          : item
      ))
    canvasAutoFitRef.current = false
    commit(normalizeSketchModelForStorage({
      ...model,
      contours: nextContours,
      openings: nextOpenings,
      ...(nextPlacedItems.length > 0 ? { placedItems: nextPlacedItems } : {}),
    }))
    setDragNode(null)
    setSelectedNode(null)
    setSelectedContourIndex(selectedNode.c)
  }

  const beginSegmentLengthEdit = (dim: SegmentDimLine) => {
    if (!canEdit) return
    setSegmentLengthEdit({ ref: { c: dim.c, s: dim.s }, value: formatLengthFt(dim.lengthFt) })
    setSegmentResizeConflict(null)
    setSelectedMeasurementIndex(null)
    setMeasurementDraft(null)
  }

  const setSegmentLengthEditValue = (value: string) => {
    setSegmentLengthEdit((current) => (current ? { ...current, value } : current))
  }

  const cancelSegmentLengthEdit = () => {
    setSegmentLengthEdit(null)
    setSegmentResizeConflict(null)
  }

  const applySegmentLengthEdit = (anchor: SketchSegmentResizeAnchor = 'start') => {
    if (!segmentLengthEdit) return
    const parsed = parseLengthFt(segmentLengthEdit.value)
    if (!Number.isFinite(parsed)) {
      setSegmentResizeConflict({ reason: 'invalid-length', segments: [segmentLengthEdit.ref] })
      setError('hub_sketch_dimension_invalid')
      return
    }
    const nextLengthFt = snapFeetToPrecision(parsed)
    const result = resizeSketchSegmentToLength(model, segmentLengthEdit.ref, nextLengthFt, { anchor })
    if (!result.ok) {
      setSegmentResizeConflict(result.conflict)
      setError('hub_sketch_dimension_conflict')
      return
    }
    canvasAutoFitRef.current = false
    commit(result.model)
  }

  const applyOpeningT = (index: number, nextT: number) => {
    const current = modelRef.current
    const opening = current.openings[index]
    if (!opening) return
    const clampedT = clampOpeningT(current, opening, nextT)
    const nextModel = { ...current, openings: current.openings.map((op, i) => (i === index ? { ...op, t: clampedT } : op)) }
    canvasAutoFitRef.current = false
    selectedOpeningIndexRef.current = index
    setSelectedOpeningIndex(index)
    commit(nextModel)
  }

  const centerSelectedOpening = () => {
    const index = selectedOpeningIndexRef.current
    if (index === null) return
    const current = modelRef.current
    const opening = current.openings[index]
    if (!opening) return
    const segmentLengthFt = openingSegmentLengthFt(current, opening)
    if (segmentLengthFt <= 0.001) return
    applyOpeningT(index, centerOpeningT(segmentLengthFt, openingWidthFt(opening)))
  }

  const updateOpeningAt = (index: number, patch: Partial<Opening>) => {
    const current = modelRef.current
    const opening = current.openings[index]
    if (!opening) return
    const nextOpening = normalizeOpeningForModel(current, { ...opening, ...patch })
    if (!nextOpening) return
    const nextModel = {
      ...current,
      openings: current.openings.map((item, itemIndex) => (itemIndex === index ? nextOpening : item)),
    }
    canvasAutoFitRef.current = false
    selectedOpeningIndexRef.current = index
    setSelectedOpeningIndex(index)
    commit(nextModel)
  }

  const updateSelectedOpeningWidth = (valueFt: number) => {
    const index = selectedOpeningIndexRef.current
    if (index === null) return
    updateOpeningAt(index, { w: Math.max(0.5, snapOpeningFeetToPrecision(valueFt)) })
  }

  const updateSelectedOpeningHeight = (valueFt: number) => {
    const index = selectedOpeningIndexRef.current
    if (index === null) return
    updateOpeningAt(index, { h: Math.max(0.5, snapOpeningFeetToPrecision(valueFt)) })
  }

  const updateSelectedOpeningFloor = (valueFt: number) => {
    const index = selectedOpeningIndexRef.current
    if (index === null) return
    updateOpeningAt(index, { sill: Math.max(0, snapOpeningFeetToPrecision(valueFt)) })
  }

  const removeSelectedOpening = () => {
    const index = selectedOpeningIndexRef.current
    const current = modelRef.current
    if (index === null || !current.openings[index]) return
    commit({ ...current, openings: current.openings.filter((_, itemIndex) => itemIndex !== index) })
    selectedOpeningIndexRef.current = null
    setSelectedOpeningIndex(null)
    setOpeningOffsetEdit(null)
    setOpeningSnapGuide(null)
  }

  const beginOpeningOffsetEdit = (index: number, side: OpeningOffsetSide, valueFt: number) => {
    if (!canEdit) return
    setSelectedOpeningIndex(index)
    selectedOpeningIndexRef.current = index
    setOpeningOffsetEdit({ index, side, value: formatOpeningFt(valueFt) })
    setSegmentLengthEdit(null)
    setSegmentResizeConflict(null)
    setSelectedMeasurementIndex(null)
    setMeasurementDraft(null)
  }

  const setOpeningOffsetEditValue = (value: string) => {
    setOpeningOffsetEdit((current) => (current ? { ...current, value } : current))
  }

  const cancelOpeningOffsetEdit = () => {
    setOpeningOffsetEdit(null)
  }

  const applyOpeningOffsetEdit = () => {
    if (!openingOffsetEdit) return
    const parsed = parseLengthFt(openingOffsetEdit.value)
    if (!Number.isFinite(parsed)) {
      setError('hub_sketch_dimension_invalid')
      return
    }
    const current = modelRef.current
    const opening = current.openings[openingOffsetEdit.index]
    if (!opening) {
      setOpeningOffsetEdit(null)
      return
    }
    const segmentLengthFt = openingSegmentLengthFt(current, opening)
    const widthFt = Math.min(openingWidthFt(opening), segmentLengthFt)
    const maxOffsetFt = Math.max(0, segmentLengthFt - widthFt)
    const offsetFt = Math.max(0, parsed)
    if (offsetFt > maxOffsetFt + 0.0001) {
      setError('hub_sketch_dimension_conflict')
      return
    }
    applyOpeningT(openingOffsetEdit.index, openingTForOffset(segmentLengthFt, widthFt, openingOffsetEdit.side, offsetFt))
  }

  useEffect(() => {
    if (!segmentLengthEdit) return
    if (!eachSegment(model).some((seg) => seg.c === segmentLengthEdit.ref.c && seg.s === segmentLengthEdit.ref.s)) {
      cancelSegmentLengthEdit()
    }
  }, [model, segmentLengthEdit])

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
      setWallElevationFullscreen(false)
    }
  }, [selectedWallKey, cabinetWallOptions])

  useEffect(() => {
    if (!selectedWall) {
      setWallElevationFullscreen(false)
      setWallElevationFinishPanelOpen(false)
    }
  }, [selectedWall])

  const openWallElevationFullscreen = useCallback((finishPanelOpen = false) => {
    setWallElevationFinishPanelOpen(finishPanelOpen)
    setWallElevationFullscreen(true)
  }, [])

  const closeWallElevationFullscreen = useCallback(() => {
    setWallElevationFullscreen(false)
  }, [])

  const handle3DWallPick = useCallback((key: string | null) => {
    setSelectedWallKey(key)
    if (key) openWallElevationFullscreen(false)
  }, [openWallElevationFullscreen])

  // NAV-FIX-2: Esc снимает выделение стены в обоих видах (2D и 3D), а сначала закрывает fullscreen-развёртку.
  useEffect(() => {
    if (selectedWallKey === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableKeyTarget(event.target)) return
      if (event.key === 'Escape') {
        if (wallElevationFullscreen) setWallElevationFullscreen(false)
        else setSelectedWallKey(null)
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedWallKey, wallElevationFullscreen])

  // NAV-FIX-2: кнопки панели «Стена N» — только навигация в существующие режимы с уже выбранной стеной.
  const openWallFinish = () => {
    if (!selectedWall) return
    setActiveMode('finish')
    setContextSheetOpen(true)
    setMeasurementDraft(null)
    setSelectedMeasurementIndex(null)
    openWallElevationFullscreen(true)
  }
  const openWallOpenings = () => {
    if (!selectedWall) return
    setActiveMode('opening')
    setContextSheetOpen(true)
    setWallElevationFullscreen(false)
    canvasAutoFitRef.current = false
    setMeasurementDraft(null)
    setViewMode('2d')
    setTool('door')
  }
  const openWallCabinets = () => {
    if (!selectedWall) return
    setActiveMode('cabinet')
    setContextSheetOpen(true)
    setWallElevationFullscreen(false)
    canvasAutoFitRef.current = false
    setMeasurementDraft(null)
    setViewMode('2d')
    setTool('cabinet')
    setSelectedCabinetWallKey(selectedWall.key)
  }

  const selectSketchMode = (mode: SketchMode) => {
    setActiveMode(mode)
    setContextSheetOpen(true)
    setWallElevationFullscreen(false)
    setOpeningOffsetEdit(null)
    setOpeningSnapGuide(null)
    // SKETCH-DISCOVER-FIX-17: сбрасываем залипший инспектор проёма — «Дверь» не переживает уход из opening.
    setSelectedOpeningIndex(null)
    selectedOpeningIndexRef.current = null
    // SKETCH-DISCOVER-FIX-17: режимы с инструментами сразу раскрывают контекст-панель (иначе прячется за ☰).
    if (mode === 'cabinet' || mode === 'finish' || mode === 'light' || mode === 'opening') {
      setContextPanelCollapsed(false)
    }
    if (mode !== 'wall') setNewRoomPending(false)

    if (mode === 'wall') {
      setViewMode('2d')
      setTool('wall')
      setMeasurementDraft(null)
      setSelectedMeasurementIndex(null)
      return
    }
    if (mode === 'opening') {
      setViewMode('2d')
      setTool((current) => (current === 'window' ? 'window' : 'door'))
      setMeasurementDraft(null)
      setSelectedMeasurementIndex(null)
      return
    }
    if (mode === 'cabinet') {
      setViewMode('2d')
      setTool('cabinet')
      setMeasurementDraft(null)
      setSelectedMeasurementIndex(null)
      return
    }
    if (mode === 'measure') {
      setTool('measure')
      setShowMeasurements(true)
      setMeasurementDraft(null)
      return
    }
    if (mode === 'finish' || mode === 'light') {
      setViewMode('3d')
      setTool('wall')
      setMeasurementDraft(null)
      setSelectedMeasurementIndex(null)
      return
    }
    setViewMode('2d')
    setTool('wall')
    setMeasurementDraft(null)
    setSelectedMeasurementIndex(null)
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
    const preferCssFullscreen = typeof window !== 'undefined' && (
      window.matchMedia('(max-width: 720px)').matches ||
      /iP(hone|od)/.test(window.navigator.userAgent) ||
      !document.fullscreenEnabled ||
      !shell.requestFullscreen
    )
    if (preferCssFullscreen) {
      setCanvasBrowserFullscreen(false)
      setCanvasFullscreenFallback(true)
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

  const switchSketchViewMode = useCallback((mode: ViewMode, preserveFullscreen = false) => {
    if (mode === viewMode) return
    if (mode === '2d') canvasAutoFitRef.current = true
    setWallElevationFullscreen(false)
    setMeasurementDraft(null)
    setSelectedMeasurementIndex(null)

    if (preserveFullscreen) {
      if (mode === '2d') {
        setCanvasBrowserFullscreen(false)
        setCanvasFullscreenFallback(true)
      } else {
        setCanvasBrowserFullscreen(false)
        setCanvasFullscreenFallback(false)
        setThreeDFullscreenRequest((value) => value + 1)
      }
    }

    setViewMode(mode)
  }, [viewMode])

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
    const segmentLengthFt = openingSegmentLengthFt(model, draft)
    if (segmentLengthFt <= 0.001) return { ...draft, t: clampOpeningT(model, draft, rawT) }
    const placement = softOpeningPlacement({
      rawT,
      segmentLengthFt,
      openingWidthFt: openingWidthFt(draft),
      precisionStepFt: activeSnapFt,
      magnetThresholdFt: openingMagnetThresholdFt(model, screenWorldPx),
      neighbors: openingPlacementNeighbors(model, draft, -1),
    })
    return { ...draft, t: placement.t }
  }

  const electricalPlacedAt = (kind: 'outlet' | 'switch', c: number, s: number, rawT: number): SketchPlacedCatalogItem | null => {
    const seg = eachSegment(model).find((candidate) => candidate.c === c && candidate.s === s)
    if (!seg) return null
    const cellFt = modelCellFt(model)
    const tValue = Math.max(0, Math.min(1, rawT))
    const ax = seg.a.x * cellFt
    const az = seg.a.y * cellFt
    const bx = seg.b.x * cellFt
    const bz = seg.b.y * cellFt
    const xFt = ax + (bx - ax) * tValue
    const zFt = az + (bz - az) * tValue
    const markerKind = kind === 'outlet' ? SKETCH_CATALOG_KIND_OUTLET : SKETCH_CATALOG_KIND_SWITCH
    return {
      id: makeId(kind),
      catalogItemId: kind === 'outlet' ? BUILTIN_OUTLET_CATALOG_ID : BUILTIN_SWITCH_CATALOG_ID,
      category: 'other',
      kind: markerKind,
      name: t(kind === 'outlet' ? 'hub_sketch_outlet' : 'hub_sketch_switch'),
      model: markerKind,
      xFt,
      yFt: kind === 'outlet' ? 1.5 : 4,
      zFt,
      rotationY: -Math.atan2(bz - az, bx - ax),
      surface: 'wall',
      c,
      s,
      t: tValue,
    }
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

  const screenWorldPxForView = (view = canvasViewRef.current): number => {
    return view.width / Math.max(1, canvasSizeRef.current.width)
  }

  const smartGuideThresholdCells = (view = canvasViewRef.current): number => {
    return Math.min(SMART_GUIDE_MAX_CELLS, (SMART_GUIDE_SCREEN_PX * screenWorldPxForView(view)) / CELL_PX)
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

  const zoomCanvasToCenter = (factor: number) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    canvasAutoFitRef.current = false
    setCanvasView((view) => {
      const nextView = zoomCanvasAt(centerX, centerY, factor, view)
      canvasViewRef.current = nextView
      return nextView
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

  // Прилипание новой точки к вершинам/стенам ДРУГИХ контуров.
  const snapToExistingForModel = (
    baseModel: SketchModel,
    p: Pt,
    options: { excludeContourIndex?: number } = {},
  ): SketchExistingSnapResult | null => (
    snapToExistingGeometry(baseModel, p, { radiusCells: ROOM_SNAP, excludeContourIndex: options.excludeContourIndex })
  )

  // Точка для установки угла стены: прилипание к чужой геометрии имеет приоритет над сеткой.
  const wallPointForModel = (baseModel: SketchModel, raw: Pt, stepFt: number): { p: Pt; snapped: boolean; snap: SketchExistingSnapResult | null } => {
    const active = baseModel.contours[baseModel.contours.length - 1]
    if (shouldCloseOpenContourFromPoint(active, raw, CLOSE_SNAP)) {
      return { p: active.points[0], snapped: true, snap: null }
    }
    const s = snapToExistingForModel(baseModel, raw)
    return s ? { p: s.point, snapped: true, snap: s } : { p: snapForModel(baseModel, raw, stepFt), snapped: false, snap: null }
  }

  const wallPoint = (raw: Pt): { p: Pt; snapped: boolean } => wallPointForModel(model, raw, activeSnapFt)

  const measurementPointForModel = (baseModel: SketchModel, raw: Pt, stepFt: number): { p: Pt; snapped: boolean; snap: SketchExistingSnapResult | null } => {
    const s = snapToExistingForModel(baseModel, raw)
    return s ? { p: s.point, snapped: true, snap: s } : { p: snapForModel(baseModel, raw, stepFt), snapped: false, snap: null }
  }

  const measurementPoint = (raw: Pt): { p: Pt; snapped: boolean } => measurementPointForModel(model, raw, activeSnapFt)

  const applyPointerMoveAt = (clientX: number, clientY: number, view = canvasViewRef.current, pointerId?: number) => {
    if (!canEditRef.current) return
    const raw = pointerCellAt(clientX, clientY, view)
    const armedDragNode = armedDragNodeRef.current
    if (
      armedDragNode &&
      dragNodeRef.current === null &&
      (pointerId === undefined || armedDragNode.pointerId === pointerId)
    ) {
      const currentScreenPoint = { clientX, clientY }
      if (!screenPointerMovedBeyondThreshold(armedDragNode.origin, currentScreenPoint, NODE_DRAG_THRESHOLD_PX)) return
      if (!raw) {
        setSmartGuides([])
        setHoverSnapGuide(null)
        return
      }
      const node = { c: armedDragNode.c, p: armedDragNode.p }
      armedDragNodeRef.current = null
      recordHistoryStep()
      dragMovedRef.current = true
      dragNodeRef.current = node
      setDragNode(node)
      edgeAutoPanPointerRef.current = currentScreenPoint
      updateEdgeAutoPan(clientX, clientY)
    }
    const currentDragNode = dragNodeRef.current
    if (currentDragNode) {
      if (!raw) {
        setSmartGuides([])
        setHoverSnapGuide(null)
        return
      }
      dragMovedRef.current = true
      setModel((m) => {
        const contour = m.contours[currentDragNode.c]
        if (!contour || !contour.points[currentDragNode.p]) {
          setSmartGuides([])
          return m
        }
        const thresholdCells = smartGuideThresholdCells(view)
        const existingSnap = snapToExistingForModel(m, raw, { excludeContourIndex: currentDragNode.c })
        const fallback = existingSnap?.point ?? snapForModel(m, raw, activeSnapFtRef.current)
        const guided = snapPointWithSmartGuides(m, raw, {
          fallbackPoint: fallback,
          thresholdCells,
          excludeContourIndex: currentDragNode.c,
          excludePointIndex: currentDragNode.p,
        })
        const cornerSquare = snapCornerSquare(m, existingSnap?.point ?? guided.point, {
          contourIndex: currentDragNode.c,
          pointIndex: currentDragNode.p,
          thresholdCells,
        })
        setSmartGuides([...(existingSnap ? [] : guided.guides), ...cornerSquare.guides])
        const nextContours = m.contours.map((item, contourIndex) => (
          contourIndex === currentDragNode.c
            ? {
                ...item,
                points: item.points.map((point, pointIndex) => (pointIndex === currentDragNode.p ? cornerSquare.point : point)),
              }
            : item
        ))
        const nextBaseModel: SketchModel = {
          ...m,
          contours: nextContours,
        }
        nextBaseModel.openings = m.openings.map((opening) => (
          opening.c === currentDragNode.c ? { ...opening, t: clampOpeningT(nextBaseModel, opening, opening.t) } : opening
        ))
        const placedItems = repositionWallBoundTemplateItems(m.placedItems, m, nextBaseModel)
        const nextModel = {
          ...nextBaseModel,
          ...(placedItems ? { placedItems } : {}),
        }
        modelRef.current = nextModel
        return nextModel
      })
      return
    }
    const currentDragIdx = dragIdxRef.current
    if (currentDragIdx !== null) {
      if (!raw) {
        setOpeningSnapGuide(null)
        setSmartGuides([])
        setHoverSnapGuide(null)
        return
      }
      dragMovedRef.current = true
      setModel((m) => {
        const o = m.openings[currentDragIdx]
        if (!o) {
          setOpeningSnapGuide(null)
          return m
        }
        const ends = openingEnds(m, o)
        if (!ends) {
          setOpeningSnapGuide(null)
          return m
        }
        const rawT = projectT(raw, ends.a, ends.b)
        const placement = softOpeningPlacement({
          rawT,
          segmentLengthFt: dist(ends.a, ends.b) * modelCellFt(m),
          openingWidthFt: openingWidthFt(o),
          precisionStepFt: activeSnapFtRef.current,
          magnetThresholdFt: openingMagnetThresholdFt(m, screenWorldPxForView(view)),
          neighbors: openingPlacementNeighbors(m, o, currentDragIdx),
        })
        setOpeningSnapGuide(placement.magnet)
        const nextT = placement.t
        const nextModel = { ...m, openings: m.openings.map((op, i) => (i === currentDragIdx ? { ...op, t: nextT } : op)) }
        modelRef.current = nextModel
        return nextModel
      })
      return
    }
    const currentDragPlacedId = dragPlacedIdRef.current
    if (currentDragPlacedId !== null) {
      if (!raw) {
        setSmartGuides([])
        setHoverSnapGuide(null)
        return
      }
      dragMovedRef.current = true
      setModel((m) => {
        const placedItems = sanitizePlacedCatalogItems(m.placedItems)
        const item = placedItems.find((placed) => placed.id === currentDragPlacedId)
        if (!item) {
          setSmartGuides([])
          return m
        }
        const fallback = snapForModel(m, raw, activeSnapFtRef.current)
        const guided = snapPointWithSmartGuides(m, raw, {
          fallbackPoint: fallback,
          thresholdCells: smartGuideThresholdCells(view),
          excludeItemId: currentDragPlacedId,
        })
        setSmartGuides(guided.guides)
        const cellFt = modelCellFt(m)
        const near = nearestSegment(m, guided.point)
        const keepWallBound = item.surface === 'wall' || Number.isInteger(item.c)
        const nextItems = placedItems.map((placed) => {
          if (placed.id !== currentDragPlacedId) return placed
          if (keepWallBound && near && near.d <= SEG_HIT) {
            const seg = eachSegment(m).find((candidate) => candidate.c === near.c && candidate.s === near.s)
            if (seg) {
              const rawT = Math.max(0, Math.min(1, near.t))
              const targetWallId = sketchWallKey(near.c, near.s)
              // CABINETS-PLACE-13: кабинет скользит вдоль стены с bump-упором в соседа/угол.
              const tValue = isCabinetPlacedItem(placed)
                ? clampCabinetTAlongWall(
                    placedItems,
                    placed,
                    Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y) * cellFt * 12,
                    targetWallId,
                    rawT,
                  )
                : rawT
              const xFt = (seg.a.x + (seg.b.x - seg.a.x) * tValue) * cellFt
              const zFt = (seg.a.y + (seg.b.y - seg.a.y) * tValue) * cellFt
              return {
                ...placed,
                xFt,
                zFt,
                c: near.c,
                s: near.s,
                t: tValue,
                wallId: targetWallId,
                rotationY: -Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x),
              }
            }
          }
          const { c: _c, s: _s, t: _t, wallId: _wallId, ...freePlaced } = placed
          return {
            ...freePlaced,
            xFt: guided.point.x * cellFt,
            zFt: guided.point.y * cellFt,
          }
        })
        const nextModel = { ...m, placedItems: nextItems }
        modelRef.current = nextModel
        return nextModel
      })
      return
    }
    if (!raw) {
      setHover(null)
      setHoverSnapped(false)
      setHoverSnapGuide(null)
      setSmartGuides([])
      return
    }
    const currentModel = modelRef.current
    const currentTool = toolRef.current
    if (currentTool === 'wall') {
      const active = currentModel.contours[currentModel.contours.length - 1]
      if (!shouldTrackWallDraftPointer(active, newRoomDraftPendingRef.current)) {
        setHover(null)
        setHoverSnapped(false)
        setHoverSnapGuide(null)
        setSmartGuides([])
        return
      }
      const wp = wallPointForModel(currentModel, raw, activeSnapFtRef.current)
      setHover(wp.p)
      setHoverSnapped(wp.snapped)
      setHoverSnapGuide(wp.snap)
    } else if (currentTool === 'measure') {
      const mp = measurementPointForModel(currentModel, raw, activeSnapFtRef.current)
      setHover(mp.p)
      setHoverSnapped(mp.snapped)
      setHoverSnapGuide(mp.snap)
    } else {
      setHover(raw)
      setHoverSnapped(false)
      setHoverSnapGuide(null)
    }
    setSmartGuides([])
  }

  function edgeAutoPanInteractionActive(): boolean {
    const currentTool = toolRef.current
    if (dragIdxRef.current !== null) return true
    if (dragNodeRef.current !== null || dragPlacedIdRef.current !== null) return true
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

  const resetWallDraftAfterFinish = useCallback((result: { changed: boolean; action: 'closed' | 'discarded' | 'none' }) => {
    if (!shouldResetWallDraftAfterContourFinish(result)) return
    const nextDraft = resolveWallDraftAfterContourFinish(result, {
      hover: null,
      hoverSnapped: false,
      hoverSnapGuide: null as SketchExistingSnapResult | null,
      newRoomDraftPending: newRoomDraftPendingRef.current,
    })
    setHover(nextDraft.hover)
    setHoverSnapped(nextDraft.hoverSnapped)
    setHoverSnapGuide(nextDraft.hoverSnapGuide)
    setNewRoomPending(nextDraft.newRoomDraftPending)
    setSmartGuides([])
    stopEdgeAutoPan()
  }, [])

  const markContourJustClosed = useCallback((contourIndex: number) => {
    if (contourIndex < 0) return
    if (closedContourFlashTimerRef.current !== null) {
      window.clearTimeout(closedContourFlashTimerRef.current)
      closedContourFlashTimerRef.current = null
    }
    setRecentlyClosedContourIndex(contourIndex)
    closedContourFlashTimerRef.current = window.setTimeout(() => {
      setRecentlyClosedContourIndex((current) => (current === contourIndex ? null : current))
      closedContourFlashTimerRef.current = null
    }, 1400)
  }, [])

  useEffect(() => () => {
    if (closedContourFlashTimerRef.current !== null) {
      window.clearTimeout(closedContourFlashTimerRef.current)
      closedContourFlashTimerRef.current = null
    }
  }, [])

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

  const finishOpenContourFromModel = useCallback((baseModel: SketchModel, options: {
    minClosedPoints?: number
    discardIncomplete?: boolean
    closeComplete?: boolean
  } = {}) => {
    const finishedContourIndex = baseModel.contours.length - 1
    const result = finishLastOpenContour(baseModel, options)
    if (!result.changed) return false
    commit(result.model as SketchModel)
    lastWallClickAppendRef.current = null
    resetWallDraftAfterFinish(result)
    if (result.action === 'closed') markContourJustClosed(finishedContourIndex)
    if (result.action === 'discarded') {
      setSelectedNode(null)
      setSelectedContourIndex(null)
      setSelectedWallKey(null)
    }
    return true
  }, [commit, markContourJustClosed, resetWallDraftAfterFinish])

  const finishActiveOpenContour = useCallback((options: {
    minClosedPoints?: number
    discardIncomplete?: boolean
    closeComplete?: boolean
  } = {}) => finishOpenContourFromModel(modelRef.current, options), [finishOpenContourFromModel])

  useEffect(() => {
    if (!canEdit || viewMode !== '2d') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableKeyTarget(event.target)) return
      if (event.key === 'Escape') {
        if (tool === 'measure') {
          setTool('wall')
          setMeasurementDraft(null)
          setSelectedMeasurementIndex(null)
          event.preventDefault()
          return
        }
        if (tool === 'wall' && finishActiveOpenContour({ closeComplete: false })) {
          event.preventDefault()
          return
        }
      }
      if (event.key === 'Enter' && tool === 'wall' && finishActiveOpenContour()) {
        event.preventDefault()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedMeasurementIndex !== null) {
        removeMeasurement(selectedMeasurementIndex)
        event.preventDefault()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNode !== null) {
        removeSelectedCorner()
        event.preventDefault()
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedOpeningIndex !== null) {
        removeSelectedOpening()
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canEdit, viewMode, tool, selectedMeasurementIndex, selectedOpeningIndex, selectedNode, model, finishActiveOpenContour])

  useEffect(() => {
    if (selectedMeasurementIndex !== null && !model.measurements?.[selectedMeasurementIndex]) {
      setSelectedMeasurementIndex(null)
    }
  }, [model.measurements, selectedMeasurementIndex])

  const closeSketchPropertiesPanel = () => {
    setWallElevationFullscreen(false)
    setSelectedWallKey(null)
    setSelectedContourIndex(null)
    setSelectedNode(null)
    selectedOpeningIndexRef.current = null
    setSelectedOpeningIndex(null)
    setOpeningOffsetEdit(null)
    setOpeningSnapGuide(null)
    setSelectedMeasurementIndex(null)
  }

  const clearCanvasTapTimer = () => {
    const tap = canvasTapRef.current
    if (tap && tap.longPressTimer !== null) {
      window.clearTimeout(tap.longPressTimer)
      tap.longPressTimer = null
    }
  }

  const shouldIgnoreTouchForActivePen = (e: React.PointerEvent): boolean => (
    e.pointerType === 'touch' && penActiveRef.current && activePenPointerIdRef.current !== e.pointerId
  )

  const finishPenPointer = (e: React.PointerEvent) => {
    if (e.pointerType !== 'pen' || activePenPointerIdRef.current !== e.pointerId) return
    penActiveRef.current = false
    activePenPointerIdRef.current = null
  }

  const activeTouchPointers = (): CanvasPointer[] => (
    Array.from(canvasPointersRef.current.values()).filter((pointer) => pointer.pointerType === 'touch')
  )

  const beginCanvasPinchFromTouches = () => {
    const touches = activeTouchPointers()
    if (touches.length < 2) return false
    const [a, b] = touches
    clearCanvasTapTimer()
    canvasTapRef.current = null
    canvasPanRef.current = null
    canvasPinchRef.current = {
      startDistance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
      startMid: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
      view: canvasViewRef.current,
    }
    canvasSuppressClickRef.current = true
    return true
  }

  const beginCanvasTapGesture = (e: React.PointerEvent<SVGSVGElement>) => {
    clearCanvasTapTimer()
    const gesture: CanvasTapGesture = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      pointerType: e.pointerType,
      moved: false,
      longPressed: false,
      longPressTimer: null,
    }
    gesture.longPressTimer = window.setTimeout(() => {
      const current = canvasTapRef.current
      if (!current || current.id !== gesture.id || current.moved) return
      current.longPressed = true
      current.longPressTimer = null
      if (selectCanvasObjectAt(current.startX, current.startY)) {
        canvasSuppressClickRef.current = true
      }
    }, 560)
    canvasTapRef.current = gesture
  }

  const markCanvasTapMoved = (e: React.PointerEvent) => {
    const tap = canvasTapRef.current
    if (!tap || tap.id !== e.pointerId) return
    if (Math.hypot(e.clientX - tap.startX, e.clientY - tap.startY) <= 10) return
    tap.moved = true
    clearCanvasTapTimer()
  }

  const isCanvasTapActionTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return true
    const currentTool = toolRef.current
    if (target.closest('.hub-sketch-node-hit, .hub-sketch-node, .hub-sketch-opening, .hub-sketch-opening-hit, .hub-sketch-plan-item, .hub-sketch-measurement, .hub-sketch-measurement-delete, .hub-sketch-dim-line-editable, .hub-sketch-wall-hit')) {
      return false
    }
    if (target.closest('.hub-sketch-wall')) {
      if (currentTool === 'door' || currentTool === 'window' || currentTool === 'outlet' || currentTool === 'switch' || currentTool === 'measure') return true
      const currentModel = modelRef.current
      const active = currentModel.contours[currentModel.contours.length - 1]
      return !!active && !active.closed
    }
    return true
  }

  const handleMove = (e: React.PointerEvent) => {
    if (!canEdit) return
    applyPointerMoveAt(e.clientX, e.clientY, canvasViewRef.current, e.pointerId)
    if (e.pointerType === 'mouse') updateEdgeAutoPan(e.clientX, e.clientY)
  }

  const handleCanvasPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (shouldIgnoreTouchForActivePen(e)) {
      e.preventDefault()
      return
    }
    if (e.pointerType === 'pen') {
      penActiveRef.current = true
      activePenPointerIdRef.current = e.pointerId
    }

    stopEdgeAutoPan()
    canvasPointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType })
    e.currentTarget.setPointerCapture?.(e.pointerId)

    if (beginCanvasPinchFromTouches()) return

    if (e.pointerType === 'mouse') {
      canvasTapRef.current = null
      canvasPanRef.current = { startX: e.clientX, startY: e.clientY, view: canvasViewRef.current, moved: false }
      canvasPinchRef.current = null
      return
    }

    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      canvasPanRef.current = null
      canvasPinchRef.current = null
      beginCanvasTapGesture(e)
      applyPointerMoveAt(e.clientX, e.clientY, canvasViewRef.current, e.pointerId)
    }
  }

  const handleCanvasPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (shouldIgnoreTouchForActivePen(e)) {
      e.preventDefault()
      return
    }
    if (canvasPointersRef.current.has(e.pointerId)) {
      canvasPointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType })
    }

    const touches = activeTouchPointers()
    if (touches.length >= 2 && (canvasPinchRef.current || beginCanvasPinchFromTouches())) {
      const [a, b] = touches
      const pinch = canvasPinchRef.current
      if (!pinch) return
      const currentDistance = Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY))
      const currentMid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
      const factor = pinch.startDistance / currentDistance
      const anchor = canvasPoint(pinch.startMid.x, pinch.startMid.y, pinch.view)
      const svg = svgRef.current
      if (anchor && svg) {
        const rect = svg.getBoundingClientRect()
        const nextWidth = pinch.view.width * factor
        const nextHeight = pinch.view.height * factor
        const ratioX = (currentMid.x - rect.left) / Math.max(1, rect.width)
        const ratioY = (currentMid.y - rect.top) / Math.max(1, rect.height)
        const nextView = normalizeCanvasView(canvasSizeRef.current, {
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
        setHoverSnapGuide(null)
      }
      e.preventDefault()
      return
    }

    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      markCanvasTapMoved(e)
      applyPointerMoveAt(e.clientX, e.clientY, canvasViewRef.current, e.pointerId)
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
        const nextView = normalizeCanvasView(canvasSizeRef.current, {
          ...pan.view,
          x: pan.view.x - dx * (pan.view.width / Math.max(1, canvasSizeRef.current.width)),
          y: pan.view.y - dy * (pan.view.height / Math.max(1, canvasSizeRef.current.height)),
        })
        canvasViewRef.current = nextView
        setCanvasView(nextView)
        setHover(null)
        setHoverSnapped(false)
        setHoverSnapGuide(null)
        e.preventDefault()
        return
      }
    }

    handleMove(e)
  }

  const handleCanvasPointerEnd = (e: React.PointerEvent<SVGSVGElement>) => {
    const stored = canvasPointersRef.current.get(e.pointerId)
    const tap = canvasTapRef.current?.id === e.pointerId ? canvasTapRef.current : null
    const tapMoved = tap ? tap.moved || Math.hypot(e.clientX - tap.startX, e.clientY - tap.startY) > 10 : false
    const tapLongPressed = !!tap?.longPressed
    if (tap) {
      clearCanvasTapTimer()
      canvasTapRef.current = null
    }

    canvasPointersRef.current.delete(e.pointerId)
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    finishPenPointer(e)
    const endingDragNode = dragNodeRef.current
    const armedNode = armedDragNodeRef.current
    const armedNodeTap = armedNode &&
      armedNode.pointerId === e.pointerId &&
      dragNodeRef.current === null &&
      !screenPointerMovedBeyondThreshold(armedNode.origin, { clientX: e.clientX, clientY: e.clientY }, NODE_DRAG_THRESHOLD_PX)
      ? { c: armedNode.c, p: armedNode.p, pointerType: armedNode.pointerType }
      : null

    if (activeTouchPointers().length < 2) canvasPinchRef.current = null
    if (canvasPointersRef.current.size === 1) {
      const remaining = Array.from(canvasPointersRef.current.values())[0]
      canvasPanRef.current = remaining.pointerType === 'mouse'
        ? { startX: remaining.clientX, startY: remaining.clientY, view: canvasViewRef.current, moved: false }
        : null
    } else {
      canvasPanRef.current = null
    }
    if (canvasPointersRef.current.size === 0) stopEdgeAutoPan()
    endDragOpening()
    endDragNode()
    endDragPlaced()

    if (endingDragNode && (e.pointerType === 'touch' || e.pointerType === 'pen')) {
      nodeTapClickHandledRef.current = endingDragNode
      dragMovedRef.current = false
      canvasSuppressClickRef.current = true
      e.preventDefault()
      return
    }

    if (armedNodeTap && (armedNodeTap.pointerType === 'touch' || armedNodeTap.pointerType === 'pen')) {
      const node = { c: armedNodeTap.c, p: armedNodeTap.p }
      handleNodeTap(node)
      nodeTapClickHandledRef.current = node
      canvasSuppressClickRef.current = true
      e.preventDefault()
      return
    }

    if (stored && (stored.pointerType === 'touch' || stored.pointerType === 'pen')) {
      if (tapLongPressed) {
        canvasSuppressClickRef.current = true
        e.preventDefault()
        return
      }
      if (!tapMoved && isCanvasTapActionTarget(e.target)) {
        const handled = applyCanvasActionAt(e.clientX, e.clientY)
        if (handled) {
          canvasSuppressClickRef.current = true
          e.preventDefault()
        }
      }
    }
  }

  const handleCanvasPointerLeave = () => {
    if (canvasPointersRef.current.size > 0) return
    clearCanvasTapTimer()
    canvasTapRef.current = null
    stopEdgeAutoPan()
    endDragOpening()
    endDragNode()
    endDragPlaced()
    setHover(null)
    setHoverSnapped(false)
    setHoverSnapGuide(null)
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
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (shouldIgnoreTouchForActivePen(e)) return
    if (e.pointerType === 'pen') {
      penActiveRef.current = true
      activePenPointerIdRef.current = e.pointerId
    }
    e.stopPropagation()
    recordHistoryStep()
    // любое взаимодействие с проёмом подавляет следующий click (иначе поставили бы новую точку/проём)
    dragMovedRef.current = true
    dragIdxRef.current = i
    selectedOpeningIndexRef.current = i
    setDragIdx(i)
    setSelectedOpeningIndex(i)
    setActiveMode('opening')
    setSelectedWallKey(null)
    setSelectedMeasurementIndex(null)
    setMeasurementDraft(null)
    setOpeningOffsetEdit(null)
    edgeAutoPanPointerRef.current = { clientX: e.clientX, clientY: e.clientY }
    updateEdgeAutoPan(e.clientX, e.clientY)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const sameNode = (a: DragNode | null, b: DragNode): boolean => !!a && a.c === b.c && a.p === b.p

  const selectNodeForEdit = (node: DragNode) => {
    setActiveMode('wall')
    setSelectedNode(node)
    setSelectedContourIndex(node.c)
    setSelectedWallKey(null)
    selectedOpeningIndexRef.current = null
    setSelectedOpeningIndex(null)
    setSelectedMeasurementIndex(null)
    setMeasurementDraft(null)
  }

  const closeActiveContourFromStartNode = (node: DragNode): boolean => {
    const currentModel = modelRef.current
    const activeIndex = currentModel.contours.length - 1
    const active = currentModel.contours[activeIndex]
    if (!active || node.c !== activeIndex || node.p !== 0 || !shouldCloseOpenContourFromPoint(active, active.points[0], CLOSE_SNAP)) {
      return false
    }
    return finishActiveOpenContour({ discardIncomplete: false })
  }

  const handleNodeTap = (node: DragNode): boolean => {
    if (closeActiveContourFromStartNode(node)) return true
    selectNodeForEdit(node)
    return true
  }

  const handleNodeClick = (c: number, p: number) => (event: React.MouseEvent) => {
    event.stopPropagation()
    const node = { c, p }
    if (!canEdit) return
    if (sameNode(nodeTapClickHandledRef.current, node)) {
      nodeTapClickHandledRef.current = null
      canvasSuppressClickRef.current = false
      return
    }
    nodeTapClickHandledRef.current = null
    if (dragMovedRef.current) {
      dragMovedRef.current = false
      return
    }
    handleNodeTap(node)
  }

  const startDragNode = (c: number, p: number) => (e: React.PointerEvent) => {
    if (!canEdit) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (shouldIgnoreTouchForActivePen(e)) return
    if (e.pointerType === 'pen') {
      penActiveRef.current = true
      activePenPointerIdRef.current = e.pointerId
    }
    e.stopPropagation()
    const node = { c, p }
    armedDragNodeRef.current = {
      ...node,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      origin: { clientX: e.clientX, clientY: e.clientY },
    }
    dragNodeRef.current = null
    setDragNode(null)
    selectNodeForEdit(node)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const startDragPlanItem = (item: SketchPlacedCatalogItem) => (e: React.PointerEvent) => {
    if (!canEdit || tool === 'measure') return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (shouldIgnoreTouchForActivePen(e)) return
    if (e.pointerType === 'pen') {
      penActiveRef.current = true
      activePenPointerIdRef.current = e.pointerId
    }
    e.stopPropagation()
    recordHistoryStep()
    // dragMovedRef ставится в true только при реальном движении (pointer-move) — чтобы отличить
    // клик по шкафу (открыть поповер) от перетаскивания. CABINETS-PLACE-13.
    dragMovedRef.current = false
    setPlanCabinetEditor(null)
    dragPlacedIdRef.current = item.id
    setDragPlacedId(item.id)
    setSelectedContourIndex(null)
    setSelectedWallKey(null)
    setSelectedOpeningIndex(null)
    setSelectedMeasurementIndex(null)
    setMeasurementDraft(null)
    setActiveMode(isCabinetPlacedItem(item) ? 'cabinet' : 'light')
    edgeAutoPanPointerRef.current = { clientX: e.clientX, clientY: e.clientY }
    updateEdgeAutoPan(e.clientX, e.clientY)
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  // CABINETS-PLACE-13: клик (не перетаскивание) по элементу плана. stopPropagation не даёт
  // канвасу поставить новый предмет; для шкафа открываем тот же поповер, что на развёртке.
  const handlePlanItemClick = (item: SketchPlacedCatalogItem) => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (dragMovedRef.current) {
      dragMovedRef.current = false
      return
    }
    if (!canEdit) return
    if (isCabinetPlacedItem(item) && !item.filler) {
      setActiveMode('cabinet')
      setPlanCabinetEditor({ id: item.id, x: e.clientX, y: e.clientY })
    } else {
      setPlanCabinetEditor(null)
    }
  }

  // Отпускание проёма: сохраняем свободную позицию; storage-normalize отдельно округляет до 1/8".
  const endDragOpening = () => {
    if (dragIdxRef.current === null) return
    stopEdgeAutoPan()
    dragIdxRef.current = null
    setDragIdx(null)
    setOpeningSnapGuide(null)
    setSketchMaterials(null)
    setSketchMaterialsAdded(null)
  }

  const endDragNode = () => {
    armedDragNodeRef.current = null
    if (dragNodeRef.current === null) return
    dragNodeRef.current = null
    stopEdgeAutoPan()
    setDragNode(null)
    setSmartGuides([])
    setSketchMaterials(null)
    setSketchMaterialsAdded(null)
  }

  const endDragPlaced = () => {
    if (dragPlacedIdRef.current === null) return
    stopEdgeAutoPan()
    dragPlacedIdRef.current = null
    setDragPlacedId(null)
    setSmartGuides([])
    setSketchMaterials(null)
    setSketchMaterialsAdded(null)
  }

  const applyCanvasActionAt = (clientX: number, clientY: number): boolean => {
    if (!canEdit) return false
    if (canvasSuppressClickRef.current) {
      canvasSuppressClickRef.current = false
      dragMovedRef.current = false
      return false
    }
    // клик после перетаскивания проёма не должен ставить новый
    if (dragMovedRef.current) {
      dragMovedRef.current = false
      return false
    }
    // CABINETS-PLACE-13: клик по пустому месту закрывает поповер шкафа.
    if (planCabinetEditor) setPlanCabinetEditor(null)
    // NAV-FIX-2: клик по пустому месту снимает выделение стены (клик по самой стене обрабатывает хит-таргет со stopPropagation).
    if (wallSelectEnabled && selectedWallKey !== null) setSelectedWallKey(null)
    if (wallSelectEnabled && selectedContourIndex !== null) setSelectedContourIndex(null)
    if (wallSelectEnabled && selectedNode !== null) setSelectedNode(null)
    const raw = pointerCellAt(clientX, clientY)
    if (!raw) return false

    if (tool === 'measure') {
      const p = measurementPoint(raw).p
      setActiveMode('measure')
      setShowMeasurements(true)
      setSelectedMeasurementIndex(null)
      if (!measurementDraft) {
        setMeasurementDraft(p)
        return true
      }
      if (dist(measurementDraft, p) < 0.01) return false
      const nextMeasurement: SketchMeasurement = { id: makeId('measure'), scope: 'plan', a: measurementDraft, b: p }
      commit({ ...model, measurements: [...(model.measurements ?? []), nextMeasurement] })
      setMeasurementDraft(null)
      setSelectedMeasurementIndex((model.measurements ?? []).length)
      return true
    }

    if (tool === 'outlet' || tool === 'switch') {
      const near = nearestSegment(model, raw)
      if (!near || near.d > SEG_HIT) {
        setError('hub_sketch_no_segment')
        return true
      }
      const placed = electricalPlacedAt(tool, near.c, near.s, near.t)
      if (!placed) {
        setError('hub_sketch_no_segment')
        return true
      }
      commit({ ...model, placedItems: [...sanitizePlacedCatalogItems(model.placedItems), placed] })
      return true
    }

    if (tool === 'wall') {
      const p = wallPoint(raw).p
      const contours = model.contours
      const last = contours[contours.length - 1]
      const appendTime = typeof performance !== 'undefined' ? performance.now() : Date.now()
      if (newRoomDraftPendingRef.current) {
        const nextContour: Contour = { points: [p], closed: false }
        commit({ ...model, contours: [...contours, nextContour] })
        lastWallClickAppendRef.current = { contourIndex: contours.length, pointIndex: 0, point: p, clientX, clientY, time: appendTime }
        setNewRoomPending(false)
        setHover(null)
        setHoverSnapped(false)
        setHoverSnapGuide(null)
        setSelectedContourIndex(null)
        setSelectedNode(null)
        setSelectedWallKey(null)
        return true
      }
      // Замыкание: клик рядом со стартовой точкой активного контура (≥3 точек).
      if (shouldCloseOpenContourFromPoint(last, p, CLOSE_SNAP)) {
        return finishActiveOpenContour({ discardIncomplete: false })
      }
      if (last && !last.closed && last.points.length > 0) {
        // не дублируем точку, совпадающую с предыдущей
        const prev = last.points[last.points.length - 1]
        if (dist(p, prev) < 0.01) return false
        const next = { ...model, contours: contours.map((c, i) => (i === contours.length - 1 ? { ...c, points: [...c.points, p] } : c)) }
        commit(next)
        lastWallClickAppendRef.current = { contourIndex: contours.length - 1, pointIndex: last.points.length, point: p, clientX, clientY, time: appendTime }
      } else {
        commit({ ...model, contours: [...contours, { points: [p], closed: false }] })
        lastWallClickAppendRef.current = { contourIndex: contours.length, pointIndex: 0, point: p, clientX, clientY, time: appendTime }
        setNewRoomPending(false)
        setHover(null)
        setHoverSnapped(false)
        setHoverSnapGuide(null)
      }
      return true
    }

    if (tool !== 'door' && tool !== 'window') return false

    // door / window: ставим на ближайший сегмент в пределах порога
    const near = nearestSegment(model, raw)
    if (!near || near.d > SEG_HIT) {
      setError('hub_sketch_no_segment')
      return true
    }
    const opening = openingDraftAt(tool, near.c, near.s, near.t)
    const nextIndex = model.openings.length
    commit({ ...model, openings: [...model.openings, opening] })
    selectedOpeningIndexRef.current = nextIndex
    setSelectedOpeningIndex(nextIndex)
    setActiveMode('opening')
    return true
  }

  const rollbackDoubleClickWallAppend = (baseModel: SketchModel, event: React.MouseEvent): SketchModel => {
    const append = lastWallClickAppendRef.current
    if (!append) return baseModel
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const contour = baseModel.contours[append.contourIndex]
    const appendedPoint = contour?.points[append.pointIndex]
    if (
      now - append.time > 700 ||
      append.contourIndex !== baseModel.contours.length - 1 ||
      append.pointIndex < 3 ||
      !contour ||
      contour.closed ||
      append.pointIndex !== contour.points.length - 1 ||
      !appendedPoint ||
      dist(appendedPoint, append.point) > 0.001 ||
      Math.hypot(event.clientX - append.clientX, event.clientY - append.clientY) > NODE_DRAG_THRESHOLD_PX * 3
    ) {
      return baseModel
    }
    return {
      ...baseModel,
      contours: baseModel.contours.map((item, index) => (
        index === append.contourIndex
          ? { ...item, points: item.points.filter((_, pointIndex) => pointIndex !== append.pointIndex) }
          : item
      )),
    }
  }

  const handleClick = (e: React.MouseEvent) => {
    if (e.detail > 1) return
    applyCanvasActionAt(e.clientX, e.clientY)
  }

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!canEdit || viewMode !== '2d' || tool !== 'wall') return
    if (canvasSuppressClickRef.current || dragMovedRef.current) {
      canvasSuppressClickRef.current = false
      dragMovedRef.current = false
      lastWallClickAppendRef.current = null
      return
    }
    e.preventDefault()
    const baseModel = rollbackDoubleClickWallAppend(modelRef.current, e)
    lastWallClickAppendRef.current = null
    finishOpenContourFromModel(baseModel)
  }

  function selectCanvasObjectAt(clientX: number, clientY: number): boolean {
    if (!canEditRef.current) return false
    const raw = pointerCellAt(clientX, clientY)
    const point = canvasPoint(clientX, clientY)
    if (!raw || !point) return false
    const hitCells = Math.max(SEG_HIT, (30 * screenWorldPxForView()) / CELL_PX)
    const hitWorldPx = 30 * screenWorldPxForView()

    let nodeHit: { node: DragNode; d: number } | null = null
    const currentModel = modelRef.current
    for (let c = 0; c < currentModel.contours.length; c++) {
      const contour = currentModel.contours[c]
      for (let p = 0; p < contour.points.length; p++) {
        const candidate = contour.points[p]
        const d = dist(raw, candidate)
        if (d <= hitCells && (!nodeHit || d < nodeHit.d)) nodeHit = { node: { c, p }, d }
      }
    }
    if (nodeHit) {
      setActiveMode('wall')
      setSelectedNode(nodeHit.node)
      setSelectedContourIndex(nodeHit.node.c)
      setSelectedWallKey(null)
      selectedOpeningIndexRef.current = null
      setSelectedOpeningIndex(null)
      setSelectedMeasurementIndex(null)
      setMeasurementDraft(null)
      return true
    }

    let openingHit: { index: number; d: number } | null = null
    for (let index = 0; index < currentModel.openings.length; index++) {
      const opening = currentModel.openings[index]
      const geom = openingGeom(currentModel, opening)
      if (!geom) continue
      const widthCells = Math.min(openingWidthFt(opening) / modelCellFt(currentModel), dist(geom.a, geom.b))
      const a = { x: geom.p.x - (geom.ux * widthCells) / 2, y: geom.p.y - (geom.uy * widthCells) / 2 }
      const b = { x: geom.p.x + (geom.ux * widthCells) / 2, y: geom.p.y + (geom.uy * widthCells) / 2 }
      const tValue = projectT(raw, a, b)
      const projected = { x: a.x + (b.x - a.x) * tValue, y: a.y + (b.y - a.y) * tValue }
      const d = dist(raw, projected)
      if (d <= hitCells && (!openingHit || d < openingHit.d)) openingHit = { index, d }
    }
    if (openingHit) {
      setActiveMode('opening')
      selectedOpeningIndexRef.current = openingHit.index
      setSelectedOpeningIndex(openingHit.index)
      setSelectedWallKey(null)
      setSelectedContourIndex(null)
      setSelectedNode(null)
      setSelectedMeasurementIndex(null)
      setMeasurementDraft(null)
      return true
    }

    for (const { index, line } of planMeasurementLines) {
      const tValue = projectT(point, { x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 })
      const projected = { x: line.x1 + (line.x2 - line.x1) * tValue, y: line.y1 + (line.y2 - line.y1) * tValue }
      if (dist(point, projected) <= hitWorldPx) {
        setActiveMode('measure')
        setSelectedMeasurementIndex(index)
        setMeasurementDraft(null)
        setSelectedWallKey(null)
        setSelectedContourIndex(null)
        setSelectedNode(null)
        selectedOpeningIndexRef.current = null
        setSelectedOpeningIndex(null)
        return true
      }
    }

    const near = nearestSegment(modelRef.current, raw)
    if (near && near.d <= hitCells) {
      setActiveMode('wall')
      setSelectedWallKey(sketchWallKey(near.c, near.s))
      setSelectedContourIndex(null)
      setSelectedNode(null)
      selectedOpeningIndexRef.current = null
      setSelectedOpeningIndex(null)
      setSelectedMeasurementIndex(null)
      setMeasurementDraft(null)
      return true
    }

    for (let index = modelRef.current.contours.length - 1; index >= 0; index--) {
      const contour = modelRef.current.contours[index]
      if (!pointInContour(raw, contour)) continue
      setActiveMode('wall')
      setSelectedContourIndex(index)
      setSelectedNode(null)
      setSelectedWallKey(null)
      selectedOpeningIndexRef.current = null
      setSelectedOpeningIndex(null)
      setSelectedMeasurementIndex(null)
      setMeasurementDraft(null)
      return true
    }

    return false
  }

  const finishShape = () => {
    finishActiveOpenContour({ discardIncomplete: false })
  }

  const startNewRoom = () => {
    if (!canEdit) return
    setActiveMode('wall')
    setContextSheetOpen(true)
    setViewMode('2d')
    setTool('wall')
    setMeasurementDraft(null)
    setSelectedMeasurementIndex(null)
    setClearConfirmOpen(false)
    selectedOpeningIndexRef.current = null
    setSelectedOpeningIndex(null)
    setSelectedContourIndex(null)
    setSelectedNode(null)
    setSelectedWallKey(null)
    setOpeningOffsetEdit(null)
    setOpeningSnapGuide(null)
    setHoverSnapGuide(null)
    setNewRoomPending(true)
  }

  const renameContour = (index: number, rawLabel: string) => {
    if (!canEdit) return
    const current = modelRef.current
    const contour = current.contours[index]
    if (!contour) return
    const label = sanitizeContourLabel(rawLabel)
    if ((contour.label ?? undefined) === label) return
    const contours = current.contours.map((item, itemIndex) => {
      if (itemIndex !== index) return item
      const next: Contour = { ...item }
      if (label) next.label = label
      else delete next.label
      return next
    })
    commit(normalizeSketchModelForStorage({ ...current, contours }))
  }

  const undo = useCallback(() => {
    const result = undoSketchHistory(history, modelRef.current, SKETCH_HISTORY_LIMIT)
    if (!result) return
    setHistory(result.history)
    modelRef.current = result.current
    setModel(result.current)
    setMeasurementDraft(null)
    setSelectedMeasurementIndex(null)
    dragIdxRef.current = null
    dragNodeRef.current = null
    dragPlacedIdRef.current = null
    setDragIdx(null)
    setDragNode(null)
    setDragPlacedId(null)
    setSelectedOpeningIndex(null)
    setSelectedContourIndex(null)
    setSelectedNode(null)
    setNewRoomPending(false)
    setOpeningOffsetEdit(null)
    setOpeningSnapGuide(null)
    clearModelChangeState()
  }, [history, clearModelChangeState])

  const redo = useCallback(() => {
    const result = redoSketchHistory(history, modelRef.current, SKETCH_HISTORY_LIMIT)
    if (!result) return
    setHistory(result.history)
    modelRef.current = result.current
    setModel(result.current)
    setMeasurementDraft(null)
    setSelectedMeasurementIndex(null)
    dragIdxRef.current = null
    dragNodeRef.current = null
    dragPlacedIdRef.current = null
    setDragIdx(null)
    setDragNode(null)
    setDragPlacedId(null)
    setSelectedOpeningIndex(null)
    setSelectedContourIndex(null)
    setSelectedNode(null)
    setNewRoomPending(false)
    setOpeningOffsetEdit(null)
    setOpeningSnapGuide(null)
    clearModelChangeState()
  }, [history, clearModelChangeState])

  const clearAll = () => {
    setClearConfirmOpen(false)
    if (!hasClearableSketchContent(model)) return
    canvasAutoFitRef.current = true
    commit(EMPTY_MODEL)
    setMeasurementDraft(null)
    setSelectedMeasurementIndex(null)
    setSelectedOpeningIndex(null)
    setOpeningOffsetEdit(null)
    setOpeningSnapGuide(null)
    setDragNode(null)
    setDragPlacedId(null)
    setSelectedNode(null)
    setSelectedContourIndex(null)
    setNewRoomPending(false)
    lastWallClickAppendRef.current = null
    setHover(null)
    setHoverSnapped(false)
    setHoverSnapGuide(null)
    setRecentlyClosedContourIndex(null)
  }

  const requestClearAll = () => {
    if (!hasClearableSketchContent(model)) return
    setClearConfirmOpen(true)
  }

  const cancelClearAll = () => {
    setClearConfirmOpen(false)
  }

  useEffect(() => {
    if (!canEdit) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableKeyTarget(event.target)) return
      if (event.altKey || (!event.ctrlKey && !event.metaKey)) return
      const key = event.key.toLowerCase()
      const isUndo = key === 'z' && !event.shiftKey
      const isRedo = key === 'y' || (key === 'z' && event.shiftKey)
      const isDuplicate = key === 'd' && !event.shiftKey
      if (!isUndo && !isRedo && !isDuplicate) return
      event.preventDefault()
      if (isUndo) undo()
      else if (isRedo) redo()
      else duplicateSelectedSketch()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canEdit, undo, redo, duplicateSelectedSketch])

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
      setError(layout.invalidCodes.length > 0 ? null : 'hub_sketch_cabinet_empty')
      setStatus(layout.invalidCodes.length > 0 ? 'hub_sketch_cabinet_invalid_help' : null)
      return
    }
    const wallId = sketchWallKey(selectedCabinetWall.c, selectedCabinetWall.s)
    const keptItems = sanitizePlacedCatalogItems(model.placedItems)
      .filter((item) => !(isCabinetPlacedItem(item) && item.wallId === wallId))
    const next: SketchModel = { ...model, placedItems: [...keptItems, ...layout.items] }
    commit(next)
    setStatus(layout.overflow ? 'hub_sketch_cabinet_overflow' : layout.smallFiller ? 'hub_sketch_cabinet_small_filler' : 'hub_sketch_cabinet_placed')
  }

  // UX-CABINETS-6: визуальное размещение — ряд стены хранится как placedItems,
  // код-строка собирается заново из уже стоящих шкафов (без авто-филлеров) → layoutCabinetRunOnWall.
  const cabinetRunItemsForWall = useCallback((wallId: string): SketchPlacedCatalogItem[] => (
    sanitizePlacedCatalogItems(model.placedItems)
      .filter((item) => isCabinetPlacedItem(item) && item.wallId === wallId && !item.filler)
      .sort((a, b) => (a.t ?? 0) - (b.t ?? 0))
  ), [model])

  const rebuildCabinetWall = useCallback((wall: WallSegment, codes: string[]) => {
    const wallId = sketchWallKey(wall.c, wall.s)
    const kept = sanitizePlacedCatalogItems(model.placedItems)
      .filter((item) => !(isCabinetPlacedItem(item) && item.wallId === wallId))
    setError(null)
    if (codes.length === 0) {
      commit({ ...model, placedItems: kept })
      setStatus(null)
      return
    }
    const layout = layoutCabinetRunOnWall(model, wall, codes.join(' '))
    commit({ ...model, placedItems: [...kept, ...layout.items] })
    setStatus(layout.overflow ? 'hub_sketch_cabinet_overflow' : layout.smallFiller ? 'hub_sketch_cabinet_small_filler' : 'hub_sketch_cabinet_placed')
  }, [commit, model])

  const placeCabinetEntry = useCallback((entry: CabinetCatalogEntry, widthIn?: number) => {
    if (!selectedCabinetWall) {
      setError('hub_sketch_no_segment')
      return
    }
    const width = widthIn ?? cabinetCatalogDefaultWidth(entry)
    const code = cabinetCatalogEntryCode(entry, width, cabinetGalleryWallHeight)
    const wallId = sketchWallKey(selectedCabinetWall.c, selectedCabinetWall.s)
    const existing = cabinetRunItemsForWall(wallId).map((item) => cabinetDisplayCode(item)).filter(Boolean)
    rebuildCabinetWall(selectedCabinetWall, [...existing, code])
  }, [cabinetGalleryWallHeight, cabinetRunItemsForWall, rebuildCabinetWall, selectedCabinetWall])

  const cabinetItemCodeWithSize = (item: SketchPlacedCatalogItem, widthIn: number, wallHeightIn?: number): string => {
    const pad2 = (value: number) => String(Math.round(value)).padStart(2, '0')
    if (item.layer === 'wall') {
      const heightIn = wallHeightIn ?? Math.round(item.heightIn ?? 30)
      return `W${pad2(widthIn)}${pad2(heightIn)}`
    }
    const prefix = item.cabinetPrefix || 'B'
    return `${prefix}${Math.round(widthIn)}`
  }

  const handleCabinetResize = useCallback((item: SketchPlacedCatalogItem, widthIn: number, wallHeightIn?: number) => {
    const wallId = item.wallId ?? ''
    const wall = cabinetWallOptions.find((seg) => sketchWallKey(seg.c, seg.s) === wallId)
    if (!wall) return
    const codes = cabinetRunItemsForWall(wallId)
      .map((it) => (it.id === item.id ? cabinetItemCodeWithSize(it, widthIn, wallHeightIn) : cabinetDisplayCode(it)))
      .filter(Boolean)
    rebuildCabinetWall(wall, codes)
  }, [cabinetRunItemsForWall, cabinetWallOptions, rebuildCabinetWall])

  const handleCabinetRemove = useCallback((item: SketchPlacedCatalogItem) => {
    const wallId = item.wallId ?? ''
    const wall = cabinetWallOptions.find((seg) => sketchWallKey(seg.c, seg.s) === wallId)
    if (!wall) return
    const codes = cabinetRunItemsForWall(wallId)
      .filter((it) => it.id !== item.id)
      .map((it) => cabinetDisplayCode(it))
      .filter(Boolean)
    rebuildCabinetWall(wall, codes)
  }, [cabinetRunItemsForWall, cabinetWallOptions, rebuildCabinetWall])

  const cabinetRunItems = effectiveCabinetWallKey ? cabinetRunItemsForWall(effectiveCabinetWallKey) : []

  // CABINETS-PLACE-13: Esc/Delete для поповера шкафа на плане (как на развёртке).
  useEffect(() => {
    if (!planCabinetEditor) return
    const onKey = (event: KeyboardEvent) => {
      if (isEditableKeyTarget(event.target)) return
      if (event.key === 'Escape') {
        setPlanCabinetEditor(null)
        event.preventDefault()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const target = sanitizePlacedCatalogItems(model.placedItems).find((it) => it.id === planCabinetEditor.id)
        if (target) {
          handleCabinetRemove(target)
          setPlanCabinetEditor(null)
          event.preventDefault()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [planCabinetEditor, model, handleCabinetRemove])

  const updateModelFrom3D = useCallback((next: SketchModel) => {
    commit(normalizeSketchModelForStorage(next))
  }, [commit])

  const updateWallElevationModel = useCallback((next: SketchModel) => {
    canvasAutoFitRef.current = false
    updateModelFrom3D(next)
  }, [updateModelFrom3D])

  const updateWallElevationMeasurements = useCallback((measurements: SketchMeasurement[]) => {
    const next: SketchModel = { ...modelRef.current }
    if (measurements.length > 0) next.measurements = measurements
    else delete next.measurements
    updateWallElevationModel(next)
  }, [updateWallElevationModel])

  const updateSelectedWallSurface = useCallback((surface: SketchSurfaceFinish) => {
    if (!selectedWallKey) return
    const current = modelRef.current
    const finishes = normalizeFinishes(current.finishes)
    updateWallElevationModel({
      ...current,
      finishes: {
        ...finishes,
        wallFinishes: {
          ...finishes.wallFinishes,
          [selectedWallKey]: surface,
        },
      },
    })
  }, [selectedWallKey, updateWallElevationModel])

  const updateSelectedWallCoverageMode = useCallback((mode: 'full' | 'partial') => {
    if (!selectedWallSurface) return
    const currentHeightFt = wallHeightFt(modelRef.current)
    const currentCoverage = selectedWallSurface.coverage?.mode === 'partial'
      ? selectedWallSurface.coverage
      : { mode: 'partial' as const, bottomFt: 0, heightFt: Math.min(4, currentHeightFt), regions: [] }
    updateSelectedWallSurface({
      ...selectedWallSurface,
      coverage: mode === 'full'
        ? { mode: 'full' as const }
        : { ...currentCoverage, mode: 'partial' as const, regions: currentCoverage.regions ?? [] },
    } as SketchSurfaceFinish)
  }, [selectedWallSurface, updateSelectedWallSurface])

  const updateSelectedWallFinishKind = useCallback((kind: 'paint' | 'tile' | 'drywall-patch') => {
    if (!selectedWallSurface) return
    const coverage = selectedWallSurface.coverage
    if (kind === 'tile') {
      const tile = normalizeTileSurface(selectedWallSurface)
      updateSelectedWallSurface({ ...tile, ...(coverage ? { coverage } : {}), kind: 'tile' })
      return
    }
    if (kind === 'drywall-patch') {
      const patch = normalizeDrywallPatchSurface(selectedWallSurface)
      updateSelectedWallSurface({ ...patch, ...(coverage ? { coverage } : {}), kind: 'drywall-patch' })
      return
    }
    const color = selectedWallSurface.kind === 'paint'
      ? cleanColor(selectedWallSurface.color, DEFAULT_WALL_PAINT)
      : selectedWallSurface.kind === 'drywall-patch'
        ? cleanColor(selectedWallSurface.baseColor, DEFAULT_WALL_PAINT)
        : DEFAULT_WALL_PAINT
    updateSelectedWallSurface({ kind: 'paint', color, ...(coverage ? { coverage } : {}) })
  }, [selectedWallSurface, updateSelectedWallSurface])

  const updateSelectedWallPaintColor = useCallback((color: string) => {
    if (!selectedWallSurface) return
    updateSelectedWallSurface({ ...selectedWallSurface, kind: 'paint', color: cleanColor(color, DEFAULT_WALL_PAINT) } as SketchSurfaceFinish)
  }, [selectedWallSurface, updateSelectedWallSurface])

  const updateSelectedWallTile = useCallback((patch: Partial<ReturnType<typeof normalizeTileSurface>>) => {
    if (!selectedWallSurface) return
    updateSelectedWallSurface({ ...normalizeTileSurface(selectedWallSurface), ...patch, kind: 'tile' })
  }, [selectedWallSurface, updateSelectedWallSurface])

  const updateSelectedWallDrywallColor = useCallback((field: 'baseColor' | 'patchColor', color: string) => {
    if (!selectedWallSurface) return
    updateSelectedWallSurface({ ...normalizeDrywallPatchSurface(selectedWallSurface), [field]: cleanColor(color, field === 'baseColor' ? DEFAULT_WALL_PAINT : DEFAULT_DRYWALL_PATCH_COLOR), kind: 'drywall-patch' })
  }, [selectedWallSurface, updateSelectedWallSurface])

  const clearSelectedWallSurface = useCallback(() => {
    if (!selectedWallKey) return
    const current = modelRef.current
    const finishes = normalizeFinishes(current.finishes)
    const wallFinishes = { ...finishes.wallFinishes }
    delete wallFinishes[selectedWallKey]
    updateWallElevationModel({ ...current, finishes: { ...finishes, wallFinishes } })
  }, [selectedWallKey, updateWallElevationModel])

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
      stats.perContour.forEach((c) => {
        lines.push(
          `${t('hub_sketch_contour')} ${c.index + 1}: ${t('hub_sketch_area')} ${c.area.toFixed(1)} ft² · ${t('hub_sketch_perimeter')} ${fmtFt(c.perimeter)}`,
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

  const runSketchMaterials = async () => {
    if (!profile || sketchMaterialsBusy) return
    if (stats.perContour.length === 0) {
      setError('hub_sketch_empty')
      return
    }
    setSketchMaterialsBusy(true)
    setSketchMaterialsAdded(null)
    setError(null)
    setStatus(null)
    try {
      const result = await calculateSketchMaterials(normalizeSketchModelForStorage(model), {
        includePrimer,
        includeTexture,
        labels: {
          outletName: t('hub_sketch_outlet'),
          switchName: t('hub_sketch_switch'),
          eachUnit: t('hub_sketch_material_unit_each'),
        },
      })
      setSketchMaterials(result)
      setStatus('hub_sketch_materials_ready')
    } catch {
      setError('hub_sketch_materials_failed')
    } finally {
      setSketchMaterialsBusy(false)
    }
  }

  const appendSketchMaterialsToSpec = async () => {
    if (!profile || !sketchMaterials || sketchMaterialsAppendBusy) return
    setSketchMaterialsAppendBusy(true)
    setSketchMaterialsAdded(null)
    setError(null)
    setStatus(null)
    try {
      const created = await appendSketchMaterialRows(profile, project.id, sketchMaterials.rows)
      setSketchMaterialsAdded(created.length)
      setStatus('hub_sketch_materials_added')
    } catch {
      setError('hub_sketch_materials_append_failed')
    } finally {
      setSketchMaterialsAppendBusy(false)
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
        contours: sanitizeSketchContours(data.contours),
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
      canvasAutoFitRef.current = true
      setMeasurementDraft(null)
      setSelectedMeasurementIndex(null)
      setSelectedOpeningIndex(null)
      setSelectedContourIndex(null)
      setSelectedNode(null)
      setNewRoomPending(false)
      setOpeningOffsetEdit(null)
      setOpeningSnapGuide(null)
      commit(normalizeSketchModelForStorage(nextModel))
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
  const wallDraftPointerActive = shouldTrackWallDraftPointer(activeContour, newRoomDraftPending)
  const canClearSketch = hasClearableSketchContent(model)
  const wallSelectEnabled = canEdit && tool !== 'door' && tool !== 'window' && tool !== 'measure' && tool !== 'outlet' && tool !== 'switch' && !activeContourOpen
  const selectedOpening = selectedOpeningIndex !== null ? model.openings[selectedOpeningIndex] ?? null : null
  const canCenterOpening = canEdit && !!selectedOpening && !!openingEnds(model, selectedOpening)
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
  const selectedOpeningClearanceLines = selectedOpening && selectedOpeningIndex !== null && dragIdx !== selectedOpeningIndex && tool !== 'measure'
    ? openingClearanceDimLines(model, selectedOpening, selectedOpeningIndex, t, screenWorldPx)
    : []
  const activeOpeningSnapGuide = dragIdx !== null && openingSnapGuide && model.openings[dragIdx]
    ? openingSnapGuide2D(model, model.openings[dragIdx], openingSnapGuide, t, screenWorldPx)
    : null
  const roomLabels = useMemo(
    () => model.contours
      .map((contour, index) => {
        if (!contour.closed || contour.points.length < 3) return null
        const center = contourCenter(contour)
        if (!center) return null
        const label = roomDisplayName(contour, index, t('hub_sketch_room_panel_title'))
        return { index, center, label, shortLabel: shortRoomLabel(label) }
      })
      .filter((label): label is { index: number; center: Pt; label: string; shortLabel: string } => !!label),
    [model.contours, t],
  )

  useEffect(() => {
    if (recentlyClosedContourIndex === null) return
    const contour = model.contours[recentlyClosedContourIndex]
    if (!contour || !contour.closed) setRecentlyClosedContourIndex(null)
  }, [model.contours, recentlyClosedContourIndex])

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

  const renderOpeningClearanceDimLine2D = (
    dim: OpeningClearanceDimLine,
    key: string,
    className: string,
    openingIndex: number | null,
    editable: boolean,
    fontScale = 10.5,
  ) => {
    const canEditOffset = editable && openingIndex !== null && (dim.metric === 'left' || dim.metric === 'right')
    const editing = canEditOffset &&
      openingOffsetEdit?.index === openingIndex &&
      openingOffsetEdit.side === dim.metric
    const editValue = editing ? openingOffsetEdit.value : ''
    const inputW = Math.max(86, Math.min(142, editValue.length ? editValue.length * 8 + 36 : 104)) * screenWorldPx
    const inputH = 30 * screenWorldPx
    const groupClass = `${className}${canEditOffset ? ' hub-sketch-opening-clearance-dim-editable' : ''}`
    return (
      <g key={key} className={groupClass}>
        <line className="hub-sketch-dim-extension" x1={dim.ext1x1} y1={dim.ext1y1} x2={dim.ext1x2} y2={dim.ext1y2} />
        <line className="hub-sketch-dim-extension" x1={dim.ext2x1} y1={dim.ext2y1} x2={dim.ext2x2} y2={dim.ext2y2} />
        <line className="hub-sketch-dim-main" x1={dim.x1} y1={dim.y1} x2={dim.x2} y2={dim.y2} />
        <line className="hub-sketch-dim-tick" x1={dim.tick1x1} y1={dim.tick1y1} x2={dim.tick1x2} y2={dim.tick1y2} />
        <line className="hub-sketch-dim-tick" x1={dim.tick2x1} y1={dim.tick2y1} x2={dim.tick2x2} y2={dim.tick2y2} />
        {editing ? (
          <foreignObject
            x={dim.labelX - inputW / 2}
            y={dim.labelY - inputH / 2}
            width={inputW}
            height={inputH}
            transform={`rotate(${dim.angle} ${dim.labelX} ${dim.labelY})`}
          >
            <input
              className="hub-sketch-dim-edit-input"
              value={editValue}
              inputMode="text"
              autoFocus
              aria-label={t('hub_sketch_opening_offset_edit_label')}
              onChange={(event) => setOpeningOffsetEditValue(event.target.value)}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onBlur={applyOpeningOffsetEdit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  applyOpeningOffsetEdit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelOpeningOffsetEdit()
                }
              }}
            />
          </foreignObject>
        ) : (
          <text
            className={canEditOffset ? 'hub-sketch-dim-label hub-sketch-dim-label-editable' : 'hub-sketch-dim-label'}
            x={dim.labelX}
            y={dim.labelY}
            textAnchor="middle"
            dominantBaseline="central"
            style={{ fontSize: fontScale * screenWorldPx }}
            transform={`rotate(${dim.angle} ${dim.labelX} ${dim.labelY})`}
            role={canEditOffset ? 'button' : undefined}
            tabIndex={canEditOffset ? 0 : undefined}
            aria-label={canEditOffset ? t('hub_sketch_opening_offset_edit_label') : undefined}
            onPointerDown={canEditOffset ? (event) => event.stopPropagation() : undefined}
            onClick={canEditOffset ? (event) => {
              event.stopPropagation()
              if (openingIndex === null) return
              beginOpeningOffsetEdit(openingIndex, dim.metric as OpeningOffsetSide, dim.valueFt)
            } : undefined}
            onKeyDown={canEditOffset ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              if (openingIndex === null) return
              beginOpeningOffsetEdit(openingIndex, dim.metric as OpeningOffsetSide, dim.valueFt)
            } : undefined}
          >
            {dim.text}
          </text>
        )}
      </g>
    )
  }

  const sketchMaterialSectionLabel = (section: SketchMaterialRow['section']): string => {
    if (section === TILE_MATERIAL_SECTION) return t('hub_sketch_material_section_tile')
    if (section === WALL_MATERIAL_SECTION) return t('hub_sketch_material_section_walls')
    if (section === CABINET_MATERIAL_SECTION) return t('hub_sketch_material_section_cabinets')
    if (section === ELECTRICAL_MATERIAL_SECTION) return t('hub_sketch_material_section_electrical')
    return section
  }

  const fmtMaterialQty = (value: number | null): string => {
    if (value == null) return '—'
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
  }

  const sketchMaterialRowsBySection = (section: SketchMaterialRow['section']) =>
    sketchMaterials?.rows.filter((row) => row.section === section) ?? []

  const renderWallElevationFinishControls = (fullscreen = false) => {
    if (!canEdit || !selectedWall || !selectedWallSurface) return null
    const coverageMode = selectedWallSurface.coverage?.mode === 'partial' ? 'partial' : 'full'
    const activeTile = normalizeTileSurface(selectedWallSurface)
    const tileSizeValue = `${activeTile.tileWIn ?? 12}x${activeTile.tileHIn ?? 24}`
    const tileSizePresetValue = TILE_SIZE_OPTIONS.some((option) => `${option.w}x${option.h}` === tileSizeValue) ? tileSizeValue : 'custom'
    return (
      <div className={fullscreen ? 'hub-sketch-wall-finishbar hub-sketch-wall-finishbar-fullscreen' : 'hub-sketch-wall-finishbar'}>
        <div className="hub-sketch-segmented" role="group" aria-label={t('hub_sketch_3d_finish_mode')}>
          {(['paint', 'tile', 'drywall-patch'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={selectedWallSurface.kind === kind ? 'btn small' : 'btn ghost small'}
              aria-pressed={selectedWallSurface.kind === kind}
              onClick={() => updateSelectedWallFinishKind(kind)}
            >
              {t(kind === 'paint' ? 'hub_sketch_3d_paint' : kind === 'tile' ? 'hub_sketch_3d_tile' : 'hub_sketch_3d_drywall_patch')}
            </button>
          ))}
        </div>
        <div className="hub-sketch-segmented" role="group" aria-label={t('hub_sketch_finish_coverage')}>
          {(['full', 'partial'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={coverageMode === mode ? 'btn small' : 'btn ghost small'}
              aria-pressed={coverageMode === mode}
              onClick={() => updateSelectedWallCoverageMode(mode)}
            >
              {t(mode === 'full' ? 'hub_sketch_finish_full' : 'hub_sketch_finish_partial')}
            </button>
          ))}
        </div>
        {selectedWallSurface.kind === 'paint' && (
          <div className="hub-sketch-wall-finishbar-swatches" aria-label={t('hub_sketch_3d_wall_color')}>
            <input
              className="hub-sketch-color-input"
              type="color"
              value={cleanColor(selectedWallSurface.color, DEFAULT_WALL_PAINT)}
              onChange={(event) => updateSelectedWallPaintColor(event.target.value)}
              aria-label={t('hub_sketch_3d_custom_color')}
            />
          </div>
        )}
        {selectedWallSurface.kind === 'tile' && (
          <div className="hub-sketch-wall-finishbar-tile">
            <label className="hub-sketch-field">
              <span className="muted">{t('hub_sketch_3d_tile_size')}</span>
              <select
                value={tileSizePresetValue}
                onChange={(event) => {
                  const option = TILE_SIZE_OPTIONS.find((item) => `${item.w}x${item.h}` === event.target.value)
                  if (option) updateSelectedWallTile({ tileWIn: option.w, tileHIn: option.h })
                }}
              >
                <option value="custom">{t('hub_sketch_3d_tile_size_custom')}</option>
                {TILE_SIZE_OPTIONS.map((option) => (
                  <option key={option.key} value={`${option.w}x${option.h}`}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="hub-sketch-field hub-sketch-wall-finishbar-color">
              <span className="muted">{t('hub_sketch_3d_tile_color')}</span>
              <input
                type="color"
                value={cleanColor(activeTile.tileColor, DEFAULT_TILE_COLOR)}
                onChange={(event) => updateSelectedWallTile({ tileColor: event.target.value })}
              />
            </label>
          </div>
        )}
        {selectedWallSurface.kind === 'drywall-patch' && (
          <div className="hub-sketch-wall-finishbar-tile">
            <label className="hub-sketch-field hub-sketch-wall-finishbar-color">
              <span className="muted">{t('hub_sketch_drywall_base_color')}</span>
              <input
                type="color"
                value={cleanColor(selectedWallSurface.baseColor, DEFAULT_WALL_PAINT)}
                onChange={(event) => updateSelectedWallDrywallColor('baseColor', event.target.value)}
              />
            </label>
            <label className="hub-sketch-field hub-sketch-wall-finishbar-color">
              <span className="muted">{t('hub_sketch_drywall_patch_color')}</span>
              <input
                type="color"
                value={cleanColor(selectedWallSurface.patchColor, DEFAULT_DRYWALL_PATCH_COLOR)}
                onChange={(event) => updateSelectedWallDrywallColor('patchColor', event.target.value)}
              />
            </label>
          </div>
        )}
        {selectedWallFinish?.overridden && (
          <button type="button" className="btn ghost small" onClick={clearSelectedWallSurface}>
            {t('hub_sketch_3d_wall_use_all')}
          </button>
        )}
      </div>
    )
  }

  const renderViewModeToggle = (fullscreen = false) => (
    <div
      className={fullscreen ? 'hub-sketch-view-toggle hub-sketch-view-toggle-fullscreen' : 'hub-sketch-view-toggle'}
      role="group"
      aria-label={t('hub_sketch_view_mode')}
    >
      {(['2d', '3d'] as ViewMode[]).map((mode) => (
        <button
          key={mode}
          type="button"
          className={viewMode === mode ? 'btn small' : 'btn ghost small'}
          aria-pressed={viewMode === mode}
          onClick={() => switchSketchViewMode(mode, fullscreen)}
        >
          {t(mode === '2d' ? 'hub_sketch_view_2d' : 'hub_sketch_view_3d')}
        </button>
      ))}
    </div>
  )

  const renderCanvasControls = () => (
    <div className="hub-sketch-2d-control-stack" role="toolbar" aria-label={t('hub_sketch_2d_canvas_tools')}>
      <div className="hub-sketch-2d-control-group" role="group" aria-label={t('hub_sketch_history_controls')}>
        <button
          type="button"
          className="hub-sketch-round-btn"
          disabled={!canEdit || !canUndo}
          aria-label={t('hub_sketch_step_back')}
          title={t('hub_sketch_step_back')}
          onClick={undo}
        >
          ↶
        </button>
        <button
          type="button"
          className="hub-sketch-round-btn"
          disabled={!canEdit || !canRedo}
          aria-label={t('hub_sketch_step_forward')}
          title={t('hub_sketch_step_forward')}
          onClick={redo}
        >
          ↷
        </button>
      </div>
      <div className="hub-sketch-2d-control-group" role="group" aria-label={t('hub_sketch_zoom_controls')}>
        <button
          type="button"
          className="hub-sketch-round-btn"
          aria-label={t('hub_sketch_zoom_in')}
          title={t('hub_sketch_zoom_in')}
          onClick={() => zoomCanvasToCenter(1 / ZOOM_BUTTON_STEP)}
        >
          +
        </button>
        <button
          type="button"
          className="hub-sketch-round-btn"
          aria-label={t('hub_sketch_zoom_out')}
          title={t('hub_sketch_zoom_out')}
          onClick={() => zoomCanvasToCenter(ZOOM_BUTTON_STEP)}
        >
          −
        </button>
      </div>
      <div className="hub-sketch-2d-tools" role="group" aria-label={t('hub_sketch_view_controls')}>
        <button type="button" className="btn ghost small" onClick={fitCanvasToModel}>
          {t('hub_sketch_camera_fit')}
        </button>
        <button type="button" className="btn ghost small" aria-pressed={canvasFullscreenActive} onClick={toggleCanvasFullscreen}>
          {t(canvasFullscreenActive ? 'hub_sketch_3d_fullscreen_exit' : 'hub_sketch_3d_fullscreen')}
        </button>
      </div>
    </div>
  )

  const closeSketchSheet = (kind: SketchSheetKind) => {
    if (kind === 'context') {
      setContextSheetOpen(false)
      setClearConfirmOpen(false)
    } else {
      closeSketchPropertiesPanel()
    }
  }

  const startSheetSwipe = (kind: SketchSheetKind) => (event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse') return
    sheetSwipeRef.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastY: event.clientY,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const moveSheetSwipe = (event: React.PointerEvent<HTMLElement>) => {
    const swipe = sheetSwipeRef.current
    if (!swipe || swipe.pointerId !== event.pointerId) return
    swipe.lastY = event.clientY
  }

  const endSheetSwipe = (event: React.PointerEvent<HTMLElement>) => {
    const swipe = sheetSwipeRef.current
    if (!swipe || swipe.pointerId !== event.pointerId) return
    sheetSwipeRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const dy = swipe.lastY - swipe.startY
    const dx = event.clientX - swipe.startX
    if (dy > 56 && dy > Math.abs(dx) * 1.25) closeSketchSheet(swipe.kind)
  }

  const renderSketchContextPanel = (fullscreen = false) => {
    const activeModeMeta = SKETCH_MODE_OPTIONS.find((option) => option.mode === activeMode) ?? SKETCH_MODE_OPTIONS[0]
    const copySelection = activeCopySelection()
    const canSaveRoomTemplate = model.contours.some((contour) => contour.closed && contour.points.length >= 3)
    return (
      <aside
        className={[
          'hub-sketch-context-panel',
          fullscreen ? 'hub-sketch-context-panel-fullscreen' : '',
          contextSheetOpen ? 'hub-sketch-sheet-open' : 'hub-sketch-sheet-closed',
        ].filter(Boolean).join(' ')}
        aria-label={t('hub_sketch_context_panel')}
      >
        <div
          className="hub-sketch-sheet-grip"
          aria-hidden="true"
          onPointerDown={startSheetSwipe('context')}
          onPointerMove={moveSheetSwipe}
          onPointerUp={endSheetSwipe}
          onPointerCancel={endSheetSwipe}
        />
        <div className="hub-sketch-context-head">
          <span className="hub-sketch-context-icon" aria-hidden="true">{activeModeMeta.icon}</span>
          <h3>{t(activeModeMeta.labelKey)}</h3>
          <button type="button" className="hub-sketch-sheet-close btn ghost small" onClick={() => closeSketchSheet('context')}>
            {t('close')}
          </button>
        </div>

        {activeMode === 'wall' && (
          <div className="hub-sketch-context-section">
            <div className="hub-sketch-context-primary">
              <button type="button" className="btn hub-sketch-context-primary-btn" disabled={!canClose} onClick={finishShape}>
                {t('hub_sketch_finish')}
              </button>
              <button
                type="button"
                className={newRoomDraftPending ? 'btn small' : 'btn ghost small'}
                aria-pressed={newRoomDraftPending}
                onClick={startNewRoom}
              >
                {`+ ${t('hub_sketch_room_add')}`}
              </button>
            </div>
            <div className="hub-sketch-context-actions-row">
              <button type="button" className="btn ghost small" onClick={() => setTemplatePickerOpen((value) => !value)}>
                {t('hub_sketch_template_new')}
              </button>
              <button type="button" className="btn ghost small" disabled={!copySelection} onClick={duplicateSelectedSketch}>
                {t('hub_sketch_duplicate')}
              </button>
              <button type="button" className="btn ghost small" disabled={!copySelection} onClick={mirrorSelectedSketch}>
                {t('hub_sketch_mirror')}
              </button>
              <button type="button" className="btn ghost small" disabled={!canSaveRoomTemplate} onClick={saveCurrentAsTemplate}>
                {t('hub_sketch_template_save')}
              </button>
              <button type="button" className="btn ghost small hub-sketch-context-danger" disabled={!canClearSketch} onClick={requestClearAll}>
                {t('hub_sketch_clear')}
              </button>
            </div>
            {clearConfirmOpen && (
              <div className="hub-sketch-clear-confirm" role="group" aria-label={t('hub_sketch_clear_confirm')}>
                <span>{t('hub_sketch_clear_confirm')}</span>
                <button type="button" className="btn red small" onClick={clearAll}>
                  {t('hub_sketch_clear_confirm_yes')}
                </button>
                <button type="button" className="btn ghost small" onClick={cancelClearAll}>
                  {t('hub_sketch_cancel')}
                </button>
              </div>
            )}
            {templatePickerOpen && (
              <div className="hub-sketch-template-list" role="list" aria-label={t('hub_sketch_templates')}>
                {roomTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="hub-sketch-template-card"
                    onClick={() => addRoomTemplate(template)}
                  >
                    <span>{templateDisplayName(template)}</span>
                    <small>{templateStatsText(template)}</small>
                  </button>
                ))}
              </div>
            )}
            <div className="hub-sketch-context-stats hub-sketch-context-stats-inline" aria-label={t('hub_sketch_stats')}>
              <div>
                <span className="muted">{t('hub_sketch_area')}</span>
                <strong>{stats.totalArea.toFixed(1)} ft²</strong>
              </div>
              <div>
                <span className="muted">{t('hub_sketch_perimeter')}</span>
                <strong>{fmtFt(stats.totalPerimeter)}</strong>
              </div>
              <div>
                <span className="muted">{t('hub_sketch_contours')}</span>
                <strong>{model.contours.filter((c) => c.points.length >= 2).length}</strong>
              </div>
            </div>
          </div>
        )}

        {activeMode === 'opening' && (
          <div className="hub-sketch-context-section">
            <div className="hub-sketch-segmented" role="group" aria-label={t('hub_sketch_3d_openings')}>
              {(['door', 'window'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={tool === kind ? 'btn small' : 'btn ghost small'}
                  aria-pressed={tool === kind}
                  onClick={() => {
                    setTool(kind)
                    setMeasurementDraft(null)
                    setSelectedMeasurementIndex(null)
                  }}
                >
                  {t(kind === 'door' ? 'hub_sketch_tool_door' : 'hub_sketch_tool_window')}
                </button>
              ))}
            </div>
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
            <div className="hub-sketch-actions">
              <button type="button" className="btn ghost small" disabled={!canCenterOpening} onClick={centerSelectedOpening}>
                {t('hub_sketch_opening_center')}
              </button>
              <button type="button" className="btn ghost small" disabled={selectedOpeningIndex === null} onClick={removeSelectedOpening}>
                {t('hub_sketch_3d_remove')}
              </button>
            </div>
          </div>
        )}

        {activeMode === 'cabinet' && (
        <div className="hub-sketch-cabinet-tools">
          <label className="hub-sketch-field hub-sketch-cabinet-wall-select">
            <span className="muted">{t('hub_sketch_cabinet_wall')}</span>
            <select
              value={effectiveCabinetWallKey ?? ''}
              onChange={(event) => {
                const key = event.target.value || null
                setSelectedCabinetWallKey(key)
                if (key) setSelectedWallKey(key)
              }}
              disabled={cabinetWallOptions.length === 0}
            >
              {cabinetWallOptions.length === 0 && <option value="">{t('hub_sketch_no_segment')}</option>}
              {cabinetWallGroups.map((group) => (
                <optgroup key={`room-wall-group-${group.c}`} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {/* UX-CABINETS-6: визуальные карточки — ГЛАВНЫЙ способ добавить шкаф (клик = шкаф в ряд) */}
          <div className="hub-sketch-cabinet-gallery hub-sketch-cabinet-gallery-panel">
            <div className="hub-sketch-cabinet-gallery-head">
              <span>{t('hub_sketch_cabinet_gallery_title')}</span>
              <span className="hub-sketch-cabinet-gallery-count">{CABINET_CATALOG_ENTRIES.length}</span>
            </div>
            <p className="hub-sketch-cabinet-gallery-hint muted">{t('hub_sketch_cabinet_gallery_pick_hint')}</p>
            <div className="hub-sketch-cabinet-gallery-body">
              <label className="hub-sketch-field hub-sketch-cabinet-gallery-search">
                <span className="muted">{t('hub_sketch_cabinet_gallery_search_label')}</span>
                <input
                  type="search"
                  value={cabinetGallerySearch}
                  onChange={(event) => setCabinetGallerySearch(event.target.value)}
                  placeholder={t('hub_sketch_cabinet_gallery_search')}
                />
              </label>
              {cabinetGalleryGroups.length === 0 ? (
                <div className="hub-sketch-cabinet-gallery-empty">{t('hub_sketch_cabinet_gallery_empty')}</div>
              ) : (
                cabinetGalleryGroups.map((group) => (
                  <section className="hub-sketch-cabinet-gallery-group" key={group.category.id}>
                    <h4>{t(group.category.labelKey)}</h4>
                    <div className="hub-sketch-cabinet-gallery-grid">
                      {group.entries.map((entry) => {
                        const selected = selectedCabinetGalleryEntryId === entry.id
                        const defaultCode = cabinetCatalogEntryCode(entry, cabinetCatalogDefaultWidth(entry), cabinetGalleryWallHeight)
                        return (
                          <div className={selected ? 'hub-sketch-cabinet-gallery-card hub-sketch-cabinet-gallery-card-active' : 'hub-sketch-cabinet-gallery-card'} key={entry.id}>
                            <button
                              type="button"
                              className="hub-sketch-cabinet-gallery-pick"
                              disabled={!selectedCabinetWall}
                              title={t('hub_sketch_cabinet_gallery_add')}
                              onClick={() => placeCabinetEntry(entry)}
                            >
                              <CabinetGalleryIcon icon={entry.icon} />
                              <span className="hub-sketch-cabinet-gallery-card-body">
                                <span className="hub-sketch-cabinet-gallery-card-name">{t(entry.labelKey)}</span>
                                <span className="hub-sketch-cabinet-gallery-card-code">{defaultCode}</span>
                              </span>
                              <span className="hub-sketch-cabinet-gallery-card-add" aria-hidden="true">+</span>
                            </button>
                            <button
                              type="button"
                              className="hub-sketch-cabinet-gallery-more"
                              aria-expanded={selected}
                              onClick={() => setSelectedCabinetGalleryEntryId((current) => current === entry.id ? null : entry.id)}
                            >
                              {t(entry.sizeKind === 'panelDepth' ? 'hub_sketch_cabinet_gallery_depth' : 'hub_sketch_cabinet_gallery_sizes')}
                              <span aria-hidden="true">{selected ? '▴' : '▾'}</span>
                            </button>
                            {selected && (
                              <div className="hub-sketch-cabinet-gallery-sizes">
                                {entry.sizeKind === 'wall' && (
                                  <div className="hub-sketch-cabinet-gallery-size-row" role="group" aria-label={t('hub_sketch_cabinet_wall_height')}>
                                    <span className="muted">{t('hub_sketch_cabinet_wall_height')}</span>
                                    {(entry.wallHeightsIn ?? CABINET_WALL_HEIGHTS_IN).map((heightIn) => (
                                      <button
                                        key={heightIn}
                                        type="button"
                                        className={cabinetGalleryWallHeight === heightIn ? 'btn small' : 'btn ghost small'}
                                        aria-pressed={cabinetGalleryWallHeight === heightIn}
                                        onClick={() => setCabinetGalleryWallHeight(heightIn)}
                                      >
                                        {`${heightIn}"`}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <div className="hub-sketch-cabinet-gallery-size-row" role="group" aria-label={t(entry.sizeKind === 'panelDepth' ? 'hub_sketch_cabinet_gallery_depth' : 'hub_sketch_width')}>
                                  <span className="muted">{t(entry.sizeKind === 'panelDepth' ? 'hub_sketch_cabinet_gallery_depth' : 'hub_sketch_width')}</span>
                                  {entry.widthsIn.map((widthIn) => (
                                    <button
                                      key={`${entry.id}-${widthIn}`}
                                      type="button"
                                      className="btn ghost small hub-sketch-cabinet-gallery-code-chip"
                                      disabled={!selectedCabinetWall}
                                      onClick={() => placeCabinetEntry(entry, widthIn)}
                                    >
                                      {entry.sizeKind === 'wall' ? `${widthIn}"` : `+${cabinetCatalogEntryCode(entry, widthIn, cabinetGalleryWallHeight)}`}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </section>
                ))
              )}
            </div>
          </div>
          {/* Текущий ряд на выбранной стене — видно и можно удалить в один клик */}
          <div className="hub-sketch-cabinet-run" role="group" aria-label={t('hub_sketch_cabinet_run_label')}>
            <span className="hub-sketch-cabinet-run-label muted">{t('hub_sketch_cabinet_run_label')}</span>
            {cabinetRunItems.length === 0 ? (
              <span className="muted">{t('hub_sketch_cabinet_run_empty')}</span>
            ) : (
              cabinetRunItems.map((item) => (
                <span className="hub-sketch-cabinet-run-chip" key={item.id}>
                  <span>{cabinetDisplayCode(item)}</span>
                  <button
                    type="button"
                    className="hub-sketch-cabinet-run-remove"
                    aria-label={`${t('hub_sketch_cabinet_remove')} ${cabinetDisplayCode(item)}`}
                    onClick={() => handleCabinetRemove(item)}
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
          {/* ПРО-режим: ввод кодами (эксперт) — свёрнут по умолчанию */}
          <details className="hub-sketch-cabinet-expert">
            <summary>{t('hub_sketch_cabinet_expert')}</summary>
            <div className="hub-sketch-cabinet-expert-body">
              <p className="hub-sketch-cabinet-expert-note muted">{t('hub_sketch_cabinet_expert_note')}</p>
              <textarea
                className="hub-sketch-cabinet-code-input"
                value={cabinetCodes}
                onChange={(event) => setCabinetCodes(event.target.value)}
                rows={fullscreen ? 2 : 3}
                spellCheck={false}
                placeholder="B30 2DB27 W3030 BEP24-3/4 BF3"
              />
              <details className="hub-sketch-cabinet-cheatsheet">
                <summary>{t('hub_sketch_cabinet_cheatsheet')}</summary>
                <p>{t('hub_sketch_cabinet_codes_hint')}</p>
                <div className="hub-sketch-cabinet-help-grid">
                  {CABINET_HELP_ITEMS.map((item) => (
                    <span key={item.code}>
                      <strong>{item.code}</strong>
                      {`=${t(item.labelKey)}`}
                    </span>
                  ))}
                </div>
              </details>
              <div className="hub-sketch-cabinet-builder" role="group" aria-label={t('hub_sketch_cabinet_builder_label')}>
                <div className="hub-sketch-cabinet-builder-row">
                  {CABINET_BUILDER_KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={cabinetBuilderKind === kind ? 'btn small' : 'btn ghost small'}
                      aria-pressed={cabinetBuilderKind === kind}
                      onClick={() => setCabinetBuilderKind(kind)}
                    >
                      {`+${t(CABINET_BUILDER_LABEL_KEYS[kind])}`}
                    </button>
                  ))}
                </div>
                {cabinetBuilderKind === 'wall' && (
                  <div className="hub-sketch-cabinet-builder-row" role="group" aria-label={t('hub_sketch_cabinet_wall_height')}>
                    <span className="muted">{t('hub_sketch_cabinet_wall_height')}</span>
                    {CABINET_WALL_HEIGHTS_IN.map((heightIn) => (
                      <button
                        key={heightIn}
                        type="button"
                        className={cabinetBuilderWallHeight === heightIn ? 'btn small' : 'btn ghost small'}
                        aria-pressed={cabinetBuilderWallHeight === heightIn}
                        onClick={() => setCabinetBuilderWallHeight(heightIn)}
                      >
                        {`${heightIn}"`}
                      </button>
                    ))}
                  </div>
                )}
                {cabinetBuilderKind === 'appliance' && (
                  <div className="hub-sketch-cabinet-builder-row" role="group" aria-label={t('hub_sketch_cabinet_appliance_type')}>
                    <span className="muted">{t('hub_sketch_cabinet_appliance_type')}</span>
                    {CABINET_APPLIANCE_PREFIXES.map((prefix) => (
                      <button
                        key={prefix}
                        type="button"
                        className={cabinetBuilderAppliance === prefix ? 'btn small' : 'btn ghost small'}
                        aria-pressed={cabinetBuilderAppliance === prefix}
                        onClick={() => setCabinetBuilderAppliance(prefix)}
                      >
                        {t(CABINET_APPLIANCE_LABEL_KEYS[prefix])}
                      </button>
                    ))}
                  </div>
                )}
                <div className="hub-sketch-cabinet-builder-row" role="group" aria-label={t('hub_sketch_width')}>
                  <span className="muted">{t('hub_sketch_width')}</span>
                  {CABINET_STANDARD_WIDTHS_IN.map((widthIn) => (
                    <button key={widthIn} type="button" className="btn ghost small" onClick={() => addCabinetBuilderWidth(widthIn)}>
                      {`+${widthIn}"`}
                    </button>
                  ))}
                </div>
              </div>
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
              {/* CABINETS-PLACE-13: незакрытый остаток стены показываем цифрой, а не гигантским авто-филлером */}
              {cabinetLayoutPreview && cabinetLayoutPreview.summaries.some((summary) => summary.remainderIn > 0) && (
                <div className="hub-sketch-cabinet-remainder">
                  {cabinetLayoutPreview.summaries.filter((summary) => summary.remainderIn > 0).map((summary) => (
                    <span className="hub-sketch-cabinet-remainder-chip" key={summary.layer}>
                      {`${t(summary.layer === 'base' ? 'hub_sketch_cabinet_base' : 'hub_sketch_cabinet_wall_layer')} · ${t('hub_sketch_cabinet_wall_used')} ${formatInches(summary.totalWidthIn)} · ${t('hub_sketch_cabinet_wall_remainder')} ${formatInches(summary.remainderIn)}`}
                    </span>
                  ))}
                </div>
              )}
              {cabinetLayoutPreview && cabinetLayoutPreview.invalidCodes.length > 0 && (
                <div className="hub-sketch-cabinet-help">
                  {cabinetLayoutPreview.invalidCodes.map((invalidCode, invalidIndex) => {
                    const candidates = cabinetLayoutPreview.suggestions[invalidCode] ?? suggestCabinetCodes(invalidCode)
                    return (
                      <div className="hub-sketch-cabinet-suggestion-row" key={`${invalidCode}-${invalidIndex}`}>
                        <span className="hub-sketch-cabinet-suggestion-text">{`${t('hub_sketch_cabinet_invalid')}: ${invalidCode}`}</span>
                        {candidates.length > 0 && <span className="muted">{`${t('hub_sketch_cabinet_maybe')}:`}</span>}
                        {candidates.map((candidate) => (
                          <button
                            key={`${invalidCode}-${invalidIndex}-${candidate}`}
                            type="button"
                            className="btn ghost small hub-sketch-cabinet-chip"
                            onClick={() => applyCabinetSuggestion(invalidCode, candidate)}
                          >
                            {cabinetSuggestionLabel(candidate)}
                          </button>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}
              {cabinetLayoutPreview?.overflow && <div className="error-msg hub-sketch-cabinet-warning">{t('hub_sketch_cabinet_overflow')}</div>}
              {cabinetLayoutPreview?.smallFiller && <div className="error-msg hub-sketch-cabinet-warning">{t('hub_sketch_cabinet_small_filler')}</div>}
            </div>
          </details>
        </div>
      )}
        {activeMode === 'measure' && (
          <div className="hub-sketch-context-section">
            <button
              type="button"
              className={tool === 'measure' ? 'btn small' : 'btn ghost small'}
              aria-pressed={tool === 'measure'}
              onClick={() => {
                setTool('measure')
                setShowMeasurements(true)
                setMeasurementDraft(null)
              }}
            >
              {t('hub_sketch_tool_measure')}
            </button>
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
            <button type="button" className="btn ghost small" disabled={selectedMeasurementIndex === null} onClick={() => selectedMeasurementIndex !== null && removeMeasurement(selectedMeasurementIndex)}>
              {t('hub_sketch_measurement_delete')}
            </button>
          </div>
        )}

        {activeMode === 'light' && (
          <div className="hub-sketch-context-section">
            <button type="button" className="btn small" onClick={() => setViewMode('3d')}>
              {t('hub_sketch_view_3d')}
            </button>
            <div className="hub-sketch-segmented" role="group" aria-label={t('hub_sketch_material_section_electrical')}>
              {(['outlet', 'switch'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={tool === kind ? 'btn small' : 'btn ghost small'}
                  aria-pressed={tool === kind}
                  onClick={() => {
                    setViewMode('2d')
                    setTool(kind)
                    setMeasurementDraft(null)
                    setSelectedMeasurementIndex(null)
                  }}
                >
                  {t(kind === 'outlet' ? 'hub_sketch_outlet' : 'hub_sketch_switch')}
                </button>
              ))}
            </div>
          </div>
        )}

        {activeMode === 'finish' && (
          <div className="hub-sketch-context-section">
            <button type="button" className="btn small" onClick={() => setViewMode('3d')}>
              {t('hub_sketch_view_3d')}
            </button>
            {selectedWall ? (
              <button type="button" className="btn ghost small" onClick={openWallFinish}>
                {t('hub_sketch_wall_panel_finish_action')}
              </button>
            ) : (
              <p className="muted hub-sketch-context-hint">{t('hub_sketch_finish_pick_wall_hint')}</p>
            )}
          </div>
        )}

        {activeMode === 'markup' && (
          <div className="hub-sketch-context-section">
            <label className="muted hub-sketch-name-label">{t('hub_sketch_name')}</label>
            <input
              className="hub-sketch-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="room-1"
              disabled={busy}
            />
            <div className="hub-sketch-material-options">
              <label className="hub-sketch-layer-toggle">
                <input
                  type="checkbox"
                  checked={includePrimer}
                  onChange={(event) => setIncludePrimer(event.target.checked)}
                />
                <span>{t('hub_sketch_material_include_primer')}</span>
              </label>
              <label className="hub-sketch-layer-toggle">
                <input
                  type="checkbox"
                  checked={includeTexture}
                  onChange={(event) => setIncludeTexture(event.target.checked)}
                />
                <span>{t('hub_sketch_material_include_texture')}</span>
              </label>
            </div>
            <div className="hub-sketch-save-actions">
              <button type="button" className="btn small" disabled={busy} onClick={save}>
                {busy ? t('saving') : t('hub_sketch_save')}
              </button>
              <button type="button" className="btn ghost small" disabled={busy} onClick={calcMaterial}>
                {t('hub_sketch_material')}
              </button>
              <button type="button" className="btn ghost small" disabled={sketchMaterialsBusy} onClick={runSketchMaterials}>
                {sketchMaterialsBusy ? t('loading') : t('hub_sketch_materials_from_sketch')}
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
      </aside>
    )
  }

  const request3DCameraPreset = (mode: SketchCameraPreset, preserveFullscreen = false) => {
    switchSketchViewMode('3d', preserveFullscreen)
    setThreeDCameraPresetRequest((current) => ({ mode, key: (current?.key ?? 0) + 1 }))
  }

  const runViewPreset = (mode: SketchCameraPreset, preserveFullscreen = false) => {
    if (mode === 'fit' && viewMode === '2d') {
      fitCanvasToModel()
      return
    }
    request3DCameraPreset(mode, preserveFullscreen)
  }

  const renderSketchTopbar = (fullscreen = false) => (
    <div className={fullscreen ? 'hub-sketch-topbar hub-sketch-topbar-fullscreen' : 'card hub-sketch-topbar'}>
      <div className="hub-sketch-topbar-group hub-sketch-topbar-left">
        {renderViewModeToggle(fullscreen)}
        <div className="hub-sketch-view-preset-group" role="group" aria-label={t('hub_sketch_view_controls')}>
          {!fullscreen && (
            <button type="button" className="btn ghost small" onClick={() => runViewPreset('fit', fullscreen)}>
              {t('hub_sketch_camera_fit')}
            </button>
          )}
          <button type="button" className="btn ghost small" onClick={() => runViewPreset('top', fullscreen)}>
            {t('hub_sketch_camera_top')}
          </button>
          <button type="button" className="btn ghost small" onClick={() => runViewPreset('angle', fullscreen)}>
            {t('hub_sketch_camera_angle')}
          </button>
          <button type="button" className="btn ghost small" onClick={() => runViewPreset('inside', fullscreen)}>
            {t('hub_sketch_camera_inside')}
          </button>
        </div>
      </div>
      <div className="hub-sketch-topbar-group hub-sketch-topbar-center">
        {lengthInput('wallHeight', 'hub_sketch_wall_height', heightFt, 1, 30, updateWallHeight, 'hub-sketch-height-field')}
        <div className="hub-sketch-snap hub-sketch-snap-compact" role="group" aria-label={t('hub_sketch_snap')}>
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
        <label className="hub-sketch-layer-toggle hub-sketch-code-toggle">
          <input
            type="checkbox"
            checked={codeCheckEnabled}
            onChange={(event) => setCodeCheckEnabled(event.target.checked)}
          />
          <span>{t('hub_sketch_code_check')}</span>
        </label>
      </div>
      <div className="hub-sketch-topbar-group hub-sketch-topbar-right">
        {canEdit && (
          <button
            type="button"
            className={newRoomDraftPending ? 'btn small' : 'btn ghost small'}
            aria-pressed={newRoomDraftPending}
            onClick={startNewRoom}
          >
            {`+ ${t('hub_sketch_room_add')}`}
          </button>
        )}
        <button type="button" className="btn ghost small" onClick={() => selectSketchMode('markup')}>
          {t('hub_sketch_mode_markup')}
        </button>
        {viewMode === '2d' && !fullscreen && (
          <button type="button" className="btn ghost small" aria-pressed={canvasFullscreenActive} onClick={toggleCanvasFullscreen}>
            {t(canvasFullscreenActive ? 'hub_sketch_3d_fullscreen_exit' : 'hub_sketch_3d_fullscreen')}
          </button>
        )}
      </div>
    </div>
  )

  const renderModeRail = (fullscreen = false) => (
    <nav className={fullscreen ? 'hub-sketch-mode-rail hub-sketch-mode-rail-fullscreen' : 'hub-sketch-mode-rail'} aria-label={t('hub_sketch_mode_rail')}>
      {/* SKETCH-RAIL-FIX-19: кнопка-тоггл всегда в DOM — при use3DContextPanel слот
          РЕЗЕРВИРУЕТСЯ (visibility:hidden + pointer-events:none, НЕ display:none),
          чтобы кнопки режимов стояли на одних и тех же Y в 2D и 3D и рейл не съезжал
          (иначе нативный title показывал соседний режим под курсором). */}
      <button
        type="button"
        className={use3DContextPanel ? 'hub-sketch-mode-btn hub-sketch-panel-toggle-btn hub-sketch-panel-toggle-btn-reserved' : 'hub-sketch-mode-btn hub-sketch-panel-toggle-btn'}
        aria-pressed={!contextPanelCollapsed}
        aria-hidden={use3DContextPanel || undefined}
        tabIndex={use3DContextPanel ? -1 : undefined}
        aria-label={t(contextPanelCollapsed ? 'hub_sketch_panel_expand' : 'hub_sketch_panel_collapse')}
        title={use3DContextPanel ? undefined : t(contextPanelCollapsed ? 'hub_sketch_panel_expand' : 'hub_sketch_panel_collapse')}
        onClick={() => {
          if (use3DContextPanel) return
          setContextPanelCollapsed((value) => !value)
        }}
      >
        <span className="hub-sketch-mode-icon" aria-hidden="true">{contextPanelCollapsed ? '☰' : '‹'}</span>
        <span className="hub-sketch-mode-label">{t(contextPanelCollapsed ? 'hub_sketch_panel_expand' : 'hub_sketch_panel_collapse')}</span>
      </button>
      {SKETCH_MODE_OPTIONS.map((option) => (
        <button
          key={option.mode}
          type="button"
          className={activeMode === option.mode ? 'hub-sketch-mode-btn hub-sketch-mode-btn-active' : 'hub-sketch-mode-btn'}
          aria-label={t(option.labelKey)}
          aria-pressed={activeMode === option.mode}
          title={t(option.labelKey)}
          onClick={() => selectSketchMode(option.mode)}
        >
          <span className="hub-sketch-mode-icon" aria-hidden="true">{option.icon}</span>
          <span className="hub-sketch-mode-label">{t(option.labelKey)}</span>
        </button>
      ))}
    </nav>
  )

  const renderSketchPropertiesPanel = () => {
    const selectedMeasurement = selectedMeasurementIndex !== null ? model.measurements?.[selectedMeasurementIndex] ?? null : null
    if (!selectedWall && !selectedContour && !selectedOpening && !selectedMeasurement) return null
    return (
      <aside className="hub-sketch-properties-panel hub-sketch-sheet-open" aria-label={t('hub_sketch_properties_panel')}>
        <div
          className="hub-sketch-sheet-grip"
          aria-hidden="true"
          onPointerDown={startSheetSwipe('properties')}
          onPointerMove={moveSheetSwipe}
          onPointerUp={endSheetSwipe}
          onPointerCancel={endSheetSwipe}
        />
        {selectedWall && (
          <section className="hub-sketch-properties-section">
            <div className="hub-sketch-properties-head">
              <h3>{`${t('hub_sketch_wall_panel_title')} ${selectedWall.index + 1}`}</h3>
              <button
                type="button"
                className="btn ghost small"
                aria-label={t('hub_sketch_wall_panel_close')}
                onClick={() => {
                  setWallElevationFullscreen(false)
                  setSelectedWallKey(null)
                }}
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
                <button type="button" className="btn ghost small" onClick={duplicateSelectedSketch}>
                  {t('hub_sketch_duplicate')}
                </button>
                <button type="button" className="btn ghost small" onClick={mirrorSelectedSketch}>
                  {t('hub_sketch_mirror')}
                </button>
                <button type="button" className="btn ghost small" onClick={addCornerToSelectedWall}>
                  {t('hub_sketch_corner_add')}
                </button>
                <button type="button" className="btn ghost small" onClick={saveCurrentAsTemplate}>
                  {t('hub_sketch_template_save')}
                </button>
              </div>
            )}
          </section>
        )}

        {selectedContour && (
          <section className="hub-sketch-properties-section">
            <div className="hub-sketch-properties-head">
              <h3>{roomDisplayName(selectedContour.contour, selectedContour.index, t('hub_sketch_room_panel_title'))}</h3>
              <button
                type="button"
                className="btn ghost small"
                aria-label={t('hub_sketch_room_panel_close')}
                onClick={() => {
                  setSelectedContourIndex(null)
                  setSelectedNode(null)
                }}
              >
                ×
              </button>
            </div>
            {canEdit && (
              <label className="hub-sketch-field hub-sketch-room-label-field">
                <span className="muted">{t('hub_sketch_room_name')}</span>
                <input
                  key={`room-label-input-${selectedContour.index}-${selectedContour.contour.label ?? ''}`}
                  defaultValue={selectedContour.contour.label ?? ''}
                  placeholder={roomDisplayName(undefined, selectedContour.index, t('hub_sketch_room_panel_title'))}
                  onBlur={(event) => renameContour(selectedContour.index, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      event.currentTarget.value = selectedContour.contour.label ?? ''
                      event.currentTarget.blur()
                    }
                  }}
                />
              </label>
            )}
            <div className="hub-sketch-wall-panel-facts">
              <span className="muted">{t('hub_sketch_area')}</span>
              <span className="hub-sketch-stat-value">{selectedContour.areaSqft.toFixed(1)} ft²</span>
              <span className="muted">{t('hub_sketch_perimeter')}</span>
              <span className="hub-sketch-stat-value">{fmtFt(selectedContour.perimeterFt)}</span>
              <span className="muted">{t('hub_sketch_contours')}</span>
              <span className="hub-sketch-stat-value">{selectedContour.contour.points.length}</span>
            </div>
            {canEdit && (
              <div className="hub-sketch-wall-panel-actions">
                <button type="button" className="btn ghost small" onClick={duplicateSelectedSketch}>
                  {t('hub_sketch_duplicate')}
                </button>
                <button type="button" className="btn ghost small" onClick={mirrorSelectedSketch}>
                  {t('hub_sketch_mirror')}
                </button>
                <button type="button" className="btn ghost small" disabled={!selectedNode} onClick={removeSelectedCorner}>
                  {t('hub_sketch_corner_remove')}
                </button>
                <button type="button" className="btn ghost small" onClick={saveCurrentAsTemplate}>
                  {t('hub_sketch_template_save')}
                </button>
              </div>
            )}
          </section>
        )}

        {selectedOpening && selectedOpeningIndex !== null && (
          <section className="hub-sketch-properties-section">
            <div className="hub-sketch-properties-head">
              <h3>{t(selectedOpening.kind === 'door' ? 'hub_sketch_tool_door' : 'hub_sketch_tool_window')}</h3>
              <button
                type="button"
                className="btn ghost small"
                aria-label={t('hub_sketch_wall_panel_close')}
                onClick={() => {
                  selectedOpeningIndexRef.current = null
                  setSelectedOpeningIndex(null)
                  setOpeningOffsetEdit(null)
                }}
              >
                ×
              </button>
            </div>
            {lengthInput('doorW', 'hub_sketch_width', openingWidthFt(selectedOpening), 0.5, 20, updateSelectedOpeningWidth)}
            {lengthInput('doorH', 'hub_sketch_height', openingHeightFt(selectedOpening), 0.5, 20, updateSelectedOpeningHeight)}
            {selectedOpening.kind === 'window' && lengthInput('winSill', 'hub_sketch_sill', openingFloorFt(selectedOpening), 0, 20, updateSelectedOpeningFloor)}
            <div className="hub-sketch-wall-panel-actions">
              <button type="button" className="btn ghost small" disabled={!canCenterOpening} onClick={centerSelectedOpening}>
                {t('hub_sketch_opening_center')}
              </button>
              <button type="button" className="btn ghost small" onClick={removeSelectedOpening}>
                {t('hub_sketch_3d_remove')}
              </button>
            </div>
          </section>
        )}

        {selectedMeasurement && (
          <section className="hub-sketch-properties-section">
            <div className="hub-sketch-properties-head">
              <h3>{t('hub_sketch_tool_measure')}</h3>
              <button type="button" className="btn ghost small" aria-label={t('hub_sketch_wall_panel_close')} onClick={() => setSelectedMeasurementIndex(null)}>
                ×
              </button>
            </div>
            <span className="hub-sketch-stat-value">{fmtFt(dist(selectedMeasurement.a, selectedMeasurement.b) * modelCellFt(model))}</span>
            {canEdit && selectedMeasurementIndex !== null && (
              <button type="button" className="btn ghost small" onClick={() => removeMeasurement(selectedMeasurementIndex)}>
                {t('hub_sketch_measurement_delete')}
              </button>
            )}
          </section>
        )}
      </aside>
    )
  }

  const use3DContextPanel = canEdit && viewMode === '3d' && MODES_WITH_3D_CONTEXT.has(activeMode)
  const hasPropertiesPanel = Boolean(selectedWall || selectedContour || selectedOpening || (selectedMeasurementIndex !== null && model.measurements?.[selectedMeasurementIndex]))
  useEffect(() => {
    if (!hasPropertiesPanel) return
    setContextSheetOpen(false)
    setClearConfirmOpen(false)
  }, [hasPropertiesPanel])
  // SKETCH-CANVAS-12: колонка контекст-панели свёрнута (нет 3D-панели и стоит флаг) —
  // сетка переходит в двухколоночный режим (как -no-context), панель прячется на ≥721px.
  const contextColumnCollapsed = !use3DContextPanel && contextPanelCollapsed
  const workspaceClass = [
    'hub-sketch-workspace',
    (use3DContextPanel || contextColumnCollapsed) ? 'hub-sketch-workspace-no-context' : '',
    contextColumnCollapsed ? 'hub-sketch-workspace-context-collapsed' : '',
    hasPropertiesPanel ? 'hub-sketch-workspace-has-properties' : '',
  ].filter(Boolean).join(' ')

  return (
    <section className={canvasFullscreenActive ? 'hub-tab-panel hub-sketch hub-sketch-2d-fullscreen-active' : 'hub-tab-panel hub-sketch'}>
      {renderSketchTopbar()}

      <div className={workspaceClass}>
        {canEdit && renderModeRail()}
        {canEdit && !use3DContextPanel && renderSketchContextPanel()}

        <div className="hub-sketch-main">
          <div className="card hub-sketch-canvas-card">
        {viewMode === '2d' ? (
          <>
            <div
              ref={svgShellRef}
              className={canvasFullscreenActive ? 'hub-sketch-svg-shell hub-sketch-svg-shell-fullscreen' : 'hub-sketch-svg-shell'}
            >
              {canvasFullscreenActive && renderSketchTopbar(true)}
              {canEdit && canvasFullscreenActive && (
                <div className={contextPanelCollapsed ? 'hub-sketch-fullscreen-context-row hub-sketch-fullscreen-context-row-collapsed' : 'hub-sketch-fullscreen-context-row'}>
                  {renderModeRail(true)}
                  {!contextPanelCollapsed && renderSketchContextPanel(true)}
                </div>
              )}
              <div className="hub-sketch-svg-stage">
                <svg
                  ref={svgRef}
                  className="hub-sketch-svg"
                  viewBox={`${canvasView.x} ${canvasView.y} ${canvasView.width} ${canvasView.height}`}
                  preserveAspectRatio="xMidYMid meet"
                  role="img"
                  aria-label={t('hub_tab_sketch')}
                  onClick={handleClick}
                  onDoubleClick={handleDoubleClick}
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
            const selected = selectedContourIndex === ci
            const justClosed = recentlyClosedContourIndex === ci
            return c.closed && c.points.length >= 3 ? (
              <polygon
                key={`c${ci}`}
                className={[
                  'hub-sketch-wall',
                  selected ? 'hub-sketch-room-selected' : '',
                  justClosed ? 'hub-sketch-room-just-closed' : '',
                ].filter(Boolean).join(' ')}
                points={pts}
                onClick={wallSelectEnabled ? (event) => {
                  event.stopPropagation()
                  setSelectedContourIndex((current) => (current === ci ? null : ci))
                  setSelectedWallKey(null)
                  setSelectedNode(null)
                  setSelectedMeasurementIndex(null)
                  setSelectedOpeningIndex(null)
                } : undefined}
              />
            ) : (
              <polyline key={`c${ci}`} className="hub-sketch-wall" points={pts} fill="none" />
            )
          })}

          {roomLabels.length > 0 && (
            <g className="hub-sketch-room-labels">
              {roomLabels.map((entry) => {
                const justClosed = recentlyClosedContourIndex === entry.index
                const badgeText = t('hub_sketch_closed_badge')
                const badgeWidth = Math.max(74, badgeText.length * 7 + 28) * screenWorldPx
                const badgeHeight = 22 * screenWorldPx
                const badgeX = entry.center.x * CELL_PX - badgeWidth / 2
                const badgeY = entry.center.y * CELL_PX + 12 * screenWorldPx
                return (
                  <g key={`room-label-${entry.index}`}>
                    <text
                      className={selectedContourIndex === entry.index ? 'hub-sketch-room-label hub-sketch-room-label-selected' : 'hub-sketch-room-label'}
                      x={entry.center.x * CELL_PX}
                      y={entry.center.y * CELL_PX}
                      textAnchor="middle"
                      dominantBaseline="central"
                      style={{ fontSize: 12 * screenWorldPx }}
                    >
                      <title>{entry.label}</title>
                      {entry.shortLabel}
                    </text>
                    {justClosed && (
                      <g className="hub-sketch-room-closed-badge">
                        <rect x={badgeX} y={badgeY} width={badgeWidth} height={badgeHeight} rx={5 * screenWorldPx} />
                        <text
                          x={entry.center.x * CELL_PX}
                          y={badgeY + badgeHeight / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          style={{ fontSize: 10.5 * screenWorldPx }}
                        >
                          {`✓ ${badgeText}`}
                        </text>
                      </g>
                    )}
                  </g>
                )
              })}
            </g>
          )}

          {/* NAV-FIX-2: выбор стены на 2D — подсветка выбранной + невидимые хит-таргеты по сегментам */}
          {cabinetWallOptions.map((seg) => {
            const key = sketchWallKey(seg.c, seg.s)
            const x1 = seg.a.x * CELL_PX
            const y1 = seg.a.y * CELL_PX
            const x2 = seg.b.x * CELL_PX
            const y2 = seg.b.y * CELL_PX
            const selected = selectedWallKey === key
            const conflict = segmentResizeConflictKeys.has(key)
            return (
              <g key={`ws-${key}`}>
                {selected && <line className="hub-sketch-wall-selected" x1={x1} y1={y1} x2={x2} y2={y2} />}
                {conflict && <line className="hub-sketch-wall-conflict" x1={x1} y1={y1} x2={x2} y2={y2} />}
                {wallSelectEnabled && (
                  <line
                    className="hub-sketch-wall-hit"
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (selectedWallKey === key) {
                        setSelectedWallKey(null)
                      } else {
                        setSelectedWallKey(key)
                        openWallElevationFullscreen(false)
                      }
                      setSelectedContourIndex(null)
                      setSelectedNode(null)
                    }}
                  />
                )}
              </g>
            )
          })}

          {/* размерные линии стен */}
          {wallDimLines.map((dim, i) => {
            const key = sketchWallKey(dim.c, dim.s)
            const editing = segmentLengthEdit?.ref.c === dim.c && segmentLengthEdit.ref.s === dim.s
            const conflict = segmentResizeConflictKeys.has(key)
            const inputW = Math.max(92, Math.min(150, segmentLengthEdit?.value.length ? segmentLengthEdit.value.length * 8 + 34 : 110)) * screenWorldPx
            const inputH = 32 * screenWorldPx
            return (
              <g key={`l${i}`} className={`hub-sketch-dim-line hub-sketch-dim-line-editable${conflict ? ' hub-sketch-dim-line-conflict' : ''}`}>
                <line className="hub-sketch-dim-extension" x1={dim.ext1x1} y1={dim.ext1y1} x2={dim.ext1x2} y2={dim.ext1y2} />
                <line className="hub-sketch-dim-extension" x1={dim.ext2x1} y1={dim.ext2y1} x2={dim.ext2x2} y2={dim.ext2y2} />
                <line className="hub-sketch-dim-main" x1={dim.x1} y1={dim.y1} x2={dim.x2} y2={dim.y2} />
                <line className="hub-sketch-dim-tick" x1={dim.tick1x1} y1={dim.tick1y1} x2={dim.tick1x2} y2={dim.tick1y2} />
                <line className="hub-sketch-dim-tick" x1={dim.tick2x1} y1={dim.tick2y1} x2={dim.tick2x2} y2={dim.tick2y2} />
                {editing ? (
                  <foreignObject
                    x={dim.labelX - inputW / 2}
                    y={dim.labelY - inputH / 2}
                    width={inputW}
                    height={inputH}
                    transform={`rotate(${dim.angle} ${dim.labelX} ${dim.labelY})`}
                  >
                    <input
                      className="hub-sketch-dim-edit-input"
                      value={segmentLengthEdit.value}
                      inputMode="text"
                      autoFocus
                      aria-label={t('hub_sketch_dimension_edit_label')}
                      onChange={(event) => setSegmentLengthEditValue(event.target.value)}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={() => applySegmentLengthEdit()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          applySegmentLengthEdit()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelSegmentLengthEdit()
                        }
                      }}
                    />
                  </foreignObject>
                ) : (
                  <text
                    className="hub-sketch-dim-label hub-sketch-dim-label-editable"
                    x={dim.labelX}
                    y={dim.labelY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    style={{ fontSize: dimFontSize }}
                    transform={`rotate(${dim.angle} ${dim.labelX} ${dim.labelY})`}
                    role={canEdit ? 'button' : undefined}
                    tabIndex={canEdit ? 0 : undefined}
                    aria-label={canEdit ? t('hub_sketch_dimension_edit_label') : undefined}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      beginSegmentLengthEdit(dim)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      beginSegmentLengthEdit(dim)
                    }}
                  >
                    {dim.text}
                  </text>
                )}
              </g>
            )
          })}

          {/* точки контуров (крупные хит-таргеты) */}
          {model.contours.map((c, ci) =>
            c.points.map((p, pi) => {
              const selected = selectedNode?.c === ci && selectedNode.p === pi
              const dragging = dragNode?.c === ci && dragNode.p === pi
              const activeEnd = activeContourOpen && ci === model.contours.length - 1 && pi === c.points.length - 1
              const nodeHitRadius = Math.max(nodeRadius + 4 * screenWorldPx, NODE_HIT_MIN_SCREEN_PX * screenWorldPx)
              return (
                <g key={`n${ci}-${pi}`} className="hub-sketch-node-group" onClick={canEdit ? handleNodeClick(ci, pi) : undefined}>
                  <circle
                    className="hub-sketch-node-hit"
                    cx={p.x * CELL_PX}
                    cy={p.y * CELL_PX}
                    r={nodeHitRadius}
                    onPointerDown={canEdit ? startDragNode(ci, pi) : undefined}
                  />
                  <circle
                    className={`hub-sketch-node${activeEnd ? ' hub-sketch-node-active-end' : ''}${selected ? ' hub-sketch-node-selected' : ''}${dragging ? ' hub-sketch-node-dragging' : ''}`}
                    cx={p.x * CELL_PX}
                    cy={p.y * CELL_PX}
                    r={nodeRadius}
                    onPointerDown={canEdit ? startDragNode(ci, pi) : undefined}
                  />
                </g>
              )
            }),
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
            const selected = selectedOpeningIndex === i || dragIdx === i
            const dimLabel = openingDimLabel(model, o, i, t, screenWorldPx)
            return (
              <g
                key={`o${i}`}
                className={`${canEdit && tool !== 'measure' ? 'hub-sketch-opening' : ''}${selected ? ' hub-sketch-opening-selected' : ''}`}
                onPointerDown={canEdit && tool !== 'measure' ? startDragOpening(i) : undefined}
              >
                {selected && <line className="hub-sketch-opening-selection-halo" x1={x1} y1={y1} x2={x2} y2={y2} />}
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

          {selectedOpeningClearanceLines.map((dim, index) => renderOpeningClearanceDimLine2D(
            dim,
            `opening-selected-clearance-${index}`,
            'hub-sketch-opening-clearance-dim hub-sketch-opening-clearance-dim-active',
            selectedOpeningIndex,
            canEdit,
          ))}

          {dragOpeningClearanceLines.map((dim, index) => renderOpeningClearanceDimLine2D(
            dim,
            `opening-drag-clearance-${index}`,
            'hub-sketch-opening-clearance-dim hub-sketch-opening-clearance-dim-active',
            dragIdx,
            false,
          ))}

          {activeOpeningSnapGuide && (
            <g className="hub-sketch-opening-snap-guide">
              <line x1={activeOpeningSnapGuide.x1} y1={activeOpeningSnapGuide.y1} x2={activeOpeningSnapGuide.x2} y2={activeOpeningSnapGuide.y2} />
              <circle cx={activeOpeningSnapGuide.dotX} cy={activeOpeningSnapGuide.dotY} r={Math.max(2.5, 3.5 * screenWorldPx)} />
              <text
                x={activeOpeningSnapGuide.labelX}
                y={activeOpeningSnapGuide.labelY}
                textAnchor="middle"
                dominantBaseline="central"
                style={{ fontSize: 11 * screenWorldPx }}
              >
                {activeOpeningSnapGuide.text}
              </text>
            </g>
          )}

          {hoverSnapGuide && tool === 'wall' && wallDraftPointerActive && (
            <g className="hub-sketch-room-snap-guide">
              {hoverSnapGuide.target.kind === 'segment' && (
                <line
                  className="hub-sketch-room-snap-edge"
                  x1={hoverSnapGuide.target.a.x * CELL_PX}
                  y1={hoverSnapGuide.target.a.y * CELL_PX}
                  x2={hoverSnapGuide.target.b.x * CELL_PX}
                  y2={hoverSnapGuide.target.b.y * CELL_PX}
                />
              )}
              <circle
                className={hoverSnapGuide.target.kind === 'point' ? 'hub-sketch-room-snap-node' : 'hub-sketch-room-snap-dot'}
                cx={hoverSnapGuide.point.x * CELL_PX}
                cy={hoverSnapGuide.point.y * CELL_PX}
                r={Math.max(4, 5.5 * screenWorldPx)}
              />
            </g>
          )}

          {smartGuides.length > 0 && (
            <g className="hub-sketch-smart-guides">
              {smartGuides.map((guide, index) => {
                const value = guide.value * CELL_PX
                const label = t(smartGuideLabelKey(guide.kind))
                const line = guide.from && guide.to
                  ? {
                      x1: guide.from.x * CELL_PX,
                      y1: guide.from.y * CELL_PX,
                      x2: guide.to.x * CELL_PX,
                      y2: guide.to.y * CELL_PX,
                    }
                  : null
                const markerPath = guide.cornerMarker
                  ? (() => {
                      const marker = guide.cornerMarker
                      const markerSizeCells = Math.max(0.25, Math.min(0.75, (12 * screenWorldPx) / CELL_PX))
                      const horizontalX = (marker.corner.x + marker.horizontalSign * markerSizeCells) * CELL_PX
                      const verticalY = (marker.corner.y + marker.verticalSign * markerSizeCells) * CELL_PX
                      const cornerX = marker.corner.x * CELL_PX
                      const cornerY = marker.corner.y * CELL_PX
                      return `M ${horizontalX} ${cornerY} L ${horizontalX} ${verticalY} L ${cornerX} ${verticalY}`
                    })()
                  : null
                return guide.axis === 'x' ? (
                  <g key={`sg-${guide.axis}-${guide.kind}-${index}`} className={`hub-sketch-smart-guide hub-sketch-smart-guide-${guide.kind}`}>
                    <line
                      x1={line ? line.x1 : value}
                      y1={line ? line.y1 : canvasView.y}
                      x2={line ? line.x2 : value}
                      y2={line ? line.y2 : canvasView.y + canvasView.height}
                    />
                    {markerPath && <path className="hub-sketch-smart-guide-corner-marker" d={markerPath} />}
                    <text x={(line ? line.x2 : value) + 8 * screenWorldPx} y={line ? line.y2 - 8 * screenWorldPx : canvasView.y + 18 * screenWorldPx}>
                      {label}
                    </text>
                  </g>
                ) : (
                  <g key={`sg-${guide.axis}-${guide.kind}-${index}`} className={`hub-sketch-smart-guide hub-sketch-smart-guide-${guide.kind}`}>
                    <line
                      x1={line ? line.x1 : canvasView.x}
                      y1={line ? line.y1 : value}
                      x2={line ? line.x2 : canvasView.x + canvasView.width}
                      y2={line ? line.y2 : value}
                    />
                    {markerPath && <path className="hub-sketch-smart-guide-corner-marker" d={markerPath} />}
                    <text x={line ? line.x2 + 8 * screenWorldPx : canvasView.x + 8 * screenWorldPx} y={(line ? line.y2 : value) - 8 * screenWorldPx}>
                      {label}
                    </text>
                  </g>
                )
              })}
            </g>
          )}

          {planItems.map((entry) => {
            const className = `hub-sketch-plan-item${entry.warning ? ' hub-sketch-plan-item-warn' : ''}${entry.toilet ? ' hub-sketch-plan-toilet' : ''}${entry.showerPan ? ' hub-sketch-plan-shower' : ''}${entry.cabinet ? ' hub-sketch-plan-cabinet' : ''}${entry.electrical ? ` hub-sketch-plan-electrical hub-sketch-plan-${entry.electrical}` : ''}${entry.layer === 'wall' ? ' hub-sketch-plan-cabinet-wall' : ''}${entry.filler ? ' hub-sketch-plan-cabinet-filler' : ''}${dragPlacedId === entry.item.id ? ' hub-sketch-plan-item-dragging' : ''}`
            const labelFontSize = Math.max(5 * screenWorldPx, Math.min(11 * screenWorldPx, entry.width / Math.max(4, entry.cabinetCode.length * 0.6)))
            return (
              <g
                key={`pi-${entry.item.id}`}
                className={className}
                transform={`translate(${entry.x} ${entry.y}) rotate(${entry.angle})`}
                onPointerDown={canEdit ? startDragPlanItem(entry.item) : undefined}
                onClick={canEdit ? handlePlanItemClick(entry.item) : undefined}
              >
                <title>{entry.item.name ?? (entry.electrical === 'outlet' ? t('hub_sketch_outlet') : entry.electrical === 'switch' ? t('hub_sketch_switch') : entry.toilet ? t('hub_sketch_toilet') : entry.cabinet ? entry.cabinetCode : t('hub_sketch_code_target_item'))}</title>
                <rect
                  className="hub-sketch-plan-item-hit"
                  x={-Math.max(entry.width, 44 * screenWorldPx) / 2}
                  y={-Math.max(entry.depth, 44 * screenWorldPx) / 2}
                  width={Math.max(entry.width, 44 * screenWorldPx)}
                  height={Math.max(entry.depth, 44 * screenWorldPx)}
                  rx={6 * screenWorldPx}
                />
                {entry.electrical ? (
                  <>
                    <rect x={-entry.width / 2} y={-entry.depth / 2} width={entry.width} height={entry.depth} rx={Math.min(4 * screenWorldPx, entry.width * 0.18)} />
                    {entry.electrical === 'outlet' ? (
                      <>
                        <circle className="hub-sketch-plan-electrical-mark" cx={-entry.width * 0.14} cy={-entry.depth * 0.07} r={Math.max(1.2 * screenWorldPx, entry.width * 0.045)} />
                        <circle className="hub-sketch-plan-electrical-mark" cx={entry.width * 0.14} cy={-entry.depth * 0.07} r={Math.max(1.2 * screenWorldPx, entry.width * 0.045)} />
                        <line className="hub-sketch-plan-electrical-mark" x1={-entry.width * 0.18} y1={entry.depth * 0.18} x2={entry.width * 0.18} y2={entry.depth * 0.18} />
                      </>
                    ) : (
                      <line className="hub-sketch-plan-electrical-mark" x1={0} y1={-entry.depth * 0.24} x2={entry.width * 0.12} y2={entry.depth * 0.22} />
                    )}
                  </>
                ) : entry.toilet ? (
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
                    setActiveMode('measure')
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
              const offsets = openingEdgeOffsetsFt(segLen * cellFt, openingWidthFt(o), o.t)
              const px = g.p.x * CELL_PX
              const py = g.p.y * CELL_PX
              const sizeTxt = `${t('hub_sketch_dim_size_short')} ${formatOpeningFt(openingWidthFt(o))}×${formatOpeningFt(openingHeightFt(o))}`
              const floorTxt = o.kind === 'window' ? ` · ${t('hub_sketch_dim_floor_short')} ${formatOpeningFt(openingFloorFt(o))}` : ''
              return (
                <text className="hub-sketch-drag-dim" x={px} y={py - 12} textAnchor="middle">
                  {`${sizeTxt} · ${t('hub_sketch_dim_left_short')} ${formatOpeningFt(offsets.left)} · ${t('hub_sketch_dim_right_short')} ${formatOpeningFt(offsets.right)}${floorTxt}`}
                </text>
              )
            })()}

          {/* превью курсора */}
          {canEdit && hover && ((tool === 'wall' && wallDraftPointerActive) || tool === 'measure') && (
            <circle
              className={hoverSnapped ? 'hub-sketch-hover hub-sketch-hover-snap' : 'hub-sketch-hover'}
              cx={hover.x * CELL_PX}
              cy={hover.y * CELL_PX}
              r={hoverRadius}
            />
          )}
                </svg>
                {selectedWall && selectedWallSurface && !wallElevationFullscreen && (
                  <div className="hub-sketch-wall-elevation-mini">
                    <button
                      type="button"
                      className="hub-sketch-wall-elevation-mini-button"
                      aria-label={t('hub_sketch_elevation_fullscreen_open')}
                      onClick={() => openWallElevationFullscreen(false)}
                    >
                      <WallElevation
                        model={model}
                        wall={selectedWall.seg}
                        heightFt={heightFt}
                        finish={selectedWallSurface}
                        compact
                        codeCheckEnabled={false}
                      />
                      <span>{t('hub_sketch_elevation_fullscreen_open')}</span>
                    </button>
                  </div>
                )}
                {segmentResizeConflict && segmentLengthEdit && (
                  <div className="hub-sketch-dimension-conflict" role="alertdialog" aria-live="polite">
                    <span>{t('hub_sketch_dimension_conflict_prompt')}</span>
                    <button type="button" className="btn small" onMouseDown={(event) => event.preventDefault()} onClick={() => applySegmentLengthEdit('end')}>
                      {t('hub_sketch_dimension_move_start')}
                    </button>
                    <button type="button" className="btn small" onMouseDown={(event) => event.preventDefault()} onClick={() => applySegmentLengthEdit('start')}>
                      {t('hub_sketch_dimension_move_end')}
                    </button>
                    <button type="button" className="btn ghost small" onMouseDown={(event) => event.preventDefault()} onClick={cancelSegmentLengthEdit}>
                      {t('cancel')}
                    </button>
                  </div>
                )}
                {renderCanvasControls()}
                {/* CABINETS-PLACE-13: поповер шкафа на плане — те же контролы, что на развёртке (ширина/высота навесных/удалить). */}
                {planCabinetEditor && (() => {
                  const editorItem = planItems.find((entry) => entry.item.id === planCabinetEditor.id)?.item
                  if (!editorItem) return null
                  const widthIn = Math.round(editorItem.widthIn ?? 0)
                  const left = Math.min(Math.max(12, planCabinetEditor.x), Math.max(12, window.innerWidth - 268))
                  const top = Math.min(Math.max(12, planCabinetEditor.y + 14), Math.max(12, window.innerHeight - 200))
                  return (
                    <div
                      className="hub-sketch-plan-cabinet-editor hub-sketch-elevation-cabinet-editor"
                      role="group"
                      aria-label={t('hub_sketch_cabinet_edit')}
                      style={{ left, top }}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <div className="hub-sketch-elevation-cabinet-editor-head">
                        <strong>{cabinetDisplayCode(editorItem) || t('hub_sketch_tool_cabinet')}</strong>
                        <button
                          type="button"
                          className="hub-sketch-elevation-cabinet-editor-close"
                          aria-label={t('lightbox_close')}
                          onClick={() => setPlanCabinetEditor(null)}
                        >
                          ×
                        </button>
                      </div>
                      <div className="hub-sketch-elevation-cabinet-editor-row" role="group" aria-label={t('hub_sketch_width')}>
                        <span className="muted">{t('hub_sketch_width')}</span>
                        {CABINET_STANDARD_WIDTHS_IN.map((w) => {
                          const current = widthIn === w
                          return (
                            <button
                              key={w}
                              type="button"
                              className={current ? 'btn small' : 'btn ghost small'}
                              aria-pressed={current}
                              onClick={() => handleCabinetResize(editorItem, w)}
                            >
                              {`${w}"`}
                            </button>
                          )
                        })}
                      </div>
                      {editorItem.layer === 'wall' && (
                        <div className="hub-sketch-elevation-cabinet-editor-row" role="group" aria-label={t('hub_sketch_cabinet_wall_height')}>
                          <span className="muted">{t('hub_sketch_cabinet_wall_height')}</span>
                          {CABINET_WALL_HEIGHTS_IN.map((h) => {
                            const current = Math.round(editorItem.heightIn ?? 0) === h
                            return (
                              <button
                                key={h}
                                type="button"
                                className={current ? 'btn small' : 'btn ghost small'}
                                aria-pressed={current}
                                onClick={() => handleCabinetResize(editorItem, widthIn, h)}
                              >
                                {`${h}"`}
                              </button>
                            )
                          })}
                        </div>
                      )}
                      <button
                        type="button"
                        className="btn ghost small hub-sketch-elevation-cabinet-editor-delete"
                        onClick={() => {
                          handleCabinetRemove(editorItem)
                          setPlanCabinetEditor(null)
                        }}
                      >
                        {t('hub_sketch_cabinet_remove')}
                      </button>
                    </div>
                  )
                })()}
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
            onHeightChange={updateWallHeight}
            snapStepFt={activeSnapFt}
            openingDefaults={openingDefaults}
            onOpeningDefaultsChange={(patch) => {
              if (patch.doorW !== undefined) setDoorW(patch.doorW)
              if (patch.doorH !== undefined) setDoorH(patch.doorH)
              if (patch.winW !== undefined) setWinW(patch.winW)
              if (patch.winH !== undefined) setWinH(patch.winH)
              if (patch.winSill !== undefined) setWinSill(patch.winSill)
            }}
            snapControls={SNAP_OPTIONS.map((option) => ({
              key: option.mode,
              label: t(option.labelKey),
              active: snapMode === option.mode,
              onSelect: () => setSnapMode(option.mode),
            }))}
            codeCheckEnabled={codeCheckEnabled}
            onCodeCheckChange={setCodeCheckEnabled}
            pickedWallKey={selectedWallKey}
            onPickWall={handle3DWallPick}
            contextMode={activeMode}
            cameraPresetRequest={threeDCameraPresetRequest}
            fullscreenRequestKey={threeDFullscreenRequest}
            viewModeControl={renderViewModeToggle(true)}
            label={t('hub_sketch_3d_label')}
            loadingLabel={t('hub_sketch_3d_loading')}
            errorLabel={t('hub_sketch_3d_error')}
          />
        )}
          </div>
        </div>
        {renderSketchPropertiesPanel()}
      </div>

      {wallElevationFullscreen && selectedWall && selectedWallSurface && (
        <div
          className="hub-sketch-elevation-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t('hub_sketch_3d_wall_elevation')}
        >
          <WallElevation
            model={model}
            wall={selectedWall.seg}
            heightFt={heightFt}
            finish={selectedWallSurface}
            canEdit={canEdit}
            snapStepFt={activeSnapFt}
            codeCheckEnabled={codeCheckEnabled}
            onMeasurementsChange={updateWallElevationMeasurements}
            onModelChange={updateWallElevationModel}
            onCabinetResize={handleCabinetResize}
            onCabinetRemove={handleCabinetRemove}
            onBack={closeWallElevationFullscreen}
            toolbarExtras={
              <>
                {canEdit && (
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => {
                      closeWallElevationFullscreen()
                      setTool('door')
                    }}
                  >
                    <span aria-hidden="true">🚪</span>
                    <span>{t('hub_sketch_elevation_opening')}</span>
                  </button>
                )}
                <div className="hub-sketch-elevation-toolbar-title">
                  <strong>{`${t('hub_sketch_wall_panel_title')} ${selectedWall.index + 1}`}</strong>
                  <span className="muted">{`${t('hub_sketch_dim_length_short')}: ${fmtFt(selectedWall.lengthFt)}`}</span>
                </div>
              </>
            }
            toolbarEnd={
              <>
                {renderViewModeToggle(true)}
                <button
                  type="button"
                  className="hub-sketch-elevation-lightbox-close"
                  aria-label={t('lightbox_close')}
                  onClick={closeWallElevationFullscreen}
                >
                  ×
                </button>
              </>
            }
            sidePanel={canEdit ? renderWallElevationFinishControls(true) : null}
          />
        </div>
      )}

      {status && <p className="hub-sketch-ok">{t(status)}</p>}
      {error && <p className="error-msg">{t(error)}</p>}

      {sketchMaterials && (
        <div className="card hub-sketch-materials-result">
          <div className="hub-sketch-materials-head">
            <div>
              <h3>{t('hub_sketch_materials_from_sketch')}</h3>
              <p className="muted">
                {[
                  `${t('hub_sketch_material_fact_paint')} ${sketchMaterials.facts.paintAreaSqft.toFixed(1)} ft²`,
                  `${t('hub_sketch_material_fact_tile')} ${sketchMaterials.facts.tileAreaSqft.toFixed(1)} ft²`,
                  `${t('hub_sketch_material_fact_patch')} ${sketchMaterials.facts.patchAreaSqft.toFixed(1)} ft²`,
                ].join(' · ')}
              </p>
            </div>
            <button
              type="button"
              className="btn small"
              disabled={sketchMaterialsAppendBusy || sketchMaterials.rows.length === 0}
              onClick={appendSketchMaterialsToSpec}
            >
              {sketchMaterialsAppendBusy ? t('saving') : t('hub_sketch_materials_to_spec')}
            </button>
          </div>
          {sketchMaterialsAdded != null && <p className="ok-msg">{`${t('hub_sketch_materials_added_count')}: ${sketchMaterialsAdded}`}</p>}
          {sketchMaterials.rows.length === 0 ? (
            <p className="muted">{t('hub_sketch_materials_empty')}</p>
          ) : (
            <div className="hub-sketch-material-table">
              <div className="hub-sketch-material-table-head">
                <span>{t('mat_col_name')}</span>
                <span>{t('mat_col_qty')}</span>
                <span>{t('mat_col_unit')}</span>
                <span>{t('mat_col_note')}</span>
              </div>
              {SKETCH_MATERIAL_SECTIONS.map((section) => {
                const rows = sketchMaterialRowsBySection(section)
                if (rows.length === 0) return null
                return (
                  <div className="hub-sketch-material-section" key={section}>
                    <h4>{sketchMaterialSectionLabel(section)}</h4>
                    {rows.map((row, index) => (
                      <div className="hub-sketch-material-row" key={`${section}-${row.name}-${index}`}>
                        <span className="hub-sketch-material-name">{row.name}</span>
                        <span>{fmtMaterialQty(row.qty)}</span>
                        <span>{row.unit ?? '—'}</span>
                        <span className="muted">{row.note ?? '—'}</span>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
