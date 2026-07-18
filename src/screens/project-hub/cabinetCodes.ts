import type { Contour, Pt } from './sketchFinishes'
import type { SketchPlacedCatalogItem } from './sketchCatalog'
import { formatInches, parseInches, snapInchesToPrecision } from './inches'

export type CabinetLayer = 'base' | 'wall'
export type CabinetHinge = 'L' | 'R'
export type CabinetLayoutWarning = 'overflow' | 'small-filler'

export type ParsedCabinetCode = {
  raw: string
  code: string
  prefix: string
  widthIn: number
  heightIn: number
  depthIn: number
  layer: CabinetLayer
  hinge?: CabinetHinge
  filler: boolean
  panel: boolean
}

export type CabinetCodeParseResult = {
  cabinets: ParsedCabinetCode[]
  invalidCodes: string[]
}

export type CabinetLayoutWall = {
  c: number
  s: number
  a: Pt
  b: Pt
}

export type CabinetLayoutModel = {
  cellFt?: number
  height?: number
  contours: Contour[]
}

export type CabinetLayoutLayerSummary = {
  layer: CabinetLayer
  cabinetCount: number
  totalWidthIn: number
  fillerWidthIn: number
  overflowIn: number
}

export type CabinetLayoutResult = {
  items: SketchPlacedCatalogItem[]
  parsed: ParsedCabinetCode[]
  invalidCodes: string[]
  summaries: CabinetLayoutLayerSummary[]
  wallLengthIn: number
  overflow: boolean
  smallFiller: boolean
}

const IN_PER_FT = 12
const DEFAULT_BASE_DEPTH_IN = 24
const DEFAULT_WALL_DEPTH_IN = 12
const DEFAULT_VANITY_DEPTH_IN = 21
const DEFAULT_BASE_HEIGHT_IN = 34.5
const DEFAULT_WALL_HEIGHT_IN = 30
const DEFAULT_UTILITY_HEIGHT_IN = 90
const DEFAULT_REFRIGERATOR_PANEL_HEIGHT_IN = 96
const DEFAULT_PANEL_THICKNESS_IN = 0.75
export const CABINET_WALL_BOTTOM_IN = 54
export const CABINET_COUNTERTOP_HEIGHT_IN = 36
export const CABINET_TOE_KICK_IN = 4
export const CABINET_MIN_FILLER_IN = 3

const PREFIXES = ['WINE', '2DB', 'BEP', 'REP', 'BLS', 'BBC', 'SB', 'DB', 'BF', 'B', 'W', 'U', 'V', 'F'] as const

function finite(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function modelCellFt(model: CabinetLayoutModel): number {
  const cellFt = finite(model.cellFt)
  return cellFt !== null && cellFt > 0 ? cellFt : 1
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '')
}

