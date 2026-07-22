import type { CatalogCategory, CatalogItem, CatalogItemSpecs } from '../../lib/api'
import { normalizeTileSurface, type Contour, type SketchTileFinish } from './sketchFinishes'
import { formatInches } from './inches'

export type CatalogPlacementSurface = 'floor' | 'wall' | 'ceiling'
// ELEMENTS-INFRA-26: инженерка-разметка — новые классы placed-объектов (подводки/колонны/короба).
// APPLIANCES-28: техника (плита/варочная/духовка/СВЧ/холодильник/ПММ/вытяжка) и мебель (столы/стулья).
export type SketchPlacedCatalogKind = 'TOILET' | 'SHOWER_PAN' | 'OUTLET' | 'SWITCH' | 'PIPE' | 'COLUMN' | 'BOX' | 'APPLIANCE' | 'FURNITURE'
export type SketchElectricalVariant = 'single' | 'double'
export type SketchPipeKind = 'water-h' | 'water-v' | 'gas'
export type SketchColumnShape = 'round' | 'square'
// APPLIANCES-28: тип техники (габариты — в appliances.ts) и мебели.
export type SketchApplianceType = 'range' | 'cooktop' | 'oven' | 'microwave' | 'refrigerator' | 'dishwasher' | 'hood'
export type SketchFurnitureType = 'table-rect' | 'table-round' | 'chair'
export type SketchPlacedCabinetLayer = 'base' | 'wall'
export type SketchShowerPanShape = 'rect' | 'neo-angle'

export type SketchPlacedCatalogItem = {
  id: string
  catalogItemId: string
  xFt: number
  yFt: number
  zFt: number
  rotationY: number
  surface: CatalogPlacementSurface
  c?: number
  s?: number
  t?: number
  category?: CatalogCategory
  kind?: SketchPlacedCatalogKind
  name?: string
  brand?: string
  model?: string
  code?: string
  cabinetPrefix?: string
  wallId?: string
  layer?: SketchPlacedCabinetLayer
  hinge?: 'L' | 'R'
  filler?: boolean
  // CABINETS-CORNER-FILLERS-24: ручной филлер, вставленный пользователем. Отличает его от
  // авто-филлера (≤3" зазор, добавляется расчётом): ручной сохраняется в код-строке ряда и
  // не срезается при пересборке. Опционально; старый эскиз без поля грузится штатно.
  manualFiller?: boolean
  // ELEMENTS-INFRA-26: инженерка-разметка. variant — одинарная/двойная (розетка/выключатель);
  // pipe — тип подводки (вода гориз./верт., газ); column — форма колонны (круг/квадрат).
  // Все опциональны и проходят через sanitizePlacedCatalogItems (allowlist), version:1 цел.
  variant?: SketchElectricalVariant
  pipe?: SketchPipeKind
  column?: SketchColumnShape
  // APPLIANCES-28: тип техники/мебели + флаг «встроена в пенал» (духовка/СВЧ). Все опциональны и
  // проходят через sanitizePlacedCatalogItems (allowlist), version:1 цел, старый эскиз грузится штатно.
  applianceType?: SketchApplianceType
  furnitureType?: SketchFurnitureType
  builtIn?: boolean
  panel?: boolean
  showerPanShape?: SketchShowerPanShape
  panFinish?: SketchTileFinish
  layoutWarning?: 'overflow' | 'small-filler'
  widthIn?: number
  depthIn?: number
  heightIn?: number
  // CABINETS-VERTICAL-22: зазор (дюймы) от столешницы (36") до низа навесного шкафа.
  // Опционально, только для layer==='wall'. Отсутствует → дефолт 18" (низ навесных 54" от пола).
  wallGapIn?: number
  photoPath?: string
  specs?: CatalogItemSpecs
}

export type CatalogDimsFt = {
  widthFt: number
  depthFt: number
  heightFt: number
}

export type CatalogResolvedPlacedItem = {
  placed: SketchPlacedCatalogItem
  catalogItem: CatalogItem | null
  missingCatalogItem: boolean
  category: CatalogCategory
  name: string
  brand: string | null
  model: string | null
  photoPath: string | null
  specs: CatalogItemSpecs | null
  dims: CatalogDimsFt
  widthIn: number
  depthIn: number
  heightIn: number
}

export type CatalogWorldPoint = { x: number; z: number }

export type CatalogWallHit = {
  c: number
  s: number
  t: number
  x: number
  z: number
  yFt?: number
  ux: number
  uz: number
  nx: number
  nz: number
  side: 1 | -1
  distanceFt: number
  lengthFt: number
  rotationY: number
}

export type CatalogSceneBounds = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  width: number
  depth: number
}

