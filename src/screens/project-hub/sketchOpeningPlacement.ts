export type OpeningOffsetSide = 'left' | 'right'

export type OpeningPlacementMagnetKind =
  | 'precision'
  | 'center'
  | 'edge-start'
  | 'edge-end'
  | 'neighbor'

export type OpeningPlacementNeighbor = {
  t: number
  widthFt: number
}

export type OpeningPlacementMagnet = {
  kind: OpeningPlacementMagnetKind
  t: number
  centerFt: number
  guideFt: number
  distanceFt: number
}

export type SoftOpeningPlacementInput = {
  rawT: number
  segmentLengthFt: number
  openingWidthFt: number
  precisionStepFt: number
  magnetThresholdFt: number
  neighbors?: OpeningPlacementNeighbor[]
}

export type SoftOpeningPlacementResult = {
  t: number
  magnet: OpeningPlacementMagnet | null
}

type OpeningPlacementCandidate = {
  kind: OpeningPlacementMagnetKind
  centerFt: number
  guideFt: number
  thresholdFt: number
  priority: number
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function openingHalfWidthFt(segmentLengthFt: number, openingWidthFt: number): number {
  return Math.max(0, Math.min(finitePositive(openingWidthFt, 0), finitePositive(segmentLengthFt, 0)) / 2)
}

export function clampOpeningCenterFt(segmentLengthFt: number, openingWidthFt: number, centerFt: number): number {
  const length = finitePositive(segmentLengthFt, 0)
  if (length <= 0.001) return 0
  const halfWidth = openingHalfWidthFt(length, openingWidthFt)
  if (halfWidth * 2 >= length - 0.001) return length / 2
  return clampNumber(Number.isFinite(centerFt) ? centerFt : length / 2, halfWidth, length - halfWidth)
}

export function clampOpeningPlacementT(segmentLengthFt: number, openingWidthFt: number, t: number): number {
  const length = finitePositive(segmentLengthFt, 0)
  if (length <= 0.001) return 0.5
  return clampOpeningCenterFt(length, openingWidthFt, (Number.isFinite(t) ? t : 0.5) * length) / length
}

export function centerOpeningT(segmentLengthFt: number, openingWidthFt: number): number {
  return clampOpeningPlacementT(segmentLengthFt, openingWidthFt, 0.5)
}

export function openingTForOffset(
  segmentLengthFt: number,
  openingWidthFt: number,
  side: OpeningOffsetSide,
  offsetFt: number,
): number {
  const length = finitePositive(segmentLengthFt, 0)
  if (length <= 0.001) return 0.5
  const halfWidth = openingHalfWidthFt(length, openingWidthFt)
  const offset = Math.max(0, Number.isFinite(offsetFt) ? offsetFt : 0)
  const centerFt = side === 'left'
    ? offset + halfWidth
    : length - offset - halfWidth
  return clampOpeningCenterFt(length, openingWidthFt, centerFt) / length
}

export function openingEdgeOffsetsFt(segmentLengthFt: number, openingWidthFt: number, t: number): { left: number; right: number } {
  const length = finitePositive(segmentLengthFt, 0)
  if (length <= 0.001) return { left: 0, right: 0 }
  const halfWidth = openingHalfWidthFt(length, openingWidthFt)
  const centerFt = clampOpeningCenterFt(length, openingWidthFt, (Number.isFinite(t) ? t : 0.5) * length)
  return {
    left: Math.max(0, centerFt - halfWidth),
    right: Math.max(0, length - centerFt - halfWidth),
  }
}

function candidateMagnet(
  candidate: OpeningPlacementCandidate,
  rawCenterFt: number,
  segmentLengthFt: number,
  openingWidthFt: number,
): OpeningPlacementMagnet | null {
  const centerFt = clampOpeningCenterFt(segmentLengthFt, openingWidthFt, candidate.centerFt)
  const distanceFt = Math.abs(rawCenterFt - centerFt)
  if (distanceFt > candidate.thresholdFt) return null
  return {
    kind: candidate.kind,
    t: segmentLengthFt > 0 ? centerFt / segmentLengthFt : 0.5,
    centerFt,
    guideFt: candidate.guideFt,
    distanceFt,
  }
}

export function softOpeningPlacement(input: SoftOpeningPlacementInput): SoftOpeningPlacementResult {
  const segmentLengthFt = finitePositive(input.segmentLengthFt, 0)
  if (segmentLengthFt <= 0.001) return { t: 0.5, magnet: null }
  const openingWidthFt = finitePositive(input.openingWidthFt, 0)
  const rawT = Number.isFinite(input.rawT) ? input.rawT : 0.5
  const freeCenterFt = clampOpeningCenterFt(segmentLengthFt, openingWidthFt, rawT * segmentLengthFt)
  const semanticThresholdFt = Math.max(0, Number.isFinite(input.magnetThresholdFt) ? input.magnetThresholdFt : 0)
  const stepFt = finitePositive(input.precisionStepFt, 0)
  const precisionThresholdFt = stepFt > 0
    ? Math.min(semanticThresholdFt, stepFt * 0.22, 0.5 / 12)
    : 0
  const halfWidth = openingHalfWidthFt(segmentLengthFt, openingWidthFt)
  const candidates: OpeningPlacementCandidate[] = [
    { kind: 'center', centerFt: segmentLengthFt / 2, guideFt: segmentLengthFt / 2, thresholdFt: semanticThresholdFt, priority: 0 },
    { kind: 'edge-start', centerFt: halfWidth, guideFt: 0, thresholdFt: semanticThresholdFt, priority: 1 },
    { kind: 'edge-end', centerFt: segmentLengthFt - halfWidth, guideFt: segmentLengthFt, thresholdFt: semanticThresholdFt, priority: 1 },
  ]

  if (precisionThresholdFt > 0) {
    const snappedFt = Math.round(freeCenterFt / stepFt) * stepFt
    candidates.push({ kind: 'precision', centerFt: snappedFt, guideFt: snappedFt, thresholdFt: precisionThresholdFt, priority: 4 })
  }

  for (const neighbor of input.neighbors ?? []) {
    if (!Number.isFinite(neighbor.t) || !Number.isFinite(neighbor.widthFt)) continue
    const neighborHalfWidth = openingHalfWidthFt(segmentLengthFt, neighbor.widthFt)
    const neighborCenterFt = clampOpeningCenterFt(segmentLengthFt, neighbor.widthFt, neighbor.t * segmentLengthFt)
    const neighborStartFt = neighborCenterFt - neighborHalfWidth
    const neighborEndFt = neighborCenterFt + neighborHalfWidth
    candidates.push(
      { kind: 'neighbor', centerFt: neighborStartFt + halfWidth, guideFt: neighborStartFt, thresholdFt: semanticThresholdFt, priority: 2 },
      { kind: 'neighbor', centerFt: neighborEndFt + halfWidth, guideFt: neighborEndFt, thresholdFt: semanticThresholdFt, priority: 2 },
      { kind: 'neighbor', centerFt: neighborStartFt - halfWidth, guideFt: neighborStartFt, thresholdFt: semanticThresholdFt, priority: 2 },
      { kind: 'neighbor', centerFt: neighborEndFt - halfWidth, guideFt: neighborEndFt, thresholdFt: semanticThresholdFt, priority: 2 },
      { kind: 'neighbor', centerFt: neighborCenterFt, guideFt: neighborCenterFt, thresholdFt: semanticThresholdFt, priority: 3 },
    )
  }

  const magnet = candidates
    .map((candidate) => ({ candidate, magnet: candidateMagnet(candidate, freeCenterFt, segmentLengthFt, openingWidthFt) }))
    .filter((entry): entry is { candidate: OpeningPlacementCandidate; magnet: OpeningPlacementMagnet } => !!entry.magnet)
    .sort((a, b) => a.magnet.distanceFt - b.magnet.distanceFt || a.candidate.priority - b.candidate.priority)[0]?.magnet ?? null

  return {
    t: magnet ? magnet.t : freeCenterFt / segmentLengthFt,
    magnet,
  }
}
