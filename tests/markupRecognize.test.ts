import { describe, expect, it } from 'vitest'
import {
  boundingBox,
  catmullRomSmooth,
  centroid,
  distance,
  pathLength,
  perpendicularDistance,
  rdp,
  recognize,
  snapLine,
  type Pt,
  type Shape,
} from '../src/components/markup/markupRecognize'

// Детерминированные генераторы штрихов (без Math.random — распознавание должно быть стабильным).
function sampleSegment(a: Pt, b: Pt, n: number, jitter = 0): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    // Треугольная псевдо-неровность от индекса — детерминирована и мала.
    const j = jitter ? ((i % 3) - 1) * jitter : 0
    out.push({ x: a.x + (b.x - a.x) * t + j, y: a.y + (b.y - a.y) * t - j })
  }
  return out
}

function samplePolyline(corners: Pt[], perEdge: number, closed: boolean, jitter = 0): Pt[] {
  const pts: Pt[] = []
  const loop = closed ? [...corners, corners[0]] : corners
  for (let i = 0; i < loop.length - 1; i++) {
    const seg = sampleSegment(loop[i], loop[i + 1], perEdge, jitter)
    pts.push(...(i === 0 ? seg : seg.slice(1)))
  }
  return pts
}

function circlePoints(cx: number, cy: number, r: number, n: number): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
  }
  return pts
}

function starPoints(cx: number, cy: number, rOut: number, rIn: number, spikes: number, perEdge = 6): Pt[] {
  const corners: Pt[] = []
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? rOut : rIn
    const a = -Math.PI / 2 + (i / (spikes * 2)) * Math.PI * 2
    corners.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
  }
  return samplePolyline(corners, perEdge, true)
}

describe('geometry helpers', () => {
  it('perpendicularDistance on a degenerate segment falls back to point distance', () => {
    expect(perpendicularDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5)
  })

  it('perpendicularDistance measures offset from the line', () => {
    expect(perpendicularDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3)
  })

  it('pathLength / boundingBox / centroid', () => {
    const sq: Pt[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }]
    expect(pathLength(sq)).toBeCloseTo(6)
    expect(boundingBox(sq)).toEqual({ x: 0, y: 0, w: 2, h: 2 })
    expect(centroid(sq)).toEqual({ x: 1, y: 1 })
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })
})

describe('rdp', () => {
  it('collapses collinear points to endpoints', () => {
    const line = sampleSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, 20)
    const simplified = rdp(line, 1)
    expect(simplified).toHaveLength(2)
    expect(simplified[0]).toEqual({ x: 0, y: 0 })
    expect(simplified[1]).toEqual({ x: 100, y: 0 })
  })

  it('keeps a genuine corner', () => {
    const bent = [...sampleSegment({ x: 0, y: 0 }, { x: 50, y: 0 }, 10), ...sampleSegment({ x: 50, y: 0 }, { x: 50, y: 50 }, 10).slice(1)]
    const simplified = rdp(bent, 2)
    expect(simplified.length).toBe(3)
    expect(simplified[1].x).toBeCloseTo(50)
    expect(simplified[1].y).toBeCloseTo(0)
  })
})

describe('catmullRomSmooth', () => {
  it('returns denser points that keep the endpoints', () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: 0 }, { x: 30, y: 20 }]
    const smooth = catmullRomSmooth(pts, 8)
    expect(smooth.length).toBeGreaterThan(pts.length)
    expect(smooth[0]).toEqual(pts[0])
    expect(smooth[smooth.length - 1]).toEqual(pts[pts.length - 1])
  })

  it('passes tiny inputs through untouched', () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
    expect(catmullRomSmooth(pts)).toEqual(pts)
  })
})

describe('snapLine', () => {
  it('snaps a near-45° stroke to an exact diagonal', () => {
    const s = snapLine({ x: 0, y: 0 }, { x: 100, y: 98 }) as Extract<Shape, { kind: 'line' }>
    expect(s.kind).toBe('line')
    expect(Math.abs(s.b.x - s.b.y)).toBeLessThan(1e-6)
  })

  it('snaps a near-horizontal stroke flat', () => {
    const s = snapLine({ x: 0, y: 0 }, { x: 100, y: 4 }) as Extract<Shape, { kind: 'line' }>
    expect(s.b.y).toBeCloseTo(0)
    expect(s.b.x).toBeCloseTo(Math.hypot(100, 4))
  })

  it('leaves an off-angle stroke unsnapped', () => {
    const s = snapLine({ x: 0, y: 0 }, { x: 100, y: 40 }) as Extract<Shape, { kind: 'line' }>
    expect(s.b).toEqual({ x: 100, y: 40 })
  })
})

