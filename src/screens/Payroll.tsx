import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { closePayPeriod, getAppSettings, getArchivePayPeriods, getCurrentPayPeriod, getIntervalsBetween, getPayPeriodByExactDates, getPayPeriodItems, getTeam, getVisibleProfileRates, getYearlyPayrollReport, logEvent, markPayPeriodPaid } from '../lib/api'
import type { PayPeriodSnapshotRow } from '../lib/api'
import { orgWeekGrouping, computeTravelGaps, intervalsToTravelShifts, DEFAULT_PAID_GAP_ALERT_HOURS } from '../lib/time'
import { computeWorkerTotal, regularOvertimeSplit, splitHoursByWeek, type WeekBoundary } from '../lib/payrollMath'
import type { ArchivePayPeriod, PayPeriod, Profile, ProfileRate, WorkInterval, YearlyPayReportRow } from '../lib/types'

interface PeriodWindow {
  id: string | null
  start: Date
  end: Date
  status: string | null
}

interface PayrollRow {
  worker: Profile
  regularHours: number
  overtimeHours: number
  // G1: оплачиваемое время в пути — отдельно от work-часов, но входит в total.
  travelHours: number
  overAlertGapMs: number // самый длинный разрыв сверх порога (0 — таких нет)
  rate: number | null
  total: number
}

// UI-FIX-PACK-1 (г): плоская строка для отрисовки таблицы/итогов/CSV. Живой расчёт (PayrollRow)
// и замороженный снапшот (PayPeriodSnapshotRow) сводятся к ней — экран не знает, откуда цифры.
interface DisplayRow {
  id: string
  name: string
  regularHours: number
  overtimeHours: number
  travelHours: number
  rate: number | null
  total: number
  overAlertGapMs: number
}

// PAY-1: пресеты периода для черновика зарплаты «из текущих часов».
type PresetKey = 'lastWeek' | 'last2Weeks' | 'thisMonth' | 'custom'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
const TWO_WEEK_ANCHOR = new Date('2026-01-05T00:00:00')

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function startOfWeek(d: Date) {
  const x = startOfDay(d)
  const day = (x.getDay() + 6) % 7
  x.setDate(x.getDate() - day)
  return x
}

function fallbackPeriod(): PeriodWindow {
  const weekStart = startOfWeek(new Date())
  const diffWeeks = Math.floor((weekStart.getTime() - TWO_WEEK_ANCHOR.getTime()) / WEEK_MS)
  const start = new Date(weekStart)
  if (Math.abs(diffWeeks % 2) === 1) start.setDate(start.getDate() - 7)
  return { id: null, start, end: new Date(start.getTime() + 14 * DAY_MS), status: null }
}

function periodFromDb(period: PayPeriod | null): PeriodWindow {
  if (!period) return fallbackPeriod()
  const start = startOfDay(new Date(`${period.period_start}T00:00:00`))
  const end = startOfDay(new Date(`${period.period_end}T00:00:00`))
  end.setDate(end.getDate() + 1)
  return { id: period.id, start, end, status: period.status }
}

// PAY-1: окно из строки истории (ArchivePayPeriod) — как periodFromDb (end + 1 день, эксклюзивно).
function periodFromArchive(p: ArchivePayPeriod): PeriodWindow {
  const start = startOfDay(new Date(`${p.period_start}T00:00:00`))
  const end = startOfDay(new Date(`${p.period_end}T00:00:00`))
  end.setDate(end.getDate() + 1)
  return { id: p.id, start, end, status: p.status }
}

