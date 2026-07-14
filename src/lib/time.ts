import type { TimeEvent, WorkInterval } from './types'

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

// Начало вчерашних суток (устройство-локально), тот же приём что и todayStartISO
export function yesterdayStartISO(): string {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString()
}

// Начало прошлой недели (пн, устройство-локально), та же логика что и weekStartISO
export function lastWeekStartISO(): string {
  const d = new Date(); const day = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - day - 7); d.setHours(0, 0, 0, 0); return d.toISOString()
}

// ── G1: Paid travel time between job sites ────────────────────────────────────
// The gap between a worker's CHECK-OUT and the NEXT CHECK-IN, when BOTH fall on the
// SAME org-local calendar day, is PAID working time ("время в пути" / travel). It is
// tracked separately from work hours but added to the worker's total paid hours.
// Pure, side-effect free. Gap semantics (per Andrei's spec):
//   (c) never paid across an org-local day boundary (night is not travel);
//   (d) only gaps strictly BETWEEN two shifts — never before the first check-in or
//       after the last check-out of a day (that falls out naturally: we only look at
//       gaps between consecutive shifts, and rule (c) drops cross-day pairs).
// A gap "over alert" (durationHours > alertHours) is still paid, just highlighted.

// Default for app_settings.paid_gap_alert_hours when the column is null/blank.
export const DEFAULT_PAID_GAP_ALERT_HOURS = 1

// A worker shift as epoch ms. endMs null = still open (no check-out yet): such a shift
// can be the NEXT side of a gap (its start is a real check-in) but never the PREV side.
export interface TravelShift {
  startMs: number
  endMs: number | null
}

export interface TravelGap {
  startMs: number        // preceding check-out (epoch ms)
  endMs: number          // following check-in (epoch ms)
  durationHours: number
  overAlert: boolean     // durationHours > alertHours
}

// Org-local calendar day of an instant. With a timezone → F2's org-local ymd; when
// null/blank → device-local day key, EXACTLY mirroring the F15 fallback (unpadded
// YYYY-M-D). Keys are only ever compared within one computeTravelGaps call, so the
// two branches never mix.
function travelDayKey(ms: number, timeZone: string | null): string {
  if (timeZone) return orgWeekGrouping(ms, timeZone).ymd
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

// Travel gaps between consecutive shifts within the same org-local day. Shifts may be
// unsorted; we sort by start. A gap is emitted only when the preceding shift is closed
// (has a check-out) and the following check-in is strictly later AND on the same org-local
// day. `alertHours` marks (not cuts) gaps that exceed the alert threshold.
export function computeTravelGaps(shifts: TravelShift[], timeZone: string | null, alertHours: number): TravelGap[] {
  const sorted = [...shifts].sort((a, b) => a.startMs - b.startMs)
  const gaps: TravelGap[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const prevEnd = sorted[i].endMs
    if (prevEnd === null) continue // open shift has no check-out → no gap after it yet
    const nextStart = sorted[i + 1].startMs
    const gapMs = nextStart - prevEnd
    if (gapMs <= 0) continue // overlap or zero → not a gap
    // Rule (c): both check-out and next check-in must be the same org-local day.
    if (travelDayKey(prevEnd, timeZone) !== travelDayKey(nextStart, timeZone)) continue
    const durationHours = gapMs / 3600000
    gaps.push({ startMs: prevEnd, endMs: nextStart, durationHours, overAlert: durationHours > alertHours })
  }
  return gaps
}

// WorkInterval[] (v_work_intervals) → TravelShift[]. Reuses the app's canonical pairing
// (each interval is one check-in→check-out); open intervals carry endMs=null.
export function intervalsToTravelShifts(intervals: WorkInterval[]): TravelShift[] {
  return intervals.map((i) => ({
    startMs: new Date(i.start_at).getTime(),
    endMs: i.end_at ? new Date(i.end_at).getTime() : null,
  }))
}

// Raw time_events → TravelShift[]. Mirrors workedMs pairing at the shift level:
// check_in opens a shift, check_out closes it; breaks are internal and do NOT split a
// shift; a trailing unclosed check_in yields an open shift (endMs=null). For screens
// (Dashboard) that hold time_events rather than v_work_intervals.
export function eventsToTravelShifts(events: TimeEvent[]): TravelShift[] {
  const sorted = [...events].sort((a, b) => a.event_time.localeCompare(b.event_time))
  const shifts: TravelShift[] = []
  let inAt: number | null = null
  for (const e of sorted) {
    if (e.event_type === 'check_in') inAt = new Date(e.event_time).getTime()
    else if (e.event_type === 'check_out' && inAt !== null) {
      shifts.push({ startMs: inAt, endMs: new Date(e.event_time).getTime() })
      inAt = null
    }
  }
  if (inAt !== null) shifts.push({ startMs: inAt, endMs: null })
  return shifts
}

// ── Org-timezone day/week boundaries (F2) ─────────────────────────────────────
// Day-boundary math for payroll must use the ORGANIZATION timezone, not the
// device-local one. All conversions derive the actual UTC offset from Intl at
// each instant, so DST transitions are handled correctly (no fixed offset, no
// hand-rolled arithmetic). These helpers are pure and side-effect free.

// UTC offset (ms) at a given instant for `timeZone`, such that
//   wallClock = utcInstant + offset.
// Derived by formatting the instant into its org-local wall components and
// re-reading them as if they were UTC. DST-correct because Intl knows the rules.
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs))
  const map: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value
  // Some engines render midnight as hour "24"; normalize to 0.
  let hour = Number(map.hour)
  if (hour === 24) hour = 0
  const wallAsUtc = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    hour, Number(map.minute), Number(map.second),
  )
  return wallAsUtc - utcMs
}

