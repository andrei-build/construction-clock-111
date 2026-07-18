import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { CATALOG_CATEGORIES, getCatalogItems, uploadProjectFileToR2 } from '../../lib/api'
import type { CatalogCategory, CatalogItem } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import { supabase, SUPABASE_KEY, SUPABASE_URL } from '../../lib/supabase'
import type { Profile, Project } from '../../lib/types'
import {
  DEFAULT_FLOOR_PAINT,
  DEFAULT_GROUT_COLOR,
  DEFAULT_GROUT_IN,
  DEFAULT_TILE_COLOR,
  DEFAULT_WALL_PAINT,
  TILE_SIZE_OPTIONS,
  WALL_PAINT_SWATCHES,
  calculateTileCuts,
  cleanColor,
  createTilePatternCanvas,
  normalizeFinishes,
  normalizeTileSurface,
  sketchWallKey,
  type SketchFinishes,
  type Pt,
  type Sketch3DModel,
  type SketchLight,
  type SketchLightKind,
  type SketchSurfaceFinish,
  type SketchSwitch,
  type SketchTileFinish,
} from './sketchFinishes'
import { formatFeetInches, formatInches, parseInches } from './inches'
import WallElevation from './WallElevation'
import {
  catalogDimsFromItem,
  catalogDimsText,
  catalogItemHasExactDims,
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
  type CatalogResolvedPlacedItem,
  type CatalogWallHit,
  type SketchPlacedCatalogItem,
} from './sketchCatalog'
import { SHERWIN_WILLIAMS_COLORS } from './sw-colors'

const CELL_FT = 1
const DEFAULT_WALL_HEIGHT_FT = 8
const WALL_THICKNESS_FT = 0.5
const DOOR_W_FT = 3
const DOOR_H_FT = 6.8
const WIN_W_FT = 3
const WIN_H_FT = 4
const WIN_SILL_FT = 3
const DEFAULT_SWITCH_HEIGHT_FT = 4
const DEFAULT_SCONCE_HEIGHT_FT = 5.6
const ORBIT_FOV_DEG = 65
const INSIDE_FOV_DEG = 70
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

