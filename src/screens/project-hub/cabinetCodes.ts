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
  suggestions: Record<string, string[]>
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
  remainderIn: number
}

export type CabinetLayoutResult = {
  items: SketchPlacedCatalogItem[]
  parsed: ParsedCabinetCode[]
  invalidCodes: string[]
  suggestions: Record<string, string[]>
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
const DEFAULT_HOOD_HEIGHT_IN = 18
const DEFAULT_HOOD_DEPTH_IN = 18
export const CABINET_WALL_BOTTOM_IN = 54
export const CABINET_COUNTERTOP_HEIGHT_IN = 36
export const CABINET_TOE_KICK_IN = 4
export const CABINET_MIN_FILLER_IN = 3

// CABINETS-VERTICAL-22: стандарт NKBA — зазор 18" между столешницей (36") и низом навесного ⇒ низ 54" от пола.
export const DEFAULT_WALL_CABINET_GAP_IN = CABINET_WALL_BOTTOM_IN - CABINET_COUNTERTOP_HEIGHT_IN
export const WALL_CABINET_MIN_GAP_IN = 0
export const WALL_CABINET_MAX_GAP_IN = 240

// Эффективный зазор навесного: явное поле wallGapIn (дюймы) либо дефолт 18".
export function wallCabinetGapIn(item: Pick<SketchPlacedCatalogItem, 'wallGapIn'>): number {
  const gap = Number(item.wallGapIn)
  return Number.isFinite(gap) ? gap : DEFAULT_WALL_CABINET_GAP_IN
}

// Низ навесного (дюймы от пола) из зазора.
export function wallCabinetBottomInFromGap(gapIn: number): number {
  return CABINET_COUNTERTOP_HEIGHT_IN + gapIn
}

// Зазор (дюймы) из низа навесного (дюймы от пола).
export function wallCabinetGapFromBottomIn(bottomIn: number): number {
  return bottomIn - CABINET_COUNTERTOP_HEIGHT_IN
}

// Центр навесного по Y (футы) — как его позиционируют развёртка и 3D. Предпочитает wallGapIn,
// иначе fallback на yFt (старые эскизы без поля грузятся штатно, дефолт 18").
export function wallCabinetCenterYFt(item: Pick<SketchPlacedCatalogItem, 'wallGapIn' | 'yFt'>, heightIn: number): number {
  if (Number.isFinite(Number(item.wallGapIn))) {
    return (wallCabinetBottomInFromGap(wallCabinetGapIn(item)) + heightIn / 2) / IN_PER_FT
  }
  return item.yFt
}

const PREFIXES = ['RANGE', 'WINE', 'HOOD', '3DB', '2DB', '1DB', 'BEP', 'REP', 'BLS', 'BBC', 'REF', 'SB', 'DB', 'BF', 'DW', 'B', 'W', 'U', 'V', 'F'] as const
const PREFIX_SET = new Set<string>(PREFIXES)
const DEFAULT_REFRIGERATOR_HEIGHT_IN = 72
const DEFAULT_REFRIGERATOR_DEPTH_IN = 30
const DEFAULT_SUGGESTION_WIDTH_IN = 30
const STANDARD_SUGGESTION_WIDTHS_IN = [12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48]
const CYRILLIC_PREFIX_ALIASES: Array<[RegExp, string]> = [
  [/(^|[^0-9A-Za-zА-Яа-яЁё])([Вв][Бб]|[Сс][Бб])(?=\s*\d)/g, '$1SB'],
]
const CYRILLIC_VISUALS: Record<string, string> = {
  А: 'A',
  а: 'A',
  В: 'B',
  в: 'B',
  Б: 'B',
  б: 'B',
  Е: 'E',
  е: 'E',
  С: 'C',
  с: 'C',
  Р: 'P',
  р: 'P',
  Н: 'H',
  н: 'H',
  К: 'K',
  к: 'K',
  М: 'M',
  м: 'M',
  Т: 'T',
  т: 'T',
  О: 'O',
  о: 'O',
  У: 'Y',
  у: 'Y',
  Х: 'X',
  х: 'X',
  З: '3',
  з: '3',
  Ф: 'F',
  ф: 'F',
  Д: 'D',
  д: 'D',
}

function finite(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function modelCellFt(model: CabinetLayoutModel): number {
  const cellFt = finite(model.cellFt)
  return cellFt !== null && cellFt > 0 ? cellFt : 1
}

function transliterateCabinetText(value: string): string {
  const withAliases = CYRILLIC_PREFIX_ALIASES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
  return Array.from(withAliases).map((char) => CYRILLIC_VISUALS[char] ?? char).join('')
}

function normalizeDigitLookalikes(value: string): string {
  const chars = Array.from(value)
  return chars.map((char, index) => {
    if (char !== 'O') return char
    const prev = chars[index - 1]
    const next = chars[index + 1]
    return (prev && /\d/.test(prev)) || (next && /\d/.test(next)) ? '0' : char
  }).join('')
}

function normalizeCabinetText(value: string): string {
  return normalizeDigitLookalikes(transliterateCabinetText(value).toUpperCase())
}

function normalizeCode(value: string): string {
  return normalizeCabinetText(value).trim().replace(/\s+/g, '')
}

export function normalizeCabinetCodeInput(value: string): string {
  return normalizeCode(value)
}

function startsNumberToken(value: string): boolean {
  return /^\d/.test(value)
}

function isStandalonePrefixToken(value: string): boolean {
  return PREFIX_SET.has(normalizeCode(value))
}

function isSimpleWallSizeToken(value: string): boolean {
  return /^\d{1,2}$/.test(value)
}

function cabinetTokens(input: string): string[] {
  const parts = normalizeCabinetText(input)
    .replace(/[,;]+/g, ' ')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  const tokens: string[] = []
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i]
    const prefix = normalizeCode(token)
    const next = parts[i + 1]
    if (next && isStandalonePrefixToken(prefix) && startsNumberToken(next)) {
      if (prefix === 'W' && parts[i + 2] && isSimpleWallSizeToken(next) && isSimpleWallSizeToken(parts[i + 2])) {
        tokens.push(`${prefix}${next}${parts[i + 2]}`)
        i += 2
      } else {
        tokens.push(`${prefix}${next}`)
        i += 1
      }
    } else {
      tokens.push(token)
    }
  }
  return tokens
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
  const refrigerator = prefix === 'REF'
  const hood = prefix === 'HOOD'
  return {
    raw: code,
    code,
    prefix,
    widthIn,
    heightIn: refrigerator ? DEFAULT_REFRIGERATOR_HEIGHT_IN : hood ? DEFAULT_HOOD_HEIGHT_IN : wall ? DEFAULT_WALL_HEIGHT_IN : DEFAULT_BASE_HEIGHT_IN,
    depthIn: refrigerator ? DEFAULT_REFRIGERATOR_DEPTH_IN : hood ? DEFAULT_HOOD_DEPTH_IN : wall ? DEFAULT_WALL_DEPTH_IN : vanity ? DEFAULT_VANITY_DEPTH_IN : DEFAULT_BASE_DEPTH_IN,
    layer: wall || hood ? 'wall' : 'base',
    hinge,
    filler,
    panel: false,
  }
}

