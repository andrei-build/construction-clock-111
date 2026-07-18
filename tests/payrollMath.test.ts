import { describe, it, expect } from 'vitest'
import {
  round2,
  computeWorkerTotal,
  splitHoursByWeek,
  regularOvertimeSplit,
  workedMsInWindow,
  unpaidSegments,
  computeUnpaidSummary,
  type HoursInterval,
  type WeekBoundary,
  type ClosedWindow,
  type UnpaidInterval,
} from '../src/lib/payrollMath'

// ── helpers ─────────────────────────────────────────────────────────────────
const H = 3600000
const iso = (s: string) => new Date(s).getTime()
const sumWeeks = (weeks: Map<string, number>) => [...weeks.values()].reduce((a, b) => a + b, 0)

// Fixed UTC-Monday week boundary — test-owned, so this file never imports time.ts.
// weeks start Monday 00:00Z, matching the (device) grouping payrollMath is fed in prod.
function utcWeekBoundary(cursor: number): WeekBoundary {
  const d = new Date(cursor)
  const isoDow = (d.getUTCDay() + 6) % 7 // 0 = Mon
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - isoDow)
  return { key: new Date(monday).toISOString().slice(0, 10), nextBoundaryMs: monday + 7 * 24 * H }
}

const NOW = iso('2026-06-01T00:00:00Z') // fixed "now" for open-shift tests (far future)

