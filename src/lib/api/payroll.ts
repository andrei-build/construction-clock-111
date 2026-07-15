import { supabase } from '../supabase'
import { logEvent } from './_shared'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment } from '../types'


export async function getVisibleProfileRates(): Promise<ProfileRate[]> {
  const { data, error } = await supabase.from('profile_rates')
    .select('profile_id, hourly_rate')
  if (error) return []
  return (data as ProfileRate[]) ?? []
}

export async function getCurrentPayPeriod(): Promise<PayPeriod | null> {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase.from('pay_periods')
    .select('id, period_start, period_end, status')
    .lte('period_start', today)
    .gte('period_end', today)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return null
  return (data as PayPeriod | null) ?? null
}

// Строка снапшота зарплаты — считается на клиенте из уже рассчитанных строк таблицы (rows).
// A4c: расширена под jsonb-элемент close_pay_period. Новые поля опциональны — closePayPeriod
// подставляет дефолты (overtime_multiplier 1.5, bonus/reimbursement/deduction 0, time_event_ids []),
// чтобы существующие вызовы не ломались. total — уже округлённый round-half-up (см. A4a).
export interface PayPeriodItemInput {
  profile_id: string
  regular_hours: number
  overtime_hours: number
  overtime_multiplier?: number
  // REP-1: часы проезда за период (pay_period_items.travel_hours, миграция 0032). ТОЛЬКО разбивка —
  // оплата проезда уже входит в total (total пишется без изменений).
  travel_hours: number
  hourly_rate: number | null
  bonus?: number
  reimbursement?: number
  deduction?: number
  total: number
  time_event_ids?: string[]
  adjustments?: unknown
  note?: string | null
}

// Закрыть период: draft → approved. A4c: один транзакционный вызов SECURITY DEFINER RPC
// close_pay_period (миграция 0037, finance-gated) вместо ручного upsert → delete-all → insert
// тремя нетранзакционными запросами. RPC пересоздаёт pay_period_items в ОДНОЙ транзакции и
// возвращает id периода (string). p_period_id = null → новый период. БД запрещает мутировать
// approved/paid строки (триггеры pay_period_items_immutable / pay_period_status_flow) — UI не
// предлагает пере-закрытие такого периода; отказ RPC ловится вызывающим и показывается дружелюбно.
export async function closePayPeriod(p: Profile, input: {
  payPeriodId: string | null
  periodStart: string
  periodEnd: string
  label: string
  items: PayPeriodItemInput[]
  totalPay: number
}): Promise<string> {
  const p_items = input.items.map((item) => ({
    profile_id: item.profile_id,
    regular_hours: item.regular_hours,
    overtime_hours: item.overtime_hours,
    overtime_multiplier: item.overtime_multiplier ?? 1.5,
    // travel_hours — ТОЛЬКО разбивка; оплата проезда уже сидит в total, повторно не прибавляем.
    travel_hours: item.travel_hours,
    hourly_rate: item.hourly_rate,
    bonus: item.bonus ?? 0,
    reimbursement: item.reimbursement ?? 0,
    deduction: item.deduction ?? 0,
    total: item.total,
    time_event_ids: item.time_event_ids ?? [],
    adjustments: item.adjustments ?? null,
    note: item.note ?? null,
  }))

  const { data, error } = await supabase.rpc('close_pay_period', {
    p_period_start: input.periodStart,
    p_period_end: input.periodEnd,
    p_items,
    p_period_id: input.payPeriodId,
  })
  if (error) throw error
  const payPeriodId = String(data)

  await logEvent(p, 'payroll.period_closed', 'pay_period', payPeriodId, {
    period_start: input.periodStart,
    period_end: input.periodEnd,
    workers: input.items.length,
    total: input.totalPay,
  })
  return payPeriodId
}

// Отметить период оплаченным: approved → paid.
export async function markPayPeriodPaid(p: Profile, payPeriodId: string, meta: {
  periodStart: string
  periodEnd: string
  workers: number
  totalPay: number
}): Promise<void> {
  const { error } = await supabase.from('pay_periods')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', payPeriodId)
  if (error) throw error
  await logEvent(p, 'payroll.period_paid', 'pay_period', payPeriodId, {
    period_start: meta.periodStart,
    period_end: meta.periodEnd,
    workers: meta.workers,
    total: meta.totalPay,
  })
}

// PAY-1: найти уже существующий период по ТОЧНЫМ датам окна (period_start/period_end).
// Черновик из пресета переиспользует этот id (обновляет период вместо вставки дубля),
// чтобы не задваивать деньги в Архиве/отчётах. Нет совпадения → null (будет новый черновик).
export async function getPayPeriodByExactDates(periodStart: string, periodEnd: string): Promise<PayPeriod | null> {
  const { data, error } = await supabase.from('pay_periods')
    .select('id, period_start, period_end, status')
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return null
  return (data as PayPeriod | null) ?? null
}

