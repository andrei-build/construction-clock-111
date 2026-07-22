export type SketchGuidePoint = { x: number; y: number }
export type SketchGuideContour = { points: SketchGuidePoint[]; closed: boolean }
export type SketchGuideSegment = { c: number; s: number; a: SketchGuidePoint; b: SketchGuidePoint }
export type SketchGuidePlacedItem = {
  id: string
  xFt: number
  zFt: number
}
export type SketchGuideModel = {
  cellFt?: number
  contours: SketchGuideContour[]
  placedItems?: SketchGuidePlacedItem[]
}
export type SketchScreenPoint = { clientX: number; clientY: number }
export type SketchSmartGuideKind = 'center' | 'edge' | 'axis' | 'equal-offset' | 'corner-square'
export type SketchSmartGuide = {
  kind: SketchSmartGuideKind
  axis: 'x' | 'y'
  value: number
  distance: number
  from?: SketchGuidePoint
  to?: SketchGuidePoint
  cornerMarker?: {
    corner: SketchGuidePoint
    horizontalSign: -1 | 1
    verticalSign: -1 | 1
  }
}
export type SketchSmartGuideResult = {
  point: SketchGuidePoint
  guides: SketchSmartGuide[]
  snapped: boolean
}
export type SketchCornerSquareSnapResult = {
  point: SketchGuidePoint
  guides: SketchSmartGuide[]
  squared: boolean
}
export type SketchExistingSnapTarget =
  | { kind: 'point'; c: number; p: number; point: SketchGuidePoint }
  | { kind: 'segment'; c: number; s: number; a: SketchGuidePoint; b: SketchGuidePoint; t: number; point: SketchGuidePoint }
export type SketchExistingSnapResult = {
  point: SketchGuidePoint
  target: SketchExistingSnapTarget
  distance: number
}
export type SketchOpenContourFinishResult<TModel> = {
  model: TModel
  changed: boolean
  action: 'closed' | 'discarded' | 'none'
}
export type SketchWallDraftUiState<TSnapGuide = unknown> = {
  hover: SketchGuidePoint | null
  hoverSnapped: boolean
  hoverSnapGuide: TSnapGuide | null
  newRoomDraftPending: boolean
}
export type SketchClearableModel = Pick<SketchGuideModel, 'contours'> & {
  openings?: readonly unknown[]
  measurements?: readonly unknown[]
  placedItems?: readonly unknown[]
}

type SmartGuideCandidate = {
  kind: SketchSmartGuideKind
  value: number
  priority: number
}

type CornerNeighbor = {
  point: SketchGuidePoint
  index: number
}

type CornerAxisSnap = {
  value: number
  distance: number
  neighbor: SketchGuidePoint
}

type AxisDirection = {
  axis: 'x' | 'y'
  sign: -1 | 1
}

function modelCellFt(model: SketchGuideModel): number {
  return Number.isFinite(model.cellFt) && (model.cellFt ?? 0) > 0 ? model.cellFt ?? 1 : 1
}

function segmentEnd(contour: SketchGuideContour, index: number): SketchGuidePoint | null {
  if (index < contour.points.length - 1) return contour.points[index + 1]
  if (contour.closed && contour.points.length >= 3 && index === contour.points.length - 1) return contour.points[0]
  return null
}

