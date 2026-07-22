import { describe, expect, it } from 'vitest'
import {
  CABINET_COUNTERTOP_HEIGHT_IN,
  CABINET_WALL_BOTTOM_IN,
  DEFAULT_WALL_CABINET_GAP_IN,
  wallCabinetBottomInFromGap,
  wallCabinetCenterYFt,
  wallCabinetGapFromBottomIn,
  wallCabinetGapIn,
} from '../src/screens/project-hub/cabinetCodes'
import { sanitizePlacedCatalogItems } from '../src/screens/project-hub/sketchCatalog'

// CABINETS-VERTICAL-22: пересчёт высоты/зазора навесного + round-trip нового поля через sanitize.

describe('wall cabinet vertical gap math', () => {
  it('NKBA default gap is 18" (uppers bottom 54" from floor)', () => {
    expect(DEFAULT_WALL_CABINET_GAP_IN).toBe(18)
    expect(wallCabinetBottomInFromGap(DEFAULT_WALL_CABINET_GAP_IN)).toBe(CABINET_WALL_BOTTOM_IN)
    expect(CABINET_WALL_BOTTOM_IN - CABINET_COUNTERTOP_HEIGHT_IN).toBe(18)
  })

  it('gap<->bottom conversions are inverse around the 36" countertop', () => {
    expect(wallCabinetGapFromBottomIn(54)).toBe(18)
    expect(wallCabinetBottomInFromGap(24)).toBe(60)
    expect(wallCabinetGapFromBottomIn(wallCabinetBottomInFromGap(21))).toBe(21)
  })

  it('missing wallGapIn falls back to default gap; explicit value wins', () => {
    expect(wallCabinetGapIn({ wallGapIn: undefined })).toBe(18)
    expect(wallCabinetGapIn({ wallGapIn: 24 })).toBe(24)
  })

  it('center Y prefers wallGapIn, else uses stored yFt', () => {
    // 30" tall upper, gap 24" -> bottom 60", center = (60 + 15)/12 = 6.25 ft
    expect(wallCabinetCenterYFt({ wallGapIn: 24, yFt: 999 }, 30)).toBeCloseTo(6.25, 5)
    // no gap field -> old sketch behaviour: use yFt untouched
    expect(wallCabinetCenterYFt({ wallGapIn: undefined, yFt: 4.75 }, 30)).toBe(4.75)
  })
})

describe('sanitizePlacedCatalogItems preserves wallGapIn', () => {
  const base = {
    id: 'w1',
    catalogItemId: 'builtin-cabinet:W3030',
    xFt: 1,
    yFt: 5,
    zFt: 1,
    rotationY: 0,
    surface: 'wall',
    category: 'cabinet',
    layer: 'wall',
    widthIn: 30,
    depthIn: 12,
    heightIn: 30,
  }

  it('keeps a valid wallGapIn (save/load round-trip)', () => {
    const [placed] = sanitizePlacedCatalogItems([{ ...base, wallGapIn: 24 }])
    expect(placed.wallGapIn).toBe(24)
    // simulate reload: sanitize again, value survives
    const [reloaded] = sanitizePlacedCatalogItems([placed])
    expect(reloaded.wallGapIn).toBe(24)
  })

  it('old sketches without wallGapIn load with the field absent (default 18" applies on read)', () => {
    const [placed] = sanitizePlacedCatalogItems([{ ...base }])
    expect(placed.wallGapIn).toBeUndefined()
    expect(wallCabinetGapIn(placed)).toBe(18)
  })

  it('clamps out-of-range / non-finite gap values', () => {
    const [negative] = sanitizePlacedCatalogItems([{ ...base, wallGapIn: -5 }])
    expect(negative.wallGapIn).toBe(0)
    const [huge] = sanitizePlacedCatalogItems([{ ...base, wallGapIn: 99999 }])
    expect(huge.wallGapIn).toBe(600)
    const [nan] = sanitizePlacedCatalogItems([{ ...base, wallGapIn: 'oops' }])
    expect(nan.wallGapIn).toBeUndefined()
  })
})
