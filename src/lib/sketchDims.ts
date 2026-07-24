// BLUEPRINT-DIMS-60: pure computed blueprint dimensions for the 2D sketch.
// The sketch model stays version:1 centerline geometry; this module only reads contours/openings
// and returns SVG/canvas-ready dimension chains plus structural grid axes.

export type SketchDimPt = { x: number; y: number }

export type SketchDimContour = {
  points: SketchDimPt[]
  closed?: boolean
}

export type SketchDimOpening = {
  c: number
  s: number
  t: number
}

export type SketchDimModel = {
  cellFt?: number
  contours: SketchDimContour[]
  openings?: SketchDimOpening[]
}

export type BlueprintDimSide = 'top' | 'right' | 'bottom' | 'left'
export type BlueprintDimRow = 'openingsAxes' | 'segments' | 'overall'
export type BlueprintAxisOrientation = 'vertical' | 'horizontal'

export type BlueprintAxisSource = {
  c: number
  s: number
  a: SketchDimPt
  b: SketchDimPt
}

export type BlueprintAxis = {
  id: string
  orientation: BlueprintAxisOrientation
  label: string
  position: number
  sources: BlueprintAxisSource[]
  x1: number
  y1: number
  x2: number
  y2: number
  bubbles: Array<{ side: BlueprintDimSide; cx: number; cy: number; r: number; label: string }>
}

export type BlueprintDimensionLine = {
  id: string
  side: BlueprintDimSide
  row: BlueprintDimRow
  x1: number
  y1: number
  x2: number
  y2: number
  ext1x1: number
  ext1y1: number
  ext1x2: number
  ext1y2: number
  ext2x1: number
  ext2y1: number
  ext2x2: number
  ext2y2: number
  tick1x1: number
  tick1y1: number
  tick1x2: number
  tick1y2: number
  tick2x1: number
  tick2y1: number
  tick2x2: number
  tick2y2: number
  labelX: number
  labelY: number
  angle: number
  text: string
  valueFt: number
  from: number
  to: number
}

export type SketchDimsBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
}

export type BlueprintDimensionLayout = {
  bounds: SketchDimsBounds | null
  dimensions: BlueprintDimensionLine[]
  axes: BlueprintAxis[]
  rowOffsetsPx: Record<BlueprintDimRow, number>
}

export type BlueprintDimensionOptions = {
  cellPx?: number
  screenWorldPx?: number
  rowOffsetsScreenPx?: Partial<Record<BlueprintDimRow, number>>
  axisBubbleOffsetScreenPx?: number
  axisBubbleRadiusScreenPx?: number
  axisMergeToleranceCells?: number
  axisSnapToleranceCells?: number
  minAxisLengthCells?: number
  formatLengthFt?: (valueFt: number) => string
}

type Segment = { c: number; s: number; a: SketchDimPt; b: SketchDimPt }
type AxisSeed = Omit<BlueprintAxis, 'id' | 'label' | 'x1' | 'y1' | 'x2' | 'y2' | 'bubbles'>

const DEFAULT_CELL_FT = 1
const DEFAULT_CELL_PX = 32
const DEFAULT_ROW_OFFSETS_SCREEN_PX: Record<BlueprintDimRow, number> = {
  openingsAxes: 36,
  segments: 64,
  overall: 92,
}
const DEFAULT_AXIS_BUBBLE_OFFSET_SCREEN_PX = 124
const DEFAULT_AXIS_BUBBLE_RADIUS_SCREEN_PX = 12
const DIM_TICK_SCREEN_PX = 8
const DIM_LABEL_SCREEN_PX = 12
const DIM_EXTENSION_GAP_SCREEN_PX = 4
const INCH_DENOMINATOR = 16

function finitePositive(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) {
    const t = y
    y = x % y
    x = t
  }
  return x || 1
}

function formatInchRemainder(wholeInches: number, fractionUnits: number): string {
  let inchText = wholeInches > 0 ? String(wholeInches) : ''
  if (fractionUnits > 0) {
    const divisor = gcd(fractionUnits, INCH_DENOMINATOR)
    const fraction = `${fractionUnits / divisor}/${INCH_DENOMINATOR / divisor}`
    inchText = inchText ? `${inchText} ${fraction}` : fraction
  }
  return inchText || '0'
}

