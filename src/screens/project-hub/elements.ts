// ELEMENTS-INFRA-26: чистые пресеты/типы/геометрия инженерной разметки (электрика, сантех-подводки,
// колонны/короба). Это НЕ декор и НЕ материалы — разметка для монтажников, включаемая в развёртку/экспорт.
// Модуль без React/DOM: только данные + функции, чтобы покрывать юнит-тестами (round-trip, обрезка ряда).
import type { SketchColumnShape, SketchElectricalVariant, SketchPipeKind, SketchPlacedCatalogItem } from './sketchCatalog'

const IN_PER_FT = 12

export type InfraElementDims = { widthIn: number; depthIn: number; heightIn: number }

// ── Электрика ─────────────────────────────────────────────────────────────
// Схематичная накладка (footprint на стене) + центр по высоте от пола (AFF).
export const ELECTRICAL_PLATE_HEIGHT_IN = 4.5
export const ELECTRICAL_SINGLE_WIDTH_IN = 3
export const ELECTRICAL_DOUBLE_WIDTH_IN = 5.5
export const OUTLET_DEFAULT_CENTER_IN = 18 // центр розетки 18" от пола
export const SWITCH_DEFAULT_CENTER_IN = 48 // центр выключателя 48" от пола

export function electricalDims(variant: SketchElectricalVariant): InfraElementDims {
  return {
    widthIn: variant === 'double' ? ELECTRICAL_DOUBLE_WIDTH_IN : ELECTRICAL_SINGLE_WIDTH_IN,
    depthIn: 1,
    heightIn: ELECTRICAL_PLATE_HEIGHT_IN,
  }
}

export function electricalDefaultCenterIn(kind: 'outlet' | 'switch'): number {
  return kind === 'switch' ? SWITCH_DEFAULT_CENTER_IN : OUTLET_DEFAULT_CENTER_IN
}

// ── Сантех-подводки ───────────────────────────────────────────────────────
// Схематичные символы труб. floorCenterIn — центр символа по высоте от пола.
export type PipePreset = InfraElementDims & { floorCenterIn: number }

export const PIPE_PRESETS: Record<SketchPipeKind, PipePreset> = {
  'water-h': { widthIn: 14, depthIn: 1, heightIn: 3, floorCenterIn: 14 },
  'water-v': { widthIn: 3, depthIn: 1, heightIn: 26, floorCenterIn: 20 },
  gas: { widthIn: 14, depthIn: 1, heightIn: 3, floorCenterIn: 26 },
}

export function pipeDims(pipe: SketchPipeKind): InfraElementDims {
  const preset = PIPE_PRESETS[pipe]
  return { widthIn: preset.widthIn, depthIn: preset.depthIn, heightIn: preset.heightIn }
}

export function pipeDefaultCenterIn(pipe: SketchPipeKind): number {
  return PIPE_PRESETS[pipe].floorCenterIn
}

// ── Колонны / короба (напольные преграды, режут кабинетный ряд) ────────────
export const COLUMN_ROUND_DEFAULT: InfraElementDims = { widthIn: 12, depthIn: 12, heightIn: 96 }
export const COLUMN_SQUARE_DEFAULT: InfraElementDims = { widthIn: 12, depthIn: 12, heightIn: 96 }
export const BOX_DEFAULT: InfraElementDims = { widthIn: 24, depthIn: 18, heightIn: 36 }

export function columnDims(shape: SketchColumnShape): InfraElementDims {
  return shape === 'round' ? { ...COLUMN_ROUND_DEFAULT } : { ...COLUMN_SQUARE_DEFAULT }
}

// Центр-по-высоте (yFt) для напольного объекта, стоящего на полу.
export function floorObjectCenterIn(heightIn: number): number {
  return Math.max(0, heightIn) / 2
}

// Высота центра символа от пола (для живого размера «от пола» на развёртке).
export function infraCenterFloorIn(placed: Pick<SketchPlacedCatalogItem, 'yFt'>): number {
  const y = Number(placed.yFt)
  return Number.isFinite(y) ? Math.max(0, y * IN_PER_FT) : 0
}

// ── Геометрия преграды на стене ────────────────────────────────────────────
export type InfraObstacleInterval = { startIn: number; endIn: number }

