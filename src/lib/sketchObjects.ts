import { formatBlueprintLengthFt } from './sketchDims'

export type SketchPoint = { x: number; y: number }

export type SketchStairDirection = 'horizontal' | 'vertical' | 'turn'
export type SketchStairArrow = 'UP' | 'DN'

export type SketchStair = {
  id: string
  x: number
  y: number
  widthIn: number
  steps: number
  direction: SketchStairDirection
  arrow: SketchStairArrow
}

export type SketchCallout = {
  id: string
  target: SketchPoint
  label: SketchPoint
  text: string
}

export type SketchObjectsModel = {
  stairs?: unknown
  callouts?: unknown
}

export type SanitizedSketchObjectCollections = {
  stairs?: SketchStair[]
  callouts?: SketchCallout[]
}

export type SketchPlanSymbolKind =
  | 'bathtub'
  | 'toilet'
  | 'lavatory'
  | 'shower'
  | 'range'
  | 'kitchen-sink'

export type SketchPlanSymbolSource = {
  category?: string
  kind?: string
  model?: string
  code?: string
  name?: string
  catalogItemId?: string
  applianceType?: string
}

export type PlanPrimitive =
  | { type: 'rect'; x: number; y: number; width: number; height: number; rx?: number }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { type: 'circle'; cx: number; cy: number; r: number }
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'path'; d: string }

export type PlanSymbolGeometry = {
  kind: SketchPlanSymbolKind
  outline: PlanPrimitive[]
  details: PlanPrimitive[]
}

export type SketchStairGeometry = {
  id: string
  direction: SketchStairDirection
  arrow: SketchStairArrow
  widthLabel: string
  outline: SketchPoint[]
  treads: Array<{ a: SketchPoint; b: SketchPoint }>
  arrowPath: SketchPoint[]
  arrowHead: [SketchPoint, SketchPoint, SketchPoint]
  label: { x: number; y: number; text: string }
  widthTag: { x: number; y: number; text: string }
}

export type SketchCalloutGeometry = {
  id: string
  textLines: string[]
  box: { x: number; y: number; width: number; height: number; rx: number }
  leader: { x1: number; y1: number; x2: number; y2: number }
  arrowHead: [SketchPoint, SketchPoint, SketchPoint]
}

export const SKETCH_STAIR_DIRECTIONS: readonly SketchStairDirection[] = ['horizontal', 'vertical', 'turn']
export const SKETCH_STAIR_ARROWS: readonly SketchStairArrow[] = ['UP', 'DN']
export const DEFAULT_SKETCH_STAIR_WIDTH_IN = 42
export const DEFAULT_SKETCH_STAIR_STEPS = 12
export const DEFAULT_SKETCH_STAIR_TREAD_IN = 11
export const DEFAULT_CALLOUT_TEXT = 'NOTE'

const MAX_STORED_TEXT = 180
const MAX_OBJECTS = 200

function cleanString(value: unknown, max = MAX_STORED_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text ? text.slice(0, max) : undefined
}

