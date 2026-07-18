import { describe, expect, it } from 'vitest'
import { sanitizeSketchOpenings } from '../src/screens/project-hub/sketchFinishes'

describe('project hub sketch opening sanitation', () => {
  it('keeps version-1 opening data compatible while clamping unsafe fields', () => {
    const openings = sanitizeSketchOpenings([
      { kind: 'door', c: 1, s: 2, t: 1.4, w: 2.505, h: 6.666 },
      { kind: 'window', c: 0, s: 3, t: -0.2, w: 2.005, h: 4.0625, sill: 3.005 },
      { kind: 'arch', c: 0, s: 0, t: 0.5 },
      { kind: 'door', c: 0.5, s: 0, t: 0.5 },
    ])

    expect(openings).toEqual([
      { kind: 'door', c: 1, s: 2, t: 1, w: 2.5, h: 6.666666666666667 },
      { kind: 'window', c: 0, s: 3, t: 0, w: 2, h: 4.0625, sill: 3 },
    ])
  })

  it('returns no openings for non-array JSON', () => {
    expect(sanitizeSketchOpenings(null)).toEqual([])
    expect(sanitizeSketchOpenings({ openings: [] })).toEqual([])
  })
})
