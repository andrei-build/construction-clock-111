// FIN-PRICEBOOK-36 (серия PLAN-TO-ESTIMATE, 4/4): чистая логика секции «Прайс-бук» в Финансах.
// 0 DOM / 0 React / 0 supabase — покрываем юнит-тестами (vitest node-env) и переиспользуем в UI
// (FinanceTab.tsx). Никаких браузерных/сетевых зависимостей здесь быть не должно (как estimateCore.ts /
// planPinCore.ts). Давность цены считаем от catalog_items.price_updated_at; nowIso передаём ЯВНО, чтобы
// тесты были детерминированы (никакого Date.now() внутри ядра).

const MS_PER_DAY = 86_400_000

// Порог «устаревшей» цены по умолчанию (дни). Спека #36 — 90 дней.
export const PRICE_STALE_THRESHOLD_DAYS = 90

// Давность цены в целых днях (пол — floor). null, если дата пуста/битая. Может быть отрицательной,
// если price_updated_at в будущем (свежее «сейчас») — вызывающий трактует это как свежую цену.
export function priceAgeDays(priceUpdatedAt: string | null | undefined, nowIso: string): number | null {
  if (!priceUpdatedAt) return null
  const then = new Date(priceUpdatedAt).getTime()
  const now = new Date(nowIso).getTime()
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null
  return Math.floor((now - then) / MS_PER_DAY)
}

// Цена устарела, если давность неизвестна (нет даты) ИЛИ ≥ порога. Ровно порог считается устаревшей.
export function isPriceStale(
  priceUpdatedAt: string | null | undefined,
  nowIso: string,
  thresholdDays: number = PRICE_STALE_THRESHOLD_DAYS,
): boolean {
  const age = priceAgeDays(priceUpdatedAt, nowIso)
  if (age === null) return true
  return age >= thresholdDays
}

// Три состояния свежести цены: 'unknown' (даты нет), 'stale' (старше порога), 'fresh' (свежая).
// UI красит unknown+stale жёлтым, fresh — зелёным/нейтральным.
export type PriceFreshness = 'unknown' | 'stale' | 'fresh'

export function priceFreshness(
  priceUpdatedAt: string | null | undefined,
  nowIso: string,
  thresholdDays: number = PRICE_STALE_THRESHOLD_DAYS,
): PriceFreshness {
  const age = priceAgeDays(priceUpdatedAt, nowIso)
  if (age === null) return 'unknown'
  return age >= thresholdDays ? 'stale' : 'fresh'
}

// Тон бейджа: устаревшая/неизвестная → 'amber', свежая → 'green' (существующие классы .badge.*).
export function staleBadgeTone(freshness: PriceFreshness): 'amber' | 'green' {
  return freshness === 'fresh' ? 'green' : 'amber'
}

// Форматирование цены в долларах: '1 234,56 $' (группы разрядов неразрывным пробелом, дробь запятой),
// либо '—' для null/невалидного. Формируем вручную (без Intl), чтобы результат не зависел от локали среды.
export function formatUsd(price: number | null | undefined): string {
  if (price == null) return '—'
  const n = Number(price)
  if (!Number.isFinite(n)) return '—'
  const neg = n < 0
  const [intPart, decPart] = Math.abs(n).toFixed(2).split('.')
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${neg ? '-' : ''}${grouped},${decPart} $`
}

// Разбор пользовательского ввода цены в число ≥0, либо null (пусто/мусор/отрицательное). Принимаем и
// запятую как десятичный разделитель, и пробелы-разделители разрядов — как их вводят вручную.
export function parsePriceInput(raw: string | null | undefined): number | null {
  const s = String(raw ?? '').trim().replace(/[\s ]/g, '').replace(',', '.')
  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

export interface PricebookSearchable {
  name?: string | null
  brand?: string | null
  category?: string | null
}

// Регистронезависимый фильтр по name/brand/category. Пустой/пробельный запрос → true (не фильтруем).
export function matchesPricebookSearch(item: PricebookSearchable, query: string | null | undefined): boolean {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return true
  return [item?.name, item?.brand, item?.category]
    .some((v) => String(v ?? '').toLowerCase().includes(q))
}