describe('recognize — lines & arrows', () => {
  it('turns a wobbly near-straight stroke into a snapped line', () => {
    const pts = sampleSegment({ x: 20, y: 100 }, { x: 320, y: 104 }, 30, 2)
    const s = recognize(pts)
    expect(s.kind).toBe('line')
    if (s.kind === 'line') expect(s.b.y).toBeCloseTo(s.a.y, 0)
  })

  it('recognizes a shaft-plus-barb as an arrow', () => {
    const shaft = sampleSegment({ x: 40, y: 200 }, { x: 260, y: 200 }, 24)
    const barb = sampleSegment({ x: 260, y: 200 }, { x: 225, y: 175 }, 6).slice(1)
    const s = recognize([...shaft, ...barb])
    expect(s.kind).toBe('arrow')
    if (s.kind === 'arrow') {
      expect(s.a.x).toBeCloseTo(40, 0)
      expect(s.b.x).toBeCloseTo(260, 0)
    }
  })

  it('a plain line is NOT mistaken for an arrow', () => {
    const s = recognize(sampleSegment({ x: 40, y: 40 }, { x: 240, y: 40 }, 24))
    expect(s.kind).toBe('line')
  })
})

describe('recognize — closed shapes', () => {
  it('recognizes a hand-drawn circle', () => {
    const s = recognize(circlePoints(200, 200, 90, 48))
    expect(s.kind).toBe('ellipse')
    if (s.kind === 'ellipse') {
      expect(s.rx).toBeCloseTo(s.ry, 0)
      expect(s.rx).toBeCloseTo(90, -1)
    }
  })

  it('recognizes a stretched ellipse', () => {
    const pts: Pt[] = []
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2
      pts.push({ x: 200 + Math.cos(a) * 140, y: 200 + Math.sin(a) * 60 })
    }
    const s = recognize(pts)
    expect(s.kind).toBe('ellipse')
    if (s.kind === 'ellipse') expect(s.rx).toBeGreaterThan(s.ry * 1.8)
  })

  it('recognizes an axis-aligned rectangle', () => {
    const rect = samplePolyline([{ x: 50, y: 60 }, { x: 250, y: 58 }, { x: 252, y: 160 }, { x: 48, y: 162 }], 12, true)
    const s = recognize(rect)
    expect(s.kind).toBe('rect')
    if (s.kind === 'rect') {
      expect(s.w).toBeCloseTo(204, -1)
      expect(s.h).toBeCloseTo(104, -1)
    }
  })

  it('recognizes a triangle as a 3-point polygon', () => {
    const tri = samplePolyline([{ x: 150, y: 40 }, { x: 260, y: 220 }, { x: 40, y: 220 }], 14, true)
    const s = recognize(tri)
    expect(s.kind).toBe('polygon')
    if (s.kind === 'polygon') expect(s.points).toHaveLength(3)
  })

  it('recognizes a diamond as a 4-point polygon at bbox mid-edges', () => {
    const diamond = samplePolyline([{ x: 150, y: 40 }, { x: 260, y: 150 }, { x: 150, y: 260 }, { x: 40, y: 150 }], 14, true)
    const s = recognize(diamond)
    expect(s.kind).toBe('polygon')
    if (s.kind === 'polygon') expect(s.points).toHaveLength(4)
  })

  it('recognizes a 5-point star', () => {
    const s = recognize(starPoints(200, 200, 110, 45, 5))
    expect(s.kind).toBe('star')
    if (s.kind === 'star') {
      expect(s.count).toBe(5)
      expect(s.rInner).toBeLessThan(s.rOuter)
    }
  })
})

describe('recognize — check & fallback', () => {
  it('recognizes a check mark', () => {
    const check = [...sampleSegment({ x: 60, y: 120 }, { x: 100, y: 180 }, 8), ...sampleSegment({ x: 100, y: 180 }, { x: 200, y: 50 }, 12).slice(1)]
    const s = recognize(check)
    expect(s.kind).toBe('check')
  })

  it('falls back to a smoothed path for an unrecognized squiggle', () => {
    const pts: Pt[] = []
    for (let i = 0; i <= 40; i++) {
      pts.push({ x: 40 + i * 6, y: 120 + Math.sin(i * 0.9) * 40 })
    }
    const s = recognize(pts)
    expect(s.kind).toBe('path')
    if (s.kind === 'path') expect(s.points.length).toBeGreaterThan(0)
  })

  it('a single tap stays a path (dot)', () => {
    const s = recognize([{ x: 10, y: 10 }])
    expect(s.kind).toBe('path')
  })
})
