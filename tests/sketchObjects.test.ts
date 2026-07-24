import { describe, expect, it } from 'vitest'
import {
  buildPlanSymbolGeometry,
  buildSketchCalloutGeometry,
  buildSketchStairGeometry,
  createDefaultSketchCallout,
  createDefaultSketchStair,
  formatSketchObjectLengthIn,
  inferSketchPlanSymbolKind,
  sanitizeSketchCallouts,
  sanitizeSketchObjectCollections,
  sanitizeSketchStairs,
} from '../src/lib/sketchObjects'

describe('sketchObjects stairs', () => {
  it('sanitizes stair parameters through the version:1 allowlist', () => {
    const [stair] = sanitizeSketchStairs([{
      id: 'stair-1',
      x: '2',
      y: 3,
      widthIn: 42.5,
      steps: 13.2,
      direction: 'turn',
      arrow: 'DN',
      unknown: 'strip',
    }])

    expect(stair).toEqual({
      id: 'stair-1',
      x: 2,
      y: 3,
      widthIn: 42.5,
      steps: 13,
      direction: 'turn',
      arrow: 'DN',
    })
    expect('unknown' in stair).toBe(false)
    expect(formatSketchObjectLengthIn(stair.widthIn)).toBe('3\'-6 1/2"')
  })

  it('builds a plan stair with tread lines, UP/DN arrow and width label', () => {
    const stair = createDefaultSketchStair('stair-2', { x: 5, y: 4 }, { widthIn: 36, steps: 8, direction: 'horizontal', arrow: 'UP' })
    const geometry = buildSketchStairGeometry(stair, { cellFt: 1, cellPx: 32 })

    expect(geometry.treads).toHaveLength(7)
    expect(geometry.arrow).toBe('UP')
    expect(geometry.label.text).toBe('UP')
    expect(geometry.widthLabel).toBe('3\'-0"')
    expect(geometry.outline).toHaveLength(4)
    expect(geometry.arrowHead).toHaveLength(3)
  })
})

describe('sketchObjects callouts', () => {
  it('sanitizes callout model and builds an arrowed label box', () => {
    const callout = createDefaultSketchCallout('callout-1', { x: 4, y: 5 }, { text: 'VERIFY BLOCKING' })
    const [clean] = sanitizeSketchCallouts([{ ...callout, extra: true }])
    const geometry = buildSketchCalloutGeometry(clean, { cellPx: 32, screenWorldPx: 1 })

    expect(clean.text).toBe('VERIFY BLOCKING')
    expect('extra' in clean).toBe(false)
    expect(geometry.textLines.join(' ')).toBe('VERIFY BLOCKING')
    expect(geometry.leader.x2).toBe(4 * 32)
    expect(geometry.leader.y2).toBe(5 * 32)
    expect(geometry.arrowHead).toHaveLength(3)
    expect(geometry.box.width).toBeGreaterThan(90)
  })
})

describe('sketchObjects sanitize round-trip', () => {
  it('preserves new object collections through load -> save -> load', () => {
    const raw = {
      stairs: [{ id: 's', x: 1, y: 2, width_in: 48, step_count: 10, direction: 'vertical', arrow: 'DN', junk: 1 }],
      callouts: [{ id: 'c', targetX: 3, targetY: 4, labelX: 5, labelY: 2, text: 'Hold layout', junk: 2 }],
      dropped: true,
    }

    const loaded = sanitizeSketchObjectCollections(raw)
    const saved = JSON.parse(JSON.stringify(loaded))
    const reloaded = sanitizeSketchObjectCollections(saved)

    expect(reloaded).toEqual({
      stairs: [{ id: 's', x: 1, y: 2, widthIn: 48, steps: 10, direction: 'vertical', arrow: 'DN' }],
      callouts: [{ id: 'c', target: { x: 3, y: 4 }, label: { x: 5, y: 2 }, text: 'Hold layout' }],
    })
  })

  it('old sketches without object collections sanitize to an empty additive patch', () => {
    expect(sanitizeSketchObjectCollections({})).toEqual({})
    expect(sanitizeSketchStairs(undefined)).toEqual([])
    expect(sanitizeSketchCallouts(null)).toEqual([])
  })
})

describe('sketchObjects plan symbols', () => {
  it('infers standard plan symbols from catalog and cabinet fields', () => {
    expect(inferSketchPlanSymbolKind({ kind: 'TOILET', catalogItemId: 'builtin-toilet' })).toBe('toilet')
    expect(inferSketchPlanSymbolKind({ category: 'shower', model: 'SHOWER_PAN_RECT' })).toBe('shower')
    expect(inferSketchPlanSymbolKind({ category: 'vanity', code: 'V36' })).toBe('lavatory')
    expect(inferSketchPlanSymbolKind({ category: 'cabinet', code: 'SB36' })).toBe('kitchen-sink')
    expect(inferSketchPlanSymbolKind({ category: 'cabinet', applianceType: 'range', code: 'RANGE30' })).toBe('range')
    expect(inferSketchPlanSymbolKind({ name: 'Alcove bathtub 60 x 30' })).toBe('bathtub')
  })

  it('builds scaled top-view geometry for plumbing and kitchen symbols', () => {
    const tub = buildPlanSymbolGeometry('bathtub', 160, 80)
    const range = buildPlanSymbolGeometry('range', 96, 80)
    const sink = buildPlanSymbolGeometry('kitchen-sink', 120, 70)

    expect(tub.outline[0]).toMatchObject({ type: 'rect', width: 160, height: 80 })
    expect(tub.details.some((primitive) => primitive.type === 'ellipse')).toBe(true)
    expect(range.details.filter((primitive) => primitive.type === 'circle')).toHaveLength(4)
    expect(sink.details.some((primitive) => primitive.type === 'rect')).toBe(true)
  })
})