// PAY-1: годовой отчёт (per-worker) — часы и оплачено $ по закрытым/оплаченным периодам
// (status approved|paid), чьё period_start попадает в окно года [fromDate, toDate] (YYYY-MM-DD).
// Тот же источник и та же нотация «закрыто/оплачено», что у Архива (getArchivePayPeriods):
// pay_periods + pay_period_items, без RPC. Деньги гейтит UI (finance-only). Три запроса,
// сборка на клиенте — без embed, чтобы не зависеть от строгих FK.
export async function getYearlyPayrollReport(fromDate: string, toDate: string): Promise<YearlyPayReportRow[]> {
  const { data: periodRows, error } = await supabase.from('pay_periods')
    .select('id, period_start, status')
    .in('status', ['approved', 'paid'])
    .gte('period_start', fromDate)
    .lte('period_start', toDate)
  if (error || !periodRows) return []
  const periods = periodRows as Array<{ id: string; period_start: string; status: string | null }>
  if (periods.length === 0) return []

  const periodIds = periods.map((p) => p.id)
  // REP-1: travel_hours (миграция 0032) — разбивка часов проезда. Деньги (total) читаем как есть,
  // travel уже входит в total, поэтому суммы $ не меняются — добавляется только колонка часов.
  const { data: itemRows } = await supabase.from('pay_period_items')
    .select('pay_period_id, profile_id, regular_hours, overtime_hours, travel_hours, total')
    .in('pay_period_id', periodIds)
  const items = (itemRows ?? []) as Array<{ pay_period_id: string; profile_id: string; regular_hours: number | null; overtime_hours: number | null; travel_hours: number | null; total: number | null }>
  if (items.length === 0) return []

  const workerIds = [...new Set(items.map((i) => i.profile_id))]
  const workerById = new Map<string, { name: string | null; role: string | null }>()
  if (workerIds.length > 0) {
    const { data: profRows } = await supabase.from('profiles').select('id, name, role').in('id', workerIds)
    for (const row of (profRows ?? []) as Array<{ id: string; name: string | null; role: string | null }>) {
      workerById.set(row.id, { name: row.name, role: row.role })
    }
  }

  const byWorker = new Map<string, YearlyPayReportRow>()
  const periodsByWorker = new Map<string, Set<string>>()
  for (const it of items) {
    const prof = workerById.get(it.profile_id)
    const row = byWorker.get(it.profile_id) ?? {
      profile_id: it.profile_id,
      worker_name: prof?.name ?? null,
      worker_role: prof?.role ?? null,
      regular_hours: 0,
      overtime_hours: 0,
      travel_hours: 0,
      total_hours: 0,
      paid: 0,
      periods: 0,
    }
    const reg = Number(it.regular_hours) || 0
    const ot = Number(it.overtime_hours) || 0
    const travel = Number(it.travel_hours) || 0
    row.regular_hours += reg
    row.overtime_hours += ot
    row.travel_hours += travel
    // total_hours = обычные + сверхурочные + проезд (только часы). paid ($) не трогаем.
    row.total_hours += reg + ot + travel
    row.paid += Number(it.total) || 0
    byWorker.set(it.profile_id, row)
    const set = periodsByWorker.get(it.profile_id) ?? new Set<string>()
    set.add(it.pay_period_id)
    periodsByWorker.set(it.profile_id, set)
  }
  for (const [id, set] of periodsByWorker) {
    const row = byWorker.get(id)
    if (row) row.periods = set.size
  }

  return [...byWorker.values()].sort((a, b) => (a.worker_name ?? '').localeCompare(b.worker_name ?? ''))
}

// REP-1: report_payroll пересоздан аддитивно (доп. колонки regular/overtime/travel_hours, total_pay
// уже включает проезд) — generic-обёртка отдаёт все колонки RPC как есть, менять её не нужно.
// report_travel — новый RPC report_travel_hours(worker_name, travel_hours) для отдельной разбивки проезда.
const reportRpc: Record<ReportKind, string> = {
  hours: 'report_hours',
  payroll: 'report_payroll',
  expenses: 'report_expenses',
  travel: 'report_travel_hours',
}

export async function getReportRows(kind: ReportKind, from: string, to: string): Promise<ReportRow[]> {
  const { data, error } = await supabase.rpc(reportRpc[kind], { p_from: from, p_to: to })
  if (error) throw error
  return ((data ?? []) as ReportRow[])
}

