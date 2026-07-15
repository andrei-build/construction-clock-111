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

// Строка снапшота зарплаты — считается на клиенте из уже рассчитанных строк таблицы (rows)
export interface PayPeriodItemInput {
  profile_id: string
  regular_hours: number
  overtime_hours: number
  // REP-1: часы проезда за период (pay_period_items.travel_hours, миграция 0032). ТОЛЬКО разбивка —
  // оплата проезда уже входит в total (см. closePayPeriod: total пишется без изменений).
  travel_hours: number
  hourly_rate: number | null
  total: number
}

// Закрыть период: draft → approved. Апсертит pay_periods и переснимает pay_period_items из строк таблицы.
export async function closePayPeriod(p: Profile, input: {
  payPeriodId: string | null
  periodStart: string
  periodEnd: string
  label: string
  items: PayPeriodItemInput[]
  totalPay: number
}): Promise<string> {
  const now = new Date().toISOString()
  let payPeriodId = input.payPeriodId

  if (payPeriodId) {
    const { error } = await supabase.from('pay_periods')
      .update({ status: 'approved', approved_by: p.id, approved_at: now })
      .eq('id', payPeriodId)
    if (error) throw error
  } else {
    const { data, error } = await supabase.from('pay_periods')
      .insert({
        org_id: p.org_id,
        label: input.label,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        status: 'approved',
        approved_by: p.id,
        approved_at: now,
      })
      .select('id')
      .single()
    if (error) throw error
    payPeriodId = String(data.id)
  }

  const { error: delError } = await supabase.from('pay_period_items')
    .delete()
    .eq('pay_period_id', payPeriodId)
  if (delError) throw delError

  if (input.items.length > 0) {
    const rows = input.items.map((item) => ({
      pay_period_id: payPeriodId,
      profile_id: item.profile_id,
      regular_hours: item.regular_hours,
      overtime_hours: item.overtime_hours,
      // REP-1: travel_hours — ТОЛЬКО разбивка. Оплата проезда уже сидит в item.total
      // (buildPayrollRows: total = reg*rate + ot*rate*1.5 + travel*rate). НЕ прибавляем
      // проезд к total повторно, деньги (total) не трогаем.
      travel_hours: item.travel_hours,
      overtime_multiplier: 1.5,
      hourly_rate: item.hourly_rate,
      bonus: 0,
      reimbursement: 0,
      deduction: 0,
      total: item.total,
    }))
    const { error: insError } = await supabase.from('pay_period_items').insert(rows)
    if (insError) throw insError
  }

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
