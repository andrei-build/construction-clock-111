import { describe, it, expect } from 'vitest'
import {
  PIN_SEVERITIES,
  PIN_KINDS,
  isSeverity,
  isKind,
  normalizeSeverity,
  normalizeKind,
  pinColor,
  pinEmoji,
  clampBbox,
  pointToBbox,
  pinPercent,
} from '../src/lib/planPinCore'

describe('severity/kind guards & normalizers', () => {
  it('recognizes valid severities and kinds', () => {
    expect(PIN_SEVERITIES).toEqual(['green', 'yellow', 'red'])
    expect(PIN_KINDS).toEqual(['estimate', 'node', 'note'])
    expect(isSeverity('red')).toBe(true)
    expect(isSeverity('blue')).toBe(false)
    expect(isKind('note')).toBe(true)
    expect(isKind('bogus')).toBe(false)
  })
  it('normalizes unknown to schema defaults', () => {
    expect(normalizeSeverity('yellow')).toBe('yellow')
    expect(normalizeSeverity('purple')).toBe('green')
    expect(normalizeSeverity(null)).toBe('green')
    expect(normalizeSeverity(undefined)).toBe('green')
    expect(normalizeKind('node')).toBe('node')
    expect(normalizeKind('xxx')).toBe('estimate')
    expect(normalizeKind(42)).toBe('estimate')
  })
})

describe('pinColor / pinEmoji', () => {
  it('maps each severity to a distinct color', () => {
    expect(pinColor('green')).toBe('#22c55e')
    expect(pinColor('yellow')).toBe('#eab308')
    expect(pinColor('red')).toBe('#ef4444')
  })
  it('falls back to green for junk (layer never breaks)', () => {
    expect(pinColor('nope')).toBe('#22c55e')
    expect(pinColor(null)).toBe('#22c55e')
  })
  it('emoji circles per severity', () => {
    expect(pinEmoji('green')).toBe('🟢')
    expect(pinEmoji('yellow')).toBe('🟡')
    expect(pinEmoji('red')).toBe('🔴')
    expect(pinEmoji('other')).toBe('🟢')
  })
})

describe('clampBbox', () => {
  it('clamps x/y into [0..1]', () => {
    expect(clampBbox({ x: 0.5, y: 0.25 })).toEqual({ x: 0.5, y: 0.25 })
    expect(clampBbox({ x: -1, y: 5 })).toEqual({ x: 0, y: 1 })
  })
  it('keeps optional w/h only when present, clamped', () => {
    expect(clampBbox({ x: 0.2, y: 0.2, w: 2, h: -0.3 })).toEqual({ x: 0.2, y: 0.2, w: 1, h: 0 })
    expect(clampBbox({ x: 0.2, y: 0.2 })).toEqual({ x: 0.2, y: 0.2 })
  })
  it('handles junk / empty jsonb without throwing', () => {
    expect(clampBbox(null)).toEqual({ x: 0, y: 0 })
    expect(clampBbox(undefined)).toEqual({ x: 0, y: 0 })
    expect(clampBbox('nope')).toEqual({ x: 0, y: 0 })
    expect(clampBbox([1, 2])).toEqual({ x: 0, y: 0 })
    expect(clampBbox({ x: NaN, y: Infinity })).toEqual({ x: 0, y: 0 })
  })
  it('coerces numeric strings', () => {
    expect(clampBbox({ x: '0.5', y: '0.75' })).toEqual({ x: 0.5, y: 0.75 })
  })
})

describe('pointToBbox', () => {
  it('converts pixel offset to fraction of page area', () => {
    expect(pointToBbox(50, 100, 200, 400)).toEqual({ x: 0.25, y: 0.25 })
    expect(pointToBbox(200, 400, 200, 400)).toEqual({ x: 1, y: 1 })
  })
  it('clamps out-of-bounds clicks', () => {
    expect(pointToBbox(-10, 500, 200, 400)).toEqual({ x: 0, y: 1 })
  })
  it('no divide-by-zero when area not measured yet', () => {
    expect(pointToBbox(50, 50, 0, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe('pinPercent', () => {
  it('formats fraction as css percent', () => {
    expect(pinPercent(0.5)).toBe('50%')
    expect(pinPercent(0)).toBe('0%')
    expect(pinPercent(1)).toBe('100%')
  })
  it('clamps and guards non-finite', () => {
    expect(pinPercent(2)).toBe('100%')
    expect(pinPercent(-1)).toBe('0%')
    expect(pinPercent(NaN)).toBe('0%')
  })
})