function nearestStandardSuggestionWidth(width: number | null): number {
  if (!width || width <= 0) return DEFAULT_SUGGESTION_WIDTH_IN
  return STANDARD_SUGGESTION_WIDTHS_IN.reduce((best, candidate) => (
    Math.abs(candidate - width) < Math.abs(best - width) ? candidate : best
  ), STANDARD_SUGGESTION_WIDTHS_IN[0])
}

function suggestionWidth(value: string): number {
  return nearestStandardSuggestionWidth(parseFirstNumber(normalizeCode(value)))
}

function suggestionCode(prefix: string, widthIn: number): string {
  if (prefix === 'W') return `W${String(widthIn).padStart(2, '0')}30`
  return `${prefix}${widthIn}`
}

function preferredSuggestionPrefixes(value: string): string[] {
  const alpha = normalizeCode(value).replace(/[^A-Z]/g, '')
  if (alpha.startsWith('SB') || alpha === 'S') return ['SB', 'B', 'DB', 'W']
  if (alpha.startsWith('DB') || alpha.startsWith('D')) return ['DB', 'B', 'SB', 'W']
  if (alpha.startsWith('W')) return ['W', 'B', 'DB', 'SB']
  if (alpha.startsWith('V')) return ['V', 'B', 'SB', 'DB']
  if (alpha.startsWith('BF') || alpha.startsWith('F')) return ['BF', 'B', 'DB', 'W']
  if (alpha.startsWith('DW')) return ['DW', 'RANGE', 'REF', 'B']
  if (alpha.startsWith('H')) return ['HOOD', 'W', 'RANGE', 'B']
  if (alpha.startsWith('REF')) return ['REF', 'RANGE', 'DW', 'B']
  if (alpha.startsWith('R')) return ['RANGE', 'REF', 'DW', 'B']
  return ['B', 'DB', 'W', 'SB']
}

export function suggestCabinetCodes(value: string, limit = 4): string[] {
  const normalized = normalizeCode(value)
  if (!normalized || parseCabinetCode(normalized)) return []
  const widthIn = suggestionWidth(normalized)
  const candidates: string[] = []
  const add = (code: string) => {
    if (!candidates.includes(code) && parseCabinetCode(code)) candidates.push(code)
  }
  preferredSuggestionPrefixes(normalized).forEach((prefix) => add(suggestionCode(prefix, widthIn)))
  ;['B', 'DB', 'W', 'SB'].forEach((prefix) => add(suggestionCode(prefix, widthIn)))
  return candidates.slice(0, Math.max(0, limit))
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
  const suggestions: Record<string, string[]> = {}
  cabinetTokens(input).forEach((token) => {
    const parsed = parseCabinetCode(token)
    if (parsed) cabinets.push(parsed)
    else {
      const invalid = normalizeCode(token) || token
      invalidCodes.push(invalid)
      suggestions[invalid] = suggestCabinetCodes(invalid)
    }
  })
  return { cabinets, invalidCodes, suggestions }
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
  const { cabinets, invalidCodes, suggestions } = parseCabinetCodes(input)
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
    let remainderIn = 0
    let runCabinets = layerCabinets
    if (overflowIn <= 0) {
      const gap = snapInchesToPrecision(wallLengthIn - cabinetWidth)
      if (gap > 0) {
        // CABINETS-PLACE-13: авто-филлер только для мелкого зазора (≤3"); большой остаток
        // НЕ закрываем синтетическим шкафом — показываем цифрой (remainderIn) как у лидеров.
        if (gap <= CABINET_MIN_FILLER_IN) {
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
        } else {
          remainderIn = gap
        }
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
      remainderIn,
    })
  })

  return {
    items,
    parsed: cabinets,
    invalidCodes,
    suggestions,
    summaries,
    wallLengthIn,
    overflow,
    smallFiller,
  }
}
