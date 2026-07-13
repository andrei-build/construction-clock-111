import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { isManagerRole } from '../lib/types'
import { getDailyReports, createDailyReport, getProjects } from '../lib/api'
import type { DailyReport, Project } from '../lib/types'

const localeByLang = {
  ru: 'ru-RU',
  en: 'en-US',
  es: 'es-ES',
} as const

// Локальная дата в формате YYYY-MM-DD (без сдвига в UTC), под столбец report_date::date.
function todayValue() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export default function DailyReports() {
  const { profile } = useAuth()
  const { t, lang } = useI18n()
  const manager = profile ? isManagerRole(profile.role) : false

  const [reports, setReports] = useState<DailyReport[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const [projectId, setProjectId] = useState('')
  const [reportDate, setReportDate] = useState(todayValue)
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  const [filterProject, setFilterProject] = useState('')

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      setError(false)
      try {
        const [r, pr] = await Promise.all([getDailyReports(), getProjects()])
        if (mounted) {
          setReports(r)
          setProjects(pr)
        }
      } catch {
        if (mounted) {
          setReports([])
          setProjects([])
          setError(true)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [profile?.id])

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(localeByLang[lang], { day: '2-digit', month: 'short', year: 'numeric' })
      .format(new Date(`${iso}T12:00:00`))

  const visible = useMemo(
    () => (filterProject ? reports.filter((r) => r.project_id === filterProject) : reports),
    [reports, filterProject],
  )

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!profile || saving || !projectId || !body.trim()) return
    setSaving(true)
    setSaveError(false)
    try {
      const created = await createDailyReport(profile, { projectId, reportDate, body: body.trim() })
      if (created) setReports((rows) => [created, ...rows])
      setBody('')
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="screen">
      <h1>📋 {t('daily_reports')}</h1>

      <form className="card" onSubmit={handleSubmit}>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
          <option value="" disabled>{t('daily_pick_project')}</option>
          {projects.map((pr) => (
            <option key={pr.id} value={pr.id}>{pr.name}</option>
          ))}
        </select>
        <input
          type="date"
          value={reportDate}
          max={todayValue()}
          onChange={(e) => setReportDate(e.target.value)}
          required
        />
        <textarea
          placeholder={t('daily_body_placeholder')}
          value={body}
          rows={4}
          onChange={(e) => setBody(e.target.value)}
          required
        />
        {saveError && <p className="error-msg">{t('daily_save_failed')}</p>}
        <button type="submit" className="btn" disabled={saving || !projectId || !body.trim()}>
          {saving ? t('daily_saving') : t('daily_submit')}
        </button>
      </form>

      {projects.length > 1 && (
        <div className="timeline-filters" aria-label={t('daily_filter')}>
          <button
            type="button"
            className={`timeline-chip ${filterProject === '' ? 'active' : ''}`}
            onClick={() => setFilterProject('')}
          >
            {t('daily_all_projects')}
          </button>
          {projects.map((pr) => (
            <button
              key={pr.id}
              type="button"
              className={`timeline-chip ${filterProject === pr.id ? 'active' : ''}`}
              onClick={() => setFilterProject(pr.id)}
            >
              {pr.name}
            </button>
          ))}
        </div>
      )}

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {!loading && !error && visible.length === 0 && <div className="card muted">{t('daily_empty')}</div>}

      {!loading && !error && visible.map((r) => (
        <div key={r.id} className="card">
          <div className="row">
            <span className="item-title">{r.project?.name ?? t('daily_unknown_project')}</span>
            <span className="badge blue">{formatDate(r.report_date)}</span>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {manager ? (r.author?.name ?? t('daily_unknown_author')) : t('daily_you')}
          </div>
          <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{r.body}</p>
        </div>
      ))}
    </div>
  )
}
