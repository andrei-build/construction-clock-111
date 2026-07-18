import type { Opening, Pt } from './sketchFinishes'
import {
  isToiletPlacedCatalogItem,
  type CatalogPlacementSurface,
  type SketchPlacedCatalogItem,
} from './sketchCatalog'
import { formatInches } from './inches'

const CELL_FT = 1
const DOOR_W_FT = 3
const DOOR_H_FT = 80 / 12
const WIN_W_FT = 3
const WIN_H_FT = 4
const WIN_SILL_FT = 3
const IN_PER_FT = 12
const EPS = 0.000001

export const CODE_CLEARANCE_REFERENCES = {
  toiletSide: {
    code: 'IRC P2705.1 / UPC 402.5',
    url: 'https://codes.iccsafe.org/content/IRC2021P1/chapter-27-plumbing-fixtures',
  },
  toiletFront: {
    code: 'IRC R307.1',
    url: 'https://codes.iccsafe.org/s/IRC2021P2/part-iii-building-planning-and-construction/IRC2021P2-Pt03-Ch03-SecR307',
  },
  showerSize: {
    code: 'IRC P2708.1',
    url: 'https://codes.iccsafe.org/s/IRC2024P2/chapter-27-plumbing-fixtures/IRC2024P2-Pt07-Ch27-SecP2708.1',
  },
  doorSwing: {
    code: 'IRC R307.1',
    url: 'https://codes.iccsafe.org/s/IRC2021P2/part-iii-building-planning-and-construction/IRC2021P2-Pt03-Ch03-SecR307',
  },
} as const

export const CODE_CLEARANCE_MINIMUMS_IN = {
  // IRC P2705.1 and WA UPC 402.5: 15 in from water closet centerline to side wall/obstruction.
  // https://codes.iccsafe.org/content/IRC2021P1/chapter-27-plumbing-fixtures
  // https://app.leg.wa.gov/wac/default.aspx?cite=51-56-0400
  toiletSideCenterline: 15,
  // IRC R307.1/Figure R307.1: 21 in clear space in front of bathroom fixtures.
  // https://codes.iccsafe.org/s/IRC2021P2/part-iii-building-planning-and-construction/IRC2021P2-Pt03-Ch03-SecR307
  toiletFrontClear: 21,
  // IRC P2705.1: lavatory centerline 15 in minimum from a side wall/partition/vanity.
  // https://codes.iccsafe.org/content/IRC2021P1/chapter-27-plumbing-fixtures
  vanitySideCenterline: 15,
  // IRC P2708.1: shower compartment minimum finished interior dimension is 30 in.
  // https://codes.iccsafe.org/s/IRC2024P2/chapter-27-plumbing-fixtures/IRC2024P2-Pt07-Ch27-SecP2708.1
  showerInteriorDimension: 30,
} as const

export type CodeClearancePoint = { x: number; z: number }
export type CodeClearanceLine = { a: CodeClearancePoint; b: CodeClearancePoint }
export type CodeClearanceArc = {
  center: CodeClearancePoint
  radiusFt: number
  start: CodeClearancePoint
  end: CodeClearancePoint
}

export type CodeClearanceEntityKind = 'toilet' | 'vanity' | 'shower' | 'door' | 'wall' | 'item'

export type CodeClearanceEntity = {
  kind: CodeClearanceEntityKind
  id: string
  label?: string
  wall?: { c: number; s: number }
}

export type CodeClearanceCheckType =
  | 'toilet-side'
  | 'toilet-front'
  | 'vanity-side'
  | 'shower-size'
  | 'door-swing'

export type CodeClearanceDirection = 'left' | 'right' | 'front' | 'width' | 'depth' | 'swing'

export type CodeClearanceCheck = {
  id: string
  type: CodeClearanceCheckType
  direction: CodeClearanceDirection
  subject: CodeClearanceEntity
  target: CodeClearanceEntity
  actualIn: number
  requiredIn: number
  code: string
  codeUrl: string
  ok: boolean
  line?: CodeClearanceLine
  arc?: CodeClearanceArc
}

