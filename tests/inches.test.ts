import { describe, expect, it } from 'vitest'
import {
  formatFeetInches,
  formatInches,
  parseFeetInches,
  parseInches,
  snapOpeningFeetToPrecision,
  snapOpeningInchesToPrecision,
} from '../src/screens/project-hub/inches'

describe('project hub inch formatting', () => {
  it('parses whole, mixed fraction, and decimal inches to sixteenths', () => {
    expect(parseInches('12"')).toBe(12)
    expect(parseInches('12 1/8"')).toBe(12.125)
    expect(parseInches('11 7/8"')).toBe(11.875)
    expect(parseInches('12.125"')).toBe(12.125)
    expect(parseInches('1/16')).toBe(0.0625)
  })

  it('accepts inch words and hyphenated mixed fractions', () => {
    expect(parseInches('12 in')).toBe(12)
    expect(parseInches('12 inches')).toBe(12)
    expect(parseInches('12-1/8')).toBe(12.125)
  })

  it('rounds parsed values to the nearest sixteenth', () => {
    expect(parseInches('12.03')).toBe(12)
    expect(parseInches('12.07')).toBe(12.0625)
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
    expect(formatInches(11.875)).toBe('11 7/8"')
    expect(formatInches(11.9375)).toBe('11 15/16"')
    expect(formatInches(12.0625)).toBe('12 1/16"')
    expect(formatInches(0.5)).toBe('1/2"')
  })

  it('handles rounding carry and negative values', () => {
    expect(formatInches(11.999)).toBe('12"')
    expect(formatInches(-1.5)).toBe('-1 1/2"')
    expect(formatInches(Number.NaN)).toBe('0"')
  })

  it('parses feet and inches to sixteenth-inch precision', () => {
    expect(parseFeetInches('8 ft 3 1/2 in')).toBe(99.5)
    expect(parseFeetInches('8 ft 3 1/16 in')).toBe(99.0625)
    expect(parseFeetInches('8ft 3-1/2in')).toBe(99.5)
    expect(parseFeetInches('8\' 3 1/2"')).toBe(99.5)
    expect(parseFeetInches('3 ft')).toBe(36)
    expect(parseFeetInches('4 ft')).toBe(48)
    expect(parseFeetInches('20 ft')).toBe(240)
    expect(parseFeetInches('2.5 ft')).toBe(30)
    expect(parseFeetInches('6 in')).toBe(6)
  })

  it('formats feet and inches without decimal feet', () => {
    expect(formatFeetInches(99.5)).toBe('8 ft 3 1/2 in')
    expect(formatFeetInches(30)).toBe('2 ft 6 in')
    expect(formatFeetInches(96)).toBe('8 ft')
    expect(formatFeetInches(0.0625)).toBe('1/16 in')
    expect(formatFeetInches(-18)).toBe('-1 ft 6 in')
  })

  it('snaps opening-only values to eighth-inch precision', () => {
    expect(snapOpeningInchesToPrecision(12.0625)).toBe(12.125)
    expect(snapOpeningInchesToPrecision(11.9375)).toBe(12)
    expect(snapOpeningFeetToPrecision(2.005)).toBe(2)
    expect(snapOpeningFeetToPrecision(6.666)).toBe(80 / 12)
  })
})

// SWEEP-FIX-32: в поле длины голое число без единиц = ФУТЫ.
// parseLengthFt — обёртка SketchTab над parseFeetInches({ bareUnit: 'feet' }),
// возвращающая футы; воспроизводим её ровно здесь для регресс-контроля.
function parseLengthFt(value: string, bareUnit: 'feet' | 'inches' = 'feet'): number {
  const parsedInches = parseFeetInches(value, { bareUnit })
  return Number.isFinite(parsedInches) ? parsedInches / 12 : Number.NaN
}

describe('length field bare-number-as-feet (SWEEP-FIX-32)', () => {
  it('treats a bare number as feet in a length field', () => {
    expect(parseLengthFt('20')).toBe(20)
    expect(parseLengthFt('6')).toBe(6)
    expect(parseLengthFt('12')).toBe(12)
    expect(parseLengthFt('6 1/2')).toBe(6.5)
  })

  it('keeps explicit inch markers as inches', () => {
    expect(parseLengthFt('20"')).toBe(20 / 12)
    expect(parseLengthFt('20 in')).toBe(20 / 12)
    expect(parseLengthFt('20 inches')).toBe(20 / 12)
  })

  it('keeps explicit feet and feet-inch input working', () => {
    expect(parseLengthFt("6'")).toBe(6)
    expect(parseLengthFt('6 ft')).toBe(6)
    expect(parseLengthFt("6' 2\"")).toBe(6 + 2 / 12)
    expect(parseLengthFt('6 ft 2 in')).toBe(6 + 2 / 12)
  })

  it('handles a fractional inch after explicit feet', () => {
    expect(parseLengthFt("6' 2 1/2\"")).toBe(6 + 2.5 / 12)
  })

  it('does not disturb explicit units when bare-feet is enabled', () => {
    // Явные единицы имеют приоритет над режимом bareUnit.
    expect(parseLengthFt('3 ft')).toBe(3)
    expect(parseLengthFt('3"')).toBe(3 / 12)
    expect(Number.isNaN(parseLengthFt(''))).toBe(true)
    expect(Number.isNaN(parseLengthFt('abc'))).toBe(true)
  })

  it('keeps inch-native length callers on inches (opening offset / opening dims)', () => {
    // Смещение проёма и габариты проёмов дюймо-нативны: голое число = дюймы.
    expect(parseLengthFt('20', 'inches')).toBe(20 / 12)
    expect(parseLengthFt('18', 'inches')).toBe(18 / 12)
    expect(parseLengthFt('20"', 'inches')).toBe(20 / 12)
    expect(parseLengthFt("2'", 'inches')).toBe(2)
  })

  it('leaves parseFeetInches default (inches) untouched for other callers', () => {
    expect(parseFeetInches('20')).toBe(20)
    expect(parseFeetInches('6 in')).toBe(6)
    expect(parseFeetInches('20 ft')).toBe(240)
    expect(parseFeetInches('20', { bareUnit: 'feet' })).toBe(240)
    expect(parseFeetInches('20"', { bareUnit: 'feet' })).toBe(20)
  })
})
