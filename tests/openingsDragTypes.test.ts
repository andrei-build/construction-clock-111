import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_TYPE,
  cleanWindowType,
  sanitizeSketchOpenings,
  type Opening,
} from '../src/screens/project-hub/sketchFinishes'
import {
  centerOpeningT,
  clampOpeningCenterFt,
  clampOpeningPlacementT,
  openingEdgeOffsetsFt,
  openingTForOffset,
  softOpeningPlacement,
} from '../src/screens/project-hub/sketchOpeningPlacement'

// OPENINGS-DRAG-TYPES-27: перетаскивание проёма (клэмп к сегменту + живые размеры Л/П),
// типы окон (глухое/створчатое/двойное) и тип «проём»-вырез — через version:1 allowlist.

describe('OPENINGS-DRAG-TYPES-27 drag clamp along wall segment', () => {
  it('clamps the opening center so the leaf never leaves the wall segment', () => {
    // Сегмент 10 ft, окно 3 ft — центр не выходит за [1.5, 8.5].
    expect(clampOpeningCenterFt(10, 3, -5)).toBeCloseTo(1.5)
    expect(clampOpeningCenterFt(10, 3, 100)).toBeCloseTo(8.5)
    expect(clampOpeningCenterFt(10, 3, 5)).toBeCloseTo(5)
  })

  it('clamps the parametric t into the valid slide range while dragging', () => {
    // t за пределами → к ближайшему краю, внутри → без изменений.
    expect(clampOpeningPlacementT(10, 3, -1)).toBeCloseTo(0.15)
    expect(clampOpeningPlacementT(10, 3, 2)).toBeCloseTo(0.85)
    expect(clampOpeningPlacementT(10, 3, 0.5)).toBeCloseTo(0.5)
  })

  it('centers wider-than-wall openings instead of overflowing', () => {
    expect(clampOpeningCenterFt(4, 6, 0)).toBeCloseTo(2)
    expect(centerOpeningT(4, 6)).toBeCloseTo(0.5)
  })

  it('slides freely mid-segment but soft-magnets to a precision node while dragging', () => {
    const free = softOpeningPlacement({ rawT: 0.44, segmentLengthFt: 10, openingWidthFt: 2, precisionStepFt: 1, magnetThresholdFt: 0.1 })
    expect(free.magnet).toBeNull()
    expect(free.t).toBeCloseTo(0.44)

    const snapped = softOpeningPlacement({ rawT: 0.402, segmentLengthFt: 10, openingWidthFt: 2, precisionStepFt: 1, magnetThresholdFt: 0.1 })
    expect(snapped.magnet?.kind).toBe('precision')
    expect(snapped.t).toBeCloseTo(0.4)
  })

  it('soft-magnets to the segment center when dragged near mid-wall', () => {
    const near = softOpeningPlacement({ rawT: 0.52, segmentLengthFt: 10, openingWidthFt: 3, precisionStepFt: 0, magnetThresholdFt: 0.3 })
    expect(near.magnet?.kind).toBe('center')
    expect(near.t).toBeCloseTo(0.5)
  })
})

describe('OPENINGS-DRAG-TYPES-27 live L/R dimensions', () => {
  it('reports left/right offsets to the corners that update as t changes', () => {
    const left = openingEdgeOffsetsFt(12, 3, centerOpeningT(12, 3))
    expect(left.left).toBeCloseTo(4.5)
    expect(left.right).toBeCloseTo(4.5)

    const shifted = openingEdgeOffsetsFt(12, 3, openingTForOffset(12, 3, 'left', 2))
    expect(shifted.left).toBeCloseTo(2)
    expect(shifted.right).toBeCloseTo(7)
  })

  it('click-to-type an exact offset lands the opening precisely (round-trip offset->t->offset)', () => {
    const t = openingTForOffset(20, 4, 'right', 3)
    const offsets = openingEdgeOffsetsFt(20, 4, t)
    expect(offsets.right).toBeCloseTo(3)
    expect(offsets.left).toBeCloseTo(13)
  })
})