export type CodeClearanceViolation = CodeClearanceCheck & { ok: false }

export type CodeClearanceContour = { points: Pt[]; closed: boolean }

export type CodeClearanceModel = {
  cellFt?: number
  contours: CodeClearanceContour[]
  openings?: Opening[]
  placedItems?: SketchPlacedCatalogItem[]
}

export type CodeClearanceTranslator = (key: string) => string

type Vec = { x: number; z: number }
type WallSegment = { c: number; s: number; a: Vec; b: Vec }
type ItemDims = {
  widthIn: number
  depthIn: number
  heightIn: number
  widthFt: number
  depthFt: number
  heightFt: number
}
type SizedPlacedItem = { item: SketchPlacedCatalogItem; dims: ItemDims }
type RayHit = {
  distanceFt: number
  point: Vec
  entity: CodeClearanceEntity
}

function finite(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function positive(value: unknown): number | null {
  const n = finite(value)
  return n !== null && n > 0 ? n : null
}

function modelCellFt(model: CodeClearanceModel): number {
  const cellFt = finite(model.cellFt)
  return cellFt !== null && cellFt > 0 ? cellFt : CELL_FT
}

function openingWidthFt(opening: Opening): number {
  return opening.w ?? (opening.kind === 'door' ? DOOR_W_FT : WIN_W_FT)
}

function openingHeightFt(opening: Opening): number {
  return opening.kind === 'door' ? (opening.h ?? DOOR_H_FT) : (opening.h ?? WIN_H_FT)
}

function openingFloorFt(opening: Opening): number {
  return opening.kind === 'door' ? 0 : (opening.sill ?? WIN_SILL_FT)
}

function toIn(valueFt: number): number {
  return valueFt * IN_PER_FT
}

function toFt(valueIn: number): number {
  return valueIn / IN_PER_FT
}

function roundIn(valueIn: number): number {
  return Number.isFinite(valueIn) ? Math.max(0, Number(valueIn.toFixed(3))) : 0
}

function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.z * b.z
}

function cross(a: Vec, b: Vec): number {
  return a.x * b.z - a.z * b.x
}

function add(a: Vec, b: Vec, scale = 1): Vec {
  return { x: a.x + b.x * scale, z: a.z + b.z * scale }
}

function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, z: a.z - b.z }
}

function normalize(v: Vec): Vec {
  const len = Math.hypot(v.x, v.z)
  return len > EPS ? { x: v.x / len, z: v.z / len } : { x: 1, z: 0 }
}

function contourCenter(contour: CodeClearanceContour, cellFt: number): Vec {
  if (contour.points.length === 0) return { x: 0, z: 0 }
  const sum = contour.points.reduce((acc, point) => ({ x: acc.x + point.x * cellFt, z: acc.z + point.y * cellFt }), { x: 0, z: 0 })
  return { x: sum.x / contour.points.length, z: sum.z / contour.points.length }
}

function wallSegments(model: CodeClearanceModel): WallSegment[] {
  const cellFt = modelCellFt(model)
  const out: WallSegment[] = []
  model.contours.forEach((contour, c) => {
    for (let s = 0; s < contour.points.length - 1; s++) {
      out.push({
        c,
        s,
        a: { x: contour.points[s].x * cellFt, z: contour.points[s].y * cellFt },
        b: { x: contour.points[s + 1].x * cellFt, z: contour.points[s + 1].y * cellFt },
      })
    }
    if (contour.closed && contour.points.length >= 3) {
      out.push({
        c,
        s: contour.points.length - 1,
        a: { x: contour.points[contour.points.length - 1].x * cellFt, z: contour.points[contour.points.length - 1].y * cellFt },
        b: { x: contour.points[0].x * cellFt, z: contour.points[0].y * cellFt },
      })
    }
  })
  return out.filter((seg) => dist(seg.a, seg.b) > 0.01)
}