export function formatBlueprintLengthFt(valueFt: number): string {
  const units = Math.round((Number.isFinite(valueFt) ? valueFt : 0) * 12 * INCH_DENOMINATOR)
  const sign = units < 0 ? '-' : ''
  const absUnits = Math.abs(units)
  const unitsPerFoot = 12 * INCH_DENOMINATOR
  const feet = Math.floor(absUnits / unitsPerFoot)
  const inchUnits = absUnits % unitsPerFoot
  const wholeInches = Math.floor(inchUnits / INCH_DENOMINATOR)
  const fractionUnits = inchUnits % INCH_DENOMINATOR
  const inchText = formatInchRemainder(wholeInches, fractionUnits)
  return feet > 0 ? `${sign}${feet}'-${inchText}"` : `${sign}${inchText}"`
}

export function sketchDimsBounds(model: SketchDimModel): SketchDimsBounds | null {
  const xs: number[] = []
  const ys: number[] = []
  model.contours.forEach((contour) => {
    contour.points.forEach((point) => {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
      xs.push(point.x)
      ys.push(point.y)
    })
  })
  if (xs.length === 0 || ys.length === 0) return null
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY }
}

function eachSegment(model: SketchDimModel): Segment[] {
  const out: Segment[] = []
  model.contours.forEach((contour, c) => {
    for (let s = 0; s < contour.points.length - 1; s++) {
      out.push({ c, s, a: contour.points[s], b: contour.points[s + 1] })
    }
    if (contour.closed && contour.points.length >= 3) {
      out.push({ c, s: contour.points.length - 1, a: contour.points[contour.points.length - 1], b: contour.points[0] })
    }
  })
  return out
}

