// SKETCH-TOPBAR-CONSOLIDATE-52: чистое ядро раскладки верхней строки эскиза (2D/3D).
// Без React/DOM — только решения «что показывать» и «какой значок у режима рейла»,
// чтобы дедуп видов и набор иконок были детерминированы и покрыты юнит-тестами.

// Режимы левого рейла эскиза (совпадают со SketchMode в SketchTab).
export type SketchRailMode =
  | 'wall'
  | 'opening'
  | 'finish'
  | 'cabinet'
  | 'light'
  | 'measure'
  | 'markup'

// Идентификатор узнаваемого значка (SVG рисуется в SketchTab по этому id).
export type SketchRailIconId = SketchRailMode

// Каждому режиму — свой понятный значок (стена/проём/отделка/кабинеты/свет/рулетка/разметка).
export const SKETCH_RAIL_ICON_BY_MODE: Record<SketchRailMode, SketchRailIconId> = {
  wall: 'wall',
  opening: 'opening',
  finish: 'finish',
  cabinet: 'cabinet',
  light: 'light',
  measure: 'measure',
  markup: 'markup',
}

// Значок режима с безопасным фолбэком (незнакомый режим → 'wall').
export function railIconId(mode: string): SketchRailIconId {
  return (SKETCH_RAIL_ICON_BY_MODE as Record<string, SketchRailIconId>)[mode] ?? 'wall'
}

export interface Sketch3DStripContext {
  // true — 3D развёрнут на весь экран (общая верхняя строка приложения скрыта).
  fullscreenActive: boolean
}

// Виды (Вписать/Сверху/Угол/Внутри) живут в ЕДИНОЙ верхней строке приложения (сегмент-переключатель).
// В обычном режиме дублировать их в 3D-строке НЕ нужно; в полноэкранном режиме верхней строки нет,
// поэтому виды показываем прямо в 3D-строке. Это правило устраняет «островной» дубль видов из #52.
export function show3DViewPresetsInStrip(ctx: Sketch3DStripContext): boolean {
  return ctx.fullscreenActive
}

// «На весь экран» обязана быть видимой во всех режимах эскиза (2D / 3D / развёртка) — п.5 контракта.
export function isFullscreenControlAlwaysVisible(): boolean {
  return true
}