// ═══════════════════════════════════════════════════════════════════════════════
// round2 — round-HALF-UP to the cent, float-epsilon-safe
// ═══════════════════════════════════════════════════════════════════════════════
describe('round2', () => {
  it('rounds a clean half-cent UP (epsilon-safe)', () => {
    expect(round2(1.005)).toBe(1.01)
    expect(round2(2.005)).toBe(2.01)
    expect(round2(0.005)).toBe(0.01)
  })

  it('leaves already-2dp values unchanged and rounds down below half', () => {
    expect(round2(3.01)).toBe(3.01)
    expect(round2(1.004)).toBe(1.0)
    expect(round2(100)).toBe(100)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// computeWorkerTotal — FROZEN round-SUM contract (round ONCE on the sum)
// ═══════════════════════════════════════════════════════════════════════════════
describe('computeWorkerTotal', () => {
  it('round-SUM diverges from round-EACH by exactly one cent (round-SUM wins)', () => {
    // rate = 1 → components equal the hours. regular = 1.005, travel = 2.005.
    // round-EACH: round2(1.005) + round2(2.005) = 1.01 + 2.01 = 3.02
    // round-SUM : round2(1.005 + 2.005) = round2(3.01)         = 3.01
    const total = computeWorkerTotal({ regularHours: 1.005, overtimeHours: 0, travelHours: 2.005, rate: 1 })
    const roundEach = round2(1.005 * 1) + round2(2.005 * 1)
    expect(total).toBe(3.01)
    expect(roundEach).toBeCloseTo(3.02, 10) // 1.01 + 2.01 (float: 3.0199999999999996)
    expect(roundEach - total).toBeCloseTo(0.01, 10) // exactly one cent apart
  })

  it('sums regular + OT×1.5 + travel from full-precision hours', () => {
    // 10h reg @ $20 = 200; 2h OT @ $30 = 60; 1.5h travel @ $20 = 30 → 290.00
    const total = computeWorkerTotal({ regularHours: 10, overtimeHours: 2, travelHours: 1.5, rate: 20 })
    expect(total).toBe(290)
  })

  it('applies bonus + reimbursement and subtracts deduction before the single round', () => {
    const total = computeWorkerTotal({
      regularHours: 10, overtimeHours: 0, travelHours: 0, rate: 20,
      bonus: 50, reimbursement: 12.5, deduction: 7.5,
    })
    expect(total).toBe(255) // 200 + 50 + 12.5 - 7.5
  })

  it('rate === null → 0', () => {
    expect(computeWorkerTotal({ regularHours: 10, overtimeHours: 5, travelHours: 2, rate: null })).toBe(0)
  })

  it('honours a non-default overtime multiplier', () => {
    expect(computeWorkerTotal({ regularHours: 0, overtimeHours: 4, travelHours: 0, rate: 10, overtimeMultiplier: 2 })).toBe(80)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// regularOvertimeSplit — weekly 40h threshold split
// ═══════════════════════════════════════════════════════════════════════════════
describe('regularOvertimeSplit — 40h boundary', () => {
  it('39.99h → all regular, no OT', () => {
    const s = regularOvertimeSplit(new Map([['w1', 39.99]]))
    expect(s.regularHours).toBeCloseTo(39.99, 10)
    expect(s.overtimeHours).toBe(0)
  })

  it('40.00h → exactly 40 regular, no OT', () => {
    const s = regularOvertimeSplit(new Map([['w1', 40.0]]))
    expect(s.regularHours).toBe(40)
    expect(s.overtimeHours).toBe(0)
  })

  it('40.01h → 40 regular + 0.01 OT', () => {
    const s = regularOvertimeSplit(new Map([['w1', 40.01]]))
    expect(s.regularHours).toBe(40)
    expect(s.overtimeHours).toBeCloseTo(0.01, 10)
  })

  it('threshold is PER WEEK, not per period (35 + 45 = 45 reg + 5 OT)', () => {
    const s = regularOvertimeSplit(new Map([['w1', 35], ['w2', 45]]))
    expect(s.regularHours).toBe(75) // 35 + min(45,40)=40
    expect(s.overtimeHours).toBe(5) // only w2 exceeds
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// splitHoursByWeek — A4b overlap-clip + week split + midnight + DST
// ═══════════════════════════════════════════════════════════════════════════════
describe('splitHoursByWeek — overlap clip to the window', () => {
  // period window: Mon 2026-01-05 00:00Z .. Mon 2026-01-19 00:00Z (two weeks, half-open)
  const pStart = iso('2026-01-05T00:00:00Z')
  const pEnd = iso('2026-01-19T00:00:00Z')

  it('a shift that STARTED before the period but ends inside is NOT dropped (only in-window hours counted)', () => {
    const intervals: HoursInterval[] = [
      { start_at: '2026-01-04T22:00:00Z', end_at: '2026-01-05T06:00:00Z' }, // 8h wall, 6h in-window
    ]
    const weeks = splitHoursByWeek(intervals, pStart, pEnd, utcWeekBoundary, NOW)
    expect(sumWeeks(weeks)).toBeCloseTo(6, 10) // 00:00Z→06:00Z only, pre-window 22:00→00:00 clipped
  })

  it('a shift entirely before the period IS dropped', () => {
    const intervals: HoursInterval[] = [
      { start_at: '2026-01-03T08:00:00Z', end_at: '2026-01-03T16:00:00Z' },
    ]
    const weeks = splitHoursByWeek(intervals, pStart, pEnd, utcWeekBoundary, NOW)
    expect(sumWeeks(weeks)).toBe(0)
  })

  it('a shift running past the period end is clipped to the window', () => {
    const intervals: HoursInterval[] = [
      { start_at: '2026-01-18T20:00:00Z', end_at: '2026-01-19T04:00:00Z' }, // 8h wall, 4h in-window
    ]
    const weeks = splitHoursByWeek(intervals, pStart, pEnd, utcWeekBoundary, NOW)
    expect(sumWeeks(weeks)).toBeCloseTo(4, 10)
  })

  it('an OPEN shift (end_at null) that started before period end is included, ending at min(now, periodEnd)', () => {
    const intervals: HoursInterval[] = [
      { start_at: '2026-01-06T00:00:00Z', end_at: null },
    ]
    // now is far past periodEnd → clipped to periodEnd. 2026-01-06T00:00Z → 2026-01-19T00:00Z = 13 days.
    const weeks = splitHoursByWeek(intervals, pStart, pEnd, utcWeekBoundary, NOW)
    expect(sumWeeks(weeks)).toBeCloseTo(13 * 24, 10)
  })

  it('splits a shift crossing the WEEK boundary into two week keys', () => {
    const intervals: HoursInterval[] = [
      { start_at: '2026-01-11T20:00:00Z', end_at: '2026-01-12T04:00:00Z' }, // Sun 20:00 → Mon 04:00
    ]
    const weeks = splitHoursByWeek(intervals, pStart, pEnd, utcWeekBoundary, NOW)
    expect(weeks.get('2026-01-05')).toBeCloseTo(4, 10) // 20:00→24:00 Sun in week of 01-05
    expect(weeks.get('2026-01-12')).toBeCloseTo(4, 10) // 00:00→04:00 Mon in week of 01-12
    expect(sumWeeks(weeks)).toBeCloseTo(8, 10)
  })

  it('a shift crossing MIDNIGHT within one week stays in that week, full hours', () => {
    const intervals: HoursInterval[] = [
      { start_at: '2026-01-06T22:00:00Z', end_at: '2026-01-07T02:00:00Z' }, // Tue 22:00 → Wed 02:00
    ]
    const weeks = splitHoursByWeek(intervals, pStart, pEnd, utcWeekBoundary, NOW)
    expect(weeks.size).toBe(1)
    expect(weeks.get('2026-01-05')).toBeCloseTo(4, 10)
  })
})

describe('splitHoursByWeek — DST transition day (America/Los_Angeles spring forward)', () => {
  // 2026-03-08: at 02:00 PST clocks jump to 03:00 PDT (the 02:00–03:00 wall hour does not exist).
  // A "4-hour" wall shift 01:00→05:00 local = 3 REAL elapsed hours. Timestamps carry the offset:
  //   check_in  01:00 PST (UTC-8) = 09:00Z ; check_out 05:00 PDT (UTC-7) = 12:00Z → 3h absolute.
  it('counts REAL elapsed hours across the spring-forward jump (3h, not 4h wall)', () => {
    const pStart = iso('2026-03-02T00:00:00Z')
    const pEnd = iso('2026-03-16T00:00:00Z')
    const intervals: HoursInterval[] = [
      { start_at: '2026-03-08T09:00:00Z', end_at: '2026-03-08T12:00:00Z' },
    ]
    const weeks = splitHoursByWeek(intervals, pStart, pEnd, utcWeekBoundary, NOW)
    expect(sumWeeks(weeks)).toBeCloseTo(3, 10)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// workedMsInWindow — MyTime tile hours from adjustment-aware intervals (е)
// ═══════════════════════════════════════════════════════════════════════════════
describe('workedMsInWindow — overlap of intervals with a bucket window', () => {
  const from = iso('2026-01-06T00:00:00Z')
  const to = iso('2026-01-07T00:00:00Z') // one-day bucket

  it('sums whole intervals fully inside the window', () => {
    const ivs: HoursInterval[] = [
      { start_at: '2026-01-06T08:00:00Z', end_at: '2026-01-06T12:00:00Z' }, // 4h
      { start_at: '2026-01-06T13:00:00Z', end_at: '2026-01-06T17:30:00Z' }, // 4.5h
    ]
    expect(workedMsInWindow(ivs, from, to, NOW)).toBe(8.5 * H)
  })

  it('clips an interval straddling the window start/end to the in-window part', () => {
    const ivs: HoursInterval[] = [
      { start_at: '2026-01-05T22:00:00Z', end_at: '2026-01-06T02:00:00Z' }, // 2h in-window
      { start_at: '2026-01-06T23:00:00Z', end_at: '2026-01-07T05:00:00Z' }, // 1h in-window
    ]
    expect(workedMsInWindow(ivs, from, to, NOW)).toBe(3 * H)
  })

  it('excludes intervals entirely outside the window', () => {
    const ivs: HoursInterval[] = [
      { start_at: '2026-01-08T08:00:00Z', end_at: '2026-01-08T12:00:00Z' },
    ]
    expect(workedMsInWindow(ivs, from, to, NOW)).toBe(0)
  })

  it('an OPEN interval (end_at null) is clamped to min(now, windowEnd)', () => {
    // now inside the window → clamp to now, not windowEnd.
    const now = iso('2026-01-06T10:00:00Z')
    const ivs: HoursInterval[] = [{ start_at: '2026-01-06T08:00:00Z', end_at: null }]
    expect(workedMsInWindow(ivs, from, to, now)).toBe(2 * H) // 08:00→10:00
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// unpaidSegments — subtract closed pay-period windows from an interval (д)
// ═══════════════════════════════════════════════════════════════════════════════
describe('unpaidSegments', () => {
  const seg = (a: string, b: string): ClosedWindow => ({ startMs: iso(a), endMs: iso(b) })

  it('no closed windows → the whole interval is unpaid', () => {
    const out = unpaidSegments(iso('2026-01-01T00:00:00Z'), iso('2026-01-02T00:00:00Z'), [])
    expect(out).toHaveLength(1)
    expect(out[0].endMs - out[0].startMs).toBe(24 * H)
  })

  it('a closed window fully covering the interval → nothing unpaid', () => {
    const out = unpaidSegments(iso('2026-01-01T06:00:00Z'), iso('2026-01-01T18:00:00Z'), [seg('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')])
    expect(out).toHaveLength(0)
  })

  it('a closed window in the MIDDLE splits the interval into two unpaid pieces', () => {
    const out = unpaidSegments(iso('2026-01-01T00:00:00Z'), iso('2026-01-02T00:00:00Z'), [seg('2026-01-01T08:00:00Z', '2026-01-01T16:00:00Z')])
    const total = out.reduce((s, x) => s + (x.endMs - x.startMs), 0)
    expect(out).toHaveLength(2)
    expect(total).toBe(16 * H) // 24h - 8h closed
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// computeUnpaidSummary — Overview "unpaid" KPI with weekly OT ×1.5 (д)
// ═══════════════════════════════════════════════════════════════════════════════
describe('computeUnpaidSummary — hours outside closed periods, OT ×1.5', () => {
  const boundary = (c: number): WeekBoundary => utcWeekBoundary(c)

  it('sums plain unpaid hours × rate when under 40h/week (no OT)', () => {
    // Two 5h shifts in one week, rate 20 → 10h × 20 = 200, all regular.
    const ivs: UnpaidInterval[] = [
      { profile_id: 'w1', start_at: '2026-01-06T08:00:00Z', end_at: '2026-01-06T13:00:00Z' },
      { profile_id: 'w1', start_at: '2026-01-07T08:00:00Z', end_at: '2026-01-07T13:00:00Z' },
    ]
    const rates = new Map<string, number | null>([['w1', 20]])
    const s = computeUnpaidSummary(ivs, [], rates, NOW, boundary)
    expect(s.hours).toBeCloseTo(10, 10)
    expect(s.amount).toBe(200)
  })

  it('applies OT ×1.5 to unpaid hours over 40 in a week', () => {
    // 45h in one UTC week (Mon 2026-01-05 00:00Z → Tue 21:00Z, same Mon-anchored week),
    // rate 10 → 40×10 + 5×10×1.5 = 400 + 75 = 475.
    const ivs: UnpaidInterval[] = [
      { profile_id: 'w1', start_at: '2026-01-05T00:00:00Z', end_at: '2026-01-06T21:00:00Z' }, // 45h straight, one week
    ]
    const rates = new Map<string, number | null>([['w1', 10]])
    const s = computeUnpaidSummary(ivs, [], rates, NOW, boundary)
    expect(s.hours).toBeCloseTo(45, 10)
    expect(s.amount).toBe(475)
  })

  it('excludes hours inside a closed (approved/paid) window before the OT split', () => {
    // 10h shift, 4h of it inside a closed window → 6h unpaid, rate 10 → 60.
    const ivs: UnpaidInterval[] = [
      { profile_id: 'w1', start_at: '2026-01-06T08:00:00Z', end_at: '2026-01-06T18:00:00Z' },
    ]
    const closed: ClosedWindow[] = [{ startMs: iso('2026-01-06T10:00:00Z'), endMs: iso('2026-01-06T14:00:00Z') }]
    const rates = new Map<string, number | null>([['w1', 10]])
    const s = computeUnpaidSummary(ivs, closed, rates, NOW, boundary)
    expect(s.hours).toBeCloseTo(6, 10)
    expect(s.amount).toBe(60)
  })

  it('rate === null → hours still count, money contributes 0', () => {
    const ivs: UnpaidInterval[] = [
      { profile_id: 'w1', start_at: '2026-01-06T08:00:00Z', end_at: '2026-01-06T16:00:00Z' },
    ]
    const rates = new Map<string, number | null>([['w1', null]])
    const s = computeUnpaidSummary(ivs, [], rates, NOW, boundary)
    expect(s.hours).toBeCloseTo(8, 10)
    expect(s.amount).toBe(0)
  })

  it('OT is PER WORKER PER WEEK, not pooled across workers', () => {
    // Two workers, 30h each in one week → each under 40, no OT. rate 10 → 600 total.
    const ivs: UnpaidInterval[] = [
      { profile_id: 'w1', start_at: '2026-01-05T00:00:00Z', end_at: '2026-01-06T06:00:00Z' }, // 30h
      { profile_id: 'w2', start_at: '2026-01-05T00:00:00Z', end_at: '2026-01-06T06:00:00Z' }, // 30h
    ]
    const rates = new Map<string, number | null>([['w1', 10], ['w2', 10]])
    const s = computeUnpaidSummary(ivs, [], rates, NOW, boundary)
    expect(s.hours).toBeCloseTo(60, 10)
    expect(s.amount).toBe(600) // no OT despite 60h pooled
  })
})