// UTC instant (ms) of org-local midnight for the calendar date y-m-d.
// We want `utc` s.t. wall(utc) == 00:00 on y-m-d. Since wall = utc + offset,
// utc = wallMidnight - offset(utc). We estimate the offset near the naive guess,
// then refine once to cover DST transitions where the offset differs at the
// resolved instant.
function orgDayStartMs(y: number, m: number, d: number, timeZone: string): number {
  const naiveUtc = Date.UTC(y, m - 1, d, 0, 0, 0) // org-local midnight read as UTC
  const off1 = tzOffsetMs(naiveUtc, timeZone)
  let utc = naiveUtc - off1
  const off2 = tzOffsetMs(utc, timeZone)
  if (off2 !== off1) utc = naiveUtc - off2
  return utc
}

export interface OrgWeekGrouping {
  ymd: string             // org-local calendar day of the instant, YYYY-MM-DD
  weekKey: string         // stable key for the org-local week = its Monday, YYYY-MM-DD
  weekStartMs: number     // UTC ms of org-local Monday 00:00 of this week
  nextWeekStartMs: number // UTC ms of the following org-local Monday 00:00
}

// Single grouping helper: given an ISO instant / epoch ms / Date and the org
// IANA timezone, return the org-local calendar day plus the week bounds needed
// to bucket hours (weeks start Monday, matching the device-local logic this
// replaces). Week bounds are computed per-Monday via Intl so DST-length weeks
// (23h/25h days) split at the exact instant.
export function orgWeekGrouping(instant: string | number | Date, timeZone: string): OrgWeekGrouping {
  const utcMs = instant instanceof Date
    ? instant.getTime()
    : typeof instant === 'number'
      ? instant
      : new Date(instant).getTime()

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(utcMs))
  const map: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value
  const y = Number(map.year), m = Number(map.month), d = Number(map.day)

  // Day-of-week from the calendar date (pure, tz-independent). ISO: 0=Mon..6=Sun,
  // matching the existing device-local `(getDay() + 6) % 7` convention.
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun..6=Sat
  const isoDow = (dow + 6) % 7

  // Monday of this org-local week and the following Monday, via calendar math.
  const monday = new Date(Date.UTC(y, m - 1, d - isoDow))
  const my = monday.getUTCFullYear(), mm = monday.getUTCMonth() + 1, md = monday.getUTCDate()
  const next = new Date(Date.UTC(my, mm - 1, md + 7))

  return {
    ymd: `${map.year}-${map.month}-${map.day}`,
    weekKey: `${my}-${String(mm).padStart(2, '0')}-${String(md).padStart(2, '0')}`,
    weekStartMs: orgDayStartMs(my, mm, md, timeZone),
    nextWeekStartMs: orgDayStartMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone),
  }
}
