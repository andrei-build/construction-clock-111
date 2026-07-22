// SWEEP-FIX-34: чистые правила выбора вида/инструмента по режиму рейла «Эскиз».
// Вынесено из SketchTab, чтобы юнит-тесты фиксировали: режим «Электрика» (light) НЕ прыгает в 3D.

export type SketchModeName = 'wall' | 'opening' | 'finish' | 'cabinet' | 'light' | 'measure' | 'markup'

// SWEEP-FIX-35: НИ ОДИН режим рейла не открывает эскиз в 3D автоматически — все остаются на 2D-плане.
// 'finish' (Отделка) теперь тоже 2D: стену выбирают кликом на плане, палитра отделки применяется к ней.
// 'light' (Электрика, #34) и все прочие режимы также 2D; 3D доступен только по явной кнопке «3D вид».
export function sketchModeViewMode(_mode: SketchModeName): '2d' | '3d' {
  return '2d'
}

// Инструменты 2D-панели инфраструктуры режима «Электрика»
// (розетки/выключатели/подводки/колонны/встроенная техника/мебель).
export const INFRA_TOOLS = [
  'outlet',
  'switch',
  'pipe-water-h',
  'pipe-water-v',
  'pipe-gas',
  'column-round',
  'column-square',
  'box',
  'appliance-oven',
  'appliance-microwave',
  'furniture-table-rect',
  'furniture-table-round',
  'furniture-chair',
] as const

// Инструмент по умолчанию при входе в «Электрику», если текущий не инфраструктурный.
export const DEFAULT_INFRA_TOOL = 'outlet'

export function isInfraTool(tool: string): boolean {
  return (INFRA_TOOLS as readonly string[]).includes(tool)
}

// Инструмент, с которым режим «Электрика» становится активным: сохраняем текущий инфра-инструмент,
// иначе ставим розетку — чтобы клик по плану ставил инфраструктуру, а не стену.
export function infraToolForLight(currentTool: string): string {
  return isInfraTool(currentTool) ? currentTool : DEFAULT_INFRA_TOOL
}
