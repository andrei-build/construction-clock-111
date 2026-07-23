import { describe, expect, it } from 'vitest'
import {
  DRYWALL_SHEET_SQFT,
  applyRegionField,
  drywallSheetCount,
  finishAreaSqft,
  tileZoneEstimateForFinish,
  wallAreaSqft,
} from '../src/screens/project-hub/wallFinishMetrics'
import {
  symmetricTileAxisCells,
  tileAxisCells,
} from '../src/screens/project-hub/tileLayout'
import type { SketchSurfaceFinish } from '../src/screens/project-hub/sketchFinishes'

describe('wallFinishMetrics — wall area', () => {
  it('9 ft × 8 ft wall = 72 ft²', () => {
    expect(wallAreaSqft(9, 8)).toBe(72)
  })
  it('ignores non-finite / non-positive dims', () => {
    expect(wallAreaSqft(0, 8)).toBe(0)
    expect(wallAreaSqft(Number.NaN, 8)).toBe(0)
  })
})

describe('wallFinishMetrics — drywall sheets', () => {
  it('rounds up to whole 4x8 sheets (32 ft² each)', () => {
    expect(DRYWALL_SHEET_SQFT).toBe(32)
    expect(drywallSheetCount(24)).toBe(1)
    expect(drywallSheetCount(50)).toBe(2)
    expect(drywallSheetCount(0)).toBe(0)
  })
})

function tileFinish(overrides: Partial<SketchSurfaceFinish> = {}): SketchSurfaceFinish {
  return { kind: 'tile', tileWIn: 12, tileHIn: 24, groutIn: 0, ...overrides } as SketchSurfaceFinish
}

describe('wallFinishMetrics — tile zone estimate', () => {
  it('zone 36" × 96" (3×8 ft = 24 ft²) with 12×24 tile → tiles with waste', () => {
    const finish = tileFinish({
      coverage: { mode: 'partial', regions: [{ x0Ft: 0, y0Ft: 0, x1Ft: 3, y1Ft: 8 }] },
    })
    const est = tileZoneEstimateForFinish(finish, 9, 8)
    expect(est.areaSqft).toBe(24)
    // 24 ft² × 1.2 waste = 28.8 ft² → 28.8*144 / (12*24) = 14.4 → ceil 15
    expect(est.tileCount).toBe(15)
    expect(est.hasPrice).toBe(false)
    expect(est.costUsd).toBe(0)
  })

  it('cost per sqft = area × price', () => {
    const finish = tileFinish({
      catalogPriceUsd: 5,
      catalogPriceUnit: 'sqft',
      coverage: { mode: 'partial', regions: [{ x0Ft: 0, y0Ft: 0, x1Ft: 3, y1Ft: 8 }] },
    })
    const est = tileZoneEstimateForFinish(finish, 9, 8)
    expect(est.hasPrice).toBe(true)
    expect(est.costUsd).toBe(120)
  })

  it('cost per piece = tile count × price', () => {
    const finish = tileFinish({
      catalogPriceUsd: 2,
      catalogPriceUnit: 'piece',
      coverage: { mode: 'partial', regions: [{ x0Ft: 0, y0Ft: 0, x1Ft: 3, y1Ft: 8 }] },
    })
    const est = tileZoneEstimateForFinish(finish, 9, 8)
    expect(est.tileCount).toBe(15)
    expect(est.costUsd).toBe(30)
  })

  it('non-tile finish → zero estimate', () => {
    const est = tileZoneEstimateForFinish({ kind: 'paint', color: '#ffffff' } as SketchSurfaceFinish, 9, 8)
    expect(est).toEqual({ areaSqft: 0, tileCount: 0, costUsd: 0, hasPrice: false })
  })
})

describe('wallFinishMetrics — Частично = только зона, не вся стена', () => {
  it('partial coverage reports region area, not full wall', () => {
    const finish = tileFinish({
      coverage: { mode: 'partial', regions: [{ x0Ft: 1, y0Ft: 0, x1Ft: 4, y1Ft: 8 }] },
    })
    expect(finishAreaSqft(finish, 9, 8)).toBe(24)
    // full wall would be 72
    expect(finishAreaSqft(finish, 9, 8)).not.toBe(wallAreaSqft(9, 8))
  })
  it('full coverage reports whole wall', () => {
    const finish = tileFinish()
    expect(finishAreaSqft(finish, 9, 8)).toBe(72)
  })
})

describe('wallFinishMetrics — zone clamp on numeric input', () => {
  const region = { x0Ft: 0, y0Ft: 0, x1Ft: 3, y1Ft: 8 }
  it('width 36" (3 ft) on a 9 ft wall stays', () => {
    const next = applyRegionField(region, 'width', 3, 9, 8)
    expect(next.x1Ft - next.x0Ft).toBeCloseTo(3, 6)
  })
  it('width beyond wall is clamped to remaining space', () => {
    const next = applyRegionField(region, 'width', 40, 9, 8)
    expect(next.x1Ft).toBeLessThanOrEqual(9 + 1e-9)
    expect(next.x1Ft - next.x0Ft).toBeCloseTo(9, 6)
  })
  it('left keeps width and stays inside wall', () => {
    const next = applyRegionField(region, 'left', 100, 9, 8)
    expect(next.x0Ft).toBeCloseTo(6, 6) // 9 - width(3)
    expect(next.x1Ft).toBeCloseTo(9, 6)
  })
  it('height 96" (8 ft) fits an 8 ft wall', () => {
    const next = applyRegionField(region, 'height', 8, 9, 8)
    expect(next.y1Ft - next.y0Ft).toBeCloseTo(8, 6)
  })
})

describe('tileLayout — seam cells + symmetry', () => {
  it('36" wide, 12" tile, 0 grout → 3 full cells, no cuts', () => {
    const cells = tileAxisCells(36, 12, 0, 0)
    expect(cells.length).toBe(3)
    expect(cells.every((cell) => !cell.cut)).toBe(true)
    expect(cells.map((cell) => cell.sizeIn)).toEqual([12, 12, 12])
  })

  it('symmetric layout balances edge cuts and avoids small slivers', () => {
    const { cells } = symmetricTileAxisCells(30, 12, 0)
    expect(cells.length).toBeGreaterThanOrEqual(2)
    const first = cells[0]
    const last = cells[cells.length - 1]
    // symmetric edges
    expect(Math.abs(first.sizeIn - last.sizeIn)).toBeLessThan(0.5)
    // no sliver cut below 20% of tile
    const minCut = Math.min(...cells.filter((c) => c.cut).map((c) => c.sizeIn))
    expect(minCut).toBeGreaterThanOrEqual(12 * 0.2 - 0.01)
  })

  it('cells clip to surface bounds', () => {
    const cells = tileAxisCells(20, 12, 0.5, 0)
    expect(cells[0].startIn).toBeGreaterThanOrEqual(0)
    expect(cells[cells.length - 1].endIn).toBeLessThanOrEqual(20 + 1e-6)
  })
})
