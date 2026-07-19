export type SketchTemplatePoint = { x: number; y: number }
export type SketchTemplateContour = { points: SketchTemplatePoint[]; closed: boolean }
export type SketchTemplateOpening = {
  kind: 'door' | 'window'
  c: number
  s: number
  t: number
  w?: number
  h?: number
  sill?: number
}
export type SketchTemplatePlacedItem = {
  id: string
  xFt: number
  yFt: number
  zFt: number
  rotationY: number
  c?: number
  s?: number
  t?: number
  wallId?: string
  [key: string]: unknown
}
export type SketchTemplateModel = {
  version: 1
  cellFt: number
  height?: number
  contours: SketchTemplateContour[]
  openings: SketchTemplateOpening[]
  placedItems?: SketchTemplatePlacedItem[]
}
export type SketchRoomTemplate = {
  id: string
  name?: string
  labelKey?: string
  builtin?: boolean
  createdAt?: string
  model: SketchTemplateModel
}
export type SketchCopySelection =
  | { kind: 'contour'; c: number }
  | { kind: 'wall'; c: number; s: number }
export type SketchCopyResult<T extends SketchTemplateModel> = {
  model: T
  selection: SketchCopySelection
}

const EPS = 0.000001

function pointDistance(a: SketchTemplatePoint, b: SketchTemplatePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function modelCellFt(model: Pick<SketchTemplateModel, 'cellFt'>): number {
  return Number.isFinite(model.cellFt) && model.cellFt > 0 ? model.cellFt : 1
}

function wallKey(c: number, s: number): string {
  return `${c}:${s}`
}

function segmentPointIndexes(contour: SketchTemplateContour, segmentIndex: number): { start: number; end: number } | null {
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) return null
  if (segmentIndex < contour.points.length - 1) return { start: segmentIndex, end: segmentIndex + 1 }
  if (contour.closed && contour.points.length >= 3 && segmentIndex === contour.points.length - 1) return { start: segmentIndex, end: 0 }
  return null
}

function cloneContour(contour: SketchTemplateContour): SketchTemplateContour {
  return {
    closed: contour.closed,
    points: contour.points.map((point) => ({ x: point.x, y: point.y })),
  }
}

function cloneOpening(opening: SketchTemplateOpening): SketchTemplateOpening {
  return { ...opening }
}

function clonePlacedItem(item: SketchTemplatePlacedItem): SketchTemplatePlacedItem {
  return { ...item }
}

function contourBounds(contour: SketchTemplateContour): { minX: number; maxX: number; minY: number; maxY: number } {
  if (contour.points.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  const xs = contour.points.map((point) => point.x)
  const ys = contour.points.map((point) => point.y)
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  }
}

function modelBounds(model: Pick<SketchTemplateModel, 'contours'>): { minX: number; maxX: number; minY: number; maxY: number; hasPoints: boolean } {
  const points = model.contours.flatMap((contour) => contour.points)
  if (points.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0, hasPoints: false }
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    hasPoints: true,
  }
}

function translateContour(contour: SketchTemplateContour, offset: SketchTemplatePoint): SketchTemplateContour {
  return {
    closed: contour.closed,
    points: contour.points.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y })),
  }
}

function scaleAndTranslateContour(
  contour: SketchTemplateContour,
  fromCellFt: number,
  toCellFt: number,
  origin: SketchTemplatePoint,
): SketchTemplateContour {
  const scale = fromCellFt / toCellFt
  return {
    closed: contour.closed,
    points: contour.points.map((point) => ({
      x: point.x * scale + origin.x,
      y: point.y * scale + origin.y,
    })),
  }
}

function normalizeRadians(value: number): number {
  const full = Math.PI * 2
  const n = Number.isFinite(value) ? value : 0
  return ((n % full) + full) % full
}

function wallPose(model: Pick<SketchTemplateModel, 'cellFt' | 'contours'>, c: number, s: number) {
  const contour = model.contours[c]
  const indexes = contour ? segmentPointIndexes(contour, s) : null
  if (!contour || !indexes) return null
  const cellFt = modelCellFt(model)
  const a = contour.points[indexes.start]
  const b = contour.points[indexes.end]
  const ax = a.x * cellFt
  const az = a.y * cellFt
  const bx = b.x * cellFt
  const bz = b.y * cellFt
  const dx = bx - ax
  const dz = bz - az
  const length = Math.hypot(dx, dz)
  if (length <= EPS) return null
  const ux = dx / length
  const uz = dz / length
  return { ax, az, dx, dz, ux, uz, nx: -uz, nz: ux, angle: Math.atan2(uz, ux) }
}