type SurfaceTarget = 'walls' | 'wall' | 'floor'
type PlacementKind = SketchLightKind | 'switch' | null
type Segment = { c: number; s: number; a: Pt; b: Pt }
type CameraPreset = 'fit' | 'top' | 'angle' | 'inside'
type InteractiveKind = 'light' | 'switch' | 'catalog'
type InchDraftField = 'tileWIn' | 'tileHIn' | 'groutIn' | 'offsetXIn' | 'offsetYIn'
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
type PhotoRenderFacts = {
  room: Record<string, unknown>
  tile: Record<string, unknown>
  wall_color: Record<string, unknown>
  items: Array<Record<string, unknown>>
  extra: Record<string, unknown>
}
type PhotoRenderErrorCode = 'no_key' | 'gemini_failed' | 'no_session' | 'snapshot_failed' | 'request_failed'
type PhotoRenderModalState =
  | {
      kind: 'success'
      imageB64: string
      mime: string
      sourceImageB64: string
      facts: PhotoRenderFacts
      variant: number
      saved: boolean
      saveBusy: boolean
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
  label: string
  loadingLabel: string
  errorLabel: string
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function openingWidthFt(o: Sketch3DModel['openings'][number]): number {
  return o.w ?? (o.kind === 'door' ? DOOR_W_FT : WIN_W_FT)
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
  contour: SketchContour | null,
  cellFt: number,
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

  if (contour) {
    const inside = pointInContourWorld(contour, cellFt, x, z)
    const wall = nearestContourWall(contour, cellFt, x, z)
    const wallScore = wall ? wall.distance - INSIDE_WALL_CLEARANCE_FT : 100
    record(inside && wallScore >= -0.0001, wallScore, wall?.normal ?? null)
  }

  obstacles.forEach((obstacle) => {
    const result = evaluateRectObstacle(obstacle, x, z)
    record(result.valid, result.score, result.normal)
  })

  return { valid, score: Number.isFinite(score) ? score : 100, normal }
}

function findInsideStartWorld(
  contour: SketchContour | null,
  cellFt: number,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; width: number; depth: number },
  obstacles: InsideRectObstacle[],
): InsidePoint {
  if (!contour) return { x: bounds.minX + bounds.width / 2, z: bounds.minZ + bounds.depth / 2 }

  const contourBounds = contourBoundsWorld(contour, cellFt)
  const centroid = contourCenterWorld(contour, cellFt)
  const fallback = pointInContourWorld(contour, cellFt, centroid.x, centroid.z)
    ? centroid
    : { x: contourBounds.minX + contourBounds.width / 2, z: contourBounds.minZ + contourBounds.depth / 2 }
  const fallbackResult = evaluateInsideStanding(contour, cellFt, obstacles, fallback.x, fallback.z)
  let best: { point: InsidePoint; score: number } | null = fallbackResult.valid ? { point: fallback, score: fallbackResult.score } : null
  let bestAny: { point: InsidePoint; score: number } = {
    point: fallback,
    score: fallbackResult.score,
  }

  const consider = (point: InsidePoint) => {
    const result = evaluateInsideStanding(contour, cellFt, obstacles, point.x, point.z)
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
  contour: SketchContour | null,
  cellFt: number,
  obstacles: InsideRectObstacle[],
  maxDistance: number,
): number {
  const step = 0.25
  for (let distanceFt = step; distanceFt <= maxDistance; distanceFt += step) {
    const x = start.x + direction.x * distanceFt
    const z = start.z + direction.z * distanceFt
    if (!evaluateInsideStanding(contour, cellFt, obstacles, x, z).valid) return Math.max(0, distanceFt - step)
  }
  return maxDistance
}

function insideYawFromDirection(direction: InsideVector): number {
  const normalized = normalizeInsideVector(direction.x, direction.z)
  return Math.atan2(-normalized.x, -normalized.z)
}

function insideStartYaw(
  contour: SketchContour | null,
  cellFt: number,
  bounds: { width: number; depth: number },
  obstacles: InsideRectObstacle[],
  start: InsidePoint,
): number {
  let axis = insideLongAxisDirection(contour, cellFt, bounds)
  const maxDistance = Math.max(8, bounds.width, bounds.depth)
  const forward = insideRayDistance(start, axis, contour, cellFt, obstacles, maxDistance)
  const backward = insideRayDistance(start, { x: -axis.x, z: -axis.z }, contour, cellFt, obstacles, maxDistance)
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

function surfaceFinishFact(surface: SketchSurfaceFinish, fallbackPaint: string): Record<string, unknown> {
  if (surface.kind === 'tile') {
    const tile = normalizeTileSurface(surface)
    return {
      kind: 'tile',
      source: 'solid_color',
      user_photo: false,
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
    }
  }

  return {
    kind: 'paint',
    color: swColorFact(surface.color, fallbackPaint),
  }
}

function tileSurfaceFact(surface: SketchSurfaceFinish): Record<string, unknown> | null {
  return surface.kind === 'tile' ? surfaceFinishFact(surface, DEFAULT_WALL_PAINT) : null
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
  const raw = o.kind === 'door' ? DOOR_H_FT : (o.h ?? WIN_H_FT)
  return Math.max(0.2, Math.min(raw, Math.max(0.2, roomHeightFt)))
}

function openingSillFt(o: Sketch3DModel['openings'][number], roomHeightFt: number): number {
  if (o.kind === 'door') return 0
  const height = openingHeightFt(o, roomHeightFt)
  return Math.max(0, Math.min(o.sill ?? WIN_SILL_FT, Math.max(0, roomHeightFt - height)))
}

function safeRenderSlug(value: string | undefined, fallback: string): string {
  const clean = (value ?? '').trim().toLowerCase().replace(/[^a-z0-9а-я\-_]+/gi, '-').replace(/^-+|-+$/g, '')
  return clean || fallback
}

function renderPhotoFileName(baseName: string, variant: number): string {
  return `render-${baseName}-${Math.max(1, variant)}.png`
}

function photoImageSrc(imageB64: string, mime: string): string {
  if (imageB64.startsWith('data:')) return imageB64
  return `data:${mime || PHOTO_RENDER_MIME};base64,${imageB64}`
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

async function callRenderPhoto(imageB64: string, facts: PhotoRenderFacts): Promise<{ imageB64: string; mime: string }> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new PhotoRenderRequestError('no_session')

  const response = await fetch(`${SUPABASE_URL}/functions/v1/render-photo`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ image_b64: imageB64, facts }),
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

function buildPhotoRenderFacts(
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
      finish: surfaceFinishFact(finish, finishes.wallPaint),
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
      floor: tileSurfaceFact(finishes.floor),
      walls_default: tileSurfaceFact(finishes.walls),
      per_wall: wallTileOverrides,
      user_photo: false,
    },
    wall_color: {
      default: finishes.walls.kind === 'paint'
        ? swColorFact(finishes.walls.color, finishes.wallPaint)
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
      surface: resolved.placed.surface,
      dimensions: {
        width: inchesFact(resolved.widthIn),
        depth: inchesFact(resolved.depthIn),
        height: inchesFact(resolved.heightIn),
      },
      position_ft: {
        x: roundFact(resolved.placed.xFt, 4),
        y: roundFact(resolved.placed.yFt, 4),
        z: roundFact(resolved.placed.zFt, 4),
      },
      rotation_deg: roundFact((resolved.placed.rotationY * 180) / Math.PI, 2),
      photo_url: resolved.photoPath,
      missing_catalog_item: resolved.missingCatalogItem,
    })),
    extra: {
      sketch_name: sketchName?.trim() || null,
      project_name: projectName?.trim() || null,
      camera_mode: cameraMode,
      cell_ft: cellFt,
      dimensions_hidden_for_capture: true,
      floor_finish: surfaceFinishFact(finishes.floor, DEFAULT_FLOOR_PAINT),
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

function createTileTexture(THREE: any, surface: SketchSurfaceFinish | undefined) {
  const texture = new THREE.CanvasTexture(createTilePatternCanvas(surface))
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function createWallMaterial(THREE: any, surface: SketchSurfaceFinish, widthFt: number, heightFt: number) {
  if (surface.kind !== 'tile') {
    return new THREE.MeshStandardMaterial({ color: cleanColor(surface.color, DEFAULT_WALL_PAINT), roughness: 0.72 })
  }
  const texture = createTileTexture(THREE, surface)
  const { x, y, tile } = tilePitch(surface)
  texture.repeat.set((widthFt * 12) / x, (heightFt * 12) / y)
  texture.offset.set((tile.offsetXIn ?? 0) / x, (tile.offsetYIn ?? 0) / y)
  return new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: 0.78 })
}