function cleanFinite(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanPoint(value: unknown, fallback?: SketchPoint): SketchPoint | null {
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>
    const x = cleanFinite(raw.x)
    const y = cleanFinite(raw.y)
    if (x !== undefined && y !== undefined) return { x, y }
  }
  return fallback ?? null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function sanitizeStairDirection(value: unknown): SketchStairDirection {
  return SKETCH_STAIR_DIRECTIONS.includes(value as SketchStairDirection) ? (value as SketchStairDirection) : 'horizontal'
}

function sanitizeStairArrow(value: unknown): SketchStairArrow {
  return value === 'DN' ? 'DN' : 'UP'
}

export function formatSketchObjectLengthIn(valueIn: number): string {
  return formatBlueprintLengthFt((Number.isFinite(valueIn) ? valueIn : 0) / 12)
}

export function createDefaultSketchStair(
  id: string,
  point: SketchPoint,
  defaults: Partial<Pick<SketchStair, 'widthIn' | 'steps' | 'direction' | 'arrow'>> = {},
): SketchStair {
  return {
    id,
    x: point.x,
    y: point.y,
    widthIn: clamp(cleanFinite(defaults.widthIn) ?? DEFAULT_SKETCH_STAIR_WIDTH_IN, 18, 96),
    steps: Math.round(clamp(cleanFinite(defaults.steps) ?? DEFAULT_SKETCH_STAIR_STEPS, 2, 40)),
    direction: sanitizeStairDirection(defaults.direction),
    arrow: sanitizeStairArrow(defaults.arrow),
  }
}

export function createDefaultSketchCallout(
  id: string,
  target: SketchPoint,
  defaults: Partial<Pick<SketchCallout, 'text' | 'label'>> = {},
): SketchCallout {
  const text = cleanString(defaults.text) ?? DEFAULT_CALLOUT_TEXT
  const label = cleanPoint(defaults.label) ?? { x: target.x + 2.25, y: target.y - 1.35 }
  return { id, target, label, text }
}

export function sanitizeSketchStairs(value: unknown): SketchStair[] {
  if (!Array.isArray(value)) return []
  return value
    .map((raw): SketchStair | null => {
      if (!raw || typeof raw !== 'object') return null
      const item = raw as Record<string, unknown>
      const id = cleanString(item.id, 100)
      const x = cleanFinite(item.x ?? item.xFt)
      const y = cleanFinite(item.y ?? item.z ?? item.yFt)
      if (!id || x === undefined || y === undefined) return null
      const widthIn = clamp(cleanFinite(item.widthIn ?? item.width_in) ?? DEFAULT_SKETCH_STAIR_WIDTH_IN, 18, 96)
      const steps = Math.round(clamp(cleanFinite(item.steps ?? item.stepCount ?? item.step_count) ?? DEFAULT_SKETCH_STAIR_STEPS, 2, 40))
      return {
        id,
        x,
        y,
        widthIn,
        steps,
        direction: sanitizeStairDirection(item.direction),
        arrow: sanitizeStairArrow(item.arrow),
      }
    })
    .filter((item): item is SketchStair => !!item)
    .slice(0, MAX_OBJECTS)
}

export function sanitizeSketchCallouts(value: unknown): SketchCallout[] {
  if (!Array.isArray(value)) return []
  return value
    .map((raw): SketchCallout | null => {
      if (!raw || typeof raw !== 'object') return null
      const item = raw as Record<string, unknown>
      const id = cleanString(item.id, 100)
      const target = cleanPoint(item.target, {
        x: cleanFinite(item.targetX ?? item.x) ?? Number.NaN,
        y: cleanFinite(item.targetY ?? item.y) ?? Number.NaN,
      })
      const label = cleanPoint(item.label, {
        x: cleanFinite(item.labelX ?? item.textX) ?? Number.NaN,
        y: cleanFinite(item.labelY ?? item.textY) ?? Number.NaN,
      })
      const text = cleanString(item.text)
      if (!id || !target || !label || !Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(label.x) || !Number.isFinite(label.y) || !text) return null
      return { id, target, label, text }
    })
    .filter((item): item is SketchCallout => !!item)
    .slice(0, MAX_OBJECTS)
}

export function sanitizeSketchObjectCollections(model: SketchObjectsModel): SanitizedSketchObjectCollections {
  const stairs = sanitizeSketchStairs(model.stairs)
  const callouts = sanitizeSketchCallouts(model.callouts)
  const out: SanitizedSketchObjectCollections = {}
  if (stairs.length > 0) out.stairs = stairs
  if (callouts.length > 0) out.callouts = callouts
  return out
}

function stairOutlineRect(cx: number, cy: number, width: number, depth: number): SketchPoint[] {
  return [
    { x: cx - width / 2, y: cy - depth / 2 },
    { x: cx + width / 2, y: cy - depth / 2 },
    { x: cx + width / 2, y: cy + depth / 2 },
    { x: cx - width / 2, y: cy + depth / 2 },
  ]
}

function arrowHead(a: SketchPoint, b: SketchPoint, size: number): [SketchPoint, SketchPoint, SketchPoint] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const px = -uy
  const py = ux
  return [
    b,
    { x: b.x - ux * size + px * size * 0.52, y: b.y - uy * size + py * size * 0.52 },
    { x: b.x - ux * size - px * size * 0.52, y: b.y - uy * size - py * size * 0.52 },
  ]
}