function pointDistance(a: SketchGuidePoint, b: SketchGuidePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function screenPointerMovedBeyondThreshold(
  origin: SketchScreenPoint,
  current: SketchScreenPoint,
  thresholdPx: number,
): boolean {
  const threshold = Number.isFinite(thresholdPx) && thresholdPx > 0 ? thresholdPx : 0
  return Math.hypot(current.clientX - origin.clientX, current.clientY - origin.clientY) > threshold
}

export function shouldCloseOpenContourFromPoint(
  contour: SketchGuideContour | null | undefined,
  point: SketchGuidePoint,
  thresholdCells: number,
): boolean {
  const threshold = Number.isFinite(thresholdCells) && thresholdCells > 0 ? thresholdCells : 0
  return !!contour && !contour.closed && contour.points.length >= 3 && pointDistance(point, contour.points[0]) <= threshold
}

export function shouldResetWallDraftAfterContourFinish(
  result: Pick<SketchOpenContourFinishResult<unknown>, 'changed' | 'action'>,
): boolean {
  return result.changed && (result.action === 'closed' || result.action === 'discarded')
}

export function resolveWallDraftAfterContourFinish<TSnapGuide>(
  result: Pick<SketchOpenContourFinishResult<unknown>, 'changed' | 'action'>,
  draft: SketchWallDraftUiState<TSnapGuide>,
): SketchWallDraftUiState<TSnapGuide> {
  if (!shouldResetWallDraftAfterContourFinish(result)) return draft
  return {
    ...draft,
    hover: null,
    hoverSnapped: false,
    hoverSnapGuide: null,
    newRoomDraftPending: false,
  }
}

export function shouldTrackWallDraftPointer(
  activeContour: SketchGuideContour | null | undefined,
  newRoomDraftPending: boolean,
): boolean {
  return newRoomDraftPending || !!activeContour && !activeContour.closed && activeContour.points.length > 0
}

export function hasClearableSketchContent(model: SketchClearableModel): boolean {
  return (
    model.contours.length > 0 ||
    (model.openings?.length ?? 0) > 0 ||
    (model.measurements?.length ?? 0) > 0 ||
    (model.placedItems?.length ?? 0) > 0
  )
}

export function finishLastOpenContour<
  TContour extends SketchGuideContour,
  TModel extends { contours: TContour[] },
>(
  model: TModel,
  options: { minClosedPoints?: number; discardIncomplete?: boolean; closeComplete?: boolean } = {},
): SketchOpenContourFinishResult<TModel> {
  const minClosedPoints = Number.isFinite(options.minClosedPoints) && (options.minClosedPoints ?? 0) > 0
    ? options.minClosedPoints ?? 3
    : 3
  const lastIndex = model.contours.length - 1
  const last = model.contours[lastIndex]
  if (!last || last.closed || last.points.length === 0) {
    return { model, changed: false, action: 'none' }
  }
  if (last.points.length >= minClosedPoints && options.closeComplete !== false) {
    return {
      model: {
        ...model,
        contours: model.contours.map((contour, index) => (
          index === lastIndex ? { ...contour, closed: true } : contour
        )),
      },
      changed: true,
      action: 'closed',
    }
  }
  if (options.discardIncomplete === false) {
    return { model, changed: false, action: 'none' }
  }
  return {
    model: {
      ...model,
      contours: model.contours.filter((_, index) => index !== lastIndex),
    },
    changed: true,
    action: 'discarded',
  }
}

function projectSegmentT(p: SketchGuidePoint, a: SketchGuidePoint, b: SketchGuidePoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 <= 0.000001) return 0
  return Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
}

function eachGuideSegment(model: Pick<SketchGuideModel, 'contours'>): SketchGuideSegment[] {
  const out: SketchGuideSegment[] = []
  model.contours.forEach((contour, c) => {
    for (let s = 0; s < contour.points.length - 1; s += 1) {
      out.push({ c, s, a: contour.points[s], b: contour.points[s + 1] })
    }
    if (contour.closed && contour.points.length >= 3) {
      out.push({ c, s: contour.points.length - 1, a: contour.points[contour.points.length - 1], b: contour.points[0] })
    }
  })
  return out
}

function pushUnique(candidates: SmartGuideCandidate[], candidate: SmartGuideCandidate) {
  if (!Number.isFinite(candidate.value)) return
  const existing = candidates.find((item) => Math.abs(item.value - candidate.value) < 0.0001)
  if (!existing) {
    candidates.push(candidate)
    return
  }
  if (candidate.priority < existing.priority) {
    existing.kind = candidate.kind
    existing.priority = candidate.priority
  }
}

