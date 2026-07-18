const SIXTEENTH = 1 / 16

function roundToSixteenth(value: number): number {
  return Math.round(value / SIXTEENTH) * SIXTEENTH
}

function stripInchUnit(value: string): string {
  return value
    .replace(/[″“”]/g, '"')
    .replace(/\s*(?:"|in\.?|inch|inches)\s*$/i, '')
    .trim()
}

function parseFraction(value: string): number {
  const match = value.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (!match) return Number.NaN
  const numerator = Number(match[1])
  const denominator = Number(match[2])
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return Number.NaN
  return numerator / denominator
}

export function parseInches(value: string): number {
  const body = stripInchUnit(value)
  if (!body) return Number.NaN

  const sign = body.startsWith('-') ? -1 : 1
  const unsigned = body.replace(/^[+-]\s*/, '').replace(/\s*-\s*(?=\d+\s*\/)/, ' ').trim()
  if (!unsigned) return Number.NaN

  if (/^\d+(?:\.\d+)?$/.test(unsigned)) {
    return roundToSixteenth(sign * Number(unsigned))
  }

  const fraction = parseFraction(unsigned)
  if (Number.isFinite(fraction)) return roundToSixteenth(sign * fraction)

  const mixed = unsigned.match(/^(\d+(?:\.\d+)?)\s+(\d+\s*\/\s*\d+)$/)
  if (!mixed) return Number.NaN
  const whole = Number(mixed[1])
  const part = parseFraction(mixed[2])
  if (!Number.isFinite(whole) || !Number.isFinite(part)) return Number.NaN
  return roundToSixteenth(sign * (whole + part))
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y) {
    const t = y
    y = x % y
    x = t
  }
  return x || 1
}

export function formatInches(value: number): string {
  const units = Math.round((Number.isFinite(value) ? value : 0) * 16)
  const sign = units < 0 ? '-' : ''
  const absUnits = Math.abs(units)
  const whole = Math.floor(absUnits / 16)
  const remainder = absUnits % 16

  if (remainder === 0) return `${sign}${whole}"`

  const divisor = gcd(remainder, 16)
  const numerator = remainder / divisor
  const denominator = 16 / divisor
  const fraction = `${numerator}/${denominator}`
  return whole > 0 ? `${sign}${whole} ${fraction}"` : `${sign}${fraction}"`
}
