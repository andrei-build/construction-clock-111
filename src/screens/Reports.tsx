import { useEffect, useMemo, useState } from 'react'
import { getReportRows } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import type { ReportCell, ReportKind, ReportRow } from '../lib/types'

const reportTabs: ReportKind[] = ['hours', 'payroll', 'expenses']
const numericSkip = /(^|_)id$|pin|phone|zip|number/i

function dateValue(date: Date) {
  return date.toISOString().slice(0, 10)
}

function daysAgo(days: number) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return dateValue(d)
}

function startOfMonth() {
  const d = new Date()
  d.setDate(1)
  return dateValue(d)
}

function defaultFrom() {
  return daysAgo(13)
}

const rangePresets = ['current_period', '2w', 'month', '3m', 'year'] as const
type RangePreset = typeof rangePresets[number]

// Purely client-side ranges; end is always today. `current_period` uses the
// start of the calendar month (no pay_periods dependency — DB untouched).
function presetRange(preset: RangePreset) {
  const to = dateValue(new Date())
  switch (preset) {
    case 'current_period': return { from: startOfMonth(), to }
    case '2w': return { from: daysAgo(13), to }
    case 'month': return { from: daysAgo(29), to }
    case '3m': return { from: daysAgo(89), to }
    case 'year': return { from: daysAgo(364), to }
  }
}

const rangeLabelKey: Record<RangePreset | 'custom', string> = {
  current_period: 'range_current_period',
  '2w': 'range_2w',
  month: 'range_month',
  '3m': 'range_3m',
  year: 'range_year',
  custom: 'range_custom',
}

function csvCell(value: ReportCell | undefined) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

function toNumber(value: ReportCell | undefined) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function errorMessage(error: unknown) {
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '')
  }
  return String(error ?? '')
}

export default function Reports() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [kind, setKind] = useState<ReportKind>('hours')
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(() => dateValue(new Date()))
  const [rows, setRows] = useState<ReportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      if (from > to) {
        setRows([])
        setError(t('date_range_invalid'))
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)
      try {
        const data = await getReportRows(kind, from, to)
        if (!mounted) return
        setRows(data)
      } catch (err) {
        if (!mounted) return
        const message = errorMessage(err)
        setRows([])
        setError(message.toLowerCase().includes('finance access required') ? t('reports_finance_required') : t('load_error'))
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [from, kind, profile?.id, t, to])

  const activePreset = useMemo<RangePreset | 'custom'>(() => {
    for (const preset of rangePresets) {
      const range = presetRange(preset)
      if (range.from === from && range.to === to) return preset
    }
    return 'custom'
  }, [from, to])

  const applyPreset = (preset: RangePreset) => {
    const range = presetRange(preset)
    setFrom(range.from)
    setTo(range.to)
  }

  const columns = useMemo(() => {
    const keys: string[] = []
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!keys.includes(key)) keys.push(key)
      }
    }
    return keys
  }, [rows])

  const numericColumns = useMemo(() => (
    columns.filter((column) => !numericSkip.test(column) && rows.some((row) => toNumber(row[column]) !== null))
  ), [columns, rows])

  const totals = useMemo(() => {
    const result: Record<string, number> = {}
    for (const column of numericColumns) {
      result[column] = rows.reduce((sum, row) => sum + (toNumber(row[column]) ?? 0), 0)
    }
    return result
  }, [numericColumns, rows])

  const hasTotals = numericColumns.length > 0

  const columnLabel = (column: string) => {
    const key = `report_col_${column}`
    const translated = t(key)
    if (translated !== key) return translated
    return column.replace(/_/g, ' ')
  }

  const formatCell = (column: string, value: ReportCell | undefined) => {
    const n = toNumber(value)
    if (n !== null && /(amount|cost|pay|payroll|total|rate|expense)/i.test(column)) {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n)
    }
    if (n !== null && /(hours|hrs|duration)/i.test(column)) return n.toFixed(2)
    if (typeof value === 'boolean') return value ? t('yes') : t('no')
    return value ?? ''
  }

  const exportCsv = () => {
    if (rows.length === 0) return
    const lines = [
      columns.map(csvCell).join(','),
      ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
    ]
    if (hasTotals) {
      lines.push(columns.map((column, index) => {
        if (index === 0) return csvCell(t('total'))
        return numericColumns.includes(column) ? csvCell(totals[column].toFixed(2)) : csvCell('')
      }).join(','))
    }
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `report-${kind}-${from}-${to}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="screen reports-screen">
      <div className="row reports-head">
        <div>
          <h1>📈 {t('reports')}</h1>
          <p className="muted">{from} – {to}</p>
        </div>
        <button className="btn ghost small" disabled={rows.length === 0} onClick={exportCsv}>
          {t('export_csv')}
        </button>
      </div>

      <div className="tabs reports-range">
        {rangePresets.map((preset) => (
          <button
            key={preset}
            className={activePreset === preset ? 'active' : ''}
            onClick={() => applyPreset(preset)}
          >
            {t(rangeLabelKey[preset])}
          </button>
        ))}
        <button type="button" className={activePreset === 'custom' ? 'active' : ''} disabled>
          {t(rangeLabelKey.custom)}
        </button>
      </div>

      <div className="card reports-filter">
        <div className="grid2">
          <div>
            <label>{t('date_from')}</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label>{t('date_to')}</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="tabs">
        {reportTabs.map((tab) => (
          <button key={tab} className={kind === tab ? 'active' : ''} onClick={() => setKind(tab)}>
            {t(`report_${tab}`)}
          </button>
        ))}
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{error}</p>}
      {!loading && !error && rows.length === 0 && <div className="card muted">{t('no_report_rows')}</div>}

      {!loading && !error && rows.length > 0 && (
        <div className="card reports-table-wrap">
          <table className="reports-table">
            <thead>
              <tr>
                {columns.map((column) => <th key={column}>{columnLabel(column)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => <td key={column}>{formatCell(column, row[column])}</td>)}
                </tr>
              ))}
              {hasTotals && (
                <tr className="reports-total-row">
                  {columns.map((column, index) => (
                    <td key={column}>
                      {index === 0 ? t('total') : numericColumns.includes(column) ? formatCell(column, totals[column]) : ''}
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
