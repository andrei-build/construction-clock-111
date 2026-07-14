import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getProjectHub } from '../lib/api'
import { isManagerRole } from '../lib/types'
import type { ProjectHubData } from '../lib/types'
import OverviewTab from './project-hub/OverviewTab'
import TasksTab from './project-hub/TasksTab'
import TimeTab from './project-hub/TimeTab'
import FinanceTab from './project-hub/FinanceTab'
import FilesTab from './project-hub/FilesTab'
import ReportsTab from './project-hub/ReportsTab'
import NotesTab from './project-hub/NotesTab'
import ClientTab from './project-hub/ClientTab'

type HubTab = 'overview' | 'tasks' | 'time' | 'finance' | 'files' | 'reports' | 'notes' | 'client'

const HUB_TABS: { key: HubTab; labelKey: string; workerVisible?: boolean }[] = [
  { key: 'overview', labelKey: 'hub_tab_overview', workerVisible: true },
  { key: 'tasks', labelKey: 'hub_tab_tasks', workerVisible: true },
  { key: 'time', labelKey: 'hub_tab_time' },
  { key: 'finance', labelKey: 'hub_tab_finance' },
  { key: 'files', labelKey: 'hub_tab_files' },
  { key: 'reports', labelKey: 'hub_tab_reports' },
  { key: 'notes', labelKey: 'hub_tab_notes', workerVisible: true },
  { key: 'client', labelKey: 'hub_tab_client' },
]

function statusBadgeClass(status: string | null | undefined) {
  if (status === 'active') return 'badge green'
  if (status === 'paused') return 'badge amber'
  if (status === 'completed') return 'badge blue'
  return 'badge grey'
}

export default function ProjectHub() {
  const { id } = useParams()
  const { profile } = useAuth()
  const { t } = useI18n()
  const [hub, setHub] = useState<ProjectHubData>({ project: null, profit: null, account: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [tab, setTab] = useState<HubTab>('overview')
  const managerView = profile ? isManagerRole(profile.role) : false
  const visibleTabs = useMemo(
    () => HUB_TABS.filter((item) => managerView || item.workerVisible),
    [managerView],
  )

  useEffect(() => {
    if (!visibleTabs.some((item) => item.key === tab)) setTab('overview')
  }, [tab, visibleTabs])

  useEffect(() => {
    if (!id) return
    let mounted = true
    ;(async () => {
      setLoading(true)
      setError(false)
      try {
        const data = await getProjectHub(id)
        if (mounted) setHub(data)
      } catch {
        if (mounted) setError(true)
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [id, profile?.id])

  const project = hub.project

  return (
    <div className="screen project-hub-screen">
      <div className="worker-detail-head project-hub-head">
        <div>
          <Link className="inline-link muted" to="/projects">{t('hub_back_to_projects')}</Link>
          <h1>{project ? project.name : t('project')}</h1>
          {project?.address && <p className="muted">{project.address}</p>}
        </div>
        {project && (
          <span className={statusBadgeClass(project.status)}>
            {t(`project_status_${project.status}`)}
          </span>
        )}
      </div>

      {loading && <div className="card center muted">{t('loading')}</div>}
      {error && <p className="error-msg">{t('load_error')}</p>}
      {!loading && !error && !project && <div className="card muted">{t('hub_project_not_found')}</div>}

      {!loading && !error && project && (
        <>
          <div className="hub-tabs" role="tablist" aria-label={t('hub_tabs_label')}>
            {visibleTabs.map((tabDef) => (
              <button
                key={tabDef.key}
                type="button"
                role="tab"
                aria-selected={tab === tabDef.key}
                className={tab === tabDef.key ? 'active' : ''}
                onClick={() => setTab(tabDef.key)}
              >
                {t(tabDef.labelKey)}
              </button>
            ))}
          </div>

          {tab === 'overview' && <OverviewTab project={project} profit={hub.profit} account={hub.account} />}
          {tab === 'tasks' && <TasksTab project={project} profile={profile} />}
          {tab === 'time' && <TimeTab />}
          {tab === 'finance' && <FinanceTab />}
          {tab === 'files' && <FilesTab project={project} profile={profile} />}
          {tab === 'reports' && <ReportsTab />}
          {tab === 'notes' && <NotesTab project={project} profile={profile} />}
          {tab === 'client' && <ClientTab />}
        </>
      )}
    </div>
  )
}