const CATALOG_CATEGORIES: CatalogCategory[] = ['shower', 'vanity', 'cabinet', 'light', 'fan', 'tile', 'other']
const CATALOG_CATEGORY_SET = new Set<string>(CATALOG_CATEGORIES)
export const SKETCH_CATALOG_KIND_TOILET: SketchPlacedCatalogKind = 'TOILET'
export const SKETCH_CATALOG_KIND_SHOWER_PAN: SketchPlacedCatalogKind = 'SHOWER_PAN'
export const SKETCH_CATALOG_KIND_OUTLET: SketchPlacedCatalogKind = 'OUTLET'
export const SKETCH_CATALOG_KIND_SWITCH: SketchPlacedCatalogKind = 'SWITCH'
export const SKETCH_CATALOG_KIND_PIPE: SketchPlacedCatalogKind = 'PIPE'
export const SKETCH_CATALOG_KIND_COLUMN: SketchPlacedCatalogKind = 'COLUMN'
export const SKETCH_CATALOG_KIND_BOX: SketchPlacedCatalogKind = 'BOX'
export const SKETCH_CATALOG_KIND_APPLIANCE: SketchPlacedCatalogKind = 'APPLIANCE'
export const SKETCH_CATALOG_KIND_FURNITURE: SketchPlacedCatalogKind = 'FURNITURE'
export const BUILTIN_TOILET_CATALOG_ID = 'builtin-toilet'
export const BUILTIN_SHOWER_PAN_RECT_CATALOG_ID = 'builtin-shower-pan-60x32'
export const BUILTIN_SHOWER_PAN_NEO_CATALOG_ID = 'builtin-shower-pan-neo-36'
export const BUILTIN_OUTLET_CATALOG_ID = 'builtin-outlet'
export const BUILTIN_SWITCH_CATALOG_ID = 'builtin-switch'
// ELEMENTS-INFRA-26: builtin-каталог для новых инженерных классов (снимок размеров, не в смете).
export const BUILTIN_PIPE_CATALOG_ID = 'builtin-pipe'
export const BUILTIN_COLUMN_CATALOG_ID = 'builtin-column'
export const BUILTIN_BOX_CATALOG_ID = 'builtin-box'
// APPLIANCES-28: builtin-каталог для встроенной техники (маркер) и мебели (снимок габаритов, не в смете).
export const BUILTIN_APPLIANCE_CATALOG_ID = 'builtin-appliance'
export const BUILTIN_FURNITURE_CATALOG_ID = 'builtin-furniture'
export const BUILTIN_TOILET_CATALOG_ITEM: CatalogItem = {
  id: BUILTIN_TOILET_CATALOG_ID,
  org_id: '',
  category: 'other',
  name: 'Toilet',
  brand: null,
  model: SKETCH_CATALOG_KIND_TOILET,
  width_in: 15,
  depth_in: 28,
  height_in: 30,
  photo_path: null,
  price: null,
  specs: null,
  url: null,
  note: null,
  is_active: true,
  sort_order: -100,
  created_by: null,
  created_at: '',
  updated_at: '',
}
export const BUILTIN_SHOWER_PAN_CATALOG_ITEMS: CatalogItem[] = [
  {
    id: BUILTIN_SHOWER_PAN_RECT_CATALOG_ID,
    org_id: '',
    category: 'shower',
    name: 'Shower pan 60 x 32',
    brand: null,
    model: 'SHOWER_PAN_RECT',
    width_in: 60,
    depth_in: 32,
    height_in: 4,
    photo_path: null,
    price: null,
    specs: null,
    url: null,
    note: null,
    is_active: true,
    sort_order: -90,
    created_by: null,
    created_at: '',
    updated_at: '',
  },
  {
    id: BUILTIN_SHOWER_PAN_NEO_CATALOG_ID,
    org_id: '',
    category: 'shower',
    name: 'Neo-angle shower pan 36 x 36',
    brand: null,
    model: 'SHOWER_PAN_NEO_ANGLE',
    width_in: 36,
    depth_in: 36,
    height_in: 4,
    photo_path: null,
    price: null,
    specs: null,
    url: null,
    note: null,
    is_active: true,
    sort_order: -89,
    created_by: null,
    created_at: '',
    updated_at: '',
  },
]
const IN_TO_FT = 1 / 12
const FLOOR_WALL_SNAP_FT = 2.25
const MAX_STORED_TEXT = 140
export const DEFAULT_SHOWER_PAN_CURB_HEIGHT_IN = 6

function cleanString(value: unknown, max = MAX_STORED_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text ? text.slice(0, max) : undefined
}

function cleanFinite(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanPositive(value: unknown): number | undefined {
  const n = cleanFinite(value)
  if (n === undefined || n <= 0) return undefined
  return Math.max(0.01, Math.min(1200, n))
}

function cleanSpecs(value: unknown): CatalogItemSpecs | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: CatalogItemSpecs = {}
  Object.entries(value as Record<string, unknown>).slice(0, 80).forEach(([key, rawValue]) => {
    const cleanKey = key.trim().slice(0, MAX_STORED_TEXT)
    if (!cleanKey) return
    if (rawValue == null) return
    const cleanValue = String(rawValue).trim().slice(0, 400)
    out[cleanKey] = cleanValue
  })
  return Object.keys(out).length > 0 ? out : undefined
}

function specEntries(specs: unknown): Array<{ key: string; value: string }> {
  const clean = cleanSpecs(specs)
  if (!clean) return []
  return Object.entries(clean).map(([key, value]) => ({ key, value }))
}

function normalizeSpecKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
}

function parseInchesFromSpecValue(value: unknown): number | undefined {
  const direct = cleanPositive(value)
  if (direct !== undefined) return direct
  if (typeof value !== 'string') return undefined
  const text = value.replace(',', '.')
  const match = text.match(/-?\d+(?:\.\d+)?/)
  if (!match) return undefined
  const n = Number(match[0])
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (/\b(mm|мм)\b/i.test(text)) return cleanPositive(n / 25.4)
  if (/\b(cm|см)\b/i.test(text)) return cleanPositive(n / 2.54)
  if (/\b(ft|feet|foot|фут|фута|футов)\b/i.test(text)) return cleanPositive(n * 12)
  return cleanPositive(n)
}

function dimFromSpecKey(key: string): 'widthIn' | 'depthIn' | 'heightIn' | null {
  const k = normalizeSpecKey(key)
  if (/^(w|ш)$/.test(k) || /width|wide|ширина|ancho/.test(k)) return 'widthIn'
  if (/^(d|г)$/.test(k) || /depth|deep|глубина|fondo|profundidad/.test(k)) return 'depthIn'
  if (/^(h|в)$/.test(k) || /height|high|высота|alto/.test(k)) return 'heightIn'
  return null
}

function dimTokenFromText(token: string): 'widthIn' | 'depthIn' | 'heightIn' | null {
  const k = normalizeSpecKey(token)
  if (/^(w|ш)$/.test(k) || /width|шир|ancho/.test(k)) return 'widthIn'
  if (/^(d|г)$/.test(k) || /depth|глуб|fondo|profund/.test(k)) return 'depthIn'
  if (/^(h|в)$/.test(k) || /height|выс|alto/.test(k)) return 'heightIn'
  return null
}

function parseDimensionOrderFromText(text: string): Array<'widthIn' | 'depthIn' | 'heightIn'> | null {
  const tokens = normalizeSpecKey(text)
    .split(/[xх×*/\\|,;]+/i)
    .map((token) => dimTokenFromText(token))
    .filter((token): token is 'widthIn' | 'depthIn' | 'heightIn' => !!token)
  const unique = new Set(tokens)
  return tokens.length >= 2 && unique.size === tokens.length ? tokens : null
}

function parseDimensionNumbers(value: string): number[] {
  return value
    .replace(',', '.')
    .match(/\d+(?:\.\d+)?/g)
    ?.map((part) => Number(part))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 3) ?? []
}