function wallEntity(wall: WallSegment): CodeClearanceEntity {
  return { kind: 'wall', id: `wall:${wall.c}:${wall.s}`, wall: { c: wall.c, s: wall.s } }
}

function openingEntity(opening: Opening, index: number): CodeClearanceEntity {
  return { kind: 'door', id: `door:${index}`, wall: { c: opening.c, s: opening.s } }
}

function itemEntity(item: SketchPlacedCatalogItem): CodeClearanceEntity {
  if (isToiletPlacedCatalogItem(item)) return { kind: 'toilet', id: item.id, label: item.name }
  if (item.category === 'vanity') return { kind: 'vanity', id: item.id, label: item.name }
  if (item.category === 'shower') return { kind: 'shower', id: item.id, label: item.name }
  return { kind: 'item', id: item.id, label: item.name }
}

function placedDims(item: SketchPlacedCatalogItem): ItemDims | null {
  const widthIn = positive(item.widthIn)
  const depthIn = positive(item.depthIn)
  const heightIn = positive(item.heightIn)
  if (widthIn === null || depthIn === null || heightIn === null) return null
  return {
    widthIn,
    depthIn,
    heightIn,
    widthFt: toFt(widthIn),
    depthFt: toFt(depthIn),
    heightFt: toFt(heightIn),
  }
}

function sizedItems(model: CodeClearanceModel): SizedPlacedItem[] {
  return (model.placedItems ?? [])
    .map((item): SizedPlacedItem | null => {
      const dims = placedDims(item)
      return dims ? { item, dims } : null
    })
    .filter((item): item is SizedPlacedItem => !!item)
}

function blockingSurface(surface: CatalogPlacementSurface | undefined): boolean {
  return surface !== 'ceiling'
}

function isFixtureBlocker(item: SketchPlacedCatalogItem): boolean {
  if (!blockingSurface(item.surface)) return false
  return item.category !== 'light' && item.category !== 'fan'
}

function isSideObstruction(item: SketchPlacedCatalogItem): boolean {
  return isFixtureBlocker(item)
}

function itemAxes(item: Pick<SketchPlacedCatalogItem, 'rotationY'>): { side: Vec; forward: Vec } {
  const rotation = finite(item.rotationY) ?? 0
  const c = Math.cos(rotation)
  const s = Math.sin(rotation)
  return {
    side: { x: c, z: -s },
    forward: { x: s, z: c },
  }
}

function itemCenter(item: SketchPlacedCatalogItem): Vec {
  return { x: finite(item.xFt) ?? 0, z: finite(item.zFt) ?? 0 }
}

function localToWorld(item: SketchPlacedCatalogItem, localX: number, localZ: number): Vec {
  const center = itemCenter(item)
  const axes = itemAxes(item)
  return add(add(center, axes.side, localX), axes.forward, localZ)
}

function worldToLocal(item: SketchPlacedCatalogItem, point: Vec): Vec {
  const delta = sub(point, itemCenter(item))
  const axes = itemAxes(item)
  return { x: dot(delta, axes.side), z: dot(delta, axes.forward) }
}

function worldVectorToLocal(item: SketchPlacedCatalogItem, vector: Vec): Vec {
  const axes = itemAxes(item)
  return { x: dot(vector, axes.side), z: dot(vector, axes.forward) }
}

function itemFootprintCorners(item: SketchPlacedCatalogItem, dims: ItemDims): Vec[] {
  const halfW = dims.widthFt / 2
  const halfD = dims.depthFt / 2
  return [
    localToWorld(item, -halfW, -halfD),
    localToWorld(item, halfW, -halfD),
    localToWorld(item, halfW, halfD),
    localToWorld(item, -halfW, halfD),
  ]
}

