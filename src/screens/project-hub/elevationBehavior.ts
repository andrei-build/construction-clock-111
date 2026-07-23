// ELEV-BEHAVIOR-56: чистое ядро поведения развёртки (без React/DOM) — под юнит-тестом.
// Собирает три механики задачи #56 в тестируемые функции:
//   1) миллиметровое движение объектов клавишами (стрелка = 1/8", Shift+стрелка = 1") + числом;
//   2) вход в режим рисования зоны отделки сразу по выбору «Частично»;
//   3) живые размеры обводимого/тянущегося прямоугольника (Ш×В в дюймах + площадь ft²) у курсора.
// version:1 модели не трогаем — здесь только арифметика над числами (футы/дюймы).

// Шаг тонкого движения: обычная стрелка = 1/8 дюйма, Shift+стрелка = 1 дюйм (в футах).
export const NUDGE_FINE_FT = 1 / 96 // 1/8"
export const NUDGE_COARSE_FT = 1 / 12 // 1"

export function nudgeStepFt(shift: boolean): number {
  return shift ? NUDGE_COARSE_FT : NUDGE_FINE_FT
}

export type NudgeVector = { dx: number; dy: number }

// Перевод клавиши-стрелки в вектор сдвига (футы). dy>0 = вверх (к потолку) — под систему координат
// развёртки, где высота растёт вверх. Не-стрелка → null (обработчик не перехватывает клавишу).
export function arrowNudgeFt(key: string, shift: boolean): NudgeVector | null {
  const step = nudgeStepFt(shift)
  switch (key) {
    case 'ArrowLeft':
      return { dx: -step, dy: 0 }
    case 'ArrowRight':
      return { dx: step, dy: 0 }
    case 'ArrowUp':
      return { dx: 0, dy: step }
    case 'ArrowDown':
      return { dx: 0, dy: -step }
    default:
      return null
  }
}

export function isArrowKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
}

// Сдвинуть скалярную координату на шаг и удержать в [min, max] (клэмп границами стены/этажа).
export function nudgeValue(value: number, delta: number, min: number, max: number): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  return Math.max(lo, Math.min(hi, value + delta))
}

// Вход в рисование зоны СРАЗУ по выбору «Частично» (point #1). Отдельная булева, чтобы UI-эффект
// и тест опирались на один и тот же предикат.
export function shouldAutoDrawZone(mode: 'full' | 'partial' | undefined | null): boolean {
  return mode === 'partial'
}

// Живые размеры обводимого прямоугольника: из двух углов (футы) → Ш×В в дюймах + площадь ft².
// Порядок точек не важен (берём модуль). Используется и при drag-рисовании, и при resize за ручки.
export type LiveDrawDims = { widthIn: number; heightIn: number; areaSqft: number }

export function liveDrawDims(a: { x: number; y: number }, b: { x: number; y: number }): LiveDrawDims {
  const widthFt = Math.abs(b.x - a.x)
  const heightFt = Math.abs(b.y - a.y)
  return { widthIn: widthFt * 12, heightIn: heightFt * 12, areaSqft: widthFt * heightFt }
}

// Компактная площадь для подписи (совпадает с логикой плашки зоны): целое при ≥10, иначе 1-2 знака.
export function formatLiveAreaSqft(areaSqft: number): string {
  const area = Math.max(0, Number.isFinite(areaSqft) ? areaSqft : 0)
  if (area >= 10) return `${Math.round(area)}`
  if (area >= 1) return area.toFixed(1).replace(/\.0$/, '')
  return area.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')
}
