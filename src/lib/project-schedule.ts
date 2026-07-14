// Здоровье графика проекта по projects.start_date + projects.end_date — паритет
// Check Time (project-schedule.ts, health state machine). Чистые функции, без
// сторонних дат-библиотек. Границы дня — конец дня (end-of-day) для end_date,
// начало дня для start_date.
//
// Состояния:
//   unscheduled  — end_date не задан;
//   not_started  — сегодня раньше start_date;
//   on_track     — в графике (< 50% прошло и > 10% срока осталось);
//   half_elapsed — прошло ≥ 50% срока (amber);
//   almost_due   — осталось ≤ 10% срока (red);
//   overdue      — сегодня позже конца дня end_date (red).
//
// CC's traffic-light helper lives in screens/project-hub/status; здесь —
// более богатый статус поверх тех же двух полей, плюс проценты и обратный отсчёт.

import type { TrafficStatus } from '../screens/project-hub/status'

export type ProjectScheduleState =
  | 'unscheduled'
  | 'not_started'
  | 'on_track'
  | 'half_elapsed'
  | 'almost_due'
  | 'overdue'

export interface ProjectSchedule {
  start_date?: string | null
  end_date?: string | null
}

// Начало дня по строке даты (локальное время, как в deadlineStatus).
function startOfDay(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Конец дня — дедлайн «включительно» до 23:59:59.999.
function endOfDay(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

// Доля прошедшего срока (0..100). 0, если срок нельзя вычислить (нет обеих дат).
export function elapsedPercent(project: ProjectSchedule, now: Date = new Date()): number {
  if (!project.start_date || !project.end_date) return 0
  const start = startOfDay(project.start_date)
  const end = endOfDay(project.end_date)
  const span = end - start
  if (span <= 0) return now.getTime() >= end ? 100 : 0
  return clampPercent(((now.getTime() - start) / span) * 100)
}

// Доля оставшегося срока (0..100) — дополнение к elapsedPercent.
export function remainingPercent(project: ProjectSchedule, now: Date = new Date()): number {
  if (!project.start_date || !project.end_date) return 100
  return clampPercent(100 - elapsedPercent(project, now))
}

// Машина состояний графика проекта.
export function projectScheduleState(project: ProjectSchedule, now: Date = new Date()): ProjectScheduleState {
  if (!project.end_date) return 'unscheduled'
  const nowMs = now.getTime()
  const end = endOfDay(project.end_date)
  if (nowMs > end) return 'overdue'
  if (project.start_date) {
    const start = startOfDay(project.start_date)
    if (nowMs < start) return 'not_started'
    // В пределах срока: остаток ≤ 10% важнее «прошло ≥ 50%».
    if (remainingPercent(project, now) <= 10) return 'almost_due'
    if (elapsedPercent(project, now) >= 50) return 'half_elapsed'
    return 'on_track'
  }
  // start_date не задан — процент срока не посчитать, статус «в графике».
  return 'on_track'
}

// Проекция богатого состояния на существующий светофор (red/amber/green/neutral),
// чтобы не ломать вызовы statusDotClass().
const STATE_TO_DEADLINE: Record<ProjectScheduleState, TrafficStatus> = {
  unscheduled: 'neutral',
  not_started: 'green',
  on_track: 'green',
  half_elapsed: 'amber',
  almost_due: 'red',
  overdue: 'red',
}

export function scheduleStateToDeadline(state: ProjectScheduleState): TrafficStatus {
  return STATE_TO_DEADLINE[state]
}

// Обратный отсчёт до дедлайна: «3d 4h» до конца дня end_date, «overdue» после.
// Пустая строка, если end_date не задан. Без дат-библиотек.
export function formatProjectCountdown(endDate: string | null | undefined, now: Date = new Date()): string {
  if (!endDate) return ''
  const diffMs = endOfDay(endDate) - now.getTime()
  if (diffMs <= 0) return 'overdue'
  const totalMinutes = Math.floor(diffMs / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