export type CatalogItemResolvedDimensionsIn = {
  widthIn: number
  depthIn: number
  heightIn: number
}

export type CatalogTileSizeIn = {
  tileWIn: number
  tileHIn: number
}

function catalogSpecDimensions(specs: unknown): Partial<CatalogItemResolvedDimensionsIn> {
  const out: Partial<CatalogItemResolvedDimensionsIn> = {}
  specEntries(specs).forEach(({ key, value }) => {
    const directDim = dimFromSpecKey(key)
    if (directDim) {
      const parsed = parseInchesFromSpecValue(value)
      if (parsed !== undefined) out[directDim] = parsed
      return
    }

    const order = parseDimensionOrderFromText(key) ?? parseDimensionOrderFromText(value)
    if (!order || order.length < 2) return
    const numbers = parseDimensionNumbers(value)
    if (numbers.length < order.length) return
    order.forEach((dim, index) => {
      const parsed = cleanPositive(numbers[index])
      if (parsed !== undefined) out[dim] = parsed
    })
  })
  return out
}

export function catalogItemResolvedDimensionsIn(item: Pick<CatalogItem, 'width_in' | 'depth_in' | 'height_in' | 'specs'>): CatalogItemResolvedDimensionsIn | null {
  const specDims = catalogSpecDimensions(item.specs)
  const widthIn = cleanPositive(item.width_in) ?? specDims.widthIn
  const depthIn = cleanPositive(item.depth_in) ?? specDims.depthIn
  const heightIn = cleanPositive(item.height_in) ?? specDims.heightIn
  if (widthIn === undefined || depthIn === undefined || heightIn === undefined) return null
  return { widthIn, depthIn, heightIn }
}

export function catalogTileSizeFromItem(item: Pick<CatalogItem, 'width_in' | 'height_in' | 'specs'>): CatalogTileSizeIn | null {
  const specDims = catalogSpecDimensions(item.specs)
  const tileWIn = cleanPositive(item.width_in) ?? specDims.widthIn
  const tileHIn = cleanPositive(item.height_in) ?? specDims.heightIn
  if (tileWIn === undefined || tileHIn === undefined) return null
  return { tileWIn, tileHIn }
}

export function catalogTileFinishPatch(item: Pick<CatalogItem, 'id' | 'name' | 'width_in' | 'height_in' | 'photo_path' | 'specs'>): Pick<SketchTileFinish, 'tileWIn' | 'tileHIn' | 'catalogItemId' | 'catalogItemName' | 'catalogPhotoPath'> | null {
  const size = catalogTileSizeFromItem(item)
  if (!size) return null
  return {
    tileWIn: size.tileWIn,
    tileHIn: size.tileHIn,
    catalogItemId: item.id,
    catalogItemName: cleanString(item.name) ?? item.id,
    catalogPhotoPath: cleanString(item.photo_path, 600),
  }
}

function cleanCategory(value: unknown): CatalogCategory | undefined {
  return typeof value === 'string' && CATALOG_CATEGORY_SET.has(value) ? (value as CatalogCategory) : undefined
}

function cleanPlacedKind(value: unknown): SketchPlacedCatalogKind | undefined {
  if (value === SKETCH_CATALOG_KIND_TOILET) return SKETCH_CATALOG_KIND_TOILET
  if (value === SKETCH_CATALOG_KIND_SHOWER_PAN) return SKETCH_CATALOG_KIND_SHOWER_PAN
  if (value === SKETCH_CATALOG_KIND_OUTLET) return SKETCH_CATALOG_KIND_OUTLET
  if (value === SKETCH_CATALOG_KIND_SWITCH) return SKETCH_CATALOG_KIND_SWITCH
  if (value === SKETCH_CATALOG_KIND_PIPE) return SKETCH_CATALOG_KIND_PIPE
  if (value === SKETCH_CATALOG_KIND_COLUMN) return SKETCH_CATALOG_KIND_COLUMN
  if (value === SKETCH_CATALOG_KIND_BOX) return SKETCH_CATALOG_KIND_BOX
  if (value === SKETCH_CATALOG_KIND_APPLIANCE) return SKETCH_CATALOG_KIND_APPLIANCE
  if (value === SKETCH_CATALOG_KIND_FURNITURE) return SKETCH_CATALOG_KIND_FURNITURE
  return undefined
}

// APPLIANCES-28: узкие валидаторы типа техники/мебели (allowlist round-trip).
const APPLIANCE_TYPE_SET = new Set<SketchApplianceType>(['range', 'cooktop', 'oven', 'microwave', 'refrigerator', 'dishwasher', 'hood'])
function cleanApplianceType(value: unknown): SketchApplianceType | undefined {
  return typeof value === 'string' && APPLIANCE_TYPE_SET.has(value as SketchApplianceType) ? (value as SketchApplianceType) : undefined
}

const FURNITURE_TYPE_SET = new Set<SketchFurnitureType>(['table-rect', 'table-round', 'chair'])
function cleanFurnitureType(value: unknown): SketchFurnitureType | undefined {
  return typeof value === 'string' && FURNITURE_TYPE_SET.has(value as SketchFurnitureType) ? (value as SketchFurnitureType) : undefined
}

// ELEMENTS-INFRA-26: узкие валидаторы новых инженерных полей (allowlist round-trip).
function cleanElectricalVariant(value: unknown): SketchElectricalVariant | undefined {
  return value === 'single' || value === 'double' ? value : undefined
}

function cleanPipeKind(value: unknown): SketchPipeKind | undefined {
  return value === 'water-h' || value === 'water-v' || value === 'gas' ? value : undefined
}

function cleanColumnShape(value: unknown): SketchColumnShape | undefined {
  return value === 'round' || value === 'square' ? value : undefined
}

function cleanPlacedCabinetLayer(value: unknown): SketchPlacedCabinetLayer | undefined {
  return value === 'base' || value === 'wall' ? value : undefined
}

function cleanHinge(value: unknown): 'L' | 'R' | undefined {
  return value === 'L' || value === 'R' ? value : undefined
}

function cleanShowerPanShape(value: unknown): SketchShowerPanShape | undefined {
  return value === 'neo-angle' || value === 'rect' ? value : undefined
}

