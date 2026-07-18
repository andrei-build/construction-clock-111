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

// (е) MyTime — worked ms of a set of adjustment-aware intervals (v_work_intervals) intersecting
// the half-open window [fromMs, toMs). Open shifts (end_at null) are clamped to min(now, toMs).
// Pure overlap-sum so the worker's hour tiles read the SAME source as payroll (edits applied).
export function workedMsInWindow(intervals: HoursInterval[], fromMs: number, toMs: number, now: number): number {
  let ms = 0
  for (const iv of intervals) {
    const startMs = new Date(iv.start_at).getTime()
    const rawEndMs = iv.end_at ? new Date(iv.end_at).getTime() : Math.min(now, toMs)
    if (!Number.isFinite(startMs) || !Number.isFinite(rawEndMs)) continue
    const lo = Math.max(startMs, fromMs)
    const hi = Math.min(rawEndMs, toMs)
    if (hi > lo) ms += hi - lo
  }
  return ms
}

// (д) Overview «Неоплачено» KPI — pure computation, TZ-agnostic and Supabase-free so vitest can
// exercise the OT math directly.
export interface ClosedWindow {
  startMs: number
  endMs: number
}

export interface UnpaidInterval {
  profile_id: string
  start_at: string
  end_at: string | null
}

export interface UnpaidSummary {
  hours: number
  amount: number
}

// UTC Monday-anchored week boundary. The KPI is a dashboard ESTIMATE, so it uses TZ-agnostic UTC
// weeks (exact per-org weekly grouping lives in Payroll). Injected into computeUnpaidSummary so
// tests can pin the boundary.
export function utcMondayWeekBoundary(cursorMs: number): WeekBoundary {
  const d = new Date(cursorMs)
  const dayFromMon = (d.getUTCDay() + 6) % 7 // 0 = Monday
  const mondayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dayFromMon)
  return { key: new Date(mondayMs).toISOString(), nextBoundaryMs: mondayMs + 7 * 24 * 3600000 }
}

// Subtract closed (approved/paid) pay-period windows from [startMs, endMs), returning the UNPAID
// sub-segments. Splitting each interval against every closed window in turn preserves the exact
// unpaid slices (needed later for weekly OT grouping).
export function unpaidSegments(startMs: number, endMs: number, closed: ClosedWindow[]): ClosedWindow[] {
  let open: ClosedWindow[] = [{ startMs, endMs }]
  for (const period of closed) {
    const next: ClosedWindow[] = []
    for (const segment of open) {
      const overlapStart = Math.max(segment.startMs, period.startMs)
      const overlapEnd = Math.min(segment.endMs, period.endMs)
      if (overlapEnd <= overlapStart) {
        next.push(segment)
        continue
      }
      if (segment.startMs < overlapStart) next.push({ startMs: segment.startMs, endMs: overlapStart })
      if (overlapEnd < segment.endMs) next.push({ startMs: overlapEnd, endMs: segment.endMs })
    }
    open = next
    if (open.length === 0) break
  }
  return open
}

// Unpaid hours + money for the Overview KPI. Unpaid = work-interval time outside approved/paid
// periods. Money applies weekly OT ×1.5 (regularOvertimeSplit + computeWorkerTotal) per worker,
// using their latest rate — so a worker over 40 unpaid hours in a week is not undercounted.
// rate === null (no rate on file) contributes 0 money but its hours still count.
export function computeUnpaidSummary(
  intervals: UnpaidInterval[],
  closed: ClosedWindow[],
  rateByWorker: Map<string, number | null>,
  now: number,
  weekBoundary: (cursorMs: number) => WeekBoundary = utcMondayWeekBoundary,
): UnpaidSummary {
  // Collect each worker's unpaid sub-segments as HoursInterval so we can reuse splitHoursByWeek.
  const segByWorker = new Map<string, HoursInterval[]>()
  for (const interval of intervals) {
    const startMs = new Date(interval.start_at).getTime()
    const endMs = interval.end_at ? new Date(interval.end_at).getTime() : now
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue
    const segs = unpaidSegments(startMs, endMs, closed)
    if (segs.length === 0) continue
    const list = segByWorker.get(interval.profile_id) ?? []
    for (const s of segs) list.push({ start_at: new Date(s.startMs).toISOString(), end_at: new Date(s.endMs).toISOString() })
    segByWorker.set(interval.profile_id, list)
  }

  let hours = 0
  let amount = 0
  for (const [profileId, segs] of segByWorker) {
    let winStart = Infinity
    let winEnd = -Infinity
    for (const s of segs) {
      winStart = Math.min(winStart, new Date(s.start_at).getTime())
      winEnd = Math.max(winEnd, new Date(s.end_at as string).getTime())
    }
    // Segments are already clipped to the unpaid windows; the wide [winStart, winEnd) window means
    // splitHoursByWeek only performs the week-boundary split, no further clipping.
    const weeks = splitHoursByWeek(segs, winStart, winEnd, weekBoundary, now)
    const { regularHours, overtimeHours } = regularOvertimeSplit(weeks)
    hours += regularHours + overtimeHours
    const rate = rateByWorker.get(profileId) ?? null
    amount += computeWorkerTotal({ regularHours, overtimeHours, travelHours: 0, rate })
  }
  return { hours, amount }
}