type WallWorld = { ax: number; az: number; bx: number; bz: number } // концы стены в футах (world)
type ObstacleWorld = { xFt: number; zFt: number; widthFt: number; depthFt: number; rotationY: number }

function obstacleFootprintCorners(o: ObstacleWorld): Array<{ x: number; z: number }> {
  const cos = Math.cos(o.rotationY)
  const sin = Math.sin(o.rotationY)
  const hw = o.widthFt / 2
  const hd = o.depthFt / 2
  // локальные оси прямоугольника: side = (cos, sin), forward = (-sin, cos)
  return [
    { x: o.xFt - cos * hw + sin * hd, z: o.zFt - sin * hw - cos * hd },
    { x: o.xFt + cos * hw + sin * hd, z: o.zFt + sin * hw - cos * hd },
    { x: o.xFt + cos * hw - sin * hd, z: o.zFt + sin * hw + cos * hd },
    { x: o.xFt - cos * hw - sin * hd, z: o.zFt - sin * hw + cos * hd },
  ]
}

// Проекция footprint преграды на ось стены → заблокированный интервал [startIn, endIn] в дюймах
// от начала стены. Возвращает null, если преграда дальше maxPerpFt от линии стены (не задевает ряд)
// или проекция не попадает на стену. Единый источник «колонна режет ряд».
export function columnObstacleIntervalOnWall(
  wall: WallWorld,
  obstacle: ObstacleWorld,
  opts: { maxPerpFt?: number } = {},
): InfraObstacleInterval | null {
  const dx = wall.bx - wall.ax
  const dz = wall.bz - wall.az
  const lengthFt = Math.hypot(dx, dz)
  if (lengthFt <= 0.001) return null
  const ux = dx / lengthFt
  const uz = dz / lengthFt
  const nx = -uz
  const nz = ux
  // перпендикулярное расстояние центра преграды до линии стены
  const perp = Math.abs((obstacle.xFt - wall.ax) * nx + (obstacle.zFt - wall.az) * nz)
  const reach = obstacle.depthFt / 2 + obstacle.widthFt / 2
  const maxPerpFt = opts.maxPerpFt ?? 2.5
  if (perp > maxPerpFt + reach) return null
  const corners = obstacleFootprintCorners(obstacle)
  const alongs = corners.map((c) => (c.x - wall.ax) * ux + (c.z - wall.az) * uz)
  const lengthIn = lengthFt * IN_PER_FT
  const startIn = Math.max(0, Math.min(lengthIn, Math.min(...alongs) * IN_PER_FT))
  const endIn = Math.max(0, Math.min(lengthIn, Math.max(...alongs) * IN_PER_FT))
  if (endIn - startIn <= 0.05) return null
  return { startIn, endIn }
}

// Свободные пробеги вдоль стены = [0, wallLengthIn] минус объединённые интервалы преград.
// Кабинетный ряд пакуется по этим пробегам (шкаф не проходит сквозь колонну).
export function freeRunsAlongWall(wallLengthIn: number, obstacles: InfraObstacleInterval[]): InfraObstacleInterval[] {
  const total = Math.max(0, wallLengthIn)
  if (total <= 0) return []
  const clipped = obstacles
    .map((o) => ({ startIn: Math.max(0, Math.min(total, o.startIn)), endIn: Math.max(0, Math.min(total, o.endIn)) }))
    .filter((o) => o.endIn - o.startIn > 0.05)
    .sort((a, b) => a.startIn - b.startIn)
  if (clipped.length === 0) return [{ startIn: 0, endIn: total }]
  // объединяем перекрывающиеся преграды
  const merged: InfraObstacleInterval[] = []
  clipped.forEach((o) => {
    const last = merged[merged.length - 1]
    if (last && o.startIn <= last.endIn + 0.05) {
      last.endIn = Math.max(last.endIn, o.endIn)
    } else {
      merged.push({ ...o })
    }
  })
  const runs: InfraObstacleInterval[] = []
  let cursor = 0
  merged.forEach((o) => {
    if (o.startIn - cursor > 0.05) runs.push({ startIn: cursor, endIn: o.startIn })
    cursor = Math.max(cursor, o.endIn)
  })
  if (total - cursor > 0.05) runs.push({ startIn: cursor, endIn: total })
  return runs
}
