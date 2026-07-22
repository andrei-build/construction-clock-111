// PIN-LAYER-38: чистая логика слоя пинов поверх встроенного просмотрщика (FileViewer, #37).
// Вынесено сюда, чтобы покрыть юнит-тестами без DOM/React/supabase (vitest node-env) и
// переиспользовать в api-обёртке (src/lib/api/estimate.ts) и в UI (FileViewer.tsx).
// Никаких браузерных/сетевых зависимостей здесь быть не должно.

export type PinSeverity = 'green' | 'yellow' | 'red'
export type PinKind = 'estimate' | 'node' | 'note'

// Позиция пина в ДОЛЯХ области страницы (0..1 по ширине/высоте) — чтобы кружок ехал вместе с
// зумом/паном/масштабом просмотрщика. w/h опциональны (запас под прямоугольник), кружок ставим по x,y.
export interface PlanPinBbox {
  x: number
  y: number
  w?: number
  h?: number
}

export const PIN_SEVERITIES: PinSeverity[] = ['green', 'yellow', 'red']
export const PIN_KINDS: PinKind[] = ['estimate', 'node', 'note']

const SEVERITY_COLORS: Record<PinSeverity, string> = {
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
}

const SEVERITY_EMOJI: Record<PinSeverity, string> = {
  green: '🟢',
  yellow: '🟡',
  red: '🔴',
}

export function isSeverity(v: unknown): v is PinSeverity {
  return v === 'green' || v === 'yellow' || v === 'red'
}

export function isKind(v: unknown): v is PinKind {
  return v === 'estimate' || v === 'node' || v === 'note'
}

// Дефолт — 'green' (как в схеме БД), любой мусор нормализуем к нему.
export function normalizeSeverity(v: unknown): PinSeverity {
  return isSeverity(v) ? v : 'green'
}

// Дефолт — 'estimate' (как в схеме БД).
export function normalizeKind(v: unknown): PinKind {
  return isKind(v) ? v : 'estimate'
}

// CSS-цвет кружка по серьёзности (неизвестное → зелёный, чтобы слой никогда не падал/не пустел).
export function pinColor(severity: unknown): string {
  return SEVERITY_COLORS[normalizeSeverity(severity)]
}

// Эмодзи-кружок для формы/бейджа.
export function pinEmoji(severity: unknown): string {
  return SEVERITY_EMOJI[normalizeSeverity(severity)]
}

// Кламп одной координаты в [0..1]; NaN/Infinity → 0 (безопасный левый-верхний угол).
function clamp01(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

// Нормализуем произвольный jsonb-bbox из БД (или ввод) к {x,y} в долях 0..1, w/h — если заданы.
// Пустой/битый bbox → {x:0,y:0}, слой не падает.
export function clampBbox(raw: unknown): PlanPinBbox {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: PlanPinBbox = { x: clamp01(src.x), y: clamp01(src.y) }
  if (src.w != null) out.w = clamp01(src.w)
  if (src.h != null) out.h = clamp01(src.h)
  return out
}

// Пиксельный клик по области страницы → доли 0..1. Ширина/высота ≤0 → доля 0 (без деления на ноль).
export function pointToBbox(offsetX: number, offsetY: number, width: number, height: number): PlanPinBbox {
  const x = width > 0 ? offsetX / width : 0
  const y = height > 0 ? offsetY / height : 0
  return clampBbox({ x, y })
}

// CSS-процент для абсолютного позиционирования кружка (left/top) из доли 0..1.
export function pinPercent(fraction: number): string {
  return `${clamp01(fraction) * 100}%`
}
