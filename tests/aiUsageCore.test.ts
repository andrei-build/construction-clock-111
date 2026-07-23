import { describe, it, expect } from 'vitest'
import {
  AI_MODEL_PRICES,
  DEFAULT_AI_MODEL,
  priceForModel,
  costUsd,
  usageDayKey,
  aggregateAiUsage,
  formatUsd,
  formatTokens,
  searchMessages,
  dedupeProposalsByTitle,
} from '../src/lib/aiUsageCore'

const NOW = '2026-07-22T00:00:00.000Z'

describe('priceForModel', () => {
  it('matches a model family by substring (date-suffixed ids too)', () => {
    expect(priceForModel('claude-3-5-sonnet-20241022')).toEqual(AI_MODEL_PRICES['claude-3-5-sonnet'])
    expect(priceForModel('claude-opus-4-1-20250805')).toEqual(AI_MODEL_PRICES['claude-opus-4'])
    expect(priceForModel('claude-haiku-4-5')).toEqual(AI_MODEL_PRICES['claude-haiku-4'])
  })
  it('falls back to the default model price when model is missing / unknown', () => {
    const def = AI_MODEL_PRICES[DEFAULT_AI_MODEL]
    expect(priceForModel(null)).toEqual(def)
    expect(priceForModel(undefined)).toEqual(def)
    expect(priceForModel('')).toEqual(def)
    expect(priceForModel('gpt-4o')).toEqual(def)
  })
})

describe('costUsd', () => {
  it('prices by the given model (per 1M tokens input/output)', () => {
    // opus-4: $5 in / $25 out per 1M
    expect(costUsd(1_000_000, 1_000_000, 'claude-opus-4-1')).toBeCloseTo(30, 6)
    // 200k in + 50k out on sonnet ($3/$15): 0.2*3 + 0.05*15 = 0.6 + 0.75 = 1.35
    expect(costUsd(200_000, 50_000, 'claude-3-5-sonnet')).toBeCloseTo(1.35, 6)
  })
  it('uses the default model price when model is absent', () => {
    // default = claude-3-5-sonnet ($3/$15): 1M in only → $3
    expect(costUsd(1_000_000, 0, null)).toBeCloseTo(3, 6)
    expect(costUsd(1_000_000, 0, undefined)).toBeCloseTo(3, 6)
  })
  it('treats negative / non-finite token counts as 0', () => {
    expect(costUsd(-100, -100, 'claude-opus-4')).toBe(0)
    expect(costUsd(Number.NaN, Number.NaN, 'claude-opus-4')).toBe(0)
  })
})

describe('usageDayKey', () => {
  it('returns the UTC YYYY-MM-DD, null on empty/broken', () => {
    expect(usageDayKey('2026-07-22T13:45:00.000Z')).toBe('2026-07-22')
    expect(usageDayKey(null)).toBe(null)
    expect(usageDayKey('nope')).toBe(null)
  })
})

describe('aggregateAiUsage', () => {
  const events = [
    // within window, has model
    { event_type: 'ai.chat', created_at: '2026-07-22T09:00:00.000Z', data: { tokens_in: 1000, tokens_out: 500, model: 'claude-3-5-sonnet' } },
    { event_type: 'ai.chat', created_at: '2026-07-22T18:00:00.000Z', data: { tokens_in: 2000, tokens_out: 1000, model: 'claude-3-5-sonnet' } },
    // within window, NO model (old row) → approx, priced by default
    { event_type: 'ai.chat', created_at: '2026-07-21T10:00:00.000Z', data: { tokens_in: 500, tokens_out: 100 } },
    // outside 30-day window → counts in totals, NOT in byDay
    { event_type: 'ai.chat', created_at: '2026-05-01T10:00:00.000Z', data: { tokens_in: 4000, tokens_out: 0, model: 'claude-3-5-sonnet' } },
    // non-chat event → ignored entirely
    { event_type: 'task.created', created_at: '2026-07-22T10:00:00.000Z', data: { tokens_in: 9999, tokens_out: 9999 } },
    // missing tokens → treated as 0, still counts as a chat
    { event_type: 'ai.chat', created_at: '2026-07-22T20:00:00.000Z', data: { model: 'claude-3-5-sonnet' } },
  ]

  it('sums tokens and $ across all ai.chat rows', () => {
    const s = aggregateAiUsage(events, NOW, 30)
    expect(s.count).toBe(5)
    expect(s.totalIn).toBe(1000 + 2000 + 500 + 4000 + 0)
    expect(s.totalOut).toBe(500 + 1000 + 100 + 0 + 0)
    // approx because one row lacked a model
    expect(s.approx).toBe(true)
  })

  it('groups by UTC day within the last N days only', () => {
    const s = aggregateAiUsage(events, NOW, 30)
    const dates = s.byDay.map((d) => d.date)
    expect(dates).toEqual(['2026-07-21', '2026-07-22']) // sorted asc, May row excluded
    const jul22 = s.byDay.find((d) => d.date === '2026-07-22')!
    expect(jul22.tokensIn).toBe(3000)
    expect(jul22.tokensOut).toBe(1500)
  })

  it('is empty and zero for no events', () => {
    const s = aggregateAiUsage([], NOW)
    expect(s).toEqual({ totalIn: 0, totalOut: 0, totalUsd: 0, count: 0, approx: false, byDay: [] })
    expect(aggregateAiUsage(null, NOW).count).toBe(0)
  })
})

