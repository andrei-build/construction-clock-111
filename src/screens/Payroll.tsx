import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { closePayPeriod, getCurrentPayPeriod, getIntervalsBetween, getTeam, getVisibleProfileRates, logEvent, markPayPeriodPaid } from '../lib/api'
import type { PayPeriod, Profile, ProfileRate, WorkInterval } from '../lib/types'

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
  rate: number | null
  total: number
}

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

// Часы по неделям из v_work_intervals (корректировки уже применены); неделя — по start_at интервала
function weeklyHours(intervals: WorkInterval[], period: PeriodWindow, now = Date.now()) {
  const weeks = new Map<string, number>()
  for (const interval of intervals) {
    const startMs = new Date(interval.start_at).getTime()
    if (startMs < period.start.getTime() || startMs >= period.end.getTime()) continue
    const endMs = interval.end_at ? new Date(interval.end_at).getTime() : Math.min(now, period.end.getTime())
    const hours = Math.max(0, endMs - startMs) / 3600000
    const key = weekKey(startMs)
    weeks.set(key, (weeks.get(key) ?? 0) + hours)
  }
  return weeks
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
  const [period, setPeriod] = useState<PeriodWindow>(() => fallbackPeriod())
  const [team, setTeam] = useState<Profile[]>([])
  const [intervals, setIntervals] = useState<WorkInterval[]>([])
  const [rates, setRates] = useState<ProfileRate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [working, setWorking] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const dbPeriod = await getCurrentPayPeriod()
        const currentPeriod = periodFromDb(dbPeriod)
        const [workers, intervalRows, visibleRates] = await Promise.all([
          getTeam(),
          getIntervalsBetween(currentPeriod.start.toISOString(), currentPeriod.end.toISOString()),
          getVisibleProfileRates(),
        ])
        if (!mounted) return
        setPeriod(currentPeriod)
        setTeam(workers)
        setIntervals(intervalRows)
        setRates(visibleRates)
      } catch {
        if (mounted) setError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  const rows = useMemo<PayrollRow[]>(() => {
    const byWorker = new Map<string, WorkInterval[]>()
    for (const interval of intervals) {
      if (!byWorker.has(interval.profile_id)) byWorker.set(interval.profile_id, [])
      byWorker.get(interval.profile_id)!.push(interval)
    }

    const rateByWorker = new Map(rates.map((r) => [r.profile_id, r.hourly_rate === null ? null : Number(r.hourly_rate)]))

    return team
      .filter((worker) => byWorker.has(worker.id) || rateByWorker.has(worker.id))
      .map((worker) => {
        const weeks = weeklyHours(byWorker.get(worker.id) ?? [], period)
        let regularHours = 0
        let overtimeHours = 0
        for (const hours of weeks.values()) {
          regularHours += Math.min(hours, 40)
          overtimeHours += Math.max(0, hours - 40)
        }
        const rate = rateByWorker.get(worker.id) ?? null
        const total = rate === null ? 0 : (regularHours * rate) + (overtimeHours * rate * 1.5)
        return { worker, regularHours, overtimeHours, rate, total }
      })
      .sort((a, b) => a.worker.name.localeCompare(b.worker.name))
  }, [intervals, period, rates, team])

  const totals = rows.reduce((acc, row) => ({
    regular: acc.regular + row.regularHours,
    overtime: acc.overtime + row.overtimeHours,
    pay: acc.pay + row.total,
  }), { regular: 0, overtime: 0, pay: 0 })

  const locked = !loading && rates.length === 0
  const money = (value: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
  const dateLabel = (d: Date) => d.toLocaleDateString()
  const endInclusive = new Date(period.end.getTime() - DAY_MS)

  const exportCsv = async () => {
    if (!profile || locked) return
    const lines = [
      ['worker', 'regular_hours', 'ot_hours', 'rate', 'total'].map(csvCell).join(','),
      ...rows.map((row) => [
        row.worker.name,
        formatHours(row.regularHours),
        formatHours(row.overtimeHours),
        row.rate === null ? '' : row.rate,
        row.total.toFixed(2),
      ].map(csvCell).join(',')),
      ['TOTAL', formatHours(totals.regular), formatHours(totals.overtime), '', totals.pay.toFixed(2)].map(csvCell).join(','),
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
      workers: rows.length,
    })
  }

  const reloadPeriod = async () => {
    const dbPeriod = await getCurrentPayPeriod()
    setPeriod(periodFromDb(dbPeriod))
  }

  const closePeriod = async () => {
    if (!profile || locked || working) return
    setWorking(true)
    setMsg(null)
    try {
      const items = rows
        .filter((row) => row.regularHours > 0 || row.overtimeHours > 0 || row.rate !== null)
        .map((row) => ({
          profile_id: row.worker.id,
          regular_hours: row.regularHours,
          overtime_hours: row.overtimeHours,
          hourly_rate: row.rate,
          total: row.total,
        }))
      await closePayPeriod(profile, {
        payPeriodId: period.id,
        periodStart: ymd(period.start),
        periodEnd: ymd(endInclusive),
        label: `${dateLabel(period.start)} – ${dateLabel(endInclusive)}`,
        items,
        totalPay: totals.pay,
      })
      await reloadPeriod()
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
        workers: rows.length,
        totalPay: totals.pay,
      })
      await reloadPeriod()
      setMsg('period_paid_ok')
    } catch {
      setMsg('period_action_failed')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="screen payroll-screen">
      <div className="row payroll-head">
        <div>
          <h1>💵 {t('payroll')}</h1>
          <p className="muted">{t('pay_period')}: {dateLabel(period.start)} – {dateLabel(endInclusive)}</p>
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
          <button className="btn ghost small" disabled={locked || rows.length === 0} onClick={exportCsv}>
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
              <div className="big">{money(totals.pay)}</div>
              <div className="muted">{t('total')}</div>
            </div>
          </div>

          {rows.length === 0 && <div className="card muted">{t('no_payroll_rows')}</div>}
          {rows.length > 0 && (
            <div className="card payroll-table-wrap">
              <table className="payroll-table">
                <thead>
                  <tr>
                    <th>{t('worker')}</th>
                    <th>{t('regular_hours')}</th>
                    <th>{t('ot_hours')}</th>
                    <th>{t('rate')}</th>
                    <th>{t('total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.worker.id}>
                      <td>{row.worker.name}</td>
                      <td>{formatHours(row.regularHours)}</td>
                      <td>{formatHours(row.overtimeHours)}</td>
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
