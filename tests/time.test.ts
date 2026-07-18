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
// PAY-FIX-1: интеграция «OT-неделя с перерывом» и детерминизм выбора ставки.
import { splitHoursByWeek, regularOvertimeSplit, computeWorkerTotal } from '../src/lib/payrollMath'
import { latestRateByWorker, type RateHistoryRow } from '../src/lib/api/payroll'

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
// PAY-FIX-1: по умолчанию смена открыта check_in и закрыта check_out (обычный переезд-годный конец).
// Для перерыва передаём endType='break_start' у предыдущей и startType='break_end' у следующей.
// Открытая смена (end===null) всегда несёт endType=null.
const shift = (
  start: string,
  end: string | null,
  startType: TimeEventType = 'check_in',
  endType: TimeEventType | null = 'check_out',
): TravelShift => ({
  startMs: iso(start),
  endMs: end === null ? null : iso(end),
  startType,
  endType: end === null ? null : endType,
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

  // PAY-FIX-1: перерыв (v_work_intervals режет смену на паре break_start/break_end) НЕ травел.
  // (а) смена с перерывом 30 мин: интервал закрылся break_start, следующий открылся break_end → гэп
  // 30 мин не оплачивается, хотя он в один день и start>prevEnd.
  it('a break gap (break_start → break_end) is NOT travel', () => {
    const gaps = computeTravelGaps(
      [
        shift('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z', 'check_in', 'break_start'),
        shift('2026-01-05T12:30:00Z', '2026-01-05T17:00:00Z', 'break_end', 'check_out'),
      ],
      TZ,
      1,
    )
    expect(gaps).toEqual([])
  })

  // (б) переезд между объектами в тот же день: ушёл с объекта (check_out), приехал на другой
  // (check_in) — гэп засчитан травелом.
  it('a check_out → check_in gap on the same day IS travel', () => {
    const gaps = computeTravelGaps(
      [
        shift('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z', 'check_in', 'check_out'),
        shift('2026-01-05T13:00:00Z', '2026-01-05T17:00:00Z', 'check_in', 'check_out'),
      ],
      TZ,
      1,
    )
    expect(gaps).toHaveLength(1)
    expect(gaps[0].durationHours).toBe(1)
  })

  // Смешанный день: перерыв внутри первой смены + реальный переезд ко второму объекту.
  // Оплачивается ТОЛЬКО переезд (перерыв — нет).
  it('mixed day: only the check_out→check_in move is paid, the break is not', () => {
    const gaps = computeTravelGaps(
      [
        // Объект A: 09:00 check_in → 12:00 break_start
        shift('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z', 'check_in', 'break_start'),
        // Объект A: 12:30 break_end → 14:00 check_out (перерыв 12:00–12:30 — не травел)
        shift('2026-01-05T12:30:00Z', '2026-01-05T14:00:00Z', 'break_end', 'check_out'),
        // Объект B: 15:00 check_in → 18:00 check_out (переезд 14:00–15:00 — травел 1ч)
        shift('2026-01-05T15:00:00Z', '2026-01-05T18:00:00Z', 'check_in', 'check_out'),
      ],
      TZ,
      1,
    )
    expect(gaps.map((g) => g.durationHours)).toEqual([1])
    expect(gaps[0].startMs).toBe(iso('2026-01-05T14:00:00Z'))
    expect(gaps[0].endMs).toBe(iso('2026-01-05T15:00:00Z'))
  })

  // (г) переезд «через полночь» (check_out вечером, check_in утром следующего дня) НЕ травел —
  // даже при верных типах: ночь не оплачивается (правило одного org-локального дня).
  it('a check_out→check_in gap across midnight is NOT travel', () => {
    const gaps = computeTravelGaps(
      [
        shift('2026-01-05T21:00:00Z', '2026-01-05T23:00:00Z', 'check_in', 'check_out'),
        shift('2026-01-06T07:00:00Z', '2026-01-06T11:00:00Z', 'check_in', 'check_out'),
      ],
      TZ,
      1,
    )
    expect(gaps).toEqual([])
  })

  // Гэп с верным временем/днём, но без типов концов (types не подтянулись) — травелом не считается.
  it('a same-day gap with missing event types is NOT travel', () => {
    const gaps = computeTravelGaps(
      [
        { startMs: iso('2026-01-05T09:00:00Z'), endMs: iso('2026-01-05T12:00:00Z') },
        { startMs: iso('2026-01-05T13:00:00Z'), endMs: iso('2026-01-05T17:00:00Z') },
      ],
      TZ,
      1,
    )
    expect(gaps).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// intervalsToTravelShifts / eventsToTravelShifts — adapters
// ═══════════════════════════════════════════════════════════════════════════════
describe('intervalsToTravelShifts', () => {
  const wi = (
    start_at: string,
    end_at: string | null,
    start_type: TimeEventType | null = 'check_in',
    end_type: TimeEventType | null = end_at ? 'check_out' : null,
  ): WorkInterval => ({
    org_id: 'o1',
    profile_id: 'u1',
    project_id: 'p1',
    start_event_id: 's',
    end_event_id: end_at ? 'e' : null,
    start_at,
    end_at,
    was_adjusted: false,
    adjust_reason: null,
    start_type,
    end_type,
  })

  it('maps closed and open intervals to epoch ms, carrying event types', () => {
    const shifts = intervalsToTravelShifts([
      wi('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z'),
      wi('2026-01-05T13:00:00Z', null),
    ])
    expect(shifts).toEqual([
      { startMs: iso('2026-01-05T09:00:00Z'), endMs: iso('2026-01-05T12:00:00Z'), startType: 'check_in', endType: 'check_out' },
      { startMs: iso('2026-01-05T13:00:00Z'), endMs: null, startType: 'check_in', endType: null },
    ])
  })

  // PAY-FIX-1: интервал, закрытый break_start / открытый break_end (кусок смены до/после перерыва),
  // прокидывает эти типы — computeTravelGaps по ним отбросит перерыв.
  it('carries break event types through unchanged', () => {
    const shifts = intervalsToTravelShifts([
      wi('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z', 'check_in', 'break_start'),
      wi('2026-01-05T12:30:00Z', '2026-01-05T17:00:00Z', 'break_end', 'check_out'),
    ])
    expect(shifts[0].endType).toBe('break_start')
    expect(shifts[1].startType).toBe('break_end')
    // и такой день не даёт травела
    expect(computeTravelGaps(shifts, TZ, 1)).toEqual([])
  })

  // Интервалы без типов (start_type/end_type не заданы) → startType/endType = null (травел не начислится).
  it('maps missing interval types to null', () => {
    const shifts = intervalsToTravelShifts([
      wi('2026-01-05T09:00:00Z', '2026-01-05T12:00:00Z', null, null),
    ])
    expect(shifts).toEqual([
      { startMs: iso('2026-01-05T09:00:00Z'), endMs: iso('2026-01-05T12:00:00Z'), startType: null, endType: null },
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
    // PAY-FIX-1: концы смены — check_in/check_out (перерывы внутренние, не режут смену).
    expect(shifts).toEqual([{ startMs: iso('2026-01-05T09:00:00Z'), endMs: iso('2026-01-05T12:00:00Z'), startType: 'check_in', endType: 'check_out' }])
  })

  it('a trailing check_in yields an open shift', () => {
    const shifts = eventsToTravelShifts([
      ev('check_in', '2026-01-05T09:00:00Z'),
      ev('check_out', '2026-01-05T12:00:00Z'),
      ev('check_in', '2026-01-05T13:00:00Z'),
    ])
    expect(shifts).toEqual([
      { startMs: iso('2026-01-05T09:00:00Z'), endMs: iso('2026-01-05T12:00:00Z'), startType: 'check_in', endType: 'check_out' },
      { startMs: iso('2026-01-05T13:00:00Z'), endMs: null, startType: 'check_in', endType: null },
    ])
  })

  // PAY-FIX-1: две смены check_in→check_out в один день (переезд между ними) дают травел через
  // eventsToTravelShifts (Overview держит сырые события, а не v_work_intervals).
  it('two same-day shifts feed a paid travel gap', () => {
    const shifts = eventsToTravelShifts([
      ev('check_in', '2026-01-05T09:00:00Z'),
      ev('check_out', '2026-01-05T12:00:00Z'),
      ev('check_in', '2026-01-05T13:00:00Z'),
      ev('check_out', '2026-01-05T17:00:00Z'),
    ])
    const gaps = computeTravelGaps(shifts, TZ, 1)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].durationHours).toBe(1)
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

// ═══════════════════════════════════════════════════════════════════════════════
// PAY-FIX-1: OT-неделя с перерывом — часы, травел и деньги совпадают с эталоном (в)
// Собираем полный зарплатный путь: v_work_intervals → weeklyHours (splitHoursByWeek) →
// regularOvertimeSplit + computeTravelGaps → computeWorkerTotal, как в Payroll.buildPayrollRows.
// ═══════════════════════════════════════════════════════════════════════════════
describe('OT week with a break — hours + travel + money match the SQL contract', () => {
  const wiT = (
    start_at: string,
    end_at: string,
    start_type: TimeEventType,
    end_type: TimeEventType,
  ): WorkInterval => ({
    org_id: 'o1', profile_id: 'u1', project_id: 'p1',
    start_event_id: 's', end_event_id: 'e',
    start_at, end_at, was_adjusted: false, adjust_reason: null,
    start_type, end_type,
  })

  it('45h week (40 reg + 5 OT) with a 30m break and a 1h same-day move @ $20', () => {
    const TZU = 'UTC'
    const rate = 20
    // Одна ISO-неделя Пн 2026-01-05 .. Вс 2026-01-11 (UTC).
    const periodStartMs = iso('2026-01-05T00:00:00Z')
    const periodEndMs = iso('2026-01-12T00:00:00Z')
    const intervals: WorkInterval[] = [
      // Пн: смена с перерывом 12:00–12:30 (режется на паре break_start/break_end) → 9ч работы
      wiT('2026-01-05T08:00:00Z', '2026-01-05T12:00:00Z', 'check_in', 'break_start'),
      wiT('2026-01-05T12:30:00Z', '2026-01-05T17:30:00Z', 'break_end', 'check_out'),
      // Вт: 9ч
      wiT('2026-01-06T08:00:00Z', '2026-01-06T17:00:00Z', 'check_in', 'check_out'),
      // Ср: объект A 08–12, объект B 13–18 → 9ч работы + переезд 12:00–13:00 (1ч, оплачивается)
      wiT('2026-01-07T08:00:00Z', '2026-01-07T12:00:00Z', 'check_in', 'check_out'),
      wiT('2026-01-07T13:00:00Z', '2026-01-07T18:00:00Z', 'check_in', 'check_out'),
      // Чт: 9ч
      wiT('2026-01-08T08:00:00Z', '2026-01-08T17:00:00Z', 'check_in', 'check_out'),
      // Пт: 9ч
      wiT('2026-01-09T08:00:00Z', '2026-01-09T17:00:00Z', 'check_in', 'check_out'),
    ]

    // Часы по неделям (как weeklyHours в Payroll: границы недели через orgWeekGrouping).
    const weekBoundary = (cursor: number) => {
      const g = orgWeekGrouping(cursor, TZU)
      return { key: g.weekKey, nextBoundaryMs: g.nextWeekStartMs }
    }
    const weeks = splitHoursByWeek(intervals, periodStartMs, periodEndMs, weekBoundary, periodEndMs)
    const totalHours = [...weeks.values()].reduce((s, h) => s + h, 0)
    expect(totalHours).toBeCloseTo(45, 9) // 9×5 дней, перерыв в интервалы не входит

    const { regularHours, overtimeHours } = regularOvertimeSplit(weeks)
    expect(regularHours).toBe(40)
    expect(overtimeHours).toBeCloseTo(5, 9)

    // Травел: перерыв Пн НЕ считается, реальный переезд Ср (1ч) — считается.
    const gaps = computeTravelGaps(intervalsToTravelShifts(intervals), TZU, 1)
    const travelHours = gaps.reduce((s, g) => s + g.durationHours, 0)
    expect(gaps).toHaveLength(1)
    expect(travelHours).toBe(1)

    // Деньги: 40×20 + 5×20×1.5 + 1×20 = 800 + 150 + 20 = 970.
    const total = computeWorkerTotal({ regularHours, overtimeHours, travelHours, rate })
    expect(total).toBe(970)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// PAY-FIX-1: детерминированный выбор ставки (latestRateByWorker) — как SQL report_payroll
// (effective_from desc, затем created_at desc, берём первую = самую свежую на работника).
// ═══════════════════════════════════════════════════════════════════════════════
describe('latestRateByWorker', () => {
  const row = (profile_id: string, hourly_rate: number | null, effective_from: string, created_at: string): RateHistoryRow =>
    ({ profile_id, hourly_rate, effective_from, created_at })

  it('picks the latest effective_from per worker regardless of input order', () => {
    const rates = latestRateByWorker([
      row('u1', 20, '2026-01-01', '2026-01-01T00:00:00Z'),
      row('u1', 30, '2026-06-01', '2026-06-01T00:00:00Z'), // самая свежая
      row('u1', 25, '2026-03-01', '2026-03-01T00:00:00Z'),
    ])
    expect(rates).toEqual([{ profile_id: 'u1', hourly_rate: 30 }])
  })

  it('breaks effective_from ties by created_at desc', () => {
    const rates = latestRateByWorker([
      row('u1', 20, '2026-06-01', '2026-06-01T09:00:00Z'),
      row('u1', 33, '2026-06-01', '2026-06-01T15:00:00Z'), // тот же день, но создана позже
    ])
    expect(rates).toEqual([{ profile_id: 'u1', hourly_rate: 33 }])
  })

  it('keeps one latest rate per worker', () => {
    const rates = latestRateByWorker([
      row('u1', 20, '2026-01-01', '2026-01-01T00:00:00Z'),
      row('u2', 40, '2026-02-01', '2026-02-01T00:00:00Z'),
      row('u1', 22, '2026-05-01', '2026-05-01T00:00:00Z'),
    ])
    const byId = new Map(rates.map((r) => [r.profile_id, r.hourly_rate]))
    expect(byId.get('u1')).toBe(22)
    expect(byId.get('u2')).toBe(40)
    expect(rates).toHaveLength(2)
  })

  it('preserves a null rate (no rate on file) as null', () => {
    const rates = latestRateByWorker([row('u1', null, '2026-05-01', '2026-05-01T00:00:00Z')])
    expect(rates).toEqual([{ profile_id: 'u1', hourly_rate: null }])
  })

  it('empty history → empty', () => {
    expect(latestRateByWorker([])).toEqual([])
  })
})
