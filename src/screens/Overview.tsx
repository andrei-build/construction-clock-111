import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import CollapsibleSection from '../components/CollapsibleSection'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import {
  approveShiftReview,
  createTimeAdjustment,
  getAppSettings,
  getDueClientReminders,
  getLiveLastLocations,
  getMaterialsSpendTotal,
  getOpenGeoEvents,
  getOpenTasks,
  getProjectWeekHours,
  getProjects,
  getRecentActivity,
  getSuspiciousShifts,
  getTeam,
  getTodayEvents,
  getUnpaidWorkSummary,
  managerCheckoutWorker,
  markClientReminderDone,
  subscribeToLiveLocations,
  subscribeToOrgEvents,
  subscribeToTaskChanges,
} from '../lib/api'
import {
  DEFAULT_PAID_GAP_ALERT_HOURS,
  computeTravelGaps,
  fmtClock,
  fmtHours,
  shiftState,
  todayStartISO,
  workedMs,
} from '../lib/time'
import { hasFinanceAccess, isManagerWrite } from '../lib/types'
import type { DueClientReminder, EventRow, LiveLastLocation, Profile, Project, ShiftGeoEvent, SuspiciousShift, Task, TimeEvent } from '../lib/types'

type MetricTone = 'green' | 'amber' | 'red' | 'blue' | 'grey'

type ShiftSegment = {
  startMs: number
  endMs: number | null
  projectId: string | null
}

type TravelGapRow = {
  id: string
  worker: Profile
  fromProjectId: string | null
  toProjectId: string | null
  startMs: number
  endMs: number
  durationHours: number
  overAlert: boolean
}

type OnSiteRow = {
  worker: Profile
  events: TimeEvent[]
  project: Project | null
  live: LiveLastLocation | null
  latestEvent: TimeEvent | null
  state: ReturnType<typeof shiftState>
  hoursMs: number
}

type EditingShift = {
  id: string
  checkIn: string
  checkOut: string
  reason: string
}

const REVIEW_COLLAPSE_COUNT = 4
const PRIORITY_SCORE: Record<Task['priority'], number> = { urgent: 4, high: 3, medium: 2, low: 1 }

const eventLabelKeys: Record<string, string> = {
  'time.check_in': 'timeline_event_time_check_in',
  'time.check_out': 'timeline_event_time_check_out',
  'time.manager_checkout': 'overview_event_manager_checkout',
  'task.completed': 'timeline_event_task_completed',
  'task.created': 'overview_event_task_created',
  'task.material_requested': 'overview_event_material_requested',
  'dispatch.plan_sent': 'timeline_event_dispatch_plan_sent',
  'shift.review_approved': 'timeline_event_shift_review_approved',
  'time.adjustment_created': 'timeline_event_time_adjustment_created',
}

function groupEventsByWorker(events: TimeEvent[]): Map<string, TimeEvent[]> {
  const grouped = new Map<string, TimeEvent[]>()
  for (const event of events) {
    const list = grouped.get(event.profile_id)
    if (list) list.push(event)
    else grouped.set(event.profile_id, [event])
  }
  return grouped
}

function latestEvent(events: TimeEvent[]): TimeEvent | null {
  if (events.length === 0) return null
  return [...events].sort((a, b) => b.event_time.localeCompare(a.event_time))[0]
}

function eventSegments(events: TimeEvent[]): ShiftSegment[] {
  const sorted = [...events].sort((a, b) => a.event_time.localeCompare(b.event_time))
  const segments: ShiftSegment[] = []
  let open: { startMs: number; projectId: string | null } | null = null

  for (const event of sorted) {
    if (event.event_type === 'check_in') {
      open = { startMs: new Date(event.event_time).getTime(), projectId: event.project_id }
    } else if (event.event_type === 'check_out' && open) {
      segments.push({ startMs: open.startMs, endMs: new Date(event.event_time).getTime(), projectId: open.projectId })
      open = null
    }
  }

  if (open) segments.push({ startMs: open.startMs, endMs: null, projectId: open.projectId })
  return segments.filter((segment) => Number.isFinite(segment.startMs))
}