function itemFootprintSamples(item: SketchPlacedCatalogItem, dims: ItemDims): Vec[] {
  const corners = itemFootprintCorners(item, dims)
  const center = itemCenter(item)
  return [
    center,
    ...corners,
    { x: (corners[0].x + corners[1].x) / 2, z: (corners[0].z + corners[1].z) / 2 },
    { x: (corners[1].x + corners[2].x) / 2, z: (corners[1].z + corners[2].z) / 2 },
    { x: (corners[2].x + corners[3].x) / 2, z: (corners[2].z + corners[3].z) / 2 },
    { x: (corners[3].x + corners[0].x) / 2, z: (corners[3].z + corners[0].z) / 2 },
  ]
}

function raySegmentDistance(origin: Vec, direction: Vec, wall: WallSegment): number | null {
  const ray = normalize(direction)
  const seg = sub(wall.b, wall.a)
  const denom = cross(ray, seg)
  if (Math.abs(denom) < EPS) return null
  const delta = sub(wall.a, origin)
  const t = cross(delta, seg) / denom
  const u = cross(delta, ray) / denom
  if (t < 0.0001 || u < -0.0001 || u > 1.0001) return null
  return t
}

function rayRectDistance(origin: Vec, direction: Vec, item: SketchPlacedCatalogItem, dims: ItemDims): number | null {
  const localOrigin = worldToLocal(item, origin)
  const localDirection = worldVectorToLocal(item, normalize(direction))
  const halfW = dims.widthFt / 2
  const halfD = dims.depthFt / 2
  let tMin = Number.NEGATIVE_INFINITY
  let tMax = Number.POSITIVE_INFINITY

  const testAxis = (originValue: number, directionValue: number, min: number, max: number): boolean => {
    if (Math.abs(directionValue) < EPS) return originValue >= min - EPS && originValue <= max + EPS
    const a = (min - originValue) / directionValue
    const b = (max - originValue) / directionValue
    tMin = Math.max(tMin, Math.min(a, b))
    tMax = Math.min(tMax, Math.max(a, b))
    return tMin <= tMax + EPS
  }

  if (!testAxis(localOrigin.x, localDirection.x, -halfW, halfW)) return null
  if (!testAxis(localOrigin.z, localDirection.z, -halfD, halfD)) return null
  if (tMax < 0.0001) return null
  return Math.max(0, tMin)
}

function rectContainsPoint(item: SketchPlacedCatalogItem, dims: ItemDims, point: Vec): boolean {
  const local = worldToLocal(item, point)
  return Math.abs(local.x) <= dims.widthFt / 2 + EPS && Math.abs(local.z) <= dims.depthFt / 2 + EPS
}

function nearestRayHit(
  model: CodeClearanceModel,
  items: SizedPlacedItem[],
  origin: Vec,
  direction: Vec,
  excludeItemId: string | null,
  includeItem: (item: SketchPlacedCatalogItem) => boolean,
): RayHit | null {
  let best: RayHit | null = null
  const ray = normalize(direction)

  const record = (distanceFt: number | null, entity: CodeClearanceEntity) => {
    if (distanceFt === null || distanceFt < 0) return
    if (!best || distanceFt < best.distanceFt) {
      best = {
        distanceFt,
        point: add(origin, ray, distanceFt),
        entity,
      }
    }
  }

  wallSegments(model).forEach((wall) => record(raySegmentDistance(origin, ray, wall), wallEntity(wall)))
  items.forEach(({ item, dims }) => {
    if (item.id === excludeItemId || !includeItem(item)) return
    record(rayRectDistance(origin, ray, item, dims), itemEntity(item))
  })

  return best
}

function nearestWallRayHit(model: CodeClearanceModel, origin: Vec, direction: Vec): RayHit | null {
  let best: RayHit | null = null
  const ray = normalize(direction)
  wallSegments(model).forEach((wall) => {
    const distanceFt = raySegmentDistance(origin, ray, wall)
    if (distanceFt === null) return
    if (!best || distanceFt < best.distanceFt) {
      best = {
        distanceFt,
        point: add(origin, ray, distanceFt),
        entity: wallEntity(wall),
      }
    }
  })
  return best
}

