// APPLIANCES-28: чистые пресеты/типы кухонной техники (габариты Ш×Г×В, стандарты US) и простой
// мебели (столы/стулья) для компоновки. Модуль без React/DOM — только данные + функции, чтобы
// покрывать юнит-тестами (round-trip, дефолтные ширины, тип↔префикс). По образцу elements.ts (#26).
//
// Техника, стоящая в кабинетном ряду (плита/варочная/холодильник/ПММ/вытяжка), выражается КОДАМИ
// кабинетов и раскладывается ТЕМ ЖЕ layoutCabinetRunOnWall (#22-#24). Здесь — пресеты + маппинг
// префикс↔тип для тегирования placed-объекта kind=APPLIANCE (различимая иконка на развёртке/3D).
// Встроенная техника (духовка/СВЧ в пенале — IKEA Integrated in cabinet) ставится настенным маркером.
import type { SketchApplianceType, SketchFurnitureType } from './sketchCatalog'

export type ApplianceDims = { widthIn: number; depthIn: number; heightIn: number }

export type AppliancePreset = ApplianceDims & {
  type: SketchApplianceType
  // ширины-пресеты (первая = дефолт при быстрой постановке)
  widthsIn: readonly number[]
  // как встаёт в ряд: base (плита/варочная/холодильник/ПММ), wall (вытяжка). Встроенные — маркер.
  layer: 'base' | 'wall'
  // духовка/СВЧ — встроены в высокий кабинет (пенал), ставятся как настенный маркер (не опора ряда).
  builtIn?: boolean
  // центр по высоте от пола (дюймы) для встроенного маркера (духовка ~30", СВЧ ~66").
  builtInCenterIn?: number
  // префикс кабинетного кода для техники-опоры ряда (null у встроенных маркеров).
  cabinetPrefix: string | null
}

// Стандартные ширины (дюймы) — первая = дефолт.
const RANGE_WIDTHS_IN = [30, 36, 48] as const
const COOKTOP_WIDTHS_IN = [30, 36] as const
const REFRIGERATOR_WIDTHS_IN = [33, 36, 30, 42, 48] as const
const DISHWASHER_WIDTHS_IN = [24, 18] as const
const HOOD_WIDTHS_IN = [30, 36, 24, 42, 48] as const
const OVEN_WIDTHS_IN = [30, 27, 24] as const
const MICROWAVE_WIDTHS_IN = [30, 27, 24] as const

export const APPLIANCE_PRESETS: Record<SketchApplianceType, AppliancePreset> = {
  // Плита (варочная+духовой шкаф, отдельностоящая): опора ряда, высота столешницы.
  range: { type: 'range', widthsIn: RANGE_WIDTHS_IN, widthIn: 30, depthIn: 25, heightIn: 36, layer: 'base', cabinetPrefix: 'RANGE' },
  // Варочная панель: врезается в базовый шкаф, опора ряда по ширине.
  cooktop: { type: 'cooktop', widthsIn: COOKTOP_WIDTHS_IN, widthIn: 30, depthIn: 22, heightIn: 36, layer: 'base', cabinetPrefix: 'COOK' },
  // Холодильник: свой габарит 33/36, полная высота.
  refrigerator: { type: 'refrigerator', widthsIn: REFRIGERATOR_WIDTHS_IN, widthIn: 33, depthIn: 30, heightIn: 72, layer: 'base', cabinetPrefix: 'REF' },
  // Посудомойка: занимает 24" в ряду.
  dishwasher: { type: 'dishwasher', widthsIn: DISHWASHER_WIDTHS_IN, widthIn: 24, depthIn: 24, heightIn: 34.5, layer: 'base', cabinetPrefix: 'DW' },
  // Вытяжка: навесная над плитой.
  hood: { type: 'hood', widthsIn: HOOD_WIDTHS_IN, widthIn: 30, depthIn: 18, heightIn: 18, layer: 'wall', cabinetPrefix: 'HOOD' },
  // Духовой шкаф встроенный (в пенал): настенный маркер ~30" от пола.
  oven: { type: 'oven', widthsIn: OVEN_WIDTHS_IN, widthIn: 30, depthIn: 24, heightIn: 29, layer: 'wall', builtIn: true, builtInCenterIn: 30, cabinetPrefix: null },
  // СВЧ встроенная (в пенал над духовкой): настенный маркер ~66" от пола.
  microwave: { type: 'microwave', widthsIn: MICROWAVE_WIDTHS_IN, widthIn: 30, depthIn: 16, heightIn: 18, layer: 'wall', builtIn: true, builtInCenterIn: 66, cabinetPrefix: null },
}