function axisCandidates(
  model: SketchGuideModel,
  axis: 'x' | 'y',
  exclude: { contourIndex?: number; pointIndex?: number; itemId?: string } = {},
): SmartGuideCandidate[] {
  const candidates: SmartGuideCandidate[] = []
  const coordinate = axis === 'x' ? 'x' : 'y'
  model.contours.forEach((contour, contourIndex) => {
    contour.points.forEach((point, pointIndex) => {
      if (exclude.contourIndex === contourIndex && exclude.pointIndex === pointIndex) return
      pushUnique(candidates, { kind: 'edge', value: point[coordinate], priority: 1 })
    })
    contour.points.forEach((point, pointIndex) => {
      const end = segmentEnd(contour, pointIndex)
      if (!end) return
      const midpoint = (point[coordinate] + end[coordinate]) / 2
      pushUnique(candidates, { kind: 'center', value: midpoint, priority: 0 })
    })
  })

  const cellFt = modelCellFt(model)
  ;(model.placedItems ?? []).forEach((item) => {
    if (item.id === exclude.itemId) return
    const value = axis === 'x' ? item.xFt / cellFt : item.zFt / cellFt
    pushUnique(candidates, { kind: 'axis', value, priority: 2 })
  })

  const anchorValues = candidates
    .filter((candidate) => candidate.kind !== 'equal-offset')
    .map((candidate) => candidate.value)
    .sort((a, b) => a - b)
  for (let i = 0; i < anchorValues.length; i += 1) {
    for (let j = i + 1; j < anchorValues.length; j += 1) {
      const a = anchorValues[i]
      const b = anchorValues[j]
      const gap = b - a
      if (gap <= 0.0001) continue
      pushUnique(candidates, { kind: 'equal-offset', value: a - gap, priority: 3 })
      pushUnique(candidates, { kind: 'equal-offset', value: b + gap, priority: 3 })
      pushUnique(candidates, { kind: 'equal-offset', value: (a + b) / 2, priority: 3 })
    }
  }

  return candidates
}

function bestAxisGuide(rawValue: number, candidates: SmartGuideCandidate[], thresholdCells: number): SketchSmartGuide | null {
  if (!Number.isFinite(rawValue) || thresholdCells <= 0) return null
  return candidates
    .map((candidate) => ({
      kind: candidate.kind,
      axis: 'x' as const,
      value: candidate.value,
      distance: Math.abs(rawValue - candidate.value),
      priority: candidate.priority,
    }))
    .filter((candidate) => candidate.distance <= thresholdCells)
    .sort((a, b) => a.distance - b.distance || a.priority - b.priority)[0] ?? null
}

export function smartGuideLabelKey(kind: SketchSmartGuideKind): string {
  if (kind === 'center') return 'hub_sketch_guide_center'
  if (kind === 'edge') return 'hub_sketch_guide_edge'
  if (kind === 'axis') return 'hub_sketch_guide_axis'
  if (kind === 'corner-square') return 'hub_sketch_guide_corner_square'
  return 'hub_sketch_guide_equal'
}

export type SketchContourTranslationSnap = {
  offset: SketchGuidePoint
  snapped: boolean
  target: SketchExistingSnapTarget | null
}

// ROOM-MOVE-23: магнит «стена-к-стене» при перетаскивании ЦЕЛОЙ комнаты.
// На вход — уже сдвинутые точки контура; ищем вершину, ближайшую к геометрии ДРУГИХ контуров
// (переиспользуя snapToExistingGeometry, тот же снап, что при «+Добавить комнату»/drag узла),
// и возвращаем доп.смещение, которое ставит эту вершину точно на цель — так общая стена совмещается.
// Чистая функция сдвига координат (без мутаций модели): комнату двигают на offset, индексы/структура целы.
export function snapContourTranslation(
  model: Pick<SketchGuideModel, 'contours'>,
  contourIndex: number,
  translatedPoints: SketchGuidePoint[],
  options: { radiusCells: number },
): SketchContourTranslationSnap {
  const radius = Number.isFinite(options.radiusCells) && options.radiusCells > 0 ? options.radiusCells : 0
  const noSnap: SketchContourTranslationSnap = { offset: { x: 0, y: 0 }, snapped: false, target: null }
  if (radius <= 0) return noSnap
  let best: { offset: SketchGuidePoint; distance: number; target: SketchExistingSnapTarget } | null = null
  translatedPoints.forEach((vertex) => {
    const snap = snapToExistingGeometry(model, vertex, { radiusCells: radius, excludeContourIndex: contourIndex })
    if (!snap) return
    if (!best || snap.distance < best.distance) {
      best = {
        offset: { x: snap.point.x - vertex.x, y: snap.point.y - vertex.y },
        distance: snap.distance,
        target: snap.target,
      }
    }
  })
  if (!best) return noSnap
  const resolved = best as { offset: SketchGuidePoint; distance: number; target: SketchExistingSnapTarget }
  return { offset: resolved.offset, snapped: true, target: resolved.target }
}