describe('OPENINGS-DRAG-TYPES-27 window type + passthrough round-trip (version:1 allowlist)', () => {
  it('keeps window subtype (fixed/casement/double) through sanitize', () => {
    const openings = sanitizeSketchOpenings([
      { kind: 'window', c: 0, s: 1, t: 0.5, w: 3, h: 4, sill: 3, winType: 'casement' },
      { kind: 'window', c: 0, s: 2, t: 0.5, w: 3, h: 4, sill: 3, winType: 'double' },
      { kind: 'window', c: 0, s: 3, t: 0.5, w: 3, h: 4, sill: 3, winType: 'fixed' },
    ])
    expect(openings.map((o) => o.winType)).toEqual(['casement', 'double', 'fixed'])
  })

  it('drops unknown/invalid window subtypes and never sets winType on doors', () => {
    const openings = sanitizeSketchOpenings([
      { kind: 'window', c: 0, s: 1, t: 0.5, winType: 'bogus' },
      { kind: 'door', c: 0, s: 2, t: 0.5, winType: 'casement' },
    ])
    expect(openings[0].winType).toBeUndefined()
    expect('winType' in openings[1]).toBe(false)
  })

  it('accepts the passthrough opening (кind "opening") with width/height/sill', () => {
    const openings = sanitizeSketchOpenings([
      { kind: 'opening', c: 1, s: 0, t: 0.5, w: 3, h: 7, sill: 2.5 },
    ])
    expect(openings).toHaveLength(1)
    expect(openings[0].kind).toBe('opening')
    expect(openings[0].w).toBeCloseTo(3)
    expect(openings[0].h).toBeCloseTo(7)
    expect(openings[0].sill).toBeCloseTo(2.5)
    expect(openings[0].winType).toBeUndefined()
  })

  it('still rejects unsupported kinds while old door/window sketches load unchanged', () => {
    const openings = sanitizeSketchOpenings([
      { kind: 'arch', c: 0, s: 0, t: 0.5 },
      { kind: 'door', c: 1, s: 2, t: 1.4, w: 2.505, h: 6.666 },
      { kind: 'window', c: 0, s: 3, t: -0.2, w: 2.005, h: 4.0625, sill: 3.005 },
    ])
    expect(openings.map((o) => o.kind)).toEqual(['door', 'window'])
  })

  it('is idempotent: a sanitized model with the new fields survives a second save/reload', () => {
    const once = sanitizeSketchOpenings([
      { kind: 'window', c: 0, s: 0, t: 0.5, w: 3, h: 4, sill: 3, winType: 'double' },
      { kind: 'opening', c: 0, s: 1, t: 0.5, w: 3, h: 7, sill: 2 },
    ])
    const twice = sanitizeSketchOpenings(once as unknown[])
    expect(twice).toEqual(once)
  })

  it('cleanWindowType narrows to the supported set with a stable default', () => {
    expect(cleanWindowType('fixed')).toBe('fixed')
    expect(cleanWindowType('casement')).toBe('casement')
    expect(cleanWindowType('double')).toBe('double')
    expect(cleanWindowType('sliding')).toBeUndefined()
    expect(cleanWindowType(undefined)).toBeUndefined()
    expect(DEFAULT_WINDOW_TYPE).toBe('fixed')
  })

  it('drops sill on doors but keeps it on windows and passthrough openings', () => {
    const openings = sanitizeSketchOpenings([
      { kind: 'door', c: 0, s: 0, t: 0.5, w: 2.5, h: 6.7, sill: 4 } as Opening,
      { kind: 'opening', c: 0, s: 1, t: 0.5, w: 3, h: 7, sill: 2 },
    ])
    expect(openings[0].sill).toBeUndefined()
    expect(openings[1].sill).toBeCloseTo(2)
  })
})