function cleanPanFinish(value: unknown): SketchTileFinish | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (raw.kind !== 'tile' && !raw.catalogItemId && !raw.tileCatalogItemId) return undefined
  return normalizeTileSurface({
    ...raw,
    kind: 'tile',
    catalogItemId: raw.catalogItemId ?? raw.tileCatalogItemId,
    catalogItemName: raw.catalogItemName ?? raw.tileCatalogItemName,
    catalogPhotoPath: raw.catalogPhotoPath ?? raw.tileCatalogPhotoPath,
  } as SketchTileFinish)
}

function cleanLayoutWarning(value: unknown): 'overflow' | 'small-filler' | undefined {
  return value === 'overflow' || value === 'small-filler' ? value : undefined
}

function cleanSurface(value: unknown): CatalogPlacementSurface {
  return value === 'wall' || value === 'ceiling' || value === 'floor' ? value : 'floor'
}

function normalizeAngle(value: number): number {
  const full = Math.PI * 2
  const n = Number.isFinite(value) ? value : 0
  return ((n % full) + full) % full
}

export function catalogItemHasExactDims(item: CatalogItem): boolean {
  return catalogItemResolvedDimensionsIn(item) !== null
}

export function isBuiltinToiletCatalogItem(item: Pick<CatalogItem, 'id' | 'model'>): boolean {
  return item.id === BUILTIN_TOILET_CATALOG_ID || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_TOILET
}

export function isBuiltinShowerPanCatalogItem(item: Pick<CatalogItem, 'id' | 'model'>): boolean {
  const model = String(item.model ?? '').toUpperCase()
  return item.id === BUILTIN_SHOWER_PAN_RECT_CATALOG_ID
    || item.id === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID
    || model.startsWith(SKETCH_CATALOG_KIND_SHOWER_PAN)
}

export function isToiletPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return item.kind === SKETCH_CATALOG_KIND_TOILET
    || item.catalogItemId === BUILTIN_TOILET_CATALOG_ID
    || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_TOILET
}

export function isShowerPanPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId' | 'category'>): boolean {
  const model = String(item.model ?? '').toUpperCase()
  return item.kind === SKETCH_CATALOG_KIND_SHOWER_PAN
    || item.catalogItemId === BUILTIN_SHOWER_PAN_RECT_CATALOG_ID
    || item.catalogItemId === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID
    || model.startsWith(SKETCH_CATALOG_KIND_SHOWER_PAN)
    || item.category === 'shower'
}

export function isOutletPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return item.kind === SKETCH_CATALOG_KIND_OUTLET
    || item.catalogItemId === BUILTIN_OUTLET_CATALOG_ID
    || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_OUTLET
}

export function isSwitchPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return item.kind === SKETCH_CATALOG_KIND_SWITCH
    || item.catalogItemId === BUILTIN_SWITCH_CATALOG_ID
    || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_SWITCH
}

export function isElectricalPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return isOutletPlacedCatalogItem(item) || isSwitchPlacedCatalogItem(item)
}

// ELEMENTS-INFRA-26: предикаты новых инженерных классов.
export function isPipePlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return item.kind === SKETCH_CATALOG_KIND_PIPE
    || item.catalogItemId === BUILTIN_PIPE_CATALOG_ID
    || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_PIPE
}

export function isColumnPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return item.kind === SKETCH_CATALOG_KIND_COLUMN
    || item.catalogItemId === BUILTIN_COLUMN_CATALOG_ID
    || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_COLUMN
}

export function isBoxPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return item.kind === SKETCH_CATALOG_KIND_BOX
    || item.catalogItemId === BUILTIN_BOX_CATALOG_ID
    || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_BOX
}

// Напольная преграда (колонна/короб): режет кабинетный ряд, видна на плане и в 3D.
export function isObstaclePlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return isColumnPlacedCatalogItem(item) || isBoxPlacedCatalogItem(item)
}

// Настенный маркер разметки (электрика/подводка): в смету/материалы НЕ идёт, в развёртку — да.
export function isInfraMarkerPlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return isElectricalPlacedCatalogItem(item) || isPipePlacedCatalogItem(item)
}

// APPLIANCES-28: техника (плита/варочная/духовка/СВЧ/холодильник/ПММ/вытяжка). Техника-опора ряда
// (kind=APPLIANCE + applianceType) остаётся полноценным кабинетным элементом (category cabinet) —
// участвует в layoutCabinetRunOnWall/остатке/цепочках; здесь только тег для различимой отрисовки.
export function isAppliancePlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return item.kind === SKETCH_CATALOG_KIND_APPLIANCE
    || item.catalogItemId === BUILTIN_APPLIANCE_CATALOG_ID
    || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_APPLIANCE
}

// Встроенная техника (духовка/СВЧ в пенале — IKEA Integrated in cabinet): настенный маркер, не опора ряда.
export function isBuiltInAppliancePlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId' | 'builtIn'>): boolean {
  return isAppliancePlacedCatalogItem(item) && item.builtIn === true
}

// Мебель (столы/стулья) — напольный объект для компоновки. НЕ в смету/материалы, НЕ режет ряд.
export function isFurniturePlacedCatalogItem(item: Pick<SketchPlacedCatalogItem, 'kind' | 'model' | 'catalogItemId'>): boolean {
  return item.kind === SKETCH_CATALOG_KIND_FURNITURE
    || item.catalogItemId === BUILTIN_FURNITURE_CATALOG_ID
    || String(item.model ?? '').toUpperCase() === SKETCH_CATALOG_KIND_FURNITURE
}

export function showerPanShapeFromCatalogItem(item: Pick<CatalogItem, 'id' | 'model'>): SketchShowerPanShape {
  const model = String(item.model ?? '').toUpperCase()
  return item.id === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID || model.includes('NEO') ? 'neo-angle' : 'rect'
}

export function showerPanShapeFromPlacedItem(item: Pick<SketchPlacedCatalogItem, 'catalogItemId' | 'model' | 'showerPanShape'>): SketchShowerPanShape {
  const clean = cleanShowerPanShape(item.showerPanShape)
  if (clean) return clean
  const model = String(item.model ?? '').toUpperCase()
  return item.catalogItemId === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID || model.includes('NEO') ? 'neo-angle' : 'rect'
}