export function snapToExistingGeometry(
  model: Pick<SketchGuideModel, 'contours'>,
  rawPoint: SketchGuidePoint,
  options: {
    radiusCells: number
    excludeContourIndex?: number
    excludeOpenLastContour?: boolean
  },
): SketchExistingSnapResult | null {
  const radius = Number.isFinite(options.radiusCells) && options.radiusCells > 0 ? options.radiusCells : 0
  if (radius <= 0) return null
  const activeIdx = model.contours.length - 1
  const active = model.contours[activeIdx]
  const excludeContourIndex = options.excludeContourIndex
    ?? (options.excludeOpenLastContour !== false && active && !active.closed ? activeIdx : undefined)

  let bestPoint: SketchExistingSnapResult | null = null
  let bestPointDistance = radius
  model.contours.forEach((contour, c) => {
    if (c === excludeContourIndex) return
    contour.points.forEach((point, p) => {
      const distance = pointDistance(rawPoint, point)
      if (distance <= bestPointDistance) {
        bestPointDistance = distance
        bestPoint = {
          point: { x: point.x, y: point.y },
          target: { kind: 'point', c, p, point: { x: point.x, y: point.y } },
          distance,
        }
      }
    })
  })
  if (bestPoint) return bestPoint

  let bestSegment: SketchExistingSnapResult | null = null
  let bestSegmentDistance = radius
  eachGuideSegment(model).forEach((seg) => {
    if (seg.c === excludeContourIndex) return
    const t = projectSegmentT(rawPoint, seg.a, seg.b)
    const point = {
      x: seg.a.x + (seg.b.x - seg.a.x) * t,
      y: seg.a.y + (seg.b.y - seg.a.y) * t,
    }
    const distance = pointDistance(rawPoint, point)
    if (distance <= bestSegmentDistance) {
      bestSegmentDistance = distance
      bestSegment = {
        point,
        target: {
          kind: 'segment',
          c: seg.c,
          s: seg.s,
          a: { x: seg.a.x, y: seg.a.y },
          b: { x: seg.b.x, y: seg.b.y },
          t,
          point,
        },
        distance,
      }
    }
  })
  return bestSegment
}

function cornerNeighbors(contour: SketchGuideContour, pointIndex: number): CornerNeighbor[] {
  if (!contour.points[pointIndex]) return []
  const lastIndex = contour.points.length - 1
  const prevIndex = pointIndex > 0
    ? pointIndex - 1
    : contour.closed && contour.points.length >= 3
      ? lastIndex
      : null
  const nextIndex = pointIndex < lastIndex
    ? pointIndex + 1
    : contour.closed && contour.points.length >= 3
      ? 0
      : null
  const neighbors: CornerNeighbor[] = []
  if (prevIndex !== null) neighbors.push({ point: contour.points[prevIndex], index: prevIndex })
  if (nextIndex !== null && nextIndex !== prevIndex) neighbors.push({ point: contour.points[nextIndex], index: nextIndex })
  return neighbors
}

function bestCornerAxisSnap(
  point: SketchGuidePoint,
  neighbors: CornerNeighbor[],
  axis: 'x' | 'y',
  thresholdCells: number,
): CornerAxisSnap | null {
  const coordinate = axis === 'x' ? 'x' : 'y'
  return neighbors
    .map((neighbor) => ({
      value: neighbor.point[coordinate],
      distance: Math.abs(point[coordinate] - neighbor.point[coordinate]),
      neighbor: neighbor.point,
      index: neighbor.index,
    }))
    .filter((snap) => snap.distance < thresholdCells)
    .sort((a, b) => a.distance - b.distance || a.index - b.index)[0] ?? null
}

function axisDirectionFromCorner(corner: SketchGuidePoint, neighbor: SketchGuidePoint): AxisDirection | null {
  const dx = neighbor.x - corner.x
  const dy = neighbor.y - corner.y
  const epsilon = 0.000001
  if (Math.abs(dy) <= epsilon && Math.abs(dx) > epsilon) {
    return { axis: 'x', sign: dx > 0 ? 1 : -1 }
  }
  if (Math.abs(dx) <= epsilon && Math.abs(dy) > epsilon) {
    return { axis: 'y', sign: dy > 0 ? 1 : -1 }
  }
  return null
}

