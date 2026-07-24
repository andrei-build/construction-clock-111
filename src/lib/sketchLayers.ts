// BLUEPRINT-LAYERS-59: чистое ядро слоя «существующее / новое / демонтаж» для эскиза (version:1).
// Без React/DOM/сайд-эффектов. Слой — ОПЦИОНАЛЬНОЕ свойство КЛАССИФИКАЦИИ/ОТРИСОВКИ контура
// (комната/стена), ровно как wallThickness из BLUEPRINT-WALLS-58: модель остаётся centerline,
// слой не меняет геометрию. Здесь только: валидация значения (sanitize-allowlist), дефолт для
// старых эскизов без поля ('new' → обычная чистая заливка), выбор визуального паттерна и
// видимость слоя под тогглом «скрыть существующее».
//
// Персист-контракт: sanitizeLayer прошивается в ТЕ ЖЕ sanitize-пути, что и sanitizeWallThickness
// (sanitizeSketchContours при load+save + sanitizeRoomTemplate). Неизвестное/битое значение →
// undefined → поле опускается → рендер берёт DEFAULT_SKETCH_LAYER. version НЕ меняется.

export type SketchLayer = 'existing' | 'new' | 'demolition'

export const SKETCH_LAYERS: readonly SketchLayer[] = ['existing', 'new', 'demolition']

// Старый эскиз без поля (и явное 'new') рисуется как раньше — чистая заливка, сплошной контур.
export const DEFAULT_SKETCH_LAYER: SketchLayer = 'new'

// Allowlist слоёв: строго одно из трёх значений, иначе undefined (поле опускается при save).
export function sanitizeLayer(value: unknown): SketchLayer | undefined {
  return value === 'existing' || value === 'new' || value === 'demolition' ? value : undefined
}

// Слой для отрисовки: undefined/битое → дефолт 'new'. Никогда не бросает.
export function resolveLayer(value: unknown): SketchLayer {
  return sanitizeLayer(value) ?? DEFAULT_SKETCH_LAYER
}

// Тоггл «скрыть существующее» гасит ТОЛЬКО слой 'existing' (видно «что строим»). Новое и
// демонтаж остаются. Прочие слои всегда видимы.
export function isLayerVisible(value: unknown, hideExisting: boolean): boolean {
  return !(hideExisting && resolveLayer(value) === 'existing')
}

// Тип заливки контура на плане: диагональная штриховка (существующее), чистая (новое),
// демонтаж (крест-накрест + пунктирный контур).
export type LayerFill = 'hatch' | 'plain' | 'demolition'

export function layerFill(value: unknown): LayerFill {
  const layer = resolveLayer(value)
  if (layer === 'existing') return 'hatch'
  if (layer === 'demolition') return 'demolition'
  return 'plain'
}

// Пунктирный контур — только у демонтажа.
export function layerIsDashed(value: unknown): boolean {
  return resolveLayer(value) === 'demolition'
}

// id SVG-паттернов заливки (см. <defs> в SketchTab / легенда). Чистый слой заливки не имеет.
export const LAYER_HATCH_PATTERN_ID = 'hub-sketch-layer-hatch'
export const LAYER_DEMO_PATTERN_ID = 'hub-sketch-layer-demo'

// Ссылка на паттерн заливки контура (`url(#..)`) либо null для чистой заливки ('new').
export function layerFillPatternId(value: unknown): string | null {
  const fill = layerFill(value)
  if (fill === 'hatch') return LAYER_HATCH_PATTERN_ID
  if (fill === 'demolition') return LAYER_DEMO_PATTERN_ID
  return null
}

// i18n-ключи подписей слоёв (значения строк живут в src/lib/i18n.tsx, ru/en/es).
export const LAYER_LABEL_KEYS: Record<SketchLayer, string> = {
  existing: 'hub_sketch_layer_existing',
  new: 'hub_sketch_layer_new',
  demolition: 'hub_sketch_layer_demolition',
}