export function showerPanFootprintPoints(shape: SketchShowerPanShape, widthFt: number, depthFt: number): Array<{ x: number; z: number }> {
  const width = Math.max(0, widthFt)
  const depth = Math.max(0, depthFt)
  if (shape !== 'neo-angle') {
    return [
      { x: -width / 2, z: -depth / 2 },
      { x: width / 2, z: -depth / 2 },
      { x: width / 2, z: depth / 2 },
      { x: -width / 2, z: depth / 2 },
    ]
  }
  const cut = Math.min(width, depth) * 0.38
  return [
    { x: -width / 2, z: -depth / 2 },
    { x: width / 2, z: -depth / 2 },
    { x: width / 2, z: depth / 2 - cut },
    { x: width / 2 - cut, z: depth / 2 },
    { x: -width / 2, z: depth / 2 },
  ]
}

function polygonAreaSqft(points: Array<{ x: number; z: number }>): number {
  if (points.length < 3) return 0
  let sum = 0
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length]
    sum += point.x * next.z - next.x * point.z
  })
  return Math.abs(sum) / 2
}

function polygonPerimeterFt(points: Array<{ x: number; z: number }>): number {
  if (points.length < 2) return 0
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]
    return sum + Math.hypot(next.x - point.x, next.z - point.z)
  }, 0)
}

function showerPanCurbHeightFt(item: Pick<SketchPlacedCatalogItem, 'heightIn'>): number {
  const heightIn = cleanPositive(item.heightIn)
  const curbIn = heightIn === undefined
    ? DEFAULT_SHOWER_PAN_CURB_HEIGHT_IN
    : Math.max(4, Math.min(DEFAULT_SHOWER_PAN_CURB_HEIGHT_IN, heightIn))
  return curbIn * IN_TO_FT
}

export type ShowerPanTileSurfaceStats = {
  floorAreaSqft: number
  sideAreaSqft: number
  areaSqft: number
  perimeterLnft: number
  curbHeightFt: number
}

export function showerPanTileSurfaceStats(item: Pick<SketchPlacedCatalogItem, 'catalogItemId' | 'model' | 'showerPanShape' | 'widthIn' | 'depthIn' | 'heightIn'>): ShowerPanTileSurfaceStats | null {
  const widthIn = cleanPositive(item.widthIn)
  const depthIn = cleanPositive(item.depthIn)
  if (widthIn === undefined || depthIn === undefined) return null
  const points = showerPanFootprintPoints(showerPanShapeFromPlacedItem(item), widthIn * IN_TO_FT, depthIn * IN_TO_FT)
  const floorAreaSqft = polygonAreaSqft(points)
  const perimeterLnft = polygonPerimeterFt(points)
  if (floorAreaSqft <= 0.001 || perimeterLnft <= 0.001) return null
  const curbHeightFt = showerPanCurbHeightFt(item)
  const sideAreaSqft = perimeterLnft * curbHeightFt
  return {
    floorAreaSqft,
    sideAreaSqft,
    areaSqft: floorAreaSqft + sideAreaSqft,
    perimeterLnft,
    curbHeightFt,
  }
}

function isBuiltinSnapshotPlacedItem(item: Pick<SketchPlacedCatalogItem, 'catalogItemId'>): boolean {
  return item.catalogItemId === BUILTIN_TOILET_CATALOG_ID
    || item.catalogItemId === BUILTIN_SHOWER_PAN_RECT_CATALOG_ID
    || item.catalogItemId === BUILTIN_SHOWER_PAN_NEO_CATALOG_ID
    || item.catalogItemId === BUILTIN_OUTLET_CATALOG_ID
    || item.catalogItemId === BUILTIN_SWITCH_CATALOG_ID
    || item.catalogItemId === BUILTIN_PIPE_CATALOG_ID
    || item.catalogItemId === BUILTIN_COLUMN_CATALOG_ID
    || item.catalogItemId === BUILTIN_BOX_CATALOG_ID
    || item.catalogItemId === BUILTIN_APPLIANCE_CATALOG_ID
    || item.catalogItemId === BUILTIN_FURNITURE_CATALOG_ID
    || item.catalogItemId.startsWith('builtin-cabinet:')
}

export function catalogDimsFromItem(item: CatalogItem): CatalogDimsFt | null {
  const dims = catalogItemResolvedDimensionsIn(item)
  if (!dims) return null
  return { widthFt: dims.widthIn * IN_TO_FT, depthFt: dims.depthIn * IN_TO_FT, heightFt: dims.heightIn * IN_TO_FT }
}

export function placedCatalogDims(placed: SketchPlacedCatalogItem): CatalogDimsFt | null {
  const specDims = catalogSpecDimensions(placed.specs)
  const width = cleanPositive(placed.widthIn) ?? specDims.widthIn
  const depth = cleanPositive(placed.depthIn) ?? specDims.depthIn
  const height = cleanPositive(placed.heightIn) ?? specDims.heightIn
  if (width === undefined || depth === undefined || height === undefined) return null
  return { widthFt: width * IN_TO_FT, depthFt: depth * IN_TO_FT, heightFt: height * IN_TO_FT }
}

export function catalogDimsText(widthIn: number, depthIn: number, heightIn: number): string {
  return `${formatInches(widthIn)}×${formatInches(depthIn)}×${formatInches(heightIn)}`
}

export function snapshotCatalogItem(item: CatalogItem): Pick<SketchPlacedCatalogItem, 'catalogItemId' | 'category' | 'name' | 'brand' | 'model' | 'widthIn' | 'depthIn' | 'heightIn' | 'photoPath' | 'specs'> {
  const dims = catalogItemResolvedDimensionsIn(item)
  const specs = cleanSpecs(item.specs)
  return {
    catalogItemId: item.id,
    category: item.category,
    name: item.name,
    brand: item.brand ?? undefined,
    model: item.model ?? undefined,
    widthIn: dims?.widthIn,
    depthIn: dims?.depthIn,
    heightIn: dims?.heightIn,
    photoPath: item.photo_path ?? undefined,
    specs,
  }
}

