import type { TimeEvent } from './types'

// Состояние смены из событий дня (ДНК §2: история неизменна, состояние выводится)
export type ShiftState = { status: 'off' | 'on' | 'break'; since: string | null; projectId: string | null }

export function shiftState(events: TimeEvent[]): ShiftState {
  const sorted = [...events].sort((a, b) => a.event_time.localeCompare(b.event_time))
  let state: ShiftState = { status: 'off', since: null, projectId: null }
  for (const e of sorted) {
    if (e.event_type === 'check_in') state = { status: 'on', since: e.event_time, projectId: e.project_id }
    else if (e.event_type === 'check_out') state = { status: 'off', since: null, projectId: null }
    else if (e.event_type === 'break_start' && state.status === 'on') state = { ...state, status: 'break' }
    else if (e.event_type === 'break_end' && state.status === 'break') state = { ...state, status: 'on' }
  }
  return state
}

// Часы из пар событий, минус перерывы; открытая смена считается до "сейчас"
export function workedMs(events: TimeEvent[], now = Date.now()): number {
  const sorted = [...events].sort((a, b) => a.event_time.localeCompare(b.event_time))
  let total = 0
  let inAt: number | null = null
  let breakAt: number | null = null
  for (const e of sorted) {
    const t = new Date(e.event_time).getTime()
    if (e.event_type === 'check_in') { inAt = t; breakAt = null }
    else if (e.event_type === 'break_start' && inAt !== null && breakAt === null) breakAt = t
    else if (e.event_type === 'break_end' && breakAt !== null) { total -= 0; inAt = inAt! + (t - breakAt); breakAt = null }
    else if (e.event_type === 'check_out' && inAt !== null) {
      const effectiveEnd = breakAt ?? t
      total += effectiveEnd - inAt
      inAt = null; breakAt = null
    }
  }
  if (inAt !== null) total += (breakAt ?? now) - inAt
  return Math.max(0, total)
}

export function fmtHours(ms: number): string {
  const h = ms / 3600000
  return (Math.round(h * 100) / 100).toFixed(2)
}

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function todayStartISO(): string {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString()
}

export function weekStartISO(): string {
  const d = new Date(); const day = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); return d.toISOString()
}