export const BUILTIN_SKETCH_ROOM_TEMPLATES: SketchRoomTemplate[] = [
  {
    id: 'bath-5x8',
    labelKey: 'hub_sketch_template_bath_5x8',
    builtin: true,
    model: {
      version: 1,
      cellFt: 1,
      contours: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 8 }, { x: 0, y: 8 }] }],
      openings: [],
    },
  },
  {
    id: 'bath-8x10',
    labelKey: 'hub_sketch_template_bath_8x10',
    builtin: true,
    model: {
      version: 1,
      cellFt: 1,
      contours: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 10 }, { x: 0, y: 10 }] }],
      openings: [],
    },
  },
  {
    id: 'kitchen-i',
    labelKey: 'hub_sketch_template_kitchen_i',
    builtin: true,
    model: {
      version: 1,
      cellFt: 1,
      contours: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 }, { x: 0, y: 8 }] }],
      openings: [],
    },
  },
  {
    id: 'kitchen-l',
    labelKey: 'hub_sketch_template_kitchen_l',
    builtin: true,
    model: {
      version: 1,
      cellFt: 1,
      contours: [{
        closed: true,
        points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 }, { x: 8, y: 8 }, { x: 8, y: 12 }, { x: 0, y: 12 }],
      }],
      openings: [],
    },
  },
  {
    id: 'kitchen-u',
    labelKey: 'hub_sketch_template_kitchen_u',
    builtin: true,
    model: {
      version: 1,
      cellFt: 1,
      contours: [{
        closed: true,
        points: [
          { x: 0, y: 0 },
          { x: 14, y: 0 },
          { x: 14, y: 10 },
          { x: 10, y: 10 },
          { x: 10, y: 4 },
          { x: 4, y: 4 },
          { x: 4, y: 10 },
          { x: 0, y: 10 },
        ],
      }],
      openings: [],
    },
  },
  {
    id: 'bedroom',
    labelKey: 'hub_sketch_template_bedroom',
    builtin: true,
    model: {
      version: 1,
      cellFt: 1,
      contours: [{ closed: true, points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 12 }, { x: 0, y: 12 }] }],
      openings: [],
    },
  },
]

export function sketchContourPerimeterFt(contour: SketchTemplateContour, cellFt = 1): number {
  let total = 0
  for (let i = 1; i < contour.points.length; i += 1) total += pointDistance(contour.points[i - 1], contour.points[i])
  if (contour.closed && contour.points.length >= 3) total += pointDistance(contour.points[contour.points.length - 1], contour.points[0])
  return total * cellFt
}

export function sketchContourAreaSqft(contour: SketchTemplateContour, cellFt = 1): number {
  if (!contour.closed || contour.points.length < 3) return 0
  let sum = 0
  contour.points.forEach((point, index) => {
    const next = contour.points[(index + 1) % contour.points.length]
    sum += point.x * next.y - next.x * point.y
  })
  return Math.abs(sum) * cellFt * cellFt / 2
}

export function duplicateSketchContour(contour: SketchTemplateContour, offset: SketchTemplatePoint): SketchTemplateContour {
  return translateContour(contour, offset)
}

export function mirrorSketchContourX(contour: SketchTemplateContour, axisX = (contourBounds(contour).minX + contourBounds(contour).maxX) / 2): SketchTemplateContour {
  return {
    closed: contour.closed,
    points: contour.points.map((point) => ({ x: axisX * 2 - point.x, y: point.y })),
  }
}

export function suggestedSketchTemplateOrigin(
  model: Pick<SketchTemplateModel, 'contours'>,
  template: Pick<SketchTemplateModel, 'contours'>,
  gapCells = 3,
): SketchTemplatePoint {
  const base = modelBounds(model)
  const incoming = modelBounds(template)
  if (!base.hasPoints) {
    return { x: 2 - incoming.minX, y: 2 - incoming.minY }
  }
  return {
    x: base.maxX + gapCells - incoming.minX,
    y: base.minY - incoming.minY,
  }
}

