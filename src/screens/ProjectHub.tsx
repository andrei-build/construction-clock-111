import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getProjectHub, updateProject } from '../lib/api'
import { isManagerRole, isManagerWrite } from '../lib/types'
import type { ProjectHubData } from '../lib/types'
import OverviewTab from './project-hub/OverviewTab'
import TasksTab from './project-hub/TasksTab'
import TimeTab from './project-hub/TimeTab'
import FinanceTab from './project-hub/FinanceTab'
import FilesTab from './project-hub/FilesTab'
import ReportsTab from './project-hub/ReportsTab'
import NotesTab from './project-hub/NotesTab'
import ClientTab from './project-hub/ClientTab'
import SketchTab from './project-hub/SketchTab'
import MaterialsTab from './project-hub/MaterialsTab'

type HubTab = 'overview' | 'tasks' | 'time' | 'finance' | 'files' | 'reports' | 'notes' | 'client' | 'sketch' | 'materials'

const HUB_TABS: { key: HubTab; labelKey: string; workerVisible?: boolean }[] = [
  { key: 'overview', labelKey: 'hub_tab_overview', workerVisible: true },
  { key: 'tasks', labelKey: 'hub_tab_tasks', workerVisible: true },
  { key: 'time', labelKey: 'hub_tab_time' },
  { key: 'finance', labelKey: 'hub_tab_finance' },
  { key: 'files', labelKey: 'hub_tab_files' },
  { key: 'reports', labelKey: 'hub_tab_reports' },
  { key: 'notes', labelKey: 'hub_tab_notes', workerVisible: true },
  { key: 'sketch', labelKey: 'hub_tab_sketch', workerVisible: true },
  { key: 'materials', labelKey: 'hub_tab_materials', workerVisible: true },
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
  const [searchParams, setSearchParams] = useSearchParams()
  const [hub, setHub] = useState<ProjectHubData>({ project: null, profit: null, account: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const managerView = profile ? isManagerRole(profile.role) : false
  const canWrite = profile ? isManagerWrite(profile.role) : false

  // PROJECT-HEADER-COMPACT-55: имя проекта — кнопка-меню (Переименовать/Детали). Переименование
  // переиспользует существующую мутацию updateProject (адрес сохраняем как есть) — 0 новой схемы/RPC.
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [savingName, setSavingName] = useState(false)
  const identRef = useRef<HTMLDivElement | null>(null)
  const visibleTabs = useMemo(
    () => HUB_TABS.filter((item) => managerView || item.workerVisible),
    [managerView],
  )

  // NAV-STATE-1: активная вкладка живёт в URL (?tab=files), а не в useState — переживает ремоунт
  // (возврат из соседней вкладки браузера, тихий PWA-reload) и восстанавливается кнопкой «назад».
  // Значение вне доступных вкладок (роль/не найдено) деградирует в «Обзор». Смену вкладки пишем с
  // replace, чтобы шаги внутри проекта не копились в истории — «назад» уводит из проекта, как раньше.
  const rawTab = searchParams.get('tab')
  const tab: HubTab = (visibleTabs.find((item) => item.key === rawTab)?.key) ?? 'overview'
  const setTab = (next: HubTab) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'overview') params.delete('tab')
    else params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

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

  // Закрываем меню имени по клику вне области и по Esc.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (identRef.current && !identRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const startRename = () => {
    if (!project) return
    setNameDraft(project.name)
    setRenaming(true)
  }

  const commitRename = async () => {
    const next = nameDraft.trim()
    if (!profile || !project || !id) { setRenaming(false); return }
    if (!next || next === project.name) { setRenaming(false); return }
    setSavingName(true)
    try {
      await updateProject(profile, id, { name: next, address: project.address ?? '' })
      setHub((prev) => (prev.project ? { ...prev, project: { ...prev.project, name: next } } : prev))
    } catch {
      // сеть/RLS — тихо откатываем в режим просмотра, имя остаётся прежним
    } finally {
      setSavingName(false)
      setRenaming(false)
    }
  }

  return (
    <div className="screen project-hub-screen">
      {/* PROJECT-HEADER-COMPACT-55: единая компактная панель (≤44px): back + имя·адрес + все
          табы + бейдж статуса — вместо трёх верхних этажей. Табы скроллятся горизонтально на узких. */}
      <div className="project-hub-head ph-compact">
        <Link className="ph-back" to="/projects" aria-label={t('hub_back_to_projects')} title={t('hub_back_to_projects')}>←</Link>
        <div className="ph-ident" ref={identRef}>
          {renaming ? (
            <input
              className="ph-name-input"
              value={nameDraft}
              autoFocus
              disabled={savingName}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => { void commitRename() }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { void commitRename() }
                else if (e.key === 'Escape') { setRenaming(false) }
              }}
              aria-label={t('hub_menu_rename')}
            />
          ) : (
            <button
              type="button"
              className="ph-name"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={!project}
            >
              {project ? project.name : t('project')}
            </button>
          )}
          {project?.address && (
            <span className="ph-address muted" title={project.address}>{project.address}</span>
          )}
          {menuOpen && project && !renaming && (
            <div className="ph-name-menu" role="menu">
              {canWrite && (
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); startRename() }}>
                  {t('hub_menu_rename')}
                </button>
              )}
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setTab('overview') }}>
                {t('hub_menu_details')}
              </button>
            </div>
          )}
        </div>
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
          {tab === 'overview' && (
            <OverviewTab
              project={project}
              profit={hub.profit}
              account={hub.account}
              profile={profile}
              managerView={managerView}
              onOpenTab={(next) => setTab(next)}
            />
          )}
          {tab === 'tasks' && <TasksTab project={project} profile={profile} />}
          {tab === 'time' && <TimeTab project={project} />}
          {tab === 'finance' && <FinanceTab project={project} profile={profile} />}
          {tab === 'files' && <FilesTab project={project} profile={profile} />}
          {tab === 'reports' && <ReportsTab project={project} />}
          {tab === 'notes' && <NotesTab project={project} profile={profile} />}
          {tab === 'sketch' && <SketchTab project={project} profile={profile} />}
          {tab === 'materials' && <MaterialsTab project={project} profile={profile} />}
          {tab === 'client' && (
            <ClientTab
              project={project}
              profile={profile}
              onClientChanged={(clientAccountId) =>
                setHub((prev) => (prev.project ? { ...prev, project: { ...prev.project, client_account_id: clientAccountId } } : prev))
              }
            />
          )}
        </>
      )}
    </div>
  )
}
