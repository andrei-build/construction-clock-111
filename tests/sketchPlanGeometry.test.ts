import { describe, expect, it } from 'vitest'
import {
  contourArea,
  contourCenter,
  contourPerimeter,
  dist,
  pointInContour,
  projectT,
  type Contour,
} from '../src/screens/project-hub/sketchPlanGeometry'

const rect = (w: number, h: number, closed = true): Contour => ({
  closed,
  points: [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ],
})

describe('dist', () => {
  it('returns 0 for coincident points', () => {
    expect(dist({ x: 3, y: 4 }, { x: 3, y: 4 })).toBe(0)
  })

  it('computes euclidean distance (3-4-5)', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })

  it('is sign-agnostic for negative coordinates', () => {
    expect(dist({ x: -3, y: -4 }, { x: 0, y: 0 })).toBe(5)
  })
})

describe('contourPerimeter', () => {
  it('sums closed-rectangle edges including the closing edge', () => {
    expect(contourPerimeter(rect(4, 2))).toBe(12)
  })

  it('omits the closing edge for an open contour', () => {
    expect(contourPerimeter(rect(4, 2, false))).toBe(10)
  })

  it('returns 0 for an empty or single-point contour', () => {
    expect(contourPerimeter({ closed: true, points: [] })).toBe(0)
    expect(contourPerimeter({ closed: true, points: [{ x: 1, y: 1 }] })).toBe(0)
  })
})

describe('contourArea', () => {
  it('computes area of a closed rectangle via the shoelace formula', () => {
    expect(contourArea(rect(4, 3))).toBe(12)
  })

  it('is orientation-independent (absolute value)', () => {
    const cw: Contour = {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 3 },
        { x: 4, y: 3 },
        { x: 4, y: 0 },
      ],
    }
    expect(contourArea(cw)).toBe(12)
  })

  it('returns 0 for an open contour or fewer than 3 points', () => {
    expect(contourArea(rect(4, 3, false))).toBe(0)
    expect(contourArea({ closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBe(0)
  })
})

describe('contourCenter', () => {
  it('returns the origin for an empty contour', () => {
    expect(contourCenter({ closed: true, points: [] })).toEqual({ x: 0, y: 0 })
  })

  it('returns the centroid of a closed rectangle', () => {
    expect(contourCenter(rect(4, 2))).toEqual({ x: 2, y: 1 })
  })

  it('falls back to the arithmetic mean for an open contour', () => {
    const open: Contour = {
      closed: false,
      points: [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 4, y: 0 },
      ],
    }
    expect(contourCenter(open)).toEqual({ x: 2, y: 0 })
  })
})

describe('pointInContour', () => {
  it('detects a point inside a closed rectangle', () => {
    expect(pointInContour({ x: 2, y: 1 }, rect(4, 2))).toBe(true)
  })

  it('rejects a point outside the contour', () => {
    expect(pointInContour({ x: 10, y: 10 }, rect(4, 2))).toBe(false)
  })

  it('always returns false for an open contour', () => {
    expect(pointInContour({ x: 2, y: 1 }, rect(4, 2, false))).toBe(false)
  })
})

describe('projectT', () => {
  it('projects the midpoint to t = 0.5', () => {
    expect(projectT({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0.5)
  })

  it('clamps a projection before the start to 0', () => {
    expect(projectT({ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0)
  })

  it('clamps a projection past the end to 1', () => {
    expect(projectT({ x: 20, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(1)
  })

  it('returns 0 for a degenerate (zero-length) segment', () => {
    expect(projectT({ x: 3, y: 3 }, { x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0)
  })
})
