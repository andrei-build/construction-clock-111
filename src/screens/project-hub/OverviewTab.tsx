import { useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { getOpenTasks, getProjectHubFiles, getProjectNotes, getProjectTimeEvents } from '../../lib/api'
import { isEffectiveOpenTask } from '../../lib/task-status'
import type { Account, Project, ProjectProfit, ProjectTimeEvent } from '../../lib/types'
import { getDeadlineInfo, statusDotClass, type TrafficStatus } from './status'

type TileKey = 'deadline' | 'profit' | 'client'
export type OverviewCountTab = 'tasks' | 'time' | 'files' | 'notes'

interface OverviewTabProps {
  project: Project
  profit: ProjectProfit | null
  account: Account | null
  managerView: boolean
  onOpenTab: (tab: OverviewCountTab) => void
}

interface TeamMember {
  profileId: string
  name: string
  totalMs: number
  onShift: boolean
}

interface TeamAggregate {
  members: TeamMember[]
  onShiftCount: number
  totalMs: number
}

interface OverviewCounts {
  tasks: number
  files: number | null
  notes: number
}

// Пары check_in→check_out по работнику (события уже отсортированы по event_time ↑).
// Незакрытый check_in ⇒ работник сейчас в смене; часы считаем без денег, паритет с TimeTab.
function aggregateTeam(events: ProjectTimeEvent[]): TeamAggregate {
  const byWorker = new Map<string, ProjectTimeEvent[]>()
  for (const ev of events) {
    const list = byWorker.get(ev.profile_id)
    if (list) list.push(ev)
    else byWorker.set(ev.profile_id, [ev])
  }
  const members: TeamMember[] = []
  for (const [profileId, rows] of byWorker) {
    let openIn: ProjectTimeEvent | null = null
    let totalMs = 0
    for (const ev of rows) {
      if (ev.event_type === 'check_in') {
        openIn = ev
      } else if (ev.event_type === 'check_out' && openIn) {
        const ms = new Date(ev.event_time).getTime() - new Date(openIn.event_time).getTime()
        if (ms > 0) totalMs += ms
        openIn = null
      }
    }
    const name = rows.find((row) => row.profile?.name)?.profile?.name ?? ''
    members.push({ profileId, name, totalMs, onShift: openIn !== null })
  }
  members.sort(
    (a, b) =>
      Number(b.onShift) - Number(a.onShift) ||
      b.totalMs - a.totalMs ||
      (a.name || '').localeCompare(b.name || ''),
  )
  return {
    members,
    onShiftCount: members.filter((m) => m.onShift).length,
    totalMs: members.reduce((sum, m) => sum + m.totalMs, 0),
  }
}

function formatHours(ms: number) {
  return (ms / 3_600_000).toFixed(1)
}

function formatCount(template: string, value: number | null | undefined) {
  return template.replace('{n}', String(value ?? 0))
}

function formatDate(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString()
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return null
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return null
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
}

function normalizedProfitStatus(profit: ProjectProfit | null): TrafficStatus {
  if (!profit?.profit_status || profit.profit_status === 'grey') return 'neutral'
  return profit.profit_status
}

export default function OverviewTab({ project, profit, account, managerView, onOpenTab }: OverviewTabProps) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState<TileKey | null>(null)
  const [team, setTeam] = useState<TeamAggregate | null>(null)
  const [counts, setCounts] = useState<OverviewCounts | null>(null)
  const [aggLoading, setAggLoading] = useState(true)

  // Сводка «всего по проекту»: команда/часы (только менеджеру — вкладка «Время» тоже manager-only),
  // счётчики задач/файлов/заметок. Файлы тянем только менеджеру (вкладка «Файлы» скрыта работнику).
  useEffect(() => {
    let mounted = true
    ;(async () => {
      setAggLoading(true)
      try {
        const [openTasks, notes, events, files] = await Promise.all([
          getOpenTasks(),
          getProjectNotes(project.id),
          managerView ? getProjectTimeEvents(project.id) : Promise.resolve([] as ProjectTimeEvent[]),
          managerView ? getProjectHubFiles(project.id) : Promise.resolve(null),
        ])
        if (!mounted) return
        const openForProject = openTasks.filter(
          (task) => task.project_id === project.id && isEffectiveOpenTask(task),
        ).length
        setCounts({ tasks: openForProject, files: files ? files.length : null, notes: notes.length })
        setTeam(managerView ? aggregateTeam(events) : null)
      } catch {
        if (mounted) {
          setCounts(null)
          setTeam(null)
        }
      } finally {
        if (mounted) setAggLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [project.id, managerView])

  const deadline = getDeadlineInfo(project)
  const profitStatus = normalizedProfitStatus(profit)
  const clientStatus: TrafficStatus = account?.client_rating ?? 'neutral'
  const budget = formatMoney(project.budget_amount ?? profit?.budget_amount)
  const startDate = formatDate(project.start_date)
  const endDate = formatDate(project.end_date)

  const deadlineValue = deadline.daysOverdue !== null
    ? formatCount(t(deadline.valueKey), deadline.daysOverdue)
    : deadline.daysLeft !== null && deadline.valueKey === 'hub_deadline_days_left_value'
      ? formatCount(t(deadline.valueKey), deadline.daysLeft)
      : t(deadline.valueKey)

  const marginValue = profit?.margin_pct === null || profit?.margin_pct === undefined
    ? t('hub_no_data')
    : `${Math.round(profit.margin_pct * 10) / 10}%`
  const profitSummary = profitStatus === 'neutral' ? t('hub_profit_no_data') : t(`hub_profit_${profitStatus}`)
  const profitBreakdown = [
    `${t('hub_labor')}: ${formatMoney(profit?.labor_cost) ?? t('hub_no_data')}`,
    `${t('hub_expenses')}: ${formatMoney(profit?.expenses_cost) ?? t('hub_no_data')}`,
    `${t('hub_total_cost')}: ${formatMoney(profit?.total_cost) ?? t('hub_no_data')}`,
  ].join(' | ')

  const clientValue = account?.name
    ?? (project.client_account_id ? t('hub_client_missing') : t('hub_client_not_selected'))
  const clientSummary = account?.client_rating
    ? t(`hub_rating_${account.client_rating}`)
    : project.client_account_id
      ? t('hub_client_no_rating')
      : t('hub_client_no_account')
  const clientExplainKey = !project.client_account_id
    ? 'hub_client_no_account_explain'
    : account?.client_rating
      ? `hub_rating_${account.client_rating}_explain`
      : 'hub_client_no_rating_explain'

  const toggle = (key: TileKey) => setExpanded((current) => (current === key ? null : key))

  return (
    <section className="hub-tab-panel">
      <div className="hub-overview-grid">
        <button
          type="button"
          className="card hub-indicator"
          aria-expanded={expanded === 'deadline'}
          onClick={() => toggle('deadline')}
        >
          <div className="hub-indicator-head">
            <span className={statusDotClass(deadline.status)} />
            <span className="item-title">{t('hub_deadline')}</span>
          </div>
          <div className="hub-indicator-value">{deadlineValue}</div>
          <div className="muted hub-dates-row">
            {t('hub_dates')}: {startDate ?? t('hub_no_data')} | {endDate ?? t('hub_no_data')}
          </div>
          {expanded === 'deadline' && <div className="hub-tile-explain">{t(deadline.explanationKey)}</div>}
        </button>

        <button
          type="button"
          className="card hub-indicator"
          aria-expanded={expanded === 'profit'}
          onClick={() => toggle('profit')}
        >
          <div className="hub-indicator-head">
            <span className={statusDotClass(profitStatus)} />
            <span className="item-title">{t('project_margin')}</span>
          </div>
          <div className="hub-indicator-value num-display">{marginValue}</div>
          <div className="muted">{profitSummary}</div>
          <div className="muted hub-breakdown">{profitBreakdown}</div>
          {expanded === 'profit' && (
            <div className="hub-tile-explain">
              {profitStatus === 'neutral' ? t('hub_profit_no_data_explain') : t(`hub_profit_${profitStatus}_explain`)}
            </div>
          )}
        </button>

        <button
          type="button"
          className="card hub-indicator"
          aria-expanded={expanded === 'client'}
          onClick={() => toggle('client')}
          title={account?.rating_note ?? undefined}
        >
          <div className="hub-indicator-head">
            <span className={statusDotClass(clientStatus)} />
            <span className="item-title">{t('hub_client_rating')}</span>
          </div>
          <div className="hub-indicator-value">{clientValue}</div>
          <div className="muted">{clientSummary}</div>
          {account?.rating_note && <div className="muted hub-rating-note">{account.rating_note}</div>}
          {expanded === 'client' && <div className="hub-tile-explain">{t(clientExplainKey)}</div>}
        </button>
      </div>

      <div className="hub-overview-counters">
        <button type="button" className="card hub-counter" onClick={() => onOpenTab('tasks')} title={t('hub_overview_counts_hint')}>
          <span className="hub-counter-num num-display">{aggLoading ? '—' : counts?.tasks ?? 0}</span>
          <span className="muted">{t('hub_overview_open_tasks')}</span>
        </button>
        {managerView && (
          <button type="button" className="card hub-counter" onClick={() => onOpenTab('files')} title={t('hub_overview_counts_hint')}>
            <span className="hub-counter-num num-display">{aggLoading ? '—' : counts?.files ?? 0}</span>
            <span className="muted">{t('hub_tab_files')}</span>
          </button>
        )}
        <button type="button" className="card hub-counter" onClick={() => onOpenTab('notes')} title={t('hub_overview_counts_hint')}>
          <span className="hub-counter-num num-display">{aggLoading ? '—' : counts?.notes ?? 0}</span>
          <span className="muted">{t('hub_tab_notes')}</span>
        </button>
      </div>

      {managerView && (
        <div className="card hub-overview-team">
          <div className="hub-overview-team-head">
            <h2>{t('hub_overview_team')}</h2>
            <button type="button" className="inline-link" onClick={() => onOpenTab('time')}>{t('hub_overview_view_time')}</button>
          </div>
          {aggLoading && <div className="muted">{t('loading')}</div>}
          {!aggLoading && team && team.members.length === 0 && (
            <div className="muted">{t('hub_overview_team_empty')}</div>
          )}
          {!aggLoading && team && team.members.length > 0 && (
            <>
              <div className="hub-overview-team-summary">
                <span className="item-title">
                  {t('hub_overview_on_shift_now').replace('{n}', String(team.onShiftCount))}
                </span>
                <span className="hub-time-hours num-display">{formatHours(team.totalMs)} {t('hub_time_hours')}</span>
              </div>
              <ul className="hub-overview-team-list">
                {team.members.map((member) => (
                  <li className="hub-overview-team-row" key={member.profileId}>
                    <span className="hub-overview-team-name">
                      {member.onShift && <span className="status-dot green" title={t('hub_overview_on_shift_badge')} />}
                      {member.name || t('hub_worker_unknown')}
                      {member.onShift && <span className="badge green hub-on-shift-badge">{t('hub_overview_on_shift_badge')}</span>}
                    </span>
                    <span className="hub-time-hours">{formatHours(member.totalMs)} {t('hub_time_hours')}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="card hub-quick-facts">
        <h2>{t('hub_overview_quick_facts')}</h2>
        <div className="hub-fact-grid">
          {budget && (
            <div className="hub-fact">
              <span className="muted">{t('hub_budget')}</span>
              <span className="item-title num-display">{budget}</span>
            </div>
          )}
          <div className="hub-fact">
            <span className="muted">{t('project_gps_radius')}</span>
            <span className="item-title">{project.gps_radius_m != null ? `${formatNumber(project.gps_radius_m)} ${t('unit_meters')}` : t('hub_no_data')}</span>
          </div>
          <div className="hub-fact hub-fact-wide">
            <span className="muted">{t('hub_project_notes')}</span>
            <span className="item-title hub-project-notes">{project.notes?.trim() || t('hub_project_notes_empty')}</span>
          </div>
        </div>
      </div>
    </section>
  )
}
