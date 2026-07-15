// A6: pure payroll money math. This module is deliberately FREE of any import of
// src/lib/time.ts (protected lane), React, or Supabase, so vitest can exercise it
// in a plain node env and the supervisor can review money logic in isolation.
//
// FROZEN rounding contract (Claude-from-chat, standard payroll — do NOT deviate):
// hours stay in full float precision; each money component is computed from full
// hours; the SUM is rounded ONCE to the cent, round-HALF-UP. Never pre-round terms.

// Round-half-up to 2 decimals, float-epsilon-safe. round2(1.005) === 1.01.
export function round2(x: number): number {
  return Math.round((x + Number.EPSILON) * 100) / 100
}

export interface WorkerTotalInput {
  regularHours: number
  overtimeHours: number
  // Travel pay is INSIDE total here (travel_hours is a breakdown-only column elsewhere).
  travelHours: number
  rate: number | null
  overtimeMultiplier?: number // default 1.5
  bonus?: number
  reimbursement?: number
  deduction?: number
}

// Worker money total under the FROZEN contract: components from FULL float hours,
// summed, then rounded ONCE. rate === null (no rate on file) → 0.
export function computeWorkerTotal(input: WorkerTotalInput): number {
  const { rate } = input
  if (rate === null) return 0
  const otMultiplier = input.overtimeMultiplier ?? 1.5
  const regularPay = input.regularHours * rate
  const otPay = input.overtimeHours * rate * otMultiplier
  const travelPay = input.travelHours * rate
  const bonus = input.bonus ?? 0
  const reimbursement = input.reimbursement ?? 0
  const deduction = input.deduction ?? 0
  return round2(regularPay + otPay + travelPay + bonus + reimbursement - deduction)
}

// Minimal shape of a work interval this module needs (subset of WorkInterval).
export interface HoursInterval {
  start_at: string
  end_at: string | null // null → open shift still running
}

export interface WeekBoundary {
  key: string             // stable week key for grouping (e.g. Monday YYYY-MM-DD)
  nextBoundaryMs: number  // UTC ms of the next week boundary after the cursor
}

// Overlap-clip a worker's intervals to the half-open window [periodStartMs, periodEndMs)
// and split each contribution at week boundaries supplied by weekBoundary(cursorMs).
//
// A6/A4b OVERLAP semantics: an interval is kept when [start, end) intersects the window —
// so a shift that STARTED before the window but ends inside it is NOT dropped; only the
// hours INSIDE the window are counted (seg-clip). Open shifts (end_at null) end at
// min(now, periodEnd). weekBoundary is injected so this stays free of time.ts.
export function splitHoursByWeek(
  intervals: HoursInterval[],
  periodStartMs: number,
  periodEndMs: number,
  weekBoundary: (cursorMs: number) => WeekBoundary,
  now: number,
): Map<string, number> {
  const weeks = new Map<string, number>()
  for (const interval of intervals) {
    const startMs = new Date(interval.start_at).getTime()
    const rawEndMs = interval.end_at ? new Date(interval.end_at).getTime() : Math.min(now, periodEndMs)
    // Keep only intervals that overlap the window. rawEndMs <= start of window OR
    // start >= end of window → no overlap → skip.
    if (rawEndMs <= periodStartMs || startMs >= periodEndMs) continue
    const segStart = Math.max(startMs, periodStartMs)
    const segEnd = Math.min(rawEndMs, periodEndMs)
    let cursor = segStart
    while (cursor < segEnd) {
      const { key, nextBoundaryMs } = weekBoundary(cursor)
      const portionEnd = Math.min(segEnd, nextBoundaryMs)
      const hours = Math.max(0, portionEnd - cursor) / 3600000
      weeks.set(key, (weeks.get(key) ?? 0) + hours)
      cursor = portionEnd
    }
  }
  return weeks
}

export interface RegularOvertimeSplit {
  regularHours: number
  overtimeHours: number
}

// Weekly-overtime split (standard payroll): hours over the threshold within EACH week
// are overtime; summed across the weeks of the period. Full float precision preserved.
export function regularOvertimeSplit(weeks: Map<string, number>, weeklyThreshold = 40): RegularOvertimeSplit {
  let regularHours = 0
  let overtimeHours = 0
  for (const hours of weeks.values()) {
    regularHours += Math.min(hours, weeklyThreshold)
    overtimeHours += Math.max(0, hours - weeklyThreshold)
  }
  return { regularHours, overtimeHours }
}