function cabinetTokens(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function parseNumberToken(value: string): number | null {
  const cleaned = value.trim().replace(/^[-.]+|[-.]+$/g, '')
  if (!cleaned) return null
  const parsed = parseInches(cleaned)
  return Number.isFinite(parsed) && parsed > 0 ? snapInchesToPrecision(parsed) : null
}

function parseFirstNumber(value: string): number | null {
  const match = value.match(/\d+(?:\.\d+)?(?:-\d+\s*\/\s*\d+|-\d+\/\d+|\s+\d+\s*\/\s*\d+|\/\d+)?/)
  return match ? parseNumberToken(match[0]) : null
}

function stripHinge(code: string): { body: string; hinge?: CabinetHinge } {
  const match = code.match(/^(.*?)-?([LR])$/)
  if (!match) return { body: code }
  const body = match[1]
  if (!/\d/.test(body)) return { body: code }
  return { body, hinge: match[2] as CabinetHinge }
}

function findPrefix(code: string): string | null {
  return PREFIXES.find((prefix) => code.startsWith(prefix)) ?? null
}

function parseWallCabinet(code: string, body: string, hinge?: CabinetHinge): ParsedCabinetCode | null {
  const rest = body.slice(1)
  const compact = rest.replace(/[^\d]/g, '')
  if (!compact) return null
  const widthIn = snapInchesToPrecision(Number(compact.slice(0, 2)))
  const heightIn = compact.length >= 4 ? snapInchesToPrecision(Number(compact.slice(2, 4))) : DEFAULT_WALL_HEIGHT_IN
  const depthIn = compact.length >= 6 ? snapInchesToPrecision(Number(compact.slice(4, 6))) : DEFAULT_WALL_DEPTH_IN
  if (widthIn <= 0 || heightIn <= 0 || depthIn <= 0) return null
  return { raw: code, code, prefix: 'W', widthIn, heightIn, depthIn, layer: 'wall', hinge, filler: false, panel: false }
}

function parseUtilityCabinet(code: string, body: string, hinge?: CabinetHinge): ParsedCabinetCode | null {
  const compact = body.slice(1).replace(/[^\d]/g, '')
  const widthIn = compact.length >= 2 ? snapInchesToPrecision(Number(compact.slice(0, 2))) : parseFirstNumber(body.slice(1))
  if (!widthIn || widthIn <= 0) return null
  const heightIn = compact.length >= 4 ? snapInchesToPrecision(Number(compact.slice(2, 4))) : DEFAULT_UTILITY_HEIGHT_IN
  const depthIn = compact.length >= 6 ? snapInchesToPrecision(Number(compact.slice(4, 6))) : DEFAULT_BASE_DEPTH_IN
  return { raw: code, code, prefix: 'U', widthIn, heightIn, depthIn, layer: 'base', hinge, filler: false, panel: false }
}

function parsePanelCabinet(code: string, body: string, prefix: 'BEP' | 'REP', hinge?: CabinetHinge): ParsedCabinetCode | null {
  const rest = body.slice(prefix.length)
  const match = rest.match(/^(\d+(?:\.\d+)?)(?:-(\d+\s*\/\s*\d+|\d+\/\d+|\d+(?:\.\d+)?))?$/)
  const depthIn = match ? parseNumberToken(match[1]) : parseFirstNumber(rest)
  if (!depthIn || depthIn <= 0) return null
  const thicknessIn = match?.[2] ? parseNumberToken(match[2]) : DEFAULT_PANEL_THICKNESS_IN
  const heightIn = prefix === 'REP' ? DEFAULT_REFRIGERATOR_PANEL_HEIGHT_IN : DEFAULT_BASE_HEIGHT_IN
  return {
    raw: code,
    code,
    prefix,
    widthIn: snapInchesToPrecision(thicknessIn ?? DEFAULT_PANEL_THICKNESS_IN),
    heightIn,
    depthIn,
    layer: 'base',
    hinge,
    filler: false,
    panel: true,
  }
}

function parseGenericCabinet(code: string, body: string, prefix: string, hinge?: CabinetHinge): ParsedCabinetCode | null {
  const rest = body.slice(prefix.length)
  const widthIn = parseFirstNumber(rest)
  if (!widthIn || widthIn <= 0) return null
  const wall = prefix === 'W'
  const vanity = prefix === 'V'
  const filler = prefix === 'F' || prefix === 'BF'
  return {
    raw: code,
    code,
    prefix,
    widthIn,
    heightIn: wall ? DEFAULT_WALL_HEIGHT_IN : DEFAULT_BASE_HEIGHT_IN,
    depthIn: wall ? DEFAULT_WALL_DEPTH_IN : vanity ? DEFAULT_VANITY_DEPTH_IN : DEFAULT_BASE_DEPTH_IN,
    layer: wall ? 'wall' : 'base',
    hinge,
    filler,
    panel: false,
  }
}

export function parseCabinetCode(value: string): ParsedCabinetCode | null {
  const code = normalizeCode(value)
  if (!code) return null
  const { body, hinge } = stripHinge(code)
  const prefix = findPrefix(body)
  if (!prefix) return null
  if (prefix === 'W') return parseWallCabinet(code, body, hinge)
  if (prefix === 'U') return parseUtilityCabinet(code, body, hinge)
  if (prefix === 'BEP' || prefix === 'REP') return parsePanelCabinet(code, body, prefix, hinge)
  return parseGenericCabinet(code, body, prefix, hinge)
}

export function parseCabinetCodes(input: string): CabinetCodeParseResult {
  const cabinets: ParsedCabinetCode[] = []
  const invalidCodes: string[] = []
  cabinetTokens(input).forEach((token) => {
    const parsed = parseCabinetCode(token)
    if (parsed) cabinets.push(parsed)
    else invalidCodes.push(normalizeCode(token) || token)
  })
  return { cabinets, invalidCodes }
}

export function isCabinetPlacedItem(item: Pick<SketchPlacedCatalogItem, 'category' | 'model' | 'code' | 'layer'>): boolean {
  return item.category === 'cabinet' || item.layer === 'base' || item.layer === 'wall' || !!parseCabinetCode(item.code ?? item.model ?? '')
}

export function cabinetDisplayCode(item: Pick<SketchPlacedCatalogItem, 'code' | 'model' | 'name'>): string {
  return item.code?.trim() || item.model?.trim() || item.name?.trim() || ''
}

export function cabinetScheduleCsv(items: SketchPlacedCatalogItem[]): string | null {
  const rows = items.filter(isCabinetPlacedItem)
  if (rows.length === 0) return null
  const escape = (value: unknown): string => {
    const text = value == null ? '' : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = ['wall_id', 'layer', 'code', 'name', 'width_in', 'depth_in', 'height_in', 'hinge', 'filler', 'warning']
  const lines = rows.map((item) => [
    item.wallId ?? '',
    item.layer ?? '',
    cabinetDisplayCode(item),
    item.name ?? '',
    item.widthIn ?? '',
    item.depthIn ?? '',
    item.heightIn ?? '',
    item.hinge ?? '',
    item.filler ? 'yes' : '',
    item.layoutWarning ?? '',
  ])
  return [header, ...lines].map((row) => row.map(escape).join(',')).join('\n')
}

function wallLengthFt(model: CabinetLayoutModel, wall: CabinetLayoutWall): number {
  return Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y) * modelCellFt(model)
}

function contourCenter(contour: Contour, cellFt: number): { x: number; z: number } {
  if (contour.points.length === 0) return { x: 0, z: 0 }
  const sum = contour.points.reduce((acc, point) => ({ x: acc.x + point.x * cellFt, z: acc.z + point.y * cellFt }), { x: 0, z: 0 })
  return { x: sum.x / contour.points.length, z: sum.z / contour.points.length }
}

function wallInteriorSide(model: CabinetLayoutModel, wall: CabinetLayoutWall, ux: number, uz: number): 1 | -1 {
  const cellFt = modelCellFt(model)
  const contour = model.contours[wall.c]
  if (!contour) return 1
  const ax = wall.a.x * cellFt
  const az = wall.a.y * cellFt
  const bx = wall.b.x * cellFt
  const bz = wall.b.y * cellFt
  const mid = { x: (ax + bx) / 2, z: (az + bz) / 2 }
  const center = contourCenter(contour, cellFt)
  const nx = -uz
  const nz = ux
  return (center.x - mid.x) * nx + (center.z - mid.z) * nz < 0 ? -1 : 1
}

function normalizeAngle(value: number): number {
  const full = Math.PI * 2
  return ((value % full) + full) % full
}

function fillerCode(layer: CabinetLayer, widthIn: number): string {
  const body = formatInches(widthIn).replace(/"/g, '').replace(/\s+/g, '-')
  return `${layer === 'base' ? 'BF' : 'F'}${body}`
}

function itemName(parsed: ParsedCabinetCode): string {
  if (parsed.filler) return `${parsed.code} filler`
  if (parsed.panel) return `${parsed.code} panel`
  return parsed.code
}

function cabinetItemId(runId: string, layer: CabinetLayer, index: number, code: string): string {
  return `${runId}-${layer}-${index}-${code.replace(/[^A-Z0-9_-]+/gi, '-')}`.slice(0, 120)
}

function makePlacedCabinet(
  parsed: ParsedCabinetCode,
  model: CabinetLayoutModel,
  wall: CabinetLayoutWall,
  runId: string,
  layerIndex: number,
  startIn: number,
  warning: CabinetLayoutWarning | undefined,
): SketchPlacedCatalogItem {
  const cellFt = modelCellFt(model)
  const ax = wall.a.x * cellFt
  const az = wall.a.y * cellFt
  const bx = wall.b.x * cellFt
  const bz = wall.b.y * cellFt
  const lengthFt = Math.max(0.001, Math.hypot(bx - ax, bz - az))
  const ux = (bx - ax) / lengthFt
  const uz = (bz - az) / lengthFt
  const nx = -uz
  const nz = ux
  const side = wallInteriorSide(model, wall, ux, uz)
  const centerDistanceFt = (startIn + parsed.widthIn / 2) / IN_PER_FT
  const depthFt = parsed.depthIn / IN_PER_FT
  const offsetFt = 0.25 + depthFt / 2
  const heightFt = parsed.heightIn / IN_PER_FT
  const roomHeightFt = finite(model.height) ?? 8
  const wallBottomFt = CABINET_WALL_BOTTOM_IN / IN_PER_FT
  const wallY = Math.min(Math.max(heightFt / 2, wallBottomFt + heightFt / 2), Math.max(heightFt / 2, roomHeightFt - heightFt / 2))
  const xFt = ax + ux * centerDistanceFt + nx * side * offsetFt
  const zFt = az + uz * centerDistanceFt + nz * side * offsetFt
  const rotationY = normalizeAngle(-Math.atan2(uz, ux) + (side < 0 ? Math.PI : 0))
  const wallId = `${wall.c}:${wall.s}`
  const placed: SketchPlacedCatalogItem = {
    id: cabinetItemId(runId, parsed.layer, layerIndex, parsed.code),
    catalogItemId: `builtin-cabinet:${parsed.code}`,
    category: 'cabinet',
    name: itemName(parsed),
    model: parsed.code,
    code: parsed.code,
    cabinetPrefix: parsed.prefix,
    wallId,
    layer: parsed.layer,
    filler: parsed.filler,
    panel: parsed.panel,
    xFt: snapInchesToPrecision(xFt * IN_PER_FT) / IN_PER_FT,
    yFt: parsed.layer === 'wall' ? snapInchesToPrecision(wallY * IN_PER_FT) / IN_PER_FT : heightFt / 2,
    zFt: snapInchesToPrecision(zFt * IN_PER_FT) / IN_PER_FT,
    rotationY,
    surface: parsed.layer === 'wall' ? 'wall' : 'floor',
    c: wall.c,
    s: wall.s,
    t: Math.max(0, Math.min(1, centerDistanceFt / lengthFt)),
    widthIn: parsed.widthIn,
    depthIn: parsed.depthIn,
    heightIn: parsed.heightIn,
  }
  if (parsed.hinge) placed.hinge = parsed.hinge
  if (warning) placed.layoutWarning = warning
  return placed
}

export function layoutCabinetRunOnWall(
  model: CabinetLayoutModel,
  wall: CabinetLayoutWall,
  input: string,
  runId = `cabinet-run-${wall.c}-${wall.s}`,
): CabinetLayoutResult {
  const { cabinets, invalidCodes } = parseCabinetCodes(input)
  const wallLengthIn = snapInchesToPrecision(wallLengthFt(model, wall) * IN_PER_FT)
  const items: SketchPlacedCatalogItem[] = []
  const summaries: CabinetLayoutLayerSummary[] = []
  let overflow = false
  let smallFiller = false

  ;(['base', 'wall'] as CabinetLayer[]).forEach((layer) => {
    const layerCabinets = cabinets.filter((cabinet) => cabinet.layer === layer)
    if (layerCabinets.length === 0) return
    const cabinetWidth = snapInchesToPrecision(layerCabinets.reduce((sum, cabinet) => sum + cabinet.widthIn, 0))
    const overflowIn = Math.max(0, snapInchesToPrecision(cabinetWidth - wallLengthIn))
    let fillerWidthIn = 0
    let runCabinets = layerCabinets
    if (overflowIn <= 0) {
      const gap = snapInchesToPrecision(wallLengthIn - cabinetWidth)
      if (gap > 0) {
        fillerWidthIn = gap
        if (gap < CABINET_MIN_FILLER_IN) smallFiller = true
        runCabinets = [
          ...layerCabinets,
          {
            raw: fillerCode(layer, gap),
            code: fillerCode(layer, gap),
            prefix: layer === 'base' ? 'BF' : 'F',
            widthIn: gap,
            heightIn: layer === 'base' ? DEFAULT_BASE_HEIGHT_IN : DEFAULT_WALL_HEIGHT_IN,
            depthIn: layer === 'base' ? DEFAULT_BASE_DEPTH_IN : DEFAULT_WALL_DEPTH_IN,
            layer,
            filler: true,
            panel: false,
          },
        ]
      }
    } else {
      overflow = true
    }

    let cursorIn = 0
    runCabinets.forEach((cabinet, index) => {
      const warning = overflowIn > 0 && cursorIn + cabinet.widthIn > wallLengthIn + 0.001
        ? 'overflow'
        : cabinet.filler && cabinet.widthIn < CABINET_MIN_FILLER_IN
          ? 'small-filler'
          : undefined
      items.push(makePlacedCabinet(cabinet, model, wall, runId, index, cursorIn, warning))
      cursorIn = snapInchesToPrecision(cursorIn + cabinet.widthIn)
    })

    summaries.push({
      layer,
      cabinetCount: layerCabinets.length,
      totalWidthIn: cabinetWidth,
      fillerWidthIn,
      overflowIn,
    })
  })

  return {
    items,
    parsed: cabinets,
    invalidCodes,
    summaries,
    wallLengthIn,
    overflow,
    smallFiller,
  }
}
