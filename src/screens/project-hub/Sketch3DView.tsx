import { useEffect, useMemo, useRef, useState, type ChangeEvent as ReactChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { CATALOG_CATEGORIES, getCatalogItems, getProjectFileDownloadUrl, getProjectHubFiles, mediaUrl, uploadProjectFileToR2 } from '../../lib/api'
import type { CatalogCategory, CatalogItem } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { supabase, SUPABASE_KEY, SUPABASE_URL } from '../../lib/supabase'
import type { Profile, Project, ProjectHubFile } from '../../lib/types'
import {
  DEFAULT_DOOR_HEIGHT_FT,
  DEFAULT_DOOR_WIDTH_FT,
  DEFAULT_DRYWALL_PATCH_COLOR,
  DEFAULT_DRYWALL_PATCH_HEIGHT_FT,
  DEFAULT_DRYWALL_PATCH_WIDTH_FT,
  DEFAULT_FLOOR_PAINT,
  DEFAULT_GROUT_COLOR,
  DEFAULT_GROUT_IN,
  DEFAULT_TILE_COLOR,
  DEFAULT_WALL_PAINT,
  DEFAULT_WINDOW_HEIGHT_FT,
  DEFAULT_WINDOW_SILL_FT,
  DEFAULT_WINDOW_WIDTH_FT,
  DEFAULT_OPENING_WIDTH_FT,
  DEFAULT_OPENING_HEIGHT_FT,
  DEFAULT_OPENING_SILL_FT,
  DEFAULT_WINDOW_TYPE,
  TILE_SIZE_OPTIONS,
  WALL_PAINT_SWATCHES,
  cleanColor,
  createTilePatternCanvas,
  finishCoverageBoundsFt,
  finishCoverageRegionsFt,
  normalizeDrywallPatchSurface,
  normalizeFinishes,
  normalizeTileSurface,
  sketchWallKey,
  type Opening,
  type SketchFinishes,
  type Pt,
  type Sketch3DModel,
  type SketchDrywallPatchFinish,
  type SketchLight,
  type SketchLightKind,
  type SketchMeasurement,
  type SketchMeasurementPoint,
  type SketchPaintFinish,
  type SketchSurfaceFinish,
  type SketchSwitch,
  type SketchTileFinish,
  type WindowType,
} from './sketchFinishes'
import { formatFeetInches, formatInches, parseFeetInches, parseInches, snapOpeningFeetToPrecision } from './inches'
import WallElevation from './WallElevation'
import {
  codeClearanceItemIds,
  formatCodeClearanceIn,
  formatCodeClearanceMessage,
  getCodeClearanceChecks,
  type CodeClearanceCheck,
} from './code-clearances'
import {
  BUILTIN_SHOWER_PAN_CATALOG_ITEMS,
  BUILTIN_SHOWER_PAN_NEO_CATALOG_ID,
  BUILTIN_TOILET_CATALOG_ITEM,
  catalogDimsFromItem,
  catalogDimsText,
  catalogItemHasExactDims,
  catalogItemResolvedDimensionsIn,
  catalogTileFinishPatch,
  catalogTileSizeFromItem,
  createShowerPanPlacedCatalogItem,
  isBuiltinToiletCatalogItem,
  isBuiltinShowerPanCatalogItem,
  isElectricalPlacedCatalogItem,
  isOutletPlacedCatalogItem,
  isPipePlacedCatalogItem,
  isColumnPlacedCatalogItem,
  isFurniturePlacedCatalogItem,
  isShowerPanPlacedCatalogItem,
  isSwitchPlacedCatalogItem,
  isToiletPlacedCatalogItem,
  movePlacedOnCeiling,
  movePlacedOnFloor,
  movePlacedOnWall,
  nearestCatalogWall,
  placedCatalogDoesNotFit,
  placedOnCeiling,
  placedOnFloor,
  placedOnWall,
  resolvePlacedCatalogItem,
  rotatePlacedCatalogItem,
  sanitizePlacedCatalogItems,
  showerPanFootprintPoints,
  showerPanShapeFromCatalogItem,
  showerPanShapeFromPlacedItem,
  SKETCH_CATALOG_KIND_TOILET,
  withShowerPanPlacedCatalogMetadata,
  type CatalogResolvedPlacedItem,
  type CatalogWallHit,
  type SketchFurnitureType,
  type SketchPlacedCatalogItem,
} from './sketchCatalog'
import {
  CABINET_COUNTERTOP_HEIGHT_IN,
  CABINET_TOE_KICK_IN,
  cabinetDisplayCode,
  isCabinetPlacedItem,
  wallCabinetCenterYFt,
} from './cabinetCodes'
import { SHERWIN_WILLIAMS_COLORS } from './sw-colors'
import { DEFAULT_TILE_WASTE_FACTOR, estimateTileLayout, type TileLayoutOpening } from './tileLayout'
import {
  buildSketch3DWallPlan,
  evaluateSketch3DInsideStanding,
  sketch3dFitDistanceForExtents,
  sketch3dFitPad,
  type Sketch3DWallPiece,
} from './sketch3dGeometry'

const CELL_FT = 1
const DEFAULT_WALL_HEIGHT_FT = 8
const WALL_THICKNESS_FT = 0.5
const EIGHTH_IN_FT = 1 / 96
const DEFAULT_SWITCH_HEIGHT_FT = 4
const DEFAULT_SCONCE_HEIGHT_FT = 5.6
const ORBIT_FOV_DEG = 65
const INSIDE_FOV_DEG = 76
const FULLSCREEN_FOV_DEG = 75
const EYE_HEIGHT_FT = 5 + 7 / 12
const INSIDE_BODY_CLEARANCE_FT = 0.5
const INSIDE_WALL_CLEARANCE_FT = WALL_THICKNESS_FT / 2 + INSIDE_BODY_CLEARANCE_FT
const INSIDE_WHEEL_STEP_FT = 2
const INSIDE_MOVE_STEP_FT = 0.18
const INSIDE_LOOK_SENSITIVITY = 0.004
const INSIDE_PITCH_LIMIT_RAD = 1.28
const INSIDE_JOYSTICK_SPEED_FTPS = 4
const SW_COLOR_LIMIT = 48
const PHOTO_RENDER_MIME = 'image/png'
const PHOTO_REFERENCE_MAX_BYTES = 8 * 1024 * 1024

type SurfaceTarget = 'walls' | 'wall' | 'floor'
type OpeningPlacementKind = Opening['kind']
type PlacementKind = SketchLightKind | 'switch' | OpeningPlacementKind | null
type SketchContextMode = 'wall' | 'opening' | 'finish' | 'cabinet' | 'plumbing' | 'light' | 'measure' | 'markup'
type Segment = { c: number; s: number; a: Pt; b: Pt }
type CameraPreset = 'fit' | 'top' | 'angle' | 'inside'
type CameraPresetRequest = { mode: CameraPreset; key: number }
type InteractiveKind = 'light' | 'switch' | 'catalog' | 'opening' | 'measurement'
type InchDraftField = 'tileWIn' | 'tileHIn' | 'groutIn' | 'offsetXIn' | 'offsetYIn'
type FeetDraftField = 'roomHeightFt' | 'coverageBottomFt' | 'coverageHeightFt' | 'patchXFt' | 'patchYFt' | 'patchWidthFt' | 'patchHeightFt'
type OpeningDefaultDraftField = 'doorW' | 'doorH' | 'winW' | 'winH' | 'winSill'
type TileSourceMode = 'manual' | 'catalog'
type Sketch3DModelWithCatalog = Sketch3DModel & { placedItems?: SketchPlacedCatalogItem[] }
type SketchContour = Sketch3DModel['contours'][number]
type InsidePoint = { x: number; z: number }
type InsideVector = { x: number; z: number }
type InsideRectObstacle = { x: number; z: number; halfW: number; halfD: number; rotationY: number }
type InsideStandingResult = { valid: boolean; score: number; normal: InsideVector | null }
type InsideMoveApi = {
  setJoystickVector: (strafe: number, forward: number) => void
  stopJoystick: () => void
}
type PhotoRenderSnapshot = { dataUrl: string; width: number; height: number; blank: boolean }
type PhotoRenderSnapshotApi = { capturePng: () => PhotoRenderSnapshot | null }
type CeilingVisibilityApi = { setVisible: (visible: boolean) => void }
type PhotoRenderFacts = {
  room: Record<string, unknown>
  tile: Record<string, unknown>
  wall_color: Record<string, unknown>
  items: Array<Record<string, unknown>>
  extra: Record<string, unknown>
}
type PhotoRenderErrorCode = 'no_key' | 'gemini_failed' | 'no_session' | 'snapshot_failed' | 'request_failed'
type PhotoRenderReferenceState =
  | {
      source: 'device'
      name: string
      mime: string
      previewUrl: string
      imageB64: string
      file: File
    }
  | {
      source: 'project'
      name: string
      mime: string
      previewUrl: string
      projectFile: ProjectHubFile
    }
type PhotoRenderResolvedReference = {
  source: PhotoRenderReferenceState['source']
  name: string
  mime: string
  imageB64: string
  file?: File
  projectFile?: ProjectHubFile
}
type PhotoRenderModalState =
  | {
      kind: 'success'
      imageB64: string
      mime: string
      sourceImageB64: string
      facts: PhotoRenderFacts
      reference: PhotoRenderResolvedReference | null
      variant: number
      saved: boolean
      saveBusy: boolean
      saveErrorKey?: string
    }
  | { kind: 'error'; messageKey: string }

type Sketch3DOpeningDefaults = {
  doorW: number
  doorH: number
  winW: number
  winH: number
  winSill: number
}

// SKETCH-SNAP-1: панель-тост «Снимок» — снимок ТЕКУЩЕГО ракурса камеры (canvas → PNG, без UI-оверлеев
// и размерных стрелок; механизм снимка общий с «Фото-рендер» — photoSnapshotApiRef.capturePng()).
// Снимок автосохраняется в файлы проекта и предлагает «Скачать» + «Поделиться» (системный share sheet —
// «показать клиенту или команде» одним касанием). Никакой автоотправки почты/сообщений.
type SnapshotPanelState =
  | {
      kind: 'ready'
      dataUrl: string
      fileName: string
      saveBusy: boolean
      saved: boolean
      saveErrorKey?: string
    }
  | { kind: 'error'; messageKey: string }

interface Sketch3DViewProps {
  model: Sketch3DModelWithCatalog
  heightFt: number
  project?: Pick<Project, 'id' | 'name'> | null
  profile?: Profile | null
  sketchName?: string
  canEdit?: boolean
  onModelChange?: (model: Sketch3DModelWithCatalog) => void
  onHeightChange?: (heightFt: number) => void
  snapStepFt?: number
  codeCheckEnabled?: boolean
  onCodeCheckChange?: (enabled: boolean) => void
  // NAV-FIX-2: общий с 2D выбор стены (клик по стене в 3D подсвечивает её и открывает панель «Стена N»).
  pickedWallKey?: string | null
  onPickWall?: (key: string | null) => void
  openingDefaults?: Sketch3DOpeningDefaults
  onOpeningDefaultsChange?: (patch: Partial<Sketch3DOpeningDefaults>) => void
  snapControls?: Array<{ key: string; label: string; active: boolean; onSelect: () => void }>
  contextMode?: SketchContextMode
  cameraPresetRequest?: CameraPresetRequest | null
  fullscreenRequestKey?: number
  viewModeControl?: ReactNode
  label: string
  loadingLabel: string
  errorLabel: string
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function openingWidthFt(o: Sketch3DModel['openings'][number]): number {
  return o.w ?? (o.kind === 'door' ? DEFAULT_DOOR_WIDTH_FT : DEFAULT_WINDOW_WIDTH_FT)
}

function modelCellFt(model: Sketch3DModel): number {
  return Number.isFinite(model.cellFt) && model.cellFt > 0 ? model.cellFt : CELL_FT
}

function openingEnds(model: Sketch3DModel, o: Sketch3DModel['openings'][number]): { a: Pt; b: Pt } | null {
  const c = model.contours[o.c]
  if (!c) return null
  const a = c.points[o.s]
  const b = o.s + 1 < c.points.length ? c.points[o.s + 1] : (c.closed ? c.points[0] : null)
  if (!a || !b) return null
  return { a, b }
}

function eachSegment(model: Sketch3DModel): Segment[] {
  const out: Segment[] = []
  model.contours.forEach((cont, c) => {
    for (let s = 0; s < cont.points.length - 1; s++) out.push({ c, s, a: cont.points[s], b: cont.points[s + 1] })
    if (cont.closed && cont.points.length >= 3) out.push({ c, s: cont.points.length - 1, a: cont.points[cont.points.length - 1], b: cont.points[0] })
  })
  return out
}

function segmentSharedKey(seg: Segment): string {
  const pointKey = (point: Pt) => `${Math.round(point.x * 10000)}:${Math.round(point.y * 10000)}`
  const a = pointKey(seg.a)
  const b = pointKey(seg.b)
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function modelBounds(model: Sketch3DModel): { minX: number; maxX: number; minZ: number; maxZ: number; width: number; depth: number } {
  const cellFt = modelCellFt(model)
  const points = model.contours.flatMap((c) => c.points)
  if (points.length === 0) return { minX: -6, maxX: 6, minZ: -5, maxZ: 5, width: 12, depth: 10 }
  const xs = points.map((p) => p.x * cellFt)
  const zs = points.map((p) => p.y * cellFt)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minZ = Math.min(...zs)
  const maxZ = Math.max(...zs)
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    width: Math.max(maxX - minX, 1),
    depth: Math.max(maxZ - minZ, 1),
  }
}

function contourSignedArea(contour: SketchContour): number {
  if (contour.points.length < 3) return 0
  let sum = 0
  contour.points.forEach((point, index) => {
    const next = contour.points[(index + 1) % contour.points.length]
    sum += point.x * next.y - next.x * point.y
  })
  return sum / 2
}

function largestClosedContour(model: Sketch3DModel): SketchContour | null {
  let best: SketchContour | null = null
  let bestArea = 0
  model.contours.forEach((contour) => {
    if (!contour.closed || contour.points.length < 3) return
    const area = Math.abs(contourSignedArea(contour))
    if (area > bestArea) {
      bestArea = area
      best = contour
    }
  })
  return best
}

function pointInContourWorld(contour: SketchContour, cellFt: number, x: number, z: number): boolean {
  let inside = false
  const points = contour.points
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x * cellFt
    const zi = points[i].y * cellFt
    const xj = points[j].x * cellFt
    const zj = points[j].y * cellFt
    const denom = zj - zi
    const atX = ((xj - xi) * (z - zi)) / (Math.abs(denom) < 0.000001 ? 0.000001 : denom) + xi
    const intersects = ((zi > z) !== (zj > z)) && x < atX
    if (intersects) inside = !inside
  }
  return inside
}

function contourCenterWorld(contour: SketchContour, cellFt: number): { x: number; z: number } {
  const area = contourSignedArea(contour)
  if (Math.abs(area) > 0.000001) {
    let x = 0
    let z = 0
    contour.points.forEach((point, index) => {
      const next = contour.points[(index + 1) % contour.points.length]
      const cross = point.x * next.y - next.x * point.y
      x += (point.x + next.x) * cross
      z += (point.y + next.y) * cross
    })
    const factor = 1 / (6 * area)
    return { x: x * factor * cellFt, z: z * factor * cellFt }
  }
  const sum = contour.points.reduce((acc, point) => ({ x: acc.x + point.x, z: acc.z + point.y }), { x: 0, z: 0 })
  return { x: (sum.x / Math.max(1, contour.points.length)) * cellFt, z: (sum.z / Math.max(1, contour.points.length)) * cellFt }
}

function roomDisplayName(contour: SketchContour | undefined, index: number, roomWord: string): string {
  const label = contour?.label?.trim()
  return label || `${roomWord} ${index + 1}`
}

function roomCenterWorld(model: Sketch3DModel, bounds: { minX: number; maxX: number; minZ: number; maxZ: number; width: number; depth: number }): { x: number; z: number } {
  const cellFt = modelCellFt(model)
  const room = largestClosedContour(model)
  if (room) {
    const center = contourCenterWorld(room, cellFt)
    if (pointInContourWorld(room, cellFt, center.x, center.z)) return center
  }
  return { x: bounds.minX + bounds.width / 2, z: bounds.minZ + bounds.depth / 2 }
}

function normalizeInsideVector(x: number, z: number): InsideVector {
  const len = Math.hypot(x, z)
  return len > 0.000001 ? { x: x / len, z: z / len } : { x: 0, z: 1 }
}

function contourBoundsWorld(contour: SketchContour, cellFt: number) {
  const xs = contour.points.map((point) => point.x * cellFt)
  const zs = contour.points.map((point) => point.y * cellFt)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minZ = Math.min(...zs)
  const maxZ = Math.max(...zs)
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    width: Math.max(0.001, maxX - minX),
    depth: Math.max(0.001, maxZ - minZ),
  }
}

function nearestContourWall(contour: SketchContour, cellFt: number, x: number, z: number): { distance: number; normal: InsideVector } | null {
  if (contour.points.length < 2) return null
  const center = contourCenterWorld(contour, cellFt)
  let best: { distance: number; normal: InsideVector } | null = null
  contour.points.forEach((point, index) => {
    const next = contour.points[(index + 1) % contour.points.length]
    if (!next) return
    const ax = point.x * cellFt
    const az = point.y * cellFt
    const bx = next.x * cellFt
    const bz = next.y * cellFt
    const dx = bx - ax
    const dz = bz - az
    const len2 = dx * dx + dz * dz
    if (len2 <= 0.000001) return
    const t = clampNumber(((x - ax) * dx + (z - az) * dz) / len2, 0, 1)
    const cx = ax + dx * t
    const cz = az + dz * t
    const distance = Math.hypot(x - cx, z - cz)
    let normal = normalizeInsideVector(x - cx, z - cz)
    if (distance <= 0.000001) normal = normalizeInsideVector(center.x - cx, center.z - cz)
    if (!best || distance < best.distance) best = { distance, normal }
  })
  return best
}

function rectLocalPoint(rect: InsideRectObstacle, x: number, z: number): InsidePoint {
  const dx = x - rect.x
  const dz = z - rect.z
  const c = Math.cos(rect.rotationY)
  const s = Math.sin(rect.rotationY)
  return { x: dx * c - dz * s, z: dx * s + dz * c }
}

function rectLocalVectorToWorld(rect: InsideRectObstacle, x: number, z: number): InsideVector {
  const c = Math.cos(rect.rotationY)
  const s = Math.sin(rect.rotationY)
  return normalizeInsideVector(x * c + z * s, -x * s + z * c)
}

function evaluateRectObstacle(rect: InsideRectObstacle, x: number, z: number): InsideStandingResult {
  const local = rectLocalPoint(rect, x, z)
  const absX = Math.abs(local.x)
  const absZ = Math.abs(local.z)
  const outsideX = Math.max(0, absX - rect.halfW)
  const outsideZ = Math.max(0, absZ - rect.halfD)

  if (outsideX > 0 || outsideZ > 0) {
    const distance = Math.hypot(outsideX, outsideZ)
    const score = distance - INSIDE_BODY_CLEARANCE_FT
    const nearestX = clampNumber(local.x, -rect.halfW, rect.halfW)
    const nearestZ = clampNumber(local.z, -rect.halfD, rect.halfD)
    const normal = rectLocalVectorToWorld(rect, local.x - nearestX, local.z - nearestZ)
    return { valid: score >= -0.0001, score, normal }
  }

  const penX = rect.halfW - absX
  const penZ = rect.halfD - absZ
  const normal = penX < penZ
    ? rectLocalVectorToWorld(rect, local.x >= 0 ? 1 : -1, 0)
    : rectLocalVectorToWorld(rect, 0, local.z >= 0 ? 1 : -1)
  return { valid: false, score: -(INSIDE_BODY_CLEARANCE_FT + Math.min(penX, penZ)), normal }
}

function catalogObstacleRect(placed: SketchPlacedCatalogItem, localX: number, localZ: number, widthFt: number, depthFt: number): InsideRectObstacle {
  const c = Math.cos(placed.rotationY)
  const s = Math.sin(placed.rotationY)
  return {
    x: placed.xFt + localX * c + localZ * s,
    z: placed.zFt - localX * s + localZ * c,
    halfW: Math.max(0.02, widthFt / 2),
    halfD: Math.max(0.02, depthFt / 2),
    rotationY: placed.rotationY,
  }
}

function insideCatalogObstacles(items: CatalogResolvedPlacedItem[]): InsideRectObstacle[] {
  const obstacles: InsideRectObstacle[] = []
  items.forEach((resolved) => {
    const placed = resolved.placed
    if (placed.surface === 'ceiling') return
    if (resolved.category === 'light' || resolved.category === 'fan') return

    const width = Math.max(0.04, resolved.dims.widthFt)
    const depth = Math.max(0.04, resolved.dims.depthFt)
    if (resolved.category === 'shower' && placed.surface === 'floor') {
      const rim = Math.max(0.08, Math.min(0.28, Math.min(width, depth) * 0.07))
      obstacles.push(catalogObstacleRect(placed, 0, -depth / 2 + rim / 2, width, rim))
      obstacles.push(catalogObstacleRect(placed, -width / 2 + rim / 2, 0, rim, depth))
      obstacles.push(catalogObstacleRect(placed, width / 2 - rim / 2, 0, rim, depth))
      return
    }

    obstacles.push(catalogObstacleRect(placed, 0, 0, width, depth))
  })
  return obstacles
}

function evaluateInsideStanding(
  model: Sketch3DModel,
  obstacles: InsideRectObstacle[],
  x: number,
  z: number,
): InsideStandingResult {
  let valid = true
  let score = Number.POSITIVE_INFINITY
  let blockingScore = Number.POSITIVE_INFINITY
  let normal: InsideVector | null = null

  const record = (resultValid: boolean, resultScore: number, resultNormal: InsideVector | null) => {
    score = Math.min(score, resultScore)
    if (!resultValid) {
      valid = false
      if (resultScore < blockingScore) {
        blockingScore = resultScore
        normal = resultNormal
      }
    }
  }

  const wallResult = evaluateSketch3DInsideStanding(model, x, z, { wallClearanceFt: INSIDE_WALL_CLEARANCE_FT, roomHeightFt: model.height ?? DEFAULT_WALL_HEIGHT_FT })
  record(wallResult.valid, wallResult.score, wallResult.normal)

  obstacles.forEach((obstacle) => {
    const result = evaluateRectObstacle(obstacle, x, z)
    record(result.valid, result.score, result.normal)
  })

  return { valid, score: Number.isFinite(score) ? score : 100, normal }
}

function findInsideStartWorld(
  model: Sketch3DModel,
  contour: SketchContour | null,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; width: number; depth: number },
  obstacles: InsideRectObstacle[],
): InsidePoint {
  const cellFt = modelCellFt(model)
  if (!contour) return { x: bounds.minX + bounds.width / 2, z: bounds.minZ + bounds.depth / 2 }

  const contourBounds = contourBoundsWorld(contour, cellFt)
  const centroid = contourCenterWorld(contour, cellFt)
  const fallback = pointInContourWorld(contour, cellFt, centroid.x, centroid.z)
    ? centroid
    : { x: contourBounds.minX + contourBounds.width / 2, z: contourBounds.minZ + contourBounds.depth / 2 }
  const fallbackResult = evaluateInsideStanding(model, obstacles, fallback.x, fallback.z)
  let best: { point: InsidePoint; score: number } | null = fallbackResult.valid ? { point: fallback, score: fallbackResult.score } : null
  let bestAny: { point: InsidePoint; score: number } = {
    point: fallback,
    score: fallbackResult.score,
  }

  const consider = (point: InsidePoint) => {
    const result = evaluateInsideStanding(model, obstacles, point.x, point.z)
    if (result.score > bestAny.score) bestAny = { point, score: result.score }
    if (result.valid && (!best || result.score > best.score)) best = { point, score: result.score }
  }

  consider({ x: contourBounds.minX + contourBounds.width / 2, z: contourBounds.minZ + contourBounds.depth / 2 })

  const gridStep = clampNumber(Math.min(contourBounds.width, contourBounds.depth) / 24, 0.25, 2)
  for (let x = contourBounds.minX; x <= contourBounds.maxX + 0.0001; x += gridStep) {
    for (let z = contourBounds.minZ; z <= contourBounds.maxZ + 0.0001; z += gridStep) {
      consider({ x, z })
    }
  }

  if (best) {
    let refineStep = gridStep / 2
    for (let pass = 0; pass < 4; pass++) {
      const base = best.point
      for (let ix = -2; ix <= 2; ix++) {
        for (let iz = -2; iz <= 2; iz++) {
          consider({ x: base.x + ix * refineStep, z: base.z + iz * refineStep })
        }
      }
      refineStep /= 2
    }
    return best.point
  }

  return bestAny.point
}

function insideLongAxisDirection(
  contour: SketchContour | null,
  cellFt: number,
  bounds: { width: number; depth: number },
): InsideVector {
  if (!contour || contour.points.length < 2) return bounds.width >= bounds.depth ? { x: 1, z: 0 } : { x: 0, z: 1 }
  const center = contour.points.reduce(
    (acc, point) => ({ x: acc.x + point.x * cellFt, z: acc.z + point.y * cellFt }),
    { x: 0, z: 0 },
  )
  center.x /= contour.points.length
  center.z /= contour.points.length
  let xx = 0
  let zz = 0
  let xz = 0
  contour.points.forEach((point) => {
    const dx = point.x * cellFt - center.x
    const dz = point.y * cellFt - center.z
    xx += dx * dx
    zz += dz * dz
    xz += dx * dz
  })
  if (Math.abs(xx) + Math.abs(zz) <= 0.000001) return bounds.width >= bounds.depth ? { x: 1, z: 0 } : { x: 0, z: 1 }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz)
  return normalizeInsideVector(Math.cos(angle), Math.sin(angle))
}

function insideRayDistance(
  start: InsidePoint,
  direction: InsideVector,
  model: Sketch3DModel,
  obstacles: InsideRectObstacle[],
  maxDistance: number,
): number {
  const step = 0.25
  for (let distanceFt = step; distanceFt <= maxDistance; distanceFt += step) {
    const x = start.x + direction.x * distanceFt
    const z = start.z + direction.z * distanceFt
    if (!evaluateInsideStanding(model, obstacles, x, z).valid) return Math.max(0, distanceFt - step)
  }
  return maxDistance
}

function insideYawFromDirection(direction: InsideVector): number {
  const normalized = normalizeInsideVector(direction.x, direction.z)
  return Math.atan2(-normalized.x, -normalized.z)
}

function insideStartYaw(
  model: Sketch3DModel,
  contour: SketchContour | null,
  cellFt: number,
  bounds: { width: number; depth: number },
  obstacles: InsideRectObstacle[],
  start: InsidePoint,
): number {
  let axis = insideLongAxisDirection(contour, cellFt, bounds)
  const maxDistance = Math.max(8, bounds.width, bounds.depth)
  const forward = insideRayDistance(start, axis, model, obstacles, maxDistance)
  const backward = insideRayDistance(start, { x: -axis.x, z: -axis.z }, model, obstacles, maxDistance)
  if (backward > forward + 0.25) axis = { x: -axis.x, z: -axis.z }
  return insideYawFromDirection(axis)
}

function segmentWorld(model: Sketch3DModel, c: number, s: number): Segment | null {
  const contour = model.contours[c]
  if (!contour) return null
  const a = contour.points[s]
  const b = s + 1 < contour.points.length ? contour.points[s + 1] : (contour.closed ? contour.points[0] : null)
  if (!a || !b) return null
  return { c, s, a, b }
}

function wallAnchor(model: Sketch3DModel, c: number, s: number, t: number, yFt: number) {
  const seg = segmentWorld(model, c, s)
  if (!seg) return null
  const cellFt = modelCellFt(model)
  const ax = seg.a.x * cellFt
  const az = seg.a.y * cellFt
  const bx = seg.b.x * cellFt
  const bz = seg.b.y * cellFt
  const dx = bx - ax
  const dz = bz - az
  const len = Math.hypot(dx, dz)
  if (len <= 0.01) return null
  const clampedT = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5))
  const ux = dx / len
  const uz = dz / len
  return {
    x: ax + dx * clampedT,
    y: yFt,
    z: az + dz * clampedT,
    ux,
    uz,
    nx: -uz,
    nz: ux,
    rotationY: -Math.atan2(uz, ux),
  }
}

function projectWallT(model: Sketch3DModel, c: number, s: number, point: { x: number; z: number }): number {
  const seg = segmentWorld(model, c, s)
  if (!seg) return 0.5
  const cellFt = modelCellFt(model)
  const ax = seg.a.x * cellFt
  const az = seg.a.y * cellFt
  const bx = seg.b.x * cellFt
  const bz = seg.b.y * cellFt
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  if (len2 <= 0.001) return 0.5
  return Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.z - az) * dz) / len2))
}

function openingInteractiveId(index: number): string {
  return `opening:${index}`
}

function openingIndexFromId(id: string | null): number | null {
  if (!id?.startsWith('opening:')) return null
  const index = Number(id.slice('opening:'.length))
  return Number.isInteger(index) && index >= 0 ? index : null
}

function measurementInteractiveId(index: number): string {
  return `measurement:${index}`
}

function measurementIndexFromId(id: string | null): number | null {
  if (!id?.startsWith('measurement:')) return null
  const index = Number(id.slice('measurement:'.length))
  return Number.isInteger(index) && index >= 0 ? index : null
}

function clampOpeningT(model: Sketch3DModel, opening: Opening, t: number): number {
  const ends = openingEnds(model, opening)
  if (!ends) return Math.max(0, Math.min(1, t))
  const segLenFt = dist(ends.a, ends.b) * modelCellFt(model)
  if (segLenFt <= 0.001) return 0.5
  const widthFt = Math.max(0.1, Math.min(openingWidthFt(opening), segLenFt))
  if (widthFt >= segLenFt - 0.001) return 0.5
  const padT = (widthFt / 2) / segLenFt
  return Math.max(padT, Math.min(1 - padT, t))
}

function snapOpeningT(model: Sketch3DModel, opening: Opening, t: number, stepFt: number): number {
  const seg = segmentWorld(model, opening.c, opening.s)
  if (!seg) return clampOpeningT(model, opening, t)
  const segLenFt = dist(seg.a, seg.b) * modelCellFt(model)
  if (segLenFt <= 0.001) return 0.5
  const step = Math.max(EIGHTH_IN_FT, Number.isFinite(stepFt) && stepFt > 0 ? stepFt : EIGHTH_IN_FT)
  const snappedFt = Math.round((t * segLenFt) / step) * step
  return clampOpeningT(model, opening, snappedFt / segLenFt)
}

function longestWallIn(model: Sketch3DModel): number {
  const cellFt = modelCellFt(model)
  return Math.max(12, ...eachSegment(model).map((seg) => dist(seg.a, seg.b) * cellFt * 12))
}

function segmentLengthFt(model: Sketch3DModel, c: number | undefined, s: number | undefined): number | undefined {
  if (!Number.isInteger(c) || !Number.isInteger(s)) return undefined
  const seg = segmentWorld(model, c ?? 0, s ?? 0)
  return seg ? dist(seg.a, seg.b) * modelCellFt(model) : undefined
}

function formatFeet(valueFt: number): string {
  return formatFeetInches((Number.isFinite(valueFt) ? valueFt : 0) * 12)
}

function formatOpeningFeet(valueFt: number): string {
  return formatInches((Number.isFinite(valueFt) ? valueFt : 0) * 12)
}

function roundFact(value: number, digits = 3): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0
}

function feetFact(valueFt: number): Record<string, unknown> {
  return {
    value_ft: roundFact(valueFt, 4),
    text: formatFeet(valueFt),
  }
}

function inchesFact(valueIn: number): Record<string, unknown> {
  return {
    value_in: roundFact(valueIn, 4),
    text: formatInches(valueIn),
  }
}

function swColorFact(color: string | undefined, fallback: string): Record<string, unknown> {
  const hex = cleanColor(color, fallback)
  const sw = SHERWIN_WILLIAMS_COLORS.find((row) => row.hex.toLowerCase() === hex.toLowerCase())
  return {
    hex,
    code: sw?.code ?? null,
    name: sw?.name ?? null,
  }
}

function coverageFact(surface: SketchSurfaceFinish, wallHeightFt: number): Record<string, unknown> | null {
  if (surface.kind === 'drywall-patch') return null
  const bounds = finishCoverageBoundsFt(surface, wallHeightFt)
  return {
    mode: bounds.full ? 'full' : 'partial',
    bottom: feetFact(bounds.bottomFt),
    top: feetFact(bounds.topFt),
    height: feetFact(bounds.topFt - bounds.bottomFt),
  }
}