describe('formatUsd & formatTokens', () => {
  it('formats dollars (2 decimals ≥ $1, 4 decimals below, $0.00 for zero)', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(12.3456)).toBe('$12.35')
    expect(formatUsd(0.0123)).toBe('$0.0123')
    expect(formatUsd(null)).toBe('$0.00')
    expect(formatUsd(-1.5)).toBe('-$1.50')
  })
  it('groups token thousands', () => {
    expect(formatTokens(1234567)).toBe('1 234 567')
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(null)).toBe('0')
  })
})

describe('searchMessages', () => {
  const msgs = [
    { id: '1', content: 'Позвони поставщику Kohler' },
    { id: '2', content: 'Смета по кухне готова' },
    { id: '3', content: null },
  ]
  it('returns everything for empty query', () => {
    expect(searchMessages(msgs, '').length).toBe(3)
    expect(searchMessages(msgs, '   ').length).toBe(3)
    expect(searchMessages(msgs, null).length).toBe(3)
  })
  it('filters by content substring, case-insensitive', () => {
    expect(searchMessages(msgs, 'kohler').map((m) => m.id)).toEqual(['1'])
    expect(searchMessages(msgs, 'СМЕТА').map((m) => m.id)).toEqual(['2'])
    expect(searchMessages(msgs, 'zzz')).toEqual([])
  })
  it('tolerates null content', () => {
    expect(searchMessages(msgs, 'готова').map((m) => m.id)).toEqual(['2'])
  })
})

describe('dedupeProposalsByTitle', () => {
  it('collapses same-title rows within 24h, keeping the freshest', () => {
    const rows = [
      { id: 'a', title: 'Купить плитку', created_at: '2026-07-22T09:00:00.000Z' },
      { id: 'b', title: 'Купить плитку', created_at: '2026-07-22T18:00:00.000Z' }, // freshest of pair
      { id: 'c', title: 'Заказать замер', created_at: '2026-07-22T12:00:00.000Z' },
    ]
    const out = dedupeProposalsByTitle(rows)
    expect(out.map((r) => r.id).sort()).toEqual(['b', 'c'])
  })
  it('keeps same-title rows more than 24h apart as separate clusters', () => {
    const rows = [
      { id: 'a', title: 'Купить плитку', created_at: '2026-07-22T18:00:00.000Z' },
      { id: 'b', title: 'Купить плитку', created_at: '2026-07-20T09:00:00.000Z' }, // > 24h older
    ]
    const out = dedupeProposalsByTitle(rows)
    expect(out.map((r) => r.id)).toEqual(['a', 'b'])
  })
  it('preserves original input order of survivors and does not mutate input', () => {
    const rows = [
      { id: 'a', title: 'X', created_at: '2026-07-22T08:00:00.000Z' },
      { id: 'b', title: 'Y', created_at: '2026-07-22T09:00:00.000Z' },
      { id: 'c', title: 'X', created_at: '2026-07-22T10:00:00.000Z' },
    ]
    const out = dedupeProposalsByTitle(rows)
    expect(out.map((r) => r.id)).toEqual(['b', 'c']) // a collapsed into fresher c; order preserved
    expect(rows.length).toBe(3)
  })
  it('returns [] for empty / null input', () => {
    expect(dedupeProposalsByTitle([])).toEqual([])
    expect(dedupeProposalsByTitle(null)).toEqual([])
  })
})