function axisLabel(index: number): string {
  let n = Math.max(0, Math.floor(index))
  let label = ''
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

function mergeAxisSeeds(seeds: AxisSeed[], toleranceCells: number): AxisSeed[] {
  const sorted = [...seeds].sort((a, b) => a.position - b.position)
  const out: AxisSeed[] = []
  sorted.forEach((seed) => {
    const last = out[out.length - 1]
    if (last && Math.abs(last.position - seed.position) <= toleranceCells) {
      const totalSources = last.sources.length + seed.sources.length
      last.position = (last.position * last.sources.length + seed.position * seed.sources.length) / totalSources
      last.sources.push(...seed.sources)
      return
    }
    out.push({ orientation: seed.orientation, position: seed.position, sources: [...seed.sources] })
  })
  return out
}

export function collectBlueprintAxes(model: SketchDimModel, options: BlueprintDimensionOptions = {}): {
  vertical: Array<AxisSeed & { label: string }>
  horizontal: Array<AxisSeed & { label: string }>
} {
  const axisSnapToleranceCells = options.axisSnapToleranceCells ?? 0.04
  const axisMergeToleranceCells = options.axisMergeToleranceCells ?? 0.08
  const minAxisLengthCells = options.minAxisLengthCells ?? 0.5
  const vertical: AxisSeed[] = []
  const horizontal: AxisSeed[] = []

  eachSegment(model).forEach((segment) => {
    const dx = segment.b.x - segment.a.x
    const dy = segment.b.y - segment.a.y
    const length = Math.hypot(dx, dy)
    if (length < minAxisLengthCells) return
    const source: BlueprintAxisSource = { c: segment.c, s: segment.s, a: segment.a, b: segment.b }
    if (Math.abs(dx) <= axisSnapToleranceCells) {
      vertical.push({ orientation: 'vertical', position: (segment.a.x + segment.b.x) / 2, sources: [source] })
    } else if (Math.abs(dy) <= axisSnapToleranceCells) {
      horizontal.push({ orientation: 'horizontal', position: (segment.a.y + segment.b.y) / 2, sources: [source] })
    }
  })

  return {
    vertical: mergeAxisSeeds(vertical, axisMergeToleranceCells).map((axis, index) => ({ ...axis, label: String(index + 1) })),
    horizontal: mergeAxisSeeds(horizontal, axisMergeToleranceCells).map((axis, index) => ({ ...axis, label: axisLabel(index) })),
  }
}

function segmentForOpening(model: SketchDimModel, opening: SketchDimOpening): Segment | null {
  const contour = model.contours[opening.c]
  if (!contour) return null
  const a = contour.points[opening.s]
  const b = opening.s + 1 < contour.points.length ? contour.points[opening.s + 1] : (contour.closed ? contour.points[0] : null)
  return a && b ? { c: opening.c, s: opening.s, a, b } : null
}

function openingBreakpointsBySide(model: SketchDimModel, bounds: SketchDimsBounds): Record<BlueprintDimSide, number[]> {
  const bySide: Record<BlueprintDimSide, number[]> = { top: [], right: [], bottom: [], left: [] }
  ;(model.openings ?? []).forEach((opening) => {
    const segment = segmentForOpening(model, opening)
    if (!segment) return
    const t = Math.max(0, Math.min(1, Number.isFinite(opening.t) ? opening.t : 0.5))
    const center = {
      x: segment.a.x + (segment.b.x - segment.a.x) * t,
      y: segment.a.y + (segment.b.y - segment.a.y) * t,
    }
    const dx = segment.b.x - segment.a.x
    const dy = segment.b.y - segment.a.y
    if (Math.abs(dx) >= Math.abs(dy)) {
      const side: BlueprintDimSide = Math.abs(center.y - bounds.minY) <= Math.abs(center.y - bounds.maxY) ? 'top' : 'bottom'
      bySide[side].push(center.x)
    } else {
      const side: BlueprintDimSide = Math.abs(center.x - bounds.minX) <= Math.abs(center.x - bounds.maxX) ? 'left' : 'right'
      bySide[side].push(center.y)
    }
  })
  return bySide
}

function uniqueBreakpoints(min: number, max: number, values: number[], toleranceCells: number): number[] {
  const ordered = [min, max, ...values]
    .filter((value) => Number.isFinite(value) && value >= min - toleranceCells && value <= max + toleranceCells)
    .map((value) => Math.max(min, Math.min(max, value)))
    .sort((a, b) => a - b)
  const out: number[] = []
  ordered.forEach((value) => {
    const last = out[out.length - 1]
    if (last !== undefined && Math.abs(last - value) <= toleranceCells) {
      if (Math.abs(value - min) < Math.abs(last - min) || Math.abs(value - max) < Math.abs(last - max)) {
        out[out.length - 1] = value
      }
      return
    }
    out.push(value)
  })
  if (out[0] !== min) out.unshift(min)
  if (out[out.length - 1] !== max) out.push(max)
  return out
}

function readableSvgAngle(dx: number, dy: number): number {
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI
  if (angle > 90 || angle < -90) angle += 180
  return angle
}

function createDimensionLine(
  id: string,
  side: BlueprintDimSide,
  row: BlueprintDimRow,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  nx: number,
  ny: number,
  offsetPx: number,
  screenWorldPx: number,
  text: string,
  valueFt: number,
  from: number,
  to: number,
): BlueprintDimensionLine | null {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len <= 0.01) return null
  const ux = dx / len
  const uy = dy / len
  const gap = DIM_EXTENSION_GAP_SCREEN_PX * screenWorldPx
  const tick = DIM_TICK_SCREEN_PX * screenWorldPx
  const labelGap = DIM_LABEL_SCREEN_PX * screenWorldPx
  const x1 = ax + nx * offsetPx
  const y1 = ay + ny * offsetPx
  const x2 = bx + nx * offsetPx
  const y2 = by + ny * offsetPx
  const slashX = (ux + nx) * tick
  const slashY = (uy + ny) * tick
  return {
    id,
    side,
    row,
    x1,
    y1,
    x2,
    y2,
    ext1x1: ax + nx * gap,
    ext1y1: ay + ny * gap,
    ext1x2: x1 + nx * gap,
    ext1y2: y1 + ny * gap,
    ext2x1: bx + nx * gap,
    ext2y1: by + ny * gap,
    ext2x2: x2 + nx * gap,
    ext2y2: y2 + ny * gap,
    tick1x1: x1 - slashX / 2,
    tick1y1: y1 - slashY / 2,
    tick1x2: x1 + slashX / 2,
    tick1y2: y1 + slashY / 2,
    tick2x1: x2 - slashX / 2,
    tick2y1: y2 - slashY / 2,
    tick2x2: x2 + slashX / 2,
    tick2y2: y2 + slashY / 2,
    labelX: (x1 + x2) / 2 + nx * labelGap,
    labelY: (y1 + y2) / 2 + ny * labelGap,
    angle: readableSvgAngle(dx, dy),
    text,
    valueFt,
    from,
    to,
  }
}