function createFloorMaterial(THREE: any, surface: SketchSurfaceFinish) {
  if (surface.kind !== 'tile') {
    return new THREE.MeshStandardMaterial({ color: cleanColor(surface.color, DEFAULT_FLOOR_PAINT), roughness: 0.82, side: THREE.DoubleSide })
  }
  const texture = createTileTexture(THREE, surface)
  return new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: 0.82, side: THREE.DoubleSide })
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
    if ((cur.userData?.itemType === 'light' || cur.userData?.itemType === 'switch' || cur.userData?.itemType === 'catalog') && typeof cur.userData?.itemId === 'string') {
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

function catalogCategoryLabelKey(category: CatalogCategory): string {
  return `catalog_cat_${category}`
}

function catalogItemDimsText(item: CatalogItem): string | null {
  if (item.width_in == null || item.depth_in == null || item.height_in == null) return null
  return catalogDimsText(item.width_in, item.depth_in, item.height_in)
}

function resolvedCatalogDimsText(item: CatalogResolvedPlacedItem): string {
  return catalogDimsText(item.widthIn, item.depthIn, item.heightIn)
}

function catalogBrandModel(brand: string | null | undefined, model: string | null | undefined): string | null {
  const text = [brand, model].filter(Boolean).join(' · ')
  return text || null
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

function addShowerPan(THREE: any, group: any, resolved: CatalogResolvedPlacedItem, material: any, edgeColor: number) {
  const width = Math.max(0.04, resolved.dims.widthFt)
  const height = Math.max(0.08, resolved.dims.heightFt)
  const depth = Math.max(0.04, resolved.dims.depthFt)
  const rim = Math.max(0.08, Math.min(0.28, Math.min(width, depth) * 0.07))
  const baseHeight = Math.max(0.04, Math.min(height * 0.5, height - 0.035))
  const rimHeight = Math.max(0.04, height - baseHeight)
  const base = new THREE.Mesh(new THREE.BoxGeometry(width, baseHeight, depth), material)
  base.position.y = -height / 2 + baseHeight / 2
  addMeshWithEdges(THREE, group, base, edgeColor, 0.58)

  const basinMaterial = new THREE.MeshStandardMaterial({ color: 0xf3f6f7, roughness: 0.38, metalness: 0.02 })
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
    new THREE.MeshStandardMaterial({ color: 0xe9eef0, roughness: 0.42 }),
  )
  panFloor.position.y = -height / 2 + baseHeight + 0.014
  addMeshWithEdges(THREE, group, panFloor, edgeColor, 0.32)
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

export default function Sketch3DView({ model, heightFt, project, profile, sketchName, canEdit = false, onModelChange, label, loadingLabel, errorLabel }: Sketch3DViewProps) {
  const { t } = useI18n()
  const shellRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const cameraApiRef = useRef<Record<CameraPreset, () => void> | null>(null)
  const insideMoveApiRef = useRef<InsideMoveApi | null>(null)
  const photoSnapshotApiRef = useRef<PhotoRenderSnapshotApi | null>(null)
  const photoRenderBusyRef = useRef(false)
  const joystickRef = useRef<HTMLDivElement | null>(null)
  const joystickPointerRef = useRef<number | null>(null)
  const dimensionGroupRef = useRef<any | null>(null)
  const dimensionsVisibleRef = useRef(false)
  const invalidate3DRef = useRef<(() => void) | null>(null)
  const placementRef = useRef<PlacementKind>(null)
  const catalogPlacementItemRef = useRef<CatalogItem | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [showDimensions, setShowDimensions] = useState(false)
  const [cameraMode, setCameraMode] = useState<CameraPreset>('fit')
  const [surfaceTarget, setSurfaceTarget] = useState<SurfaceTarget>('walls')
  const [selectedWallKey, setSelectedWallKey] = useState<string | null>(null)
  const [placement, setPlacement] = useState<PlacementKind>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState(false)
  const [catalogPlacementId, setCatalogPlacementId] = useState<string | null>(null)
  const [paintSearch, setPaintSearch] = useState('')
  const [inchDrafts, setInchDrafts] = useState<Partial<Record<InchDraftField, string>>>({})
  const [browserFullscreen, setBrowserFullscreen] = useState(false)
  const [fullscreenFallback, setFullscreenFallback] = useState(false)
  const [joystickKnob, setJoystickKnob] = useState<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false })
  const [photoRenderBusy, setPhotoRenderBusy] = useState(false)
  const [photoModal, setPhotoModal] = useState<PhotoRenderModalState | null>(null)

  const finishes = useMemo(() => normalizeFinishes(model.finishes), [model.finishes])
  const lights = useMemo(() => model.lights ?? [], [model.lights])
  const switches = useMemo(() => model.switches ?? [], [model.switches])
  const placedItems = useMemo(() => sanitizePlacedCatalogItems(model.placedItems), [model.placedItems])
  const catalogById = useMemo(() => new Map(catalogItems.map((item) => [item.id, item])), [catalogItems])
  const resolvedPlacedItems = useMemo(
    () => placedItems
      .map((placed) => resolvePlacedCatalogItem(placed, catalogById.get(placed.catalogItemId) ?? null))
      .filter((item): item is CatalogResolvedPlacedItem => !!item),
    [placedItems, catalogById],
  )
  const selectedLight = lights.find((light) => light.id === selectedId) ?? null
  const selectedSwitch = switches.find((sw) => sw.id === selectedId) ?? null
  const selectedPlaced = resolvedPlacedItems.find((item) => item.placed.id === selectedId) ?? null
  const catalogPlacementItem = catalogPlacementId ? catalogById.get(catalogPlacementId) ?? null : null
  const fullscreenActive = browserFullscreen || fullscreenFallback
  const catalogGroups = useMemo(
    () => CATALOG_CATEGORIES.map((category) => ({ category, rows: catalogItems.filter((item) => item.category === category) }))
      .filter((group) => group.rows.length > 0),
    [catalogItems],
  )
  const photoRenderBaseName = useMemo(
    () => safeRenderSlug(sketchName || project?.name, project?.id?.slice(0, 8) || 'sketch'),
    [project?.id, project?.name, sketchName],
  )
  const wallSegments = useMemo(() => eachSegment(model), [model])
  const effectiveSelectedWallKey = selectedWallKey && wallSegments.some((seg) => sketchWallKey(seg.c, seg.s) === selectedWallKey)
    ? selectedWallKey
    : wallSegments[0]
      ? sketchWallKey(wallSegments[0].c, wallSegments[0].s)
      : null
  const selectedWall = effectiveSelectedWallKey
    ? wallSegments.find((seg) => sketchWallKey(seg.c, seg.s) === effectiveSelectedWallKey) ?? null
    : null
  const selectedWallFinish = effectiveSelectedWallKey ? finishes.wallFinishes[effectiveSelectedWallKey] : undefined
  const activeSurface = surfaceTarget === 'floor'
    ? finishes.floor
    : surfaceTarget === 'wall'
      ? selectedWallFinish ?? finishes.walls
      : finishes.walls
  const activeTile = useMemo(() => normalizeTileSurface(activeSurface), [activeSurface])
  const swColorMatches = useMemo(() => {
    const query = paintSearch.trim().toLowerCase()
    const rows = query
      ? SHERWIN_WILLIAMS_COLORS.filter((color) => `${color.code} ${color.name}`.toLowerCase().includes(query))
      : SHERWIN_WILLIAMS_COLORS
    return rows.slice(0, SW_COLOR_LIMIT)
  }, [paintSearch])
  const boundsForCuts = modelBounds(model)
  const selectedWallLengthFt = selectedWall ? dist(selectedWall.a, selectedWall.b) * modelCellFt(model) : null
  const surfaceHeightIn = surfaceTarget === 'floor' ? Math.max(12, boundsForCuts.depth * 12) : Math.max(1, heightFt * 12)
  const surfaceWidthIn = surfaceTarget === 'floor'
    ? Math.max(12, boundsForCuts.width * 12)
    : selectedWallLengthFt
      ? Math.max(12, selectedWallLengthFt * 12)
      : longestWallIn(model)
  const cutSummary = activeSurface.kind === 'tile' ? calculateTileCuts(activeSurface, surfaceHeightIn, surfaceWidthIn) : null
  const selectedPlacedDoesNotFit = selectedPlaced
    ? placedCatalogDoesNotFit(selectedPlaced.placed, selectedPlaced.dims, boundsForCuts, heightFt, segmentLengthFt(model, selectedPlaced.placed.c, selectedPlaced.placed.s))
    : false

  useEffect(() => {
    placementRef.current = placement
    catalogPlacementItemRef.current = catalogPlacementItem
  }, [placement, catalogPlacementItem])

  useEffect(() => {
    setInchDrafts({})
  }, [surfaceTarget, activeTile.tileWIn, activeTile.tileHIn, activeTile.groutIn, activeTile.offsetXIn, activeTile.offsetYIn])

  useEffect(() => {
    if (wallSegments.length === 0) {
      if (selectedWallKey) setSelectedWallKey(null)
      return
    }
    if (!effectiveSelectedWallKey || selectedWallKey !== effectiveSelectedWallKey) {
      setSelectedWallKey(effectiveSelectedWallKey)
    }
  }, [wallSegments, selectedWallKey, effectiveSelectedWallKey])

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

  const addLightAt = (kind: SketchLightKind, xFt: number, zFt: number): SketchLight => ({
    id: makeId('light'),
    kind,
    name: `${lightKindLabel(t, kind)} ${lights.length + 1}`,
    xFt,
    zFt,
  })

  const removeSelected = () => {
    if (!selectedId) return
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
        if (mounted) setCatalogItems(rows)
      })
      .catch(() => {
        if (mounted) {
          setCatalogItems([])
          setCatalogError(true)
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
    if (!canEdit || !selectedPlaced) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return
      if (event.key.toLowerCase() === 'r') {
        rotateSelectedPlaced()
        event.preventDefault()
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        removeSelected()
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canEdit, selectedPlaced, placedItems])

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === shellRef.current
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
        renderer.setClearColor(0xf7f8fb, 1)
        renderer.shadowMap.enabled = false
        currentHost.appendChild(renderer.domElement)
        const textureLoader = new THREE.TextureLoader()
        textureLoader.setCrossOrigin?.('anonymous')
        const maxAnisotropy = renderer.capabilities?.getMaxAnisotropy?.() ?? 4

        const scene = new THREE.Scene()
        scene.background = new THREE.Color(0xf7f8fb)

        const cellFt = modelCellFt(model)
        const bounds = modelBounds(model)
        const insideRoom = largestClosedContour(model)
        const insideObstacles = insideCatalogObstacles(resolvedPlacedItems)
        const insideStart = findInsideStartWorld(insideRoom, cellFt, bounds, insideObstacles)
        const height = Number.isFinite(heightFt) && heightFt > 0 ? heightFt : DEFAULT_WALL_HEIGHT_FT
        const span = Math.max(bounds.width, bounds.depth, height, 12)
        const centerX = bounds.minX + bounds.width / 2
        const centerZ = bounds.minZ + bounds.depth / 2
        const orbitFov = fullscreenActive ? FULLSCREEN_FOV_DEG : ORBIT_FOV_DEG
        const insideFov = fullscreenActive ? FULLSCREEN_FOV_DEG : INSIDE_FOV_DEG
        const fitPad = Math.max(1.25, Math.min(8, span * 0.08))
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
          const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.1, camera.aspect))
          const fitDistance = (Math.max(halfH / Math.tan(vFov / 2), halfW / Math.tan(hFov / 2)) + depthHalf) * 1.12
          return Math.max(minCameraDistance, Math.min(maxCameraDistance * 0.9, fitDistance))
        }

        let insideMode = false
        let insideYaw = insideStartYaw(insideRoom, cellFt, bounds, insideObstacles, insideStart)
        let insidePitch = 0
        const eyeY = Math.max(1.25, Math.min(EYE_HEIGHT_FT, Math.max(1.25, height - 0.25)))
        let insideJoystickVector = { strafe: 0, forward: 0 }
        let insideJoystickFrame = 0
        let insideJoystickLastTime = 0
        const insideStandingAt = (x: number, z: number) => evaluateInsideStanding(insideRoom, cellFt, insideObstacles, x, z)
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
          insideYaw = insideStartYaw(insideRoom, cellFt, bounds, insideObstacles, insideStart)
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
        const itemTargets: any[] = []
        const dimensionGroup = new THREE.Group()
        dimensionGroup.visible = dimensionsVisibleRef.current
        scene.add(dimensionGroup)
        dimensionGroupRef.current = dimensionGroup
        const wallSurface = finishes.walls.kind === 'tile' ? finishes.walls : { kind: 'paint' as const, color: cleanColor(finishes.wallPaint, DEFAULT_WALL_PAINT) }
        const floorMaterial = createFloorMaterial(THREE, finishes.floor)
        const doorMaterial = new THREE.MeshStandardMaterial({ color: 0xb86b24, roughness: 0.62 })
        const windowMaterial = new THREE.MeshStandardMaterial({
          color: 0x2f80d1,
          emissive: 0x0b355d,
          emissiveIntensity: 0.08,
          roughness: 0.36,
          metalness: 0.08,
        })
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
        })

        eachSegment(model).forEach((seg) => {
          const a = { x: seg.a.x * cellFt, z: seg.a.y * cellFt }
          const b = { x: seg.b.x * cellFt, z: seg.b.y * cellFt }
          const dx = b.x - a.x
          const dz = b.z - a.z
          const len = Math.hypot(dx, dz)
          if (len <= 0.01) return
          const wallFinish = finishes.wallFinishes[sketchWallKey(seg.c, seg.s)] ?? wallSurface
          const wall = new THREE.Mesh(new THREE.BoxGeometry(len, height, WALL_THICKNESS_FT), createWallMaterial(THREE, wallFinish, len, height))
          wall.position.set((a.x + b.x) / 2, height / 2, (a.z + b.z) / 2)
          wall.rotation.y = -Math.atan2(dz, dx)
          wall.castShadow = false
          wall.receiveShadow = false
          wall.userData.wallC = seg.c
          wall.userData.wallS = seg.s
          scene.add(wall)
          wallTargets.push(wall)

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

        model.openings.forEach((opening) => {
          const ends = openingEnds(model, opening)
          if (!ends) return
          const segLenCells = dist(ends.a, ends.b)
          const segLenFt = segLenCells * cellFt
          if (segLenFt <= 0.01) return
          const ux = ((ends.b.x - ends.a.x) * cellFt) / segLenFt
          const uz = ((ends.b.y - ends.a.y) * cellFt) / segLenFt
          const x = (ends.a.x + (ends.b.x - ends.a.x) * opening.t) * cellFt
          const z = (ends.a.y + (ends.b.y - ends.a.y) * opening.t) * cellFt
          const width = Math.max(0.2, Math.min(openingWidthFt(opening), segLenFt))
          const insertHeight =
            opening.kind === 'door'
              ? Math.max(0.2, Math.min(DOOR_H_FT, height - 0.12))
              : Math.max(0.2, Math.min(opening.h ?? WIN_H_FT, height - 0.12))
          const sill =
            opening.kind === 'door'
              ? 0
              : Math.max(0, Math.min(opening.sill ?? WIN_SILL_FT, Math.max(0, height - insertHeight)))
          const nx = -uz
          const nz = ux
          const insert = new THREE.Mesh(
            new THREE.BoxGeometry(width, insertHeight, 0.08),
            opening.kind === 'door' ? doorMaterial : windowMaterial,
          )
          insert.position.set(
            x + nx * (WALL_THICKNESS_FT / 2 + 0.055),
            sill + insertHeight / 2,
            z + nz * (WALL_THICKNESS_FT / 2 + 0.055),
          )
          insert.rotation.y = -Math.atan2(uz, ux)
          insert.castShadow = false
          scene.add(insert)
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

        const catalogWallLength = (placed: SketchPlacedCatalogItem): number | undefined => {
          if (!Number.isInteger(placed.c) || !Number.isInteger(placed.s)) return undefined
          const seg = segmentWorld(model, placed.c ?? 0, placed.s ?? 0)
          return seg ? dist(seg.a, seg.b) * cellFt : undefined
        }

        const applyCatalogObjectPose = (object: any, placed: SketchPlacedCatalogItem) => {
          object.position.set(placed.xFt, placed.yFt, placed.zFt)
          object.rotation.y = placed.rotationY
        }

        resolvedPlacedItems.forEach((resolved) => {
          const placed = resolved.placed
          const doesNotFit = placedCatalogDoesNotFit(placed, resolved.dims, bounds, height, catalogWallLength(placed))
          const group = new THREE.Group()
          applyCatalogObjectPose(group, placed)
          const edgeColor = doesNotFit ? 0x991b1b : selectedId === placed.id ? 0x0f172a : 0xffffff
          const material = createCatalogMaterial(THREE, resolved, doesNotFit, textureLoader, maxAnisotropy, invalidate)
          if (placed.surface === 'floor') addContactShadow(THREE, group, resolved.dims.widthFt, resolved.dims.depthFt, resolved.dims.heightFt)
          if (resolved.category === 'shower' && placed.surface === 'floor') {
            addShowerPan(THREE, group, resolved, material, edgeColor)
          } else {
            addCatalogBox(THREE, group, resolved, material, edgeColor)
          }
          tagInteractive(group, 'catalog', placed.id)
          scene.add(group)
          itemTargets.push(group)

          if (selectedId === placed.id) {
            const warning = doesNotFit ? `\n${t('hub_sketch_3d_not_fit')}` : ''
            const text = `${resolved.name}\n${resolvedCatalogDimsText(resolved)}${warning}`
            const sprite = createLabelSprite(THREE, text)
            sprite.position.set(placed.xFt, placed.yFt + resolved.dims.heightFt / 2 + 0.42, placed.zFt)
            scene.add(sprite)
          }
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
              object: any
            }
          | null = null
        let insideLookDrag: { pointerId: number; x: number; y: number; yaw: number; pitch: number } | null = null
        const insidePointers = new Map<number, { clientX: number; clientY: number }>()
        let insidePinch: { distance: number } | null = null

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
            renderer.domElement.releasePointerCapture?.(event.pointerId)
            event.preventDefault()
            return
          }
          if (delta <= 4) placeAtPointer(event)
        }

        const onWheel = (event: WheelEvent) => {
          if (!insideMode) return
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
  }, [model, heightFt, finishes, canEdit, onModelChange, selectedId, t, lights, switches, placedItems, resolvedPlacedItems, fullscreenActive])

  const toggleFullscreen = async () => {
    const shell = shellRef.current
    if (!shell) return
    if (fullscreenActive) {
      setFullscreenFallback(false)
      if (document.fullscreenElement === shell && document.exitFullscreen) {
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
    if (shell.requestFullscreen) {
      try {
        await shell.requestFullscreen()
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
  const cameraButtonClass = (mode: CameraPreset) => (cameraMode === mode ? 'btn small' : 'btn ghost small')
  const setCameraPreset = (mode: CameraPreset) => {
    setCameraMode(mode)
    cameraApiRef.current?.[mode]()
  }
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

  const requestPhotoRender = async (sourceImageB64: string, facts: PhotoRenderFacts, variant: number) => {
    if (photoRenderBusyRef.current) return
    photoRenderBusyRef.current = true
    setPhotoRenderBusy(true)
    try {
      const result = await callRenderPhoto(sourceImageB64, facts)
      setPhotoModal({
        kind: 'success',
        imageB64: result.imageB64,
        mime: result.mime,
        sourceImageB64,
        facts,
        variant,
        saved: false,
        saveBusy: false,
      })
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
    await requestPhotoRender(snapshot.dataUrl, facts, 1)
  }

  const requestAnotherPhotoRender = async () => {
    if (!photoModal || photoModal.kind !== 'success') return
    await requestPhotoRender(photoModal.sourceImageB64, photoModal.facts, photoModal.variant + 1)
  }

  const savePhotoRender = async () => {
    if (!photoModal || photoModal.kind !== 'success') return
    if (!profile || !project) {
      setPhotoModal({ ...photoModal, saveErrorKey: 'hub_sketch_photo_render_no_session' })
      return
    }
    const currentVariant = photoModal.variant
    const currentImage = photoModal.imageB64
    setPhotoModal({ ...photoModal, saveBusy: true, saveErrorKey: undefined })
    try {
      const fileName = renderPhotoFileName(photoRenderBaseName, currentVariant)
      const file = await dataUrlToFile(photoImageSrc(currentImage, photoModal.mime), fileName, photoModal.mime)
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

  return (
    <div className="hub-sketch-3d-layout">
      <div ref={shellRef} className={fullscreenActive ? 'hub-sketch-3d-shell hub-sketch-3d-shell-fullscreen' : 'hub-sketch-3d-shell'} role="img" aria-label={label}>
        <div ref={hostRef} className="hub-sketch-3d-canvas" />
        <label className="hub-sketch-3d-dim-toggle">
          <input
            type="checkbox"
            checked={showDimensions}
            onChange={(e) => setShowDimensions(e.target.checked)}
            aria-label={t('hub_sketch_3d_dimensions')}
          />
          <span>{t('hub_sketch_3d_dimensions')}</span>
        </label>
        <div className="hub-sketch-3d-camera-tools" role="toolbar" aria-label={t('hub_sketch_3d_camera')}>
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
        {cameraMode === 'inside' && state === 'ready' && (
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
          <div className={`hub-sketch-3d-item-popover ${selectedPlacedDoesNotFit ? 'hub-sketch-3d-item-popover-warn' : ''}`}>
            <div className="hub-sketch-catalog-thumb">
              {selectedPlaced.photoPath
                ? <img src={selectedPlaced.photoPath} alt={selectedPlaced.name} loading="lazy" />
                : <span className="hub-sketch-catalog-thumb-empty" aria-hidden="true" />}
            </div>
            <div className="hub-sketch-3d-item-popover-body">
              <div className="item-title">{selectedPlaced.name}</div>
              {catalogBrandModel(selectedPlaced.brand, selectedPlaced.model) && (
                <div className="muted">{catalogBrandModel(selectedPlaced.brand, selectedPlaced.model)}</div>
              )}
              <div className="muted">{t('catalog_dims')}: {resolvedCatalogDimsText(selectedPlaced)}</div>
              <div className="hub-sketch-3d-item-flags">
                {selectedPlaced.missingCatalogItem && <span className="badge">{t('hub_sketch_3d_catalog_missing_item')}</span>}
                {selectedPlacedDoesNotFit && <span className="badge red">{t('hub_sketch_3d_not_fit')}</span>}
              </div>
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
                  <button type="button" className="btn" disabled={photoModal.saveBusy || photoRenderBusy || !profile || !project} onClick={savePhotoRender}>
                    {t('hub_sketch_photo_render_save_files')}
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

      {canEdit && (
        <aside className="hub-sketch-3d-panel" aria-label={t('hub_sketch_3d_panel')}>
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
                    {wallSegments.map((seg, index) => {
                      const key = sketchWallKey(seg.c, seg.s)
                      return (
                        <option key={key} value={key}>
                          {`${t('hub_sketch_3d_wall')} ${index + 1} · ${formatFeet(dist(seg.a, seg.b) * modelCellFt(model))}`}
                        </option>
                      )
                    })}
                  </select>
                </label>
                <WallElevation model={model} wall={selectedWall} heightFt={heightFt} finish={activeSurface} />
                {selectedWallFinish && (
                  <button type="button" className="btn ghost small" onClick={clearSelectedWallFinish}>
                    {t('hub_sketch_3d_wall_use_all')}
                  </button>
                )}
              </div>
            )}

            <div className="hub-sketch-segmented" role="group" aria-label={t('hub_sketch_3d_finish_mode')}>
              {(['paint', 'tile'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={activeSurface.kind === kind ? 'btn small' : 'btn ghost small'}
                  onClick={() => updateSurface(kind === 'tile' ? normalizeTileSurface(activeSurface) : { kind: 'paint', color: surfaceTarget === 'floor' ? DEFAULT_FLOOR_PAINT : activeSurface.kind === 'paint' ? activeSurface.color : finishes.wallPaint })}
                >
                  {t(kind === 'paint' ? 'hub_sketch_3d_paint' : 'hub_sketch_3d_tile')}
                </button>
              ))}
            </div>

            {surfaceTarget !== 'floor' && (
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

            {activeSurface.kind === 'tile' && (
              <div className="hub-sketch-tile-controls">
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
                {cutSummary && (
                  <div className="hub-sketch-cut-summary">
                    <span>{`${t('hub_sketch_3d_rows')}: ${cutSummary.rows}`}</span>
                    <span>{`${t('hub_sketch_3d_bottom')}: ${formatInches(cutSummary.bottomIn)}`}</span>
                    <span>{`${t('hub_sketch_3d_top')}: ${formatInches(cutSummary.topIn)}`}</span>
                    <span>{`${t('hub_sketch_3d_left')}: ${formatInches(cutSummary.leftIn)}`}</span>
                    <span>{`${t('hub_sketch_3d_right')}: ${formatInches(cutSummary.rightIn)}`}</span>
                  </div>
                )}
              </div>
            )}
          </section>

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
                          setCatalogPlacementId(item.id)
                          setPlacement(null)
                          setSelectedId(null)
                        }}
                      >
                        <span className="hub-sketch-catalog-thumb">
                          {item.photo_path
                            ? <img src={item.photo_path} alt={item.name} loading="lazy" />
                            : <span className="hub-sketch-catalog-thumb-empty" aria-hidden="true" />}
                        </span>
                        <span className="hub-sketch-catalog-item-body">
                          <span className="hub-sketch-catalog-item-name">{item.name}</span>
                          {catalogBrandModel(item.brand, item.model) && <span className="muted">{catalogBrandModel(item.brand, item.model)}</span>}
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
                  setCatalogPlacementId(null)
                  setPlacement((current) => (current === 'switch' ? null : 'switch'))
                }}
              >
                {t('hub_sketch_3d_switch')}
              </button>
            </div>
            <div className="hub-sketch-object-list">
              {lights.map((light, index) => (
                <button key={light.id} type="button" className={selectedId === light.id ? 'btn small' : 'btn ghost small'} onClick={() => setSelectedId(light.id)}>
                  {lightName(light, index, t)}
                </button>
              ))}
              {switches.map((sw, index) => (
                <button key={sw.id} type="button" className={selectedId === sw.id ? 'btn small' : 'btn ghost small'} onClick={() => setSelectedId(sw.id)}>
                  {switchName(sw, index, t)}
                </button>
              ))}
            </div>
          </section>

          {(selectedLight || selectedSwitch) && (
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
