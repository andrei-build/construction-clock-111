export const DEFAULT_TILE_WASTE_FACTOR = 0.2
export const DEFAULT_TILE_MIN_CUT_RATIO = 0.2

export type TileLayoutOpening = {
  xIn: number
  yIn: number
  widthIn: number
  heightIn: number
}

export type TileLayoutInput = {
  surfaceWidthIn: number
  surfaceHeightIn: number
  tileWIn: number
  tileHIn: number
  groutIn?: number
  offsetXIn?: number
  offsetYIn?: number
  wasteFactor?: number
  minCutRatio?: number
  coverageHeightIn?: number
  openings?: TileLayoutOpening[]
}

export type TileLayoutAxisSummary = {
  count: number
  firstCutIn: number
  lastCutIn: number
  minCutIn: number
  minCutRatio: number
  smallCut: boolean
  offsetIn: number
  recommendedOffsetIn: number
  recommendedMinCutIn: number
}

export type TileLayoutEstimate = {
  surfaceAreaSqft: number
  openingAreaSqft: number
  netAreaSqft: number
  wasteFactor: number
  wasteSqft: number
  grossSqft: number
  tileCount: number
  columns: TileLayoutAxisSummary
  rows: TileLayoutAxisSummary
  hasSmallCuts: boolean
}

function finite(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, digits = 3): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0
}

function positive(value: unknown, fallback: number, max = 100000): number {
  return clamp(finite(value, fallback), 0.001, max)
}

function visibleCuts(lengthIn: number, tileIn: number, groutIn: number, offsetIn: number): number[] {
  const length = positive(lengthIn, 1)
  const tile = positive(tileIn, 1)
  const pitch = tile + Math.max(0, finite(groutIn, 0))
  const offset = finite(offsetIn, 0)
  const cuts: number[] = []
  const first = Math.floor((0 - offset - tile - pitch) / pitch)
  const last = Math.ceil((length - offset + pitch) / pitch)
  for (let k = first; k <= last; k++) {
    const start = offset + k * pitch
    const end = start + tile
    const clipped = Math.min(length, end) - Math.max(0, start)
    if (clipped > 0.001) cuts.push(clipped)
  }
  return cuts
}

function bestOffset(lengthIn: number, tileIn: number, groutIn: number): { offsetIn: number; minCutIn: number } {
  const tile = positive(tileIn, 1)
  const pitch = tile + Math.max(0, finite(groutIn, 0))
  const step = 1 / 16
  let best = { offsetIn: 0, minCutIn: 0, edgeSpread: Number.POSITIVE_INFINITY, count: Number.POSITIVE_INFINITY }
  for (let offset = -pitch; offset <= pitch + 0.0001; offset += step) {
    const cuts = visibleCuts(lengthIn, tile, groutIn, offset)
    if (cuts.length === 0) continue
    const edgeCuts = [cuts[0], cuts[cuts.length - 1]]
    const minCutIn = Math.min(...edgeCuts)
    const edgeSpread = Math.abs(edgeCuts[0] - edgeCuts[1])
    const better = minCutIn > best.minCutIn + 0.001
      || (Math.abs(minCutIn - best.minCutIn) <= 0.001 && cuts.length < best.count)
      || (Math.abs(minCutIn - best.minCutIn) <= 0.001 && cuts.length === best.count && edgeSpread < best.edgeSpread)
    if (better) best = { offsetIn: round(offset, 4), minCutIn, edgeSpread, count: cuts.length }
  }
  return { offsetIn: best.offsetIn, minCutIn: round(best.minCutIn, 4) }
}

function summarizeAxis(lengthIn: number, tileIn: number, groutIn: number, offsetIn: number, minCutRatio: number): TileLayoutAxisSummary {
  const tile = positive(tileIn, 1)
  const cuts = visibleCuts(lengthIn, tile, groutIn, offsetIn)
  const firstCut = cuts[0] ?? 0
  const lastCut = cuts[cuts.length - 1] ?? 0
  const minCut = cuts.length > 0 ? Math.min(firstCut, lastCut) : 0
  const best = bestOffset(lengthIn, tile, groutIn)
  return {
    count: cuts.length,
    firstCutIn: round(firstCut),
    lastCutIn: round(lastCut),
    minCutIn: round(minCut),
    minCutRatio: round(minCut / tile, 4),
    smallCut: minCut > 0 && minCut < tile * minCutRatio - 0.001,
    offsetIn: round(finite(offsetIn, 0), 4),
    recommendedOffsetIn: best.offsetIn,
    recommendedMinCutIn: best.minCutIn,
  }
}

function openingAreaIn(input: TileLayoutOpening, maxWidthIn: number, maxHeightIn: number): number {
  const x1 = clamp(finite(input.xIn, 0), 0, maxWidthIn)
  const y1 = clamp(finite(input.yIn, 0), 0, maxHeightIn)
  const x2 = clamp(x1 + positive(input.widthIn, 0), 0, maxWidthIn)
  const y2 = clamp(y1 + positive(input.heightIn, 0), 0, maxHeightIn)
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
}

export function estimateTileLayout(input: TileLayoutInput): TileLayoutEstimate {
  const surfaceWidthIn = positive(input.surfaceWidthIn, 1)
  const rawHeightIn = positive(input.surfaceHeightIn, 1)
  const surfaceHeightIn = clamp(finite(input.coverageHeightIn, rawHeightIn), 0.001, rawHeightIn)
  const tileWIn = positive(input.tileWIn, 12)
  const tileHIn = positive(input.tileHIn, 24)
  const groutIn = Math.max(0, finite(input.groutIn, 0))
  const wasteFactor = clamp(finite(input.wasteFactor, DEFAULT_TILE_WASTE_FACTOR), 0, 0.5)
  const minCutRatio = clamp(finite(input.minCutRatio, DEFAULT_TILE_MIN_CUT_RATIO), 0.05, 0.45)
  const surfaceAreaIn = surfaceWidthIn * surfaceHeightIn
  const openingArea = (input.openings ?? []).reduce((sum, opening) => sum + openingAreaIn(opening, surfaceWidthIn, surfaceHeightIn), 0)
  const netAreaIn = Math.max(0, surfaceAreaIn - openingArea)
  const tileAreaIn = tileWIn * tileHIn
  const netAreaSqft = netAreaIn / 144
  const grossSqft = netAreaSqft * (1 + wasteFactor)
  const columns = summarizeAxis(surfaceWidthIn, tileWIn, groutIn, finite(input.offsetXIn, 0), minCutRatio)
  const rows = summarizeAxis(surfaceHeightIn, tileHIn, groutIn, finite(input.offsetYIn, 0), minCutRatio)
  return {
    surfaceAreaSqft: round(surfaceAreaIn / 144, 2),
    openingAreaSqft: round(openingArea / 144, 2),
    netAreaSqft: round(netAreaSqft, 2),
    wasteFactor,
    wasteSqft: round(netAreaSqft * wasteFactor, 2),
    grossSqft: round(grossSqft, 2),
    tileCount: Math.ceil((grossSqft * 144) / tileAreaIn),
    columns,
    rows,
    hasSmallCuts: columns.smallCut || rows.smallCut,
  }
}