// ARCH-1 «Архив» → вкладка «Зарплата / Рабочие»: закрытые/оплаченные периоды (status approved|paid) со
// строками сотрудников. Три запроса (периоды → строки → имена/роли), сборка на клиенте — без embed,
// чтобы не зависеть от строгих FK. Денежные суммы гейтит UI (finance-only), тут только читаем.
export async function getArchivePayPeriods(): Promise<ArchivePayPeriod[]> {
  const { data: periodRows, error } = await supabase.from('pay_periods')
    .select('id, label, period_start, period_end, status, paid_at')
    .in('status', ['approved', 'paid'])
    .order('period_start', { ascending: false })
  if (error || !periodRows) return []
  const periods = periodRows as Array<{ id: string; label: string | null; period_start: string; period_end: string; status: string | null; paid_at: string | null }>
  if (periods.length === 0) return []

  const periodIds = periods.map((p) => p.id)
  const { data: itemRows } = await supabase.from('pay_period_items')
    .select('pay_period_id, profile_id, regular_hours, overtime_hours, total')
    .in('pay_period_id', periodIds)
  const items = (itemRows ?? []) as Array<{ pay_period_id: string; profile_id: string; regular_hours: number | null; overtime_hours: number | null; total: number | null }>

  const workerIds = [...new Set(items.map((i) => i.profile_id))]
  const workerById = new Map<string, { name: string | null; role: string | null }>()
  if (workerIds.length > 0) {
    const { data: profRows } = await supabase.from('profiles').select('id, name, role').in('id', workerIds)
    for (const row of (profRows ?? []) as Array<{ id: string; name: string | null; role: string | null }>) {
      workerById.set(row.id, { name: row.name, role: row.role })
    }
  }

  const itemsByPeriod = new Map<string, ArchivePayItem[]>()
  for (const it of items) {
    const list = itemsByPeriod.get(it.pay_period_id) ?? []
    const prof = workerById.get(it.profile_id)
    list.push({
      profile_id: it.profile_id,
      worker_name: prof?.name ?? null,
      worker_role: prof?.role ?? null,
      regular_hours: Number(it.regular_hours) || 0,
      overtime_hours: Number(it.overtime_hours) || 0,
      total: Number(it.total) || 0,
    })
    itemsByPeriod.set(it.pay_period_id, list)
  }

  return periods.map((p) => ({
    id: p.id,
    label: p.label,
    period_start: p.period_start,
    period_end: p.period_end,
    status: p.status,
    paid_at: p.paid_at,
    items: itemsByPeriod.get(p.id) ?? [],
  }))
}

export interface UnpaidWorkSummary {
  hours: number
  amount: number
}

function payPeriodWindow(period: { period_start: string; period_end: string }): { startMs: number; endMs: number } {
  const start = new Date(`${period.period_start}T00:00:00`)
  const end = new Date(`${period.period_end}T00:00:00`)
  end.setDate(end.getDate() + 1)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

function subtractClosedPeriods(startMs: number, endMs: number, closed: Array<{ startMs: number; endMs: number }>): number {
  let openSegments = [{ startMs, endMs }]
  for (const period of closed) {
    const next: Array<{ startMs: number; endMs: number }> = []
    for (const segment of openSegments) {
      const overlapStart = Math.max(segment.startMs, period.startMs)
      const overlapEnd = Math.min(segment.endMs, period.endMs)
      if (overlapEnd <= overlapStart) {
        next.push(segment)
        continue
      }
      if (segment.startMs < overlapStart) next.push({ startMs: segment.startMs, endMs: overlapStart })
      if (overlapEnd < segment.endMs) next.push({ startMs: overlapEnd, endMs: segment.endMs })
    }
    openSegments = next
    if (openSegments.length === 0) break
  }
  return openSegments.reduce((sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs), 0)
}

// OVR-1: finance-only Overview KPI. "Unpaid" means work interval hours that are
// outside approved/paid pay periods. Money uses the latest visible worker rate.
export async function getUnpaidWorkSummary(): Promise<UnpaidWorkSummary> {
  const [periodsRes, intervalsRes, ratesRes] = await Promise.all([
    supabase.from('pay_periods')
      .select('period_start, period_end')
      .in('status', ['approved', 'paid']),
    supabase.from('v_work_intervals')
      .select('profile_id, start_at, end_at')
      .order('start_at', { ascending: false }),
    supabase.from('profile_rates')
      .select('profile_id, hourly_rate, effective_from')
      .order('effective_from', { ascending: false }),
  ])
  if (periodsRes.error || intervalsRes.error || ratesRes.error) return { hours: 0, amount: 0 }

  const closed = ((periodsRes.data ?? []) as Array<{ period_start: string; period_end: string }>)
    .map(payPeriodWindow)
    .filter((period) => Number.isFinite(period.startMs) && Number.isFinite(period.endMs))
  const rateByWorker = new Map<string, number | null>()
  for (const row of (ratesRes.data ?? []) as Array<{ profile_id: string; hourly_rate: number | null }>) {
    if (!rateByWorker.has(row.profile_id)) {
      rateByWorker.set(row.profile_id, row.hourly_rate === null ? null : Number(row.hourly_rate))
    }
  }

  const now = Date.now()
  let hours = 0
  let amount = 0
  for (const interval of (intervalsRes.data ?? []) as Array<{ profile_id: string; start_at: string; end_at: string | null }>) {
    const startMs = new Date(interval.start_at).getTime()
    const endMs = interval.end_at ? new Date(interval.end_at).getTime() : now
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue
    const unpaidMs = subtractClosedPeriods(startMs, endMs, closed)
    const unpaidHours = unpaidMs / 3600000
    hours += unpaidHours
    const rate = rateByWorker.get(interval.profile_id)
    if (typeof rate === 'number' && Number.isFinite(rate)) amount += unpaidHours * rate
  }

  return { hours, amount }
}