function surfaceFinishFact(surface: SketchSurfaceFinish, fallbackPaint: string, wallHeightFt = DEFAULT_WALL_HEIGHT_FT): Record<string, unknown> {
  if (surface.kind === 'tile') {
    const tile = normalizeTileSurface(surface)
    return {
      kind: 'tile',
      source: tile.catalogItemId ? 'catalog' : 'solid_color',
      user_photo: Boolean(tile.catalogPhotoPath),
      catalog_item_id: tile.catalogItemId ?? null,
      catalog_item_name: tile.catalogItemName ?? null,
      photo_url: tile.catalogPhotoPath ?? null,
      tile_size: {
        width: inchesFact(tile.tileWIn ?? 12),
        height: inchesFact(tile.tileHIn ?? 24),
      },
      grout: {
        width: inchesFact(tile.groutIn ?? DEFAULT_GROUT_IN),
        color: cleanColor(tile.groutColor, DEFAULT_GROUT_COLOR),
      },
      tile_color: cleanColor(tile.tileColor, DEFAULT_TILE_COLOR),
      offset: {
        x: inchesFact(tile.offsetXIn ?? 0),
        y: inchesFact(tile.offsetYIn ?? 0),
      },
      coverage: coverageFact(tile, wallHeightFt),
    }
  }

  if (surface.kind === 'drywall-patch') {
    const patch = normalizeDrywallPatchSurface(surface)
    return {
      kind: 'drywall-patch',
      base_color: swColorFact(patch.baseColor, DEFAULT_WALL_PAINT),
      patch_color: cleanColor(patch.patchColor, DEFAULT_DRYWALL_PATCH_COLOR),
      x: feetFact(patch.xFt ?? 0),
      y: feetFact(patch.yFt ?? 0),
      width: feetFact(patch.widthFt ?? DEFAULT_DRYWALL_PATCH_WIDTH_FT),
      height: feetFact(patch.heightFt ?? DEFAULT_DRYWALL_PATCH_HEIGHT_FT),
    }
  }

  return {
    kind: 'paint',
    color: swColorFact(surface.color, fallbackPaint),
    coverage: coverageFact(surface, wallHeightFt),
  }
}

function tileSurfaceFact(surface: SketchSurfaceFinish, wallHeightFt = DEFAULT_WALL_HEIGHT_FT): Record<string, unknown> | null {
  return surface.kind === 'tile' ? surfaceFinishFact(surface, DEFAULT_WALL_PAINT, wallHeightFt) : null
}

function contourPerimeterFt(contour: SketchContour, cellFt: number): number {
  let total = 0
  for (let i = 1; i < contour.points.length; i++) total += dist(contour.points[i - 1], contour.points[i]) * cellFt
  if (contour.closed && contour.points.length >= 3) total += dist(contour.points[contour.points.length - 1], contour.points[0]) * cellFt
  return total
}

function contourAreaFt(contour: SketchContour, cellFt: number): number {
  return contour.closed && contour.points.length >= 3 ? Math.abs(contourSignedArea(contour)) * cellFt * cellFt : 0
}

function openingHeightFt(o: Sketch3DModel['openings'][number], roomHeightFt: number): number {
  const raw = o.kind === 'door' ? (o.h ?? DEFAULT_DOOR_HEIGHT_FT) : (o.h ?? DEFAULT_WINDOW_HEIGHT_FT)
  return Math.max(0.2, Math.min(raw, Math.max(0.2, roomHeightFt)))
}

function openingSillFt(o: Sketch3DModel['openings'][number], roomHeightFt: number): number {
  if (o.kind === 'door') return 0
  const height = openingHeightFt(o, roomHeightFt)
  return Math.max(0, Math.min(o.sill ?? DEFAULT_WINDOW_SILL_FT, Math.max(0, roomHeightFt - height)))
}

type OpeningMetrics = {
  centerX: number
  centerZ: number
  ux: number
  uz: number
  nx: number
  nz: number
  rotationY: number
  width: number
  height: number
  sill: number
  wallLength: number
  left: number
  right: number
  edgeA: { x: number; z: number }
  edgeB: { x: number; z: number }
  wallA: { x: number; z: number }
  wallB: { x: number; z: number }
}

function openingMetrics(model: Sketch3DModel, opening: Opening, roomHeightFt: number): OpeningMetrics | null {
  const ends = openingEnds(model, opening)
  if (!ends) return null
  const cellFt = modelCellFt(model)
  const wallA = { x: ends.a.x * cellFt, z: ends.a.y * cellFt }
  const wallB = { x: ends.b.x * cellFt, z: ends.b.y * cellFt }
  const dx = wallB.x - wallA.x
  const dz = wallB.z - wallA.z
  const wallLength = Math.hypot(dx, dz)
  if (wallLength <= 0.01) return null
  const ux = dx / wallLength
  const uz = dz / wallLength
  const width = Math.max(0.2, Math.min(openingWidthFt(opening), wallLength))
  const height = openingHeightFt(opening, roomHeightFt)
  const sill = openingSillFt(opening, roomHeightFt)
  const clampedT = clampOpeningT(model, opening, opening.t)
  const centerDistance = clampedT * wallLength
  const centerX = wallA.x + ux * centerDistance
  const centerZ = wallA.z + uz * centerDistance
  let nx = -uz
  let nz = ux
  const contour = model.contours[opening.c]
  if (contour?.points.length) {
    const contourCenter = contourCenterWorld(contour, cellFt)
    const midX = (wallA.x + wallB.x) / 2
    const midZ = (wallA.z + wallB.z) / 2
    if ((contourCenter.x - midX) * nx + (contourCenter.z - midZ) * nz > 0) {
      nx *= -1
      nz *= -1
    }
  }
  const half = width / 2
  return {
    centerX,
    centerZ,
    ux,
    uz,
    nx,
    nz,
    rotationY: -Math.atan2(uz, ux),
    width,
    height,
    sill,
    wallLength,
    left: Math.max(0, centerDistance - half),
    right: Math.max(0, wallLength - centerDistance - half),
    edgeA: { x: centerX - ux * half, z: centerZ - uz * half },
    edgeB: { x: centerX + ux * half, z: centerZ + uz * half },
    wallA,
    wallB,
  }
}

function openingName(opening: Opening, index: number, t: (k: string) => string): string {
  const key = opening.kind === 'door' ? 'hub_sketch_tool_door' : opening.kind === 'window' ? 'hub_sketch_tool_window' : 'hub_sketch_mode_opening'
  return `${t(key)} ${index + 1}`
}

function openingDimensionText(opening: Opening, metrics: OpeningMetrics, t: (k: string) => string): string {
  const size = `${t('hub_sketch_dim_size_short')} ${formatOpeningFeet(metrics.width)} x ${formatOpeningFeet(metrics.height)}`
  return opening.kind === 'door' ? size : `${size}\n${t('hub_sketch_dim_floor_short')} ${formatOpeningFeet(metrics.sill)}`
}

function safeRenderSlug(value: string | undefined, fallback: string): string {
  const clean = (value ?? '').trim().toLowerCase().replace(/[^a-z0-9а-я\-_]+/gi, '-').replace(/^-+|-+$/g, '')
  return clean || fallback
}

function renderPhotoFileName(baseName: string, variant: number): string {
  return `render-${baseName}-${Math.max(1, variant)}.png`
}

function renderSourcePhotoFileName(baseName: string, variant: number): string {
  return `render-source-${baseName}-${Math.max(1, variant)}.png`
}

function imageExtension(name: string | undefined, mime: string | undefined): string {
  const byName = (name ?? '').trim().toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1]
  if (byName && ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'].includes(byName)) return byName
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  return 'jpg'
}

function renderReferenceFileName(baseName: string, variant: number, originalName: string | undefined, mime: string | undefined): string {
  const stem = (originalName ?? '').replace(/\.[^.]+$/, '')
  const originalSlug = safeRenderSlug(stem, 'reference')
  return `render-reference-${baseName}-${Math.max(1, variant)}-${originalSlug}.${imageExtension(originalName, mime)}`
}

// SKETCH-SNAP-1: имя PNG-снимка текущего ракурса 3D-вида (закон Андрея — «фото экрана одним кликом»).
// Оригинал эскиза не трогаем: это отдельный файл проекта snapshot-<эскиз/проект>-<n>.png.
function snapshotFileName(baseName: string, index: number): string {
  return `snapshot-${baseName}-${Math.max(1, index)}.png`
}

export function stripImageDataUrlPrefix(value: string): string {
  const comma = value.indexOf(',')
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value
}

function photoImageSrc(imageB64: string, mime: string): string {
  if (imageB64.startsWith('data:')) return imageB64
  return `data:${mime || PHOTO_RENDER_MIME};base64,${imageB64}`
}

function imageFileLike(file: Pick<ProjectHubFile, 'mime' | 'name'>): boolean {
  if (file.mime?.startsWith('image/')) return true
  return /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(file.name)
}

function projectHubImageUrl(file: ProjectHubFile): Promise<string | null> {
  return file.scope === 'project' ? getProjectFileDownloadUrl(file) : mediaUrl(file.storage_path)
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('empty image data'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('image read failed'))
    reader.readAsDataURL(blob)
  })
}

async function dataUrlToFile(dataUrl: string, name: string, mime: string): Promise<File> {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return new File([blob], name, { type: mime || PHOTO_RENDER_MIME })
}

class PhotoRenderRequestError extends Error {
  readonly code: PhotoRenderErrorCode
  readonly status?: number

  constructor(code: PhotoRenderErrorCode, status?: number) {
    super(code)
    this.code = code
    this.status = status
  }
}

async function readRenderErrorText(response: Response): Promise<string | undefined> {
  try {
    const body = await response.clone().json()
    const raw = (body as { error?: unknown; message?: unknown } | null)?.error ?? (body as { message?: unknown } | null)?.message
    return typeof raw === 'string' && raw.trim() ? raw : undefined
  } catch {
    try {
      const text = await response.text()
      return text.trim() ? text : undefined
    } catch {
      return undefined
    }
  }
}

async function callRenderPhoto(imageB64: string, facts: PhotoRenderFacts, referenceB64?: string): Promise<{ imageB64: string; mime: string }> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new PhotoRenderRequestError('no_session')

  const payload: { image_b64: string; facts: PhotoRenderFacts; reference_b64?: string } = { image_b64: imageB64, facts }
  if (referenceB64) payload.reference_b64 = referenceB64

  const response = await fetch(`${SUPABASE_URL}/functions/v1/render-photo`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    await readRenderErrorText(response)
    if (response.status === 503) throw new PhotoRenderRequestError('no_key', response.status)
    if (response.status === 502) throw new PhotoRenderRequestError('gemini_failed', response.status)
    throw new PhotoRenderRequestError('request_failed', response.status)
  }

  const body = await response.json() as { image_b64?: unknown; mime?: unknown }
  const outB64 = typeof body.image_b64 === 'string' ? body.image_b64 : ''
  if (!outB64) throw new PhotoRenderRequestError('request_failed')
  const mime = typeof body.mime === 'string' && body.mime.startsWith('image/') ? body.mime : PHOTO_RENDER_MIME
  return { imageB64: outB64, mime }
}

function photoRenderErrorKey(error: unknown): string {
  const code = error instanceof PhotoRenderRequestError ? error.code : 'request_failed'
  if (code === 'no_key') return 'hub_sketch_photo_render_no_key'
  if (code === 'gemini_failed') return 'hub_sketch_photo_render_gemini_failed'
  if (code === 'no_session') return 'hub_sketch_photo_render_no_session'
  if (code === 'snapshot_failed') return 'hub_sketch_photo_render_snapshot_failed'
  return 'hub_sketch_photo_render_failed'
}

function canvasLooksBlank(renderer: any): boolean {
  const canvas = renderer.domElement as HTMLCanvasElement | undefined
  const gl = typeof renderer.getContext === 'function'
    ? renderer.getContext() as WebGLRenderingContext | WebGL2RenderingContext | null
    : null
  if (!canvas || !gl || canvas.width <= 0 || canvas.height <= 0) return true

  const samples = [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ]
  const pixel = new Uint8Array(4)
  let visible = false
  let nonBlack = false
  try {
    samples.forEach(([sx, sy]) => {
      const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(canvas.width * sx)))
      const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(canvas.height * sy)))
      gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      if (pixel[3] > 0) visible = true
      if (pixel[3] > 0 && (pixel[0] > 8 || pixel[1] > 8 || pixel[2] > 8)) nonBlack = true
    })
  } catch {
    return false
  }
  return !visible || !nonBlack
}

export function buildPhotoRenderFacts(
  model: Sketch3DModelWithCatalog,
  heightFt: number,
  finishes: Required<SketchFinishes>,
  resolvedItems: CatalogResolvedPlacedItem[],
  cameraMode: CameraPreset,
  sketchName?: string,
  projectName?: string,
): PhotoRenderFacts {
  const cellFt = modelCellFt(model)
  const bounds = modelBounds(model)
  const height = Number.isFinite(heightFt) && heightFt > 0 ? heightFt : DEFAULT_WALL_HEIGHT_FT
  const segments = eachSegment(model)
  const wallFacts = segments.map((seg, index) => {
    const key = sketchWallKey(seg.c, seg.s)
    const override = finishes.wallFinishes[key]
    const finish = override ?? finishes.walls
    const lengthFt = dist(seg.a, seg.b) * cellFt
    return {
      key,
      label: `Wall ${index + 1}`,
      contour: seg.c,
      segment: seg.s,
      length: feetFact(lengthFt),
      finish: surfaceFinishFact(finish, finishes.wallPaint, height),
      overrides_default: Boolean(override),
    }
  })
  const wallPaintOverrides = wallFacts
    .filter((wall) => {
      const finish = (wall.finish as { kind?: unknown }).kind
      return finish === 'paint' && wall.overrides_default
    })
    .map((wall) => ({
      key: wall.key,
      label: wall.label,
      color: (wall.finish as { color?: unknown }).color ?? null,
    }))
  const wallTileOverrides = wallFacts
    .filter((wall) => (wall.finish as { kind?: unknown }).kind === 'tile' && wall.overrides_default)
    .map((wall) => ({
      key: wall.key,
      label: wall.label,
      tile: wall.finish,
    }))
  const panTileSurfaces = resolvedItems
    .map((resolved) => resolved.placed.panFinish)
    .filter((surface): surface is SketchTileFinish => surface?.kind === 'tile')
  const tilePhotoUsed = [
    finishes.floor,
    finishes.walls,
    ...Object.values(finishes.wallFinishes),
    ...panTileSurfaces,
  ].some((surface) => surface.kind === 'tile' && Boolean(normalizeTileSurface(surface).catalogPhotoPath))

  return {
    room: {
      width: feetFact(bounds.width),
      depth: feetFact(bounds.depth),
      height: feetFact(height),
      area_ft2: roundFact(model.contours.reduce((sum, contour) => sum + contourAreaFt(contour, cellFt), 0), 2),
      perimeter: feetFact(model.contours.reduce((sum, contour) => sum + contourPerimeterFt(contour, cellFt), 0)),
      wall_count: segments.length,
      contour_count: model.contours.length,
    },
    tile: {
      floor: tileSurfaceFact(finishes.floor, height),
      walls_default: tileSurfaceFact(finishes.walls, height),
      per_wall: wallTileOverrides,
      user_photo: tilePhotoUsed,
    },
    wall_color: {
      default: finishes.walls.kind === 'paint'
        ? swColorFact(finishes.walls.color, finishes.wallPaint)
        : finishes.walls.kind === 'drywall-patch'
          ? swColorFact(finishes.walls.baseColor, DEFAULT_WALL_PAINT)
        : swColorFact(finishes.wallPaint, DEFAULT_WALL_PAINT),
      per_wall: wallPaintOverrides,
    },
    items: resolvedItems.map((resolved) => ({
      id: resolved.placed.id,
      catalog_item_id: resolved.placed.catalogItemId,
      name: resolved.name,
      category: resolved.category,
      brand: resolved.brand,
      model: resolved.model,
      code: resolved.placed.code ?? resolved.model,
      wall_id: resolved.placed.wallId ?? null,
      layer: resolved.placed.layer ?? null,
      hinge: resolved.placed.hinge ?? null,
      filler: resolved.placed.filler === true,
      panel: resolved.placed.panel === true,
      layout_warning: resolved.placed.layoutWarning ?? null,
      surface: resolved.placed.surface,
      dimensions: {
        width: inchesFact(resolved.widthIn),
        depth: inchesFact(resolved.depthIn),
        height: inchesFact(resolved.heightIn),
      },
      pan_finish: resolved.placed.panFinish ? surfaceFinishFact(resolved.placed.panFinish, DEFAULT_FLOOR_PAINT, resolved.dims.heightFt) : null,
      position_ft: {
        x: roundFact(resolved.placed.xFt, 4),
        // CABINETS-VERTICAL-22: навесной ставим по зазору wallGapIn (иначе yFt/дефолт 18").
        y: roundFact(
          isCabinetPlacedItem(resolved.placed) && resolved.placed.layer === 'wall'
            ? wallCabinetCenterYFt(resolved.placed, resolved.heightIn)
            : resolved.placed.yFt,
          4,
        ),
        z: roundFact(resolved.placed.zFt, 4),
      },
      rotation_deg: roundFact((resolved.placed.rotationY * 180) / Math.PI, 2),
      photo_url: resolved.photoPath,
      specs: resolved.specs ?? {},
      missing_catalog_item: resolved.missingCatalogItem,
    })),
    extra: {
      sketch_name: sketchName?.trim() || null,
      project_name: projectName?.trim() || null,
      camera_mode: cameraMode,
      cell_ft: cellFt,
      dimensions_hidden_for_capture: true,
      floor_finish: surfaceFinishFact(finishes.floor, DEFAULT_FLOOR_PAINT, height),
      wall_finishes: wallFacts,
      openings: model.openings.map((opening, index) => ({
        index,
        kind: opening.kind,
        contour: opening.c,
        segment: opening.s,
        t: roundFact(opening.t, 4),
        width: feetFact(openingWidthFt(opening)),
        height: feetFact(openingHeightFt(opening, height)),
        sill: feetFact(openingSillFt(opening, height)),
      })),
      lights: (model.lights ?? []).map((light) => ({
        id: light.id,
        kind: light.kind,
        name: light.name ?? null,
        position_ft: {
          x: Number.isFinite(light.xFt) ? roundFact(light.xFt ?? 0, 4) : null,
          z: Number.isFinite(light.zFt) ? roundFact(light.zFt ?? 0, 4) : null,
        },
        wall: Number.isInteger(light.c) && Number.isInteger(light.s) ? { contour: light.c, segment: light.s, t: light.t ?? 0.5 } : null,
        height: light.heightFt !== undefined ? feetFact(light.heightFt) : null,
      })),
      switches: (model.switches ?? []).map((sw) => ({
        id: sw.id,
        label: sw.label ?? null,
        wall: { contour: sw.c, segment: sw.s, t: sw.t },
        height: sw.heightFt !== undefined ? feetFact(sw.heightFt) : null,
        controls: sw.controls ?? [],
      })),
    },
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function disposeObjectWithMaterial(object: { geometry?: unknown; material?: unknown }) {
  const geometry = object.geometry
  if (geometry && typeof geometry === 'object' && 'dispose' in geometry) {
    ;(geometry as { dispose: () => void }).dispose()
  }
  const disposeTexture = (texture: unknown) => {
    if (texture && typeof texture === 'object' && 'dispose' in texture) {
      ;(texture as { dispose: () => void }).dispose()
    }
  }
  const disposeMaterial = (material: unknown) => {
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial)
      return
    }
    if (material && typeof material === 'object') {
      disposeTexture((material as { map?: unknown }).map)
      disposeTexture((material as { emissiveMap?: unknown }).emissiveMap)
      if ('dispose' in material) (material as { dispose: () => void }).dispose()
    }
  }
  disposeMaterial(object.material)
}

function loadThreeRuntime(): Promise<[any, { OrbitControls: any }]> {
  return Promise.all([
    // @ts-expect-error three is intentionally pinned without adding @types/three.
    import('three'),
    // @ts-expect-error OrbitControls is loaded only with the 3D view.
    import('three/examples/jsm/controls/OrbitControls.js'),
  ])
}

