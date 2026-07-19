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
export type SketchSmartGuideKind = 'center' | 'edge' | 'axis' | 'equal-offset'
export type SketchSmartGuide = {
  kind: SketchSmartGuideKind
  axis: 'x' | 'y'
  value: number
  distance: number
}
export type SketchSmartGuideResult = {
  point: SketchGuidePoint
  guides: SketchSmartGuide[]
  snapped: boolean
}
export type SketchExistingSnapTarget =
  | { kind: 'point'; c: number; p: number; point: SketchGuidePoint }
  | { kind: 'segment'; c: number; s: number; a: SketchGuidePoint; b: SketchGuidePoint; t: number; point: SketchGuidePoint }
export type SketchExistingSnapResult = {
  point: SketchGuidePoint
  target: SketchExistingSnapTarget
  distance: number
}

type SmartGuideCandidate = {
  kind: SketchSmartGuideKind
  value: number
  priority: number
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
  return 'hub_sketch_guide_equal'
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