export function sanitizePlacedCatalogItems(value: unknown): SketchPlacedCatalogItem[] {
  if (!Array.isArray(value)) return []
  return value
    .map((raw): SketchPlacedCatalogItem | null => {
      if (!raw || typeof raw !== 'object') return null
      const item = raw as Record<string, unknown>
      const id = cleanString(item.id, 100)
      const catalogItemId = cleanString(item.catalogItemId, 100)
      const xFt = cleanFinite(item.xFt ?? item.x)
      const yFt = cleanFinite(item.yFt ?? item.y)
      const zFt = cleanFinite(item.zFt ?? item.z)
      if (!id || !catalogItemId || xFt === undefined || yFt === undefined || zFt === undefined) return null
      const placed: SketchPlacedCatalogItem = {
        id,
        catalogItemId,
        xFt,
        yFt,
        zFt,
        rotationY: normalizeAngle(cleanFinite(item.rotationY ?? item.rotation) ?? 0),
        surface: cleanSurface(item.surface),
      }
      const c = cleanFinite(item.c)
      const s = cleanFinite(item.s)
      const t = cleanFinite(item.t)
      if (c !== undefined && Number.isInteger(c) && c >= 0) placed.c = c
      if (s !== undefined && Number.isInteger(s) && s >= 0) placed.s = s
      if (t !== undefined) placed.t = Math.max(0, Math.min(1, t))
      const category = cleanCategory(item.category)
      if (category) placed.category = category
      const modelUpper = String(item.model ?? '').toUpperCase()
      const kind = cleanPlacedKind(item.kind)
        ?? (modelUpper === SKETCH_CATALOG_KIND_TOILET ? SKETCH_CATALOG_KIND_TOILET : undefined)
        ?? (modelUpper.startsWith(SKETCH_CATALOG_KIND_SHOWER_PAN) ? SKETCH_CATALOG_KIND_SHOWER_PAN : undefined)
      if (kind) placed.kind = kind
      const name = cleanString(item.name)
      const brand = cleanString(item.brand)
      const model = cleanString(item.model)
      const code = cleanString(item.code)
      const cabinetPrefix = cleanString(item.cabinetPrefix, 40)
      const wallId = cleanString(item.wallId, 40)
      const layer = cleanPlacedCabinetLayer(item.layer)
      const hinge = cleanHinge(item.hinge)
      const showerPanShape = cleanShowerPanShape(item.showerPanShape ?? item.shower_pan_shape)
      // ELEMENTS-INFRA-26: инженерные подполя (allowlist — иначе срежутся при save/reload).
      const variant = cleanElectricalVariant(item.variant)
      const pipe = cleanPipeKind(item.pipe)
      const column = cleanColumnShape(item.column)
      // APPLIANCES-28: подполя техники/мебели (allowlist — иначе срежутся при save/reload).
      const applianceType = cleanApplianceType(item.applianceType)
      const furnitureType = cleanFurnitureType(item.furnitureType)
      const layoutWarning = cleanLayoutWarning(item.layoutWarning)
      const photoPath = cleanString(item.photoPath, 600)
      const specs = cleanSpecs(item.specs)
      const panFinish = cleanPanFinish(item.panFinish ?? item.pan_finish)
      if (name) placed.name = name
      if (brand) placed.brand = brand
      if (model) placed.model = model
      if (code) placed.code = code
      if (cabinetPrefix) placed.cabinetPrefix = cabinetPrefix
      if (wallId) placed.wallId = wallId
      if (layer) placed.layer = layer
      if (hinge) placed.hinge = hinge
      if (showerPanShape) placed.showerPanShape = showerPanShape
      if (variant) placed.variant = variant
      if (pipe) placed.pipe = pipe
      if (column) placed.column = column
      if (applianceType) placed.applianceType = applianceType
      if (furnitureType) placed.furnitureType = furnitureType
      if (item.builtIn === true) placed.builtIn = true
      if (item.filler === true) placed.filler = true
      // CABINETS-CORNER-FILLERS-24: сохраняем маркер ручного филлера в allowlist, иначе он
      // срежется при save/reload и филлер потеряет позицию в ряду при следующей пересборке.
      if (item.manualFiller === true) placed.manualFiller = true
      if (item.panel === true) placed.panel = true
      if (panFinish) placed.panFinish = panFinish
      if (layoutWarning) placed.layoutWarning = layoutWarning
      if (photoPath) placed.photoPath = photoPath
      if (specs) placed.specs = specs
      const widthIn = cleanPositive(item.widthIn ?? item.width_in)
      const depthIn = cleanPositive(item.depthIn ?? item.depth_in)
      const heightIn = cleanPositive(item.heightIn ?? item.height_in)
      // CABINETS-CORNER-FILLERS-24: ширина филлера ограничена 0..48" (валидация round-trip).
      if (widthIn !== undefined) placed.widthIn = placed.filler ? Math.min(48, widthIn) : widthIn
      if (depthIn !== undefined) placed.depthIn = depthIn
      if (heightIn !== undefined) placed.heightIn = heightIn
      // CABINETS-VERTICAL-22: сохраняем зазор навесного (дюймы). Клампим в разумный диапазон,
      // чтобы старые/битые эскизы не ломали высоту; отсутствие поля = дефолт 18" на чтении.
      const wallGapIn = cleanFinite(item.wallGapIn ?? item.wall_gap_in)
      if (wallGapIn !== undefined) placed.wallGapIn = Math.max(0, Math.min(600, wallGapIn))
      return placed
    })
    .filter((item): item is SketchPlacedCatalogItem => !!item)
}

export function resolvePlacedCatalogItem(placed: SketchPlacedCatalogItem, catalogItem: CatalogItem | null): CatalogResolvedPlacedItem | null {
  const itemDims = catalogItem ? catalogDimsFromItem(catalogItem) : null
  const snapshotDims = placedCatalogDims(placed)
  const dims = itemDims ?? snapshotDims
  if (!dims) return null
  const itemDimsIn = catalogItem ? catalogItemResolvedDimensionsIn(catalogItem) : null
  const placedSpecDims = catalogSpecDimensions(placed.specs)
  const widthIn = itemDimsIn?.widthIn ?? cleanPositive(placed.widthIn) ?? placedSpecDims.widthIn
  const depthIn = itemDimsIn?.depthIn ?? cleanPositive(placed.depthIn) ?? placedSpecDims.depthIn
  const heightIn = itemDimsIn?.heightIn ?? cleanPositive(placed.heightIn) ?? placedSpecDims.heightIn
  if (widthIn == null || depthIn == null || heightIn == null) return null
  return {
    placed,
    catalogItem,
    missingCatalogItem: !catalogItem && !isBuiltinSnapshotPlacedItem(placed),
    category: catalogItem?.category ?? placed.category ?? 'other',
    name: catalogItem?.name ?? placed.name ?? placed.catalogItemId,
    brand: catalogItem?.brand ?? placed.brand ?? null,
    model: catalogItem?.model ?? placed.model ?? null,
    photoPath: catalogItem?.photo_path ?? placed.photoPath ?? null,
    specs: cleanSpecs(catalogItem?.specs) ?? cleanSpecs(placed.specs) ?? null,
    dims,
    widthIn,
    depthIn,
    heightIn,
  }
}