export const APPLIANCE_TYPES = Object.keys(APPLIANCE_PRESETS) as SketchApplianceType[]

// Техника-опоры ряда (не встроенные маркеры) — по образцу IKEA «в ряду».
export const ROW_APPLIANCE_TYPES = APPLIANCE_TYPES.filter((type) => !APPLIANCE_PRESETS[type].builtIn)
// Встроенная техника (духовка/СВЧ в пенале).
export const BUILT_IN_APPLIANCE_TYPES = APPLIANCE_TYPES.filter((type) => APPLIANCE_PRESETS[type].builtIn)

export function applianceDefaultWidthIn(type: SketchApplianceType): number {
  return APPLIANCE_PRESETS[type].widthsIn[0]
}

// Габарит техники: ширина из аргумента (или дефолт), глубина/высота — из пресета.
export function applianceDims(type: SketchApplianceType, widthIn = applianceDefaultWidthIn(type)): ApplianceDims {
  const preset = APPLIANCE_PRESETS[type]
  const w = Number.isFinite(widthIn) && widthIn > 0 ? widthIn : preset.widthIn
  return { widthIn: w, depthIn: preset.depthIn, heightIn: preset.heightIn }
}

// Центр по высоте от пола (дюймы) для встроенного маркера (духовка/СВЧ).
export function applianceBuiltInCenterIn(type: SketchApplianceType): number {
  return APPLIANCE_PRESETS[type].builtInCenterIn ?? 30
}

export function isBuiltInApplianceType(type: SketchApplianceType): boolean {
  return APPLIANCE_PRESETS[type].builtIn === true
}

// Единый источник: префикс кабинетного кода → тип техники (тегирование ряда kind=APPLIANCE).
export function applianceTypeFromCabinetPrefix(prefix: string): SketchApplianceType | null {
  switch (prefix) {
    case 'RANGE': return 'range'
    case 'COOK': return 'cooktop'
    case 'REF': return 'refrigerator'
    case 'DW': return 'dishwasher'
    case 'HOOD': return 'hood'
    default: return null
  }
}

// Обратный маппинг: тип техники-опоры → префикс кабинетного кода (null у встроенных).
export function applianceCabinetPrefix(type: SketchApplianceType): string | null {
  return APPLIANCE_PRESETS[type].cabinetPrefix
}

// Код кабинета для техники-опоры ряда (напр. DW24, REF33) — встаёт в тот же layoutCabinetRunOnWall.
export function applianceCabinetCode(type: SketchApplianceType, widthIn = applianceDefaultWidthIn(type)): string | null {
  const prefix = applianceCabinetPrefix(type)
  if (!prefix) return null
  const w = Number.isFinite(widthIn) && widthIn > 0 ? Math.round(widthIn) : applianceDefaultWidthIn(type)
  return `${prefix}${w}`
}

// ── Мебель (столы/стулья) — напольные объекты на плане/3D для компоновки (не в смету) ──
export type FurniturePreset = ApplianceDims & { round?: boolean }

export const FURNITURE_PRESETS: Record<SketchFurnitureType, FurniturePreset> = {
  'table-rect': { widthIn: 48, depthIn: 30, heightIn: 30 },
  'table-round': { widthIn: 42, depthIn: 42, heightIn: 30, round: true },
  chair: { widthIn: 18, depthIn: 18, heightIn: 34 },
}

export const FURNITURE_TYPES = Object.keys(FURNITURE_PRESETS) as SketchFurnitureType[]

export function furnitureDims(type: SketchFurnitureType): ApplianceDims {
  const p = FURNITURE_PRESETS[type]
  return { widthIn: p.widthIn, depthIn: p.depthIn, heightIn: p.heightIn }
}

export function isRoundFurnitureType(type: SketchFurnitureType): boolean {
  return FURNITURE_PRESETS[type].round === true
}