// PAY-1: окно пресета. Границы недели/суток — через setDate (DST-безопасно, как startOfWeek).
// end — эксклюзивная (полночь следующего дня), той же семантики, что periodFromDb.
function presetWindow(key: PresetKey, customStart: string, customEnd: string): PeriodWindow | null {
  const now = new Date()
  if (key === 'lastWeek') {
    const start = startOfWeek(now)
    start.setDate(start.getDate() - 7)
    const end = new Date(start)
    end.setDate(end.getDate() + 7)
    return { id: null, start, end, status: null }
  }
  if (key === 'last2Weeks') {
    const thisWeek = startOfWeek(now)
    const start = new Date(thisWeek)
    start.setDate(start.getDate() - 14)
    return { id: null, start, end: thisWeek, status: null }
  }
  if (key === 'thisMonth') {
    const start = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1))
    const end = startOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 1))
    return { id: null, start, end, status: null }
  }
  // custom: даты включительно; end смещаем на +1 день (эксклюзивно).
  if (!customStart || !customEnd) return null
  const start = startOfDay(new Date(`${customStart}T00:00:00`))
  const end = startOfDay(new Date(`${customEnd}T00:00:00`))
  end.setDate(end.getDate() + 1)
  if (!(end > start)) return null
  return { id: null, start, end, status: null }
}