function toDatetimeLocal(iso: string): string {
  const date = new Date(iso)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

function fromDatetimeLocal(value: string): string {
  return new Date(value).toISOString()
}

function formatHoursNumber(hours: number): string {
  return (Math.round(hours * 100) / 100).toFixed(2)
}

function formatDurationHours(hours: number, h: string, m: string): string {
  const totalMinutes = Math.round((Number(hours) || 0) * 60)
  return `${Math.floor(totalMinutes / 60)}${h} ${totalMinutes % 60}${m}`
}

// CLIENT-DOSSIER-2: локальная «сегодня» (YYYY-MM-DD) для сравнения с remind_on (date без времени).
function todayDateISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function Overview() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const mountedRef = useRef(true)
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [activity, setActivity] = useState<EventRow[]>([])
  const [suspicious, setSuspicious] = useState<SuspiciousShift[]>([])
  const [geoEvents, setGeoEvents] = useState<ShiftGeoEvent[]>([])
  const [liveRows, setLiveRows] = useState<LiveLastLocation[]>([])
  const [weekHoursByProject, setWeekHoursByProject] = useState<Map<string, number>>(() => new Map())
  const [unpaid, setUnpaid] = useState<{ hours: number; amount: number } | null>(null)
  const [materials, setMaterials] = useState<number | null>(null)
  const [clientReminders, setClientReminders] = useState<DueClientReminder[]>([])
  const [reminderBusyId, setReminderBusyId] = useState<string | null>(null)
  const [timezone, setTimezone] = useState<string | null>(null)
  const [alertHours, setAlertHours] = useState(DEFAULT_PAID_GAP_ALERT_HOURS)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [checkingOutId, setCheckingOutId] = useState<string | null>(null)
  const [editingShift, setEditingShift] = useState<EditingShift | null>(null)
  const [adjustingId, setAdjustingId] = useState<string | null>(null)
  const [showAllReviews, setShowAllReviews] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const financeAccess = hasFinanceAccess(profile)
  const canManageTime = profile ? isManagerWrite(profile.role) : false

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const loadSnapshot = useCallback(async (silent = false) => {
    if (!profile) return
    if (silent) setRefreshing(true)
    else setLoading(true)
    setError(false)
    try {
      const [
        todayEvents,
        people,
        projectRows,
        taskRows,
        activityRows,
        suspiciousRows,
        geoRows,
        liveLocationRows,
        settings,
        projectWeekHours,
        unpaidSummary,
        materialTotal,
        dueReminders,
      ] = await Promise.all([
        getTodayEvents(),
        getTeam(),
        getProjects(),
        getOpenTasks(),
        getRecentActivity(),
        getSuspiciousShifts(),
        getOpenGeoEvents(),
        getLiveLastLocations(),
        getAppSettings(),
        getProjectWeekHours(),
        financeAccess ? getUnpaidWorkSummary() : Promise.resolve(null),
        financeAccess ? getMaterialsSpendTotal() : Promise.resolve(null),
        getDueClientReminders(),
      ])
      if (!mountedRef.current) return
      setEvents(todayEvents)
      setTeam(people)
      setProjects(projectRows)
      setTasks(taskRows)
      setActivity(activityRows)
      setSuspicious(suspiciousRows)
      setGeoEvents(geoRows)
      setLiveRows(liveLocationRows)
      setWeekHoursByProject(projectWeekHours)
      setUnpaid(unpaidSummary)
      setMaterials(materialTotal)
      setClientReminders(dueReminders)
      const tz = settings?.timezone?.trim()
      setTimezone(tz ? tz : null)
      const gapAlert = Number(settings?.paid_gap_alert_hours)
      setAlertHours(Number.isFinite(gapAlert) && gapAlert > 0 ? gapAlert : DEFAULT_PAID_GAP_ALERT_HOURS)
    } catch {
      if (mountedRef.current) setError(true)
    } finally {
      if (mountedRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [financeAccess, profile])

  useEffect(() => {
    if (!profile) return
    void loadSnapshot()
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void loadSnapshot(true)
    }, 30000)
    return () => window.clearInterval(timer)
  }, [loadSnapshot, profile])

  useEffect(() => {
    if (!profile?.org_id) return
    return subscribeToTaskChanges(profile.org_id, () => {
      getOpenTasks().then((rows) => {
        if (mountedRef.current) setTasks(rows)
      }).catch(() => {
        if (mountedRef.current) setError(true)
      })
    }, `tasks:overview:${profile.org_id}`)
  }, [profile?.org_id])

  useEffect(() => {
    if (!profile?.org_id) return
    return subscribeToOrgEvents(profile.org_id, () => {
      void loadSnapshot(true)
    }, `events:overview:${profile.org_id}`)
  }, [loadSnapshot, profile?.org_id])

  useEffect(() => {
    if (!profile?.org_id) return
    return subscribeToLiveLocations(profile.org_id, () => {
      getLiveLastLocations().then((rows) => {
        if (mountedRef.current) setLiveRows(rows)
      }).catch(() => { /* polling catches the next state */ })
    }, `live:overview:${profile.org_id}`)
  }, [profile?.org_id])

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const workerById = useMemo(() => new Map(team.map((worker) => [worker.id, worker])), [team])
  const liveByWorker = useMemo(() => new Map(liveRows.map((row) => [row.worker_id, row])), [liveRows])
  const eventsByWorker = useMemo(() => groupEventsByWorker(events), [events])

  const projectName = useCallback((projectId: string | null | undefined) => (
    projectId ? projectById.get(projectId)?.name ?? t('unknown_project') : t('unknown_project')
  ), [projectById, t])

  const onSiteRows = useMemo<OnSiteRow[]>(() => team
    .map((worker) => {
      const workerEvents = eventsByWorker.get(worker.id) ?? []
      const state = shiftState(workerEvents)
      if (state.status === 'off') return null
      return {
        worker,
        events: workerEvents,
        project: state.projectId ? projectById.get(state.projectId) ?? null : null,
        live: liveByWorker.get(worker.id) ?? null,
        latestEvent: latestEvent(workerEvents),
        state,
        hoursMs: workedMs(workerEvents, now),
      }
    })
    .filter((row): row is OnSiteRow => row !== null), [eventsByWorker, liveByWorker, now, projectById, team])

  const totalMs = useMemo(
    () => Array.from(eventsByWorker.values()).reduce((sum, workerEvents) => sum + workedMs(workerEvents, now), 0),
    [eventsByWorker, now],
  )

  const sitesWithCrew = useMemo(() => new Set(onSiteRows.map((row) => row.state.projectId).filter(Boolean)).size, [onSiteRows])
  const unreviewedSuspicious = useMemo(() => suspicious.filter((shift) => shift.review_status !== 'approved'), [suspicious])
  const priorityTasks = useMemo(() => tasks
    .filter((task) => task.urgent_flag || task.priority === 'urgent' || task.priority === 'high')
    .sort((a, b) => PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority]), [tasks])

  const travelGaps = useMemo<TravelGapRow[]>(() => {
    const rows: TravelGapRow[] = []
    for (const worker of team) {
      const workerEvents = eventsByWorker.get(worker.id) ?? []
      const segments = eventSegments(workerEvents)
      const gaps = computeTravelGaps(segments, timezone, alertHours)
      for (const gap of gaps) {
        const previous = segments.find((segment) => segment.endMs === gap.startMs)
        const next = segments.find((segment) => segment.startMs === gap.endMs)
        const fromProjectId = previous?.projectId ?? null
        const toProjectId = next?.projectId ?? null
        if (fromProjectId && toProjectId && fromProjectId === toProjectId) continue
        rows.push({
          id: `${worker.id}:${gap.startMs}:${gap.endMs}`,
          worker,
          fromProjectId,
          toProjectId,
          startMs: gap.startMs,
          endMs: gap.endMs,
          durationHours: gap.durationHours,
          overAlert: gap.overAlert,
        })
      }
    }
    return rows.sort((a, b) => b.startMs - a.startMs)
  }, [alertHours, eventsByWorker, team, timezone])

  const riskCount = travelGaps.length + geoEvents.length + priorityTasks.length + clientReminders.length

  const activityToday = useMemo(() => {
    const start = new Date(todayStartISO()).getTime()
    return activity.filter((row) => new Date(row.created_at).getTime() >= start)
  }, [activity])

  const projectLoad = useMemo(() => {
    const crewByProject = new Map<string, OnSiteRow[]>()
    for (const row of onSiteRows) {
      const projectId = row.state.projectId
      if (!projectId) continue
      const list = crewByProject.get(projectId)
      if (list) list.push(row)
      else crewByProject.set(projectId, [row])
    }

    return [...crewByProject.entries()]
      .map(([projectId, crew]) => {
        const project = projectById.get(projectId)
        if (!project) return null
        return {
          project,
          crew,
          weekHours: weekHoursByProject.get(projectId) ?? 0,
          openTasks: tasks.filter((task) => task.project_id === projectId).length,
          needsReview: unreviewedSuspicious.some((shift) => shift.project_id === projectId),
        }
      })
      .filter((row): row is { project: Project; crew: OnSiteRow[]; weekHours: number; openTasks: number; needsReview: boolean } => row !== null)
      .sort((a, b) => b.crew.length - a.crew.length || a.project.name.localeCompare(b.project.name))
  }, [onSiteRows, projectById, tasks, unreviewedSuspicious, weekHoursByProject])

  const nextStep = useMemo(() => {
    const h = t('h')
    const m = t('min_short')
    const suspiciousShift = unreviewedSuspicious[0]
    if (suspiciousShift) {
      return {
        title: suspiciousShift.name,
        project: projectName(suspiciousShift.project_id),
        duration: formatDurationHours(suspiciousShift.hours, h, m),
        reason: shiftReason(suspiciousShift),
      }
    }

    const geo = geoEvents[0]
    if (geo) {
      const workerName = workerById.get(geo.worker_id)?.name ?? t('timeline_unknown_actor')
      return {
        title: workerName,
        project: projectName(geo.project_id),
        duration: geo.status === 'no_signal'
          ? `${Math.round(Number(geo.minutes_since_signal) || 0)}${m}`
          : `${Math.round(Number(geo.distance_m) || 0)} ${t('unit_meters')}`,
        reason: geo.status === 'out_of_zone' ? t('overview_reason_geo_out_of_zone') : t('overview_reason_geo_no_signal'),
      }
    }

    const gap = travelGaps[0]
    if (gap) {
      return {
        title: gap.worker.name,
        project: `${projectName(gap.fromProjectId)} -> ${projectName(gap.toProjectId)}`,
        duration: formatDurationHours(gap.durationHours, h, m),
        reason: t('overview_reason_travel_gap'),
      }
    }

    const task = priorityTasks[0]
    if (task) {
      return {
        title: task.title,
        project: projectName(task.project_id),
        duration: t(`task_priority_${task.priority}`),
        reason: t('overview_reason_priority_task'),
      }
    }

    return null
  }, [geoEvents, priorityTasks, projectName, t, travelGaps, unreviewedSuspicious, workerById])

  function shiftReason(shift: SuspiciousShift): string {
    const reasons = []
    if (shift.too_long) reasons.push(t('overview_reason_long_shift'))
    if (shift.gps_issue) reasons.push(t('overview_reason_no_gps'))
    if (shift.time_gap_issue) reasons.push(t('overview_reason_time_gap'))
    return reasons.join(' / ') || t('requires_attention')
  }

  const money = (value: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)

  const metrics = useMemo(() => {
    const items: Array<{ key: string; label: string; value: string; tone: MetricTone; note: string }> = [
      {
        key: 'on-site',
        label: t('overview_on_site_kpi'),
        value: `${onSiteRows.length}/${team.length}`,
        tone: onSiteRows.length > 0 ? 'green' : 'grey',
        note: t('overview_crew_profiles'),
      },
      {
        key: 'today',
        label: t('overview_today_kpi'),
        value: `${fmtHours(totalMs)} ${t('h')}`,
        tone: totalMs > 0 ? 'blue' : 'grey',
        note: `${projects.length} ${t('overview_active_projects_short')}`,
      },
    ]

    if (financeAccess) {
      items.push({
        key: 'unpaid',
        label: t('overview_unpaid_kpi'),
        value: money(unpaid?.amount ?? 0),
        tone: (unpaid?.amount ?? 0) > 0 ? 'amber' : 'green',
        note: `${formatHoursNumber(unpaid?.hours ?? 0)} ${t('h')}`,
      })
      items.push({
        key: 'materials',
        label: t('overview_materials_kpi'),
        value: money(materials ?? 0),
        tone: (materials ?? 0) > 0 ? 'blue' : 'grey',
        note: t('materials_cost'),
      })
    }

    items.push({
      key: 'tasks',
      label: t('overview_tasks_kpi'),
      value: String(tasks.length),
      tone: priorityTasks.length > 0 ? 'amber' : tasks.length > 0 ? 'blue' : 'grey',
      note: `${priorityTasks.length} ${t('overview_urgent_count')}`,
    })

    return items
  }, [financeAccess, materials, onSiteRows.length, priorityTasks.length, projects.length, t, tasks.length, team.length, totalMs, unpaid])

  async function approveShift(shift: SuspiciousShift) {
    if (!profile || approvingId || !canManageTime) return
    setApprovingId(shift.checkout_event_id)
    setMsg(null)
    try {
      await approveShiftReview(profile, shift.checkout_event_id)
      setSuspicious(await getSuspiciousShifts())
      setMsg('mark_reviewed')
    } catch {
      setMsg('overview_shift_review_failed')
    } finally {
      setApprovingId(null)
    }
  }

  function openAdjustment(shift: SuspiciousShift) {
    setEditingShift({
      id: shift.checkout_event_id,
      checkIn: toDatetimeLocal(shift.started_at),
      checkOut: toDatetimeLocal(shift.ended_at),
      reason: '',
    })
    setMsg(null)
  }

  async function submitAdjustment(event: FormEvent, shift: SuspiciousShift) {
    event.preventDefault()
    if (!profile || adjustingId || !canManageTime || !editingShift) return
    if (!editingShift.reason.trim()) {
      setMsg('adjust_reason_required')
      return
    }
    const adjustedCheckIn = fromDatetimeLocal(editingShift.checkIn)
    const adjustedCheckOut = fromDatetimeLocal(editingShift.checkOut)
    if (new Date(adjustedCheckOut).getTime() <= new Date(adjustedCheckIn).getTime()) {
      setMsg('adjust_time_invalid')
      return
    }

    setAdjustingId(shift.checkout_event_id)
    setMsg(null)
    try {
      await createTimeAdjustment(profile, {
        workerId: shift.profile_id,
        projectId: shift.project_id,
        originalEventId: shift.checkout_event_id,
        adjustedCheckIn,
        adjustedCheckOut,
        reason: editingShift.reason.trim(),
      })
      setEditingShift(null)
      setMsg('adjustment_saved')
      await loadSnapshot(true)
    } catch {
      setMsg('adjustment_failed')
    } finally {
      setAdjustingId(null)
    }
  }

  async function forceCheckout(row: OnSiteRow) {
    if (!profile || checkingOutId || !canManageTime) return
    if (!window.confirm(t('overview_force_checkout_confirm'))) return
    setCheckingOutId(row.worker.id)
    setMsg(null)
    try {
      await managerCheckoutWorker(profile, row.worker.id, row.state.projectId)
      setMsg('overview_force_checkout_done')
      await loadSnapshot(true)
    } catch {
      setMsg('overview_force_checkout_failed')
    } finally {
      setCheckingOutId(null)
    }
  }

  // CLIENT-DOSSIER-2: отметить напоминание клиента выполненным прямо из КЦ → убрать из списка.
  async function completeReminder(id: string) {
    if (!profile || reminderBusyId) return
    setReminderBusyId(id)
    try {
      await markClientReminderDone(profile, id)
      setClientReminders((rows) => rows.filter((row) => row.id !== id))
    } catch {
      setMsg('overview_reminder_done_failed')
    } finally {
      setReminderBusyId(null)
    }
  }

  const eventLabel = (eventType: string) => {
    const key = eventLabelKeys[eventType]
    return key ? t(key) : eventType
  }

  const gpsLabel = (row: OnSiteRow) => {
    if (row.live) return t('gps_ok')
    return row.latestEvent?.gps_status === 'good' ? t('gps_ok') : t('no_gps_data')
  }

  const lastUpdateLabel = (row: OnSiteRow) => {
    if (!row.live) return t('overview_no_live_update')
    if (row.live.minutes_ago === null || row.live.minutes_ago === undefined) return fmtClock(row.live.recorded_at)
    const minutes = Math.max(0, Math.round(Number(row.live.minutes_ago) || 0))
    if (minutes < 1) return t('overview_now_short')
    if (minutes < 60) return `${minutes}${t('min_short')}`
    return `${Math.floor(minutes / 60)}${t('h')} ${minutes % 60}${t('min_short')}`
  }

  const visibleReviews = showAllReviews ? unreviewedSuspicious : unreviewedSuspicious.slice(0, REVIEW_COLLAPSE_COUNT)
  const hiddenReviews = Math.max(0, unreviewedSuspicious.length - REVIEW_COLLAPSE_COUNT)
  const msgClass = msg?.includes('failed') || msg?.includes('invalid') || msg?.includes('required') ? 'error-msg' : 'ok-msg'
  const today = todayDateISO()

  if (loading) {
    return (
      <div className="screen dashboard-screen overview-screen">
        <h1>{t('overview')}</h1>
        <div className="card center muted">{t('loading')}</div>
      </div>
    )
  }

  return (
    <div className="screen dashboard-screen overview-screen">
      <div className="row">
        <div>
          <h1>{t('overview')}</h1>
          <p className="muted">{t('overview_subtitle')}</p>
        </div>
        <button className="btn ghost small" type="button" disabled={refreshing} onClick={() => loadSnapshot(true)}>
          {refreshing ? t('loading') : t('refresh')}
        </button>
      </div>

      {error && <p className="error-msg">{t('load_error')}</p>}
      {msg && <p className={msgClass}>{t(msg)}</p>}

      <div className="dashboard-tiles">
        {metrics.map((tile) => (
          <div key={tile.key} className={`card metric-card ${tile.tone}`}>
            <div className="metric-value">{tile.value}</div>
            <div className="muted">{tile.label}</div>
            <div className="metric-note muted">{tile.note}</div>
          </div>
        ))}
      </div>

      <section>
        <h2>{t('overview_operational_picture')}</h2>
        <div className="dashboard-panels">
          <div className="card command-card">
            <h2>{t('dashboard_now')}</h2>
            <div className="command-value">{onSiteRows.length} · {t('on_shift')}</div>
            <p className="muted">
              {sitesWithCrew} {t('overview_sites_with_crew')} · {fmtHours(totalMs)} {t('overview_hours_today_short')}
            </p>
          </div>
          <div className="card command-card">
            <h2>{t('dashboard_risks')}</h2>
            <div className={`command-value ${riskCount > 0 ? 'attention' : 'ok'}`}>
              {riskCount > 0 ? `${riskCount} · ${t('requires_attention')}` : t('no_risks')}
            </div>
            <p className="muted">
              {travelGaps.length} {t('overview_travel_gaps_short')} · {geoEvents.length} {t('overview_gps_losses_short')} · {priorityTasks.length} {t('overview_priority_tasks_short')}
            </p>
          </div>
          <div className="card command-card">
            <h2>{t('dashboard_next_step')}</h2>
            {nextStep ? (
              <>
                <div className="command-value">{nextStep.title}</div>
                <p className="muted">{nextStep.project} · {nextStep.duration} · {nextStep.reason}</p>
              </>
            ) : (
              <>
                <div className="command-value ok">{t('all_clear')}</div>
                <p className="muted">{t('no_risks')}</p>
              </>
            )}
            <div className="row">
              <Link className="btn small" to="/dispatch">{t('open_command_center')}</Link>
              <Link className="btn ghost small" to="/timeline">{t('overview_full_timeline')}</Link>
            </div>
          </div>
        </div>
      </section>

      <div className="dashboard-strips">
        {/* CLIENT-DOSSIER-2: наступившие/просроченные напоминания по клиентам с кнопкой «Сделано». */}
        <CollapsibleSection title={t('client_reminders')} count={clientReminders.length} defaultOpen={clientReminders.length > 0}>
          {clientReminders.length === 0 ? (
            <div className="card muted">{t('client_reminders_none')}</div>
          ) : (
            clientReminders.map((reminder) => {
              const overdue = reminder.remind_on < today
              return (
                <div key={reminder.id} className={`card row dashboard-row client-reminder-row ${overdue ? 'overdue' : ''}`}>
                  <div>
                    <div className="item-title">{reminder.client_name ?? t('client')}</div>
                    <div className="muted">{reminder.note}</div>
                    <div className="muted">
                      {new Date(`${reminder.remind_on}T00:00:00`).toLocaleDateString()}
                      {overdue && <span className="badge red client-reminder-badge">{t('client_reminder_overdue')}</span>}
                    </div>
                  </div>
                  <button className="btn small" disabled={reminderBusyId === reminder.id} onClick={() => completeReminder(reminder.id)}>
                    {t('client_reminder_done')}
                  </button>
                </div>
              )
            })
          )}
        </CollapsibleSection>

        <CollapsibleSection title={t('suspicious_shifts_title')} count={unreviewedSuspicious.length} defaultOpen={unreviewedSuspicious.length > 0}>
          {unreviewedSuspicious.length === 0 ? (
            <div className="card muted">{t('suspicious_none')}</div>
          ) : (
            <>
              {visibleReviews.map((shift) => (
                <div key={shift.checkout_event_id} className="review-row">
                  <div className="review-main">
                    <div className="item-title">{shift.name}</div>
                    <div className="muted">{projectName(shift.project_id)}</div>
                    <div className="muted">
                      {new Date(shift.started_at).toLocaleDateString()} · {fmtClock(shift.started_at)}-{fmtClock(shift.ended_at)} · {formatDurationHours(shift.hours, t('h'), t('min_short'))}
                    </div>
                    <div className="review-chips">
                      <span className="badge red">{t('overview_not_reviewed')}</span>
                      {shift.too_long && <span className="badge amber">{t('overview_reason_long_shift')}</span>}
                      {shift.gps_issue && <span className="badge red">{t('overview_reason_no_gps')}</span>}
                      {shift.time_gap_issue && <span className="badge red">{t('overview_reason_time_gap')}</span>}
                    </div>

                    {editingShift?.id === shift.checkout_event_id && (
                      <form className="adjustment-form" onSubmit={(event) => submitAdjustment(event, shift)}>
                        <label>{t('new_check_in')}</label>
                        <input
                          type="datetime-local"
                          value={editingShift.checkIn}
                          onChange={(event) => setEditingShift((current) => current ? { ...current, checkIn: event.target.value } : current)}
                        />
                        <label>{t('new_check_out')}</label>
                        <input
                          type="datetime-local"
                          value={editingShift.checkOut}
                          onChange={(event) => setEditingShift((current) => current ? { ...current, checkOut: event.target.value } : current)}
                        />
                        <label>{t('adjust_reason')}</label>
                        <div className="row adjust-reason-presets">
                          {(['adjust_preset_forgot_checkout', 'adjust_preset_overtime', 'adjust_preset_correction', 'adjust_preset_worked_extra'] as const).map((key) => (
                            <button key={key} className="btn ghost small" type="button" onClick={() => setEditingShift((current) => current ? { ...current, reason: t(key) } : current)}>
                              {t(key)}
                            </button>
                          ))}
                        </div>
                        <textarea
                          value={editingShift.reason}
                          rows={2}
                          onChange={(event) => setEditingShift((current) => current ? { ...current, reason: event.target.value } : current)}
                        />
                        <div className="row adjustment-actions">
                          <button className="btn ghost small" type="button" disabled={adjustingId !== null} onClick={() => setEditingShift(null)}>{t('cancel')}</button>
                          <button className="btn small" disabled={adjustingId !== null || !editingShift.reason.trim()}>{t('save_adjustment')}</button>
                        </div>
                      </form>
                    )}
                  </div>
                  <div className="review-action">
                    <button className="btn small" disabled={!canManageTime || approvingId === shift.checkout_event_id} onClick={() => approveShift(shift)}>
                      {t('mark_reviewed')}
                    </button>
                    <button className="btn ghost small" disabled={!canManageTime || adjustingId !== null} onClick={() => openAdjustment(shift)}>
                      {t('edit')}
                    </button>
                  </div>
                </div>
              ))}
              {!showAllReviews && hiddenReviews > 0 && (
                <button className="inline-link" type="button" onClick={() => setShowAllReviews(true)}>
                  +{hiddenReviews} {t('overview_more_require_review')}
                </button>
              )}
            </>
          )}
        </CollapsibleSection>

        <CollapsibleSection title={t('on_site_now')} count={onSiteRows.length} defaultOpen>
          {onSiteRows.length === 0 ? (
            <div className="card muted">{t('nobody_on_site')}</div>
          ) : (
            <div className="card payroll-table-wrap">
              <table className="payroll-table">
                <thead>
                  <tr>
                    <th>{t('overview_person')}</th>
                    <th>{t('overview_project_address')}</th>
                    <th>{t('overview_since')}</th>
                    <th>{t('overview_hours')}</th>
                    <th>{t('overview_gps_status')}</th>
                    <th>{t('overview_last_update')}</th>
                    <th>{t('overview_status')}</th>
                    <th>{t('overview_action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {onSiteRows.map((row) => (
                    <tr key={row.worker.id}>
                      <td>
                        <Link className="inline-link item-title" to={`/team/${row.worker.id}`}>{row.worker.name}</Link>
                        <div className="muted">{row.worker.role}</div>
                      </td>
                      <td>
                        {row.project ? (
                          <Link className="inline-link" to={`/projects/${row.project.id}`}>{row.project.name}</Link>
                        ) : (
                          <span>{t('unknown_project')}</span>
                        )}
                        <div className="muted">{row.project?.address ?? t('overview_no_project_address')}</div>
                      </td>
                      <td>{row.state.since ? fmtClock(row.state.since) : '-'}</td>
                      <td>{fmtHours(row.hoursMs)} {t('h')}</td>
                      <td>{gpsLabel(row)}</td>
                      <td>{lastUpdateLabel(row)}</td>
                      <td>
                        <span className={`badge ${row.state.status === 'break' ? 'amber' : 'green'}`}>
                          {row.state.status === 'break' ? t('on_break') : t('on_shift')}
                        </span>
                      </td>
                      <td>
                        {canManageTime ? (
                          <button className="btn red small" disabled={checkingOutId === row.worker.id} onClick={() => forceCheckout(row)}>
                            {t('overview_force_checkout')}
                          </button>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection title={t('overview_travel_gaps_title')} count={travelGaps.length}>
          {travelGaps.length === 0 ? (
            <div className="card muted">{t('overview_no_travel_gaps')}</div>
          ) : (
            travelGaps.map((gap) => (
              <div key={gap.id} className="card row dashboard-row">
                <div>
                  <div className="item-title">{gap.worker.name}</div>
                  <div className="muted">{projectName(gap.fromProjectId)} {'->'} {projectName(gap.toProjectId)}</div>
                  <div className="muted">{fmtClock(new Date(gap.startMs).toISOString())}-{fmtClock(new Date(gap.endMs).toISOString())}</div>
                </div>
                <span className={`badge ${gap.overAlert ? 'amber' : 'blue'}`}>
                  {formatDurationHours(gap.durationHours, t('h'), t('min_short'))}
                </span>
              </div>
            ))
          )}
        </CollapsibleSection>

        <CollapsibleSection title={t('overview_recent_events_today')} count={activityToday.length}>
          <div className="row">
            <Link className="btn ghost small" to="/timeline">{t('overview_full_timeline')}</Link>
          </div>
          {activityToday.length === 0 && <div className="card muted">{t('no_activity')}</div>}
          {activityToday.slice(0, 8).map((row) => (
            <div className="feed-item" key={row.id}>
              <div><b>{row.actor_name ?? t('timeline_unknown_actor')}</b> · {eventLabel(row.event_type)}</div>
              <div className="when">{new Date(row.created_at).toLocaleString()}</div>
            </div>
          ))}
        </CollapsibleSection>

        <CollapsibleSection title={t('overview_urgent_queue')} count={priorityTasks.length} defaultOpen={priorityTasks.length > 0}>
          {priorityTasks.length === 0 ? (
            <div className="card muted">{t('overview_no_urgent_tasks')}</div>
          ) : (
            priorityTasks.slice(0, 8).map((task) => (
              <div key={task.id} className="card row dashboard-row">
                <div>
                  <div className="item-title">{task.title}</div>
                  <div className="muted">{projectName(task.project_id)} · {task.assigned_to ? workerById.get(task.assigned_to)?.name ?? t('task_unassigned') : t('task_unassigned')}</div>
                </div>
                <span className={`badge ${task.priority === 'urgent' ? 'red' : 'amber'}`}>{t(`task_priority_${task.priority}`)}</span>
              </div>
            ))
          )}
        </CollapsibleSection>

        <CollapsibleSection title={t('overview_project_load')} count={projectLoad.length} defaultOpen>
          {projectLoad.length === 0 ? (
            <div className="card muted">{t('overview_project_load_empty')}</div>
          ) : (
            <div className="dashboard-tiles">
              {projectLoad.map((row) => (
                <div key={row.project.id} className="card metric-card blue">
                  <Link className="inline-link item-title" to={`/projects/${row.project.id}`}>{row.project.name}</Link>
                  <div className="muted">{row.project.address ?? t('overview_no_project_address')}</div>
                  <div className="review-chips">
                    <span className="badge green">{row.crew.length} {t('overview_on_shift_count')}</span>
                    <span className="badge blue">{formatHoursNumber(row.weekHours)} {t('h')}</span>
                    <span className="badge blue">{row.openTasks} {t('overview_open_tasks_count')}</span>
                    {row.needsReview && <span className="badge red">{t('overview_requires_review_badge')}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CollapsibleSection>
      </div>
    </div>
  )
}
