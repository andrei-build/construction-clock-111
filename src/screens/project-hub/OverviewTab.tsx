import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../../lib/i18n'
import { getOpenTasks, getProjectCalendarEvents, getProjectHubFiles, getProjectNotes, getProjectTimeEvents, getScheduleAssignments, getTeam } from '../../lib/api'
import { isEffectiveOpenTask } from '../../lib/task-status'
import { hasFinanceAccess } from '../../lib/types'
import type { Account, CalendarEvent, Profile, Project, ProjectProfit, ProjectTimeEvent, ScheduleAssignment } from '../../lib/types'
import { getDeadlineInfo, statusDotClass, type TrafficStatus } from './status'
import { isDateRangeInvalid } from '../../lib/project-schedule'
import ProjectNavActions from '../../components/ProjectNavActions'

type TileKey = 'deadline' | 'profit' | 'client'
export type OverviewCountTab = 'tasks' | 'time' | 'files' | 'notes'

interface OverviewTabProps {
  project: Project
  profit: ProjectProfit | null
  account: Account | null
  profile: Profile | null
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

// PROJ-1b STEP 3: назначения проекта, сгруппированные по дню (project_assignments не датируется
// по дням — группируем по assigned_at, паритет с допущением Schedule.tsx). Имена резолвим из team.
interface ScheduleDay {
  key: string
  label: string
  workers: string[]
}

const UNDATED_KEY = '__undated'

function groupScheduleByDay(
  assignments: ScheduleAssignment[],
  namesById: Map<string, string>,
  labels: { undated: string; unknown: string },
): ScheduleDay[] {
  const byDay = new Map<string, ScheduleDay>()
  for (const a of assignments) {
    const day = a.assigned_at ? a.assigned_at.slice(0, 10) : ''
    const key = day || UNDATED_KEY
    let entry = byDay.get(key)
    if (!entry) {
      entry = { key, label: day ? (formatDate(day) ?? day) : labels.undated, workers: [] }
      byDay.set(key, entry)
    }
    const name = namesById.get(a.profile_id) || labels.unknown
    if (!entry.workers.includes(name)) entry.workers.push(name)
  }
  // Датированные дни — по убыванию (свежие сверху); «без даты» — в конце.
  return [...byDay.values()].sort((x, y) => {
    if (x.key === UNDATED_KEY) return 1
    if (y.key === UNDATED_KEY) return -1
    return y.key.localeCompare(x.key)
  })
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

// REP-1: дата+время события календаря (starts_at — полный ISO-таймстамп, не YYYY-MM-DD).
function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
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

export default function OverviewTab({ project, profit, account, profile, managerView, onOpenTab }: OverviewTabProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  // A2: маржа/себестоимость/бюджет — только при доступе к финансам (owner/admin ИЛИ finance_access).
  // Без доступа блок не рендерим вовсе (v_project_profit вернёт NULL — не показываем серые нули).
  const financeAllowed = hasFinanceAccess(profile)
  const [expanded, setExpanded] = useState<TileKey | null>(null)
  const [team, setTeam] = useState<TeamAggregate | null>(null)
  const [counts, setCounts] = useState<OverviewCounts | null>(null)
  const [aggLoading, setAggLoading] = useState(true)
  // REP-1: события календаря проекта (calendar_events.project_id) — секция «События проекта».
  const [projectEvents, setProjectEvents] = useState<CalendarEvent[]>([])
  // PROJ-1b STEP 3: расписание проекта (назначения) + имена команды; секция сворачиваемая.
  const [scheduleAssignments, setScheduleAssignments] = useState<ScheduleAssignment[]>([])
  const [scheduleNames, setScheduleNames] = useState<Map<string, string>>(new Map())
  const [scheduleOpen, setScheduleOpen] = useState(false)

  // Сводка «всего по проекту»: команда/часы (только менеджеру — вкладка «Время» тоже manager-only),
  // счётчики задач/файлов/заметок. Файлы тянем только менеджеру (вкладка «Файлы» скрыта работнику).
  useEffect(() => {
    let mounted = true
    ;(async () => {
      setAggLoading(true)
      try {
        const [openTasks, notes, events, files, scheduleRows, teamRows, calendarEvents] = await Promise.all([
          getOpenTasks(),
          getProjectNotes(project.id),
          managerView ? getProjectTimeEvents(project.id) : Promise.resolve([] as ProjectTimeEvent[]),
          managerView ? getProjectHubFiles(project.id) : Promise.resolve(null),
          // PROJ-1b STEP 3: расписание — только менеджеру (как вкладка «Расписание»). getScheduleAssignments
          // org-wide; фильтруем по проекту ниже. Имена — из getTeam (назначенный мог ещё не отмечаться).
          managerView ? getScheduleAssignments() : Promise.resolve([] as ScheduleAssignment[]),
          managerView ? getTeam() : Promise.resolve([] as Profile[]),
          // REP-1: события календаря проекта — только менеджеру (секция и маршрут /calendar manager-only).
          managerView ? getProjectCalendarEvents(project.id) : Promise.resolve([] as CalendarEvent[]),
        ])
        if (!mounted) return
        const openForProject = openTasks.filter(
          (task) => task.project_id === project.id && isEffectiveOpenTask(task),
        ).length
        setCounts({ tasks: openForProject, files: files ? files.length : null, notes: notes.length })
        setTeam(managerView ? aggregateTeam(events) : null)
        setScheduleAssignments(scheduleRows.filter((a) => a.project_id === project.id))
        setScheduleNames(new Map(teamRows.map((m) => [m.id, m.name])))
        setProjectEvents(calendarEvents)
      } catch {
        if (mounted) {
          setCounts(null)
          setTeam(null)
          setScheduleAssignments([])
          setScheduleNames(new Map())
          setProjectEvents([])
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
  const datesInvalid = isDateRangeInvalid(project)

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

  // PROJ-1b STEP 3: пересобираем группы по смене языка (метки дней/«без даты» через t).
  const scheduleDays = useMemo(
    () => groupScheduleByDay(scheduleAssignments, scheduleNames, {
      undated: t('hub_schedule_undated'),
      unknown: t('hub_worker_unknown'),
    }),
    [scheduleAssignments, scheduleNames, t],
  )

  // REP-1: предстоящие события проекта (starts_at ≥ начало сегодняшнего дня), ближайшие сверху.
  // Счётчик в заголовке — по предстоящим; прошедшие в секции не показываем (они уже в /calendar).
  const upcomingEvents = useMemo(() => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const from = todayStart.getTime()
    return projectEvents
      .filter((e) => new Date(e.starts_at).getTime() >= from)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
  }, [projectEvents])

  const toggle = (key: TileKey) => setExpanded((current) => (current === key ? null : key))

  return (
    <section className="hub-tab-panel">
      {/* TRAVEL-2: та же одна кнопка «В путь» (travel.started + уведомление клиента), что и на карточке /projects. */}
      <ProjectNavActions project={project} profile={profile} projectName={project.name} address={project.address} lat={project.lat ?? null} lng={project.lng ?? null} />

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
          <div className={`muted hub-dates-row${datesInvalid ? ' hub-dates-invalid' : ''}`}>
            {t('hub_dates')}: {startDate ?? t('hub_no_data')} | {endDate ?? t('hub_no_data')}
          </div>
          {/* PROJ-2: end_date раньше start_date (опечатка в годе) — красное предупреждение, без автоправки. */}
          {datesInvalid && <div className="hub-dates-invalid-warn">{t('proj_dates_invalid_hint')}</div>}
          {expanded === 'deadline' && <div className="hub-tile-explain">{t(deadline.explanationKey)}</div>}
        </button>

        {/* A2: плитка маржи/себестоимости — только при доступе к финансам. */}
        {financeAllowed && (
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
        )}

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

      {managerView && (
        <div className="card hub-overview-schedule">
          <button
            type="button"
            className="hub-schedule-toggle"
            aria-expanded={scheduleOpen}
            onClick={() => setScheduleOpen((open) => !open)}
          >
            <h2>{t('hub_overview_schedule')}</h2>
            <span className="hub-schedule-caret" aria-hidden="true">{scheduleOpen ? '▾' : '▸'}</span>
          </button>
          {scheduleOpen && (
            <>
              {aggLoading && <div className="muted">{t('loading')}</div>}
              {!aggLoading && scheduleDays.length === 0 && (
                <div className="muted">{t('hub_overview_schedule_empty')}</div>
              )}
              {!aggLoading && scheduleDays.length > 0 && (
                <ul className="hub-schedule-list">
                  {scheduleDays.map((day) => (
                    <li className="hub-schedule-day" key={day.key}>
                      <span className="hub-schedule-date item-title">{day.label}</span>
                      <span className="hub-schedule-workers">
                        {day.workers.map((worker, i) => (
                          <span className="badge hub-schedule-chip" key={`${day.key}-${i}`}>{worker}</span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {/* REP-1: «События проекта» — календарные события, привязанные к проекту (calendar_events.project_id).
          Счётчик предстоящих в заголовке; клик по событию → org-wide /calendar (его не трогаем).
          Только менеджеру: /calendar — manager-only маршрут, как и соседние секции обзора. */}
      {managerView && (
        <div className="card hub-overview-events">
          <div className="hub-overview-team-head">
            <h2>
              {t('hub_overview_project_events')}
              {upcomingEvents.length > 0 && <span className="badge hub-events-count">{upcomingEvents.length}</span>}
            </h2>
            <button type="button" className="inline-link" onClick={() => navigate('/calendar')}>{t('hub_overview_open_calendar')}</button>
          </div>
          {aggLoading && <div className="muted">{t('loading')}</div>}
          {!aggLoading && upcomingEvents.length === 0 && (
            <div className="muted">{t('hub_overview_events_empty')}</div>
          )}
          {!aggLoading && upcomingEvents.length > 0 && (
            <ul className="hub-overview-events-list">
              {upcomingEvents.slice(0, 5).map((event) => (
                <li key={event.id}>
                  <button type="button" className="hub-event-row" onClick={() => navigate('/calendar')}>
                    <span className="hub-event-name">
                      <span className={`badge ${event.event_type === 'inspection' ? 'amber' : 'blue'}`}>{t(`event_${event.event_type}`)}</span>
                      {event.title}
                    </span>
                    <span className="muted hub-event-date">{formatDateTime(event.starts_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="card hub-quick-facts">
        <h2>{t('hub_overview_quick_facts')}</h2>
        <div className="hub-fact-grid">
          {/* A2: бюджет — финансовая величина; показываем только при доступе к финансам. */}
          {financeAllowed && budget && (
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