export function buildSketchStairGeometry(
  stair: SketchStair,
  options: { cellFt?: number; cellPx?: number } = {},
): SketchStairGeometry {
  const cellFt = Number.isFinite(options.cellFt) && (options.cellFt ?? 0) > 0 ? options.cellFt ?? 1 : 1
  const cellPx = Number.isFinite(options.cellPx) && (options.cellPx ?? 0) > 0 ? options.cellPx ?? 1 : 1
  const widthCells = (stair.widthIn / 12) / cellFt
  const runCells = Math.max(widthCells * 1.35, (stair.steps * DEFAULT_SKETCH_STAIR_TREAD_IN / 12) / cellFt)
  const cx = stair.x * cellPx
  const cy = stair.y * cellPx
  const w = widthCells * cellPx
  const run = runCells * cellPx
  const treads: Array<{ a: SketchPoint; b: SketchPoint }> = []
  let outline: SketchPoint[]
  let arrowPath: SketchPoint[]
  let widthTag: SketchPoint

  if (stair.direction === 'vertical') {
    outline = stairOutlineRect(cx, cy, w, run)
    const top = cy - run / 2
    const left = cx - w / 2
    for (let i = 1; i < stair.steps; i += 1) {
      const y = top + (run * i) / stair.steps
      treads.push({ a: { x: left, y }, b: { x: left + w, y } })
    }
    const start = { x: cx, y: cy + run * 0.36 }
    const end = { x: cx, y: cy - run * 0.36 }
    arrowPath = stair.arrow === 'UP' ? [start, end] : [end, start]
    widthTag = { x: cx + w / 2 + Math.max(10, w * 0.18), y: cy }
  } else if (stair.direction === 'turn') {
    const leg = Math.max(run * 0.58, w * 1.65)
    const left = cx - (leg + w) / 2
    const top = cy - (leg + w) / 2
    outline = [
      { x: left, y: top },
      { x: left + leg + w, y: top },
      { x: left + leg + w, y: top + w },
      { x: left + w, y: top + w },
      { x: left + w, y: top + leg + w },
      { x: left, y: top + leg + w },
    ]
    const firstSteps = Math.max(2, Math.floor(stair.steps / 2))
    const secondSteps = Math.max(2, stair.steps - firstSteps)
    for (let i = 1; i < firstSteps; i += 1) {
      const x = left + (leg * i) / firstSteps
      treads.push({ a: { x, y: top }, b: { x, y: top + w } })
    }
    for (let i = 1; i < secondSteps; i += 1) {
      const y = top + w + (leg * i) / secondSteps
      treads.push({ a: { x: left, y }, b: { x: left + w, y } })
    }
    const upPath = [
      { x: left + w * 0.5, y: top + leg + w * 0.72 },
      { x: left + w * 0.5, y: top + w * 0.5 },
      { x: left + leg + w * 0.7, y: top + w * 0.5 },
    ]
    arrowPath = stair.arrow === 'UP' ? upPath : [...upPath].reverse()
    widthTag = { x: left + leg + w + Math.max(10, w * 0.12), y: top + w / 2 }
  } else {
    outline = stairOutlineRect(cx, cy, run, w)
    const left = cx - run / 2
    const top = cy - w / 2
    for (let i = 1; i < stair.steps; i += 1) {
      const x = left + (run * i) / stair.steps
      treads.push({ a: { x, y: top }, b: { x, y: top + w } })
    }
    const start = { x: cx - run * 0.36, y: cy }
    const end = { x: cx + run * 0.36, y: cy }
    arrowPath = stair.arrow === 'UP' ? [start, end] : [end, start]
    widthTag = { x: cx, y: cy + w / 2 + Math.max(10, w * 0.18) }
  }

  const headFrom = arrowPath[Math.max(0, arrowPath.length - 2)]
  const headTo = arrowPath[arrowPath.length - 1]
  const label = {
    x: headTo.x,
    y: headTo.y - 10,
    text: stair.arrow,
  }
  return {
    id: stair.id,
    direction: stair.direction,
    arrow: stair.arrow,
    widthLabel: formatSketchObjectLengthIn(stair.widthIn),
    outline,
    treads,
    arrowPath,
    arrowHead: arrowHead(headFrom, headTo, Math.max(7, cellPx * 0.18)),
    label,
    widthTag: { ...widthTag, text: formatSketchObjectLengthIn(stair.widthIn) },
  }
}

