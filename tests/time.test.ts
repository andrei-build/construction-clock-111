import { describe, it, expect } from 'vitest'
import {
  shiftState,
  workedMs,
  fmtHours,
  fmtClock,
  todayStartISO,
  weekStartISO,
  yesterdayStartISO,
  lastWeekStartISO,
  computeTravelGaps,
  intervalsToTravelShifts,
  eventsToTravelShifts,
  orgWeekGrouping,
  DEFAULT_PAID_GAP_ALERT_HOURS,
  type TravelShift,
} from '../src/lib/time'
import type { TimeEvent, TimeEventType, WorkInterval } from '../src/lib/types'

// ── test builders ─────────────────────────────────────────────────────────────
let _seq = 0
function ev(event_type: TimeEventType, event_time: string, project_id: string | null = 'p1'): TimeEvent {
  return {
    id: `e${_seq++}`,
    org_id: 'o1',
    profile_id: 'u1',
    project_id,
    event_type,
    event_time,
    gps_status: null,
    metadata: {},
  }
}
const H = 3600000 // ms per hour
const iso = (s: string) => new Date(s).getTime()

// ═══════════════════════════════════════════════════════════════════════════════
// workedMs — worked hours from event pairs, breaks excluded, open shift → now
// ═══════════════════════════════════════════════════════════════════════════════
describe('workedMs', () => {
  it('empty event list is zero', () => {
    expect(workedMs([])).toBe(0)
  })

  it('single closed shift counts full span', () => {
    const events = [ev('check_in', '2026-01-05T09:00:00Z'), ev('check_out', '2026-01-05T17:00:00Z')]
    expect(workedMs(events)).toBe(8 * H)
  })

  it('subtracts a single break', () => {
    const events = [
      ev('check_in', '2026-01-05T09:00:00Z'),
      ev('break_start', '2026-01-05T12:00:00Z'),
      ev('break_end', '2026-01-05T12:30:00Z'),
      ev('check_out', '2026-01-05T17:00:00Z'),
    ]
    expect(workedMs(events)).toBe(7.5 * H)
  })

  it('subtracts two breaks in one shift', () => {
    const events = [
      ev('check_in', '2026-01-05T09:00:00Z'),
      ev('break_start', '2026-01-05T10:00:00Z'),
      ev('break_end', '2026-01-05T10:15:00Z'),
      ev('break_start', '2026-01-05T12:00:00Z'),
      ev('break_end', '2026-01-05T12:30:00Z'),
      ev('check_out', '2026-01-05T17:00:00Z'),
    ]
    // 8h span − 15m − 30m = 7.25h
    expect(workedMs(events)).toBe(7.25 * H)
  })

  it('open shift counts up to the supplied now', () => {
    const events = [ev('check_in', '2026-01-05T09:00:00Z')]
    expect(workedMs(events, iso('2026-01-05T14:00:00Z'))).toBe(5 * H)
  })

  it('open shift currently on break counts only up to break start', () => {
    const events = [ev('check_in', '2026-01-05T09:00:00Z'), ev('break_start', '2026-01-05T12:00:00Z')]
    expect(workedMs(events, iso('2026-01-05T17:00:00Z'))).toBe(3 * H)
  })

  it('accepts events out of chronological order (it sorts)', () => {
    const events = [ev('check_out', '2026-01-05T17:00:00Z'), ev('check_in', '2026-01-05T09:00:00Z')]
    expect(workedMs(events)).toBe(8 * H)
  })

  it('ignores a check_out with no matching check_in', () => {
    expect(workedMs([ev('check_out', '2026-01-05T17:00:00Z')])).toBe(0)
  })

  it('ignores a break_start when off the clock', () => {
    const events = [
      ev('break_start', '2026-01-05T08:00:00Z'),
      ev('check_in', '2026-01-05T09:00:00Z'),
      ev('check_out', '2026-01-05T17:00:00Z'),
    ]
    expect(workedMs(events)).toBe(8 * H)
  })

  it('checking out while still on break excludes the break tail', () => {
    // check_out during a break → effectiveEnd is the break start, not the check_out time
    const events = [
      ev('check_in', '2026-01-05T09:00:00Z'),
      ev('break_start', '2026-01-05T15:00:00Z'),
      ev('check_out', '2026-01-05T17:00:00Z'),
    ]
    expect(workedMs(events)).toBe(6 * H)
  })

  it('SUSPECTED BUG: a second check_in with no intervening check_out drops the first span', () => {
    // Documents ACTUAL behaviour: the second check_in overwrites inAt, so 09:00–10:00 is lost.
    const events = [
      ev('check_in', '2026-01-05T09:00:00Z'),
      ev('check_in', '2026-01-05T10:00:00Z'),
      ev('check_out', '2026-01-05T17:00:00Z'),
    ]
    expect(workedMs(events)).toBe(7 * H) // ideally 8h; see summary
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// shiftState — derive current status from the day's events
// ═══════════════════════════════════════════════════════════════════════════════
describe('shiftState', () => {
  it('no events → off', () => {
    expect(shiftState([])).toEqual({ status: 'off', since: null, projectId: null })
  })

  it('check_in → on, carrying since + projectId', () => {
    expect(shiftState([ev('check_in', '2026-01-05T09:00:00Z', 'proj-9')])).toEqual({
      status: 'on',
      since: '2026-01-05T09:00:00Z',
      projectId: 'proj-9',
    })
  })

  it('break_start after check_in → break (since/projectId preserved)', () => {
    const events = [ev('check_in', '2026-01-05T09:00:00Z', 'proj-9'), ev('break_start', '2026-01-05T12:00:00Z')]
    expect(shiftState(events)).toEqual({ status: 'break', since: '2026-01-05T09:00:00Z', projectId: 'proj-9' })
  })

  it('break_end returns to on', () => {
    const events = [
      ev('check_in', '2026-01-05T09:00:00Z', 'proj-9'),
      ev('break_start', '2026-01-05T12:00:00Z'),
      ev('break_end', '2026-01-05T12:30:00Z'),
    ]
    expect(shiftState(events).status).toBe('on')
  })

  it('check_out → off with nulls', () => {
    const events = [ev('check_in', '2026-01-05T09:00:00Z'), ev('check_out', '2026-01-05T17:00:00Z')]
    expect(shiftState(events)).toEqual({ status: 'off', since: null, projectId: null })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// fmtHours — ms → 2-decimal hours string (cent-precise, no float drift)
// ═══════════════════════════════════════════════════════════════════════════════
describe('fmtHours', () => {
  it('exact hour', () => expect(fmtHours(H)).toBe('1.00'))
  it('zero', () => expect(fmtHours(0)).toBe('0.00'))
  it('half hour keeps trailing zero to the cent', () => expect(fmtHours(7.5 * H)).toBe('7.50'))
  it('rounds to two decimals', () => expect(fmtHours(3660000)).toBe('1.02')) // 1.01666.. h → 1.02
  it('no floating drift across a summed shift (7.25h)', () => {
    const ms = workedMs([
      ev('check_in', '2026-01-05T09:00:00Z'),
      ev('break_start', '2026-01-05T10:00:00Z'),
      ev('break_end', '2026-01-05T10:15:00Z'),
      ev('break_start', '2026-01-05T12:00:00Z'),
      ev('break_end', '2026-01-05T12:30:00Z'),
      ev('check_out', '2026-01-05T17:00:00Z'),
    ])
    expect(fmtHours(ms)).toBe('7.25')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// computeTravelGaps — paid travel between same-day shifts (G1)
// ═══════════════════════════════════════════════════════════════════════════════
const TZ = 'UTC'
const shift = (start: string, end: string | null): TravelShift => ({
  startMs: iso(start),
  endMs: end === null ? null : iso(end),
})

describe('computeTravelGaps', () => {
  it('empty → no gaps', () => {
    expect(computeTravelGaps([], TZ, 1)).toEqual([])
  })

  it('a single shift has no gap', () => {
    expect(computeTravelGaps([shift('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z')], TZ, 1)).toEqual([])
  })

  it('same-day gap over the alert threshold is paid and flagged', () => {
    const gaps = computeTravelGaps(
      [shift('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z'), shift('2026-01-05T13:30:00Z', '2026-01-05T17:00:00Z')],
      TZ,
      1,
    )
    expect(gaps).toEqual([
      {
        startMs: iso('2026-01-05T12:00:00Z'),
        endMs: iso('2026-01-05T13:30:00Z'),
        durationHours: 1.5,
        overAlert: true,
      },
    ])
  })

  it('gap exactly equal to the alert threshold is NOT over (strict >)', () => {
    const gaps = computeTravelGaps(
      [shift('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z'), shift('2026-01-05T13:00:00Z', '2026-01-05T17:00:00Z')],
      TZ,
      1,
    )
    expect(gaps).toHaveLength(1)
    expect(gaps[0].durationHours).toBe(1)
    expect(gaps[0].overAlert).toBe(false)
  })

  it('cross-day (overnight) gap is never paid', () => {
    const gaps = computeTravelGaps(
      [shift('2026-01-05T22:00:00Z', '2026-01-05T23:00:00Z'), shift('2026-01-06T01:00:00Z', '2026-01-06T05:00:00Z')],
      TZ,
      1,
    )
    expect(gaps).toEqual([])
  })

  it('overlapping intervals produce no gap', () => {
    const gaps = computeTravelGaps(
      [shift('2026-01-05T09:00:00Z', '2026-01-05T14:00:00Z'), shift('2026-01-05T13:00:00Z', '2026-01-05T15:00:00Z')],
      TZ,
      1,
    )
    expect(gaps).toEqual([])
  })

  it('a zero-length boundary (next starts exactly at prev end) is not a gap', () => {
    const gaps = computeTravelGaps(
      [shift('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z'), shift('2026-01-05T12:00:00Z', '2026-01-05T17:00:00Z')],
      TZ,
      1,
    )
    expect(gaps).toEqual([])
  })

  it('an open (un-closed) preceding shift yields no gap after it', () => {
    const gaps = computeTravelGaps(
      [shift('2026-01-05T09:00:00Z', null), shift('2026-01-05T13:00:00Z', '2026-01-05T17:00:00Z')],
      TZ,
      1,
    )
    expect(gaps).toEqual([])
  })

  it('an open following shift can still be the far side of a gap', () => {
    const gaps = computeTravelGaps(
      [shift('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z'), shift('2026-01-05T13:00:00Z', null)],
      TZ,
      1,
    )
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ durationHours: 1, overAlert: false })
  })

  it('sorts unordered shifts and emits two gaps across three same-day shifts', () => {
    const gaps = computeTravelGaps(
      [
        shift('2026-01-05T15:00:00Z', '2026-01-05T17:00:00Z'),
        shift('2026-01-05T09:00:00Z', '2026-01-05T11:00:00Z'),
        shift('2026-01-05T12:00:00Z', '2026-01-05T13:00:00Z'),
      ],
      TZ,
      1,
    )
    expect(gaps.map((g) => g.durationHours)).toEqual([1, 2]) // 11→12 (1h), 13→15 (2h)
    expect(gaps.map((g) => g.overAlert)).toEqual([false, true])
  })

  it('org timezone decides the day boundary (LA-local same day where UTC differs)', () => {
    // 2026-01-05T23:30Z and 2026-01-06T01:30Z are the same LA-local day (Jan 5, UTC-8).
    const gaps = computeTravelGaps(
      [shift('2026-01-05T22:00:00Z', '2026-01-05T23:30:00Z'), shift('2026-01-06T01:30:00Z', '2026-01-06T03:00:00Z')],
      'America/Los_Angeles',
      1,
    )
    expect(gaps).toHaveLength(1)
    expect(gaps[0].durationHours).toBe(2)
  })

  it('DEFAULT_PAID_GAP_ALERT_HOURS is 1', () => {
    expect(DEFAULT_PAID_GAP_ALERT_HOURS).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// intervalsToTravelShifts / eventsToTravelShifts — adapters
// ═══════════════════════════════════════════════════════════════════════════════
describe('intervalsToTravelShifts', () => {
  const wi = (start_at: string, end_at: string | null): WorkInterval => ({
    org_id: 'o1',
    profile_id: 'u1',
    project_id: 'p1',
    start_event_id: 's',
    end_event_id: end_at ? 'e' : null,
    start_at,
    end_at,
    was_adjusted: false,
    adjust_reason: null,
  })

  it('maps closed and open intervals to epoch ms', () => {
    const shifts = intervalsToTravelShifts([
      wi('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z'),
      wi('2026-01-05T13:00:00Z', null),
    ])
    expect(shifts).toEqual([
      { startMs: iso('2026-01-05T09:00:00Z'), endMs: iso('2026-01-05T12:00:00Z') },
      { startMs: iso('2026-01-05T13:00:00Z'), endMs: null },
    ])
  })

  it('empty in → empty out', () => {
    expect(intervalsToTravelShifts([])).toEqual([])
  })
})

describe('eventsToTravelShifts', () => {
  it('pairs check_in/check_out and treats breaks as internal', () => {
    const shifts = eventsToTravelShifts([
      ev('check_in', '2026-01-05T09:00:00Z'),
      ev('break_start', '2026-01-05T10:00:00Z'),
      ev('break_end', '2026-01-05T10:30:00Z'),
      ev('check_out', '2026-01-05T12:00:00Z'),
    ])
    expect(shifts).toEqual([{ startMs: iso('2026-01-05T09:00:00Z'), endMs: iso('2026-01-05T12:00:00Z') }])
  })

  it('a trailing check_in yields an open shift', () => {
    const shifts = eventsToTravelShifts([
      ev('check_in', '2026-01-05T09:00:00Z'),
      ev('check_out', '2026-01-05T12:00:00Z'),
      ev('check_in', '2026-01-05T13:00:00Z'),
    ])
    expect(shifts).toEqual([
      { startMs: iso('2026-01-05T09:00:00Z'), endMs: iso('2026-01-05T12:00:00Z') },
      { startMs: iso('2026-01-05T13:00:00Z'), endMs: null },
    ])
  })

  it('empty → empty', () => {
    expect(eventsToTravelShifts([])).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// orgWeekGrouping — org-local day + week bounds, DST-correct (F2)
// ═══════════════════════════════════════════════════════════════════════════════
describe('orgWeekGrouping', () => {
  it('buckets a UTC instant into its ISO week (Monday start)', () => {
    const g = orgWeekGrouping('2026-07-15T10:00:00Z', 'UTC') // Wed 2026-07-15
    expect(g.ymd).toBe('2026-07-15')
    expect(g.weekKey).toBe('2026-07-13') // Monday
    expect(g.weekStartMs).toBe(iso('2026-07-13T00:00:00Z'))
    expect(g.nextWeekStartMs).toBe(iso('2026-07-20T00:00:00Z'))
  })

  it('zero-pads the org-local ymd', () => {
    const g = orgWeekGrouping('2026-01-05T10:00:00Z', 'UTC')
    expect(g.ymd).toBe('2026-01-05')
    expect(g.weekKey).toBe('2026-01-05') // Jan 5 2026 is itself a Monday
  })

  it('computes DST-correct week bounds across the US spring-forward (167h week)', () => {
    // Week of Sun 2026-03-08 (DST starts): Monday 03-02 (EST) → next Monday 03-09 (EDT).
    const g = orgWeekGrouping('2026-03-08T12:00:00Z', 'America/New_York')
    expect(g.ymd).toBe('2026-03-08')
    expect(g.weekKey).toBe('2026-03-02')
    expect(g.weekStartMs).toBe(iso('2026-03-02T05:00:00Z')) // EST midnight
    expect(g.nextWeekStartMs).toBe(iso('2026-03-09T04:00:00Z')) // EDT midnight
    expect((g.nextWeekStartMs - g.weekStartMs) / H).toBe(167) // one hour short — spring forward
  })

  it('uses the org timezone for the day, not UTC (LA rolls back a day)', () => {
    // 2026-07-15T05:00Z is still 2026-07-14 22:00 in LA.
    const g = orgWeekGrouping('2026-07-15T05:00:00Z', 'America/Los_Angeles')
    expect(g.ymd).toBe('2026-07-14')
  })

  it('accepts ISO string, epoch ms, and Date interchangeably', () => {
    const ms = iso('2026-07-15T10:00:00Z')
    const fromString = orgWeekGrouping('2026-07-15T10:00:00Z', 'UTC')
    const fromNumber = orgWeekGrouping(ms, 'UTC')
    const fromDate = orgWeekGrouping(new Date(ms), 'UTC')
    expect(fromNumber).toEqual(fromString)
    expect(fromDate).toEqual(fromString)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// device-local ISO helpers — invariants only (depend on the wall clock / TZ)
// ═══════════════════════════════════════════════════════════════════════════════
describe('local ISO boundary helpers', () => {
  it('todayStartISO is a valid past instant within the last 24h', () => {
    const t = Date.parse(todayStartISO())
    expect(Number.isNaN(t)).toBe(false)
    const now = Date.now()
    expect(t).toBeLessThanOrEqual(now)
    expect(now - t).toBeLessThan(24 * H)
  })

  it('yesterdayStartISO is exactly 24h before todayStartISO', () => {
    expect(Date.parse(todayStartISO()) - Date.parse(yesterdayStartISO())).toBe(24 * H)
  })

  it('weekStartISO is a Monday at local midnight, at or before today', () => {
    const d = new Date(weekStartISO())
    expect(d.getDay()).toBe(1) // Monday, device-local
    expect(d.getHours()).toBe(0)
    expect(Date.parse(weekStartISO())).toBeLessThanOrEqual(Date.parse(todayStartISO()))
  })

  it('lastWeekStartISO is exactly 7 days before weekStartISO', () => {
    expect(Date.parse(weekStartISO()) - Date.parse(lastWeekStartISO())).toBe(7 * 24 * H)
  })

  it('fmtClock returns a non-empty time string', () => {
    expect(fmtClock('2026-01-05T09:30:00Z')).toMatch(/\d/)
  })
})