function makeDistanceCheck(
  id: string,
  type: CodeClearanceCheckType,
  direction: CodeClearanceDirection,
  subject: CodeClearanceEntity,
  target: CodeClearanceEntity,
  origin: Vec,
  hit: RayHit,
  requiredIn: number,
  reference: typeof CODE_CLEARANCE_REFERENCES[keyof typeof CODE_CLEARANCE_REFERENCES],
): CodeClearanceCheck {
  const actualIn = roundIn(toIn(hit.distanceFt))
  return {
    id,
    type,
    direction,
    subject,
    target,
    actualIn,
    requiredIn,
    code: reference.code,
    codeUrl: reference.url,
    ok: actualIn + 0.001 >= requiredIn,
    line: { a: origin, b: hit.point },
  }
}

function toiletSideChecks(model: CodeClearanceModel, items: SizedPlacedItem[], subject: SizedPlacedItem): CodeClearanceCheck[] {
  const axes = itemAxes(subject.item)
  const center = itemCenter(subject.item)
  const checks: CodeClearanceCheck[] = []
  const entity = itemEntity(subject.item)
  ;[
    { key: 'left' as const, dir: { x: -axes.side.x, z: -axes.side.z } },
    { key: 'right' as const, dir: axes.side },
  ].forEach(({ key, dir }) => {
    const hit = nearestRayHit(model, items, center, dir, subject.item.id, isSideObstruction)
    if (!hit) return
    checks.push(makeDistanceCheck(
      `${subject.item.id}:toilet-side:${key}`,
      'toilet-side',
      key,
      entity,
      hit.entity,
      center,
      hit,
      CODE_CLEARANCE_MINIMUMS_IN.toiletSideCenterline,
      CODE_CLEARANCE_REFERENCES.toiletSide,
    ))
  })
  return checks
}

function toiletFrontCheck(model: CodeClearanceModel, items: SizedPlacedItem[], subject: SizedPlacedItem): CodeClearanceCheck | null {
  const axes = itemAxes(subject.item)
  const front = add(itemCenter(subject.item), axes.forward, subject.dims.depthFt / 2)
  const hit = nearestRayHit(model, items, front, axes.forward, subject.item.id, isFixtureBlocker)
  if (!hit) return null
  return makeDistanceCheck(
    `${subject.item.id}:toilet-front`,
    'toilet-front',
    'front',
    itemEntity(subject.item),
    hit.entity,
    front,
    hit,
    CODE_CLEARANCE_MINIMUMS_IN.toiletFrontClear,
    CODE_CLEARANCE_REFERENCES.toiletFront,
  )
}

function vanitySideChecks(model: CodeClearanceModel, subject: SizedPlacedItem): CodeClearanceCheck[] {
  const axes = itemAxes(subject.item)
  const center = itemCenter(subject.item)
  const checks: CodeClearanceCheck[] = []
  const entity = itemEntity(subject.item)
  ;[
    { key: 'left' as const, dir: { x: -axes.side.x, z: -axes.side.z } },
    { key: 'right' as const, dir: axes.side },
  ].forEach(({ key, dir }) => {
    const hit = nearestWallRayHit(model, center, dir)
    if (!hit) return
    checks.push(makeDistanceCheck(
      `${subject.item.id}:vanity-side:${key}`,
      'vanity-side',
      key,
      entity,
      hit.entity,
      center,
      hit,
      CODE_CLEARANCE_MINIMUMS_IN.vanitySideCenterline,
      CODE_CLEARANCE_REFERENCES.toiletSide,
    ))
  })
  return checks
}

