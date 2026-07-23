// ASSISTANT-PAGE-42 (фаза-2 страницы «Marvel» /ask): чистое ядро для трёх блоков ассистента —
// 💰 расход на ИИ, 🧠 память, 🛠 «что мне нужно». 0 DOM / 0 React / 0 supabase — покрываем
// юнит-тестами (vitest node-env) и переиспользуем в UI (Ask.tsx). nowIso передаём ЯВНО, чтобы тесты
// были детерминированы (никакого Date.now() внутри ядра — как pricebookCore.ts / estimateCore.ts).
//
// Источник цен: официальный прайс Anthropic (per-1M-tokens, input/output) — платформенная
// документация platform.claude.com/docs/en/about-claude/models/overview. Значения ниже сверены с
// прайсом на дату задачи; при появлении data.model в строке события считаем по нему, иначе по
// DEFAULT_AI_MODEL с пометкой «прибл.» (approx). Старые строки events (до v23) НЕ несут data.model —
// это НЕ ошибка, трактуем токены/цену мягко (отсутствие → 0 / дефолтная модель).

const MS_PER_DAY = 86_400_000

// Цена за 1 000 000 токенов в долларах: input / output. Ключи — семейства моделей Claude; точный
// id из data.model матчим по вхождению ключа (id часто несёт дату-суффикс, напр. claude-3-5-sonnet-*).
export interface ModelPrice {
  inputPer1M: number
  outputPer1M: number
}

// Прайс Anthropic (USD за 1M токенов). Источник: platform.claude.com/docs/en/about-claude/models/overview.
export const AI_MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-opus-4': { inputPer1M: 5, outputPer1M: 25 },
  'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4': { inputPer1M: 1, outputPer1M: 5 },
  'claude-3-5-sonnet': { inputPer1M: 3, outputPer1M: 15 },
  'claude-3-5-haiku': { inputPer1M: 0.8, outputPer1M: 4 },
  'claude-3-opus': { inputPer1M: 15, outputPer1M: 75 },
  'claude-3-haiku': { inputPer1M: 0.25, outputPer1M: 1.25 },
  'claude-3-sonnet': { inputPer1M: 3, outputPer1M: 15 },
}

// Модель по умолчанию, когда в строке события НЕТ data.model (старые строки до v23). Отдельно
// помечаем такую цену как приблизительную (approx) в UI. Выбрана как безопасный середняк по прайсу.
export const DEFAULT_AI_MODEL = 'claude-3-5-sonnet'

// Цена для конкретной модели: матч по вхождению ключа семейства; при промахе — цена DEFAULT_AI_MODEL.
export function priceForModel(model: string | null | undefined): ModelPrice {
  const id = String(model ?? '').trim().toLowerCase()
  if (id) {
    for (const key of Object.keys(AI_MODEL_PRICES)) {
      if (id.includes(key)) return AI_MODEL_PRICES[key]
    }
  }
  return AI_MODEL_PRICES[DEFAULT_AI_MODEL]
}

// Стоимость одного вызова в долларах по числу входных/выходных токенов и модели (или дефолту).
export function costUsd(
  tokensIn: number,
  tokensOut: number,
  model: string | null | undefined,
): number {
  const p = priceForModel(model)
  const inTok = Number.isFinite(tokensIn) ? Math.max(0, tokensIn) : 0
  const outTok = Number.isFinite(tokensOut) ? Math.max(0, tokensOut) : 0
  return (inTok / 1_000_000) * p.inputPer1M + (outTok / 1_000_000) * p.outputPer1M
}

// Безопасное приведение произвольного значения из jsonb к неотрицательному числу (иначе 0).
function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// UTC-ключ дня 'YYYY-MM-DD' из ISO-строки. Пустая/битая дата → null.
export function usageDayKey(iso: string | null | undefined): string | null {
  const s = String(iso ?? '')
  const t = new Date(s).getTime()
  if (!Number.isFinite(t)) return null
  return new Date(t).toISOString().slice(0, 10)
}

// Строка события AI-чата (минимальный контракт: нам нужны только тип, data и дата).
export interface AiChatEventLike {
  event_type?: string | null
  data?: unknown
  created_at?: string | null
}

export interface UsageDay {
  date: string
  tokensIn: number
  tokensOut: number
  usd: number
}

export interface AiUsageSummary {
  totalIn: number
  totalOut: number
  totalUsd: number
  count: number
  // true, если хотя бы одна учтённая строка не несла data.model → цена по DEFAULT_AI_MODEL (прибл.).
  approx: boolean
  // разбивка по дням (только за последние `days` суток), свежие дни последними (asc по date).
  byDay: UsageDay[]
}