function sideNormal(side: BlueprintDimSide): { nx: number; ny: number } {
  if (side === 'top') return { nx: 0, ny: -1 }
  if (side === 'bottom') return { nx: 0, ny: 1 }
  if (side === 'left') return { nx: -1, ny: 0 }
  return { nx: 1, ny: 0 }
}

function addSideRows(
  out: BlueprintDimensionLine[],
  side: BlueprintDimSide,
  row: BlueprintDimRow,
  breakpoints: number[],
  bounds: SketchDimsBounds,
  cellFt: number,
  cellPx: number,
  offsetPx: number,
  screenWorldPx: number,
  formatLengthFt: (valueFt: number) => string,
) {
  const { nx, ny } = sideNormal(side)
  const horizontal = side === 'top' || side === 'bottom'
  const anchor = side === 'top' ? bounds.minY : side === 'bottom' ? bounds.maxY : side === 'left' ? bounds.minX : bounds.maxX
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const from = breakpoints[i]
    const to = breakpoints[i + 1]
    const spanCells = to - from
    if (spanCells <= 0.01) continue
    const valueFt = spanCells * cellFt
    const ax = horizontal ? from * cellPx : anchor * cellPx
    const ay = horizontal ? anchor * cellPx : from * cellPx
    const bx = horizontal ? to * cellPx : anchor * cellPx
    const by = horizontal ? anchor * cellPx : to * cellPx
    const line = createDimensionLine(
      `${side}-${row}-${i}`,
      side,
      row,
      ax,
      ay,
      bx,
      by,
      nx,
      ny,
      offsetPx,
      screenWorldPx,
      formatLengthFt(valueFt),
      valueFt,
      from,
      to,
    )
    if (line) out.push(line)
  }
}

function buildAxes(
  axes: ReturnType<typeof collectBlueprintAxes>,
  bounds: SketchDimsBounds,
  cellPx: number,
  screenWorldPx: number,
  offsetScreenPx: number,
  radiusScreenPx: number,
): BlueprintAxis[] {
  const offset = offsetScreenPx * screenWorldPx
  const radius = radiusScreenPx * screenWorldPx
  const topY = bounds.minY * cellPx - offset
  const bottomY = bounds.maxY * cellPx + offset
  const leftX = bounds.minX * cellPx - offset
  const rightX = bounds.maxX * cellPx + offset
  const vertical = axes.vertical.map<BlueprintAxis>((axis) => {
    const x = axis.position * cellPx
    return {
      id: `axis-x-${axis.label}`,
      orientation: 'vertical',
      label: axis.label,
      position: axis.position,
      sources: axis.sources,
      x1: x,
      y1: topY,
      x2: x,
      y2: bottomY,
      bubbles: [
        { side: 'top', cx: x, cy: topY, r: radius, label: axis.label },
        { side: 'bottom', cx: x, cy: bottomY, r: radius, label: axis.label },
      ],
    }
  })
  const horizontal = axes.horizontal.map<BlueprintAxis>((axis) => {
    const y = axis.position * cellPx
    return {
      id: `axis-y-${axis.label}`,
      orientation: 'horizontal',
      label: axis.label,
      position: axis.position,
      sources: axis.sources,
      x1: leftX,
      y1: y,
      x2: rightX,
      y2: y,
      bubbles: [
        { side: 'left', cx: leftX, cy: y, r: radius, label: axis.label },
        { side: 'right', cx: rightX, cy: y, r: radius, label: axis.label },
      ],
    }
  })
  return [...vertical, ...horizontal]
}

