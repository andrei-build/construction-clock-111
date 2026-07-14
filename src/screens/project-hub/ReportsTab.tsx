import { useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { getProjectDailyReports } from '../../lib/api'
import type { DailyReport, Project } from '../../lib/types'

interface ReportsTabProps {
  project: Project
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value ?? '—'
  return date.toLocaleDateString()
}

export default function ReportsTab({ project }: ReportsTabProps) {
  const { t } = useI18n()
  const [reports, setReports] = useState<DailyReport[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      setLoading(true)
      setLoadError(false)
      try {
        const rows = await getProjectDailyReports(project.id)
        if (mounted) setReports(rows)
      } catch {
        if (mounted) setLoadError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [project.id])

  return (
    <section className="hub-tab-panel hub-reports">
      {loading && <div className="card center muted">{t('loading')}</div>}
      {loadError && <p className="error-msg">{t('hub_reports_load_error')}</p>}
      {!loading && !loadError && reports.length === 0 && <div className="card muted">{t('hub_reports_empty')}</div>}

      {!loading && !loadError && reports.length > 0 && (
        <div className="hub-reports-list">
          {reports.map((report) => (
            <div className="card" key={report.id}>
              <div className="hub-note-head">
                <span className="item-title">{formatDate(report.report_date)}</span>
                <span className="muted">{report.author?.name ?? t('hub_report_author_unknown')}</span>
              </div>
              <div className="hub-report-body">{report.body}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