function makeId(prefix: string): string {
  const maybeCrypto = typeof crypto !== 'undefined' ? crypto : undefined
  const uuid = maybeCrypto && 'randomUUID' in maybeCrypto ? maybeCrypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${uuid}`
}

function tilePitch(surface: SketchSurfaceFinish | undefined): { x: number; y: number; tile: SketchTileFinish } {
  const tile = normalizeTileSurface(surface)
  return {
    x: Math.max(0.01, (tile.tileWIn ?? 12) + (tile.groutIn ?? DEFAULT_GROUT_IN)),
    y: Math.max(0.01, (tile.tileHIn ?? 24) + (tile.groutIn ?? DEFAULT_GROUT_IN)),
    tile,
  }
}

function drawCatalogTilePhotoCanvas(canvas: HTMLCanvasElement, surface: SketchSurfaceFinish | undefined, image: CanvasImageSource): boolean {
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  const tile = normalizeTileSurface(surface)
  const tileW = Math.max(0.01, tile.tileWIn ?? 12)
  const tileH = Math.max(0.01, tile.tileHIn ?? 24)
  const grout = Math.max(0, tile.groutIn ?? DEFAULT_GROUT_IN)
  const pitchW = tileW + grout
  const pitchH = tileH + grout
  const pad = 1
  const w = Math.max(1, Math.round((tileW / pitchW) * canvas.width) - pad)
  const h = Math.max(1, Math.round((tileH / pitchH) * canvas.height) - pad)
  const source = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number }
  const sourceW = source.naturalWidth ?? source.videoWidth ?? source.width ?? 0
  const sourceH = source.naturalHeight ?? source.videoHeight ?? source.height ?? 0
  if (!Number.isFinite(sourceW) || !Number.isFinite(sourceH) || sourceW <= 0 || sourceH <= 0) return false
  const scale = Math.max(w / sourceW, h / sourceH)
  const cropW = w / scale
  const cropH = h / scale
  const sx = Math.max(0, (sourceW - cropW) / 2)
  const sy = Math.max(0, (sourceH - cropH) / 2)
  ctx.fillStyle = cleanColor(tile.groutColor, DEFAULT_GROUT_COLOR)
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(image, sx, sy, cropW, cropH, 0, 0, w, h)
  ctx.strokeStyle = 'rgba(255,255,255,.2)'
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, Math.max(1, w - 2), Math.max(1, h - 2))
  return true
}

function createTileTexture(
  THREE: any,
  surface: SketchSurfaceFinish | undefined,
  textureLoader?: any,
  maxAnisotropy = 4,
  onTextureReady?: () => void,
) {
  const canvas = createTilePatternCanvas(surface)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.max(1, maxAnisotropy)
  const tile = normalizeTileSurface(surface)
  if (tile.catalogPhotoPath && textureLoader) {
    textureLoader.load(
      tile.catalogPhotoPath,
      (loadedTexture: any) => {
        const image = loadedTexture?.image as CanvasImageSource | undefined
        if (image && drawCatalogTilePhotoCanvas(canvas, surface, image)) texture.needsUpdate = true
        loadedTexture?.dispose?.()
        onTextureReady?.()
      },
      undefined,
      () => onTextureReady?.(),
    )
  }
  return texture
}

function wallBaseColor(surface: SketchSurfaceFinish, fallbackPaint = DEFAULT_WALL_PAINT): string {
  if (surface.kind === 'paint') return cleanColor(surface.color, fallbackPaint)
  if (surface.kind === 'drywall-patch') return cleanColor(surface.baseColor, DEFAULT_WALL_PAINT)
  return fallbackPaint
}

function createWallMaterial(
  THREE: any,
  surface: SketchSurfaceFinish,
  widthFt: number,
  heightFt: number,
  fallbackPaint = DEFAULT_WALL_PAINT,
  textureLoader?: any,
  maxAnisotropy = 4,
  onTextureReady?: () => void,
) {
  const coverage = finishCoverageBoundsFt(surface, heightFt)
  if (surface.kind !== 'tile' || !coverage.full) {
    const color = surface.kind === 'paint' && !coverage.full ? fallbackPaint : wallBaseColor(surface, fallbackPaint)
    return new THREE.MeshStandardMaterial({ color, roughness: 0.72 })
  }
  const texture = createTileTexture(THREE, surface, textureLoader, maxAnisotropy, onTextureReady)
  const { x, y, tile } = tilePitch(surface)
  texture.repeat.set((widthFt * 12) / x, (heightFt * 12) / y)
  texture.offset.set((tile.offsetXIn ?? 0) / x, (tile.offsetYIn ?? 0) / y)
  return new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: 0.78 })
}

function createWallOverlayMaterial(
  THREE: any,
  surface: SketchSurfaceFinish,
  widthFt: number,
  heightFt: number,
  fallbackPaint = DEFAULT_WALL_PAINT,
  textureLoader?: any,
  maxAnisotropy = 4,
  onTextureReady?: () => void,
) {
  if (surface.kind === 'tile') return createWallMaterial(THREE, { ...surface, coverage: { mode: 'full' } }, widthFt, heightFt, fallbackPaint, textureLoader, maxAnisotropy, onTextureReady)
  if (surface.kind === 'drywall-patch') {
    return new THREE.MeshStandardMaterial({
      color: cleanColor(surface.patchColor, DEFAULT_DRYWALL_PATCH_COLOR),
      roughness: 0.86,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    })
  }
  return new THREE.MeshStandardMaterial({
    color: cleanColor(surface.color, fallbackPaint),
    roughness: 0.72,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  })
}

function addWallFinishOverlay(
  THREE: any,
  wall: any,
  surface: SketchSurfaceFinish,
  wallWidthFt: number,
  wallHeightFt: number,
  fallbackPaint = DEFAULT_WALL_PAINT,
  textureLoader?: any,
  maxAnisotropy = 4,
  onTextureReady?: () => void,
) {
  if (surface.kind === 'drywall-patch') {
    const patch = normalizeDrywallPatchSurface(surface)
    const width = Math.max(0.02, Math.min(wallWidthFt, patch.widthFt ?? DEFAULT_DRYWALL_PATCH_WIDTH_FT))
    const height = Math.max(0.02, Math.min(wallHeightFt, patch.heightFt ?? DEFAULT_DRYWALL_PATCH_HEIGHT_FT))
    const x = Math.max(0, Math.min(wallWidthFt - width, patch.xFt ?? 0))
    const y = Math.max(0, Math.min(wallHeightFt - height, patch.yFt ?? 0))
    const panel = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.018), createWallOverlayMaterial(THREE, patch, width, height, fallbackPaint, textureLoader, maxAnisotropy, onTextureReady))
    panel.position.set(-wallWidthFt / 2 + x + width / 2, y + height / 2 - wallHeightFt / 2, WALL_THICKNESS_FT / 2 + 0.014)
    panel.renderOrder = 4
    wall.add(panel)
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(panel.geometry),
      new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.58 }),
    )
    edges.position.copy(panel.position)
    edges.renderOrder = 5
    wall.add(edges)
    return
  }

  const coverage = finishCoverageBoundsFt(surface, wallHeightFt)
  if (coverage.full) return
  const height = Math.max(0.02, coverage.topFt - coverage.bottomFt)
  const panel = new THREE.Mesh(new THREE.BoxGeometry(wallWidthFt, height, 0.018), createWallOverlayMaterial(THREE, surface, wallWidthFt, height, fallbackPaint, textureLoader, maxAnisotropy, onTextureReady))
  panel.position.set(0, coverage.bottomFt + height / 2 - wallHeightFt / 2, WALL_THICKNESS_FT / 2 + 0.014)
  panel.renderOrder = 4
  wall.add(panel)
}

function addWallPieceFinishOverlay(
  THREE: any,
  pieceMesh: any,
  surface: SketchSurfaceFinish,
  wallLengthFt: number,
  wallHeightFt: number,
  piece: Sketch3DWallPiece,
  fallbackPaint = DEFAULT_WALL_PAINT,
  textureLoader?: any,
  maxAnisotropy = 4,
  onTextureReady?: () => void,
) {
  if (surface.kind !== 'drywall-patch' && surface.coverage?.mode !== 'partial') return
  const pieceWidth = Math.max(0.001, piece.endFt - piece.startFt)
  const pieceHeight = Math.max(0.001, piece.topFt - piece.bottomFt)
  finishCoverageRegionsFt(surface, wallLengthFt, wallHeightFt).forEach((region) => {
    const x0 = Math.max(piece.startFt, region.x0Ft)
    const x1 = Math.min(piece.endFt, region.x1Ft)
    const y0 = Math.max(piece.bottomFt, region.y0Ft)
    const y1 = Math.min(piece.topFt, region.y1Ft)
    const width = x1 - x0
    const height = y1 - y0
    if (width <= 0.02 || height <= 0.02) return
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, 0.018),
      createWallOverlayMaterial(THREE, surface, width, height, fallbackPaint, textureLoader, maxAnisotropy, onTextureReady),
    )
    panel.position.set(
      x0 - piece.startFt + width / 2 - pieceWidth / 2,
      y0 - piece.bottomFt + height / 2 - pieceHeight / 2,
      WALL_THICKNESS_FT / 2 + 0.014,
    )
    panel.renderOrder = 4
    pieceMesh.add(panel)
    if (surface.kind === 'drywall-patch') {
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(panel.geometry),
        new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.58 }),
      )
      edges.position.copy(panel.position)
      edges.renderOrder = 5
      pieceMesh.add(edges)
    }
  })
}

function createFloorMaterial(THREE: any, surface: SketchSurfaceFinish, textureLoader?: any, maxAnisotropy = 4, onTextureReady?: () => void) {
  if (surface.kind !== 'tile') {
    const color = surface.kind === 'drywall-patch' ? cleanColor(surface.baseColor, DEFAULT_FLOOR_PAINT) : cleanColor(surface.color, DEFAULT_FLOOR_PAINT)
    return new THREE.MeshStandardMaterial({ color, roughness: 0.82, side: THREE.DoubleSide })
  }
  const texture = createTileTexture(THREE, surface, textureLoader, maxAnisotropy, onTextureReady)
  return new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: 0.82, side: THREE.DoubleSide })
}

function createPanTileMaterial(THREE: any, surface: SketchTileFinish, widthFt: number, depthFt: number, textureLoader?: any, maxAnisotropy = 4, onTextureReady?: () => void) {
  const texture = createTileTexture(THREE, surface, textureLoader, maxAnisotropy, onTextureReady)
  const { x, y, tile } = tilePitch(surface)
  texture.repeat.set(Math.max(1, (widthFt * 12) / x), Math.max(1, (depthFt * 12) / y))
  texture.offset.set((tile.offsetXIn ?? 0) / x, (tile.offsetYIn ?? 0) / y)
  return new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: 0.76, metalness: 0.01 })
}

function applyFloorTileUv(geometry: any, surface: SketchSurfaceFinish) {
  if (surface.kind !== 'tile' || !geometry.attributes?.position || !geometry.attributes?.uv) return
  const { x, y, tile } = tilePitch(surface)
  const pos = geometry.attributes.position
  const uv = geometry.attributes.uv
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, ((pos.getX(i) * 12) + (tile.offsetXIn ?? 0)) / x, ((pos.getY(i) * 12) + (tile.offsetYIn ?? 0)) / y)
  }
  uv.needsUpdate = true
}

function tagInteractive(object: any, type: InteractiveKind, id: string) {
  object.traverse?.((child: any) => {
    child.userData.itemType = type
    child.userData.itemId = id
  })
  object.userData.itemType = type
  object.userData.itemId = id
}

function taggedObject(object: any): { type: InteractiveKind; id: string } | null {
  let cur = object
  while (cur) {
    if (
      (
        cur.userData?.itemType === 'light'
        || cur.userData?.itemType === 'switch'
        || cur.userData?.itemType === 'catalog'
        || cur.userData?.itemType === 'opening'
        || cur.userData?.itemType === 'measurement'
      )
      && typeof cur.userData?.itemId === 'string'
    ) {
      return { type: cur.userData.itemType, id: cur.userData.itemId }
    }
    cur = cur.parent
  }
  return null
}

function taggedWall(object: any): { c: number; s: number } | null {
  let cur = object
  while (cur) {
    if (Number.isInteger(cur.userData?.wallC) && Number.isInteger(cur.userData?.wallS)) {
      return { c: cur.userData.wallC, s: cur.userData.wallS }
    }
    cur = cur.parent
  }
  return null
}

function lightKindLabel(t: (k: string) => string, kind: SketchLightKind): string {
  return t(`hub_sketch_3d_light_${kind}`)
}

function lightName(light: SketchLight, index: number, t: (k: string) => string): string {
  return light.name?.trim() || `${lightKindLabel(t, light.kind)} ${index + 1}`
}

function switchName(sw: SketchSwitch, index: number, t: (k: string) => string): string {
  return sw.label?.trim() || `${t('hub_sketch_3d_switch')} ${index + 1}`
}

function electricalPlacedName(item: SketchPlacedCatalogItem, t: (k: string) => string): string {
  if (item.name?.trim()) return item.name.trim()
  return isOutletPlacedCatalogItem(item) ? t('hub_sketch_outlet') : t('hub_sketch_switch')
}

function catalogCategoryLabelKey(category: CatalogCategory): string {
  return `catalog_cat_${category}`
}

function catalogItemDimsText(item: CatalogItem): string | null {
  const dims = catalogItemResolvedDimensionsIn(item)
  if (!dims) return null
  return catalogDimsText(dims.widthIn, dims.depthIn, dims.heightIn)
}

function catalogTileDimsText(item: CatalogItem): string | null {
  const size = catalogTileSizeFromItem(item)
  if (!size) return null
  return `${formatInches(size.tileWIn)}×${formatInches(size.tileHIn)}`
}

function resolvedCatalogDimsText(item: CatalogResolvedPlacedItem): string {
  return catalogDimsText(item.widthIn, item.depthIn, item.heightIn)
}

function catalogBrandModel(brand: string | null | undefined, model: string | null | undefined): string | null {
  const text = [brand, model].filter(Boolean).join(' · ')
  return text || null
}

function catalogSpecsEntries(specs: CatalogResolvedPlacedItem['specs']): Array<[string, string]> {
  return Object.entries(specs ?? {})
    .filter(([key]) => key.trim())
    .map(([key, value]) => [key, String(value ?? '')])
}

function withBuiltinCatalogItems(rows: CatalogItem[]): CatalogItem[] {
  const existing = new Set(rows.map((item) => item.id))
  return [
    ...(existing.has(BUILTIN_TOILET_CATALOG_ITEM.id) ? [] : [BUILTIN_TOILET_CATALOG_ITEM]),
    ...BUILTIN_SHOWER_PAN_CATALOG_ITEMS.filter((item) => !existing.has(item.id)),
    ...rows,
  ]
}

function catalogDisplayName(item: CatalogItem, t: (k: string) => string): string {
  if (isBuiltinToiletCatalogItem(item)) return t('hub_sketch_toilet')
  if (isBuiltinShowerPanCatalogItem(item)) return item.id === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID ? t('hub_sketch_shower_pan_neo') : t('hub_sketch_shower_pan_rect')
  return item.name
}

function resolvedCatalogDisplayName(item: CatalogResolvedPlacedItem, t: (k: string) => string): string {
  if (isToiletPlacedCatalogItem(item.placed)) return t('hub_sketch_toilet')
  if (isShowerPanPlacedCatalogItem(item.placed)) return showerPanShapeFromPlacedItem(item.placed) === 'neo-angle' ? t('hub_sketch_shower_pan_neo') : t('hub_sketch_shower_pan_rect')
  return item.name
}

function catalogColor(category: CatalogCategory): number {
  switch (category) {
    case 'shower':
      return 0x5fa8d3
    case 'vanity':
      return 0xc08457
    case 'cabinet':
      return 0x7f9f68
    case 'light':
      return 0xf4c95d
    case 'fan':
      return 0x7c8794
    case 'tile':
      return 0xa7b7c8
    default:
      return 0x9ca3af
  }
}

function configurePhotoTexture(THREE: any, texture: any, anisotropy: number) {
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = Math.max(1, anisotropy)
}

function createCatalogMaterial(
  THREE: any,
  resolved: CatalogResolvedPlacedItem,
  doesNotFit: boolean,
  textureLoader: any,
  maxAnisotropy: number,
  onTextureReady: () => void,
) {
  const hasPhoto = !!resolved.photoPath
  const material = new THREE.MeshStandardMaterial({
    color: doesNotFit ? 0xffd6d6 : hasPhoto ? 0xffffff : resolved.missingCatalogItem ? 0x9ca3af : catalogColor(resolved.category),
    roughness: resolved.category === 'shower' || resolved.category === 'vanity' ? 0.46 : 0.58,
    metalness: resolved.category === 'light' || resolved.category === 'fan' ? 0.16 : 0.04,
    transparent: resolved.missingCatalogItem,
    opacity: resolved.missingCatalogItem ? 0.7 : 0.96,
  })

  if (hasPhoto) {
    const texture = textureLoader.load(
      resolved.photoPath,
      () => {
        material.needsUpdate = true
        onTextureReady()
      },
      undefined,
      () => {
        material.map = null
        material.color.set(doesNotFit ? 0xffd6d6 : catalogColor(resolved.category))
        material.needsUpdate = true
        onTextureReady()
      },
    )
    configurePhotoTexture(THREE, texture, maxAnisotropy)
    material.map = texture
  }

  return material
}

function createContactShadowTexture(THREE: any) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const gradient = ctx.createRadialGradient(64, 64, 8, 64, 64, 62)
    gradient.addColorStop(0, 'rgba(15, 23, 42, .22)')
    gradient.addColorStop(0.58, 'rgba(15, 23, 42, .09)')
    gradient.addColorStop(1, 'rgba(15, 23, 42, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function addContactShadow(THREE: any, group: any, widthFt: number, depthFt: number, heightFt: number) {
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: createContactShadowTexture(THREE),
      transparent: true,
      depthWrite: false,
      opacity: 0.82,
    }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = -heightFt / 2 + 0.012
  shadow.scale.set(Math.max(0.6, widthFt * 1.16), Math.max(0.6, depthFt * 1.16), 1)
  shadow.renderOrder = 1
  group.add(shadow)
}

function addMeshWithEdges(THREE: any, group: any, mesh: any, edgeColor: number, edgeOpacity = 0.76) {
  group.add(mesh)
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: edgeOpacity }),
  )
  edges.position.copy(mesh.position)
  edges.rotation.copy(mesh.rotation)
  edges.scale.copy(mesh.scale)
  group.add(edges)
}

function addCatalogBox(THREE: any, group: any, resolved: CatalogResolvedPlacedItem, material: any, edgeColor: number) {
  const width = Math.max(0.04, resolved.dims.widthFt)
  const height = Math.max(0.04, resolved.dims.heightFt)
  const depth = Math.max(0.04, resolved.dims.depthFt)
  const box = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material)
  box.castShadow = false
  box.receiveShadow = false
  addMeshWithEdges(THREE, group, box, edgeColor)
}

// ELEMENTS-INFRA-26: круглая колонна — цилиндр из тех же resolved.dims (диаметр = ширина).
// Существующий примитив three.js (CylinderGeometry уже применяется у сантехники/света), движок не меняем.
function addRoundColumn(THREE: any, group: any, resolved: CatalogResolvedPlacedItem, material: any, edgeColor: number) {
  const radius = Math.max(0.04, resolved.dims.widthFt / 2)
  const height = Math.max(0.04, resolved.dims.heightFt)
  const column = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 32), material)
  column.castShadow = false
  column.receiveShadow = false
  addMeshWithEdges(THREE, group, column, edgeColor)
}

// APPLIANCES-28: мебель — простые боксы-силуэты через тот же механизм объектов (как COLUMN/BOX #26).
// Круглый стол = цилиндр, прямоугольный стол = бокс, стул = бокс + спинка. Тёплый деревянный тон.
function addFurniture(THREE: any, group: any, resolved: CatalogResolvedPlacedItem, furnitureType: SketchFurnitureType | undefined, edgeColor: number) {
  const width = Math.max(0.04, resolved.dims.widthFt)
  const height = Math.max(0.04, resolved.dims.heightFt)
  const depth = Math.max(0.04, resolved.dims.depthFt)
  const woodMaterial = new THREE.MeshStandardMaterial({ color: 0xb98a54, roughness: 0.7, metalness: 0.04 })
  if (furnitureType === 'table-round') {
    const table = new THREE.Mesh(new THREE.CylinderGeometry(width / 2, width / 2, height, 32), woodMaterial)
    table.castShadow = false
    table.receiveShadow = false
    addMeshWithEdges(THREE, group, table, edgeColor)
    return
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), woodMaterial)
  body.castShadow = false
  body.receiveShadow = false
  addMeshWithEdges(THREE, group, body, edgeColor)
  if (furnitureType === 'chair') {
    // Спинка стула — тонкий бокс у заднего края (силуэт «стула», а не просто куб).
    const backThickness = Math.max(0.03, depth * 0.12)
    const backHeight = Math.max(0.04, height * 0.9)
    const back = new THREE.Mesh(new THREE.BoxGeometry(width, backHeight, backThickness), woodMaterial)
    back.position.set(0, height / 2 + backHeight / 2, -depth / 2 + backThickness / 2)
    back.castShadow = false
    back.receiveShadow = false
    addMeshWithEdges(THREE, group, back, edgeColor)
  }
}

function addCabinetFixture(THREE: any, group: any, resolved: CatalogResolvedPlacedItem, warn: boolean, edgeColor: number) {
  const placed = resolved.placed
  const width = Math.max(0.04, resolved.dims.widthFt)
  const height = Math.max(0.04, resolved.dims.heightFt)
  const depth = Math.max(0.04, resolved.dims.depthFt)
  const floorY = -height / 2
  const isWall = placed.layer === 'wall'
  const isFiller = placed.filler === true
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: warn ? 0xffd6d6 : isWall ? 0xe6eaf5 : 0xe7e2d8,
    roughness: 0.5,
    metalness: 0.02,
  })
  const faceMaterial = new THREE.MeshStandardMaterial({
    color: warn ? 0xfca5a5 : isWall ? 0xf8fafc : 0xf6f0e6,
    roughness: 0.42,
    metalness: 0.02,
  })
  const accentMaterial = new THREE.MeshStandardMaterial({ color: warn ? 0x991b1b : 0x334155, roughness: 0.58, metalness: 0.03 })

  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), bodyMaterial)
  addMeshWithEdges(THREE, group, body, edgeColor, warn ? 0.9 : 0.44)

  const faceDepth = Math.max(0.018, Math.min(0.045, depth * 0.025))
  const face = new THREE.Mesh(new THREE.BoxGeometry(width * 0.96, height * 0.9, faceDepth), faceMaterial)
  face.position.set(0, isWall ? 0 : height * 0.01, depth / 2 + faceDepth / 2)
  addMeshWithEdges(THREE, group, face, edgeColor, warn ? 0.88 : 0.36)

  const code = cabinetDisplayCode(placed)
  const drawerLines = placed.cabinetPrefix === 'DB' || placed.cabinetPrefix === '2DB' || /^2?DB/i.test(code)
  const railCount = isFiller ? 0 : drawerLines ? 3 : 2
  for (let i = 1; i <= railCount; i++) {
    const y = floorY + height * (i / (railCount + 1))
    const rail = new THREE.Mesh(new THREE.BoxGeometry(width * 0.86, 0.018, faceDepth * 1.5), accentMaterial)
    rail.position.set(0, y, depth / 2 + faceDepth * 1.6)
    group.add(rail)
  }
  if (!isFiller && width > 0.7) {
    const stile = new THREE.Mesh(new THREE.BoxGeometry(0.018, height * 0.62, faceDepth * 1.5), accentMaterial)
    stile.position.set(0, floorY + height * 0.5, depth / 2 + faceDepth * 1.6)
    group.add(stile)
  }
  if (isFiller) {
    const markA = new THREE.Mesh(new THREE.BoxGeometry(width * 1.08, 0.018, faceDepth * 1.5), accentMaterial)
    markA.rotation.z = Math.atan2(height, width)
    markA.position.set(0, 0, depth / 2 + faceDepth * 1.8)
    group.add(markA)
  }

  if (!isWall && !isFiller) {
    const toeH = Math.min(height * 0.28, CABINET_TOE_KICK_IN / 12)
    const toeD = Math.min(depth * 0.35, 3 / 12)
    const toe = new THREE.Mesh(new THREE.BoxGeometry(width * 0.84, toeH, toeD), accentMaterial)
    toe.position.set(0, floorY + toeH / 2, depth / 2 - toeD / 2)
    group.add(toe)

    const counterTopY = CABINET_COUNTERTOP_HEIGHT_IN / 12 - resolved.dims.heightFt / 2
    const counterThickness = 1.5 / 12
    const counter = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.08, counterThickness, depth + 0.08),
      new THREE.MeshStandardMaterial({ color: warn ? 0xfecaca : 0xf8fafc, roughness: 0.34, metalness: 0.02 }),
    )
    counter.position.y = Math.max(height / 2 + counterThickness / 2, counterTopY - counterThickness / 2)
    addMeshWithEdges(THREE, group, counter, edgeColor, warn ? 0.72 : 0.28)
  }
}

function createFootprintPrism(THREE: any, points: Array<{ x: number; z: number }>, height: number, material: any) {
  const positions: number[] = []
  points.forEach((point) => positions.push(point.x, -height / 2, point.z))
  points.forEach((point) => positions.push(point.x, height / 2, point.z))
  const minX = Math.min(...points.map((point) => point.x))
  const maxX = Math.max(...points.map((point) => point.x))
  const minZ = Math.min(...points.map((point) => point.z))
  const maxZ = Math.max(...points.map((point) => point.z))
  const width = Math.max(0.001, maxX - minX)
  const depth = Math.max(0.001, maxZ - minZ)
  const uvs: number[] = []
  points.forEach((point) => uvs.push((point.x - minX) / width, (point.z - minZ) / depth))
  points.forEach((point) => uvs.push((point.x - minX) / width, (point.z - minZ) / depth))
  const shapePoints = points.map((point) => new THREE.Vector2(point.x, point.z))
  const triangles = THREE.ShapeUtils.triangulateShape(shapePoints, [])
  const indices: number[] = []
  triangles.forEach((tri: number[]) => {
    indices.push(points.length + tri[0], points.length + tri[1], points.length + tri[2])
    indices.push(tri[2], tri[1], tri[0])
  })
  points.forEach((_, index) => {
    const next = (index + 1) % points.length
    indices.push(index, next, points.length + next)
    indices.push(index, points.length + next, points.length + index)
  })
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return new THREE.Mesh(geometry, material)
}

function addShowerPan(THREE: any, group: any, resolved: CatalogResolvedPlacedItem, material: any, edgeColor: number, tileMaterial?: any) {
  const width = Math.max(0.04, resolved.dims.widthFt)
  const height = Math.max(0.08, resolved.dims.heightFt)
  const depth = Math.max(0.04, resolved.dims.depthFt)
  const shape = showerPanShapeFromPlacedItem(resolved.placed)
  const finishMaterial = tileMaterial ?? null
  const shellMaterial = finishMaterial ?? material
  const basinMaterial = finishMaterial ?? new THREE.MeshStandardMaterial({ color: 0xf3f6f7, roughness: 0.38, metalness: 0.02 })
  if (shape === 'neo-angle') {
    const baseHeight = Math.max(0.05, height * 0.62)
    const base = createFootprintPrism(THREE, showerPanFootprintPoints(shape, width, depth), baseHeight, shellMaterial)
    base.position.y = -height / 2 + baseHeight / 2
    addMeshWithEdges(THREE, group, base, edgeColor, 0.58)

    const floorWidth = Math.max(0.08, width * 0.78)
    const floorDepth = Math.max(0.08, depth * 0.78)
    const panFloor = createFootprintPrism(
      THREE,
      showerPanFootprintPoints(shape, floorWidth, floorDepth),
      0.028,
      finishMaterial ?? new THREE.MeshStandardMaterial({ color: 0xe9eef0, roughness: 0.42 }),
    )
    panFloor.position.y = -height / 2 + baseHeight + 0.018
    addMeshWithEdges(THREE, group, panFloor, edgeColor, 0.32)
    return
  }
  const rim = Math.max(0.08, Math.min(0.28, Math.min(width, depth) * 0.07))
  const baseHeight = Math.max(0.04, Math.min(height * 0.5, height - 0.035))
  const rimHeight = Math.max(0.04, height - baseHeight)
  const base = new THREE.Mesh(new THREE.BoxGeometry(width, baseHeight, depth), shellMaterial)
  base.position.y = -height / 2 + baseHeight / 2
  addMeshWithEdges(THREE, group, base, edgeColor, 0.58)

  const rimY = height / 2 - rimHeight / 2
  const back = new THREE.Mesh(new THREE.BoxGeometry(width, rimHeight, rim), basinMaterial)
  const front = new THREE.Mesh(new THREE.BoxGeometry(width, rimHeight, rim), basinMaterial)
  const left = new THREE.Mesh(new THREE.BoxGeometry(rim, rimHeight, Math.max(0.02, depth - rim * 2)), basinMaterial)
  const right = new THREE.Mesh(new THREE.BoxGeometry(rim, rimHeight, Math.max(0.02, depth - rim * 2)), basinMaterial)
  back.position.set(0, rimY, -depth / 2 + rim / 2)
  front.position.set(0, rimY, depth / 2 - rim / 2)
  left.position.set(-width / 2 + rim / 2, rimY, 0)
  right.position.set(width / 2 - rim / 2, rimY, 0)
  ;[back, front, left, right].forEach((mesh) => addMeshWithEdges(THREE, group, mesh, edgeColor, 0.44))

  const panFloor = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(0.02, width - rim * 2), 0.025, Math.max(0.02, depth - rim * 2)),
    finishMaterial ?? new THREE.MeshStandardMaterial({ color: 0xe9eef0, roughness: 0.42 }),
  )
  panFloor.position.y = -height / 2 + baseHeight + 0.014
  addMeshWithEdges(THREE, group, panFloor, edgeColor, 0.32)
}

function addToiletFixture(THREE: any, group: any, resolved: CatalogResolvedPlacedItem, warn: boolean, edgeColor: number) {
  const width = Math.max(0.04, resolved.dims.widthFt)
  const height = Math.max(0.04, resolved.dims.heightFt)
  const depth = Math.max(0.04, resolved.dims.depthFt)
  const floorY = -height / 2
  const ceramic = new THREE.MeshStandardMaterial({
    color: warn ? 0xffd6d6 : 0xf8fafc,
    roughness: 0.32,
    metalness: 0.02,
  })
  const shadow = new THREE.MeshStandardMaterial({ color: warn ? 0xfecaca : 0xe5e7eb, roughness: 0.44, metalness: 0.02 })
  const water = new THREE.MeshStandardMaterial({ color: 0x9bd5ff, roughness: 0.2, metalness: 0.04, transparent: true, opacity: 0.82 })

  const tankH = Math.max(0.46, height * 0.42)
  const tankD = Math.max(0.22, depth * 0.24)
  const tank = new THREE.Mesh(new THREE.BoxGeometry(width * 0.94, tankH, tankD), ceramic)
  tank.position.set(0, floorY + height - tankH / 2, -depth / 2 + tankD / 2)
  addMeshWithEdges(THREE, group, tank, edgeColor, warn ? 0.95 : 0.46)

  const baseH = Math.max(0.34, height * 0.2)
  const base = new THREE.Mesh(new THREE.BoxGeometry(width * 0.42, baseH, depth * 0.34), shadow)
  base.position.set(0, floorY + baseH / 2, depth * 0.16)
  addMeshWithEdges(THREE, group, base, edgeColor, warn ? 0.9 : 0.3)

  const bowlH = Math.max(0.42, height * 0.34)
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.42, bowlH, 36), ceramic)
  bowl.scale.set(width * 0.78, 1, depth * 0.5)
  bowl.position.set(0, floorY + baseH + bowlH / 2 - 0.04, depth * 0.1)
  addMeshWithEdges(THREE, group, bowl, edgeColor, warn ? 0.95 : 0.38)

  const seatY = floorY + baseH + bowlH + 0.035
  const seat = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.045, 12, 40), ceramic)
  seat.rotation.x = Math.PI / 2
  seat.scale.set(width * 0.88, depth * 0.68, 1)
  seat.position.set(0, seatY, depth * 0.1)
  group.add(seat)

  const waterDisk = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.026, 28), water)
  waterDisk.scale.set(width * 0.66, 1, depth * 0.42)
  waterDisk.position.set(0, seatY + 0.01, depth * 0.1)
  group.add(waterDisk)
}

function createLabelSprite(THREE: any, text: string) {
  const lines = text.split('\n')
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  canvas.width = 512
  canvas.height = Math.max(128, 54 + lines.length * 34)
  if (ctx) {
    ctx.font = '700 26px sans-serif'
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width), 180)
    canvas.width = Math.min(768, Math.max(320, Math.ceil(widest + 56)))
    ctx.fillStyle = 'rgba(15, 23, 42, .88)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = 'rgba(255, 255, 255, .28)'
    ctx.lineWidth = 3
    ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3)
    ctx.fillStyle = '#ffffff'
    ctx.font = '700 26px sans-serif'
    lines.forEach((line, i) => ctx.fillText(line, 28, 42 + i * 34))
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(canvas.width / 120, canvas.height / 120, 1)
  sprite.renderOrder = 20
  return sprite
}

function createDimensionSprite(THREE: any, text: string) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  canvas.width = 320
  canvas.height = 82
  if (ctx) {
    ctx.font = '800 24px sans-serif'
    const widest = Math.max(ctx.measureText(text).width, 90)
    canvas.width = Math.min(420, Math.max(180, Math.ceil(widest + 30)))
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 6
    ctx.strokeStyle = 'rgba(255, 255, 255, .94)'
    ctx.fillStyle = '#0f172a'
    ctx.font = '800 22px sans-serif'
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2)
    ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(canvas.width / 210, canvas.height / 210, 1)
  sprite.renderOrder = 21
  return sprite
}

function createCodeClearanceSprite(THREE: any, text: string, warning: boolean) {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  canvas.width = 512
  canvas.height = 86
  if (ctx) {
    ctx.font = '800 22px sans-serif'
    const width = Math.min(680, Math.max(220, Math.ceil(ctx.measureText(text).width + 34)))
    canvas.width = width
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = warning ? 'rgba(185, 28, 28, .94)' : 'rgba(4, 120, 87, .88)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = 'rgba(255, 255, 255, .24)'
    ctx.lineWidth = 3
    ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3)
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = '800 22px sans-serif'
    ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(canvas.width / 180, canvas.height / 180, 1)
  sprite.renderOrder = 32
  return sprite
}

function createCodeClearanceGroup(
  THREE: any,
  checks: CodeClearanceCheck[],
  t: (key: string) => string,
  itemId?: string,
) {
  const filtered = itemId
    ? checks.filter((check) => check.subject.id === itemId || check.target.id === itemId)
    : checks
  if (filtered.length === 0) return null
  const group = new THREE.Group()
  filtered.forEach((check) => {
    const warning = !check.ok
    const color = warning ? 0xdc2626 : 0x047857
    if (check.line) {
      const y = check.type === 'shower-size' ? 0.2 : 0.14
      const a = new THREE.Vector3(check.line.a.x, y, check.line.a.z)
      const b = new THREE.Vector3(check.line.b.x, y, check.line.b.z)
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z], 3))
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: warning ? 1 : 0.72, depthTest: false }),
      )
      line.renderOrder = 30
      group.add(line)
      const pointMaterial = new THREE.MeshBasicMaterial({ color, depthTest: false })
      ;[a, b].forEach((point) => {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(warning ? 0.055 : 0.04, 12, 8), pointMaterial)
        dot.position.copy(point)
        dot.renderOrder = 31
        group.add(dot)
      })
      const label = createCodeClearanceSprite(
        THREE,
        warning
          ? formatCodeClearanceMessage(check, t)
          : `${formatCodeClearanceIn(check.actualIn)}`,
        warning,
      )
      label.position.set((a.x + b.x) / 2, y + (warning ? 0.46 : 0.32), (a.z + b.z) / 2)
      group.add(label)
    }
    if (check.arc) {
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(check.arc.start.x, 0.16, check.arc.start.z),
        new THREE.Vector3(
          check.arc.center.x + (check.arc.start.x + check.arc.end.x - check.arc.center.x * 2) * 0.7,
          0.16,
          check.arc.center.z + (check.arc.start.z + check.arc.end.z - check.arc.center.z * 2) * 0.7,
        ),
        new THREE.Vector3(check.arc.end.x, 0.16, check.arc.end.z),
      )
      const points = curve.getPoints(24)
      const geometry = new THREE.BufferGeometry().setFromPoints(points)
      const arc = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.96, depthTest: false }),
      )
      arc.renderOrder = 30
      group.add(arc)
    }
  })
  return group
}

function addLine(points: any[], a: any, b: any) {
  points.push(a.x, a.y, a.z, b.x, b.y, b.z)
}

function addDimensionLineGroup(
  THREE: any,
  parent: any,
  a: { x: number; z: number },
  b: { x: number; z: number },
  height: number,
  nx: number,
  nz: number,
  lengthText: string,
  heightText: string,
) {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len = Math.hypot(dx, dz)
  if (len <= 0.01) return
  const ux = dx / len
  const uz = dz / len
  const offset = WALL_THICKNESS_FT / 2 + 0.48
  const extGap = 0.08
  const tick = 0.22
  const y = 0.13
  const start = new THREE.Vector3(a.x + nx * offset, y, a.z + nz * offset)
  const end = new THREE.Vector3(b.x + nx * offset, y, b.z + nz * offset)
  const points: number[] = []

  addLine(points, new THREE.Vector3(a.x + nx * extGap, y, a.z + nz * extGap), start.clone().add(new THREE.Vector3(nx * extGap, 0, nz * extGap)))
  addLine(points, new THREE.Vector3(b.x + nx * extGap, y, b.z + nz * extGap), end.clone().add(new THREE.Vector3(nx * extGap, 0, nz * extGap)))
  addLine(points, start, end)
  const slash = new THREE.Vector3((ux + nx) * tick, 0, (uz + nz) * tick)
  addLine(points, start.clone().addScaledVector(slash, -0.5), start.clone().addScaledVector(slash, 0.5))
  addLine(points, end.clone().addScaledVector(slash, -0.5), end.clone().addScaledVector(slash, 0.5))

  const hx = a.x + nx * (offset + 0.42) - ux * 0.16
  const hz = a.z + nz * (offset + 0.42) - uz * 0.16
  const bottom = new THREE.Vector3(hx, 0, hz)
  const top = new THREE.Vector3(hx, height, hz)
  addLine(points, bottom, top)
  const heightSlash = new THREE.Vector3(ux * tick, tick, uz * tick)
  addLine(points, bottom.clone().addScaledVector(heightSlash, -0.5), bottom.clone().addScaledVector(heightSlash, 0.5))
  addLine(points, top.clone().addScaledVector(heightSlash, -0.5), top.clone().addScaledVector(heightSlash, 0.5))

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  const material = new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.9, depthTest: false })
  const lines = new THREE.LineSegments(geometry, material)
  lines.renderOrder = 20
  parent.add(lines)

  const lengthLabel = createDimensionSprite(THREE, lengthText)
  lengthLabel.position.set((start.x + end.x) / 2 + nx * 0.18, y + 0.28, (start.z + end.z) / 2 + nz * 0.18)
  parent.add(lengthLabel)

  const heightLabel = createDimensionSprite(THREE, heightText)
  heightLabel.position.set(hx + nx * 0.2, height / 2, hz + nz * 0.2)
  parent.add(heightLabel)
}

function addFlatDimSegment(
  THREE: any,
  points: number[],
  labels: Array<{ text: string; x: number; y: number; z: number }>,
  a: { x: number; z: number },
  b: { x: number; z: number },
  y: number,
  nx: number,
  nz: number,
  ux: number,
  uz: number,
  offset: number,
  text: string,
) {
  const start = new THREE.Vector3(a.x + nx * offset, y, a.z + nz * offset)
  const end = new THREE.Vector3(b.x + nx * offset, y, b.z + nz * offset)
  const len = Math.hypot(end.x - start.x, end.z - start.z)
  if (len <= 0.08) return
  const tick = 0.16
  const slash = new THREE.Vector3((ux + nx) * tick, 0, (uz + nz) * tick)
  addLine(points, start, end)
  addLine(points, start.clone().addScaledVector(slash, -0.5), start.clone().addScaledVector(slash, 0.5))
  addLine(points, end.clone().addScaledVector(slash, -0.5), end.clone().addScaledVector(slash, 0.5))
  labels.push({
    text,
    x: (start.x + end.x) / 2 + nx * 0.12,
    y: y + 0.24,
    z: (start.z + end.z) / 2 + nz * 0.12,
  })
}

function createOpeningDimensionGroup(
  THREE: any,
  opening: Opening,
  metrics: OpeningMetrics,
  t: (k: string) => string,
) {
  const group = new THREE.Group()
  const points: number[] = []
  const labels: Array<{ text: string; x: number; y: number; z: number }> = []
  const offset = WALL_THICKNESS_FT / 2 + 0.38
  const y = Math.max(0.18, Math.min(metrics.sill + 0.18, metrics.height + metrics.sill + 0.18))

  addFlatDimSegment(THREE, points, labels, metrics.wallA, metrics.edgeA, y, metrics.nx, metrics.nz, metrics.ux, metrics.uz, offset, `${t('hub_sketch_dim_left_short')} ${formatOpeningFeet(metrics.left)}`)
  addFlatDimSegment(THREE, points, labels, metrics.edgeA, metrics.edgeB, y + 0.38, metrics.nx, metrics.nz, metrics.ux, metrics.uz, offset, openingDimensionText(opening, metrics, t).replace('\n', ' · '))
  addFlatDimSegment(THREE, points, labels, metrics.edgeB, metrics.wallB, y, metrics.nx, metrics.nz, metrics.ux, metrics.uz, offset, `${t('hub_sketch_dim_right_short')} ${formatOpeningFeet(metrics.right)}`)

  if (points.length > 0) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
    const material = new THREE.LineBasicMaterial({
      color: opening.kind === 'door' ? 0x7c2d12 : 0x1d4ed8,
      transparent: true,
      opacity: 0.96,
      depthTest: false,
    })
    const lines = new THREE.LineSegments(geometry, material)
    lines.renderOrder = 24
    group.add(lines)
  }

  labels.forEach((label) => {
    const sprite = createDimensionSprite(THREE, label.text)
    sprite.position.set(label.x, label.y, label.z)
    group.add(sprite)
  })

  return group
}

function createSpaceMeasurementGroup(THREE: any, measurement: SketchMeasurement, selected: boolean) {
  if (measurement.scope !== 'space' || measurement.a.z === undefined || measurement.b.z === undefined) return null
  const a = new THREE.Vector3(measurement.a.x, measurement.a.y, measurement.a.z)
  const b = new THREE.Vector3(measurement.b.x, measurement.b.y, measurement.b.z)
  const length = a.distanceTo(b)
  if (length <= 0.01) return null

  const group = new THREE.Group()
  const color = selected ? 0xbe123c : 0x047857
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, b.x, b.y, b.z], 3))
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: selected ? 1 : 0.95, depthTest: false }),
  )
  line.renderOrder = 26
  group.add(line)

  const pointMaterial = new THREE.MeshBasicMaterial({ color, depthTest: false })
  const radius = selected ? 0.095 : 0.075
  ;[a, b].forEach((point: any) => {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 10), pointMaterial)
    dot.position.copy(point)
    dot.renderOrder = 27
    group.add(dot)
  })

  const label = createDimensionSprite(THREE, formatFeet(length))
  const midpoint = a.clone().add(b).multiplyScalar(0.5)
  label.position.copy(midpoint)
  label.position.y += 0.28
  group.add(label)
  return group
}

export default function Sketch3DView({
  model,
  heightFt,
  project,
  profile,
  sketchName,
  canEdit = false,
  onModelChange,
  onHeightChange,
  snapStepFt = EIGHTH_IN_FT,
  codeCheckEnabled = true,
  onCodeCheckChange,
  pickedWallKey = null,
  onPickWall,
  openingDefaults,
  onOpeningDefaultsChange,
  snapControls,
  contextMode,
  cameraPresetRequest,
  fullscreenRequestKey = 0,
  viewModeControl,
  label,
  loadingLabel,
  errorLabel,
}: Sketch3DViewProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const fullscreenRootRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const cameraApiRef = useRef<Record<CameraPreset, () => void> | null>(null)
  const insideMoveApiRef = useRef<InsideMoveApi | null>(null)
  const photoSnapshotApiRef = useRef<PhotoRenderSnapshotApi | null>(null)
  const ceilingVisibilityApiRef = useRef<CeilingVisibilityApi | null>(null)
  const photoRenderBusyRef = useRef(false)
  const joystickRef = useRef<HTMLDivElement | null>(null)
  const joystickPointerRef = useRef<number | null>(null)
  const dimensionGroupRef = useRef<any | null>(null)
  const dimensionsVisibleRef = useRef(false)
  const invalidate3DRef = useRef<(() => void) | null>(null)
  const placementRef = useRef<PlacementKind>(null)
  // NAV-FIX-2: подсветка выбранной стены применяется БЕЗ пересоздания сцены (через api-ref).
  const wallHighlightApiRef = useRef<{ setSelected: (key: string | null) => void } | null>(null)
  const pickedWallKeyRef = useRef<string | null>(null)
  const onPickWallRef = useRef<Sketch3DViewProps['onPickWall']>(undefined)
  const measure3DActiveRef = useRef(false)
  const measure3DDraftRef = useRef<SketchMeasurementPoint | null>(null)
  const catalogPlacementItemRef = useRef<CatalogItem | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [showDimensions, setShowDimensions] = useState(false)
  const [showCeiling, setShowCeiling] = useState(false)
  const [measure3DActive, setMeasure3DActive] = useState(false)
  const [cameraMode, setCameraMode] = useState<CameraPreset>('fit')
  const [surfaceTarget, setSurfaceTarget] = useState<SurfaceTarget>('walls')
  const [selectedWallKey, setSelectedWallKey] = useState<string | null>(null)
  const [placement, setPlacement] = useState<PlacementKind>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState(false)
  const [catalogPlacementId, setCatalogPlacementId] = useState<string | null>(null)
  const [tileSourceMode, setTileSourceMode] = useState<TileSourceMode>('manual')
  const [paintSearch, setPaintSearch] = useState('')
  const [inchDrafts, setInchDrafts] = useState<Partial<Record<InchDraftField, string>>>({})
  const [feetDrafts, setFeetDrafts] = useState<Partial<Record<FeetDraftField, string>>>({})
  const [openingDefaultDrafts, setOpeningDefaultDrafts] = useState<Partial<Record<OpeningDefaultDraftField, string>>>({})
  const [browserFullscreen, setBrowserFullscreen] = useState(false)
  const [fullscreenFallback, setFullscreenFallback] = useState(false)
  const [panelOverlayOpen, setPanelOverlayOpen] = useState(false)
  const [openingSizeOpen, setOpeningSizeOpen] = useState(false)
  const [joystickKnob, setJoystickKnob] = useState<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false })
  const [photoRenderBusy, setPhotoRenderBusy] = useState(false)
  const [photoModal, setPhotoModal] = useState<PhotoRenderModalState | null>(null)
  const [photoReference, setPhotoReference] = useState<PhotoRenderReferenceState | null>(null)
  const [photoReferencePickerOpen, setPhotoReferencePickerOpen] = useState(false)
  const [photoReferenceFiles, setPhotoReferenceFiles] = useState<ProjectHubFile[]>([])
  const [photoReferenceThumbs, setPhotoReferenceThumbs] = useState<Record<string, string>>({})
  const [photoReferenceLoading, setPhotoReferenceLoading] = useState(false)
  const [photoReferenceLoadError, setPhotoReferenceLoadError] = useState(false)
  const [photoReferenceErrorKey, setPhotoReferenceErrorKey] = useState<string | null>(null)
  const [snapshotPanel, setSnapshotPanel] = useState<SnapshotPanelState | null>(null)
  const photoReferenceInputRef = useRef<HTMLInputElement | null>(null)
  const snapshotBusyRef = useRef(false)
  const snapshotCountRef = useRef(0)

  const finishes = useMemo(() => normalizeFinishes(model.finishes), [model.finishes])
  const lights = useMemo(() => model.lights ?? [], [model.lights])
  const switches = useMemo(() => model.switches ?? [], [model.switches])
  const measurements = useMemo(() => model.measurements ?? [], [model.measurements])
  const spaceMeasurements = useMemo(
    () => measurements
      .map((measurement, index) => ({ measurement, index }))
      .filter(({ measurement }) => measurement.scope === 'space'),
    [measurements],
  )
  const placedItems = useMemo(() => sanitizePlacedCatalogItems(model.placedItems), [model.placedItems])
  const catalogById = useMemo(() => new Map(catalogItems.map((item) => [item.id, item])), [catalogItems])
  const resolvedPlacedItems = useMemo(
    () => placedItems
      // ELEMENTS-INFRA-26: электрика и подводки — настенные маркеры разметки, не 3D-объёмы (рисуются отдельно/на развёртке).
      .filter((placed) => !isElectricalPlacedCatalogItem(placed) && !isPipePlacedCatalogItem(placed))
      .map((placed) => resolvePlacedCatalogItem(placed, catalogById.get(placed.catalogItemId) ?? null))
      .filter((item): item is CatalogResolvedPlacedItem => !!item),
    [placedItems, catalogById],
  )
  const selectedLight = lights.find((light) => light.id === selectedId) ?? null
  const selectedSwitch = switches.find((sw) => sw.id === selectedId) ?? null
  const selectedElectrical = placedItems.find((item) => item.id === selectedId && isElectricalPlacedCatalogItem(item)) ?? null
  const selectedPlaced = resolvedPlacedItems.find((item) => item.placed.id === selectedId) ?? null
  const selectedOpeningIndex = openingIndexFromId(selectedId)
  const selectedOpening = selectedOpeningIndex !== null ? model.openings[selectedOpeningIndex] ?? null : null
  const selectedMeasurementIndex = measurementIndexFromId(selectedId)
  const selectedMeasurement = selectedMeasurementIndex !== null ? measurements[selectedMeasurementIndex] ?? null : null
  const selectedMeasurementLength = selectedMeasurement?.scope === 'space' && selectedMeasurement.a.z !== undefined && selectedMeasurement.b.z !== undefined
    ? Math.hypot(selectedMeasurement.b.x - selectedMeasurement.a.x, selectedMeasurement.b.y - selectedMeasurement.a.y, selectedMeasurement.b.z - selectedMeasurement.a.z)
    : null
  const selectedOpeningMetrics = selectedOpening ? openingMetrics(model, selectedOpening, heightFt) : null
  const catalogPlacementItem = catalogPlacementId ? catalogById.get(catalogPlacementId) ?? null : null
  const fullscreenActive = browserFullscreen || fullscreenFallback

  useEffect(() => {
    if (fullscreenRequestKey <= 0) return
    setBrowserFullscreen(false)
    setFullscreenFallback(true)
    setPanelOverlayOpen(false)
  }, [fullscreenRequestKey])

  const catalogPanelCategories = useMemo<CatalogCategory[]>(() => {
    if (contextMode === 'plumbing') return ['shower', 'vanity', 'other']
    if (contextMode === 'light') return ['light', 'fan']
    return CATALOG_CATEGORIES.filter((category) => category !== 'tile')
  }, [contextMode])
  const catalogGroups = useMemo(
    () => catalogPanelCategories
      .map((category) => ({ category, rows: catalogItems.filter((item) => item.category === category) }))
      .filter((group) => group.rows.length > 0),
    [catalogItems, catalogPanelCategories],
  )
  const photoRenderBaseName = useMemo(
    () => safeRenderSlug(sketchName || project?.name, project?.id?.slice(0, 8) || 'sketch'),
    [project?.id, project?.name, sketchName],
  )
  const selectedPhotoReferenceProjectId = photoReference?.source === 'project' ? photoReference.projectFile.id : null
  const wallSegments = useMemo(() => eachSegment(model), [model])
  const effectiveSelectedWallKey = selectedWallKey && wallSegments.some((seg) => sketchWallKey(seg.c, seg.s) === selectedWallKey)
    ? selectedWallKey
    : wallSegments[0]
      ? sketchWallKey(wallSegments[0].c, wallSegments[0].s)
      : null
  const selectedWall = effectiveSelectedWallKey
    ? wallSegments.find((seg) => sketchWallKey(seg.c, seg.s) === effectiveSelectedWallKey) ?? null
    : null
  const wallSegmentGroups = useMemo(() => {
    const cellFt = modelCellFt(model)
    const groups: Array<{ c: number; label: string; options: Array<{ key: string; label: string }> }> = []
    wallSegments.forEach((seg, index) => {
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
        label: `${t('hub_sketch_3d_wall')} ${index + 1} · ${formatFeet(dist(seg.a, seg.b) * cellFt)}`,
      })
    })
    return groups
  }, [model, t, wallSegments])
  const selectedWallFinish = effectiveSelectedWallKey ? finishes.wallFinishes[effectiveSelectedWallKey] : undefined
  const activeSurface = surfaceTarget === 'floor'
    ? finishes.floor
    : surfaceTarget === 'wall'
      ? selectedWallFinish ?? finishes.walls
      : finishes.walls
  const activeTile = useMemo(() => normalizeTileSurface(activeSurface), [activeSurface])
  const activeDrywallPatch = useMemo(() => normalizeDrywallPatchSurface(activeSurface), [activeSurface])
  const catalogTileItems = useMemo(
    () => catalogItems.filter((item) => item.category === 'tile' && item.is_active !== false),
    [catalogItems],
  )
  const activeCoverage = useMemo(() => finishCoverageBoundsFt(activeSurface, heightFt), [activeSurface, heightFt])
  const swColorMatches = useMemo(() => {
    const query = paintSearch.trim().toLowerCase()
    const rows = query
      ? SHERWIN_WILLIAMS_COLORS.filter((color) => `${color.code} ${color.name}`.toLowerCase().includes(query))
      : SHERWIN_WILLIAMS_COLORS
    return rows.slice(0, SW_COLOR_LIMIT)
  }, [paintSearch])
  const boundsForCuts = modelBounds(model)
  const selectedWallLengthFt = selectedWall ? dist(selectedWall.a, selectedWall.b) * modelCellFt(model) : null
  const surfaceHeightIn = surfaceTarget === 'floor'
    ? Math.max(12, boundsForCuts.depth * 12)
    : Math.max(1, (activeCoverage.topFt - activeCoverage.bottomFt) * 12)
  const surfaceWidthIn = surfaceTarget === 'floor'
    ? Math.max(12, boundsForCuts.width * 12)
    : selectedWallLengthFt
      ? Math.max(12, selectedWallLengthFt * 12)
      : longestWallIn(model)
  const tileLayoutOpenings = useMemo<TileLayoutOpening[]>(() => {
    if (surfaceTarget !== 'wall' || !selectedWall || !selectedWallLengthFt) return []
    return model.openings
      .filter((opening) => opening.c === selectedWall.c && opening.s === selectedWall.s)
      .map((opening): TileLayoutOpening | null => {
        const metrics = openingMetrics(model, opening, heightFt)
        if (!metrics) return null
        const widthIn = metrics.width * 12
        return {
          xIn: Math.max(0, opening.t * selectedWallLengthFt * 12 - widthIn / 2),
          yIn: metrics.sill * 12 - activeCoverage.bottomFt * 12,
          widthIn,
          heightIn: metrics.height * 12,
        }
      })
      .filter((opening): opening is TileLayoutOpening => !!opening)
  }, [surfaceTarget, selectedWall, selectedWallLengthFt, model, heightFt, activeCoverage.bottomFt])
  const tileLayout = activeSurface.kind === 'tile'
    ? estimateTileLayout({
        surfaceWidthIn,
        surfaceHeightIn,
        tileWIn: activeTile.tileWIn ?? 12,
        tileHIn: activeTile.tileHIn ?? 24,
        groutIn: activeTile.groutIn ?? DEFAULT_GROUT_IN,
        offsetXIn: activeTile.offsetXIn ?? 0,
        offsetYIn: activeTile.offsetYIn ?? 0,
        wasteFactor: DEFAULT_TILE_WASTE_FACTOR,
        openings: tileLayoutOpenings,
      })
    : null
  const selectedPlacedDoesNotFit = selectedPlaced
    ? placedCatalogDoesNotFit(selectedPlaced.placed, selectedPlaced.dims, boundsForCuts, heightFt, segmentLengthFt(model, selectedPlaced.placed.c, selectedPlaced.placed.s))
    : false
  const codeClearanceChecks = useMemo(
    () => (codeCheckEnabled ? getCodeClearanceChecks(model) : []),
    [model, codeCheckEnabled],
  )
  const codeClearanceViolations = useMemo(() => codeClearanceChecks.filter((check) => !check.ok), [codeClearanceChecks])
  const codeWarningItemIds = useMemo(() => codeClearanceItemIds(codeClearanceViolations), [codeClearanceViolations])
  const selectedPlacedCodeViolations = selectedPlaced
    ? codeClearanceViolations.filter((check) => check.subject.id === selectedPlaced.placed.id || check.target.id === selectedPlaced.placed.id)
    : []
  const selectedPlacedSpecs = selectedPlaced ? catalogSpecsEntries(selectedPlaced.specs) : []
  const selectedShowerPan = selectedPlaced && isShowerPanPlacedCatalogItem(selectedPlaced.placed) ? selectedPlaced : null
  const selectedShowerPanFinish = selectedShowerPan?.placed.panFinish ? normalizeTileSurface(selectedShowerPan.placed.panFinish) : null
  const showAllContextSections = !contextMode
  const show3DFinishes = showAllContextSections || contextMode === 'finish'
  const show3DOpenings = showAllContextSections || contextMode === 'opening'
  const show3DPlumbing = showAllContextSections || contextMode === 'plumbing'
  const show3DLighting = showAllContextSections || contextMode === 'light'
  const show3DMeasure = showAllContextSections || contextMode === 'measure'
  const show3DPanel = canEdit && (show3DFinishes || show3DOpenings || show3DPlumbing || show3DLighting || show3DMeasure)

  useEffect(() => {
    // SKETCH-DISCOVER-FIX-17: вход в 3D-режим с панелью (отделка/свет) сразу раскрывает её —
    // палитра/светильники видны без второго клика «Показать панель отделки».
    setPanelOverlayOpen(!fullscreenActive && show3DPanel)
  }, [fullscreenActive, show3DPanel])

  useEffect(() => {
    placementRef.current = placement
    catalogPlacementItemRef.current = catalogPlacementItem
  }, [placement, catalogPlacementItem])

  useEffect(() => {
    measure3DActiveRef.current = measure3DActive
    if (!measure3DActive) measure3DDraftRef.current = null
    invalidate3DRef.current?.()
  }, [measure3DActive])

  useEffect(() => {
    onPickWallRef.current = onPickWall
  }, [onPickWall])

  // NAV-FIX-2: подсветить выбранную стену (без пересоздания сцены) и навести панель отделки на неё.
  useEffect(() => {
    pickedWallKeyRef.current = pickedWallKey
    wallHighlightApiRef.current?.setSelected(pickedWallKey)
    if (pickedWallKey) {
      setSurfaceTarget('wall')
      setSelectedWallKey(pickedWallKey)
    }
    invalidate3DRef.current?.()
  }, [pickedWallKey])

  useEffect(() => {
    ceilingVisibilityApiRef.current?.setVisible(cameraMode === 'inside' || showCeiling)
    invalidate3DRef.current?.()
  }, [cameraMode, showCeiling])

  useEffect(() => {
    setInchDrafts({})
  }, [surfaceTarget, activeTile.tileWIn, activeTile.tileHIn, activeTile.groutIn, activeTile.offsetXIn, activeTile.offsetYIn])

  useEffect(() => {
    setTileSourceMode(activeTile.catalogItemId ? 'catalog' : 'manual')
  }, [surfaceTarget, activeTile.catalogItemId])

  useEffect(() => {
    setFeetDrafts({})
  }, [surfaceTarget, activeSurface])

  useEffect(() => {
    setOpeningDefaultDrafts({})
  }, [openingDefaults?.doorW, openingDefaults?.doorH, openingDefaults?.winW, openingDefaults?.winH, openingDefaults?.winSill])

  useEffect(() => {
    if (wallSegments.length === 0) {
      if (selectedWallKey) setSelectedWallKey(null)
      return
    }
    if (!effectiveSelectedWallKey || selectedWallKey !== effectiveSelectedWallKey) {
      setSelectedWallKey(effectiveSelectedWallKey)
    }
  }, [wallSegments, selectedWallKey, effectiveSelectedWallKey])

  useEffect(() => {
    if (selectedMeasurementIndex !== null && !measurements[selectedMeasurementIndex]) {
      setSelectedId(null)
    }
  }, [selectedMeasurementIndex, measurements])

  useEffect(() => {
    setPhotoReference(null)
    setPhotoReferencePickerOpen(false)
    setPhotoReferenceErrorKey(null)
    if (!project?.id) {
      setPhotoReferenceFiles([])
      setPhotoReferenceThumbs({})
      setPhotoReferenceLoading(false)
      setPhotoReferenceLoadError(false)
      return
    }

    let mounted = true
    ;(async () => {
      setPhotoReferenceLoading(true)
      setPhotoReferenceLoadError(false)
      try {
        const rows = (await getProjectHubFiles(project.id)).filter(imageFileLike)
        const entries = await Promise.all(rows.map(async (row) => {
          try {
            const url = await projectHubImageUrl(row)
            return url ? ([row.id, url] as const) : null
          } catch {
            return null
          }
        }))
        if (!mounted) return
        setPhotoReferenceFiles(rows)
        setPhotoReferenceThumbs(Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null)))
      } catch {
        if (!mounted) return
        setPhotoReferenceFiles([])
        setPhotoReferenceThumbs({})
        setPhotoReferenceLoadError(true)
      } finally {
        if (mounted) setPhotoReferenceLoading(false)
      }
    })()

    return () => { mounted = false }
  }, [project?.id])

  const applyModel = (next: Sketch3DModelWithCatalog) => {
    if (!canEdit) return
    onModelChange?.(next)
  }

  const applyPlacedItems = (nextPlaced: SketchPlacedCatalogItem[]) => {
    const next: Sketch3DModelWithCatalog = { ...model }
    if (nextPlaced.length > 0) next.placedItems = nextPlaced
    else delete next.placedItems
    applyModel(next)
  }

  const applyMeasurements = (nextMeasurements: SketchMeasurement[]) => {
    const next: Sketch3DModelWithCatalog = { ...model }
    if (nextMeasurements.length > 0) next.measurements = nextMeasurements
    else delete next.measurements
    applyModel(next)
  }

  const updateSurface = (surface: SketchSurfaceFinish) => {
    const nextFinishes = normalizeFinishes(model.finishes)
    if (surfaceTarget === 'wall') {
      if (!effectiveSelectedWallKey) return
      applyModel({
        ...model,
        finishes: {
          ...nextFinishes,
          wallFinishes: {
            ...nextFinishes.wallFinishes,
            [effectiveSelectedWallKey]: surface,
          },
        },
      })
      return
    }
    const next = { ...nextFinishes, [surfaceTarget]: surface }
    if (surfaceTarget === 'walls' && surface.kind === 'paint') next.wallPaint = cleanColor(surface.color, DEFAULT_WALL_PAINT)
    applyModel({ ...model, finishes: next })
  }

  const updateWallPaint = (color: string) => {
    const clean = cleanColor(color, DEFAULT_WALL_PAINT)
    const nextFinishes = normalizeFinishes(model.finishes)
    const nextWalls = nextFinishes.walls.kind === 'paint' ? { kind: 'paint' as const, color: clean } : nextFinishes.walls
    applyModel({ ...model, finishes: { ...nextFinishes, wallPaint: clean, walls: nextWalls } })
  }

  const updatePaintColor = (color: string) => {
    const clean = cleanColor(color, DEFAULT_WALL_PAINT)
    if (surfaceTarget === 'walls') updateWallPaint(clean)
    else updateSurface({ kind: 'paint', color: clean })
  }

  const clearSelectedWallFinish = () => {
    if (!effectiveSelectedWallKey) return
    const nextFinishes = normalizeFinishes(model.finishes)
    const nextWallFinishes = { ...nextFinishes.wallFinishes }
    delete nextWallFinishes[effectiveSelectedWallKey]
    applyModel({ ...model, finishes: { ...nextFinishes, wallFinishes: nextWallFinishes } })
  }

  const updateTile = (patch: Partial<SketchTileFinish>) => {
    const tile = normalizeTileSurface(activeSurface)
    updateSurface({ ...tile, ...patch, kind: 'tile' })
  }

  const selectCatalogTile = (item: CatalogItem) => {
    const patch = catalogTileFinishPatch(item)
    if (!patch) return
    updateTile(patch)
    setTileSourceMode('catalog')
  }

  const updateSelectedShowerPanFinish = (finish?: SketchTileFinish) => {
    if (!selectedShowerPan) return
    applyPlacedItems(placedItems.map((item) => {
      if (item.id !== selectedShowerPan.placed.id) return item
      const next = { ...item }
      if (finish) next.panFinish = normalizeTileSurface(finish)
      else delete next.panFinish
      return next
    }))
  }

  const selectShowerPanCatalogTile = (item: CatalogItem) => {
    const patch = catalogTileFinishPatch(item)
    if (!patch) return
    updateSelectedShowerPanFinish(normalizeTileSurface({ ...patch, kind: 'tile' }))
  }

  const selectManualTileSource = () => {
    setTileSourceMode('manual')
    if (!activeTile.catalogItemId && !activeTile.catalogPhotoPath && !activeTile.catalogItemName) return
    updateTile({ catalogItemId: undefined, catalogItemName: undefined, catalogPhotoPath: undefined })
  }

  const updateFinishCoverage = (patch: Partial<NonNullable<SketchTileFinish['coverage']>>) => {
    if (activeSurface.kind === 'drywall-patch') return
    const current = activeSurface.coverage?.mode === 'partial'
      ? activeSurface.coverage
      : { mode: 'partial' as const, bottomFt: 0, heightFt: Math.min(4, heightFt), regions: [] }
    if (patch.mode === 'full') {
      updateSurface({
        ...activeSurface,
        coverage: { mode: 'full' as const },
      })
      return
    }
    updateSurface({
      ...activeSurface,
      coverage: {
        ...current,
        ...patch,
        mode: 'partial' as const,
        regions: patch.regions ?? current.regions ?? [],
      },
    })
  }

  const updateDrywallPatch = (patch: Partial<SketchDrywallPatchFinish>) => {
    updateSurface({ ...activeDrywallPatch, ...patch, kind: 'drywall-patch' })
  }

  const setInchDraft = (field: InchDraftField, value: string) => {
    setInchDrafts((current) => ({ ...current, [field]: value }))
  }

  const inchInputValue = (field: InchDraftField, fallback: number): string => {
    return inchDrafts[field] ?? formatInches(fallback)
  }

  const commitInchDraft = (field: InchDraftField, fallback: number, min: number, max: number) => {
    const raw = inchDrafts[field] ?? formatInches(fallback)
    const parsed = parseInches(raw)
    setInchDrafts((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
    if (!Number.isFinite(parsed)) return
    updateTile({ [field]: clampNumber(parsed, min, max) } as Partial<SketchTileFinish>)
  }

  const handleInchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, field: InchDraftField, fallback: number, min: number, max: number) => {
    if (event.key === 'Enter') {
      commitInchDraft(field, fallback, min, max)
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      setInchDrafts((current) => {
        const next = { ...current }
        delete next[field]
        return next
      })
      event.currentTarget.blur()
    }
  }

  const setFeetDraft = (field: FeetDraftField, value: string) => {
    setFeetDrafts((current) => ({ ...current, [field]: value }))
  }

  const feetInputValue = (field: FeetDraftField, fallback: number): string => {
    return feetDrafts[field] ?? formatFeet(fallback)
  }

  const commitFeetDraft = (field: FeetDraftField, fallback: number, min: number, max: number, update: (value: number) => void) => {
    const raw = feetDrafts[field] ?? formatFeet(fallback)
    const parsed = parseFeetInches(raw)
    setFeetDrafts((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
    if (!Number.isFinite(parsed)) return
    update(clampNumber(parsed / 12, min, max))
  }

  const handleFeetKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, field: FeetDraftField, fallback: number, min: number, max: number, update: (value: number) => void) => {
    if (event.key === 'Enter') {
      commitFeetDraft(field, fallback, min, max, update)
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      setFeetDrafts((current) => {
        const next = { ...current }
        delete next[field]
        return next
      })
      event.currentTarget.blur()
    }
  }

  const openingDefaultValue = (field: OpeningDefaultDraftField, fallback: number): string => {
    return openingDefaultDrafts[field] ?? formatOpeningFeet(fallback)
  }

  const setOpeningDefaultDraft = (field: OpeningDefaultDraftField, value: string) => {
    setOpeningDefaultDrafts((current) => ({ ...current, [field]: value }))
  }

  const clearOpeningDefaultDraft = (field: OpeningDefaultDraftField) => {
    setOpeningDefaultDrafts((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  const commitOpeningDefaultDraft = (field: OpeningDefaultDraftField, fallback: number, min: number, max: number) => {
    if (!onOpeningDefaultsChange) return
    const raw = openingDefaultDrafts[field] ?? formatOpeningFeet(fallback)
    clearOpeningDefaultDraft(field)
    const parsed = parseFeetInches(raw)
    if (!Number.isFinite(parsed)) return
    onOpeningDefaultsChange({ [field]: Math.max(min, Math.min(max, snapOpeningFeetToPrecision(parsed / 12))) })
  }

  const handleOpeningDefaultKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, field: OpeningDefaultDraftField, fallback: number, min: number, max: number) => {
    if (event.key === 'Enter') {
      commitOpeningDefaultDraft(field, fallback, min, max)
      event.currentTarget.blur()
    } else if (event.key === 'Escape') {
      clearOpeningDefaultDraft(field)
      event.currentTarget.blur()
    }
  }

  const addLightAt = (kind: SketchLightKind, xFt: number, zFt: number): SketchLight => ({
    id: makeId('light'),
    kind,
    name: `${lightKindLabel(t, kind)} ${lights.length + 1}`,
    xFt,
    zFt,
  })

  const openingAtWall = (kind: OpeningPlacementKind, c: number, s: number, rawT: number): Opening => {
    const defaults = {
      doorW: openingDefaults?.doorW ?? DEFAULT_DOOR_WIDTH_FT,
      doorH: openingDefaults?.doorH ?? DEFAULT_DOOR_HEIGHT_FT,
      winW: openingDefaults?.winW ?? DEFAULT_WINDOW_WIDTH_FT,
      winH: openingDefaults?.winH ?? DEFAULT_WINDOW_HEIGHT_FT,
      winSill: openingDefaults?.winSill ?? DEFAULT_WINDOW_SILL_FT,
    }
    const draft: Opening =
      kind === 'door'
        ? {
            kind: 'door',
            c,
            s,
            t: rawT,
            w: Math.max(0.5, snapOpeningFeetToPrecision(defaults.doorW)),
            h: Math.max(0.5, snapOpeningFeetToPrecision(defaults.doorH)),
          }
        : kind === 'opening'
          ? {
              // OPENINGS-DRAG-TYPES-27: сквозной вырез без полотна.
              kind: 'opening',
              c,
              s,
              t: rawT,
              w: Math.max(0.5, snapOpeningFeetToPrecision(DEFAULT_OPENING_WIDTH_FT)),
              h: Math.max(0.5, snapOpeningFeetToPrecision(DEFAULT_OPENING_HEIGHT_FT)),
              sill: Math.max(0, snapOpeningFeetToPrecision(DEFAULT_OPENING_SILL_FT)),
            }
          : {
              kind: 'window',
              c,
              s,
              t: rawT,
              w: Math.max(0.5, snapOpeningFeetToPrecision(defaults.winW)),
              h: Math.max(0.5, snapOpeningFeetToPrecision(defaults.winH)),
              sill: Math.max(0, snapOpeningFeetToPrecision(defaults.winSill)),
              winType: DEFAULT_WINDOW_TYPE,
            }
    return { ...draft, t: snapOpeningT(model, draft, rawT, snapStepFt) }
  }

  const removeSelected = () => {
    if (!selectedId) return
    const openingIndex = openingIndexFromId(selectedId)
    if (openingIndex !== null) {
      if (!model.openings[openingIndex]) return
      applyModel({
        ...model,
        openings: model.openings.filter((_, index) => index !== openingIndex),
      })
      setSelectedId(null)
      return
    }
    const measurementIndex = measurementIndexFromId(selectedId)
    if (measurementIndex !== null) {
      if (!measurements[measurementIndex]) return
      applyMeasurements(measurements.filter((_, index) => index !== measurementIndex))
      setSelectedId(null)
      measure3DDraftRef.current = null
      return
    }
    const nextPlaced = placedItems.filter((item) => item.id !== selectedId)
    const next: Sketch3DModelWithCatalog = {
      ...model,
      lights: lights.filter((light) => light.id !== selectedId),
      switches: switches
        .filter((sw) => sw.id !== selectedId)
        .map((sw) => ({ ...sw, controls: (sw.controls ?? []).filter((id) => id !== selectedId) })),
    }
    if (nextPlaced.length > 0) next.placedItems = nextPlaced
    else delete next.placedItems
    applyModel(next)
    setSelectedId(null)
  }

  const rotateSelectedPlaced = () => {
    if (!selectedPlaced) return
    applyPlacedItems(placedItems.map((item) => (item.id === selectedPlaced.placed.id ? rotatePlacedCatalogItem(item) : item)))
  }

  const selectCatalogPlacement = (item: CatalogItem) => {
    if (!catalogItemHasExactDims(item)) return
    if (isBuiltinShowerPanCatalogItem(item)) {
      const nextPlaced = createShowerPanPlacedCatalogItem(
        item,
        makeId('placed'),
        model,
        WALL_THICKNESS_FT,
        showerPanShapeFromCatalogItem(item) === 'neo-angle' ? t('hub_sketch_shower_pan_neo') : t('hub_sketch_shower_pan_rect'),
      )
      if (!nextPlaced) return
      setMeasure3DActive(false)
      measure3DDraftRef.current = null
      setCatalogPlacementId(null)
      setPlacement(null)
      onModelChange?.({ ...model, placedItems: [...placedItems, nextPlaced] })
      setSelectedId(nextPlaced.id)
      return
    }
    setMeasure3DActive(false)
    measure3DDraftRef.current = null
    setCatalogPlacementId((current) => (current === item.id ? null : item.id))
    setPlacement(null)
    setSelectedId(null)
  }

  const updateSwitchControls = (switchId: string, lightId: string, checked: boolean) => {
    applyModel({
      ...model,
      switches: switches.map((sw) => {
        if (sw.id !== switchId) return sw
        const current = new Set(sw.controls ?? [])
        if (checked) current.add(lightId)
        else current.delete(lightId)
        return { ...sw, controls: Array.from(current) }
      }),
    })
  }

  useEffect(() => {
    let mounted = true
    setCatalogLoading(true)
    setCatalogError(false)
    getCatalogItems()
      .then((rows) => {
        if (mounted) setCatalogItems(withBuiltinCatalogItems(rows))
      })
      .catch(() => {
        if (mounted) {
          setCatalogItems(withBuiltinCatalogItems([]))
          setCatalogError(false)
        }
      })
      .finally(() => {
        if (mounted) setCatalogLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!canEdit || (!selectedPlaced && !selectedElectrical && !selectedOpening && !selectedMeasurement && !measure3DActive)) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return
      if (event.key === 'Escape' && measure3DActive) {
        setMeasure3DActive(false)
        measure3DDraftRef.current = null
        event.preventDefault()
      } else if (selectedPlaced && event.key.toLowerCase() === 'r') {
        rotateSelectedPlaced()
        event.preventDefault()
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        removeSelected()
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canEdit, selectedPlaced, selectedElectrical, selectedOpening, selectedMeasurement, measure3DActive, placedItems, selectedId, model.openings, measurements])

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === fullscreenRootRef.current
      setBrowserFullscreen(active)
      if (active) setFullscreenFallback(false)
      invalidate3DRef.current?.()
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    if (!fullscreenFallback) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFullscreenFallback(false)
        invalidate3DRef.current?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullscreenFallback])

  useEffect(() => {
    dimensionsVisibleRef.current = showDimensions
    if (dimensionGroupRef.current) dimensionGroupRef.current.visible = showDimensions
    invalidate3DRef.current?.()
  }, [showDimensions])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let cleanup: (() => void) | null = null
    setState('loading')

    loadThreeRuntime()
      .then(([THREE, { OrbitControls }]) => {
        if (disposed || !hostRef.current) return

        const currentHost = hostRef.current
        currentHost.replaceChildren()

        const renderer = new THREE.WebGLRenderer({ antialias: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        renderer.outputColorSpace = THREE.SRGBColorSpace
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.toneMappingExposure = 1.02
        renderer.setClearColor(0x0d1522, 1)
        renderer.shadowMap.enabled = false
        currentHost.appendChild(renderer.domElement)
        const textureLoader = new THREE.TextureLoader()
        textureLoader.setCrossOrigin?.('anonymous')
        const maxAnisotropy = renderer.capabilities?.getMaxAnisotropy?.() ?? 4

        const scene = new THREE.Scene()
        scene.background = new THREE.Color(0x0d1522)

        const cellFt = modelCellFt(model)
        const bounds = modelBounds(model)
        const insideRoom = largestClosedContour(model)
        const insideObstacles = insideCatalogObstacles(resolvedPlacedItems)
        const insideStart = findInsideStartWorld(model, insideRoom, bounds, insideObstacles)
        const height = Number.isFinite(heightFt) && heightFt > 0 ? heightFt : DEFAULT_WALL_HEIGHT_FT
        const span = Math.max(bounds.width, bounds.depth, height, 12)
        const centerX = bounds.minX + bounds.width / 2
        const centerZ = bounds.minZ + bounds.depth / 2
        const orbitFov = fullscreenActive ? FULLSCREEN_FOV_DEG : ORBIT_FOV_DEG
        const insideFov = fullscreenActive ? FULLSCREEN_FOV_DEG : INSIDE_FOV_DEG
        const fitPad = sketch3dFitPad(span)
        const sceneMinX = bounds.minX - WALL_THICKNESS_FT / 2 - fitPad
        const sceneMaxX = bounds.maxX + WALL_THICKNESS_FT / 2 + fitPad
        const sceneMinZ = bounds.minZ - WALL_THICKNESS_FT / 2 - fitPad
        const sceneMaxZ = bounds.maxZ + WALL_THICKNESS_FT / 2 + fitPad
        const sceneCenter = new THREE.Vector3(centerX, height / 2, centerZ)
        const sceneCorners = [
          new THREE.Vector3(sceneMinX, 0, sceneMinZ),
          new THREE.Vector3(sceneMinX, 0, sceneMaxZ),
          new THREE.Vector3(sceneMaxX, 0, sceneMinZ),
          new THREE.Vector3(sceneMaxX, 0, sceneMaxZ),
          new THREE.Vector3(sceneMinX, height, sceneMinZ),
          new THREE.Vector3(sceneMinX, height, sceneMaxZ),
          new THREE.Vector3(sceneMaxX, height, sceneMinZ),
          new THREE.Vector3(sceneMaxX, height, sceneMaxZ),
        ]
        const paddedWidth = sceneMaxX - sceneMinX
        const paddedDepth = sceneMaxZ - sceneMinZ
        const floorRadius = Math.hypot(paddedWidth, paddedDepth) / 2
        const sceneRadius = Math.hypot(paddedWidth, paddedDepth, height) / 2
        const minCameraDistance = Math.max(6, height * 1.05, floorRadius * 1.12)
        const maxCameraDistance = Math.max(minCameraDistance + span * 2, sceneRadius * 8, 60)
        const camera = new THREE.PerspectiveCamera(orbitFov, 1, 0.1, Math.max(300, maxCameraDistance * 4))

        const controls = new OrbitControls(camera, renderer.domElement)
        controls.enableDamping = true
        controls.dampingFactor = 0.08
        controls.enablePan = true
        controls.enableZoom = true
        controls.panSpeed = 0.8
        controls.zoomSpeed = 0.85
        controls.screenSpacePanning = true
        controls.target.copy(sceneCenter)
        controls.minDistance = minCameraDistance
        controls.maxDistance = maxCameraDistance
        controls.mouseButtons = {
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.PAN,
        }
        controls.touches = {
          ONE: THREE.TOUCH.ROTATE,
          TWO: THREE.TOUCH.DOLLY_PAN,
        }

        let frame = 0
        let renderQueued = false
        function invalidate() {
          if (disposed || renderQueued) return
          renderQueued = true
          frame = window.requestAnimationFrame(renderFrame)
        }
        function renderFrame() {
          if (disposed) return
          renderQueued = false
          const orbitChanged = controls.enabled ? controls.update() : false
          const clamped = controls.enabled ? clampCameraTarget() : false
          renderer.render(scene, camera)
          if (controls.enabled && (orbitChanged || clamped)) invalidate()
        }
        invalidate3DRef.current = invalidate
        controls.addEventListener('change', invalidate)

        const setCameraUp = (top: boolean) => {
          camera.up.set(0, top ? 0 : 1, top ? -1 : 0)
        }

        const distanceForDirection = (direction: any): number => {
          const viewDir = direction.clone().normalize()
          camera.position.copy(sceneCenter).addScaledVector(viewDir, 1)
          setCameraUp(Math.abs(viewDir.y) > 0.96)
          camera.lookAt(sceneCenter)
          camera.updateMatrixWorld()
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
          let halfW = 0
          let halfH = 0
          let depthHalf = 0
          sceneCorners.forEach((corner: any) => {
            const rel = corner.clone().sub(sceneCenter)
            halfW = Math.max(halfW, Math.abs(rel.dot(right)))
            halfH = Math.max(halfH, Math.abs(rel.dot(up)))
            depthHalf = Math.max(depthHalf, Math.abs(rel.dot(viewDir)))
          })
          const vFov = THREE.MathUtils.degToRad(camera.fov)
          return sketch3dFitDistanceForExtents({
            halfWidthFt: halfW,
            halfHeightFt: halfH,
            depthHalfFt: depthHalf,
            verticalFovRad: vFov,
            aspect: camera.aspect,
            minCameraDistanceFt: minCameraDistance,
            maxCameraDistanceFt: maxCameraDistance,
          })
        }

        let insideMode = false
        let insideYaw = insideStartYaw(model, insideRoom, cellFt, bounds, insideObstacles, insideStart)
        let insidePitch = 0
        const eyeY = Math.max(1.25, Math.min(EYE_HEIGHT_FT, Math.max(1.25, height - 0.25)))
        let insideJoystickVector = { strafe: 0, forward: 0 }
        let insideJoystickFrame = 0
        let insideJoystickLastTime = 0
        const insideStandingAt = (x: number, z: number) => evaluateInsideStanding(model, insideObstacles, x, z)
        const insideCanStandAt = (x: number, z: number) => insideStandingAt(x, z).valid
        const applyInsideLook = () => {
          camera.rotation.order = 'YXZ'
          camera.rotation.set(insidePitch, insideYaw, 0)
          camera.position.y = eyeY
          camera.updateMatrixWorld()
          invalidate()
        }
        const insideForwardVector = (): InsideVector => normalizeInsideVector(-Math.sin(insideYaw), -Math.cos(insideYaw))
        const insideRightVector = (): InsideVector => normalizeInsideVector(Math.cos(insideYaw), -Math.sin(insideYaw))
        const tryInsideMoveStep = (dx: number, dz: number): boolean => {
          const currentX = camera.position.x
          const currentZ = camera.position.z
          const target = insideStandingAt(currentX + dx, currentZ + dz)
          if (target.valid) {
            camera.position.x = currentX + dx
            camera.position.z = currentZ + dz
            return true
          }

          if (target.normal) {
            const dot = dx * target.normal.x + dz * target.normal.z
            const slideX = dx - target.normal.x * dot
            const slideZ = dz - target.normal.z * dot
            if (Math.hypot(slideX, slideZ) > 0.0001 && insideCanStandAt(currentX + slideX, currentZ + slideZ)) {
              camera.position.x = currentX + slideX
              camera.position.z = currentZ + slideZ
              return true
            }
          }

          if (Math.abs(dx) > 0.0001 && insideCanStandAt(currentX + dx, currentZ)) {
            camera.position.x = currentX + dx
            return true
          }
          if (Math.abs(dz) > 0.0001 && insideCanStandAt(currentX, currentZ + dz)) {
            camera.position.z = currentZ + dz
            return true
          }
          return false
        }
        const moveInsideCameraLocal = (strafeFt: number, forwardFt: number) => {
          if (!insideMode) return
          const forward = insideForwardVector()
          const right = insideRightVector()
          const dx = right.x * strafeFt + forward.x * forwardFt
          const dz = right.z * strafeFt + forward.z * forwardFt
          const distance = Math.hypot(dx, dz)
          if (distance <= 0.0001) return
          const steps = Math.max(1, Math.ceil(distance / INSIDE_MOVE_STEP_FT))
          let moved = false
          for (let i = 0; i < steps; i++) {
            if (!tryInsideMoveStep(dx / steps, dz / steps)) break
            moved = true
          }
          camera.position.y = eyeY
          if (moved) invalidate()
        }
        const moveInsideCamera = (amount: number) => {
          if (!insideMode || Math.abs(amount) <= 0.001) return
          moveInsideCameraLocal(0, amount)
        }
        const stopInsideJoystick = () => {
          insideJoystickVector = { strafe: 0, forward: 0 }
          insideJoystickLastTime = 0
          if (insideJoystickFrame) {
            window.cancelAnimationFrame(insideJoystickFrame)
            insideJoystickFrame = 0
          }
        }
        const runInsideJoystick = (time: number) => {
          insideJoystickFrame = 0
          const magnitude = Math.hypot(insideJoystickVector.strafe, insideJoystickVector.forward)
          if (!insideMode || magnitude <= 0.01) {
            stopInsideJoystick()
            return
          }
          const dt = insideJoystickLastTime ? Math.min(0.05, Math.max(0, (time - insideJoystickLastTime) / 1000)) : 1 / 60
          insideJoystickLastTime = time
          moveInsideCameraLocal(
            insideJoystickVector.strafe * INSIDE_JOYSTICK_SPEED_FTPS * dt,
            insideJoystickVector.forward * INSIDE_JOYSTICK_SPEED_FTPS * dt,
          )
          insideJoystickFrame = window.requestAnimationFrame(runInsideJoystick)
        }
        const startInsideJoystick = () => {
          if (!insideJoystickFrame) insideJoystickFrame = window.requestAnimationFrame(runInsideJoystick)
        }
        insideMoveApiRef.current = {
          setJoystickVector: (strafe: number, forward: number) => {
            const magnitude = Math.hypot(strafe, forward)
            const scale = magnitude > 1 ? 1 / magnitude : 1
            insideJoystickVector = { strafe: strafe * scale, forward: forward * scale }
            if (magnitude > 0.01) startInsideJoystick()
            else stopInsideJoystick()
          },
          stopJoystick: stopInsideJoystick,
        }
        const enterInsideCamera = () => {
          insideMode = true
          controls.enabled = false
          setCameraUp(false)
          camera.fov = insideFov
          camera.near = 0.05
          camera.far = Math.max(300, maxCameraDistance * 4)
          insideYaw = insideStartYaw(model, insideRoom, cellFt, bounds, insideObstacles, insideStart)
          insidePitch = 0
          camera.position.set(insideStart.x, eyeY, insideStart.z)
          if (!insideCanStandAt(camera.position.x, camera.position.z)) {
            const fallback = { x: centerX, z: centerZ }
            if (insideCanStandAt(fallback.x, fallback.z)) camera.position.set(fallback.x, eyeY, fallback.z)
          }
          camera.updateProjectionMatrix()
          applyInsideLook()
        }

        const fitCamera = (preset: CameraPreset = 'fit') => {
          insideMode = false
          stopInsideJoystick()
          resetInsidePointers()
          // NAV-FIX-2: рулетка НЕ должна отключать орбиту/зум — осмотр сцены остаётся свободным.
          controls.enabled = true
          camera.fov = orbitFov
          const direction =
            preset === 'top'
              ? new THREE.Vector3(0.001, 1, 0.001).normalize()
              : new THREE.Vector3(0.78, 0.52, 0.86).normalize()
          const distance = distanceForDirection(direction)
          setCameraUp(preset === 'top')
          controls.target.copy(sceneCenter)
          camera.position.copy(sceneCenter).addScaledVector(direction, distance)
          camera.lookAt(sceneCenter)
          camera.near = Math.max(0.05, minCameraDistance / 80)
          camera.far = Math.max(300, maxCameraDistance * 4)
          camera.updateProjectionMatrix()
          controls.update()
          invalidate()
        }

        cameraApiRef.current = {
          fit: () => fitCamera('fit'),
          top: () => fitCamera('top'),
          angle: () => fitCamera('angle'),
          inside: enterInsideCamera,
        }
        controls.update()

        scene.add(new THREE.HemisphereLight(0xf8fbff, 0xd3c8bb, 1.1))
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.18)
        keyLight.position.set(centerX - span * 0.5, height + span * 0.95, centerZ + span * 0.58)
        keyLight.castShadow = false
        scene.add(keyLight)

        const gridSize = Math.max(24, Math.ceil(span + 8))
        const ground = new THREE.Mesh(
          new THREE.PlaneGeometry(gridSize, gridSize),
          new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.9 }),
        )
        ground.rotation.x = -Math.PI / 2
        ground.position.set(centerX, -0.04, centerZ)
        ground.receiveShadow = false
        scene.add(ground)

        const grid = new THREE.GridHelper(gridSize, gridSize, 0xaeb8c4, 0xd9dee7)
        grid.position.set(centerX, -0.02, centerZ)
        scene.add(grid)

        const floorTargets: any[] = [ground]
        const wallTargets: any[] = []
        const wallMeshByKey = new Map<string, any>()
        const itemTargets: any[] = []
        const dimensionGroup = new THREE.Group()
        dimensionGroup.visible = dimensionsVisibleRef.current
        scene.add(dimensionGroup)
        dimensionGroupRef.current = dimensionGroup
        const ceilingGroup = new THREE.Group()
        ceilingGroup.visible = cameraMode === 'inside' || showCeiling
        scene.add(ceilingGroup)
        ceilingVisibilityApiRef.current = {
          setVisible: (visible: boolean) => {
            ceilingGroup.visible = visible
            invalidate()
          },
        }
        const wallSurface = finishes.walls.kind === 'paint'
          ? { kind: 'paint' as const, color: cleanColor(finishes.walls.color, finishes.wallPaint) }
          : finishes.walls
        const floorMaterial = createFloorMaterial(THREE, finishes.floor, textureLoader, maxAnisotropy, invalidate)
        const ceilingMaterial = new THREE.MeshStandardMaterial({
          color: 0xf8fafc,
          roughness: 0.78,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.94,
        })
        const doorMaterial = new THREE.MeshStandardMaterial({ color: 0xb86b24, roughness: 0.62 })
        const windowMaterial = new THREE.MeshStandardMaterial({
          color: 0x2f80d1,
          emissive: 0x0b355d,
          emissiveIntensity: 0.08,
          roughness: 0.36,
          metalness: 0.08,
        })
        const windowPaneMaterial = new THREE.MeshStandardMaterial({
          color: 0x9bd5ff,
          roughness: 0.18,
          metalness: 0.02,
          transparent: true,
          opacity: 0.42,
          depthWrite: false,
        })
        const openingPickMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.01, depthWrite: false })
        // OPENINGS-DRAG-TYPES-27: нейтральный откос для проёма-выреза без полотна.
        const passthroughMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.82, metalness: 0.02 })
        model.contours.forEach((contour) => {
          if (!contour.closed || contour.points.length < 3) return
          const shape = new THREE.Shape()
          contour.points.forEach((p, index) => {
            const x = p.x * cellFt
            const y = p.y * cellFt
            if (index === 0) shape.moveTo(x, y)
            else shape.lineTo(x, y)
          })
          shape.closePath()
          const geometry = new THREE.ShapeGeometry(shape)
          applyFloorTileUv(geometry, finishes.floor)
          geometry.rotateX(Math.PI / 2)
          const floor = new THREE.Mesh(geometry, floorMaterial)
          floor.position.y = 0.015
          floor.receiveShadow = false
          scene.add(floor)
          floorTargets.push(floor)

          const ceilingGeometry = new THREE.ShapeGeometry(shape)
          ceilingGeometry.rotateX(Math.PI / 2)
          const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial)
          ceiling.position.y = height - 0.015
          ceiling.castShadow = false
          ceiling.receiveShadow = false
          ceilingGroup.add(ceiling)
        })

        const sharedWallOccurrences = new Map<string, number>()
        eachSegment(model).forEach((seg) => {
          const a = { x: seg.a.x * cellFt, z: seg.a.y * cellFt }
          const b = { x: seg.b.x * cellFt, z: seg.b.y * cellFt }
          const dx = b.x - a.x
          const dz = b.z - a.z
          const len = Math.hypot(dx, dz)
          if (len <= 0.01) return
          const occurrenceKey = segmentSharedKey(seg)
          const occurrence = sharedWallOccurrences.get(occurrenceKey) ?? 0
          sharedWallOccurrences.set(occurrenceKey, occurrence + 1)
          const wallOffsetFt = occurrence === 0 ? 0 : 0.012 * Math.ceil(occurrence / 2) * (occurrence % 2 === 1 ? 1 : -1)
          const wallFinish = finishes.wallFinishes[sketchWallKey(seg.c, seg.s)] ?? wallSurface
          const wallPlan = buildSketch3DWallPlan(model, seg, height)
          const wallObject = wallPlan.openings.length > 0
            ? new THREE.Group()
            : new THREE.Mesh(new THREE.BoxGeometry(len, height, WALL_THICKNESS_FT), createWallMaterial(THREE, wallFinish, len, height, finishes.wallPaint, textureLoader, maxAnisotropy, invalidate))
          wallObject.position.set((a.x + b.x) / 2 + (-dz / len) * wallOffsetFt, height / 2, (a.z + b.z) / 2 + (dx / len) * wallOffsetFt)
          wallObject.rotation.y = -Math.atan2(dz, dx)
          wallObject.userData.wallC = seg.c
          wallObject.userData.wallS = seg.s

          if (wallPlan.openings.length > 0) {
            wallPlan.pieces.forEach((piece) => {
              const pieceWidth = Math.max(0.02, piece.endFt - piece.startFt)
              const pieceHeight = Math.max(0.02, piece.topFt - piece.bottomFt)
              const pieceMesh = new THREE.Mesh(
                new THREE.BoxGeometry(pieceWidth, pieceHeight, WALL_THICKNESS_FT),
                createWallMaterial(THREE, wallFinish, pieceWidth, pieceHeight, finishes.wallPaint, textureLoader, maxAnisotropy, invalidate),
              )
              pieceMesh.position.set(
                piece.startFt + pieceWidth / 2 - len / 2,
                piece.bottomFt + pieceHeight / 2 - height / 2,
                0,
              )
              pieceMesh.castShadow = false
              pieceMesh.receiveShadow = false
              pieceMesh.userData.wallC = seg.c
              pieceMesh.userData.wallS = seg.s
              addWallPieceFinishOverlay(THREE, pieceMesh, wallFinish, len, height, piece, finishes.wallPaint, textureLoader, maxAnisotropy, invalidate)
              wallObject.add(pieceMesh)
            })
          } else {
            wallObject.castShadow = false
            wallObject.receiveShadow = false
            addWallFinishOverlay(THREE, wallObject, wallFinish, len, height, finishes.wallPaint, textureLoader, maxAnisotropy, invalidate)
          }

          scene.add(wallObject)
          wallTargets.push(wallObject)
          wallMeshByKey.set(sketchWallKey(seg.c, seg.s), wallObject)

          let nx = -dz / len
          let nz = dx / len
          const contour = model.contours[seg.c]
          if (contour?.points.length) {
            const contourCenter = contourCenterWorld(contour, cellFt)
            const midX = (a.x + b.x) / 2
            const midZ = (a.z + b.z) / 2
            if ((contourCenter.x - midX) * nx + (contourCenter.z - midZ) * nz > 0) {
              nx *= -1
              nz *= -1
            }
          }
          addDimensionLineGroup(
            THREE,
            dimensionGroup,
            a,
            b,
            height,
            nx,
            nz,
            formatFeet(len),
            formatFeet(height),
          )
        })

        // NAV-FIX-2: подсветка выбранной стены — контур-обводка поверх меша, добавляется/снимается
        // без пересоздания сцены (иначе камера/рулетка сбивались бы при каждом выборе).
        let wallHighlight: any = null
        const setWallHighlight = (key: string | null) => {
          if (wallHighlight) {
            scene.remove(wallHighlight)
            wallHighlight.traverse?.((object: { geometry?: unknown; material?: unknown }) => disposeObjectWithMaterial(object))
            wallHighlight = null
          }
          const mesh = key ? wallMeshByKey.get(key) : null
          if (mesh) {
            const highlight = new THREE.Group()
            const addEdges = (child: any) => {
              if (!child.geometry) return
              child.updateWorldMatrix?.(true, false)
              const edges = new THREE.LineSegments(
                new THREE.EdgesGeometry(child.geometry),
                new THREE.LineBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.95, depthTest: false }),
              )
              child.getWorldPosition?.(edges.position)
              child.getWorldQuaternion?.(edges.quaternion)
              child.getWorldScale?.(edges.scale)
              edges.renderOrder = 999
              highlight.add(edges)
            }
            if (mesh.traverse) mesh.traverse(addEdges)
            else addEdges(mesh)
            if (highlight.children.length > 0) {
              scene.add(highlight)
              wallHighlight = highlight
            }
          }
          invalidate()
        }
        wallHighlightApiRef.current = { setSelected: setWallHighlight }
        setWallHighlight(pickedWallKeyRef.current)

        const applyOpeningPose = (object: any, opening: Opening) => {
          const metrics = openingMetrics(model, opening, height)
          if (!metrics) return null
          object.position.set(metrics.centerX, 0, metrics.centerZ)
          object.rotation.y = metrics.rotationY
          return metrics
        }

        model.openings.forEach((opening, index) => {
          const metrics = openingMetrics(model, opening, height)
          if (!metrics) return
          const group = new THREE.Group()
          group.position.set(metrics.centerX, 0, metrics.centerZ)
          group.rotation.y = metrics.rotationY
          const trim = Math.max(0.055, Math.min(0.12, metrics.width * 0.045))
          const frameDepth = 0.12
          // OPENINGS-DRAG-TYPES-27: проём-вырез — нейтральный откос без полотна.
          const frameMaterial = opening.kind === 'door' ? doorMaterial : opening.kind === 'opening' ? passthroughMaterial : windowMaterial
          const addFramePiece = (width: number, frameHeight: number, x: number, y: number) => {
            const frame = new THREE.Mesh(new THREE.BoxGeometry(width, frameHeight, frameDepth), frameMaterial)
            frame.position.set(x, y, 0)
            frame.castShadow = false
            frame.receiveShadow = false
            group.add(frame)
            return frame
          }
          addFramePiece(trim, metrics.height, -metrics.width / 2 + trim / 2, metrics.sill + metrics.height / 2)
          addFramePiece(trim, metrics.height, metrics.width / 2 - trim / 2, metrics.sill + metrics.height / 2)
          addFramePiece(metrics.width, trim, 0, metrics.sill + metrics.height - trim / 2)
          if (opening.kind === 'opening') {
            // Сквозной вырез: тонкий нижний откос (если приподнят над полом), без стекла.
            addFramePiece(metrics.width, trim, 0, metrics.sill + trim / 2)
          } else if (opening.kind === 'window') {
            addFramePiece(metrics.width, trim, 0, metrics.sill + trim / 2)
            const paneWidth = Math.max(0.02, metrics.width - trim * 2)
            const paneHeight = Math.max(0.02, metrics.height - trim * 2)
            const pane = new THREE.Mesh(new THREE.BoxGeometry(paneWidth, paneHeight, 0.035), windowPaneMaterial)
            pane.position.set(0, metrics.sill + metrics.height / 2, 0)
            pane.castShadow = false
            pane.receiveShadow = false
            group.add(pane)
            // OPENINGS-DRAG-TYPES-27: тип окна различим в 3D — переплёт/створка.
            const winType: WindowType = opening.winType ?? DEFAULT_WINDOW_TYPE
            const barY = metrics.sill + metrics.height / 2
            if (winType === 'double') {
              // Двойное: центральный вертикальный переплёт (две створки).
              addFramePiece(trim * 0.85, Math.max(0.02, metrics.height - trim * 2), 0, barY)
            } else if (winType === 'casement') {
              // Створчатое одинарное: тонкая ручка-марка створки сбоку.
              addFramePiece(trim * 0.7, Math.max(0.02, metrics.height * 0.24), metrics.width * 0.3, barY)
            }
          }
          const pickFace = new THREE.Mesh(
            new THREE.BoxGeometry(metrics.width, metrics.height, 0.025),
            openingPickMaterial,
          )
          pickFace.position.set(0, metrics.sill + metrics.height / 2, 0)
          pickFace.castShadow = false
          pickFace.receiveShadow = false
          pickFace.renderOrder = 3
          group.add(pickFace)
          if (selectedId === openingInteractiveId(index)) {
            addMeshWithEdges(THREE, group, pickFace, opening.kind === 'door' ? 0x7c2d12 : opening.kind === 'opening' ? 0x0f766e : 0x1d4ed8, 0.95)
            const sprite = createLabelSprite(THREE, `${openingName(opening, index, t)}\n${openingDimensionText(opening, metrics, t)}`)
            sprite.position.set(metrics.centerX + metrics.nx * 0.34, metrics.sill + metrics.height + 0.48, metrics.centerZ + metrics.nz * 0.34)
            scene.add(sprite)
            scene.add(createOpeningDimensionGroup(THREE, opening, metrics, t))
          }
          tagInteractive(group, 'opening', openingInteractiveId(index))
          scene.add(group)
          itemTargets.push(group)
        })

        const addLightGroup = (light: SketchLight, index: number) => {
          const group = new THREE.Group()
          const isWall = light.kind === 'sconce'
          const anchor = isWall && Number.isInteger(light.c) && Number.isInteger(light.s)
            ? wallAnchor(model, light.c ?? 0, light.s ?? 0, light.t ?? 0.5, Math.min(height - 0.8, light.heightFt ?? DEFAULT_SCONCE_HEIGHT_FT))
            : null

          if (isWall && anchor) {
            const plate = new THREE.Mesh(
              new THREE.BoxGeometry(0.42, 0.58, 0.12),
              new THREE.MeshStandardMaterial({ color: 0xd8c5a9, roughness: 0.48, metalness: 0.08 }),
            )
            const shade = new THREE.Mesh(
              new THREE.SphereGeometry(0.22, 18, 12),
              new THREE.MeshStandardMaterial({ color: 0xfff2c8, emissive: 0xffd57a, emissiveIntensity: 0.26, roughness: 0.42 }),
            )
            group.add(plate, shade)
            plate.position.set(0, 0, 0)
            shade.position.set(0, 0, 0.12)
            group.position.set(anchor.x + anchor.nx * (WALL_THICKNESS_FT / 2 + 0.08), anchor.y, anchor.z + anchor.nz * (WALL_THICKNESS_FT / 2 + 0.08))
            group.rotation.y = anchor.rotationY
            const glow = new THREE.PointLight(0xffe4ae, 0.65, 10)
            glow.position.set(anchor.x + anchor.nx * 0.45, anchor.y + 0.05, anchor.z + anchor.nz * 0.45)
            scene.add(glow)
          } else {
            const x = Number.isFinite(light.xFt) ? light.xFt ?? centerX : centerX
            const z = Number.isFinite(light.zFt) ? light.zFt ?? centerZ : centerZ
            group.position.set(x, height - 0.08, z)
            if (light.kind === 'recessed') {
              const trim = new THREE.Mesh(
                new THREE.CylinderGeometry(0.3, 0.3, 0.08, 28),
                new THREE.MeshStandardMaterial({ color: 0xf8fafc, emissive: 0xfff1c2, emissiveIntensity: 0.18, roughness: 0.35 }),
              )
              group.add(trim)
            } else if (light.kind === 'chandelier') {
              const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 12), new THREE.MeshStandardMaterial({ color: 0x3f352b, roughness: 0.5 }))
              const shade = new THREE.Mesh(
                new THREE.SphereGeometry(0.34, 24, 16),
                new THREE.MeshStandardMaterial({ color: 0xfff0c7, emissive: 0xffdc86, emissiveIntensity: 0.2, roughness: 0.32 }),
              )
              cord.position.y = -0.42
              shade.position.y = -0.9
              group.add(cord, shade)
            } else if (light.kind === 'fan') {
              const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.2, 18), new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.45 }))
              group.add(hub)
              for (let i = 0; i < 4; i++) {
                const blade = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.045, 0.2), new THREE.MeshStandardMaterial({ color: 0xa28261, roughness: 0.55 }))
                blade.position.x = 0.62
                blade.rotation.y = (Math.PI / 2) * i
                group.add(blade)
              }
            }
            const glow = new THREE.PointLight(0xffe8b5, light.kind === 'fan' ? 0.28 : 0.7, 14)
            glow.position.set(x, height - 0.7, z)
            scene.add(glow)
          }

          tagInteractive(group, 'light', light.id)
          scene.add(group)
          itemTargets.push(group)
          if (selectedId === light.id) {
            const sprite = createLabelSprite(THREE, lightName(light, index, t))
            sprite.position.copy(group.position)
            sprite.position.y += light.kind === 'chandelier' ? 0.45 : 0.62
            scene.add(sprite)
          }
        }

        lights.forEach(addLightGroup)

        switches.forEach((sw, index) => {
          const anchor = wallAnchor(model, sw.c, sw.s, sw.t, Math.min(height - 0.5, sw.heightFt ?? DEFAULT_SWITCH_HEIGHT_FT))
          if (!anchor) return
          const group = new THREE.Group()
          const plate = new THREE.Mesh(
            new THREE.BoxGeometry(0.34, 0.5, 0.075),
            new THREE.MeshStandardMaterial({ color: 0xf6f1e8, roughness: 0.36 }),
          )
          const toggle = new THREE.Mesh(
            new THREE.BoxGeometry(0.07, 0.22, 0.025),
            new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.3 }),
          )
          toggle.position.z = 0.055
          group.add(plate, toggle)
          group.position.set(anchor.x + anchor.nx * (WALL_THICKNESS_FT / 2 + 0.075), anchor.y, anchor.z + anchor.nz * (WALL_THICKNESS_FT / 2 + 0.075))
          group.rotation.y = anchor.rotationY
          tagInteractive(group, 'switch', sw.id)
          scene.add(group)
          itemTargets.push(group)
          if (selectedId === sw.id) {
            const names = (sw.controls ?? [])
              .map((id) => lights.findIndex((light) => light.id === id))
              .filter((i) => i >= 0)
              .map((i) => lightName(lights[i], i, t))
            const text = `${switchName(sw, index, t)}\n${t('hub_sketch_3d_controls')}: ${names.join(', ') || t('hub_sketch_3d_none')}`
            const sprite = createLabelSprite(THREE, text)
            sprite.position.copy(group.position)
            sprite.position.y += 0.72
            scene.add(sprite)
          }
        })

        placedItems.filter(isElectricalPlacedCatalogItem).forEach((placed) => {
          const isOutlet = isOutletPlacedCatalogItem(placed)
          const markerY = Math.max(0.4, Math.min(height - 0.35, Number.isFinite(placed.yFt) ? placed.yFt : isOutlet ? 1.5 : DEFAULT_SWITCH_HEIGHT_FT))
          const anchor = Number.isInteger(placed.c) && Number.isInteger(placed.s)
            ? wallAnchor(model, placed.c ?? 0, placed.s ?? 0, placed.t ?? 0.5, markerY)
            : null
          const group = new THREE.Group()
          const plate = new THREE.Mesh(
            new THREE.BoxGeometry(0.34, 0.42, 0.055),
            new THREE.MeshStandardMaterial({ color: isOutlet ? 0xe8f0ff : 0xfff4dc, roughness: 0.38 }),
          )
          group.add(plate)
          if (isOutlet) {
            const holeMaterial = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.42 })
            const leftHole = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.09, 0.016), holeMaterial)
            const rightHole = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.09, 0.016), holeMaterial)
            const ground = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.022, 0.016), holeMaterial)
            leftHole.position.set(-0.065, 0.04, 0.036)
            rightHole.position.set(0.065, 0.04, 0.036)
            ground.position.set(0, -0.105, 0.036)
            group.add(leftHole, rightHole, ground)
          } else {
            const toggle = new THREE.Mesh(
              new THREE.BoxGeometry(0.055, 0.22, 0.025),
              new THREE.MeshStandardMaterial({ color: 0x9a6a24, roughness: 0.3 }),
            )
            toggle.position.set(0.025, 0, 0.04)
            toggle.rotation.z = -0.16
            group.add(toggle)
          }
          if (anchor) {
            group.position.set(anchor.x + anchor.nx * (WALL_THICKNESS_FT / 2 + 0.07), anchor.y, anchor.z + anchor.nz * (WALL_THICKNESS_FT / 2 + 0.07))
            group.rotation.y = anchor.rotationY
          } else {
            group.position.set(placed.xFt, markerY, placed.zFt)
            group.rotation.y = placed.rotationY
          }
          tagInteractive(group, 'catalog', placed.id)
          scene.add(group)
          itemTargets.push(group)
          if (selectedId === placed.id) {
            addMeshWithEdges(THREE, group, plate, isOutlet ? 0x1d4ed8 : 0xb45309, 0.95)
            const sprite = createLabelSprite(THREE, electricalPlacedName(placed, t))
            sprite.position.copy(group.position)
            sprite.position.y += 0.46
            scene.add(sprite)
          }
        })

        const catalogWallLength = (placed: SketchPlacedCatalogItem): number | undefined => {
          if (!Number.isInteger(placed.c) || !Number.isInteger(placed.s)) return undefined
          const seg = segmentWorld(model, placed.c ?? 0, placed.s ?? 0)
          return seg ? dist(seg.a, seg.b) * cellFt : undefined
        }

        const applyCatalogObjectPose = (object: any, placed: SketchPlacedCatalogItem, centerYFt = placed.yFt) => {
          object.position.set(placed.xFt, centerYFt, placed.zFt)
          object.rotation.y = placed.rotationY
        }

        resolvedPlacedItems.forEach((resolved) => {
          const placed = resolved.placed
          const doesNotFit = placedCatalogDoesNotFit(placed, resolved.dims, bounds, height, catalogWallLength(placed))
          const codeWarn = codeWarningItemIds.has(placed.id)
          const visualWarn = doesNotFit || codeWarn
          const group = new THREE.Group()
          // CABINETS-VERTICAL-22: навесной шкаф ставим на отметку из wallGapIn (иначе прежний yFt/дефолт 18").
          const centerYFt = isCabinetPlacedItem(placed) && placed.layer === 'wall'
            ? wallCabinetCenterYFt(placed, resolved.heightIn)
            : placed.yFt
          applyCatalogObjectPose(group, placed, centerYFt)
          const edgeColor = visualWarn ? 0x991b1b : selectedId === placed.id ? 0x0f172a : 0xffffff
          const material = createCatalogMaterial(THREE, resolved, visualWarn, textureLoader, maxAnisotropy, invalidate)
          if (placed.surface === 'floor') addContactShadow(THREE, group, resolved.dims.widthFt, resolved.dims.depthFt, resolved.dims.heightFt)
          if (isToiletPlacedCatalogItem(placed)) {
            addToiletFixture(THREE, group, resolved, visualWarn, edgeColor)
          } else if (isCabinetPlacedItem(placed)) {
            addCabinetFixture(THREE, group, resolved, visualWarn, edgeColor)
          } else if (resolved.category === 'shower' && placed.surface === 'floor') {
            const panTileMaterial = placed.panFinish
              ? createPanTileMaterial(THREE, normalizeTileSurface(placed.panFinish), resolved.dims.widthFt, resolved.dims.depthFt, textureLoader, maxAnisotropy, invalidate)
              : null
            addShowerPan(THREE, group, resolved, material, edgeColor, panTileMaterial)
          } else if (isColumnPlacedCatalogItem(placed) && placed.column === 'round') {
            // ELEMENTS-INFRA-26: круглая колонна — цилиндр; квадратная колонна/короб — обычный бокс.
            addRoundColumn(THREE, group, resolved, material, edgeColor)
          } else if (isFurniturePlacedCatalogItem(placed)) {
            // APPLIANCES-28: мебель (стол/стул) — простой боксов/цилиндр силуэт (как COLUMN/BOX #26).
            addFurniture(THREE, group, resolved, placed.furnitureType, edgeColor)
          } else {
            addCatalogBox(THREE, group, resolved, material, edgeColor)
          }
          tagInteractive(group, 'catalog', placed.id)
          scene.add(group)
          itemTargets.push(group)

          if (selectedId === placed.id) {
            const codeWarning = codeClearanceViolations
              .filter((check) => check.subject.id === placed.id || check.target.id === placed.id)
              .map((check) => formatCodeClearanceMessage(check, t))[0]
            const warning = doesNotFit ? `\n${t('hub_sketch_3d_not_fit')}` : codeWarning ? `\n${codeWarning}` : ''
            const cabinetCode = isCabinetPlacedItem(placed) ? cabinetDisplayCode(placed) : ''
            const text = `${cabinetCode || resolvedCatalogDisplayName(resolved, t)}\n${resolvedCatalogDimsText(resolved)}${warning}`
            const sprite = createLabelSprite(THREE, text)
            sprite.position.set(placed.xFt, centerYFt + resolved.dims.heightFt / 2 + 0.42, placed.zFt)
            scene.add(sprite)
          }
        })

        if (codeCheckEnabled) {
          const group = createCodeClearanceGroup(THREE, codeClearanceChecks, t)
          if (group) scene.add(group)
        }

        spaceMeasurements.forEach(({ measurement, index }) => {
          const group = createSpaceMeasurementGroup(THREE, measurement, selectedId === measurementInteractiveId(index))
          if (!group) return
          tagInteractive(group, 'measurement', measurementInteractiveId(index))
          scene.add(group)
          itemTargets.push(group)
        })

        const capturePng = (): PhotoRenderSnapshot | null => {
          const canvas = renderer.domElement as HTMLCanvasElement
          const previousDimensionVisibility = dimensionGroup.visible
          dimensionGroup.visible = false
          try {
            controls.update()
            renderer.render(scene, camera)
            const blank = canvasLooksBlank(renderer)
            const dataUrl = canvas.toDataURL(PHOTO_RENDER_MIME)
            return {
              dataUrl,
              width: canvas.width,
              height: canvas.height,
              blank: blank || !dataUrl.startsWith(`data:${PHOTO_RENDER_MIME}`) || dataUrl.length < 200,
            }
          } catch {
            return null
          } finally {
            dimensionGroup.visible = previousDimensionVisibility
            renderer.render(scene, camera)
          }
        }
        photoSnapshotApiRef.current = { capturePng }

        const raycaster = new THREE.Raycaster()
        const pointer = new THREE.Vector2()
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
        const planePoint = new THREE.Vector3()
        let pointerDown: { x: number; y: number } | null = null
        let drag:
          | {
              type: InteractiveKind
              id: string
              moved: boolean
              latestLight?: SketchLight
              latestSwitch?: SketchSwitch
              latestPlaced?: SketchPlacedCatalogItem
              latestOpening?: Opening
              object: any
            }
          | null = null
        let insideLookDrag: { pointerId: number; x: number; y: number; yaw: number; pitch: number } | null = null
        const insidePointers = new Map<number, { clientX: number; clientY: number }>()
        let insidePinch: { distance: number } | null = null
        let openingDragDimensionGroup: any | null = null
        let catalogDragCodeGroup: any | null = null

        const clearOpeningDragDimensions = () => {
          if (!openingDragDimensionGroup) return
          scene.remove(openingDragDimensionGroup)
          openingDragDimensionGroup.traverse?.((object: { geometry?: unknown; material?: unknown }) => disposeObjectWithMaterial(object))
          openingDragDimensionGroup = null
        }

        const clearCatalogDragClearances = () => {
          if (!catalogDragCodeGroup) return
          scene.remove(catalogDragCodeGroup)
          catalogDragCodeGroup.traverse?.((object: { geometry?: unknown; material?: unknown }) => disposeObjectWithMaterial(object))
          catalogDragCodeGroup = null
        }

        const showOpeningDragDimensions = (opening: Opening) => {
          const metrics = openingMetrics(model, opening, height)
          clearOpeningDragDimensions()
          if (!metrics) return
          openingDragDimensionGroup = createOpeningDimensionGroup(THREE, opening, metrics, t)
          scene.add(openingDragDimensionGroup)
        }

        const showCatalogDragClearances = (placed: SketchPlacedCatalogItem) => {
          clearCatalogDragClearances()
          if (!codeCheckEnabled) return
          const nextPlacedItems = placedItems.map((item) => (item.id === placed.id ? placed : item))
          const checks = getCodeClearanceChecks({ ...model, placedItems: nextPlacedItems })
          catalogDragCodeGroup = createCodeClearanceGroup(THREE, checks, t, placed.id)
          if (catalogDragCodeGroup) scene.add(catalogDragCodeGroup)
        }

        const updatePointer = (event: { clientX: number; clientY: number }) => {
          const rect = renderer.domElement.getBoundingClientRect()
          pointer.x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1
          pointer.y = -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1)
          raycaster.setFromCamera(pointer, camera)
        }

        const insidePointerDistance = () => {
          const points = Array.from(insidePointers.values())
          if (points.length < 2) return 0
          return Math.hypot(points[0].clientX - points[1].clientX, points[0].clientY - points[1].clientY)
        }

        const resetInsidePointers = () => {
          insidePointers.clear()
          insidePinch = null
          insideLookDrag = null
        }

        const floorHitPoint = () => {
          const hits = raycaster.intersectObjects(floorTargets, true)
          if (hits[0]) return hits[0].point
          return raycaster.ray.intersectPlane(groundPlane, planePoint)
        }

        const wallHitAnchor = () => {
          const hits = raycaster.intersectObjects(wallTargets, true)
          const hit = hits[0]
          if (!hit) return null
          const wall = taggedWall(hit.object)
          if (!wall) return null
          const base = nearestCatalogWall(model, { x: hit.point.x, z: hit.point.z })
          const side = base && base.c === wall.c && base.s === wall.s ? base.side : 1
          return { ...wall, t: projectWallT(model, wall.c, wall.s, hit.point), yFt: hit.point.y, side }
        }

        const catalogWallHitAtPointer = (): CatalogWallHit | null => {
          const hits = raycaster.intersectObjects(wallTargets, true)
          const hit = hits[0]
          if (!hit) return null
          const wall = taggedWall(hit.object)
          if (!wall) return null
          const nearest = nearestCatalogWall(model, { x: hit.point.x, z: hit.point.z })
          if (!nearest || nearest.c !== wall.c || nearest.s !== wall.s) return null
          return { ...nearest, t: projectWallT(model, wall.c, wall.s, hit.point), yFt: hit.point.y }
        }

        const snapMeasureFt = (valueFt: number) => {
          const step = Number.isFinite(snapStepFt) && snapStepFt > 0 ? snapStepFt : EIGHTH_IN_FT
          return Math.round(valueFt / step) * step
        }

        const measurementSurfacePoint = (): SketchMeasurementPoint | null => {
          const hits = raycaster.intersectObjects([...wallTargets, ...floorTargets], true)
          const hit = hits[0]
          if (!hit) return null
          const wall = taggedWall(hit.object)
          if (wall) {
            const seg = segmentWorld(model, wall.c, wall.s)
            if (!seg) return null
            const cell = modelCellFt(model)
            const ax = seg.a.x * cell
            const az = seg.a.y * cell
            const bx = seg.b.x * cell
            const bz = seg.b.y * cell
            const len = Math.hypot(bx - ax, bz - az)
            if (len <= 0.001) return null
            const rawT = projectWallT(model, wall.c, wall.s, hit.point)
            const snappedT = Math.max(0, Math.min(1, snapMeasureFt(rawT * len) / len))
            return {
              x: ax + (bx - ax) * snappedT,
              y: Math.max(0, Math.min(height, snapMeasureFt(hit.point.y))),
              z: az + (bz - az) * snappedT,
            }
          }
          return {
            x: snapMeasureFt(hit.point.x),
            y: Math.max(0, Math.min(height, snapMeasureFt(hit.point.y))),
            z: snapMeasureFt(hit.point.z),
          }
        }

        const placeMeasurementAtPointer = (event: PointerEvent) => {
          if (!canEdit) return
          updatePointer(event)
          const point = measurementSurfacePoint()
          if (!point) return
          setSelectedId(null)
          const draft = measure3DDraftRef.current
          if (!draft) {
            measure3DDraftRef.current = point
            return
          }
          const length = Math.hypot(point.x - draft.x, point.y - draft.y, (point.z ?? 0) - (draft.z ?? 0))
          if (length <= 0.01) return
          const nextMeasurement: SketchMeasurement = {
            id: makeId('measure'),
            scope: 'space',
            a: draft,
            b: point,
          }
          onModelChange?.({ ...model, measurements: [...measurements, nextMeasurement] })
          setSelectedId(measurementInteractiveId(measurements.length))
          measure3DDraftRef.current = null
        }

        const placeCatalogAtPointer = (event: { clientX: number; clientY: number }, item: CatalogItem) => {
          if (!canEdit) return
          const dims = catalogDimsFromItem(item)
          if (!dims) return
          updatePointer(event)
          let nextPlaced: SketchPlacedCatalogItem | null = null
          if (item.category === 'light') {
            const wallHit = catalogWallHitAtPointer()
            if (wallHit) nextPlaced = placedOnWall(item, makeId('placed'), wallHit, dims, height, WALL_THICKNESS_FT)
          }
          if (!nextPlaced) {
            const point = floorHitPoint()
            if (!point) return
            if (item.category === 'light' || item.category === 'fan') {
              nextPlaced = placedOnCeiling(item, makeId('placed'), { x: point.x, z: point.z }, dims, height)
            } else {
              nextPlaced = placedOnFloor(item, makeId('placed'), { x: point.x, z: point.z }, dims, model, WALL_THICKNESS_FT)
            }
          }
          if (isBuiltinToiletCatalogItem(item)) {
            nextPlaced = {
              ...nextPlaced,
              kind: SKETCH_CATALOG_KIND_TOILET,
              category: 'other',
              name: t('hub_sketch_toilet'),
              model: SKETCH_CATALOG_KIND_TOILET,
            }
          }
          if (isBuiltinShowerPanCatalogItem(item)) {
            nextPlaced = withShowerPanPlacedCatalogMetadata(
              nextPlaced,
              item,
              showerPanShapeFromCatalogItem(item) === 'neo-angle' ? t('hub_sketch_shower_pan_neo') : t('hub_sketch_shower_pan_rect'),
            )
          }
          onModelChange?.({ ...model, placedItems: [...placedItems, nextPlaced] })
          setSelectedId(nextPlaced.id)
          setCatalogPlacementId(null)
        }

        const placeAtPointer = (event: PointerEvent) => {
          if (!canEdit) return
          const currentCatalogPlacementItem = catalogPlacementItemRef.current
          if (currentCatalogPlacementItem) {
            placeCatalogAtPointer(event, currentCatalogPlacementItem)
            return
          }
          const currentPlacement = placementRef.current
          if (!currentPlacement) return
          updatePointer(event)
          if (currentPlacement === 'door' || currentPlacement === 'window' || currentPlacement === 'opening') {
            const anchor = wallHitAnchor()
            if (!anchor) return
            const nextOpening = openingAtWall(currentPlacement, anchor.c, anchor.s, anchor.t)
            onModelChange?.({ ...model, openings: [...model.openings, nextOpening] })
            setSelectedId(openingInteractiveId(model.openings.length))
            return
          }
          if (currentPlacement === 'switch') {
            const anchor = wallHitAnchor()
            if (!anchor) return
            const nextSwitch: SketchSwitch = {
              id: makeId('switch'),
              c: anchor.c,
              s: anchor.s,
              t: anchor.t,
              heightFt: DEFAULT_SWITCH_HEIGHT_FT,
              controls: lights[0] ? [lights[0].id] : [],
            }
            onModelChange?.({ ...model, switches: [...switches, nextSwitch] })
            setSelectedId(nextSwitch.id)
            return
          }
          if (currentPlacement === 'sconce') {
            const anchor = wallHitAnchor()
            if (!anchor) return
            const nextLight: SketchLight = {
              id: makeId('light'),
              kind: 'sconce',
              name: `${lightKindLabel(t, 'sconce')} ${lights.length + 1}`,
              c: anchor.c,
              s: anchor.s,
              t: anchor.t,
              heightFt: DEFAULT_SCONCE_HEIGHT_FT,
            }
            onModelChange?.({ ...model, lights: [...lights, nextLight] })
            setSelectedId(nextLight.id)
            return
          }
          const point = floorHitPoint()
          if (!point) return
          const nextLight = addLightAt(currentPlacement, point.x, point.z)
          onModelChange?.({ ...model, lights: [...lights, nextLight] })
          setSelectedId(nextLight.id)
        }

        const onPointerDown = (event: PointerEvent) => {
          pointerDown = { x: event.clientX, y: event.clientY }
          if (event.button !== 0) return
          if (measure3DActiveRef.current) {
            // NAV-FIX-2: в режиме рулетки НЕ перехватываем указатель и НЕ трогаем камеру —
            // OrbitControls продолжает вращать/зумить сцену; замер ставится кликом на pointerup (delta<=4).
            drag = null
            return
          }
          if (insideMode) {
            insidePointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })
            if (insidePointers.size === 1) {
              insideLookDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, yaw: insideYaw, pitch: insidePitch }
              insidePinch = null
            } else if (insidePointers.size >= 2) {
              insideLookDrag = null
              insidePinch = { distance: insidePointerDistance() }
            }
            renderer.domElement.setPointerCapture?.(event.pointerId)
            event.preventDefault()
            return
          }
          updatePointer(event)
          const hit = raycaster.intersectObjects(itemTargets, true)[0]
          const tagged = hit ? taggedObject(hit.object) : null
          if (!tagged) return
          setSelectedId(tagged.id)
          if (!canEdit) return
          const object = hit.object.parent ?? hit.object
          drag = { ...tagged, moved: false, object }
          controls.enabled = false
          renderer.domElement.setPointerCapture?.(event.pointerId)
          event.preventDefault()
        }

        const onPointerMove = (event: PointerEvent) => {
          if (insideMode && insidePointers.has(event.pointerId)) {
            insidePointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY })
            if (insidePointers.size >= 2 && insidePinch) {
              const nextDistance = insidePointerDistance()
              const delta = nextDistance - insidePinch.distance
              insidePinch = { distance: nextDistance }
              if (Math.abs(delta) > 0.5) moveInsideCamera(Math.max(-INSIDE_WHEEL_STEP_FT, Math.min(INSIDE_WHEEL_STEP_FT, delta * 0.02)))
              event.preventDefault()
              return
            }
            if (insideLookDrag && insideLookDrag.pointerId === event.pointerId) {
              const dx = event.clientX - insideLookDrag.x
              const dy = event.clientY - insideLookDrag.y
              insideYaw = insideLookDrag.yaw - dx * INSIDE_LOOK_SENSITIVITY
              insidePitch = Math.max(-INSIDE_PITCH_LIMIT_RAD, Math.min(INSIDE_PITCH_LIMIT_RAD, insideLookDrag.pitch - dy * INSIDE_LOOK_SENSITIVITY))
              applyInsideLook()
              event.preventDefault()
              return
            }
          }
          if (!drag) return
          updatePointer(event)
          drag.moved = true
          if (drag.type === 'catalog') {
            const current = resolvedPlacedItems.find((item) => item.placed.id === drag?.id)
            if (!current) return
            let nextPlaced: SketchPlacedCatalogItem | null = null
            if (current.placed.surface === 'wall') {
              const wallHit = catalogWallHitAtPointer()
              if (!wallHit) return
              nextPlaced = movePlacedOnWall(current.placed, wallHit, current.dims, height, WALL_THICKNESS_FT)
            } else {
              const point = floorHitPoint()
              if (!point) return
              nextPlaced = current.placed.surface === 'ceiling'
                ? movePlacedOnCeiling(current.placed, { x: point.x, z: point.z }, current.dims, height)
                : movePlacedOnFloor(current.placed, { x: point.x, z: point.z }, current.dims, model, WALL_THICKNESS_FT)
            }
            drag.latestPlaced = nextPlaced
            applyCatalogObjectPose(drag.object, nextPlaced)
            showCatalogDragClearances(nextPlaced)
          } else if (drag.type === 'opening') {
            const openingIndex = openingIndexFromId(drag.id)
            const current = openingIndex !== null ? model.openings[openingIndex] : null
            const anchor = wallHitAnchor()
            if (!current || !anchor) return
            const draft: Opening = { ...current, c: anchor.c, s: anchor.s, t: anchor.t }
            const nextOpening: Opening = { ...draft, t: snapOpeningT(model, draft, anchor.t, snapStepFt) }
            drag.latestOpening = nextOpening
            applyOpeningPose(drag.object, nextOpening)
            showOpeningDragDimensions(nextOpening)
          } else if (drag.type === 'switch') {
            const anchor = wallHitAnchor()
            const current = switches.find((sw) => sw.id === drag?.id)
            if (!anchor || !current) return
            const nextSwitch = { ...current, c: anchor.c, s: anchor.s, t: anchor.t }
            drag.latestSwitch = nextSwitch
            const pose = wallAnchor(model, nextSwitch.c, nextSwitch.s, nextSwitch.t, nextSwitch.heightFt ?? DEFAULT_SWITCH_HEIGHT_FT)
            if (pose) {
              drag.object.position.set(pose.x + pose.nx * (WALL_THICKNESS_FT / 2 + 0.075), pose.y, pose.z + pose.nz * (WALL_THICKNESS_FT / 2 + 0.075))
              drag.object.rotation.y = pose.rotationY
            }
          } else if (drag.type === 'light') {
            const current = lights.find((light) => light.id === drag?.id)
            if (!current) return
            if (current.kind === 'sconce') {
              const anchor = wallHitAnchor()
              if (!anchor) return
              const nextLight = { ...current, c: anchor.c, s: anchor.s, t: anchor.t }
              drag.latestLight = nextLight
              const pose = wallAnchor(model, nextLight.c ?? 0, nextLight.s ?? 0, nextLight.t ?? 0.5, nextLight.heightFt ?? DEFAULT_SCONCE_HEIGHT_FT)
              if (pose) {
                drag.object.position.set(pose.x + pose.nx * (WALL_THICKNESS_FT / 2 + 0.08), pose.y, pose.z + pose.nz * (WALL_THICKNESS_FT / 2 + 0.08))
                drag.object.rotation.y = pose.rotationY
              }
            } else {
              const point = floorHitPoint()
              if (!point) return
              const nextLight = { ...current, xFt: point.x, zFt: point.z }
              drag.latestLight = nextLight
              drag.object.position.x = point.x
              drag.object.position.z = point.z
            }
          }
          invalidate()
          event.preventDefault()
        }

        const onPointerUp = (event: PointerEvent) => {
          const delta = pointerDown ? Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) : 0
          pointerDown = null
          if (measure3DActiveRef.current) {
            renderer.domElement.releasePointerCapture?.(event.pointerId)
            if (event.button === 0 && delta <= 4) placeMeasurementAtPointer(event)
            event.preventDefault()
            return
          }
          if (insideMode && insidePointers.has(event.pointerId)) {
            insidePointers.delete(event.pointerId)
            if (insidePointers.size === 1) {
              const [remainingId, remaining] = Array.from(insidePointers.entries())[0]
              insideLookDrag = { pointerId: remainingId, x: remaining.clientX, y: remaining.clientY, yaw: insideYaw, pitch: insidePitch }
              insidePinch = null
            } else if (insidePointers.size >= 2) {
              insideLookDrag = null
              insidePinch = { distance: insidePointerDistance() }
            } else {
              resetInsidePointers()
            }
            renderer.domElement.releasePointerCapture?.(event.pointerId)
            event.preventDefault()
            return
          }
          if (event.button !== 0) return
          if (drag) {
            const completed = drag
            drag = null
            controls.enabled = true
            clearOpeningDragDimensions()
            clearCatalogDragClearances()
            invalidate()
            if (completed.moved && completed.latestLight) {
              onModelChange?.({ ...model, lights: lights.map((light) => (light.id === completed.latestLight?.id ? completed.latestLight : light)) })
            }
            if (completed.moved && completed.latestSwitch) {
              onModelChange?.({ ...model, switches: switches.map((sw) => (sw.id === completed.latestSwitch?.id ? completed.latestSwitch : sw)) })
            }
            if (completed.moved && completed.latestPlaced) {
              onModelChange?.({ ...model, placedItems: placedItems.map((item) => (item.id === completed.latestPlaced?.id ? completed.latestPlaced : item)) })
            }
            if (completed.moved && completed.latestOpening) {
              const openingIndex = openingIndexFromId(completed.id)
              if (openingIndex !== null) {
                onModelChange?.({
                  ...model,
                  openings: model.openings.map((opening, index) => (index === openingIndex ? completed.latestOpening as Opening : opening)),
                })
                setSelectedId(openingInteractiveId(openingIndex))
              }
            }
            renderer.domElement.releasePointerCapture?.(event.pointerId)
            event.preventDefault()
            return
          }
          if (delta <= 4) {
            placeAtPointer(event)
            // NAV-FIX-2: одиночный клик (без активной установки объектов) выбирает стену; по пустому — снимает выбор.
            // Выбор синхронизируется с 2D-планом через onPickWall (общий selectedWallKey у SketchTab).
            if (!placementRef.current && !catalogPlacementItemRef.current && onPickWallRef.current) {
              updatePointer(event)
              const itemHit = raycaster.intersectObjects(itemTargets, true)[0]
              if (!itemHit) {
                const wallHit = raycaster.intersectObjects(wallTargets, true)[0]
                const pickedWall = wallHit ? taggedWall(wallHit.object) : null
                onPickWallRef.current(pickedWall ? sketchWallKey(pickedWall.c, pickedWall.s) : null)
              }
            }
          }
        }

        const onWheel = (event: WheelEvent) => {
          if (!insideMode || measure3DActiveRef.current) return
          event.preventDefault()
          const pixelDelta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 120 : event.deltaY
          moveInsideCamera(Math.max(-INSIDE_WHEEL_STEP_FT, Math.min(INSIDE_WHEEL_STEP_FT, (-pixelDelta / 100) * INSIDE_WHEEL_STEP_FT)))
        }

        const onContextMenu = (event: MouseEvent) => event.preventDefault()
        const onDragOver = (event: DragEvent) => {
          const currentCatalogPlacementItem = catalogPlacementItemRef.current
          if (!canEdit || !currentCatalogPlacementItem || !catalogItemHasExactDims(currentCatalogPlacementItem)) return
          event.preventDefault()
        }
        const onDrop = (event: DragEvent) => {
          const currentCatalogPlacementItem = catalogPlacementItemRef.current
          if (!canEdit || !currentCatalogPlacementItem || !catalogItemHasExactDims(currentCatalogPlacementItem)) return
          event.preventDefault()
          placeCatalogAtPointer(event, currentCatalogPlacementItem)
        }

        renderer.domElement.addEventListener('pointerdown', onPointerDown)
        renderer.domElement.addEventListener('pointermove', onPointerMove)
        renderer.domElement.addEventListener('pointerup', onPointerUp)
        renderer.domElement.addEventListener('pointercancel', onPointerUp)
        renderer.domElement.addEventListener('wheel', onWheel, { passive: false })
        renderer.domElement.addEventListener('contextmenu', onContextMenu)
        renderer.domElement.addEventListener('dragover', onDragOver)
        renderer.domElement.addEventListener('drop', onDrop)

        function clampCameraTarget(): boolean {
          const panPad = Math.max(4, span * 0.35)
          const nextTarget = controls.target.clone()
          nextTarget.x = Math.max(sceneMinX - panPad, Math.min(sceneMaxX + panPad, nextTarget.x))
          nextTarget.y = Math.max(0, Math.min(height, nextTarget.y))
          nextTarget.z = Math.max(sceneMinZ - panPad, Math.min(sceneMaxZ + panPad, nextTarget.z))
          const delta = nextTarget.sub(controls.target)
          if (delta.lengthSq() <= 0.000001) return false
          controls.target.add(delta)
          camera.position.add(delta)
          return true
        }

        let didInitialFit = false
        const resize = () => {
          const rect = currentHost.getBoundingClientRect()
          const width = Math.max(1, Math.floor(rect.width))
          const heightPx = Math.max(1, Math.floor(rect.height))
          renderer.setSize(width, heightPx, false)
          camera.aspect = width / heightPx
          camera.updateProjectionMatrix()
          if (!didInitialFit) {
            if (cameraMode === 'inside') enterInsideCamera()
            else fitCamera('fit')
            didInitialFit = true
          } else {
            invalidate()
          }
        }
        const observer = new ResizeObserver(resize)
        observer.observe(currentHost)
        resize()

        invalidate()
        setState('ready')

        cleanup = () => {
          window.cancelAnimationFrame(frame)
          stopInsideJoystick()
          clearOpeningDragDimensions()
          clearCatalogDragClearances()
          if (invalidate3DRef.current === invalidate) invalidate3DRef.current = null
          if (insideMoveApiRef.current?.stopJoystick === stopInsideJoystick) insideMoveApiRef.current = null
          if (photoSnapshotApiRef.current?.capturePng === capturePng) photoSnapshotApiRef.current = null
          controls.removeEventListener('change', invalidate)
          renderer.domElement.removeEventListener('pointerdown', onPointerDown)
          renderer.domElement.removeEventListener('pointermove', onPointerMove)
          renderer.domElement.removeEventListener('pointerup', onPointerUp)
          renderer.domElement.removeEventListener('pointercancel', onPointerUp)
          renderer.domElement.removeEventListener('wheel', onWheel)
          renderer.domElement.removeEventListener('contextmenu', onContextMenu)
          renderer.domElement.removeEventListener('dragover', onDragOver)
          renderer.domElement.removeEventListener('drop', onDrop)
          observer.disconnect()
          cameraApiRef.current = null
          if (dimensionGroupRef.current === dimensionGroup) dimensionGroupRef.current = null
          if (ceilingVisibilityApiRef.current?.setVisible) ceilingVisibilityApiRef.current = null
          if (wallHighlightApiRef.current?.setSelected === setWallHighlight) wallHighlightApiRef.current = null
          controls.dispose()
          scene.traverse((object: { geometry?: unknown; material?: unknown }) => disposeObjectWithMaterial(object))
          renderer.dispose()
          renderer.domElement.remove()
        }
      })
      .catch(() => {
        if (!disposed) setState('error')
      })

    return () => {
      disposed = true
      cleanup?.()
      host.replaceChildren()
    }
  }, [
    model,
    heightFt,
    finishes,
    canEdit,
    onModelChange,
    selectedId,
    t,
    lights,
    switches,
    placedItems,
    resolvedPlacedItems,
    fullscreenActive,
    snapStepFt,
    openingDefaults,
    // NAV-FIX-2: measure3DActive намеренно НЕ в зависимостях — переключение рулетки читается
    // через measure3DActiveRef.current и НЕ пересоздаёт сцену (иначе камера сбрасывалась в пресет).
    codeCheckEnabled,
    codeClearanceChecks,
    codeClearanceViolations,
    codeWarningItemIds,
  ])

  const toggleFullscreen = async () => {
    const root = fullscreenRootRef.current
    if (!root) return
    if (fullscreenActive) {
      setFullscreenFallback(false)
      if (document.fullscreenElement === root && document.exitFullscreen) {
        try {
          await document.exitFullscreen()
        } catch {
          setBrowserFullscreen(false)
        }
      } else {
        setBrowserFullscreen(false)
      }
      invalidate3DRef.current?.()
      return
    }
    setPanelOverlayOpen(false)
    if (root.requestFullscreen) {
      try {
        await root.requestFullscreen()
        return
      } catch {
        setBrowserFullscreen(false)
      }
    }
    setFullscreenFallback(true)
    invalidate3DRef.current?.()
  }

  const tileSizeValue = `${activeTile.tileWIn ?? 12}x${activeTile.tileHIn ?? 24}`
  const tileSizePresetValue = TILE_SIZE_OPTIONS.some((option) => `${option.w}x${option.h}` === tileSizeValue) ? tileSizeValue : 'custom'
  const activeFinishCoverageMode = activeSurface.kind !== 'drywall-patch' && activeSurface.coverage?.mode === 'partial' ? 'partial' : 'full'
  const cameraButtonClass = (mode: CameraPreset) => (cameraMode === mode ? 'btn small' : 'btn ghost small')
  const openingDefaultsForControls: Sketch3DOpeningDefaults = {
    doorW: openingDefaults?.doorW ?? DEFAULT_DOOR_WIDTH_FT,
    doorH: openingDefaults?.doorH ?? DEFAULT_DOOR_HEIGHT_FT,
    winW: openingDefaults?.winW ?? DEFAULT_WINDOW_WIDTH_FT,
    winH: openingDefaults?.winH ?? DEFAULT_WINDOW_HEIGHT_FT,
    winSill: openingDefaults?.winSill ?? DEFAULT_WINDOW_SILL_FT,
  }
  const setCameraPreset = (mode: CameraPreset) => {
    setCameraMode(mode)
    cameraApiRef.current?.[mode]()
  }
  useEffect(() => {
    if (!cameraPresetRequest) return
    setCameraPreset(cameraPresetRequest.mode)
  }, [cameraPresetRequest?.key])

  const renderOpeningDefaultControl = (field: OpeningDefaultDraftField, labelKey: string, valueFt: number, minFt: number, maxFt: number) => (
    <label className="hub-sketch-3d-toolbar-field">
      <span>{t(labelKey)}</span>
      <input
        type="text"
        inputMode="text"
        value={openingDefaultValue(field, valueFt)}
        onChange={(event) => setOpeningDefaultDraft(field, event.target.value)}
        onBlur={() => commitOpeningDefaultDraft(field, valueFt, minFt, maxFt)}
        onKeyDown={(event) => handleOpeningDefaultKeyDown(event, field, valueFt, minFt, maxFt)}
      />
    </label>
  )
  const updateJoystickFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const joystick = joystickRef.current
    if (!joystick) return
    const rect = joystick.getBoundingClientRect()
    const max = Math.max(24, Math.min(rect.width, rect.height) * 0.34)
    const rawX = event.clientX - (rect.left + rect.width / 2)
    const rawY = event.clientY - (rect.top + rect.height / 2)
    const len = Math.hypot(rawX, rawY)
    const scale = len > max ? max / len : 1
    const x = rawX * scale
    const y = rawY * scale
    setJoystickKnob({ x, y, active: true })
    insideMoveApiRef.current?.setJoystickVector(x / max, -y / max)
  }
  const startJoystick = (event: ReactPointerEvent<HTMLDivElement>) => {
    joystickPointerRef.current = event.pointerId
    event.currentTarget.setPointerCapture?.(event.pointerId)
    updateJoystickFromPointer(event)
    event.preventDefault()
    event.stopPropagation()
  }
  const moveJoystick = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (joystickPointerRef.current !== event.pointerId) return
    updateJoystickFromPointer(event)
    event.preventDefault()
    event.stopPropagation()
  }
  const stopJoystick = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (joystickPointerRef.current !== event.pointerId) return
    joystickPointerRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    insideMoveApiRef.current?.stopJoystick()
    setJoystickKnob({ x: 0, y: 0, active: false })
    event.preventDefault()
    event.stopPropagation()
  }

  const handlePhotoReferenceFileChange = async (event: ReactChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0]
    event.target.value = ''
    if (!picked) return
    if (!picked.type.startsWith('image/')) {
      setPhotoReferenceErrorKey('hub_sketch_photo_reference_not_image')
      return
    }
    if (picked.size > PHOTO_REFERENCE_MAX_BYTES) {
      setPhotoReferenceErrorKey('hub_sketch_photo_reference_too_large')
      return
    }

    try {
      const dataUrl = await blobToDataUrl(picked)
      setPhotoReference({
        source: 'device',
        name: picked.name,
        mime: picked.type || PHOTO_RENDER_MIME,
        previewUrl: dataUrl,
        imageB64: stripImageDataUrlPrefix(dataUrl),
        file: picked,
      })
      setPhotoReferencePickerOpen(false)
      setPhotoReferenceErrorKey(null)
    } catch {
      setPhotoReferenceErrorKey('hub_sketch_photo_reference_read_failed')
    }
  }

  const selectProjectPhotoReference = async (file: ProjectHubFile) => {
    if (file.size_bytes !== null && file.size_bytes > PHOTO_REFERENCE_MAX_BYTES) {
      setPhotoReferenceErrorKey('hub_sketch_photo_reference_too_large')
      return
    }

    try {
      const previewUrl = photoReferenceThumbs[file.id] ?? await projectHubImageUrl(file)
      if (!previewUrl) throw new Error('no preview')
      setPhotoReference({
        source: 'project',
        name: file.name,
        mime: file.mime || PHOTO_RENDER_MIME,
        previewUrl,
        projectFile: file,
      })
      setPhotoReferencePickerOpen(false)
      setPhotoReferenceErrorKey(null)
      if (!photoReferenceThumbs[file.id]) setPhotoReferenceThumbs((prev) => ({ ...prev, [file.id]: previewUrl }))
    } catch {
      setPhotoReferenceErrorKey('hub_sketch_photo_reference_read_failed')
    }
  }

  const clearPhotoReference = () => {
    setPhotoReference(null)
    setPhotoReferenceErrorKey(null)
  }

  const resolvePhotoRenderReference = async (reference: PhotoRenderReferenceState | null): Promise<PhotoRenderResolvedReference | null> => {
    if (!reference) return null
    if (reference.source === 'device') {
      return {
        source: 'device',
        name: reference.name,
        mime: reference.mime,
        imageB64: reference.imageB64,
        file: reference.file,
      }
    }
    if (reference.projectFile.size_bytes !== null && reference.projectFile.size_bytes > PHOTO_REFERENCE_MAX_BYTES) {
      throw new Error('too-large')
    }

    const url = await projectHubImageUrl(reference.projectFile)
    if (!url) throw new Error('read-failed')
    const response = await fetch(url)
    if (!response.ok) throw new Error('read-failed')
    const blob = await response.blob()
    if (blob.size > PHOTO_REFERENCE_MAX_BYTES) throw new Error('too-large')
    const dataUrl = await blobToDataUrl(blob)
    return {
      source: 'project',
      name: reference.name,
      mime: blob.type || reference.mime || PHOTO_RENDER_MIME,
      imageB64: stripImageDataUrlPrefix(dataUrl),
      projectFile: reference.projectFile,
    }
  }

  const savePhotoRenderSet = async (modalState: Extract<PhotoRenderModalState, { kind: 'success' }>) => {
    if (!profile || !project) {
      setPhotoModal((current) => (
        current?.kind === 'success' && current.variant === modalState.variant && current.imageB64 === modalState.imageB64
          ? { ...current, saveErrorKey: 'hub_sketch_photo_render_no_session', saveBusy: false }
          : current
      ))
      return
    }

    const currentVariant = modalState.variant
    const currentImage = modalState.imageB64
    setPhotoModal((current) => (
      current?.kind === 'success' && current.variant === currentVariant && current.imageB64 === currentImage
        ? { ...current, saveBusy: true, saveErrorKey: undefined }
        : current
    ))

    try {
      const sourceFile = await dataUrlToFile(
        photoImageSrc(modalState.sourceImageB64, PHOTO_RENDER_MIME),
        renderSourcePhotoFileName(photoRenderBaseName, currentVariant),
        PHOTO_RENDER_MIME,
      )
      await uploadProjectFileToR2(profile, project.id, sourceFile)

      if (modalState.reference?.source === 'device' && modalState.reference.file) {
        const referenceFile = new File(
          [modalState.reference.file],
          renderReferenceFileName(photoRenderBaseName, currentVariant, modalState.reference.name, modalState.reference.mime),
          { type: modalState.reference.file.type || modalState.reference.mime || PHOTO_RENDER_MIME },
        )
        await uploadProjectFileToR2(profile, project.id, referenceFile)
      }

      const file = await dataUrlToFile(
        photoImageSrc(currentImage, modalState.mime),
        renderPhotoFileName(photoRenderBaseName, currentVariant),
        modalState.mime,
      )
      await uploadProjectFileToR2(profile, project.id, file)

      setPhotoModal((current) => (
        current?.kind === 'success' && current.variant === currentVariant && current.imageB64 === currentImage
          ? { ...current, saved: true, saveBusy: false, saveErrorKey: undefined }
          : current
      ))
    } catch {
      setPhotoModal((current) => (
        current?.kind === 'success' && current.variant === currentVariant && current.imageB64 === currentImage
          ? { ...current, saveBusy: false, saveErrorKey: 'hub_sketch_photo_render_save_failed' }
          : current
      ))
    }
  }

  const requestPhotoRender = async (sourceImageB64: string, facts: PhotoRenderFacts, variant: number, reference: PhotoRenderResolvedReference | null) => {
    if (photoRenderBusyRef.current) return
    photoRenderBusyRef.current = true
    setPhotoRenderBusy(true)
    try {
      const result = await callRenderPhoto(sourceImageB64, facts, reference?.imageB64)
      const nextModal: Extract<PhotoRenderModalState, { kind: 'success' }> = {
        kind: 'success',
        imageB64: result.imageB64,
        mime: result.mime,
        sourceImageB64,
        facts,
        reference,
        variant,
        saved: false,
        saveBusy: Boolean(profile && project),
      }
      setPhotoModal(nextModal)
      if (profile && project) void savePhotoRenderSet(nextModal)
    } catch (error) {
      setPhotoModal({ kind: 'error', messageKey: photoRenderErrorKey(error) })
    } finally {
      photoRenderBusyRef.current = false
      setPhotoRenderBusy(false)
    }
  }

  const startPhotoRender = async () => {
    const snapshot = photoSnapshotApiRef.current?.capturePng()
    if (!snapshot || snapshot.blank) {
      setPhotoModal({ kind: 'error', messageKey: 'hub_sketch_photo_render_snapshot_failed' })
      return
    }
    const facts = buildPhotoRenderFacts(model, heightFt, finishes, resolvedPlacedItems, cameraMode, sketchName, project?.name)
    setPhotoModal(null)
    let reference: PhotoRenderResolvedReference | null = null
    try {
      reference = await resolvePhotoRenderReference(photoReference)
    } catch (error) {
      const key = error instanceof Error && error.message === 'too-large'
        ? 'hub_sketch_photo_reference_too_large'
        : 'hub_sketch_photo_reference_read_failed'
      setPhotoReferenceErrorKey(key)
      setPhotoModal({ kind: 'error', messageKey: key })
      return
    }
    await requestPhotoRender(snapshot.dataUrl, facts, 1, reference)
  }

  const requestAnotherPhotoRender = async () => {
    if (!photoModal || photoModal.kind !== 'success') return
    await requestPhotoRender(photoModal.sourceImageB64, photoModal.facts, photoModal.variant + 1, photoModal.reference)
  }

  const savePhotoRender = async () => {
    if (!photoModal || photoModal.kind !== 'success') return
    await savePhotoRenderSet(photoModal)
  }

  const downloadPhotoRender = () => {
    if (!photoModal || photoModal.kind !== 'success') return
    const link = document.createElement('a')
    link.href = photoImageSrc(photoModal.imageB64, photoModal.mime)
    link.download = renderPhotoFileName(photoRenderBaseName, photoModal.variant)
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const closePhotoRenderModal = () => {
    if (!photoRenderBusyRef.current) setPhotoModal(null)
  }

  // SKETCH-SNAP-1 — системный share sheet с файлами (мобильные): показать клиенту/команде одним касанием.
  const canNativeShareFiles = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    const nav = navigator as Navigator & { canShare?: (data?: unknown) => boolean }
    return typeof nav.share === 'function' && typeof nav.canShare === 'function'
  }, [])

  // 📸 «Снимок»: PNG текущего ракурса (общий механизм с «Фото-рендер» — размерные стрелки на время
  // снимка гасятся, render() зовётся синхронно перед toDataURL, поэтому кадр не пустой при demand-loop)
  // → автосохранение в файлы проекта. Оригинал эскиза не трогается (это отдельный файл snapshot-…-n.png).
  const takeSnapshot = async () => {
    if (snapshotBusyRef.current) return
    const snapshot = photoSnapshotApiRef.current?.capturePng()
    if (!snapshot || snapshot.blank) {
      setSnapshotPanel({ kind: 'error', messageKey: 'hub_sketch_snapshot_capture_failed' })
      return
    }
    snapshotCountRef.current += 1
    const fileName = snapshotFileName(photoRenderBaseName, snapshotCountRef.current)
    setSnapshotPanel({ kind: 'ready', dataUrl: snapshot.dataUrl, fileName, saveBusy: Boolean(profile && project), saved: false })
    if (!profile || !project) {
      setSnapshotPanel((current) => (
        current?.kind === 'ready' && current.fileName === fileName
          ? { ...current, saveBusy: false, saveErrorKey: 'hub_sketch_snapshot_no_session' }
          : current
      ))
      return
    }
    snapshotBusyRef.current = true
    try {
      const file = await dataUrlToFile(snapshot.dataUrl, fileName, PHOTO_RENDER_MIME)
      await uploadProjectFileToR2(profile, project.id, file)
      setSnapshotPanel((current) => (
        current?.kind === 'ready' && current.fileName === fileName
          ? { ...current, saveBusy: false, saved: true, saveErrorKey: undefined }
          : current
      ))
    } catch {
      setSnapshotPanel((current) => (
        current?.kind === 'ready' && current.fileName === fileName
          ? { ...current, saveBusy: false, saveErrorKey: 'hub_sketch_snapshot_save_failed' }
          : current
      ))
    } finally {
      snapshotBusyRef.current = false
    }
  }

  const downloadSnapshot = () => {
    if (snapshotPanel?.kind !== 'ready') return
    const link = document.createElement('a')
    link.href = snapshotPanel.dataUrl
    link.download = snapshotPanel.fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const shareSnapshot = async () => {
    if (snapshotPanel?.kind !== 'ready') return
    const nav = navigator as Navigator & {
      share?: (data?: unknown) => Promise<void>
      canShare?: (data?: unknown) => boolean
    }
    if (typeof nav.share !== 'function') {
      downloadSnapshot()
      return
    }
    try {
      const file = await dataUrlToFile(snapshotPanel.dataUrl, snapshotPanel.fileName, PHOTO_RENDER_MIME)
      const shareData = { files: [file], title: t('hub_sketch_snapshot_share_title'), text: t('hub_sketch_snapshot_share_text') }
      if (typeof nav.canShare === 'function' && !nav.canShare(shareData)) {
        downloadSnapshot()
        return
      }
      await nav.share(shareData)
    } catch {
      // Пользователь отменил share sheet (AbortError) или платформа отказала — молча игнорируем.
    }
  }

  const closeSnapshotPanel = () => setSnapshotPanel(null)
  const sketch3DPanelId = 'hub-sketch-3d-panel'
  const sketch3DLayoutClassName = [
    'hub-sketch-3d-layout',
    fullscreenActive ? 'hub-sketch-3d-layout-fullscreen' : '',
    show3DPanel ? 'hub-sketch-3d-layout-has-panel' : 'hub-sketch-3d-layout-no-panel',
    show3DPanel && panelOverlayOpen ? 'hub-sketch-3d-layout-panel-open' : '',
  ].filter(Boolean).join(' ')
  const panelToggleLabel = t(panelOverlayOpen ? 'hub_sketch_3d_panel_hide' : 'hub_sketch_3d_panel_show')

  return (
    <div ref={fullscreenRootRef} className={sketch3DLayoutClassName}>
      <div className={fullscreenActive ? 'hub-sketch-3d-shell hub-sketch-3d-shell-fullscreen' : 'hub-sketch-3d-shell'} role="img" aria-label={label}>
        <div ref={hostRef} className="hub-sketch-3d-canvas" />
        <div className="hub-sketch-3d-camera-tools" role="toolbar" aria-label={t('hub_sketch_3d_camera')}>
          {fullscreenActive && viewModeControl}
          {show3DPanel && !fullscreenActive && (
            <button
              type="button"
              className={panelOverlayOpen ? 'btn small' : 'btn ghost small'}
              aria-controls={sketch3DPanelId}
              aria-expanded={panelOverlayOpen}
              onClick={() => setPanelOverlayOpen((open) => !open)}
            >
              {panelToggleLabel}
            </button>
          )}
          {canEdit && show3DOpenings && onOpeningDefaultsChange && (
            <div className="hub-sketch-3d-opening-tools" role="group" aria-label={t('hub_sketch_3d_place_opening')}>
              {(['door', 'window', 'opening'] as OpeningPlacementKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={placement === kind ? 'btn small' : 'btn ghost small'}
                  aria-pressed={placement === kind}
                  onClick={() => {
                    setMeasure3DActive(false)
                    measure3DDraftRef.current = null
                    setCatalogPlacementId(null)
                    setPlacement((current) => (current === kind ? null : kind))
                    setSelectedId(null)
                  }}
                >
                  {t(kind === 'door' ? 'hub_sketch_3d_add_door' : kind === 'window' ? 'hub_sketch_3d_add_window' : 'hub_sketch_3d_add_opening')}
                </button>
              ))}
              <div className="hub-sketch-3d-opening-size">
                <button
                  type="button"
                  className={openingSizeOpen ? 'btn small' : 'btn ghost small'}
                  aria-expanded={openingSizeOpen}
                  onClick={() => setOpeningSizeOpen((open) => !open)}
                >
                  {t('hub_sketch_3d_opening_size')}
                </button>
                {openingSizeOpen && (
                  <div className="hub-sketch-3d-opening-size-menu" role="dialog" aria-label={t('hub_sketch_3d_opening_size')}>
                    <div className="hub-sketch-3d-opening-size-row">
                      <span className="hub-sketch-3d-toolbar-label">{t('hub_sketch_tool_door')}</span>
                      {renderOpeningDefaultControl('doorW', 'hub_sketch_width', openingDefaultsForControls.doorW, 0.5, 20)}
                      {renderOpeningDefaultControl('doorH', 'hub_sketch_height', openingDefaultsForControls.doorH, 0.5, 20)}
                    </div>
                    <div className="hub-sketch-3d-opening-size-row">
                      <span className="hub-sketch-3d-toolbar-label">{t('hub_sketch_tool_window')}</span>
                      {renderOpeningDefaultControl('winW', 'hub_sketch_width', openingDefaultsForControls.winW, 0.5, 20)}
                      {renderOpeningDefaultControl('winH', 'hub_sketch_height', openingDefaultsForControls.winH, 0.5, 20)}
                      {renderOpeningDefaultControl('winSill', 'hub_sketch_sill', openingDefaultsForControls.winSill, 0, 20)}
                    </div>
                  </div>
                )}
              </div>
              {(placement === 'door' || placement === 'window' || placement === 'opening') && (
                <span className="hub-sketch-3d-opening-hint">{t('hub_sketch_3d_opening_click_hint')}</span>
              )}
            </div>
          )}
          <label className="hub-sketch-3d-toolbar-toggle">
            <input
              type="checkbox"
              checked={showDimensions}
              onChange={(e) => setShowDimensions(e.target.checked)}
              aria-label={t('hub_sketch_3d_dimensions')}
            />
            <span>{t('hub_sketch_3d_dimensions')}</span>
          </label>
          <button type="button" className={cameraButtonClass('fit')} onClick={() => setCameraPreset('fit')}>
            {t('hub_sketch_camera_fit')}
          </button>
          <button type="button" className={cameraButtonClass('top')} onClick={() => setCameraPreset('top')}>
            {t('hub_sketch_camera_top')}
          </button>
          <button type="button" className={cameraButtonClass('angle')} onClick={() => setCameraPreset('angle')}>
            {t('hub_sketch_camera_angle')}
          </button>
          <button type="button" className={cameraButtonClass('inside')} onClick={() => setCameraPreset('inside')}>
            {t('hub_sketch_camera_inside')}
          </button>
          <label className="hub-sketch-3d-toolbar-toggle">
            <input
              type="checkbox"
              checked={cameraMode === 'inside' || showCeiling}
              disabled={cameraMode === 'inside'}
              onChange={(event) => setShowCeiling(event.target.checked)}
              aria-label={t('hub_sketch_3d_ceiling')}
            />
            <span>{t('hub_sketch_3d_ceiling')}</span>
          </label>
          {canEdit && showAllContextSections && (
            <button
              type="button"
              className={measure3DActive ? 'btn small' : 'btn ghost small'}
              aria-pressed={measure3DActive}
              onClick={() => {
                setMeasure3DActive((current) => !current)
                measure3DDraftRef.current = null
                setPlacement(null)
                setCatalogPlacementId(null)
                setSelectedId(null)
              }}
            >
              <span aria-hidden="true">📏</span>
              <span>{t('hub_sketch_tool_measure')}</span>
            </button>
          )}
          {fullscreenActive && (
            <div className="hub-sketch-3d-toolbar-group" role="group" aria-label={t('hub_sketch_3d_panel')}>
              <label className="hub-sketch-3d-toolbar-toggle">
                <input
                  type="checkbox"
                  checked={codeCheckEnabled}
                  onChange={(event) => onCodeCheckChange?.(event.target.checked)}
                  aria-label={t('hub_sketch_code_check')}
                />
                <span>{t('hub_sketch_code_check')}</span>
              </label>
              {onHeightChange && (
                <label className="hub-sketch-3d-toolbar-field">
                  <span>{t('hub_sketch_wall_height')}</span>
                  <input
                    type="text"
                    inputMode="text"
                    value={feetInputValue('roomHeightFt', heightFt)}
                    onChange={(event) => setFeetDraft('roomHeightFt', event.target.value)}
                    onBlur={() => commitFeetDraft('roomHeightFt', heightFt, 1, 30, onHeightChange)}
                    onKeyDown={(event) => handleFeetKeyDown(event, 'roomHeightFt', heightFt, 1, 30, onHeightChange)}
                  />
                </label>
              )}
            </div>
          )}
          {fullscreenActive && snapControls && snapControls.length > 0 && (
            <div className="hub-sketch-3d-toolbar-group" role="group" aria-label={t('hub_sketch_snap')}>
              <span className="hub-sketch-3d-toolbar-label">{t('hub_sketch_snap')}</span>
              {snapControls.map((control) => (
                <button
                  key={control.key}
                  type="button"
                  className={control.active ? 'btn small' : 'btn ghost small'}
                  aria-pressed={control.active}
                  onClick={control.onSelect}
                >
                  {control.label}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="btn ghost small hub-sketch-photo-render-btn" disabled={state !== 'ready'} onClick={takeSnapshot} title={t('hub_sketch_snapshot_hint')}>
            <span aria-hidden="true">📸</span>
            <span>{t('hub_sketch_snapshot')}</span>
          </button>
          <input
            ref={photoReferenceInputRef}
            type="file"
            accept="image/*"
            className="hub-sketch-photo-reference-input"
            onChange={handlePhotoReferenceFileChange}
          />
          <div className="hub-sketch-photo-reference-control">
            <button
              type="button"
              className="btn ghost small hub-sketch-photo-reference-add"
              disabled={photoRenderBusy}
              aria-expanded={photoReferencePickerOpen}
              onClick={() => setPhotoReferencePickerOpen((open) => !open)}
              title={t('hub_sketch_photo_reference_hint')}
            >
              {t('hub_sketch_photo_reference_add')}
            </button>
            {photoReference && (
              <div className="hub-sketch-photo-reference-selected" title={photoReference.name}>
                <img src={photoReference.previewUrl} alt={t('hub_sketch_photo_reference_selected_alt')} />
                <span>{photoReference.name}</span>
                <button
                  type="button"
                  className="hub-sketch-photo-reference-remove"
                  onClick={clearPhotoReference}
                  aria-label={t('hub_sketch_photo_reference_remove')}
                  title={t('hub_sketch_photo_reference_remove')}
                >
                  ×
                </button>
              </div>
            )}
            {photoReferencePickerOpen && (
              <div className="hub-sketch-photo-reference-menu" role="dialog" aria-label={t('hub_sketch_photo_reference_picker_label')}>
                <button
                  type="button"
                  className="btn small hub-sketch-photo-reference-source"
                  onClick={() => photoReferenceInputRef.current?.click()}
                >
                  {t('hub_sketch_photo_reference_device')}
                </button>
                <div className="hub-sketch-photo-reference-project">
                  <div className="hub-sketch-photo-reference-menu-title">{t('hub_sketch_photo_reference_project')}</div>
                  {photoReferenceLoading && <div className="muted hub-sketch-photo-reference-state">{t('hub_sketch_photo_reference_loading')}</div>}
                  {!photoReferenceLoading && photoReferenceLoadError && (
                    <div className="error-msg hub-sketch-photo-reference-state">{t('hub_sketch_photo_reference_load_failed')}</div>
                  )}
                  {!photoReferenceLoading && !photoReferenceLoadError && photoReferenceFiles.length === 0 && (
                    <div className="muted hub-sketch-photo-reference-state">{t('hub_sketch_photo_reference_empty')}</div>
                  )}
                  {!photoReferenceLoading && !photoReferenceLoadError && photoReferenceFiles.length > 0 && (
                    <div className="hub-sketch-photo-reference-grid">
                      {photoReferenceFiles.map((file) => {
                        const tooLarge = file.size_bytes !== null && file.size_bytes > PHOTO_REFERENCE_MAX_BYTES
                        const thumb = photoReferenceThumbs[file.id]
                        return (
                          <button
                            key={file.id}
                            type="button"
                            className={selectedPhotoReferenceProjectId === file.id ? 'hub-sketch-photo-reference-file active' : 'hub-sketch-photo-reference-file'}
                            disabled={tooLarge}
                            title={tooLarge ? t('hub_sketch_photo_reference_too_large') : file.name}
                            onClick={() => { void selectProjectPhotoReference(file) }}
                          >
                            <span className="hub-sketch-photo-reference-file-thumb">
                              {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span aria-hidden="true">+</span>}
                            </span>
                            <span>{file.name}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
            {photoReferenceErrorKey && <div className="hub-sketch-photo-reference-error error-msg" role="status">{t(photoReferenceErrorKey)}</div>}
          </div>
          <button type="button" className="btn ghost small hub-sketch-photo-render-btn" disabled={state !== 'ready' || photoRenderBusy} onClick={startPhotoRender}>
            <span aria-hidden="true">📷</span>
            <span>{t('hub_sketch_photo_render')}</span>
          </button>
          <button type="button" className="btn ghost small" aria-pressed={fullscreenActive} onClick={toggleFullscreen}>
            {t(fullscreenActive ? 'hub_sketch_3d_fullscreen_exit' : 'hub_sketch_3d_fullscreen')}
          </button>
        </div>
        {photoRenderBusy && (
          <div className="hub-sketch-photo-render-overlay" role="status" aria-live="polite">
            <span className="hub-sketch-photo-render-spinner" aria-hidden="true" />
            <span>{t('hub_sketch_photo_render_busy')}</span>
          </div>
        )}
        {cameraMode === 'inside' && state === 'ready' && !measure3DActive && (
          <div className="hub-sketch-inside-controls">
            <div className="hub-sketch-inside-hint">{t('hub_sketch_inside_hint')}</div>
            <div
              ref={joystickRef}
              className={joystickKnob.active ? 'hub-sketch-inside-joystick hub-sketch-inside-joystick-active' : 'hub-sketch-inside-joystick'}
              role="application"
              aria-label={t('hub_sketch_inside_joystick')}
              title={t('hub_sketch_inside_joystick_hint')}
              onPointerDown={startJoystick}
              onPointerMove={moveJoystick}
              onPointerUp={stopJoystick}
              onPointerCancel={stopJoystick}
            >
              <span className="hub-sketch-inside-joy-arrow hub-sketch-inside-joy-arrow-up" aria-hidden="true">↑</span>
              <span className="hub-sketch-inside-joy-arrow hub-sketch-inside-joy-arrow-right" aria-hidden="true">→</span>
              <span className="hub-sketch-inside-joy-arrow hub-sketch-inside-joy-arrow-down" aria-hidden="true">↓</span>
              <span className="hub-sketch-inside-joy-arrow hub-sketch-inside-joy-arrow-left" aria-hidden="true">←</span>
              <span
                className="hub-sketch-inside-joy-knob"
                style={{ transform: `translate(${joystickKnob.x}px, ${joystickKnob.y}px)` }}
                aria-hidden="true"
              />
            </div>
          </div>
        )}
        {state === 'loading' && <div className="hub-sketch-3d-overlay muted">{loadingLabel}</div>}
        {state === 'error' && <div className="hub-sketch-3d-overlay error-msg">{errorLabel}</div>}
        {selectedPlaced && (
          <div className={`hub-sketch-3d-item-popover ${selectedPlacedDoesNotFit || selectedPlacedCodeViolations.length > 0 ? 'hub-sketch-3d-item-popover-warn' : ''}`}>
            <div className="hub-sketch-catalog-thumb">
              {selectedPlaced.photoPath
                ? <img src={selectedPlaced.photoPath} alt={selectedPlaced.name} loading="lazy" />
                : <span className={isToiletPlacedCatalogItem(selectedPlaced.placed) ? 'hub-sketch-catalog-thumb-toilet' : isShowerPanPlacedCatalogItem(selectedPlaced.placed) ? 'hub-sketch-catalog-thumb-shower' : 'hub-sketch-catalog-thumb-empty'} aria-hidden="true" />}
            </div>
            <div className="hub-sketch-3d-item-popover-body">
              <div className="item-title">{isCabinetPlacedItem(selectedPlaced.placed) ? cabinetDisplayCode(selectedPlaced.placed) : resolvedCatalogDisplayName(selectedPlaced, t)}</div>
              {!isToiletPlacedCatalogItem(selectedPlaced.placed) && catalogBrandModel(selectedPlaced.brand, selectedPlaced.model) && (
                <div className="muted">{catalogBrandModel(selectedPlaced.brand, selectedPlaced.model)}</div>
              )}
              <div className="muted">{t('catalog_dims')}: {resolvedCatalogDimsText(selectedPlaced)}</div>
              {selectedPlacedSpecs.length > 0 && (
                <div className="catalog-specs-preview" aria-label={t('catalog_specs')}>
                  {selectedPlacedSpecs.map(([key, value], index) => (
                    <span key={`${key}-${index}`}>
                      <strong>{key}</strong>{value ? `: ${value}` : ''}
                    </span>
                  ))}
                </div>
              )}
              {isCabinetPlacedItem(selectedPlaced.placed) && (
                <div className="muted">
                  {[selectedPlaced.placed.layer ? t(selectedPlaced.placed.layer === 'base' ? 'hub_sketch_cabinet_base' : 'hub_sketch_cabinet_wall_layer') : null, selectedPlaced.placed.hinge ? `${t('hub_sketch_cabinet_hinge')} ${selectedPlaced.placed.hinge}` : null, selectedPlaced.placed.filler ? t('hub_sketch_cabinet_filler') : null].filter(Boolean).join(' · ')}
                </div>
              )}
              <div className="hub-sketch-3d-item-flags">
                {selectedPlaced.missingCatalogItem && <span className="badge">{t('hub_sketch_3d_catalog_missing_item')}</span>}
                {selectedPlacedDoesNotFit && <span className="badge red">{t('hub_sketch_3d_not_fit')}</span>}
                {selectedPlaced.placed.layoutWarning && <span className="badge red">{t(selectedPlaced.placed.layoutWarning === 'overflow' ? 'hub_sketch_cabinet_overflow' : 'hub_sketch_cabinet_small_filler')}</span>}
                {selectedPlacedCodeViolations.length > 0 && <span className="badge red">{t('hub_sketch_code_check')}</span>}
              </div>
              {selectedPlacedCodeViolations[0] && (
                <div className="error-msg hub-sketch-code-popover-msg">{formatCodeClearanceMessage(selectedPlacedCodeViolations[0], t)}</div>
              )}
              {selectedShowerPan && canEdit && (
                <div className="hub-sketch-pan-finish-controls">
                  <div className="hub-sketch-pan-finish-head">
                    <span className="muted">{t('hub_sketch_shower_pan_finish')}</span>
                    <span className="hub-sketch-pan-finish-name">
                      {selectedShowerPanFinish?.catalogItemName ?? (selectedShowerPanFinish ? t('hub_sketch_3d_tile') : t('hub_sketch_shower_pan_finish_none'))}
                    </span>
                  </div>
                  {selectedShowerPanFinish && (
                    <button type="button" className="btn ghost small" onClick={() => updateSelectedShowerPanFinish(undefined)}>
                      {t('hub_sketch_shower_pan_finish_clear')}
                    </button>
                  )}
                  {catalogLoading && <p className="muted">{t('loading')}</p>}
                  {catalogError && <p className="error-msg">{t('load_error')}</p>}
                  {!catalogLoading && !catalogError && catalogTileItems.length === 0 && (
                    <div className="hub-sketch-catalog-empty">
                      <p className="muted">{t('hub_sketch_tile_catalog_empty')}</p>
                      <button type="button" className="btn small" onClick={() => navigate('/catalog')}>
                        {t('hub_sketch_tile_catalog_open')}
                      </button>
                    </div>
                  )}
                  {!catalogLoading && !catalogError && catalogTileItems.length > 0 && (
                    <div className="hub-sketch-pan-tile-list" aria-label={t('hub_sketch_shower_pan_finish_catalog')}>
                      {catalogTileItems.map((item) => {
                        const tileDims = catalogTileDimsText(item)
                        const selected = selectedShowerPanFinish?.catalogItemId === item.id
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={selected ? 'hub-sketch-pan-tile-item hub-sketch-pan-tile-item-active' : 'hub-sketch-pan-tile-item'}
                            disabled={!tileDims}
                            aria-pressed={selected}
                            onClick={() => selectShowerPanCatalogTile(item)}
                          >
                            <span className="hub-sketch-pan-tile-thumb">
                              {item.photo_path
                                ? <img src={item.photo_path} alt={catalogDisplayName(item, t)} loading="lazy" />
                                : <span className="hub-sketch-tile-card-empty" aria-hidden="true">▦</span>}
                            </span>
                            <span className="hub-sketch-pan-tile-body">
                              <span className="hub-sketch-pan-tile-name">{catalogDisplayName(item, t)}</span>
                              <span className={tileDims ? 'muted' : 'error-msg'}>{tileDims ?? t('hub_sketch_tile_catalog_missing_size')}</span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
              {canEdit && (
                <div className="hub-sketch-3d-item-actions">
                  <button type="button" className="btn ghost small" onClick={rotateSelectedPlaced}>
                    {t('hub_sketch_3d_rotate')}
                  </button>
                  <button type="button" className="btn ghost small" onClick={removeSelected}>
                    {t('hub_sketch_3d_remove')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {selectedElectrical && (
          <div className="hub-sketch-3d-item-popover">
            <div className={isOutletPlacedCatalogItem(selectedElectrical) ? 'hub-sketch-3d-electrical-thumb hub-sketch-3d-electrical-thumb-outlet' : 'hub-sketch-3d-electrical-thumb hub-sketch-3d-electrical-thumb-switch'} aria-hidden="true">
              {isOutletPlacedCatalogItem(selectedElectrical) ? '⊙' : '⏽'}
            </div>
            <div className="hub-sketch-3d-item-popover-body">
              <div className="item-title">{electricalPlacedName(selectedElectrical, t)}</div>
              <div className="muted">{t('hub_sketch_material_section_electrical')}</div>
              {canEdit && (
                <div className="hub-sketch-3d-item-actions">
                  <button type="button" className="btn ghost small" onClick={removeSelected}>
                    {t('hub_sketch_3d_remove')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {selectedOpening && selectedOpeningIndex !== null && selectedOpeningMetrics && (
          <div className="hub-sketch-3d-item-popover hub-sketch-3d-opening-popover">
            <div className={`hub-sketch-3d-opening-thumb ${selectedOpening.kind === 'door' ? 'hub-sketch-3d-opening-thumb-door' : selectedOpening.kind === 'opening' ? 'hub-sketch-3d-opening-thumb-passthrough' : `hub-sketch-3d-opening-thumb-window hub-sketch-3d-opening-thumb-win-${selectedOpening.winType ?? DEFAULT_WINDOW_TYPE}`}`} aria-hidden="true" />
            <div className="hub-sketch-3d-item-popover-body">
              <div className="item-title">{openingName(selectedOpening, selectedOpeningIndex, t)}</div>
              <div className="muted">{openingDimensionText(selectedOpening, selectedOpeningMetrics, t).replace('\n', ' · ')}</div>
              <div className="muted">
                {`${t('hub_sketch_dim_left_short')} ${formatOpeningFeet(selectedOpeningMetrics.left)} · ${t('hub_sketch_dim_right_short')} ${formatOpeningFeet(selectedOpeningMetrics.right)}`}
              </div>
              {canEdit && (
                <div className="hub-sketch-3d-item-actions">
                  <button type="button" className="btn ghost small" onClick={removeSelected}>
                    {t('hub_sketch_3d_remove')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {selectedMeasurement && selectedMeasurementLength !== null && (
          <div className="hub-sketch-3d-item-popover hub-sketch-3d-measurement-popover">
            <div className="hub-sketch-3d-measurement-thumb" aria-hidden="true">📏</div>
            <div className="hub-sketch-3d-item-popover-body">
              <div className="item-title">{t('hub_sketch_tool_measure')}</div>
              <div className="muted">{formatFeet(selectedMeasurementLength)}</div>
              {canEdit && (
                <div className="hub-sketch-3d-item-actions">
                  <button type="button" className="btn ghost small" onClick={removeSelected}>
                    {t('hub_sketch_3d_remove')}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
        {snapshotPanel && (
          <div className="hub-sketch-snapshot-toast" role="status" aria-live="polite">
            {snapshotPanel.kind === 'ready' ? (
              <>
                <div className="hub-sketch-snapshot-thumb">
                  <img src={snapshotPanel.dataUrl} alt={t('hub_sketch_snapshot_image_alt')} />
                </div>
                <div className="hub-sketch-snapshot-body">
                  <div className={snapshotPanel.saveErrorKey ? 'hub-sketch-snapshot-status error-msg' : 'hub-sketch-snapshot-status'}>
                    {snapshotPanel.saveBusy
                      ? t('hub_sketch_snapshot_saving')
                      : snapshotPanel.saved
                        ? t('hub_sketch_snapshot_saved')
                        : snapshotPanel.saveErrorKey
                          ? t(snapshotPanel.saveErrorKey)
                          : t('hub_sketch_snapshot_ready')}
                  </div>
                  <div className="hub-sketch-snapshot-actions">
                    <button type="button" className="btn ghost small" onClick={downloadSnapshot}>
                      {t('download')}
                    </button>
                    {canNativeShareFiles && (
                      <button type="button" className="btn ghost small" onClick={shareSnapshot}>
                        {t('hub_sketch_snapshot_share')}
                      </button>
                    )}
                    <button type="button" className="btn ghost small" onClick={closeSnapshotPanel}>
                      {t('close')}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="hub-sketch-snapshot-body">
                <div className="hub-sketch-snapshot-status error-msg">{t(snapshotPanel.messageKey)}</div>
                <div className="hub-sketch-snapshot-actions">
                  <button type="button" className="btn ghost small" onClick={closeSnapshotPanel}>
                    {t('close')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {photoModal && (
        <div className="hub-sketch-render-backdrop" onMouseDown={closePhotoRenderModal}>
          <div
            className="card hub-sketch-render-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t(photoModal.kind === 'success' ? 'hub_sketch_photo_render_title' : 'hub_sketch_photo_render_error_title')}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="hub-sketch-render-head">
              <h3>{t(photoModal.kind === 'success' ? 'hub_sketch_photo_render_title' : 'hub_sketch_photo_render_error_title')}</h3>
              <button type="button" className="btn ghost small" disabled={photoRenderBusy} onClick={closePhotoRenderModal}>
                {t('close')}
              </button>
            </div>

            {photoModal.kind === 'success' ? (
              <>
                <div className="hub-sketch-render-preview">
                  <img src={photoImageSrc(photoModal.imageB64, photoModal.mime)} alt={t('hub_sketch_photo_render_image_alt')} />
                </div>
                {photoModal.saved && <p className="hub-sketch-ok">{t('hub_sketch_photo_render_saved')}</p>}
                {photoModal.saveErrorKey && <p className="error-msg">{t(photoModal.saveErrorKey)}</p>}
                <div className="hub-sketch-render-actions">
                  <button type="button" className="btn" disabled={photoModal.saved || photoModal.saveBusy || photoRenderBusy || !profile || !project} onClick={savePhotoRender}>
                    {photoModal.saveBusy
                      ? t('hub_sketch_snapshot_saving')
                      : photoModal.saved
                        ? t('hub_sketch_photo_render_saved')
                        : t('hub_sketch_photo_render_save_files')}
                  </button>
                  <button type="button" className="btn ghost" disabled={photoRenderBusy} onClick={downloadPhotoRender}>
                    {t('download')}
                  </button>
                  <button type="button" className="btn ghost" disabled={photoRenderBusy} onClick={requestAnotherPhotoRender}>
                    {t('hub_sketch_photo_render_another')}
                  </button>
                </div>
              </>
            ) : (
              <div className="hub-sketch-render-error">
                <p>{t(photoModal.messageKey)}</p>
                <button type="button" className="btn" onClick={closePhotoRenderModal}>
                  {t('close')}
                </button>
              </div>
            )}

            {photoRenderBusy && (
              <div className="hub-sketch-render-busy" role="status" aria-live="polite">
                <span className="hub-sketch-photo-render-spinner" aria-hidden="true" />
                <span>{t('hub_sketch_photo_render_busy')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {show3DPanel && panelOverlayOpen && (
        <aside id={sketch3DPanelId} className="hub-sketch-3d-panel" aria-label={t('hub_sketch_3d_panel')}>
          <div className="hub-sketch-3d-panel-head">
            <h2>{t('hub_sketch_3d_panel')}</h2>
            <button type="button" className="btn ghost small hub-sketch-3d-panel-close" onClick={() => setPanelOverlayOpen(false)}>
              {t('hub_sketch_3d_panel_hide')}
            </button>
          </div>
          {show3DFinishes && (
          <section className="hub-sketch-3d-section">
            <h3>{t('hub_sketch_3d_finishes')}</h3>
            <div className="hub-sketch-segmented" role="group" aria-label={t('hub_sketch_3d_surface')}>
              {(['walls', 'wall', 'floor'] as SurfaceTarget[]).map((target) => (
                <button
                  key={target}
                  type="button"
                  className={surfaceTarget === target ? 'btn small' : 'btn ghost small'}
                  disabled={target === 'wall' && wallSegments.length === 0}
                  onClick={() => setSurfaceTarget(target)}
                >
                  {t(target === 'walls' ? 'hub_sketch_3d_walls' : target === 'wall' ? 'hub_sketch_3d_wall_selected' : 'hub_sketch_3d_floor')}
                </button>
              ))}
            </div>

            {surfaceTarget === 'wall' && selectedWall && effectiveSelectedWallKey && (
              <div className="hub-sketch-wall-tools">
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_wall')}</span>
                  <select value={effectiveSelectedWallKey} onChange={(event) => setSelectedWallKey(event.target.value)}>
                    {wallSegmentGroups.map((group) => (
                      <optgroup key={`wall-group-${group.c}`} label={group.label}>
                        {group.options.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <WallElevation
                  model={model}
                  wall={selectedWall}
                  heightFt={heightFt}
                  finish={activeSurface}
                  canEdit={canEdit}
                  snapStepFt={snapStepFt}
                  codeCheckEnabled={codeCheckEnabled}
                  onMeasurementsChange={applyMeasurements}
                  onModelChange={applyModel}
                />
                {selectedWallFinish && (
                  <button type="button" className="btn ghost small" onClick={clearSelectedWallFinish}>
                    {t('hub_sketch_3d_wall_use_all')}
                  </button>
                )}
              </div>
            )}

            <div className="hub-sketch-segmented" role="group" aria-label={t('hub_sketch_3d_finish_mode')}>
              {(['paint', 'tile', ...(surfaceTarget === 'floor' ? [] : ['drywall-patch'] as const)] as const).map((kind) => {
                const coverage = activeSurface.kind !== 'drywall-patch' ? activeSurface.coverage : undefined
                const nextPaint: SketchPaintFinish = { kind: 'paint', color: surfaceTarget === 'floor' ? DEFAULT_FLOOR_PAINT : activeSurface.kind === 'paint' ? activeSurface.color : activeSurface.kind === 'drywall-patch' ? activeSurface.baseColor : finishes.wallPaint }
                if (coverage) nextPaint.coverage = coverage
                const nextTile = normalizeTileSurface(activeSurface)
                if (coverage) nextTile.coverage = coverage
                return (
                  <button
                    key={kind}
                    type="button"
                    className={activeSurface.kind === kind ? 'btn small' : 'btn ghost small'}
                    onClick={() => updateSurface(kind === 'tile' ? nextTile : kind === 'drywall-patch' ? normalizeDrywallPatchSurface(activeSurface) : nextPaint)}
                  >
                    {t(kind === 'paint' ? 'hub_sketch_3d_paint' : kind === 'tile' ? 'hub_sketch_3d_tile' : 'hub_sketch_3d_drywall_patch')}
                  </button>
                )
              })}
            </div>

            {surfaceTarget !== 'floor' && activeSurface.kind !== 'drywall-patch' && (
              <div className="hub-sketch-finish-coverage">
                <div className="hub-sketch-segmented" role="group" aria-label={t('hub_sketch_finish_coverage')}>
                  {(['full', 'partial'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={activeFinishCoverageMode === mode ? 'btn small' : 'btn ghost small'}
                      onClick={() => updateFinishCoverage(mode === 'full' ? { mode: 'full' } : { mode: 'partial' })}
                    >
                      {t(mode === 'full' ? 'hub_sketch_finish_full' : 'hub_sketch_finish_partial')}
                    </button>
                  ))}
                </div>
                {activeFinishCoverageMode === 'partial' && (
                  <div className="hub-sketch-finish-coverage-grid">
                    <label className="hub-sketch-field">
                      <span className="muted">{t('hub_sketch_finish_from_floor')}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={feetInputValue('coverageBottomFt', activeCoverage.bottomFt)}
                        onChange={(e) => setFeetDraft('coverageBottomFt', e.target.value)}
                        onBlur={() => commitFeetDraft('coverageBottomFt', activeCoverage.bottomFt, 0, Math.max(0, heightFt - 0.25), (value) => updateFinishCoverage({ bottomFt: value }))}
                        onKeyDown={(e) => handleFeetKeyDown(e, 'coverageBottomFt', activeCoverage.bottomFt, 0, Math.max(0, heightFt - 0.25), (value) => updateFinishCoverage({ bottomFt: value }))}
                      />
                    </label>
                    <label className="hub-sketch-field">
                      <span className="muted">{t('hub_sketch_finish_height')}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={feetInputValue('coverageHeightFt', activeCoverage.topFt - activeCoverage.bottomFt)}
                        onChange={(e) => setFeetDraft('coverageHeightFt', e.target.value)}
                        onBlur={() => commitFeetDraft('coverageHeightFt', activeCoverage.topFt - activeCoverage.bottomFt, 0.25, heightFt, (value) => updateFinishCoverage({ heightFt: value }))}
                        onKeyDown={(e) => handleFeetKeyDown(e, 'coverageHeightFt', activeCoverage.topFt - activeCoverage.bottomFt, 0.25, heightFt, (value) => updateFinishCoverage({ heightFt: value }))}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}

            {surfaceTarget !== 'floor' && activeSurface.kind !== 'drywall-patch' && (
              <div className="hub-sketch-paint-picker" aria-label={t('hub_sketch_3d_wall_color')}>
                <div className="hub-sketch-color-row">
                  {WALL_PAINT_SWATCHES.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className="hub-sketch-swatch"
                      style={{ backgroundColor: color }}
                      aria-label={color}
                      onClick={() => updatePaintColor(color)}
                    />
                  ))}
                  <input
                    className="hub-sketch-color-input"
                    type="color"
                    value={cleanColor(activeSurface.kind === 'paint' ? activeSurface.color : finishes.wallPaint, DEFAULT_WALL_PAINT)}
                    onChange={(e) => updatePaintColor(e.target.value)}
                    aria-label={t('hub_sketch_3d_custom_color')}
                  />
                </div>
                <input
                  className="hub-sketch-sw-search"
                  value={paintSearch}
                  onChange={(e) => setPaintSearch(e.target.value)}
                  placeholder={t('hub_sketch_3d_sw_search')}
                  aria-label={t('hub_sketch_3d_sw_search')}
                />
                <div className="hub-sketch-sw-grid">
                  {swColorMatches.map((color) => {
                    const selected = cleanColor(activeSurface.kind === 'paint' ? activeSurface.color : finishes.wallPaint, DEFAULT_WALL_PAINT).toLowerCase() === color.hex.toLowerCase()
                    return (
                      <button
                        key={color.code}
                        type="button"
                        className={selected ? 'hub-sketch-sw-chip hub-sketch-sw-chip-active' : 'hub-sketch-sw-chip'}
                        onClick={() => updatePaintColor(color.hex)}
                        title={`${color.code} ${color.name}`}
                      >
                        <span className="hub-sketch-sw-dot" style={{ backgroundColor: color.hex }} aria-hidden="true" />
                        <span className="hub-sketch-sw-code">{color.code}</span>
                        <span className="hub-sketch-sw-name">{color.name}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {activeSurface.kind === 'drywall-patch' && (
              <div className="hub-sketch-drywall-controls">
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_drywall_base_color')}</span>
                  <input type="color" value={cleanColor(activeDrywallPatch.baseColor, DEFAULT_WALL_PAINT)} onChange={(e) => updateDrywallPatch({ baseColor: e.target.value })} />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_drywall_patch_color')}</span>
                  <input type="color" value={cleanColor(activeDrywallPatch.patchColor, DEFAULT_DRYWALL_PATCH_COLOR)} onChange={(e) => updateDrywallPatch({ patchColor: e.target.value })} />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_drywall_x')}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={feetInputValue('patchXFt', activeDrywallPatch.xFt ?? 0)}
                    onChange={(e) => setFeetDraft('patchXFt', e.target.value)}
                    onBlur={() => commitFeetDraft('patchXFt', activeDrywallPatch.xFt ?? 0, 0, selectedWallLengthFt ?? 100, (value) => updateDrywallPatch({ xFt: value }))}
                    onKeyDown={(e) => handleFeetKeyDown(e, 'patchXFt', activeDrywallPatch.xFt ?? 0, 0, selectedWallLengthFt ?? 100, (value) => updateDrywallPatch({ xFt: value }))}
                  />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_drywall_y')}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={feetInputValue('patchYFt', activeDrywallPatch.yFt ?? 0)}
                    onChange={(e) => setFeetDraft('patchYFt', e.target.value)}
                    onBlur={() => commitFeetDraft('patchYFt', activeDrywallPatch.yFt ?? 0, 0, heightFt, (value) => updateDrywallPatch({ yFt: value }))}
                    onKeyDown={(e) => handleFeetKeyDown(e, 'patchYFt', activeDrywallPatch.yFt ?? 0, 0, heightFt, (value) => updateDrywallPatch({ yFt: value }))}
                  />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_width')}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={feetInputValue('patchWidthFt', activeDrywallPatch.widthFt ?? DEFAULT_DRYWALL_PATCH_WIDTH_FT)}
                    onChange={(e) => setFeetDraft('patchWidthFt', e.target.value)}
                    onBlur={() => commitFeetDraft('patchWidthFt', activeDrywallPatch.widthFt ?? DEFAULT_DRYWALL_PATCH_WIDTH_FT, 0.25, selectedWallLengthFt ?? 100, (value) => updateDrywallPatch({ widthFt: value }))}
                    onKeyDown={(e) => handleFeetKeyDown(e, 'patchWidthFt', activeDrywallPatch.widthFt ?? DEFAULT_DRYWALL_PATCH_WIDTH_FT, 0.25, selectedWallLengthFt ?? 100, (value) => updateDrywallPatch({ widthFt: value }))}
                  />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_height')}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={feetInputValue('patchHeightFt', activeDrywallPatch.heightFt ?? DEFAULT_DRYWALL_PATCH_HEIGHT_FT)}
                    onChange={(e) => setFeetDraft('patchHeightFt', e.target.value)}
                    onBlur={() => commitFeetDraft('patchHeightFt', activeDrywallPatch.heightFt ?? DEFAULT_DRYWALL_PATCH_HEIGHT_FT, 0.25, heightFt, (value) => updateDrywallPatch({ heightFt: value }))}
                    onKeyDown={(e) => handleFeetKeyDown(e, 'patchHeightFt', activeDrywallPatch.heightFt ?? DEFAULT_DRYWALL_PATCH_HEIGHT_FT, 0.25, heightFt, (value) => updateDrywallPatch({ heightFt: value }))}
                  />
                </label>
              </div>
            )}

            {activeSurface.kind === 'tile' && (
              <div className="hub-sketch-tile-controls">
                <div className="hub-sketch-tile-source">
                  <div className="hub-sketch-segmented" role="group" aria-label={t('hub_sketch_3d_tile_size')}>
                    <button
                      type="button"
                      className={tileSourceMode === 'manual' ? 'btn small' : 'btn ghost small'}
                      onClick={selectManualTileSource}
                    >
                      {t('hub_sketch_tile_source_manual')}
                    </button>
                    <button
                      type="button"
                      className={tileSourceMode === 'catalog' ? 'btn small' : 'btn ghost small'}
                      onClick={() => setTileSourceMode('catalog')}
                    >
                      {t('hub_sketch_tile_source_catalog')}
                    </button>
                  </div>
                  {tileSourceMode === 'catalog' && (
                    <>
                      {catalogLoading && <p className="muted">{t('loading')}</p>}
                      {catalogError && <p className="error-msg">{t('load_error')}</p>}
                      {!catalogLoading && !catalogError && catalogTileItems.length === 0 && (
                        <div className="hub-sketch-catalog-empty">
                          <p className="muted">{t('hub_sketch_tile_catalog_empty')}</p>
                          <button type="button" className="btn small" onClick={() => navigate('/catalog')}>
                            {t('hub_sketch_tile_catalog_open')}
                          </button>
                        </div>
                      )}
                      {!catalogLoading && !catalogError && catalogTileItems.length > 0 && (
                        <div className="hub-sketch-tile-catalog-grid">
                          {catalogTileItems.map((item) => {
                            const tileDims = catalogTileDimsText(item)
                            const selected = activeTile.catalogItemId === item.id
                            return (
                              <button
                                key={item.id}
                                type="button"
                                className={selected ? 'hub-sketch-tile-card hub-sketch-tile-card-active' : 'hub-sketch-tile-card'}
                                disabled={!tileDims}
                                aria-pressed={selected}
                                onClick={() => selectCatalogTile(item)}
                              >
                                <span className="hub-sketch-tile-card-thumb">
                                  {item.photo_path
                                    ? <img src={item.photo_path} alt={catalogDisplayName(item, t)} loading="lazy" />
                                    : <span className="hub-sketch-tile-card-empty" aria-hidden="true">▦</span>}
                                </span>
                                <span className="hub-sketch-tile-card-body">
                                  <span className="hub-sketch-tile-card-name">{catalogDisplayName(item, t)}</span>
                                  <span className={tileDims ? 'muted' : 'error-msg'}>{tileDims ?? t('hub_sketch_tile_catalog_missing_size')}</span>
                                  {selected && <span className="muted">{t('hub_sketch_tile_catalog_selected')}</span>}
                                  {selected && activeTile.catalogPhotoPath && <span className="muted">{t('hub_sketch_tile_catalog_photo')}</span>}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {tileSourceMode === 'manual' && (
                  <>
                    <label className="hub-sketch-field">
                      <span className="muted">{t('hub_sketch_3d_tile_size')}</span>
                      <select
                        value={tileSizePresetValue}
                        onChange={(e) => {
                          if (e.target.value === 'custom') return
                          const option = TILE_SIZE_OPTIONS.find((item) => `${item.w}x${item.h}` === e.target.value) ?? TILE_SIZE_OPTIONS[0]
                          updateTile({ tileWIn: option.w, tileHIn: option.h })
                        }}
                      >
                        <option value="custom">{t('hub_sketch_3d_tile_size_custom')}</option>
                        {TILE_SIZE_OPTIONS.map((option) => (
                          <option key={option.key} value={`${option.w}x${option.h}`}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="hub-sketch-field">
                      <span className="muted">{t('hub_sketch_width')}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={inchInputValue('tileWIn', activeTile.tileWIn ?? 12)}
                        onChange={(e) => setInchDraft('tileWIn', e.target.value)}
                        onBlur={() => commitInchDraft('tileWIn', activeTile.tileWIn ?? 12, 1, 96)}
                        onKeyDown={(e) => handleInchKeyDown(e, 'tileWIn', activeTile.tileWIn ?? 12, 1, 96)}
                      />
                    </label>
                    <label className="hub-sketch-field">
                      <span className="muted">{t('hub_sketch_height')}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={inchInputValue('tileHIn', activeTile.tileHIn ?? 24)}
                        onChange={(e) => setInchDraft('tileHIn', e.target.value)}
                        onBlur={() => commitInchDraft('tileHIn', activeTile.tileHIn ?? 24, 1, 96)}
                        onKeyDown={(e) => handleInchKeyDown(e, 'tileHIn', activeTile.tileHIn ?? 24, 1, 96)}
                      />
                    </label>
                  </>
                )}
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_grout_width')}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={inchInputValue('groutIn', activeTile.groutIn ?? DEFAULT_GROUT_IN)}
                    onChange={(e) => setInchDraft('groutIn', e.target.value)}
                    onBlur={() => commitInchDraft('groutIn', activeTile.groutIn ?? DEFAULT_GROUT_IN, 0, 2)}
                    onKeyDown={(e) => handleInchKeyDown(e, 'groutIn', activeTile.groutIn ?? DEFAULT_GROUT_IN, 0, 2)}
                  />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_tile_color')}</span>
                  <input type="color" value={cleanColor(activeTile.tileColor, DEFAULT_TILE_COLOR)} onChange={(e) => updateTile({ tileColor: e.target.value })} />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_grout_color')}</span>
                  <input type="color" value={cleanColor(activeTile.groutColor, DEFAULT_GROUT_COLOR)} onChange={(e) => updateTile({ groutColor: e.target.value })} />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_row_offset')}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={inchInputValue('offsetYIn', activeTile.offsetYIn ?? 0)}
                    onChange={(e) => setInchDraft('offsetYIn', e.target.value)}
                    onBlur={() => commitInchDraft('offsetYIn', activeTile.offsetYIn ?? 0, -96, 96)}
                    onKeyDown={(e) => handleInchKeyDown(e, 'offsetYIn', activeTile.offsetYIn ?? 0, -96, 96)}
                  />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_corner_offset')}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={inchInputValue('offsetXIn', activeTile.offsetXIn ?? 0)}
                    onChange={(e) => setInchDraft('offsetXIn', e.target.value)}
                    onBlur={() => commitInchDraft('offsetXIn', activeTile.offsetXIn ?? 0, -96, 96)}
                    onKeyDown={(e) => handleInchKeyDown(e, 'offsetXIn', activeTile.offsetXIn ?? 0, -96, 96)}
                  />
                </label>
                {tileLayout && (
                  <div className="hub-sketch-cut-summary">
                    <span>{`${t('hub_sketch_3d_rows')}: ${tileLayout.rows.count}`}</span>
                    <span>{`${t('hub_sketch_tile_columns')}: ${tileLayout.columns.count}`}</span>
                    <span>{`${t('hub_sketch_tile_net')}: ${tileLayout.netAreaSqft.toFixed(2)} ft²`}</span>
                    <span>{`${t('hub_sketch_tile_order')}: ${tileLayout.grossSqft.toFixed(2)} ft²`}</span>
                    <span>{`${t('hub_sketch_tile_count')}: ${tileLayout.tileCount}`}</span>
                    <span>{`${t('hub_sketch_tile_waste')}: ${Math.round(tileLayout.wasteFactor * 100)}%`}</span>
                    <span>{`${t('hub_sketch_3d_bottom')}: ${formatInches(tileLayout.rows.firstCutIn)}`}</span>
                    <span>{`${t('hub_sketch_3d_top')}: ${formatInches(tileLayout.rows.lastCutIn)}`}</span>
                    <span>{`${t('hub_sketch_3d_left')}: ${formatInches(tileLayout.columns.firstCutIn)}`}</span>
                    <span>{`${t('hub_sketch_3d_right')}: ${formatInches(tileLayout.columns.lastCutIn)}`}</span>
                    {tileLayout.hasSmallCuts && (
                      <span className="hub-sketch-cut-warning">
                        {t('hub_sketch_tile_small_cut').replace('{offset}', formatInches(tileLayout.columns.smallCut ? tileLayout.columns.recommendedOffsetIn : tileLayout.rows.recommendedOffsetIn))}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
          )}

          {show3DOpenings && (
          <section className="hub-sketch-3d-section">
            <h3>{t('hub_sketch_3d_openings')}</h3>
            <div className="hub-sketch-place-grid" role="group" aria-label={t('hub_sketch_3d_place_opening')}>
              {(['door', 'window', 'opening'] as OpeningPlacementKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={placement === kind ? 'btn small' : 'btn ghost small'}
                  aria-pressed={placement === kind}
                  onClick={() => {
                    setMeasure3DActive(false)
                    measure3DDraftRef.current = null
                    setCatalogPlacementId(null)
                    setPlacement((current) => (current === kind ? null : kind))
                    setSelectedId(null)
                  }}
                >
                  {t(kind === 'door' ? 'hub_sketch_tool_door' : kind === 'window' ? 'hub_sketch_tool_window' : 'hub_sketch_mode_opening')}
                </button>
              ))}
            </div>
            <div className="hub-sketch-object-list">
              {model.openings.map((opening, index) => (
                <button
                  key={openingInteractiveId(index)}
                  type="button"
                  className={selectedId === openingInteractiveId(index) ? 'btn small' : 'btn ghost small'}
                  onClick={() => {
                    setMeasure3DActive(false)
                    measure3DDraftRef.current = null
                    setPlacement(null)
                    setCatalogPlacementId(null)
                    setSelectedId(openingInteractiveId(index))
                  }}
                >
                  {openingName(opening, index, t)}
                </button>
              ))}
            </div>
          </section>
          )}

          {show3DMeasure && (
          <section className="hub-sketch-3d-section">
            <h3>{t('hub_sketch_tool_measure')}</h3>
            <button
              type="button"
              className={measure3DActive ? 'btn small' : 'btn ghost small'}
              aria-pressed={measure3DActive}
              onClick={() => {
                setMeasure3DActive((current) => !current)
                measure3DDraftRef.current = null
                setPlacement(null)
                setCatalogPlacementId(null)
                setSelectedId(null)
              }}
            >
              <span aria-hidden="true">📏</span>
              <span>{t('hub_sketch_tool_measure')}</span>
            </button>
            <label className="hub-sketch-3d-toolbar-toggle">
              <input
                type="checkbox"
                checked={showDimensions}
                onChange={(e) => setShowDimensions(e.target.checked)}
                aria-label={t('hub_sketch_3d_dimensions')}
              />
              <span>{t('hub_sketch_3d_dimensions')}</span>
            </label>
            <div className="hub-sketch-object-list">
              {spaceMeasurements.map(({ measurement, index }) => (
                <button
                  key={measurementInteractiveId(index)}
                  type="button"
                  className={selectedId === measurementInteractiveId(index) ? 'btn small' : 'btn ghost small'}
                  onClick={() => {
                    setMeasure3DActive(false)
                    measure3DDraftRef.current = null
                    setPlacement(null)
                    setCatalogPlacementId(null)
                    setSelectedId(measurementInteractiveId(index))
                  }}
                >
                  {formatFeet(measurement.a.z !== undefined && measurement.b.z !== undefined
                    ? Math.hypot(measurement.b.x - measurement.a.x, measurement.b.y - measurement.a.y, measurement.b.z - measurement.a.z)
                    : 0)}
                </button>
              ))}
            </div>
          </section>
          )}

          {show3DPlumbing && (
          <section className="hub-sketch-3d-section">
            <h3>{t('hub_sketch_3d_catalog')}</h3>
            {catalogPlacementItem && (
              <p className="muted hub-sketch-catalog-hint">{t('hub_sketch_3d_catalog_place_hint')}</p>
            )}
            {catalogLoading && <p className="muted">{t('loading')}</p>}
            {catalogError && <p className="error-msg">{t('load_error')}</p>}
            {!catalogLoading && !catalogError && catalogItems.length === 0 && (
              <p className="muted">{t('hub_sketch_3d_catalog_empty')}</p>
            )}
            {!catalogLoading && !catalogError && catalogItems.length > 0 && catalogGroups.length === 0 && (
              <p className="muted">{t('hub_sketch_3d_catalog_empty')}</p>
            )}
            {!catalogLoading && !catalogError && catalogGroups.map((group) => (
              <details key={group.category} className="hub-sketch-catalog-group" open>
                <summary>{t(catalogCategoryLabelKey(group.category))}</summary>
                <div className="hub-sketch-catalog-list">
                  {group.rows.map((item) => {
                    const hasDims = catalogItemHasExactDims(item)
                    const dimsText = catalogItemDimsText(item)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={catalogPlacementId === item.id ? 'hub-sketch-catalog-item hub-sketch-catalog-item-active' : 'hub-sketch-catalog-item'}
                        disabled={!hasDims}
                        draggable={hasDims}
                        aria-pressed={catalogPlacementId === item.id}
                        onClick={() => selectCatalogPlacement(item)}
                        onDragStart={(event) => {
                          if (!hasDims) return
                          event.dataTransfer.effectAllowed = 'copy'
                          event.dataTransfer.setData('text/plain', item.id)
                          setMeasure3DActive(false)
                          measure3DDraftRef.current = null
                          setCatalogPlacementId(item.id)
                          setPlacement(null)
                          setSelectedId(null)
                        }}
                      >
                        <span className="hub-sketch-catalog-thumb">
                          {item.photo_path
                            ? <img src={item.photo_path} alt={catalogDisplayName(item, t)} loading="lazy" />
                            : <span className={isBuiltinToiletCatalogItem(item) ? 'hub-sketch-catalog-thumb-toilet' : isBuiltinShowerPanCatalogItem(item) ? `hub-sketch-catalog-thumb-shower hub-sketch-catalog-thumb-shower-${showerPanShapeFromCatalogItem(item)}` : 'hub-sketch-catalog-thumb-empty'} aria-hidden="true" />}
                        </span>
                        <span className="hub-sketch-catalog-item-body">
                          <span className="hub-sketch-catalog-item-name">{catalogDisplayName(item, t)}</span>
                          {!isBuiltinToiletCatalogItem(item) && catalogBrandModel(item.brand, item.model) && <span className="muted">{catalogBrandModel(item.brand, item.model)}</span>}
                          <span className={hasDims ? 'muted' : 'error-msg'}>
                            {hasDims && dimsText ? `${t('catalog_dims')}: ${dimsText}` : t('hub_sketch_3d_catalog_missing_dims')}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </details>
            ))}
          </section>
          )}

          {show3DLighting && (
          <section className="hub-sketch-3d-section">
            <h3>{t('hub_sketch_3d_lighting')}</h3>
            <div className="hub-sketch-place-grid" role="group" aria-label={t('hub_sketch_3d_place')}>
              {(['recessed', 'chandelier', 'fan', 'sconce'] as SketchLightKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={placement === kind ? 'btn small' : 'btn ghost small'}
                  aria-pressed={placement === kind}
                  onClick={() => {
                    setMeasure3DActive(false)
                    measure3DDraftRef.current = null
                    setCatalogPlacementId(null)
                    setPlacement((current) => (current === kind ? null : kind))
                  }}
                >
                  {lightKindLabel(t, kind)}
                </button>
              ))}
              <button
                type="button"
                className={placement === 'switch' ? 'btn small' : 'btn ghost small'}
                aria-pressed={placement === 'switch'}
                onClick={() => {
                  setMeasure3DActive(false)
                  measure3DDraftRef.current = null
                  setCatalogPlacementId(null)
                  setPlacement((current) => (current === 'switch' ? null : 'switch'))
                }}
              >
                {t('hub_sketch_3d_switch')}
              </button>
            </div>
            <div className="hub-sketch-object-list">
              {lights.map((light, index) => (
                <button
                  key={light.id}
                  type="button"
                  className={selectedId === light.id ? 'btn small' : 'btn ghost small'}
                  onClick={() => {
                    setMeasure3DActive(false)
                    measure3DDraftRef.current = null
                    setSelectedId(light.id)
                  }}
                >
                  {lightName(light, index, t)}
                </button>
              ))}
              {switches.map((sw, index) => (
                <button
                  key={sw.id}
                  type="button"
                  className={selectedId === sw.id ? 'btn small' : 'btn ghost small'}
                  onClick={() => {
                    setMeasure3DActive(false)
                    measure3DDraftRef.current = null
                    setSelectedId(sw.id)
                  }}
                >
                  {switchName(sw, index, t)}
                </button>
              ))}
            </div>
          </section>
          )}

          {show3DLighting && (selectedLight || selectedSwitch) && (
            <section className="hub-sketch-3d-section hub-sketch-selected-box">
              <h3>{selectedLight ? lightName(selectedLight, lights.findIndex((light) => light.id === selectedLight.id), t) : selectedSwitch ? switchName(selectedSwitch, switches.findIndex((sw) => sw.id === selectedSwitch.id), t) : ''}</h3>
              {selectedSwitch && (
                <div className="hub-sketch-switch-links">
                  <span className="muted">{t('hub_sketch_3d_controls')}</span>
                  {lights.length === 0 && <span>{t('hub_sketch_3d_none')}</span>}
                  {lights.map((light, index) => (
                    <label key={light.id} className="hub-sketch-check-row">
                      <input
                        type="checkbox"
                        checked={(selectedSwitch.controls ?? []).includes(light.id)}
                        onChange={(e) => updateSwitchControls(selectedSwitch.id, light.id, e.target.checked)}
                      />
                      <span>{lightName(light, index, t)}</span>
                    </label>
                  ))}
                </div>
              )}
              <button type="button" className="btn ghost small" onClick={removeSelected}>
                {t('hub_sketch_3d_remove')}
              </button>
            </section>
          )}
        </aside>
      )}
    </div>
  )
}