export function buildBlueprintDimensionLayout(
  model: SketchDimModel,
  options: BlueprintDimensionOptions = {},
): BlueprintDimensionLayout {
  const bounds = sketchDimsBounds(model)
  const cellFt = finitePositive(model.cellFt, DEFAULT_CELL_FT)
  const cellPx = finitePositive(options.cellPx, DEFAULT_CELL_PX)
  const screenWorldPx = finitePositive(options.screenWorldPx, 1)
  const formatLengthFt = options.formatLengthFt ?? formatBlueprintLengthFt
  const rowOffsetsPx: Record<BlueprintDimRow, number> = {
    openingsAxes: (options.rowOffsetsScreenPx?.openingsAxes ?? DEFAULT_ROW_OFFSETS_SCREEN_PX.openingsAxes) * screenWorldPx,
    segments: (options.rowOffsetsScreenPx?.segments ?? DEFAULT_ROW_OFFSETS_SCREEN_PX.segments) * screenWorldPx,
    overall: (options.rowOffsetsScreenPx?.overall ?? DEFAULT_ROW_OFFSETS_SCREEN_PX.overall) * screenWorldPx,
  }
  if (!bounds || bounds.width <= 0.01 || bounds.height <= 0.01) {
    return { bounds, dimensions: [], axes: [], rowOffsetsPx }
  }

  const axes = collectBlueprintAxes(model, options)
  const openingBreaks = openingBreakpointsBySide(model, bounds)
  const tolerance = options.axisMergeToleranceCells ?? 0.08
  const horizontalAxisBreaks = axes.vertical.map((axis) => axis.position)
  const verticalAxisBreaks = axes.horizontal.map((axis) => axis.position)
  const sideBreaks: Record<BlueprintDimSide, Record<BlueprintDimRow, number[]>> = {
    top: {
      openingsAxes: uniqueBreakpoints(bounds.minX, bounds.maxX, [...horizontalAxisBreaks, ...openingBreaks.top], tolerance),
      segments: uniqueBreakpoints(bounds.minX, bounds.maxX, horizontalAxisBreaks, tolerance),
      overall: [bounds.minX, bounds.maxX],
    },
    bottom: {
      openingsAxes: uniqueBreakpoints(bounds.minX, bounds.maxX, [...horizontalAxisBreaks, ...openingBreaks.bottom], tolerance),
      segments: uniqueBreakpoints(bounds.minX, bounds.maxX, horizontalAxisBreaks, tolerance),
      overall: [bounds.minX, bounds.maxX],
    },
    left: {
      openingsAxes: uniqueBreakpoints(bounds.minY, bounds.maxY, [...verticalAxisBreaks, ...openingBreaks.left], tolerance),
      segments: uniqueBreakpoints(bounds.minY, bounds.maxY, verticalAxisBreaks, tolerance),
      overall: [bounds.minY, bounds.maxY],
    },
    right: {
      openingsAxes: uniqueBreakpoints(bounds.minY, bounds.maxY, [...verticalAxisBreaks, ...openingBreaks.right], tolerance),
      segments: uniqueBreakpoints(bounds.minY, bounds.maxY, verticalAxisBreaks, tolerance),
      overall: [bounds.minY, bounds.maxY],
    },
  }

  const dimensions: BlueprintDimensionLine[] = []
  ;(['top', 'right', 'bottom', 'left'] as BlueprintDimSide[]).forEach((side) => {
    ;(['openingsAxes', 'segments', 'overall'] as BlueprintDimRow[]).forEach((row) => {
      addSideRows(
        dimensions,
        side,
        row,
        sideBreaks[side][row],
        bounds,
        cellFt,
        cellPx,
        rowOffsetsPx[row],
        screenWorldPx,
        formatLengthFt,
      )
    })
  })

  return {
    bounds,
    dimensions,
    axes: buildAxes(
      axes,
      bounds,
      cellPx,
      screenWorldPx,
      options.axisBubbleOffsetScreenPx ?? DEFAULT_AXIS_BUBBLE_OFFSET_SCREEN_PX,
      options.axisBubbleRadiusScreenPx ?? DEFAULT_AXIS_BUBBLE_RADIUS_SCREEN_PX,
    ),
    rowOffsetsPx,
  }
}
