import { describe, it, expect } from 'vitest'
import {
  offsetVertices,
  paintedIntervals,
  wallSpans,
  wallThicknessPreset,
  WALL_THICKNESS_2X4_FT,
  WALL_THICKNESS_2X6_FT,
  DEFAULT_WALL_THICKNESS_FT,
  ptsToSvg,
} from '../src/lib/sketchWalls'

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

describe('offsetVertices', () => {
  it('offsets a straight horizontal segment by ±half perpendicular', () => {
    const { left, right } = offsetVertices([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, 1)
    // edge dir +x, left normal = (0, +1) → left below? leftNormal((1,0)) = (-0,1) = (0,1)
    expect(near(left[0].x, 0) && near(left[0].y, 1)).toBe(true)
    expect(near(right[0].x, 0) && near(right[0].y, -1)).toBe(true)
    expect(near(left[1].x, 10) && near(left[1].y, 1)).toBe(true)
    expect(near(right[1].x, 10) && near(right[1].y, -1)).toBe(true)
  })

  it('miters a right-angle corner of a closed unit square outward by half·√2', () => {
    // square 0,0 → 4,0 → 4,4 → 0,4 (CCW in screen coords), half=1
    const square = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ]
    const { left, right } = offsetVertices(square, true, 1)
    // one of left/right rings is the outer (offset by 1 in both axes → corner moves √2 from vertex).
    const d0 = Math.hypot(left[0].x - 0, left[0].y - 0)
    const d0r = Math.hypot(right[0].x - 0, right[0].y - 0)
    const outer = Math.max(d0, d0r)
    expect(near(outer, Math.SQRT2, 1e-9)).toBe(true)
    // outer corner at vertex (0,0) sits diagonally outside: (-1,-1)
    const outerPt = d0 > d0r ? left[0] : right[0]
    expect(near(Math.abs(outerPt.x), 1) && near(Math.abs(outerPt.y), 1)).toBe(true)
  })

  it('adjacent edges share the exact mitered corner point (no gap at corners)', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ]
    const spans = wallSpans(square, true, 2, [])
    // 4 full-edge spans, each ending where next begins.
    expect(spans.length).toBe(4)
    for (let s = 0; s < 4; s++) {
      const cur = spans[s]
      const nxt = spans[(s + 1) % 4]
      // outer end of current edge == outer start of next edge (shared corner).
      expect(near(cur.outer[1].x, nxt.outer[0].x) && near(cur.outer[1].y, nxt.outer[0].y)).toBe(true)
      expect(near(cur.inner[1].x, nxt.inner[0].x) && near(cur.inner[1].y, nxt.inner[0].y)).toBe(true)
    }
  })
})

describe('paintedIntervals (opening complement)', () => {
  it('no gaps → single full interval with no caps', () => {
    const iv = paintedIntervals([])
    expect(iv).toEqual([{ t0: 0, t1: 1, capStart: false, capEnd: false }])
  })

  it('gap in the middle → two spans, caps only on the opening side', () => {
    const iv = paintedIntervals([{ t0: 0.4, t1: 0.6 }])
    expect(iv.length).toBe(2)
    expect(iv[0]).toEqual({ t0: 0, t1: 0.4, capStart: false, capEnd: true })
    expect(iv[1]).toEqual({ t0: 0.6, t1: 1, capStart: true, capEnd: false })
  })

  it('gap touching the corner (t=0) → one span capped only at the opening edge', () => {
    const iv = paintedIntervals([{ t0: 0, t1: 0.5 }])
    expect(iv).toEqual([{ t0: 0.5, t1: 1, capStart: true, capEnd: false }])
  })

  it('gap covering the whole edge → no painted span', () => {
    expect(paintedIntervals([{ t0: 0, t1: 1 }])).toEqual([])
  })

  it('merges overlapping gaps', () => {
    const iv = paintedIntervals([{ t0: 0.2, t1: 0.5 }, { t0: 0.4, t1: 0.7 }])
    expect(iv).toEqual([
      { t0: 0, t1: 0.2, capStart: false, capEnd: true },
      { t0: 0.7, t1: 1, capStart: true, capEnd: false },
    ])
  })
})

describe('wallSpans openings cut both lines', () => {
  it('an opening on an edge breaks both outer and inner into two capped pieces', () => {
    const wall = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
    const spans = wallSpans(wall, false, 2, [{ s: 0, t0: 0.45, t1: 0.55 }])
    expect(spans.length).toBe(2)
    // left piece ends with a jamb cap at the opening; right piece starts with one.
    expect(spans[0].capEnd).not.toBeNull()
    expect(spans[0].capStart).toBeNull()
    expect(spans[1].capStart).not.toBeNull()
    expect(spans[1].capEnd).toBeNull()
    // the cap connects outer and inner across the thickness (length == thickness == 2).
    const cap = spans[0].capEnd as [{ x: number; y: number }, { x: number; y: number }]
    expect(near(Math.hypot(cap[0].x - cap[1].x, cap[0].y - cap[1].y), 2)).toBe(true)
    // both lines actually stop at the same t along the edge (x = 4.5).
    expect(near(spans[0].outer[1].x, 4.5) && near(spans[0].inner[1].x, 4.5)).toBe(true)
  })

  it('body quad has 4 corners: outer0, outer1, inner1, inner0', () => {
    const [span] = wallSpans([{ x: 0, y: 0 }, { x: 8, y: 0 }], false, 2, [])
    expect(span.body).toHaveLength(4)
    expect(span.body[0]).toEqual(span.outer[0])
    expect(span.body[1]).toEqual(span.outer[1])
    expect(span.body[2]).toEqual(span.inner[1])
    expect(span.body[3]).toEqual(span.inner[0])
  })

  it('degenerate inputs return no spans', () => {
    expect(wallSpans([{ x: 0, y: 0 }], false, 2, [])).toEqual([])
    expect(wallSpans([{ x: 0, y: 0 }, { x: 1, y: 0 }], false, 0, [])).toEqual([])
  })
})

describe('thickness presets', () => {
  it('exposes 2x4=4.5" and 2x6=6.5" defaults', () => {
    expect(near(WALL_THICKNESS_2X4_FT, 4.5 / 12)).toBe(true)
    expect(near(WALL_THICKNESS_2X6_FT, 6.5 / 12)).toBe(true)
    expect(DEFAULT_WALL_THICKNESS_FT).toBe(WALL_THICKNESS_2X4_FT)
  })

  it('picks the nearest preset', () => {
    expect(wallThicknessPreset(4.5 / 12)).toBe('2x4')
    expect(wallThicknessPreset(6.5 / 12)).toBe('2x6')
    expect(wallThicknessPreset(6 / 12)).toBe('2x6')
    expect(wallThicknessPreset(4 / 12)).toBe('2x4')
  })
})

describe('ptsToSvg', () => {
  it('scales points into an SVG points string', () => {
    expect(ptsToSvg([{ x: 1, y: 2 }, { x: 3, y: 4 }], 10)).toBe('10,20 30,40')
  })
})
