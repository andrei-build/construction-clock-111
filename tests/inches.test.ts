import { describe, expect, it } from 'vitest'
import { formatInches, parseInches } from '../src/screens/project-hub/inches'

describe('project hub inch formatting', () => {
  it('parses whole, mixed fraction, and decimal inches to sixteenths', () => {
    expect(parseInches('12"')).toBe(12)
    expect(parseInches('12 1/8"')).toBe(12.125)
    expect(parseInches('11 15/16"')).toBe(11.9375)
    expect(parseInches('12.0625"')).toBe(12.0625)
    expect(parseInches('1/16')).toBe(0.0625)
  })

  it('accepts inch words and hyphenated mixed fractions', () => {
    expect(parseInches('12 in')).toBe(12)
    expect(parseInches('12 inches')).toBe(12)
    expect(parseInches('12-1/8')).toBe(12.125)
  })

  it('rounds parsed values to the nearest sixteenth', () => {
    expect(parseInches('12.03')).toBe(12)
    expect(parseInches('12.04')).toBe(12.0625)
    expect(parseInches('2 3/32"')).toBe(2.125)
  })

  it('returns NaN for invalid input', () => {
    expect(Number.isNaN(parseInches(''))).toBe(true)
    expect(Number.isNaN(parseInches('abc'))).toBe(true)
    expect(Number.isNaN(parseInches('1/0'))).toBe(true)
  })

  it('formats inches as reduced sixteenth fractions', () => {
    expect(formatInches(12)).toBe('12"')
    expect(formatInches(12.125)).toBe('12 1/8"')
    expect(formatInches(11.9375)).toBe('11 15/16"')
    expect(formatInches(12.0625)).toBe('12 1/16"')
    expect(formatInches(0.5)).toBe('1/2"')
  })

  it('handles rounding carry and negative values', () => {
    expect(formatInches(11.999)).toBe('12"')
    expect(formatInches(-1.5)).toBe('-1 1/2"')
    expect(formatInches(Number.NaN)).toBe('0"')
  })
})
