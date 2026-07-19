import { describe, expect, it } from 'vitest'
import {
  centerOpeningT,
  openingEdgeOffsetsFt,
  softOpeningPlacement,
} from '../src/screens/project-hub/sketchOpeningPlacement'

describe('project hub sketch opening placement', () => {
  it('keeps drag free outside the soft magnet threshold and snaps only near a precision node', () => {
    const free = softOpeningPlacement({
      rawT: 4.4 / 10,
      segmentLengthFt: 10,
      openingWidthFt: 2,
      precisionStepFt: 1,
      magnetThresholdFt: 0.1,
    })

    expect(free.magnet).toBeNull()
    expect(free.t).toBeCloseTo(0.44)

    const near = softOpeningPlacement({
      rawT: 4.02 / 10,
      segmentLengthFt: 10,
      openingWidthFt: 2,
      precisionStepFt: 1,
      magnetThresholdFt: 0.1,
    })

    expect(near.magnet?.kind).toBe('precision')
    expect(near.t).toBeCloseTo(0.4)
  })

  it('centers an opening so left and right wall offsets are equal', () => {
    const t = centerOpeningT(12, 3)
    const offsets = openingEdgeOffsetsFt(12, 3, t)

    expect(t).toBeCloseTo(0.5)
    expect(offsets.left).toBeCloseTo(4.5)
    expect(offsets.right).toBeCloseTo(4.5)
  })
})