// Агрегация расхода: сумма tokens_in/tokens_out и $ по ВСЕМ строкам event_type='ai.chat' (итого),
// плюс мини-разбивка по дням за последние `days` суток. nowIso — «сейчас» (детерминизм в тестах).
export function aggregateAiUsage(
  events: readonly AiChatEventLike[] | null | undefined,
  nowIso: string,
  days = 30,
): AiUsageSummary {
  const now = new Date(nowIso).getTime()
  const cutoff = Number.isFinite(now) ? now - days * MS_PER_DAY : Number.NEGATIVE_INFINITY
  let totalIn = 0
  let totalOut = 0
  let totalUsd = 0
  let count = 0
  let approx = false
  const dayMap = new Map<string, UsageDay>()

  for (const ev of events ?? []) {
    if (ev?.event_type !== 'ai.chat') continue
    const data = (ev.data ?? {}) as Record<string, unknown>
    const tokensIn = toNum(data.tokens_in)
    const tokensOut = toNum(data.tokens_out)
    const model = typeof data.model === 'string' && data.model.trim() ? data.model : null
    if (!model) approx = true
    const usd = costUsd(tokensIn, tokensOut, model)
    totalIn += tokensIn
    totalOut += tokensOut
    totalUsd += usd
    count += 1

    const t = new Date(String(ev.created_at ?? '')).getTime()
    const key = usageDayKey(ev.created_at)
    if (key && Number.isFinite(t) && t >= cutoff) {
      const row = dayMap.get(key) ?? { date: key, tokensIn: 0, tokensOut: 0, usd: 0 }
      row.tokensIn += tokensIn
      row.tokensOut += tokensOut
      row.usd += usd
      dayMap.set(key, row)
    }
  }

  const byDay = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date))
  return { totalIn, totalOut, totalUsd, count, approx, byDay }
}

// Формат доллара для расхода ИИ: '$12.34' для сумм ≥ $1, '$0.0123' для мелких (4 знака), '$0.00' для 0.
// Точка — десятичный разделитель (dollar-first формат, отличный от pricebookCore.formatUsd).
export function formatUsd(n: number | null | undefined): string {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v) || v === 0) return '$0.00'
  const neg = v < 0
  const abs = Math.abs(v)
  const body = abs >= 1 ? abs.toFixed(2) : abs.toFixed(4)
  return `${neg ? '-' : ''}$${body}`
}

// Целое число токенов с разбивкой разрядов неразрывными пробелами: 1234567 → '1 234 567'.
export function formatTokens(n: number | null | undefined): string {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return '0'
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

export interface AiMemoryMessageLike {
  content?: string | null
}

// Регистронезависимый фильтр сообщений памяти по подстроке content. Пустой/пробельный запрос → всё.
export function searchMessages<T extends AiMemoryMessageLike>(
  messages: readonly T[] | null | undefined,
  query: string | null | undefined,
): T[] {
  const q = String(query ?? '').trim().toLowerCase()
  const list = messages ?? []
  if (!q) return [...list]
  return list.filter((m) => String(m?.content ?? '').toLowerCase().includes(q))
}

export interface ProposalLike {
  title?: string | null
  created_at?: string | null
}

// КОРНЕВОЙ дедуп предложений по title в окне 24ч (не render-level): группируем по title и схлопываем
// записи, отстоящие не более чем на windowHours от свежайшей в кластере, оставляя свежайшую. Записи
// того же title с разрывом > windowHours образуют новый кластер (обе видны). Вход не мутируем.
export function dedupeProposalsByTitle<T extends ProposalLike>(
  proposals: readonly T[] | null | undefined,
  windowHours = 24,
): T[] {
  const windowMs = windowHours * 3_600_000
  const withTime = (proposals ?? []).map((p, idx) => ({
    p,
    idx,
    t: new Date(String(p?.created_at ?? '')).getTime(),
  }))
  // Сортируем от свежих к старым (стабильно по idx при равных датах / битых датах).
  withTime.sort((a, b) => {
    const at = Number.isFinite(a.t) ? a.t : Number.NEGATIVE_INFINITY
    const bt = Number.isFinite(b.t) ? b.t : Number.NEGATIVE_INFINITY
    if (bt !== at) return bt - at
    return a.idx - b.idx
  })
  const lastKept = new Map<string, number>()
  const keptIdx = new Set<number>()
  for (const item of withTime) {
    const title = String(item.p?.title ?? '')
    const t = Number.isFinite(item.t) ? item.t : Number.NEGATIVE_INFINITY
    const prev = lastKept.get(title)
    if (prev === undefined || (Number.isFinite(prev) && prev - t > windowMs)) {
      keptIdx.add(item.idx)
      lastKept.set(title, t)
    }
  }
  // Возвращаем в исходном порядке входа (только оставленные записи).
  return (proposals ?? []).filter((_, idx) => keptIdx.has(idx))
}