// Локальная дата YYYY-MM-DD (без сдвига часового пояса, в отличие от toISOString)
function ymd(d: Date) {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function weekKey(ms: number) {
  return startOfWeek(new Date(ms)).toISOString()
}

// Часы по неделям из v_work_intervals (корректировки уже применены); неделя — по start_at интервала.
// Интервалы, пересекающие границу недели, разбиваются: каждая часть попадает в свою неделю.
// Границы недели считаются в часовом поясе организации (timeZone); при null/пустом — как раньше,
// в локальном поясе устройства. В обоих случаях суммарные часы в периоде неизменны — меняется
// только распределение по неделям у самой границы (что влияет на разбивку regular/overtime).
// A4b: OVERLAP-clip, не старт-фильтр. Смена, НАЧАВШАЯСЯ до окна, но заканчивающаяся внутри,
// больше НЕ теряется — считаются только часы ВНУТРИ окна (seg-clip). Чистая математика
// (overlap + недельная нарезка) вынесена в payrollMath.splitHoursByWeek; здесь только строим
// функцию границ недели (пояс организации через orgWeekGrouping, иначе пояс устройства).
function weeklyHours(intervals: WorkInterval[], period: PeriodWindow, timeZone: string | null, now = Date.now()) {
  const periodStart = period.start.getTime()
  const periodEnd = period.end.getTime()
  const weekBoundary = (cursor: number): WeekBoundary => {
    if (timeZone) {
      // Границы недели в поясе организации (DST-корректно через Intl).
      const g = orgWeekGrouping(cursor, timeZone)
      return { key: g.weekKey, nextBoundaryMs: g.nextWeekStartMs }
    }
    // Прежнее поведение: границы недели в локальном поясе устройства.
    const nextWeek = startOfWeek(new Date(cursor))
    nextWeek.setDate(nextWeek.getDate() + 7)
    return { key: weekKey(cursor), nextBoundaryMs: nextWeek.getTime() }
  }
  return splitHoursByWeek(intervals, periodStart, periodEnd, weekBoundary, now)
}

// PAY-1: строки зарплаты из отработанных интервалов — ЕДИНЫЙ источник расчёта для текущего
// периода И для черновика по пресету. Математика (weeklyHours + порог 40ч ×1.5 + время в пути)
// не изменилась: логика вынесена сюда байт-в-байт из прежнего useMemo, чтобы деньги для уже
// посчитанного периода совпадали.
function buildPayrollRows(
  team: Profile[],
  intervals: WorkInterval[],
  period: PeriodWindow,
  timezone: string | null,
  rates: ProfileRate[],
  alertHours: number,
): PayrollRow[] {
  const byWorker = new Map<string, WorkInterval[]>()
  for (const interval of intervals) {
    if (!byWorker.has(interval.profile_id)) byWorker.set(interval.profile_id, [])
    byWorker.get(interval.profile_id)!.push(interval)
  }

  const rateByWorker = new Map(rates.map((r) => [r.profile_id, r.hourly_rate === null ? null : Number(r.hourly_rate)]))

  return team
    .filter((worker) => byWorker.has(worker.id) || rateByWorker.has(worker.id))
    .map((worker) => {
      const workerIntervals = byWorker.get(worker.id) ?? []
      const weeks = weeklyHours(workerIntervals, period, timezone)
      const { regularHours, overtimeHours } = regularOvertimeSplit(weeks)
      // G1: время в пути — разрывы между сменами в один org-local день. Считается ОТДЕЛЬНО
      // и НЕ участвует в разбивке regular/OT (оплачивается прямой ставкой поверх work-часов).
      const travelGaps = computeTravelGaps(intervalsToTravelShifts(workerIntervals), timezone, alertHours)
      let travelHours = 0
      let overAlertGapMs = 0
      for (const gap of travelGaps) {
        travelHours += gap.durationHours
        if (gap.overAlert) overAlertGapMs = Math.max(overAlertGapMs, gap.endMs - gap.startMs)
      }
      const rate = rateByWorker.get(worker.id) ?? null
      // A4a FROZEN contract: round-half-up of the SUM (не по-компонентно). bonus/reimbursement/
      // deduction = 0 сегодня, но остаются в формуле (computeWorkerTotal) на будущее. travel уже в total.
      const total = computeWorkerTotal({ regularHours, overtimeHours, travelHours, rate })
      return { worker, regularHours, overtimeHours, travelHours, overAlertGapMs, rate, total }
    })
    .sort((a, b) => a.worker.name.localeCompare(b.worker.name))
}

function formatHours(hours: number) {
  return (Math.round(hours * 100) / 100).toFixed(2)
}

function csvCell(value: string | number) {
  return `"${String(value).replace(/"/g, '""')}"`
}

export default function Payroll() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [searchParams] = useSearchParams()
  const [period, setPeriod] = useState<PeriodWindow>(() => fallbackPeriod())
  const [currentWindow, setCurrentWindow] = useState<PeriodWindow | null>(null)
  const [team, setTeam] = useState<Profile[]>([])
  const [intervals, setIntervals] = useState<WorkInterval[]>([])
  // UI-FIX-PACK-1 (г): снапшот строк для утверждённого/оплаченного периода (pay_period_items).
  // null — снапшот ещё не загружен/не нужен (период черновой/текущий → считаем вживую).
  const [snapshot, setSnapshot] = useState<PayPeriodSnapshotRow[] | null>(null)
  const [rates, setRates] = useState<ProfileRate[]>([])
  const [timezone, setTimezone] = useState<string | null>(null)
  const [alertHours, setAlertHours] = useState(DEFAULT_PAID_GAP_ALERT_HOURS)
  const [loading, setLoading] = useState(true)
  const [bootstrapped, setBootstrapped] = useState(false)
  const [error, setError] = useState(false)
  const [working, setWorking] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  // PAY-1: черновик из пресета + выбор работника.
  const [activePreset, setActivePreset] = useState<PresetKey | null>(null)
  const [workerFilter, setWorkerFilter] = useState<string>('') // '' → все работники
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  // PAY-1: история периодов.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<ArchivePayPeriod[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)

  // PAY-1: годовой отчёт.
  const [reportOpen, setReportOpen] = useState(false)
  const [reportYear, setReportYear] = useState(() => new Date().getFullYear())
  const [report, setReport] = useState<YearlyPayReportRow[] | null>(null)
  const [reportLoading, setReportLoading] = useState(false)

  // Загрузка справочников (команда, ставки, настройки, текущий период). Интервалы грузит
  // отдельный эффект по окну period, чтобы черновик по пресету переиспользовал тот же расчёт.
  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const dbPeriod = await getCurrentPayPeriod()
        const currentPeriod = periodFromDb(dbPeriod)
        const [workers, visibleRates, settings] = await Promise.all([
          getTeam(),
          getVisibleProfileRates(),
          getAppSettings(),
        ])
        if (!mounted) return
        setCurrentWindow(currentPeriod)
        setPeriod(currentPeriod)
        setTeam(workers)
        setRates(visibleRates)
        // Часовой пояс организации для границ суток/недель. Пусто → как раньше (пояс устройства).
        const tz = settings?.timezone?.trim()
        setTimezone(tz ? tz : null)
        // G1: порог оповещения о разрыве; null/пусто/≤0 → дефолт.
        const gapAlert = Number(settings?.paid_gap_alert_hours)
        setAlertHours(Number.isFinite(gapAlert) && gapAlert > 0 ? gapAlert : DEFAULT_PAID_GAP_ALERT_HOURS)
        setBootstrapped(true)
      } catch {
        if (mounted) setError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  // Интервалы за окно активного периода (текущего или черновика). Перезагружается при смене окна.
  const periodStartMs = period.start.getTime()
  const periodEndMs = period.end.getTime()
  useEffect(() => {
    if (!bootstrapped) return
    let mounted = true
    async function loadIntervals() {
      try {
        const rows = await getIntervalsBetween(new Date(periodStartMs).toISOString(), new Date(periodEndMs).toISOString())
        if (mounted) setIntervals(rows)
      } catch {
        if (mounted) setIntervals([])
      }
    }
    loadIntervals()
    return () => { mounted = false }
  }, [bootstrapped, periodStartMs, periodEndMs])

  // UI-FIX-PACK-1 (г): для утверждённого/оплаченного периода читаем ЗАМОРОЖЕННЫЙ снапшот
  // (pay_period_items) вместо живого пересчёта — иначе поздняя правка ставки/корректировка меняла бы
  // уже утверждённые деньги задним числом. Черновик/текущий (id нет либо status draft) → снапшота нет.
  const frozen = Boolean(period.id) && (period.status === 'approved' || period.status === 'paid')
  useEffect(() => {
    let mounted = true
    if (!frozen || !period.id) { setSnapshot(null); return () => { mounted = false } }
    const pid = period.id
    setSnapshot(null)
    getPayPeriodItems(pid)
      .then((rows) => { if (mounted) setSnapshot(rows) })
      .catch(() => { if (mounted) setSnapshot([]) })
    return () => { mounted = false }
  }, [frozen, period.id])

  // PAY-1: преселект работника из карточки (/payroll?worker=<id>). Ставится один раз, когда
  // команда загружена и такой работник существует.
  useEffect(() => {
    const workerId = searchParams.get('worker')
    if (!workerId || team.length === 0) return
    if (!team.some((w) => w.id === workerId)) return
    setWorkerFilter((current) => (current ? current : workerId))
  }, [searchParams, team])

  const allRows = useMemo<PayrollRow[]>(
    () => buildPayrollRows(team, intervals, period, timezone, rates, alertHours),
    [intervals, period, rates, team, timezone, alertHours],
  )
  // PAY-1: выбор работника сужает таблицу, итоги, CSV и закрытие периода.
  const rows = useMemo(
    () => (workerFilter ? allRows.filter((r) => r.worker.id === workerFilter) : allRows),
    [allRows, workerFilter],
  )

  // UI-FIX-PACK-1 (г): для frozen-периода таблица/итоги/CSV берут суммы из снапшота (замороженные),
  // иначе — из живого расчёта. Снапшот не даёт метку разрыва (overAlertGapMs=0): её смысл только
  // для текущего пересчёта. Пока снапшот грузится (frozen && snapshot===null) — рисуем пусто, НЕ
  // подсовывая живой пересчёт.
  const snapshotLoading = frozen && snapshot === null
  const displayRows = useMemo<DisplayRow[]>(() => {
    const source: DisplayRow[] = frozen
      ? (snapshot ?? []).map((s) => ({
          id: s.profile_id,
          name: s.worker_name ?? '—',
          regularHours: s.regular_hours,
          overtimeHours: s.overtime_hours,
          travelHours: s.travel_hours,
          rate: s.hourly_rate,
          total: s.total,
          overAlertGapMs: 0,
        }))
      : allRows.map((r) => ({
          id: r.worker.id,
          name: r.worker.name,
          regularHours: r.regularHours,
          overtimeHours: r.overtimeHours,
          travelHours: r.travelHours,
          rate: r.rate,
          total: r.total,
          overAlertGapMs: r.overAlertGapMs,
        }))
    return workerFilter ? source.filter((r) => r.id === workerFilter) : source
  }, [frozen, snapshot, allRows, workerFilter])

  const totals = displayRows.reduce((acc, row) => ({
    regular: acc.regular + row.regularHours,
    overtime: acc.overtime + row.overtimeHours,
    travel: acc.travel + row.travelHours,
    pay: acc.pay + row.total,
  }), { regular: 0, overtime: 0, travel: 0, pay: 0 })

  const locked = !loading && rates.length === 0
  const money = (value: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
  const dateLabel = (d: Date) => d.toLocaleDateString()
  // G1: длительность разрыва как «1ч47м» (для метки внимания в строке зарплаты).
  const fmtGap = (ms: number) => {
    const totalMin = Math.round(ms / 60000)
    return `${Math.floor(totalMin / 60)}${t('h')}${totalMin % 60}${t('min_short')}`
  }
  const endInclusive = new Date(period.end.getTime() - DAY_MS)
  const isDraft = activePreset !== null

  const exportCsv = async () => {
    if (!profile || locked) return
    const lines = [
      ['worker', 'regular_hours', 'ot_hours', 'travel_hours', 'rate', 'total'].map(csvCell).join(','),
      ...displayRows.map((row) => [
        row.name,
        formatHours(row.regularHours),
        formatHours(row.overtimeHours),
        formatHours(row.travelHours),
        row.rate === null ? '' : row.rate,
        row.total.toFixed(2),
      ].map(csvCell).join(',')),
      ['TOTAL', formatHours(totals.regular), formatHours(totals.overtime), formatHours(totals.travel), '', totals.pay.toFixed(2)].map(csvCell).join(','),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `payroll-${period.start.toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    await logEvent(profile, 'payroll.csv_export', 'pay_period', period.id, {
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      workers: displayRows.length,
    })
  }

  const reloadPeriod = async () => {
    const dbPeriod = await getCurrentPayPeriod()
    const win = periodFromDb(dbPeriod)
    setCurrentWindow(win)
    // Держим активное окно в синхроне: если стоим на текущем периоде (не в черновике) — обновим.
    if (!isDraft) setPeriod(win)
  }

  const closePeriod = async () => {
    if (!profile || locked || working) return
    setWorking(true)
    setMsg(null)
    try {
      // A4c: closePayPeriod теперь идёт через транзакционный RPC close_pay_period (пересоздаёт
      // строки в ОДНОЙ транзакции). Для СУЩЕСТВУЮЩЕГО периода (id != null) всегда пишем ВСЕХ
      // работников окна, иначе фильтр «один работник» стёр бы строки остальных. Одиночный
      // работник = только для нового черновика (id == null).
      const source = period.id ? allRows : rows
      const items = source
        .filter((row) => row.regularHours > 0 || row.overtimeHours > 0 || row.rate !== null)
        .map((row) => ({
          profile_id: row.worker.id,
          regular_hours: row.regularHours,
          overtime_hours: row.overtimeHours,
          overtime_multiplier: 1.5,
          // REP-1: пишем разбивку проезда. total НЕ меняется — оплата проезда уже в row.total.
          travel_hours: row.travelHours,
          hourly_rate: row.rate,
          bonus: 0,
          reimbursement: 0,
          deduction: 0,
          // A4a: уже округлённый round-half-up total из buildPayrollRows (computeWorkerTotal).
          total: row.total,
          time_event_ids: [] as string[],
        }))
      const totalPay = source.reduce((s, r) => s + r.total, 0)
      const savedId = await closePayPeriod(profile, {
        payPeriodId: period.id,
        periodStart: ymd(period.start),
        periodEnd: ymd(endInclusive),
        label: `${dateLabel(period.start)} – ${dateLabel(endInclusive)}`,
        items,
        totalPay,
      })
      // Черновик стал реальным периодом → закрепляем его id/статус за активным окном.
      setPeriod((prev) => ({ ...prev, id: savedId, status: 'approved' }))
      await reloadPeriod()
      if (history) setHistory(null) // история устарела — перечитается при открытии
      setMsg('period_closed_ok')
    } catch {
      setMsg('period_action_failed')
    } finally {
      setWorking(false)
    }
  }

  const markPaid = async () => {
    if (!profile || locked || working || !period.id) return
    setWorking(true)
    setMsg(null)
    try {
      await markPayPeriodPaid(profile, period.id, {
        periodStart: ymd(period.start),
        periodEnd: ymd(endInclusive),
        workers: displayRows.length,
        totalPay: totals.pay,
      })
      setPeriod((prev) => ({ ...prev, status: 'paid' }))
      await reloadPeriod()
      if (history) setHistory(null)
      setMsg('period_paid_ok')
    } catch {
      setMsg('period_action_failed')
    } finally {
      setWorking(false)
    }
  }

  // PAY-1: применить пресет. Если под точное окно уже есть период — открываем его (с id/статусом),
  // иначе создаём черновик (id=null), который «Закрыть период» превратит в реальный период.
  const applyPreset = async (key: PresetKey) => {
    const win = presetWindow(key, customStart, customEnd)
    if (!win) return
    setMsg(null)
    setActivePreset(key)
    const existing = await getPayPeriodByExactDates(ymd(win.start), ymd(new Date(win.end.getTime() - DAY_MS)))
    setPeriod(existing ? periodFromDb(existing) : win)
  }

  const resetToCurrent = () => {
    setActivePreset(null)
    if (currentWindow) setPeriod(currentWindow)
  }

  const toggleHistory = async () => {
    const next = !historyOpen
    setHistoryOpen(next)
    if (next && history === null && !historyLoading) {
      setHistoryLoading(true)
      try {
        setHistory(await getArchivePayPeriods())
      } catch {
        setHistory([])
      } finally {
        setHistoryLoading(false)
      }
    }
  }

  const loadReport = async (year: number) => {
    setReportLoading(true)
    try {
      setReport(await getYearlyPayrollReport(`${year}-01-01`, `${year}-12-31`))
    } catch {
      setReport([])
    } finally {
      setReportLoading(false)
    }
  }

  const toggleReport = async () => {
    const next = !reportOpen
    setReportOpen(next)
    if (next && report === null && !reportLoading) await loadReport(reportYear)
  }

  const changeReportYear = async (year: number) => {
    setReportYear(year)
    await loadReport(year)
  }

  const openHistoryPeriod = (p: ArchivePayPeriod) => {
    setActivePreset('custom') // помечаем как «не текущий период», чтобы показать «← Текущий период»
    setPeriod(periodFromArchive(p))
    setMsg(null)
  }

  const thisYear = new Date().getFullYear()
  const reportTotals = (report ?? []).reduce(
    (acc, r) => ({ travel: acc.travel + r.travel_hours, hours: acc.hours + r.total_hours, paid: acc.paid + r.paid }),
    { travel: 0, hours: 0, paid: 0 },
  )

  return (
    <div className="screen payroll-screen">
      <div className="row payroll-head">
        <div>
          <h1>💵 {t('payroll')}</h1>
          <p className="muted">
            {t('pay_period')}: {dateLabel(period.start)} – {dateLabel(endInclusive)}
            {isDraft && <span className="badge amber payroll-draft-badge">{t('pay_draft_badge')}</span>}
          </p>
        </div>
        <div className="payroll-actions">
          {!locked && period.status === 'paid' && (
            <span className="badge green">{t('period_paid_badge')}</span>
          )}
          {!locked && period.status === 'approved' && (
            <button className="btn small" disabled={working} onClick={markPaid}>
              {t('mark_period_paid')}
            </button>
          )}
          {!locked && (period.status === null || period.status === 'draft') && (
            <button className="btn small" disabled={working} onClick={closePeriod}>
              {t('close_period')}
            </button>
          )}
          <button className="btn ghost small" disabled={locked || displayRows.length === 0} onClick={exportCsv}>
            {t('export_csv')}
          </button>
        </div>
      </div>

      {msg && <p className={msg === 'period_action_failed' ? 'error-msg' : 'ok-msg'}>{t(msg)}</p>}
      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {locked && (
        <div className="card payroll-lock">
          <div className="big">🔒</div>
          <div className="item-title">{t('payroll_locked')}</div>
        </div>
      )}

      {!loading && !locked && (
        <>
          {/* PAY-1: черновик зарплаты из текущих часов — пресеты периода + выбор работника. */}
          <div className="card payroll-draft-builder">
            <div className="row payroll-draft-head">
              <h2>{t('pay_draft_title')}</h2>
              {isDraft && (
                <button className="btn ghost small" onClick={resetToCurrent}>← {t('pay_reset_current')}</button>
              )}
            </div>
            <div className="payroll-preset-row">
              <button className={`btn small ${activePreset === 'lastWeek' ? '' : 'ghost'}`} onClick={() => applyPreset('lastWeek')}>{t('pay_preset_last_week')}</button>
              <button className={`btn small ${activePreset === 'last2Weeks' ? '' : 'ghost'}`} onClick={() => applyPreset('last2Weeks')}>{t('pay_preset_2weeks')}</button>
              <button className={`btn small ${activePreset === 'thisMonth' ? '' : 'ghost'}`} onClick={() => applyPreset('thisMonth')}>{t('pay_preset_month')}</button>
            </div>
            <div className="payroll-custom-row">
              <label>{t('pay_from')}<input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} /></label>
              <label>{t('pay_to')}<input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} /></label>
              <button className="btn small ghost" disabled={!customStart || !customEnd} onClick={() => applyPreset('custom')}>{t('pay_preset_custom')}</button>
            </div>
            <div className="payroll-worker-row">
              <label>
                {t('worker')}
                <select value={workerFilter} onChange={(e) => setWorkerFilter(e.target.value)}>
                  <option value="">{t('pay_worker_all')}</option>
                  {team.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </label>
              <button className="btn ghost small" onClick={toggleReport}>📅 {t('pay_year_report')}</button>
              <button className="btn ghost small" onClick={toggleHistory}>🗂 {t('pay_history_title')}</button>
            </div>
          </div>

          {/* PAY-1: годовой отчёт по работникам (часы + оплачено $), read-only агрегация за год. */}
          {reportOpen && (
            <div className="card payroll-report">
              <div className="row payroll-report-head">
                <h2>{t('pay_year_report_title')}</h2>
                <div className="payroll-report-years">
                  {[thisYear, thisYear - 1, thisYear - 2].map((y) => (
                    <button key={y} className={`btn small ${reportYear === y ? '' : 'ghost'}`} onClick={() => changeReportYear(y)}>{y}</button>
                  ))}
                </div>
              </div>
              <p className="muted">{t('pay_year_report_hint')}</p>
              {reportLoading && <div className="card center muted">{t('loading')}</div>}
              {!reportLoading && (report ?? []).length === 0 && <div className="card muted">{t('pay_report_empty')}</div>}
              {!reportLoading && (report ?? []).length > 0 && (
                <div className="payroll-table-wrap">
                  <table className="payroll-table">
                    <thead>
                      <tr>
                        <th>{t('worker')}</th>
                        <th>{t('travel_hours')}</th>
                        <th>{t('pay_col_hours')}</th>
                        <th>{t('pay_report_periods')}</th>
                        <th>{t('pay_col_paid')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(report ?? []).map((r) => (
                        <tr key={r.profile_id}>
                          <td>{r.worker_name ?? '—'}</td>
                          <td>{formatHours(r.travel_hours)}</td>
                          <td>{formatHours(r.total_hours)}</td>
                          <td>{r.periods}</td>
                          <td>{money(r.paid)}</td>
                        </tr>
                      ))}
                      <tr className="payroll-report-total">
                        <td>{t('total')}</td>
                        <td>{formatHours(reportTotals.travel)}</td>
                        <td>{formatHours(reportTotals.hours)}</td>
                        <td></td>
                        <td>{money(reportTotals.paid)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* PAY-1: история закрытых/оплаченных периодов (тот же источник, что вкладка Архива). */}
          {historyOpen && (
            <div className="card payroll-history">
              <h2>{t('pay_history_title')}</h2>
              {historyLoading && <div className="card center muted">{t('loading')}</div>}
              {!historyLoading && (history ?? []).length === 0 && <div className="card muted">{t('pay_history_empty')}</div>}
              {!historyLoading && (history ?? []).map((p) => {
                const hrs = p.items.reduce((s, i) => s + i.regular_hours + i.overtime_hours, 0)
                const gross = p.items.reduce((s, i) => s + i.total, 0)
                return (
                  <div key={p.id} className="payroll-history-row">
                    <div>
                      <span className="item-title">{p.label || `${p.period_start} — ${p.period_end}`}</span>
                      <div className="muted" style={{ fontSize: 12 }}>{p.period_start} — {p.period_end}</div>
                    </div>
                    <div className="payroll-history-meta">
                      <span className={`badge ${p.status === 'paid' ? 'green' : 'amber'}`}>{p.status === 'paid' ? t('period_paid_badge') : t('pay_status_closed')}</span>
                      <span className="badge">{hrs.toFixed(1)}h</span>
                      <span className="badge">{money(gross)}</span>
                      <button className="btn ghost small" onClick={() => openHistoryPeriod(p)}>{t('pay_open')}</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div className="grid2 payroll-totals">
            <div className="card center">
              <div className="big">{formatHours(totals.regular)}</div>
              <div className="muted">{t('regular_hours')}</div>
            </div>
            <div className="card center">
              <div className="big">{formatHours(totals.overtime)}</div>
              <div className="muted">{t('ot_hours')}</div>
            </div>
            <div className="card center">
              <div className="big">{formatHours(totals.travel)}</div>
              <div className="muted">{t('travel_hours')}</div>
            </div>
            <div className="card center">
              <div className="big">{money(totals.pay)}</div>
              <div className="muted">{t('total')}</div>
            </div>
          </div>

          {snapshotLoading && <div className="card center muted">{t('loading')}</div>}
          {!snapshotLoading && displayRows.length === 0 && <div className="card muted">{t('no_payroll_rows')}</div>}
          {!snapshotLoading && displayRows.length > 0 && (
            <div className="card payroll-table-wrap">
              <table className="payroll-table">
                <thead>
                  <tr>
                    <th>{t('worker')}</th>
                    <th>{t('regular_hours')}</th>
                    <th>{t('ot_hours')}</th>
                    <th>{t('travel_hours')}</th>
                    <th>{t('rate')}</th>
                    <th>{t('total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {row.name}
                        {row.overAlertGapMs > 0 && (
                          <span className="badge amber payroll-gap-mark" title={t('payroll_gap_alert_hint')}>
                            ⚠ {fmtGap(row.overAlertGapMs)} — {t('payroll_travel_alert')}
                          </span>
                        )}
                      </td>
                      <td>{formatHours(row.regularHours)}</td>
                      <td>{formatHours(row.overtimeHours)}</td>
                      <td>{formatHours(row.travelHours)}</td>
                      <td>{row.rate === null ? '—' : money(row.rate)}</td>
                      <td>{money(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
