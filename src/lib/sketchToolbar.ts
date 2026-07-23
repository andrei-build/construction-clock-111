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

// SKETCH-STYLE-PASS-57: размеры тёмной плашки-подложки под чертёжную (моноширинную) подпись размера.
// Моноширинный шрифт даёт детерминированную ширину: N глифов * advance + горизонтальные поля,
// поэтому подложку можно нарисовать без измерения DOM (одинаково на плане/развёртке/3D).
export const DIM_PLATE_GLYPH_EM = 0.6 // средний advance моноширинного глифа в долях кегля
export const DIM_PLATE_PAD_EM = 0.72 // суммарные горизонтальные поля (лево+право)
export const DIM_PLATE_HEIGHT_EM = 1.62 // высота плашки в долях кегля

// Ширина плашки в долях кегля (em) под техническую подпись размера. Пустая строка → только поля.
export function dimPlateWidthEm(text: string): number {
  const glyphs = Math.max(0, [...String(text ?? '')].length)
  return glyphs * DIM_PLATE_GLYPH_EM + DIM_PLATE_PAD_EM
}

// Радиус скругления плашки (в тех же единицах, что кегль): лёгкое скругление, но всегда ≤ ceiling.
// Гарантирует правило #57 «radius ≤ 8» независимо от масштаба (ceiling передаётся в единицах кегля).
export function dimPlateRadius(fontSize: number, ceiling: number): number {
  const soft = Math.max(0, fontSize) * 0.34
  return Math.min(soft, Math.max(0, ceiling))
}
