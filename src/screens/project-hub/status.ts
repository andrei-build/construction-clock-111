import type { Project } from '../../lib/types'

export type TrafficStatus = 'green' | 'amber' | 'red' | 'neutral'

export interface DeadlineInfo {
  status: TrafficStatus
  valueKey: string
  explanationKey: string
  daysLeft: number | null
  daysOverdue: number | null
  elapsedPct: number | null
}

function localDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function todayStart(now = new Date()) {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  return today
}

function dayDiff(from: Date, to: Date) {
  return Math.round((to.getTime() - from.getTime()) / 86400000)
}

export function getDeadlineInfo(
  project: Pick<Project, 'start_date' | 'end_date' | 'status'> | null | undefined,
  now = new Date(),
): DeadlineInfo {
  const start = localDate(project?.start_date)
  const end = localDate(project?.end_date)
  if (!start && !end) {
    return {
      status: 'neutral',
      valueKey: 'hub_deadline_no_dates',
      explanationKey: 'hub_deadline_no_dates_explain',
      daysLeft: null,
      daysOverdue: null,
      elapsedPct: null,
    }
  }

  const today = todayStart(now)
  const daysLeft = end ? dayDiff(today, end) : null
  if (end && daysLeft !== null && daysLeft < 0 && project?.status === 'active') {
    return {
      status: 'red',
      valueKey: 'hub_deadline_overdue_value',
      explanationKey: 'hub_deadline_overdue_explain',
      daysLeft,
      daysOverdue: Math.abs(daysLeft),
      elapsedPct: 100,
    }
  }

  let elapsedPct: number | null = null
  if (start && end && end.getTime() > start.getTime()) {
    const elapsed = today.getTime() - start.getTime()
    const span = end.getTime() - start.getTime()
    elapsedPct = Math.max(0, Math.min(100, (elapsed / span) * 100))
  }

  if ((daysLeft !== null && daysLeft <= 14) || (elapsedPct !== null && elapsedPct > 80)) {
    return {
      status: 'amber',
      valueKey: daysLeft !== null ? 'hub_deadline_days_left_value' : 'hub_deadline_watch_value',
      explanationKey: 'hub_deadline_watch_explain',
      daysLeft,
      daysOverdue: null,
      elapsedPct,
    }
  }

  return {
    status: 'green',
    valueKey: 'hub_deadline_on_track_value',
    explanationKey: 'hub_deadline_on_track_explain',
    daysLeft,
    daysOverdue: null,
    elapsedPct,
  }
}

export function statusDotClass(status: TrafficStatus) {
  return status === 'neutral' ? 'status-dot' : `status-dot ${status}`
}
