// ESTIMATE-REVIEW-39 (серия PLAN-TO-ESTIMATE, 3/4): чистая логика экрана «Смета (черновик)».
// 0 DOM / 0 React / 0 supabase — чтобы покрыть юнит-тестами (vitest node-env) и переиспользовать
// в api-обёртке (src/lib/api/estimate.ts) и в UI (FinanceTab.tsx). Никаких браузерных/сетевых
// зависимостей здесь быть не должно (как planPinCore.ts / fileViewerCore.ts).

// --- Статус черновика ---
export type EstimateStatus = 'draft' | 'review' | 'approved'
export const ESTIMATE_STATUSES: EstimateStatus[] = ['draft', 'review', 'approved']

export function isStatus(v: unknown): v is EstimateStatus {
  return v === 'draft' || v === 'review' || v === 'approved'
}

// Дефолт — 'draft' (как в схеме БД), любой мусор нормализуем к нему.
export function normalizeStatus(v: unknown): EstimateStatus {
  return isStatus(v) ? v : 'draft'
}

// ДНК-правило: смета движется только строго вперёд по цепочке draft → review → approved, по одному
// шагу. Никакого отката, скипа (draft→approved) или «самоперехода». Утверждает ЧЕЛОВЕК — авто-approve
// не бывает, но само правило перехода живёт здесь (тест + гейт api.updateEstimateStatus).
export function canTransition(from: unknown, to: unknown): boolean {
  if (!isStatus(from) || !isStatus(to)) return false
  return (from === 'draft' && to === 'review') || (from === 'review' && to === 'approved')
}

// Следующий статус в цепочке (для подписи/видимости кнопки), либо null — если approved/некорректно.
export function nextStatus(from: unknown): EstimateStatus | null {
  if (from === 'draft') return 'review'
  if (from === 'review') return 'approved'
  return null
}

// --- Флаг строки (светофор) ---
// estimate_items.flag — свободный text; в проде это цветовые слова (RU «зелёный/жёлтый/красный»
// ИЛИ англ. green/yellow/red). Нормализуем к каноничному цвету; неизвестное/пусто → null (без маркера).
export type EstimateFlag = 'green' | 'yellow' | 'red'

const FLAG_EMOJI: Record<EstimateFlag, string> = {
  green: '🟢',
  yellow: '🟡',
  red: '🔴',
}

export function normalizeFlag(raw: unknown): EstimateFlag | null {
  const s = String(raw ?? '').trim().toLowerCase()
  if (!s) return null
  if (s === 'green' || s.startsWith('зел')) return 'green'
  if (s === 'yellow' || s === 'amber' || s.startsWith('жёл') || s.startsWith('жел')) return 'yellow'
  if (s === 'red' || s.startsWith('крас')) return 'red'
  return null
}

// Эмодзи-светофор строки. Неизвестный/пустой флаг → '' (строка просто без маркера, не падаем).
export function flagEmoji(flag: unknown): string {
  const f = normalizeFlag(flag)
  return f ? FLAG_EMOJI[f] : ''
}

// --- Источник строки (source jsonb) ---
export type SourceKind = 'page' | 'rule' | 'norm' | 'catalog' | 'unknown'

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

// source.kind → нормализованный вид бейджа. Битый/пустой source → 'unknown' (бейдж не рисуем).
export function sourceKind(source: unknown): SourceKind {
  const rec = asRecord(source)
  const k = String(rec?.kind ?? '').trim().toLowerCase()
  if (k === 'page') return 'page'
  if (k === 'rule') return 'rule'
  if (k === 'norm') return 'norm'
  if (k === 'catalog') return 'catalog'
  return 'unknown'
}

// Номер страницы источника (source.page) как целое ≥1, либо null (нет привязки к странице).
export function sourcePage(source: unknown): number | null {
  const rec = asRecord(source)
  if (!rec) return null
  const raw = rec.page
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null
}

// Файл источника (source.file_id) либо null.
export function sourceFileId(source: unknown): string | null {
  const rec = asRecord(source)
  const f = rec?.file_id
  return typeof f === 'string' && f ? f : null
}

// Спека #39: каноничная RU-подпись бейджа источника (тестируемый фолбэк). UI может брать i18n по
// sourceKind()+sourcePage(), но эта функция — эталон: 'Страница N' / 'Правило' / 'Норма' / 'Каталог'.
export function sourceBadgeLabel(source: unknown): string {
  switch (sourceKind(source)) {
    case 'page': {
      const p = sourcePage(source)
      return p ? `Страница ${p}` : 'Страница'
    }
    case 'rule':
      return 'Правило'
    case 'norm':
      return 'Норма'
    case 'catalog':
      return 'Каталог'
    default:
      return ''
  }
}

// --- Итоги ---
export interface TotalsLine {
  line_total?: number | null
  qty?: number | null
  unit_price?: number | null
  markup_pct?: number | null
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

// Округление до 2 знаков (деньги), устойчиво к бинарной погрешности.
function round2(n: number): number {
  return Math.round((num(n) + Number.EPSILON) * 100) / 100
}

// line_total одной строки: если задан валидным числом — берём его (это авторитет движка);
// иначе считаем qty * unit_price * (1 + markup_pct/100). Клиентский пересчёт — опц. для правки.
export function computeLineTotal(item: TotalsLine): number {
  if (item.line_total != null && Number.isFinite(Number(item.line_total))) return round2(item.line_total)
  return round2(num(item.qty) * num(item.unit_price) * (1 + num(item.markup_pct) / 100))
}

// subtotal = Σ line_total; total = subtotal + резерв (contingency_pct %). Оба округляем до 2 знаков.
export function computeTotals(
  items: TotalsLine[] | null | undefined,
  contingencyPct: unknown,
): { subtotal: number; total: number } {
  const subtotal = round2((items ?? []).reduce((sum, it) => sum + computeLineTotal(it), 0))
  const total = round2(subtotal * (1 + num(contingencyPct) / 100))
  return { subtotal, total }
}
