import { describe, expect, it } from 'vitest'
import {
  eachSegment,
  nearestSegment,
  openingEnds,
  openingGeom,
  openingPoint,
  type ContourModel,
} from '../src/screens/project-hub/sketchOpeningGeometry'
import type { Contour } from '../src/screens/project-hub/sketchPlanGeometry'

// Замкнутый прямоугольник w×h: сегменты 0=низ, 1=правый, 2=верх, 3=замыкающий левый.
const rect = (w: number, h: number, closed = true): Contour => ({
  closed,
  points: [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ],
})

const model = (...contours: Contour[]): ContourModel => ({ contours })

describe('openingEnds', () => {
  it('returns segment endpoints for a mid-contour segment', () => {
    const m = model(rect(4, 2))
    expect(openingEnds(m, { c: 0, s: 0, t: 0.5 })).toEqual({ a: { x: 0, y: 0 }, b: { x: 4, y: 0 } })
    expect(openingEnds(m, { c: 0, s: 1, t: 0 })).toEqual({ a: { x: 4, y: 0 }, b: { x: 4, y: 2 } })
  })

  it('wraps the closing segment back to the first point when closed', () => {
    const m = model(rect(4, 2))
    // s=3 — последний сегмент замкнутого контура: конец → первая точка.
    expect(openingEnds(m, { c: 0, s: 3, t: 0 })).toEqual({ a: { x: 0, y: 2 }, b: { x: 0, y: 0 } })
  })

  it('returns null for the trailing segment of an open contour (no wrap)', () => {
    const m = model(rect(4, 2, false))
    expect(openingEnds(m, { c: 0, s: 3, t: 0 })).toBeNull()
  })

  it('returns null for a missing contour index', () => {
    expect(openingEnds(model(rect(4, 2)), { c: 5, s: 0, t: 0 })).toBeNull()
  })

  it('returns null for an out-of-range segment index', () => {
    expect(openingEnds(model(rect(4, 2)), { c: 0, s: 9, t: 0 })).toBeNull()
  })
})

describe('openingPoint', () => {
  it('interpolates the world point along the segment by t', () => {
    const m = model(rect(4, 2))
    expect(openingPoint(m, { c: 0, s: 0, t: 0.25 })).toEqual({ x: 1, y: 0 })
    expect(openingPoint(m, { c: 0, s: 0, t: 0 })).toEqual({ x: 0, y: 0 })
    expect(openingPoint(m, { c: 0, s: 0, t: 1 })).toEqual({ x: 4, y: 0 })
  })

  it('returns null when the segment does not exist', () => {
    expect(openingPoint(model(rect(4, 2)), { c: 0, s: 9, t: 0.5 })).toBeNull()
  })
})

describe('openingGeom', () => {
  it('returns center point, unit direction and endpoints', () => {
    const m = model(rect(4, 2))
    const g = openingGeom(m, { c: 0, s: 0, t: 0.5 })
    expect(g).toEqual({
      p: { x: 2, y: 0 },
      ux: 1,
      uy: 0,
      a: { x: 0, y: 0 },
      b: { x: 4, y: 0 },
    })
  })

  it('normalizes the direction to unit length on the vertical segment', () => {
    const m = model(rect(4, 2))
    const g = openingGeom(m, { c: 0, s: 1, t: 0 })
    expect(g?.ux).toBe(0)
    expect(g?.uy).toBe(1)
  })

  it('guards against a degenerate zero-length segment (len falls back to 1)', () => {
    // Контур из двух совпадающих точек: сегмент длины 0.
    const degenerate: Contour = { closed: false, points: [{ x: 3, y: 3 }, { x: 3, y: 3 }] }
    const g = openingGeom(model(degenerate), { c: 0, s: 0, t: 0.5 })
    expect(g).toEqual({ p: { x: 3, y: 3 }, ux: 0, uy: 0, a: { x: 3, y: 3 }, b: { x: 3, y: 3 } })
  })

  it('returns null when the segment does not exist', () => {
    expect(openingGeom(model(rect(4, 2)), { c: 9, s: 0, t: 0.5 })).toBeNull()
  })
})

describe('eachSegment', () => {
  it('enumerates all four edges of a closed rectangle including the closing edge', () => {
    const segs = eachSegment(model(rect(4, 2)))
    expect(segs).toHaveLength(4)
    expect(segs.map((s) => [s.c, s.s])).toEqual([[0, 0], [0, 1], [0, 2], [0, 3]])
    expect(segs[3]).toEqual({ c: 0, s: 3, a: { x: 0, y: 2 }, b: { x: 0, y: 0 } })
  })

  it('omits the closing edge for an open contour', () => {
    const segs = eachSegment(model(rect(4, 2, false)))
    expect(segs).toHaveLength(3)
    expect(segs.map((s) => s.s)).toEqual([0, 1, 2])
  })

  it('does not close a contour with fewer than 3 points', () => {
    const line: Contour = { closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }
    const segs = eachSegment(model(line))
    expect(segs).toHaveLength(1)
  })

  it('returns an empty list for an empty model', () => {
    expect(eachSegment(model())).toEqual([])
  })

  it('indexes segments across multiple contours', () => {
    const segs = eachSegment(model(rect(4, 2), rect(2, 2)))
    expect(segs.filter((s) => s.c === 0)).toHaveLength(4)
    expect(segs.filter((s) => s.c === 1)).toHaveLength(4)
  })
})

describe('nearestSegment', () => {
  it('finds the closest segment and clamped parameter for an interior point', () => {
    const m = model(rect(4, 2))
    // Точка чуть выше низа контура → ближайший сегмент 0 (низ), t≈0.5, d=0.1.
    const near = nearestSegment(m, { x: 2, y: 0.1 })
    expect(near).not.toBeNull()
    expect(near?.c).toBe(0)
    expect(near?.s).toBe(0)
    expect(near?.t).toBeCloseTo(0.5, 10)
    expect(near?.d).toBeCloseTo(0.1, 10)
  })

  it('clamps t to [0,1] when the projection falls beyond an endpoint', () => {
    const m = model(rect(4, 2))
    // Точка левее начала нижнего сегмента → проекция за концом a, t=0.
    const near = nearestSegment(m, { x: -5, y: 0 })
    expect(near?.t).toBe(0)
  })

  it('skips zero-length segments and returns null when none remain', () => {
    const degenerate: Contour = { closed: false, points: [{ x: 3, y: 3 }, { x: 3, y: 3 }] }
    expect(nearestSegment(model(degenerate), { x: 0, y: 0 })).toBeNull()
  })

  it('returns null for an empty model', () => {
    expect(nearestSegment(model(), { x: 0, y: 0 })).toBeNull()
  })
})
