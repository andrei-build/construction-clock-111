// WALL-ELEV-READOUTS-53: осмысленные показатели развёртки стены — чистая числовая логика без React/DOM.
// Собирает уже существующие хелперы (finishCoverageRegionsFt / estimateTileLayout / каталог плитки) в
// готовые цифры для плашки: площадь стены, площадь зоны, число плиток, предв. стоимость, листы ГКЛ,
// плюс клэмп зоны при числовом вводе (36×96 / 32×96). version:1 не трогаем — только чтение модели.
import {
  finishCoverageRegionsFt,
  normalizeTileSurface,
  type SketchFinishRegion,
  type SketchSurfaceFinish,
} from './sketchFinishes'
import { estimateTileLayout } from './tileLayout'

// Стандартный лист ГКЛ 4×8 ft = 32 ft². Для «площадь заплатки в листах».
export const DRYWALL_SHEET_SQFT = 32

const FINISH_REGION_MIN_FT = 1 / 96

function positiveFt(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function round2(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
}

// Площадь стены Ш×В (ft²).
export function wallAreaSqft(lengthFt: number, heightFt: number): number {
  return round2(positiveFt(lengthFt) * positiveFt(heightFt))
}

// Число листов ГКЛ, чтобы закрыть площадь (с округлением вверх, без запаса).
export function drywallSheetCount(areaSqft: number): number {
  const area = positiveFt(areaSqft)
  return area > 0 ? Math.ceil(area / DRYWALL_SHEET_SQFT) : 0
}

export type TileZoneEstimate = {
  areaSqft: number
  tileCount: number
  costUsd: number
  hasPrice: boolean
}

// Предв. смета зоны плитки: площадь покрытия (регионы или вся стена при full), реальное число
// плиток по эталонной раскладке (с запасом на подрезку) и стоимость по цене каталога (sqft/piece).
export function tileZoneEstimateForFinish(finish: SketchSurfaceFinish, lengthFt: number, heightFt: number): TileZoneEstimate {
  if (finish.kind !== 'tile') return { areaSqft: 0, tileCount: 0, costUsd: 0, hasPrice: false }
  const tile = normalizeTileSurface(finish)
  const regions = finishCoverageRegionsFt(finish, lengthFt, heightFt)
  let areaSqft = 0
  let tileCount = 0
  regions.forEach((region) => {
    const w = Math.max(0, region.x1Ft - region.x0Ft)
    const h = Math.max(0, region.y1Ft - region.y0Ft)
    if (w <= 0 || h <= 0) return
    areaSqft += w * h
    const est = estimateTileLayout({
      surfaceWidthIn: w * 12,
      surfaceHeightIn: h * 12,
      tileWIn: tile.tileWIn ?? 12,
      tileHIn: tile.tileHIn ?? 24,
      groutIn: tile.groutIn ?? 0,
    })
    tileCount += est.tileCount
  })
  const priceUsd = finish.catalogPriceUsd
  const priceUnit = finish.catalogPriceUnit
  let costUsd = 0
  let hasPrice = false
  if (typeof priceUsd === 'number' && priceUsd > 0 && (priceUnit === 'sqft' || priceUnit === 'piece')) {
    hasPrice = true
    costUsd = priceUnit === 'piece' ? tileCount * priceUsd : areaSqft * priceUsd
  }
  return { areaSqft: round2(areaSqft), tileCount, costUsd: round2(costUsd), hasPrice }
}

// Площадь покрытия отделкой (ft²) — сумма регионов (или вся стена при full).
export function finishAreaSqft(finish: SketchSurfaceFinish, lengthFt: number, heightFt: number): number {
  return round2(
    finishCoverageRegionsFt(finish, lengthFt, heightFt)
      .reduce((sum, region) => sum + Math.max(0, region.x1Ft - region.x0Ft) * Math.max(0, region.y1Ft - region.y0Ft), 0),
  )
}

export type RegionField = 'left' | 'bottom' | 'width' | 'height'

// Клэмп зоны при числовом вводе поля (в футах): держим якорь (x0/y0) и не даём выйти за стену.
// Ввод «36×96» на стене 9×8 ft → ширина клэмпится к оставшемуся месту, зона остаётся внутри стены.
export function applyRegionField(
  region: SketchFinishRegion,
  field: RegionField,
  valueFt: number,
  wallLengthFt: number,
  wallHeightFt: number,
): SketchFinishRegion {
  const lengthFt = positiveFt(wallLengthFt)
  const heightFt = positiveFt(wallHeightFt)
  const value = Number.isFinite(valueFt) ? Math.max(0, valueFt) : 0
  const width = Math.max(FINISH_REGION_MIN_FT, region.x1Ft - region.x0Ft)
  const height = Math.max(FINISH_REGION_MIN_FT, region.y1Ft - region.y0Ft)
  const out: SketchFinishRegion = { ...region }
  if (field === 'left') {
    const x0 = Math.max(0, Math.min(Math.max(0, lengthFt - width), value))
    out.x0Ft = x0
    out.x1Ft = x0 + width
  } else if (field === 'bottom') {
    const y0 = Math.max(0, Math.min(Math.max(0, heightFt - height), value))
    out.y0Ft = y0
    out.y1Ft = y0 + height
  } else if (field === 'width') {
    const nextWidth = Math.max(FINISH_REGION_MIN_FT, Math.min(Math.max(FINISH_REGION_MIN_FT, lengthFt - region.x0Ft), value))
    out.x1Ft = region.x0Ft + nextWidth
  } else {
    const nextHeight = Math.max(FINISH_REGION_MIN_FT, Math.min(Math.max(FINISH_REGION_MIN_FT, heightFt - region.y0Ft), value))
    out.y1Ft = region.y0Ft + nextHeight
  }
  return out
}