function cornerSquareMarker(
  corner: SketchGuidePoint,
  neighbors: CornerNeighbor[],
): SketchSmartGuide['cornerMarker'] | null {
  const directions = neighbors
    .map((neighbor) => axisDirectionFromCorner(corner, neighbor.point))
    .filter((direction): direction is AxisDirection => !!direction)
  const horizontal = directions.find((direction) => direction.axis === 'x')
  const vertical = directions.find((direction) => direction.axis === 'y')
  if (!horizontal || !vertical) return null
  return {
    corner: { x: corner.x, y: corner.y },
    horizontalSign: horizontal.sign,
    verticalSign: vertical.sign,
  }
}

export function snapCornerSquare(
  model: Pick<SketchGuideModel, 'contours'>,
  draggedPoint: SketchGuidePoint,
  options: {
    contourIndex: number
    pointIndex: number
    thresholdCells: number
  },
): SketchCornerSquareSnapResult {
  const contour = model.contours[options.contourIndex]
  const threshold = Number.isFinite(options.thresholdCells) && options.thresholdCells > 0 ? options.thresholdCells : 0
  if (!contour || !contour.points[options.pointIndex] || threshold <= 0) {
    return { point: { x: draggedPoint.x, y: draggedPoint.y }, guides: [], squared: false }
  }

  const neighbors = cornerNeighbors(contour, options.pointIndex)
  if (neighbors.length <= 0) {
    return { point: { x: draggedPoint.x, y: draggedPoint.y }, guides: [], squared: false }
  }

  const xSnap = bestCornerAxisSnap(draggedPoint, neighbors, 'x', threshold)
  const ySnap = bestCornerAxisSnap(draggedPoint, neighbors, 'y', threshold)
  const point = {
    x: xSnap ? xSnap.value : draggedPoint.x,
    y: ySnap ? ySnap.value : draggedPoint.y,
  }
  const guides: SketchSmartGuide[] = []
  if (xSnap) {
    guides.push({
      kind: 'corner-square',
      axis: 'x',
      value: xSnap.value,
      distance: xSnap.distance,
      from: { x: xSnap.value, y: xSnap.neighbor.y },
      to: { x: xSnap.value, y: point.y },
    })
  }
  if (ySnap) {
    guides.push({
      kind: 'corner-square',
      axis: 'y',
      value: ySnap.value,
      distance: ySnap.distance,
      from: { x: ySnap.neighbor.x, y: ySnap.value },
      to: { x: point.x, y: ySnap.value },
    })
  }

  const marker = guides.length > 0 ? cornerSquareMarker(point, neighbors) : null
  if (marker && guides[0]) {
    guides[0] = { ...guides[0], cornerMarker: marker }
  }

  return {
    point,
    guides,
    squared: guides.length > 0,
  }
}

export function snapPointWithSmartGuides(
  model: SketchGuideModel,
  rawPoint: SketchGuidePoint,
  options: {
    fallbackPoint?: SketchGuidePoint
    thresholdCells: number
    excludeContourIndex?: number
    excludePointIndex?: number
    excludeItemId?: string
  },
): SketchSmartGuideResult {
  const fallback = options.fallbackPoint ?? rawPoint
  const xGuide = bestAxisGuide(
    rawPoint.x,
    axisCandidates(model, 'x', {
      contourIndex: options.excludeContourIndex,
      pointIndex: options.excludePointIndex,
      itemId: options.excludeItemId,
    }),
    options.thresholdCells,
  )
  const yGuide = bestAxisGuide(
    rawPoint.y,
    axisCandidates(model, 'y', {
      contourIndex: options.excludeContourIndex,
      pointIndex: options.excludePointIndex,
      itemId: options.excludeItemId,
    }),
    options.thresholdCells,
  )
  const guides: SketchSmartGuide[] = []
  if (xGuide) guides.push({ ...xGuide, axis: 'x' })
  if (yGuide) guides.push({ ...yGuide, axis: 'y' })
  return {
    point: {
      x: xGuide ? xGuide.value : fallback.x,
      y: yGuide ? yGuide.value : fallback.y,
    },
    guides,
    snapped: guides.length > 0,
  }
}