function modelCellFt(model: { cellFt?: number }): number {
  return Number.isFinite(model.cellFt) && (model.cellFt ?? 0) > 0 ? model.cellFt ?? 1 : 1
}

function eachWorldSegment(model: { cellFt?: number; contours: Contour[] }) {
  const cellFt = modelCellFt(model)
  const out: Array<{ c: number; s: number; ax: number; az: number; bx: number; bz: number; len: number }> = []
  model.contours.forEach((contour, c) => {
    for (let s = 0; s < contour.points.length - 1; s++) {
      const a = contour.points[s]
      const b = contour.points[s + 1]
      const ax = a.x * cellFt
      const az = a.y * cellFt
      const bx = b.x * cellFt
      const bz = b.y * cellFt
      out.push({ c, s, ax, az, bx, bz, len: Math.hypot(bx - ax, bz - az) })
    }
    if (contour.closed && contour.points.length >= 3) {
      const a = contour.points[contour.points.length - 1]
      const b = contour.points[0]
      const ax = a.x * cellFt
      const az = a.y * cellFt
      const bx = b.x * cellFt
      const bz = b.y * cellFt
      out.push({ c, s: contour.points.length - 1, ax, az, bx, bz, len: Math.hypot(bx - ax, bz - az) })
    }
  })
  return out.filter((seg) => seg.len > 0.01)
}

export function nearestCatalogWall(model: { cellFt?: number; contours: Contour[] }, point: CatalogWorldPoint): CatalogWallHit | null {
  let best: CatalogWallHit | null = null
  eachWorldSegment(model).forEach((seg) => {
    const dx = seg.bx - seg.ax
    const dz = seg.bz - seg.az
    const len2 = dx * dx + dz * dz
    if (len2 <= 0.001) return
    const t = Math.max(0, Math.min(1, ((point.x - seg.ax) * dx + (point.z - seg.az) * dz) / len2))
    const x = seg.ax + dx * t
    const z = seg.az + dz * t
    const ux = dx / seg.len
    const uz = dz / seg.len
    const nx = -uz
    const nz = ux
    const signed = (point.x - x) * nx + (point.z - z) * nz
    const distanceFt = Math.hypot(point.x - x, point.z - z)
    if (!best || distanceFt < best.distanceFt) {
      const side: 1 | -1 = signed < 0 ? -1 : 1
      best = {
        c: seg.c,
        s: seg.s,
        t,
        x,
        z,
        ux,
        uz,
        nx,
        nz,
        side,
        distanceFt,
        lengthFt: seg.len,
        rotationY: -Math.atan2(uz, ux) + (side < 0 ? Math.PI : 0),
      }
    }
  })
  return best
}

export function placedOnFloor(item: CatalogItem, id: string, point: CatalogWorldPoint, dims: CatalogDimsFt, model: { cellFt?: number; contours: Contour[] }, wallThicknessFt: number, rotationY = 0): SketchPlacedCatalogItem {
  const nearest = nearestCatalogWall(model, point)
  const snapDistance = Math.max(FLOOR_WALL_SNAP_FT, dims.depthFt / 2 + wallThicknessFt + 0.5)
  if (nearest && nearest.distanceFt <= snapDistance) {
    return {
      id,
      ...snapshotCatalogItem(item),
      xFt: nearest.x + nearest.nx * nearest.side * (wallThicknessFt / 2 + dims.depthFt / 2),
      yFt: dims.heightFt / 2,
      zFt: nearest.z + nearest.nz * nearest.side * (wallThicknessFt / 2 + dims.depthFt / 2),
      rotationY: normalizeAngle(nearest.rotationY),
      surface: 'floor',
      c: nearest.c,
      s: nearest.s,
      t: nearest.t,
    }
  }
  return {
    id,
    ...snapshotCatalogItem(item),
    xFt: point.x,
    yFt: dims.heightFt / 2,
    zFt: point.z,
    rotationY: normalizeAngle(rotationY),
    surface: 'floor',
  }
}

function defaultFloorPlacementPoint(model: { cellFt?: number; contours: Contour[] }, dims: CatalogDimsFt): CatalogWorldPoint {
  const cellFt = modelCellFt(model)
  const points = model.contours.flatMap((contour) => contour.points)
  if (points.length === 0) return { x: 0, z: 0 }
  const xs = points.map((point) => point.x * cellFt)
  const zs = points.map((point) => point.y * cellFt)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minZ = Math.min(...zs)
  const maxZ = Math.max(...zs)
  const centerX = (minX + maxX) / 2
  const centerZ = (minZ + maxZ) / 2
  return {
    x: Math.min(centerX, minX + dims.widthFt / 2),
    z: Math.min(centerZ, minZ + dims.depthFt / 2),
  }
}

export function withShowerPanPlacedCatalogMetadata(placed: SketchPlacedCatalogItem, item: Pick<CatalogItem, 'id' | 'model' | 'name'>, name?: string): SketchPlacedCatalogItem {
  const shape = showerPanShapeFromCatalogItem(item)
  return {
    ...placed,
    kind: SKETCH_CATALOG_KIND_SHOWER_PAN,
    category: 'shower',
    name: name ?? cleanString(item.name) ?? (shape === 'neo-angle' ? 'Neo-angle shower pan 36 x 36' : 'Shower pan 60 x 32'),
    model: SKETCH_CATALOG_KIND_SHOWER_PAN,
    showerPanShape: shape,
  }
}

export function createShowerPanPlacedCatalogItem(
  item: CatalogItem,
  id: string,
  model: { cellFt?: number; contours: Contour[] },
  wallThicknessFt: number,
  name?: string,
): SketchPlacedCatalogItem | null {
  if (!isBuiltinShowerPanCatalogItem(item)) return null
  const dims = catalogDimsFromItem(item)
  if (!dims) return null
  const point = defaultFloorPlacementPoint(model, dims)
  return withShowerPanPlacedCatalogMetadata(placedOnFloor(item, id, point, dims, model, wallThicknessFt), item, name)
}