function showerSizeChecks(subject: SizedPlacedItem): CodeClearanceCheck[] {
  const entity = itemEntity(subject.item)
  const center = itemCenter(subject.item)
  const axes = itemAxes(subject.item)
  const reference = CODE_CLEARANCE_REFERENCES.showerSize
  const requiredIn = CODE_CLEARANCE_MINIMUMS_IN.showerInteriorDimension
  const target = entity
  return [
    {
      id: `${subject.item.id}:shower-width`,
      type: 'shower-size',
      direction: 'width',
      subject: entity,
      target,
      actualIn: roundIn(subject.dims.widthIn),
      requiredIn,
      code: reference.code,
      codeUrl: reference.url,
      ok: subject.dims.widthIn + 0.001 >= requiredIn,
      line: {
        a: add(center, axes.side, -subject.dims.widthFt / 2),
        b: add(center, axes.side, subject.dims.widthFt / 2),
      },
    },
    {
      id: `${subject.item.id}:shower-depth`,
      type: 'shower-size',
      direction: 'depth',
      subject: entity,
      target,
      actualIn: roundIn(subject.dims.depthIn),
      requiredIn,
      code: reference.code,
      codeUrl: reference.url,
      ok: subject.dims.depthIn + 0.001 >= requiredIn,
      line: {
        a: add(center, axes.forward, -subject.dims.depthFt / 2),
        b: add(center, axes.forward, subject.dims.depthFt / 2),
      },
    },
  ]
}

function openingEnds(model: CodeClearanceModel, opening: Opening): { a: Pt; b: Pt } | null {
  const contour = model.contours[opening.c]
  if (!contour) return null
  const a = contour.points[opening.s]
  const b = opening.s + 1 < contour.points.length ? contour.points[opening.s + 1] : (contour.closed ? contour.points[0] : null)
  if (!a || !b) return null
  return { a, b }
}

function doorMetrics(model: CodeClearanceModel, opening: Opening): {
  hinge: Vec
  closedEnd: Vec
  openEnd: Vec
  center: Vec
  radiusFt: number
  along: Vec
  inward: Vec
} | null {
  const ends = openingEnds(model, opening)
  if (!ends) return null
  const cellFt = modelCellFt(model)
  const a = { x: ends.a.x * cellFt, z: ends.a.y * cellFt }
  const b = { x: ends.b.x * cellFt, z: ends.b.y * cellFt }
  const delta = sub(b, a)
  const wallLength = Math.hypot(delta.x, delta.z)
  if (wallLength <= 0.01) return null
  const along = normalize(delta)
  const widthFt = Math.max(0.2, Math.min(openingWidthFt(opening), wallLength))
  const centerDistance = Math.max(widthFt / 2, Math.min(wallLength - widthFt / 2, opening.t * wallLength))
  const center = add(a, along, centerDistance)
  const hinge = add(center, along, -widthFt / 2)
  const closedEnd = add(hinge, along, widthFt)
  let outside = normalize({ x: -along.z, z: along.x })
  const contour = model.contours[opening.c]
  if (contour) {
    const roomCenter = contourCenter(contour, cellFt)
    const wallMid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
    if (dot(sub(roomCenter, wallMid), outside) > 0) outside = { x: -outside.x, z: -outside.z }
  }
  const inward = { x: -outside.x, z: -outside.z }
  return {
    hinge,
    closedEnd,
    openEnd: add(hinge, inward, widthFt),
    center,
    radiusFt: widthFt,
    along,
    inward,
  }
}

function pointInDoorSweep(point: Vec, metrics: NonNullable<ReturnType<typeof doorMetrics>>): boolean {
  const rel = sub(point, metrics.hinge)
  const along = dot(rel, metrics.along)
  const inward = dot(rel, metrics.inward)
  return along >= -0.04
    && inward >= -0.04
    && along <= metrics.radiusFt + 0.04
    && inward <= metrics.radiusFt + 0.04
    && Math.hypot(along, inward) <= metrics.radiusFt + 0.04
}

function doorSweepHitsItem(metrics: NonNullable<ReturnType<typeof doorMetrics>>, subject: SizedPlacedItem): boolean {
  if (!isFixtureBlocker(subject.item)) return false
  if (itemFootprintSamples(subject.item, subject.dims).some((point) => pointInDoorSweep(point, metrics))) return true
  return rectContainsPoint(subject.item, subject.dims, metrics.closedEnd) || rectContainsPoint(subject.item, subject.dims, metrics.openEnd)
}

