import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TILE_WASTE_FACTOR,
  estimateTileLayout,
} from '../src/screens/project-hub/tileLayout'

describe('sketch tile layout estimator', () => {
  it('keeps 12x24 tile on a 60 inch wall out of the small-cut warning path', () => {
    const estimate = estimateTileLayout({
      surfaceWidthIn: 60,
      surfaceHeightIn: 96,
      tileWIn: 12,
      tileHIn: 24,
      groutIn: 0.125,
    })

    expect(estimate.columns.count).toBe(5)
    expect(estimate.columns.lastCutIn).toBeCloseTo(11.5)
    expect(estimate.hasSmallCuts).toBe(false)
    expect(estimate.wasteFactor).toBe(DEFAULT_TILE_WASTE_FACTOR)
    expect(estimate.netAreaSqft).toBe(40)
    expect(estimate.grossSqft).toBe(48)
    expect(estimate.tileCount).toBe(24)
  })

  it('flags edge cuts under twenty percent and suggests a better offset', () => {
    const estimate = estimateTileLayout({
      surfaceWidthIn: 62,
      surfaceHeightIn: 96,
      tileWIn: 12,
      tileHIn: 24,
      groutIn: 0.125,
    })

    expect(estimate.columns.smallCut).toBe(true)
    expect(estimate.hasSmallCuts).toBe(true)
    expect(estimate.columns.minCutRatio).toBeLessThan(0.2)
    expect(estimate.columns.recommendedMinCutIn).toBeGreaterThan(estimate.columns.minCutIn)
  })

  it('subtracts openings and uses partial coverage height for ordering area', () => {
    const estimate = estimateTileLayout({
      surfaceWidthIn: 120,
      surfaceHeightIn: 96,
      coverageHeightIn: 48,
      tileWIn: 12,
      tileHIn: 24,
      openings: [{ xIn: 24, yIn: 0, widthIn: 36, heightIn: 36 }],
    })

    expect(estimate.surfaceAreaSqft).toBe(40)
    expect(estimate.openingAreaSqft).toBe(9)
    expect(estimate.netAreaSqft).toBe(31)
    expect(estimate.grossSqft).toBe(37.2)
  })
})