function splitCalloutText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ''
  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxChars || !current) {
      current = next
    } else {
      lines.push(current)
      current = word
    }
  })
  if (current) lines.push(current)
  return lines.slice(0, 4)
}

export function buildSketchCalloutGeometry(
  callout: SketchCallout,
  options: { cellPx?: number; screenWorldPx?: number } = {},
): SketchCalloutGeometry {
  const cellPx = Number.isFinite(options.cellPx) && (options.cellPx ?? 0) > 0 ? options.cellPx ?? 1 : 1
  const screenWorldPx = Number.isFinite(options.screenWorldPx) && (options.screenWorldPx ?? 0) > 0 ? options.screenWorldPx ?? 1 : 1
  const textLines = splitCalloutText(callout.text, 24)
  const longest = textLines.reduce((max, line) => Math.max(max, line.length), 0)
  const width = Math.max(92, Math.min(230, longest * 7.1 + 24)) * screenWorldPx
  const height = Math.max(30, textLines.length * 14 + 16) * screenWorldPx
  const cx = callout.label.x * cellPx
  const cy = callout.label.y * cellPx
  const tx = callout.target.x * cellPx
  const ty = callout.target.y * cellPx
  const dx = tx - cx
  const dy = ty - cy
  const scale = 1 / Math.max(Math.abs(dx) / (width / 2), Math.abs(dy) / (height / 2), 1)
  const start = {
    x: cx + dx * scale,
    y: cy + dy * scale,
  }
  const head = arrowHead(start, { x: tx, y: ty }, 8 * screenWorldPx)
  return {
    id: callout.id,
    textLines,
    box: {
      x: cx - width / 2,
      y: cy - height / 2,
      width,
      height,
      rx: Math.min(8 * screenWorldPx, 6 * screenWorldPx),
    },
    leader: { x1: start.x, y1: start.y, x2: tx, y2: ty },
    arrowHead: head,
  }
}