function doorSwingChecks(model: CodeClearanceModel, items: SizedPlacedItem[]): CodeClearanceCheck[] {
  const checks: CodeClearanceCheck[] = []
  ;(model.openings ?? []).forEach((opening, index) => {
    if (opening.kind !== 'door') return
    const metrics = doorMetrics(model, opening)
    if (!metrics) return
    items.forEach((item) => {
      if (!doorSweepHitsItem(metrics, item)) return
      const reference = CODE_CLEARANCE_REFERENCES.doorSwing
      checks.push({
        id: `door:${index}:swing:${item.item.id}`,
        type: 'door-swing',
        direction: 'swing',
        subject: openingEntity(opening, index),
        target: itemEntity(item.item),
        actualIn: 0,
        requiredIn: 0,
        code: reference.code,
        codeUrl: reference.url,
        ok: false,
        line: { a: metrics.hinge, b: itemCenter(item.item) },
        arc: {
          center: metrics.hinge,
          radiusFt: metrics.radiusFt,
          start: metrics.closedEnd,
          end: metrics.openEnd,
        },
      })
    })
  })
  return checks
}

export function getCodeClearanceChecks(model: CodeClearanceModel): CodeClearanceCheck[] {
  const items = sizedItems(model)
  const checks: CodeClearanceCheck[] = []
  items.forEach((subject) => {
    if (isToiletPlacedCatalogItem(subject.item)) {
      checks.push(...toiletSideChecks(model, items, subject))
      const front = toiletFrontCheck(model, items, subject)
      if (front) checks.push(front)
      return
    }
    if (subject.item.category === 'vanity') {
      checks.push(...vanitySideChecks(model, subject))
      return
    }
    if (subject.item.category === 'shower') {
      checks.push(...showerSizeChecks(subject))
    }
  })
  checks.push(...doorSwingChecks(model, items))
  return checks
}

export function checkCodeClearances(model: CodeClearanceModel): CodeClearanceViolation[] {
  return getCodeClearanceChecks(model).filter((check): check is CodeClearanceViolation => !check.ok)
}

export function codeClearanceItemIds(checks: CodeClearanceCheck[]): Set<string> {
  const ids = new Set<string>()
  checks.forEach((check) => {
    if (check.subject.kind !== 'wall' && check.subject.kind !== 'door') ids.add(check.subject.id)
    if (check.target.kind !== 'wall' && check.target.kind !== 'door') ids.add(check.target.id)
  })
  return ids
}

export function codeClearanceWallKeys(checks: CodeClearanceCheck[]): Set<string> {
  const keys = new Set<string>()
  checks.forEach((check) => {
    ;[check.subject, check.target].forEach((entity) => {
      if (entity.wall) keys.add(`${entity.wall.c}:${entity.wall.s}`)
    })
  })
  return keys
}

export function formatCodeClearanceIn(valueIn: number): string {
  return formatInches(valueIn).replace(/"$/, ' in')
}

export function codeClearanceEntityLabel(entity: CodeClearanceEntity, t: CodeClearanceTranslator): string {
  if (entity.kind === 'wall') return t('hub_sketch_code_target_wall')
  if (entity.kind === 'vanity') return t('hub_sketch_code_target_vanity')
  if (entity.kind === 'shower') return t('hub_sketch_code_target_shower')
  if (entity.kind === 'toilet') return t('hub_sketch_code_target_toilet')
  return entity.label?.trim() || t('hub_sketch_code_target_item')
}

export function formatCodeClearanceMessage(check: CodeClearanceCheck, t: CodeClearanceTranslator): string {
  const vars: Record<string, string> = {
    actual: formatCodeClearanceIn(check.actualIn),
    required: formatCodeClearanceIn(check.requiredIn),
    target: codeClearanceEntityLabel(check.target, t),
  }
  const key = check.type === 'door-swing'
    ? 'hub_sketch_code_msg_door'
    : check.type === 'shower-size'
      ? 'hub_sketch_code_msg_shower'
      : 'hub_sketch_code_msg_clearance'
  return t(key).replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '')
}
