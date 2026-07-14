import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { isManagerWrite } from '../lib/types'
import { getArchiveProjectsSummary, getArchivePayPeriods, getDeactivatedWorkers } from '../lib/api'
import type { ArchiveProjectSummary, ArchivePayPeriod, DeactivatedWorker } from '../lib/types'

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

// ARCH-1: экран «Архив» — связанная история (архивные проекты + закрытая/оплаченная зарплата).
// Корзина (мягко удалённые сущности) живёт отдельно на /trash. Маршрут гейтится менеджером в App.tsx.
export default function Archive() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const hasFinance = profile ? isManagerWrite(profile.role) : false

  const [tab, setTab] = useState<'projects' | 'payroll'>('projects')
  const [projects, setProjects] = useState<ArchiveProjectSummary[]>([])
  const [periods, setPeriods] = useState<ArchivePayPeriod[]>([])
  const [deactivated, setDeactivated] = useState<DeactivatedWorker[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const [query, setQuery] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [p, pay, deac] = await Promise.all([
          getArchiveProjectsSummary(),
          hasFinance ? getArchivePayPeriods() : Promise.resolve([] as ArchivePayPeriod[]),
          getDeactivatedWorkers(),
        ])
        if (mounted) {
          setProjects(p)
          setPeriods(pay)
          setDeactivated(deac)
        }
      } catch {
        if (mounted) {
          setProjects([])
          setPeriods([])
          setDeactivated([])
          setError(true)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id, hasFinance])

  const formatDate = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(localeByLang[lang], { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso)) : t('archive_not_recorded')

  const inDateRange = (iso: string | null): boolean => {
    if (!iso) return !fromDate && !toDate ? true : false
    const day = iso.slice(0, 10)
    if (fromDate && day < fromDate) return false
    if (toDate && day > toDate) return false
    return true
  }

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects.filter((p) => {
      if (!inDateRange(p.archived_at)) return false
      if (!q) return true
      return p.name.toLowerCase().includes(q) || (p.address ?? '').toLowerCase().includes(q)
    })
  }, [projects, query, fromDate, toDate])

  const filteredPeriods = useMemo(() => {
    const q = query.trim().toLowerCase()
    return periods
      .filter((period) => inDateRange(period.period_start) || inDateRange(period.period_end))
      .map((period) => {
        if (!q) return period
        const items = period.items.filter((i) => (i.worker_name ?? '').toLowerCase().includes(q))
        return { ...period, items }
      })
      .filter((period) => !q || period.items.length > 0)
  }, [periods, query, fromDate, toDate])

  const projectStats = useMemo(() => ({
    count: filteredProjects.length,
    tasks: filteredProjects.reduce((s, p) => s + p.taskCount, 0),
    files: filteredProjects.reduce((s, p) => s + p.mediaCount, 0),
    hours: filteredProjects.reduce((s, p) => s + p.hours, 0),
  }), [filteredProjects])

  const payrollStats = useMemo(() => {
    let paidHours = 0
    let gross = 0
    for (const period of filteredPeriods) {
      for (const i of period.items) {
        paidHours += i.regular_hours + i.overtime_hours
        gross += i.total
      }
    }
    return { paidHours, gross, periods: filteredPeriods.length }
  }, [filteredPeriods])

  const hasDateRange = Boolean(fromDate || toDate)
  const statusLabel = (status: string | null) =>
    status === 'paid' ? t('archive_status_paid') : status === 'approved' ? t('archive_status_approved') : (status ?? '—')

  return (
    <div className="screen">
      <div className="archive-head">
        <div>
          <div className="archive-eyebrow">{t('archive_eyebrow')}</div>
          <h1>🗄️ {t('archive_title')}</h1>
        </div>
        <Link to="/trash" className="btn ghost small">{t('archive_open_trash')}</Link>
      </div>
      <p className="muted" style={{ marginTop: -8 }}>{t('archive_desc')}</p>

      <div className="tabs">
        <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>{t('archive_projects')}</button>
        <button className={tab === 'payroll' ? 'active' : ''} onClick={() => setTab('payroll')}>{t('archive_tab_payroll')}</button>
      </div>

      <div className="archive-filters">
        <input
          className="archive-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === 'projects' ? t('archive_search_projects') : t('archive_search_payroll')}
        />
        <div className="archive-dates">
          <label>{t('archive_from')}<input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label>
          <label>{t('archive_to')}<input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
          {hasDateRange && (
            <button type="button" className="btn ghost small" onClick={() => { setFromDate(''); setToDate('') }}>
              {t('archive_clear_dates')}
            </button>
          )}
        </div>
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}

      {!loading && !error && tab === 'projects' && (
        <>
          <div className="project-stat-tiles archive-stat-tiles">
            <div className="project-stat-tile"><span className="muted">{t('archive_stat_projects')}</span><span className="archive-stat-value">{projectStats.count}</span></div>
            <div className="project-stat-tile"><span className="muted">{t('archive_stat_tasks')}</span><span className="archive-stat-value">{projectStats.tasks}</span></div>
            <div className="project-stat-tile"><span className="muted">{t('archive_stat_files')}</span><span className="archive-stat-value">{projectStats.files}</span></div>
            <div className="project-stat-tile"><span className="muted">{t('archive_stat_hours')}</span><span className="archive-stat-value">{projectStats.hours.toFixed(1)}h</span></div>
          </div>

          {filteredProjects.length === 0 ? (
            <div className="card muted">{t('archive_no_projects')}</div>
          ) : (
            filteredProjects.map((p) => (
              <div key={p.id} className="card">
                <div className="row">
                  <div>
                    <span className="item-title">{p.name}</span>
                    <div className="muted" style={{ fontSize: 12 }}>{p.address || t('archive_no_address')}</div>
                  </div>
                  <div className="muted" style={{ fontSize: 12, textAlign: 'right' }}>
                    {t('archive_col_archived')}<br />{formatDate(p.archived_at)}
                  </div>
                </div>
                <div className="archive-project-meta">
                  <span className="badge">{p.hours.toFixed(1)}h · {p.workerCount} {t('archive_workers')}</span>
                  <span className="badge">{p.completedTaskCount}/{p.taskCount} {t('archive_done')}</span>
                  <span className="badge amber">{p.mediaCount} {t('archive_files')}</span>
                </div>
                <div className="project-nav-actions">
                  <Link to={`/projects/${p.id}`} className="btn small">{t('archive_open')}</Link>
                </div>
              </div>
            ))
          )}
        </>
      )}

      {!loading && !error && tab === 'payroll' && (
        <>
          {!hasFinance ? (
            <div className="card">
              <div className="item-title">🔒 {t('archive_payroll_locked_title')}</div>
              <p className="muted" style={{ marginTop: 6 }}>{t('archive_payroll_locked_desc')}</p>
            </div>
          ) : (
            <>
              <div className="project-stat-tiles archive-stat-tiles">
                <div className="project-stat-tile"><span className="muted">{t('archive_stat_paid_hours')}</span><span className="archive-stat-value">{payrollStats.paidHours.toFixed(1)}h</span></div>
                <div className="project-stat-tile"><span className="muted">{t('archive_stat_gross')}</span><span className="archive-stat-value">{currency.format(payrollStats.gross)}</span></div>
                <div className="project-stat-tile"><span className="muted">{t('archive_stat_periods')}</span><span className="archive-stat-value">{payrollStats.periods}</span></div>
              </div>

              {filteredPeriods.length === 0 ? (
                <div className="card muted">{t('archive_no_payroll')}</div>
              ) : (
                filteredPeriods.map((period) => {
                  const periodHours = period.items.reduce((s, i) => s + i.regular_hours + i.overtime_hours, 0)
                  const periodGross = period.items.reduce((s, i) => s + i.total, 0)
                  return (
                    <div key={period.id} className="card">
                      <div className="row">
                        <div>
                          <span className="item-title">{period.label || `${period.period_start} — ${period.period_end}`}</span>
                          <div className="muted" style={{ fontSize: 12 }}>{period.period_start} — {period.period_end}</div>
                        </div>
                        <span className={`badge ${period.status === 'paid' ? 'green' : 'amber'}`}>{statusLabel(period.status)}</span>
                      </div>
                      <div className="archive-project-meta">
                        <span className="badge">{periodHours.toFixed(1)}h</span>
                        <span className="badge">{currency.format(periodGross)}</span>
                        <span className="badge">{period.items.length} {t('archive_workers')}</span>
                        {period.paid_at && <span className="muted" style={{ fontSize: 12 }}>{t('archive_paid_on')}: {formatDate(period.paid_at)}</span>}
                      </div>
                      {period.items.map((i) => (
                        <div key={`${period.id}-${i.profile_id}`} className="archive-pay-row">
                          <Link to={`/team/${i.profile_id}`} className="archive-pay-name">{i.worker_name ?? '—'}</Link>
                          <span className="muted">{(i.regular_hours + i.overtime_hours).toFixed(1)}h</span>
                          <span>{currency.format(i.total)}</span>
                        </div>
                      ))}
                    </div>
                  )
                })
              )}

              <h2>{t('archive_deactivated_title')}</h2>
              {deactivated.length === 0 ? (
                <div className="card muted">{t('archive_no_deactivated')}</div>
              ) : (
                deactivated.map((w) => (
                  <div key={w.id} className="card row">
                    <div>
                      <span className="item-title">{w.name}</span>
                      <div className="muted" style={{ fontSize: 12 }}>{w.role}</div>
                    </div>
                    <Link to={`/team/${w.id}`} className="btn small ghost">{t('archive_open')}</Link>
                  </div>
                ))
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