export function repositionWallBoundTemplateItems<T extends SketchTemplatePlacedItem>(
  items: T[] | undefined,
  before: Pick<SketchTemplateModel, 'cellFt' | 'contours'>,
  after: Pick<SketchTemplateModel, 'cellFt' | 'contours'>,
): T[] | undefined {
  if (!items) return undefined
  return items.map((item) => {
    if (!Number.isInteger(item.c) || !Number.isInteger(item.s) || !Number.isFinite(item.t)) return item
    const c = item.c ?? 0
    const s = item.s ?? 0
    const oldPose = wallPose(before, c, s)
    const nextPose = wallPose(after, c, s)
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

export function templateFromSketchModel<T extends SketchTemplateModel>(
  id: string,
  name: string,
  model: T,
  selection?: { kind: 'contour'; c: number },
): SketchRoomTemplate | null {
  const cellFt = modelCellFt(model)
  if (selection) {
    const contour = model.contours[selection.c]
    if (!contour || contour.points.length < 2) return null
    const openings = model.openings
      .filter((opening) => opening.c === selection.c)
      .map((opening) => ({ ...cloneOpening(opening), c: 0 }))
    const placedItems = (model.placedItems ?? [])
      .filter((item) => item.c === selection.c)
      .map((item) => ({ ...clonePlacedItem(item), c: 0, wallId: Number.isInteger(item.s) ? wallKey(0, item.s ?? 0) : item.wallId }))
    return {
      id,
      name,
      createdAt: new Date().toISOString(),
      model: {
        version: 1,
        cellFt,
        height: model.height,
        contours: [cloneContour(contour)],
        openings,
        ...(placedItems.length > 0 ? { placedItems } : {}),
      },
    }
  }
  const placedItems = (model.placedItems ?? []).map(clonePlacedItem)
  return {
    id,
    name,
    createdAt: new Date().toISOString(),
    model: {
      version: 1,
      cellFt,
      height: model.height,
      contours: model.contours.map(cloneContour),
      openings: model.openings.map(cloneOpening),
      ...(placedItems.length > 0 ? { placedItems } : {}),
    },
  }
}

export function insertSketchTemplate<T extends SketchTemplateModel>(
  model: T,
  template: SketchRoomTemplate,
  origin: SketchTemplatePoint,
  idFactory: (prefix: string, sourceId?: string) => string,
): SketchCopyResult<T> | null {
  if (template.model.contours.length === 0) return null
  const targetCellFt = modelCellFt(model)
  const fromCellFt = modelCellFt(template.model)
  const baseContourIndex = model.contours.length
  const contours = template.model.contours.map((contour) => scaleAndTranslateContour(contour, fromCellFt, targetCellFt, origin))
  const openings = template.model.openings.map((opening) => ({ ...cloneOpening(opening), c: baseContourIndex + opening.c }))
  const placedOffsetXFt = origin.x * targetCellFt
  const placedOffsetZFt = origin.y * targetCellFt
  const placedItems = (template.model.placedItems ?? []).map((item) => {
    const nextC = Number.isInteger(item.c) ? baseContourIndex + (item.c ?? 0) : item.c
    return {
      ...clonePlacedItem(item),
      id: idFactory('placed', item.id),
      ...(Number.isInteger(nextC) ? { c: nextC } : {}),
      ...(Number.isInteger(nextC) && Number.isInteger(item.s) ? { wallId: wallKey(nextC ?? 0, item.s ?? 0) } : {}),
      xFt: item.xFt + placedOffsetXFt,
      zFt: item.zFt + placedOffsetZFt,
    }
  })
  return {
    model: {
      ...model,
      contours: [...model.contours, ...contours],
      openings: [...model.openings, ...openings],
      ...(placedItems.length > 0 ? { placedItems: [...(model.placedItems ?? []), ...placedItems] } : {}),
    } as T,
    selection: { kind: 'contour', c: baseContourIndex },
  }
}

export function duplicateSketchSelection<T extends SketchTemplateModel>(
  model: T,
  selection: SketchCopySelection,
  offset: SketchTemplatePoint,
  idFactory: (prefix: string, sourceId?: string) => string,
): SketchCopyResult<T> | null {
  const sourceContour = model.contours[selection.c]
  if (!sourceContour) return null
  const cellFt = modelCellFt(model)
  const baseContourIndex = model.contours.length
  const offsetXFt = offset.x * cellFt
  const offsetZFt = offset.y * cellFt

  if (selection.kind === 'wall') {
    const indexes = segmentPointIndexes(sourceContour, selection.s)
    if (!indexes) return null
    const contour: SketchTemplateContour = {
      closed: false,
      points: [sourceContour.points[indexes.start], sourceContour.points[indexes.end]].map((point) => ({
        x: point.x + offset.x,
        y: point.y + offset.y,
      })),
    }
    const openings = model.openings
      .filter((opening) => opening.c === selection.c && opening.s === selection.s)
      .map((opening) => ({ ...cloneOpening(opening), c: baseContourIndex, s: 0 }))
    const placedItems = (model.placedItems ?? [])
      .filter((item) => item.c === selection.c && item.s === selection.s)
      .map((item) => ({
        ...clonePlacedItem(item),
        id: idFactory('placed', item.id),
        c: baseContourIndex,
        s: 0,
        wallId: wallKey(baseContourIndex, 0),
        xFt: item.xFt + offsetXFt,
        zFt: item.zFt + offsetZFt,
      }))
    return {
      model: {
        ...model,
        contours: [...model.contours, contour],
        openings: [...model.openings, ...openings],
        ...(placedItems.length > 0 ? { placedItems: [...(model.placedItems ?? []), ...placedItems] } : {}),
      } as T,
      selection: { kind: 'wall', c: baseContourIndex, s: 0 },
    }
  }

  const contour = translateContour(sourceContour, offset)
  const openings = model.openings
    .filter((opening) => opening.c === selection.c)
    .map((opening) => ({ ...cloneOpening(opening), c: baseContourIndex }))
  const placedItems = (model.placedItems ?? [])
    .filter((item) => item.c === selection.c)
    .map((item) => ({
      ...clonePlacedItem(item),
      id: idFactory('placed', item.id),
      c: baseContourIndex,
      wallId: Number.isInteger(item.s) ? wallKey(baseContourIndex, item.s ?? 0) : item.wallId,
      xFt: item.xFt + offsetXFt,
      zFt: item.zFt + offsetZFt,
    }))
  return {
    model: {
      ...model,
      contours: [...model.contours, contour],
      openings: [...model.openings, ...openings],
      ...(placedItems.length > 0 ? { placedItems: [...(model.placedItems ?? []), ...placedItems] } : {}),
    } as T,
    selection: { kind: 'contour', c: baseContourIndex },
  }
}

export function mirrorSketchSelection<T extends SketchTemplateModel>(
  model: T,
  selection: SketchCopySelection,
  axisX: number,
  offset: SketchTemplatePoint,
  idFactory: (prefix: string, sourceId?: string) => string,
): SketchCopyResult<T> | null {
  const sourceContour = model.contours[selection.c]
  if (!sourceContour) return null
  const cellFt = modelCellFt(model)
  const baseContourIndex = model.contours.length
  const offsetXFt = offset.x * cellFt
  const offsetZFt = offset.y * cellFt
  const mirrorPoint = (point: SketchTemplatePoint): SketchTemplatePoint => ({ x: axisX * 2 - point.x + offset.x, y: point.y + offset.y })
  const mirrorItem = (item: SketchTemplatePlacedItem, nextC: number, nextS = item.s): SketchTemplatePlacedItem => ({
    ...clonePlacedItem(item),
    id: idFactory('placed', item.id),
    c: nextC,
    ...(Number.isInteger(nextS) ? { s: nextS } : {}),
    ...(Number.isInteger(nextS) ? { wallId: wallKey(nextC, nextS ?? 0) } : {}),
    xFt: axisX * 2 * cellFt - item.xFt + offsetXFt,
    zFt: item.zFt + offsetZFt,
    rotationY: normalizeRadians(Math.PI - item.rotationY),
  })

  if (selection.kind === 'wall') {
    const indexes = segmentPointIndexes(sourceContour, selection.s)
    if (!indexes) return null
    const contour: SketchTemplateContour = {
      closed: false,
      points: [sourceContour.points[indexes.start], sourceContour.points[indexes.end]].map(mirrorPoint),
    }
    const openings = model.openings
      .filter((opening) => opening.c === selection.c && opening.s === selection.s)
      .map((opening) => ({ ...cloneOpening(opening), c: baseContourIndex, s: 0, t: 1 - opening.t }))
    const placedItems = (model.placedItems ?? [])
      .filter((item) => item.c === selection.c && item.s === selection.s)
      .map((item) => mirrorItem(item, baseContourIndex, 0))
    return {
      model: {
        ...model,
        contours: [...model.contours, contour],
        openings: [...model.openings, ...openings],
        ...(placedItems.length > 0 ? { placedItems: [...(model.placedItems ?? []), ...placedItems] } : {}),
      } as T,
      selection: { kind: 'wall', c: baseContourIndex, s: 0 },
    }
  }

  const contour: SketchTemplateContour = {
    closed: sourceContour.closed,
    points: sourceContour.points.map(mirrorPoint),
  }
  const openings = model.openings
    .filter((opening) => opening.c === selection.c)
    .map((opening) => ({ ...cloneOpening(opening), c: baseContourIndex, t: 1 - opening.t }))
  const placedItems = (model.placedItems ?? [])
    .filter((item) => item.c === selection.c)
    .map((item) => mirrorItem(item, baseContourIndex))
  return {
    model: {
      ...model,
      contours: [...model.contours, contour],
      openings: [...model.openings, ...openings],
      ...(placedItems.length > 0 ? { placedItems: [...(model.placedItems ?? []), ...placedItems] } : {}),
    } as T,
    selection: { kind: 'contour', c: baseContourIndex },
  }
}
