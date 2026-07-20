import {
  DEFAULT_DOOR_HEIGHT_FT,
  DEFAULT_DOOR_WIDTH_FT,
  DEFAULT_WINDOW_HEIGHT_FT,
  DEFAULT_WINDOW_SILL_FT,
  DEFAULT_WINDOW_WIDTH_FT,
  sketchWallKey,
  type Contour,
  type Opening,
  type Pt,
  type Sketch3DModel,
} from './sketchFinishes'

const EPS = 0.000001
const MIN_WALL_PIECE_FT = 0.02

export const SKETCH_3D_CAMERA_AIR_MULTIPLIER = 1.42
export const SKETCH_3D_CAMERA_MAX_DISTANCE_FRACTION = 0.98

export type Sketch3DSegment = { c: number; s: number; a: Pt; b: Pt }
export type Sketch3DInsideVector = { x: number; z: number }
export type Sketch3DInsideStandingResult = { valid: boolean; score: number; normal: Sketch3DInsideVector | null }

export type Sketch3DOpeningMetrics = {
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

export type Sketch3DWallOpeningCut = {
  opening: Opening
  openingIndex: number
  kind: Opening['kind']
  sourceWallKey: string
  centerFt: number
  leftFt: number
  rightFt: number
  widthFt: number
  heightFt: number
  sillFt: number
}

export type Sketch3DWallPieceKind = 'pier' | 'header' | 'sill'
export type Sketch3DWallPiece = {
  kind: Sketch3DWallPieceKind
  startFt: number
  endFt: number
  bottomFt: number
  topFt: number
  openingIndex?: number
}

export type Sketch3DWallPlan = {
  wallLengthFt: number
  openings: Sketch3DWallOpeningCut[]
  pieces: Sketch3DWallPiece[]
}

type SegmentInfo = {
  wallA: { x: number; z: number }
  wallB: { x: number; z: number }
  ux: number
  uz: number
  lengthFt: number
}

type Span = { startFt: number; endFt: number }

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizeVector(x: number, z: number): Sketch3DInsideVector {
  const len = Math.hypot(x, z)
  return len > EPS ? { x: x / len, z: z / len } : { x: 0, z: 1 }
}

export function sketch3dModelCellFt(model: Pick<Sketch3DModel, 'cellFt'>): number {
  return Number.isFinite(model.cellFt) && model.cellFt > 0 ? model.cellFt : 1
}

export function sketch3dOpeningWidthFt(opening: Opening): number {
  return opening.w ?? (opening.kind === 'door' ? DEFAULT_DOOR_WIDTH_FT : DEFAULT_WINDOW_WIDTH_FT)
}

export function sketch3dOpeningHeightFt(opening: Opening, roomHeightFt: number): number {
  const raw = opening.kind === 'door' ? (opening.h ?? DEFAULT_DOOR_HEIGHT_FT) : (opening.h ?? DEFAULT_WINDOW_HEIGHT_FT)
  return Math.max(0.2, Math.min(raw, Math.max(0.2, roomHeightFt)))
}

export function sketch3dOpeningSillFt(opening: Opening, roomHeightFt: number): number {
  if (opening.kind === 'door') return 0
  const height = sketch3dOpeningHeightFt(opening, roomHeightFt)
  return Math.max(0, Math.min(opening.sill ?? DEFAULT_WINDOW_SILL_FT, Math.max(0, roomHeightFt - height)))
}

export function sketch3dEachSegment(model: Sketch3DModel): Sketch3DSegment[] {
  const out: Sketch3DSegment[] = []
  model.contours.forEach((contour, c) => {
    for (let s = 0; s < contour.points.length - 1; s++) out.push({ c, s, a: contour.points[s], b: contour.points[s + 1] })
    if (contour.closed && contour.points.length >= 3) out.push({ c, s: contour.points.length - 1, a: contour.points[contour.points.length - 1], b: contour.points[0] })
  })
  return out
}

export function sketch3dSegmentSharedKey(segment: Sketch3DSegment): string {
  const pointKey = (point: Pt) => `${Math.round(point.x * 10000)}:${Math.round(point.y * 10000)}`
  const a = pointKey(segment.a)
  const b = pointKey(segment.b)
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function sketch3dSegmentWorld(model: Sketch3DModel, c: number, s: number): Sketch3DSegment | null {
  const contour = model.contours[c]
  if (!contour) return null
  const a = contour.points[s]
  const b = s + 1 < contour.points.length ? contour.points[s + 1] : (contour.closed ? contour.points[0] : null)
  if (!a || !b) return null
  return { c, s, a, b }
}

function segmentInfo(model: Sketch3DModel, segment: Sketch3DSegment): SegmentInfo | null {
  const cellFt = sketch3dModelCellFt(model)
  const wallA = { x: segment.a.x * cellFt, z: segment.a.y * cellFt }
  const wallB = { x: segment.b.x * cellFt, z: segment.b.y * cellFt }
  const dx = wallB.x - wallA.x
  const dz = wallB.z - wallA.z
  const lengthFt = Math.hypot(dx, dz)
  if (lengthFt <= 0.01) return null
  return { wallA, wallB, ux: dx / lengthFt, uz: dz / lengthFt, lengthFt }
}

export function sketch3dOpeningEnds(model: Sketch3DModel, opening: Opening): { a: Pt; b: Pt } | null {
  const segment = sketch3dSegmentWorld(model, opening.c, opening.s)
  return segment ? { a: segment.a, b: segment.b } : null
}

export function sketch3dClampOpeningT(model: Sketch3DModel, opening: Opening, t: number): number {
  const ends = sketch3dOpeningEnds(model, opening)
  if (!ends) return clampNumber(t, 0, 1)
  const segmentLengthFt = Math.hypot(ends.a.x - ends.b.x, ends.a.y - ends.b.y) * sketch3dModelCellFt(model)
  if (segmentLengthFt <= 0.001) return 0.5
  const widthFt = Math.max(0.1, Math.min(sketch3dOpeningWidthFt(opening), segmentLengthFt))
  if (widthFt >= segmentLengthFt - 0.001) return 0.5
  const padT = (widthFt / 2) / segmentLengthFt
  return clampNumber(t, padT, 1 - padT)
}

export function sketch3dOpeningMetrics(model: Sketch3DModel, opening: Opening, roomHeightFt: number): Sketch3DOpeningMetrics | null {
  const segment = sketch3dSegmentWorld(model, opening.c, opening.s)
  const info = segment ? segmentInfo(model, segment) : null
  if (!segment || !info) return null
  const width = Math.max(0.2, Math.min(sketch3dOpeningWidthFt(opening), info.lengthFt))
  const height = sketch3dOpeningHeightFt(opening, roomHeightFt)
  const sill = sketch3dOpeningSillFt(opening, roomHeightFt)
  const clampedT = sketch3dClampOpeningT(model, opening, opening.t)
  const centerDistance = clampedT * info.lengthFt
  const centerX = info.wallA.x + info.ux * centerDistance
  const centerZ = info.wallA.z + info.uz * centerDistance
  let nx = -info.uz
  let nz = info.ux
  const contour = model.contours[opening.c]
  if (contour?.points.length) {
    const contourCenter = sketch3dContourCenterWorld(contour, sketch3dModelCellFt(model))
    const midX = (info.wallA.x + info.wallB.x) / 2
    const midZ = (info.wallA.z + info.wallB.z) / 2
    if ((contourCenter.x - midX) * nx + (contourCenter.z - midZ) * nz > 0) {
      nx *= -1
      nz *= -1
    }
  }
  const half = width / 2
  return {
    centerX,
    centerZ,
    ux: info.ux,
    uz: info.uz,
    nx,
    nz,
    rotationY: -Math.atan2(info.uz, info.ux),
    width,
    height,
    sill,
    wallLength: info.lengthFt,
    left: Math.max(0, centerDistance - half),
    right: Math.max(0, info.lengthFt - centerDistance - half),
    edgeA: { x: centerX - info.ux * half, z: centerZ - info.uz * half },
    edgeB: { x: centerX + info.ux * half, z: centerZ + info.uz * half },
    wallA: info.wallA,
    wallB: info.wallB,
  }
}

function openingCutForSegment(
  model: Sketch3DModel,
  segment: Sketch3DSegment,
  opening: Opening,
  openingIndex: number,
  roomHeightFt: number,
): Sketch3DWallOpeningCut | null {
  const targetInfo = segmentInfo(model, segment)
  const sourceSegment = sketch3dSegmentWorld(model, opening.c, opening.s)
  if (!targetInfo || !sourceSegment) return null
  if (sketch3dSegmentSharedKey(segment) !== sketch3dSegmentSharedKey(sourceSegment)) return null
  const metrics = sketch3dOpeningMetrics(model, opening, roomHeightFt)
  if (!metrics) return null
  const centerFt = (metrics.centerX - targetInfo.wallA.x) * targetInfo.ux + (metrics.centerZ - targetInfo.wallA.z) * targetInfo.uz
  const half = metrics.width / 2
  const leftFt = clampNumber(centerFt - half, 0, targetInfo.lengthFt)
  const rightFt = clampNumber(centerFt + half, 0, targetInfo.lengthFt)
  if (rightFt - leftFt < MIN_WALL_PIECE_FT) return null
  return {
    opening,
    openingIndex,
    kind: opening.kind,
    sourceWallKey: sketchWallKey(opening.c, opening.s),
    centerFt: clampNumber(centerFt, 0, targetInfo.lengthFt),
    leftFt,
    rightFt,
    widthFt: rightFt - leftFt,
    heightFt: metrics.height,
    sillFt: metrics.sill,
  }
}

export function sketch3dOpeningsForSegment(model: Sketch3DModel, segment: Sketch3DSegment, roomHeightFt: number): Sketch3DWallOpeningCut[] {
  return model.openings
    .map((opening, openingIndex) => openingCutForSegment(model, segment, opening, openingIndex, roomHeightFt))
    .filter((opening): opening is Sketch3DWallOpeningCut => Boolean(opening))
    .sort((a, b) => a.leftFt - b.leftFt || a.rightFt - b.rightFt || a.openingIndex - b.openingIndex)
}

function pushWallPiece(
  pieces: Sketch3DWallPiece[],
  kind: Sketch3DWallPieceKind,
  startFt: number,
  endFt: number,
  bottomFt: number,
  topFt: number,
  openingIndex?: number,
) {
  const width = endFt - startFt
  const height = topFt - bottomFt
  if (width < MIN_WALL_PIECE_FT || height < MIN_WALL_PIECE_FT) return
  const piece: Sketch3DWallPiece = { kind, startFt, endFt, bottomFt, topFt }
  if (openingIndex !== undefined) piece.openingIndex = openingIndex
  pieces.push(piece)
}

export function buildSketch3DWallPlan(model: Sketch3DModel, segment: Sketch3DSegment, roomHeightFt: number): Sketch3DWallPlan {
  const info = segmentInfo(model, segment)
  const wallLengthFt = info?.lengthFt ?? 0
  if (!info) return { wallLengthFt, openings: [], pieces: [] }

  const openings = sketch3dOpeningsForSegment(model, segment, roomHeightFt)
  const pieces: Sketch3DWallPiece[] = []
  let blockedUntil = 0

  openings.forEach((opening) => {
    if (opening.leftFt > blockedUntil + MIN_WALL_PIECE_FT) {
      pushWallPiece(pieces, 'pier', blockedUntil, opening.leftFt, 0, roomHeightFt)
    }
    blockedUntil = Math.max(blockedUntil, opening.rightFt)
  })
  if (blockedUntil < wallLengthFt - MIN_WALL_PIECE_FT) {
    pushWallPiece(pieces, 'pier', blockedUntil, wallLengthFt, 0, roomHeightFt)
  }

  openings.forEach((opening) => {
    const openingTopFt = clampNumber(opening.sillFt + opening.heightFt, 0, roomHeightFt)
    pushWallPiece(pieces, 'header', opening.leftFt, opening.rightFt, openingTopFt, roomHeightFt, opening.openingIndex)
    if (opening.sillFt > MIN_WALL_PIECE_FT) {
      pushWallPiece(pieces, 'sill', opening.leftFt, opening.rightFt, 0, Math.min(opening.sillFt, roomHeightFt), opening.openingIndex)
    }
  })

  pieces.sort((a, b) => a.startFt - b.startFt || a.bottomFt - b.bottomFt || a.topFt - b.topFt)
  return { wallLengthFt, openings, pieces }
}

function mergeSpans(spans: Span[], limitFt: number): Span[] {
  const sorted = spans
    .map((span) => ({
      startFt: clampNumber(Math.min(span.startFt, span.endFt), 0, limitFt),
      endFt: clampNumber(Math.max(span.startFt, span.endFt), 0, limitFt),
    }))
    .filter((span) => span.endFt - span.startFt >= MIN_WALL_PIECE_FT)
    .sort((a, b) => a.startFt - b.startFt || a.endFt - b.endFt)
  const merged: Span[] = []
  sorted.forEach((span) => {
    const prev = merged[merged.length - 1]
    if (!prev || span.startFt > prev.endFt + MIN_WALL_PIECE_FT) {
      merged.push({ ...span })
    } else {
      prev.endFt = Math.max(prev.endFt, span.endFt)
    }
  })
  return merged
}

function complementSpans(openSpans: Span[], wallLengthFt: number): Span[] {
  const merged = mergeSpans(openSpans, wallLengthFt)
  const solid: Span[] = []
  let cursor = 0
  merged.forEach((span) => {
    if (span.startFt > cursor + MIN_WALL_PIECE_FT) solid.push({ startFt: cursor, endFt: span.startFt })
    cursor = Math.max(cursor, span.endFt)
  })
  if (cursor < wallLengthFt - MIN_WALL_PIECE_FT) solid.push({ startFt: cursor, endFt: wallLengthFt })
  return solid
}

export function sketch3dPassableDoorIntervalsForSegment(model: Sketch3DModel, segment: Sketch3DSegment, roomHeightFt: number): Span[] {
  const info = segmentInfo(model, segment)
  if (!info) return []
  return mergeSpans(
    sketch3dOpeningsForSegment(model, segment, roomHeightFt)
      .filter((opening) => opening.kind === 'door' && opening.sillFt <= 0.001)
      .map((opening) => ({ startFt: opening.leftFt, endFt: opening.rightFt })),
    info.lengthFt,
  )
}

function sketch3dContourSignedArea(contour: Contour): number {
  if (contour.points.length < 3) return 0
  let sum = 0
  contour.points.forEach((point, index) => {
    const next = contour.points[(index + 1) % contour.points.length]
    sum += point.x * next.y - next.x * point.y
  })
  return sum / 2
}

export function sketch3dContourCenterWorld(contour: Contour, cellFt: number): { x: number; z: number } {
  const area = sketch3dContourSignedArea(contour)
  if (Math.abs(area) > EPS) {
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

export function sketch3dPointInContourWorld(contour: Contour, cellFt: number, x: number, z: number): boolean {
  let inside = false
  const points = contour.points
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x * cellFt
    const zi = points[i].y * cellFt
    const xj = points[j].x * cellFt
    const zj = points[j].y * cellFt
    const denom = zj - zi
    const atX = ((xj - xi) * (z - zi)) / (Math.abs(denom) < EPS ? EPS : denom) + xi
    const intersects = ((zi > z) !== (zj > z)) && x < atX
    if (intersects) inside = !inside
  }
  return inside
}

function nearestDistanceToWallSpan(
  model: Sketch3DModel,
  segment: Sketch3DSegment,
  span: Span,
  x: number,
  z: number,
): { distance: number; normal: Sketch3DInsideVector } | null {
  const info = segmentInfo(model, segment)
  if (!info || span.endFt - span.startFt < MIN_WALL_PIECE_FT) return null
  const projectedFt = clampNumber((x - info.wallA.x) * info.ux + (z - info.wallA.z) * info.uz, span.startFt, span.endFt)
  const cx = info.wallA.x + info.ux * projectedFt
  const cz = info.wallA.z + info.uz * projectedFt
  const distance = Math.hypot(x - cx, z - cz)
  let normal = normalizeVector(x - cx, z - cz)
  if (distance <= EPS) {
    const contour = model.contours[segment.c]
    const center = contour ? sketch3dContourCenterWorld(contour, sketch3dModelCellFt(model)) : null
    normal = center ? normalizeVector(center.x - cx, center.z - cz) : normalizeVector(-info.uz, info.ux)
  }
  return { distance, normal }
}

export function evaluateSketch3DInsideStanding(
  model: Sketch3DModel,
  x: number,
  z: number,
  options: { wallClearanceFt: number; roomHeightFt?: number },
): Sketch3DInsideStandingResult {
  const cellFt = sketch3dModelCellFt(model)
  const closedContours = model.contours
    .map((contour, c) => ({ contour, c }))
    .filter(({ contour }) => contour.closed && contour.points.length >= 3)

  if (closedContours.length === 0) return { valid: true, score: 100, normal: null }

  let nearestAnyWallDistance = Number.POSITIVE_INFINITY
  let nearestAnyWallNormal: Sketch3DInsideVector | null = null
  const insideAny = closedContours.some(({ contour }) => sketch3dPointInContourWorld(contour, cellFt, x, z))

  let score = Number.POSITIVE_INFINITY
  let blockingScore = Number.POSITIVE_INFINITY
  let normal: Sketch3DInsideVector | null = null
  const roomHeightFt = options.roomHeightFt ?? 8

  closedContours.forEach(({ contour, c }) => {
    const segmentCount = contour.closed && contour.points.length >= 3 ? contour.points.length : Math.max(0, contour.points.length - 1)
    for (let s = 0; s < segmentCount; s++) {
      const segment = sketch3dSegmentWorld(model, c, s)
      const info = segment ? segmentInfo(model, segment) : null
      if (!segment || !info) continue
      const solidSpans = complementSpans(sketch3dPassableDoorIntervalsForSegment(model, segment, roomHeightFt), info.lengthFt)
      solidSpans.forEach((span) => {
        const result = nearestDistanceToWallSpan(model, segment, span, x, z)
        if (!result) return
        if (result.distance < nearestAnyWallDistance) {
          nearestAnyWallDistance = result.distance
          nearestAnyWallNormal = result.normal
        }
        const wallScore = result.distance - options.wallClearanceFt
        score = Math.min(score, wallScore)
        if (wallScore < -0.0001 && wallScore < blockingScore) {
          blockingScore = wallScore
          normal = result.normal
        }
      })
    }
  })

  if (!insideAny) {
    return {
      valid: false,
      score: Number.isFinite(score) ? Math.min(score, -options.wallClearanceFt) : -options.wallClearanceFt,
      normal: normal ?? nearestAnyWallNormal,
    }
  }

  return { valid: blockingScore === Number.POSITIVE_INFINITY, score: Number.isFinite(score) ? score : 100, normal }
}

export function sketch3dFitPad(spanFt: number): number {
  const span = Number.isFinite(spanFt) && spanFt > 0 ? spanFt : 12
  return Math.max(2.5, Math.min(14, span * 0.16))
}

export function sketch3dFitDistanceForExtents(params: {
  halfWidthFt: number
  halfHeightFt: number
  depthHalfFt: number
  verticalFovRad: number
  aspect: number
  minCameraDistanceFt: number
  maxCameraDistanceFt: number
}): number {
  const vFov = Math.max(0.01, params.verticalFovRad)
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.1, params.aspect))
  const baseDistance = Math.max(params.halfHeightFt / Math.tan(vFov / 2), params.halfWidthFt / Math.tan(hFov / 2)) + Math.max(0, params.depthHalfFt)
  const fitDistance = baseDistance * SKETCH_3D_CAMERA_AIR_MULTIPLIER
  return Math.max(
    params.minCameraDistanceFt,
    Math.min(params.maxCameraDistanceFt * SKETCH_3D_CAMERA_MAX_DISTANCE_FRACTION, fitDistance),
  )
}
