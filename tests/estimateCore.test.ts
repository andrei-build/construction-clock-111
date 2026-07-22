import { describe, it, expect } from 'vitest'
import {
  ESTIMATE_STATUSES,
  isStatus,
  normalizeStatus,
  canTransition,
  nextStatus,
  normalizeFlag,
  flagEmoji,
  sourceKind,
  sourcePage,
  sourceFileId,
  sourceBadgeLabel,
  computeLineTotal,
  computeTotals,
} from '../src/lib/estimateCore'

describe('status guards & transitions', () => {
  it('recognizes valid statuses', () => {
    expect(ESTIMATE_STATUSES).toEqual(['draft', 'review', 'approved'])
    expect(isStatus('draft')).toBe(true)
    expect(isStatus('approved')).toBe(true)
    expect(isStatus('sent')).toBe(false)
    expect(isStatus(null)).toBe(false)
  })
  it('normalizes unknown to draft', () => {
    expect(normalizeStatus('review')).toBe('review')
    expect(normalizeStatus('bogus')).toBe('draft')
    expect(normalizeStatus(undefined)).toBe('draft')
  })
  it('allows only strict forward single-step transitions', () => {
    expect(canTransition('draft', 'review')).toBe(true)
    expect(canTransition('review', 'approved')).toBe(true)
    // никакого скипа/отката/самоперехода
    expect(canTransition('draft', 'approved')).toBe(false)
    expect(canTransition('review', 'draft')).toBe(false)
    expect(canTransition('approved', 'review')).toBe(false)
    expect(canTransition('draft', 'draft')).toBe(false)
    expect(canTransition('approved', 'approved')).toBe(false)
    expect(canTransition('draft', 'bogus')).toBe(false)
  })
  it('gives the next status in the chain', () => {
    expect(nextStatus('draft')).toBe('review')
    expect(nextStatus('review')).toBe('approved')
    expect(nextStatus('approved')).toBe(null)
    expect(nextStatus('bogus')).toBe(null)
  })
})

describe('flag → emoji', () => {
  it('maps english + russian color words to the traffic light', () => {
    expect(normalizeFlag('green')).toBe('green')
    expect(normalizeFlag('зелёный')).toBe('green')
    expect(normalizeFlag('жёлтый')).toBe('yellow')
    expect(normalizeFlag('желтый')).toBe('yellow')
    expect(normalizeFlag('amber')).toBe('yellow')
    expect(normalizeFlag('красный')).toBe('red')
    expect(normalizeFlag('RED')).toBe('red')
  })
  it('unknown / empty → null (no marker)', () => {
    expect(normalizeFlag('')).toBe(null)
    expect(normalizeFlag(null)).toBe(null)
    expect(normalizeFlag('blue')).toBe(null)
  })
  it('flagEmoji returns the circle or empty string', () => {
    expect(flagEmoji('green')).toBe('🟢')
    expect(flagEmoji('жёлтый')).toBe('🟡')
    expect(flagEmoji('red')).toBe('🔴')
    expect(flagEmoji('')).toBe('')
    expect(flagEmoji(undefined)).toBe('')
  })
})

describe('source parsing', () => {
  it('reads kind / page / file_id defensively', () => {
    const s = { kind: 'page', page: 3, file_id: 'f-1' }
    expect(sourceKind(s)).toBe('page')
    expect(sourcePage(s)).toBe(3)
    expect(sourceFileId(s)).toBe('f-1')
  })
  it('coerces page from string and rejects junk', () => {
    expect(sourcePage({ kind: 'page', page: '5' })).toBe(5)
    expect(sourcePage({ kind: 'page', page: 0 })).toBe(null)
    expect(sourcePage({ kind: 'rule' })).toBe(null)
    expect(sourcePage(null)).toBe(null)
  })
  it('unknown / broken source → unknown kind, null ids', () => {
    expect(sourceKind({ kind: 'whatever' })).toBe('unknown')
    expect(sourceKind(null)).toBe('unknown')
    expect(sourceKind([])).toBe('unknown')
    expect(sourceFileId({})).toBe(null)
  })
  it('sourceBadgeLabel matches the RU spec', () => {
    expect(sourceBadgeLabel({ kind: 'page', page: 7 })).toBe('Страница 7')
    expect(sourceBadgeLabel({ kind: 'page' })).toBe('Страница')
    expect(sourceBadgeLabel({ kind: 'rule' })).toBe('Правило')
    expect(sourceBadgeLabel({ kind: 'norm' })).toBe('Норма')
    expect(sourceBadgeLabel({ kind: 'catalog' })).toBe('Каталог')
    expect(sourceBadgeLabel(null)).toBe('')
  })
})

describe('totals', () => {
  it('takes explicit line_total when present', () => {
    expect(computeLineTotal({ line_total: 123.456 })).toBe(123.46)
    expect(computeLineTotal({ line_total: 0 })).toBe(0)
  })
  it('computes line_total from qty * price * markup when missing', () => {
    expect(computeLineTotal({ qty: 2, unit_price: 10 })).toBe(20)
    expect(computeLineTotal({ qty: 2, unit_price: 10, markup_pct: 10 })).toBe(22)
    expect(computeLineTotal({ qty: 'x', unit_price: 10 } as never)).toBe(0)
  })
  it('sums subtotal and applies contingency', () => {
    const items = [{ line_total: 100 }, { line_total: 50 }, { qty: 1, unit_price: 25 }]
    expect(computeTotals(items, 10)).toEqual({ subtotal: 175, total: 192.5 })
    expect(computeTotals(items, 0)).toEqual({ subtotal: 175, total: 175 })
  })
  it('handles empty / junk input safely', () => {
    expect(computeTotals([], 15)).toEqual({ subtotal: 0, total: 0 })
    expect(computeTotals(null, 'x')).toEqual({ subtotal: 0, total: 0 })
  })
})
