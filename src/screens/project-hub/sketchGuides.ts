export type SketchGuidePoint = { x: number; y: number }
export type SketchGuideContour = { points: SketchGuidePoint[]; closed: boolean }
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