function normalizedText(item: SketchPlanSymbolSource): string {
  return [item.name, item.model, item.code, item.catalogItemId, item.kind, item.applianceType, item.category]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function codePrefix(item: SketchPlanSymbolSource): string {
  const raw = String(item.code ?? item.model ?? '').trim().toUpperCase()
  const match = raw.match(/^[A-Z]+/)
  return match ? match[0] : ''
}

export function inferSketchPlanSymbolKind(item: SketchPlanSymbolSource): SketchPlanSymbolKind | undefined {
  const text = normalizedText(item)
  const prefix = codePrefix(item)
  const kind = String(item.kind ?? '').toUpperCase()
  if (kind === 'TOILET' || text.includes('builtin-toilet') || /\btoilet\b|inodoro/.test(text)) return 'toilet'
  if (kind === 'SHOWER_PAN' || item.category === 'shower' || /\bshower\b|ducha/.test(text)) return 'shower'
  if (/\bbathtub\b|\bbath\b|\btub\b|banera/.test(text)) return 'bathtub'
  if (item.applianceType === 'range' || item.applianceType === 'cooktop' || prefix === 'RANGE' || prefix === 'COOK') return 'range'
  if (prefix === 'SB' || /\bkitchen\s*sink\b|fregadero/.test(text)) return 'kitchen-sink'
  if (item.category === 'vanity' || prefix === 'V' || /\bvanity\b|\blavatory\b|tocador/.test(text)) return 'lavatory'
  return undefined
}

export function buildPlanSymbolGeometry(kind: SketchPlanSymbolKind, width: number, depth: number): PlanSymbolGeometry {
  const w = Math.max(1, width)
  const d = Math.max(1, depth)
  const rx = Math.min(w, d) * 0.05
  const baseRect: PlanPrimitive = { type: 'rect', x: -w / 2, y: -d / 2, width: w, height: d, rx }
  switch (kind) {
    case 'bathtub':
      return {
        kind,
        outline: [baseRect],
        details: [
          { type: 'ellipse', cx: 0, cy: 0, rx: w * 0.38, ry: d * 0.32 },
          { type: 'circle', cx: w * 0.32, cy: 0, r: Math.min(w, d) * 0.045 },
          { type: 'line', x1: -w * 0.42, y1: -d * 0.28, x2: -w * 0.42, y2: d * 0.28 },
        ],
      }
    case 'toilet':
      return {
        kind,
        outline: [],
        details: [
          { type: 'rect', x: -w * 0.44, y: -d * 0.46, width: w * 0.88, height: d * 0.22, rx: w * 0.08 },
          { type: 'ellipse', cx: 0, cy: d * 0.1, rx: w * 0.36, ry: d * 0.28 },
          { type: 'ellipse', cx: 0, cy: d * 0.1, rx: w * 0.21, ry: d * 0.16 },
          { type: 'line', x1: 0, y1: -d * 0.48, x2: 0, y2: d * 0.5 },
        ],
      }
    case 'lavatory':
      return {
        kind,
        outline: [baseRect],
        details: [
          { type: 'ellipse', cx: 0, cy: -d * 0.02, rx: w * 0.3, ry: d * 0.28 },
          { type: 'circle', cx: 0, cy: -d * 0.02, r: Math.min(w, d) * 0.035 },
          { type: 'path', d: `M ${-w * 0.16} ${-d * 0.36} Q 0 ${-d * 0.46} ${w * 0.16} ${-d * 0.36}` },
        ],
      }
    case 'shower':
      return {
        kind,
        outline: [baseRect],
        details: [
          { type: 'line', x1: -w * 0.38, y1: 0, x2: w * 0.38, y2: 0 },
          { type: 'circle', cx: w * 0.34, cy: d * 0.28, r: Math.min(w, d) * 0.045 },
          { type: 'path', d: `M ${-w * 0.36} ${-d * 0.32} L ${w * 0.36} ${d * 0.32}` },
        ],
      }
    case 'range':
      return {
        kind,
        outline: [baseRect],
        details: [
          { type: 'circle', cx: -w * 0.22, cy: -d * 0.18, r: Math.min(w, d) * 0.09 },
          { type: 'circle', cx: w * 0.22, cy: -d * 0.18, r: Math.min(w, d) * 0.09 },
          { type: 'circle', cx: -w * 0.22, cy: d * 0.18, r: Math.min(w, d) * 0.09 },
          { type: 'circle', cx: w * 0.22, cy: d * 0.18, r: Math.min(w, d) * 0.09 },
          { type: 'line', x1: -w * 0.5, y1: d * 0.36, x2: w * 0.5, y2: d * 0.36 },
        ],
      }
    case 'kitchen-sink':
    default:
      return {
        kind,
        outline: [baseRect],
        details: [
          { type: 'rect', x: -w * 0.32, y: -d * 0.28, width: w * 0.64, height: d * 0.48, rx: Math.min(w, d) * 0.06 },
          { type: 'circle', cx: 0, cy: -d * 0.03, r: Math.min(w, d) * 0.04 },
          { type: 'path', d: `M ${-w * 0.14} ${-d * 0.36} Q 0 ${-d * 0.48} ${w * 0.14} ${-d * 0.36}` },
        ],
      }
  }
}
