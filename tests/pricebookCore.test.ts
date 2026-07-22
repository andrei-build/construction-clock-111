import { describe, it, expect } from 'vitest'
import {
  PRICE_STALE_THRESHOLD_DAYS,
  priceAgeDays,
  isPriceStale,
  priceFreshness,
  staleBadgeTone,
  formatUsd,
  parsePriceInput,
  matchesPricebookSearch,
} from '../src/lib/pricebookCore'

const NOW = '2026-07-22T00:00:00.000Z'

describe('priceAgeDays', () => {
  it('returns null for empty / broken date', () => {
    expect(priceAgeDays(null, NOW)).toBe(null)
    expect(priceAgeDays(undefined, NOW)).toBe(null)
    expect(priceAgeDays('', NOW)).toBe(null)
    expect(priceAgeDays('not-a-date', NOW)).toBe(null)
  })
  it('counts whole days between update and now', () => {
    expect(priceAgeDays('2026-07-12T00:00:00.000Z', NOW)).toBe(10)
    expect(priceAgeDays(NOW, NOW)).toBe(0)
  })
  it('is negative for a future date (fresher than now)', () => {
    expect(priceAgeDays('2026-08-01T00:00:00.000Z', NOW)).toBe(-10)
  })
})

describe('isPriceStale', () => {
  it('treats a missing date as stale (unknown age)', () => {
    expect(isPriceStale(null, NOW)).toBe(true)
  })
  it('is fresh below the threshold, stale at and above it', () => {
    expect(isPriceStale('2026-06-22T00:00:00.000Z', NOW)).toBe(false) // 30 дн.
    // ровно порог (90 дн.) — уже устарела
    expect(isPriceStale('2026-04-23T00:00:00.000Z', NOW, 90)).toBe(true)
    expect(isPriceStale('2026-01-01T00:00:00.000Z', NOW)).toBe(true)
  })
  it('a future date is never stale', () => {
    expect(isPriceStale('2026-08-01T00:00:00.000Z', NOW)).toBe(false)
  })
  it('respects a custom threshold', () => {
    expect(isPriceStale('2026-07-12T00:00:00.000Z', NOW, 5)).toBe(true) // 10 дн. > 5
    expect(isPriceStale('2026-07-12T00:00:00.000Z', NOW, 30)).toBe(false)
    expect(PRICE_STALE_THRESHOLD_DAYS).toBe(90)
  })
})

describe('priceFreshness & staleBadgeTone', () => {
  it('splits into unknown / stale / fresh', () => {
    expect(priceFreshness(null, NOW)).toBe('unknown')
    expect(priceFreshness('2026-01-01T00:00:00.000Z', NOW)).toBe('stale')
    expect(priceFreshness('2026-07-20T00:00:00.000Z', NOW)).toBe('fresh')
  })
  it('maps fresh→green, otherwise amber', () => {
    expect(staleBadgeTone('fresh')).toBe('green')
    expect(staleBadgeTone('stale')).toBe('amber')
    expect(staleBadgeTone('unknown')).toBe('amber')
  })
})

describe('formatUsd', () => {
  it('renders dash for null / invalid', () => {
    expect(formatUsd(null)).toBe('—')
    expect(formatUsd(undefined)).toBe('—')
    expect(formatUsd(NaN)).toBe('—')
  })
  it('groups thousands and uses a comma decimal', () => {
    expect(formatUsd(1234.56)).toBe('1 234,56 $')
    expect(formatUsd(0)).toBe('0,00 $')
    expect(formatUsd(9)).toBe('9,00 $')
    expect(formatUsd(1000000)).toBe('1 000 000,00 $')
  })
  it('keeps the sign for negatives', () => {
    expect(formatUsd(-42.5)).toBe('-42,50 $')
  })
})

describe('parsePriceInput', () => {
  it('returns null for empty / junk / negative', () => {
    expect(parsePriceInput('')).toBe(null)
    expect(parsePriceInput('   ')).toBe(null)
    expect(parsePriceInput('abc')).toBe(null)
    expect(parsePriceInput('-5')).toBe(null)
    expect(parsePriceInput(null)).toBe(null)
  })
  it('accepts comma decimals and grouped digits', () => {
    expect(parsePriceInput('1234.56')).toBe(1234.56)
    expect(parsePriceInput('1 234,56')).toBe(1234.56)
    expect(parsePriceInput('0')).toBe(0)
  })
})

describe('matchesPricebookSearch', () => {
  const item = { name: 'Grohe Rainshower', brand: 'Grohe', category: 'shower' }
  it('empty / whitespace query matches everything', () => {
    expect(matchesPricebookSearch(item, '')).toBe(true)
    expect(matchesPricebookSearch(item, '   ')).toBe(true)
    expect(matchesPricebookSearch(item, null)).toBe(true)
  })
  it('matches name / brand / category case-insensitively', () => {
    expect(matchesPricebookSearch(item, 'rain')).toBe(true)
    expect(matchesPricebookSearch(item, 'GROHE')).toBe(true)
    expect(matchesPricebookSearch(item, 'shower')).toBe(true)
    expect(matchesPricebookSearch(item, 'tile')).toBe(false)
  })
  it('tolerates missing fields', () => {
    expect(matchesPricebookSearch({ name: null, brand: null, category: 'fan' }, 'fan')).toBe(true)
    expect(matchesPricebookSearch({}, 'x')).toBe(false)
  })
})