export function placedOnCeiling(item: CatalogItem, id: string, point: CatalogWorldPoint, dims: CatalogDimsFt, roomHeightFt: number, rotationY = 0): SketchPlacedCatalogItem {
  return {
    id,
    ...snapshotCatalogItem(item),
    xFt: point.x,
    yFt: Math.max(dims.heightFt / 2, roomHeightFt - dims.heightFt / 2),
    zFt: point.z,
    rotationY: normalizeAngle(rotationY),
    surface: 'ceiling',
  }
}

export function placedOnWall(item: CatalogItem, id: string, hit: CatalogWallHit, dims: CatalogDimsFt, roomHeightFt: number, wallThicknessFt: number, rotationY = hit.rotationY): SketchPlacedCatalogItem {
  const yFt = Math.max(dims.heightFt / 2, Math.min(roomHeightFt - dims.heightFt / 2, hit.yFt ?? Math.min(roomHeightFt - dims.heightFt / 2, roomHeightFt * 0.68)))
  return {
    id,
    ...snapshotCatalogItem(item),
    xFt: hit.x + hit.nx * hit.side * (wallThicknessFt / 2 + dims.depthFt / 2),
    yFt,
    zFt: hit.z + hit.nz * hit.side * (wallThicknessFt / 2 + dims.depthFt / 2),
    rotationY: normalizeAngle(rotationY),
    surface: 'wall',
    c: hit.c,
    s: hit.s,
    t: hit.t,
  }
}

export function movePlacedOnFloor(placed: SketchPlacedCatalogItem, point: CatalogWorldPoint, dims: CatalogDimsFt, model: { cellFt?: number; contours: Contour[] }, wallThicknessFt: number, rotationY = placed.rotationY): SketchPlacedCatalogItem {
  const nearest = nearestCatalogWall(model, point)
  const snapDistance = Math.max(FLOOR_WALL_SNAP_FT, dims.depthFt / 2 + wallThicknessFt + 0.5)
  if (nearest && nearest.distanceFt <= snapDistance) {
    return {
      ...placed,
      xFt: nearest.x + nearest.nx * nearest.side * (wallThicknessFt / 2 + dims.depthFt / 2),
      yFt: dims.heightFt / 2,
      zFt: nearest.z + nearest.nz * nearest.side * (wallThicknessFt / 2 + dims.depthFt / 2),
      rotationY: normalizeAngle(nearest.rotationY),
      surface: 'floor',
      c: nearest.c,
      s: nearest.s,
      t: nearest.t,
    }
  }
  const next: SketchPlacedCatalogItem = {
    ...placed,
    xFt: point.x,
    yFt: dims.heightFt / 2,
    zFt: point.z,
    rotationY: normalizeAngle(rotationY),
    surface: 'floor',
  }
  delete next.c
  delete next.s
  delete next.t
  return next
}

export function movePlacedOnCeiling(placed: SketchPlacedCatalogItem, point: CatalogWorldPoint, dims: CatalogDimsFt, roomHeightFt: number, rotationY = placed.rotationY): SketchPlacedCatalogItem {
  const next: SketchPlacedCatalogItem = {
    ...placed,
    xFt: point.x,
    yFt: Math.max(dims.heightFt / 2, roomHeightFt - dims.heightFt / 2),
    zFt: point.z,
    rotationY: normalizeAngle(rotationY),
    surface: 'ceiling',
  }
  delete next.c
  delete next.s
  delete next.t
  return next
}

export function movePlacedOnWall(placed: SketchPlacedCatalogItem, hit: CatalogWallHit, dims: CatalogDimsFt, roomHeightFt: number, wallThicknessFt: number, rotationY = hit.rotationY): SketchPlacedCatalogItem {
  const yFt = Math.max(dims.heightFt / 2, Math.min(roomHeightFt - dims.heightFt / 2, hit.yFt ?? Math.min(roomHeightFt - dims.heightFt / 2, roomHeightFt * 0.68)))
  return {
    ...placed,
    xFt: hit.x + hit.nx * hit.side * (wallThicknessFt / 2 + dims.depthFt / 2),
    yFt,
    zFt: hit.z + hit.nz * hit.side * (wallThicknessFt / 2 + dims.depthFt / 2),
    rotationY: normalizeAngle(rotationY),
    surface: 'wall',
    c: hit.c,
    s: hit.s,
    t: hit.t,
  }
}

export function rotatePlacedCatalogItem(placed: SketchPlacedCatalogItem): SketchPlacedCatalogItem {
  return { ...placed, rotationY: normalizeAngle(placed.rotationY + Math.PI / 2) }
}

export function placedCatalogFootprint(placed: SketchPlacedCatalogItem, dims: CatalogDimsFt) {
  const c = Math.cos(placed.rotationY)
  const s = Math.sin(placed.rotationY)
  const width = Math.abs(c) * dims.widthFt + Math.abs(s) * dims.depthFt
  const depth = Math.abs(s) * dims.widthFt + Math.abs(c) * dims.depthFt
  return {
    minX: placed.xFt - width / 2,
    maxX: placed.xFt + width / 2,
    minZ: placed.zFt - depth / 2,
    maxZ: placed.zFt + depth / 2,
    width,
    depth,
  }
}

export function placedCatalogDoesNotFit(placed: SketchPlacedCatalogItem, dims: CatalogDimsFt, bounds: CatalogSceneBounds, roomHeightFt: number, wallLengthFt?: number): boolean {
  if (dims.heightFt > roomHeightFt + 0.001) return true
  if (placed.surface === 'wall') {
    return wallLengthFt !== undefined && dims.widthFt > wallLengthFt + 0.001
  }
  if (dims.widthFt > bounds.width + 0.001 || dims.depthFt > bounds.depth + 0.001) return true
  const footprint = placedCatalogFootprint(placed, dims)
  return footprint.minX < bounds.minX - 0.001 || footprint.maxX > bounds.maxX + 0.001 || footprint.minZ < bounds.minZ - 0.001 || footprint.maxZ > bounds.maxZ + 0.001
}
