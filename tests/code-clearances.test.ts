import { describe, expect, it } from 'vitest'
import {
  CODE_CLEARANCE_MINIMUMS_IN,
  checkCodeClearances,
  getCodeClearanceChecks,
} from '../src/screens/project-hub/code-clearances'
import type { SketchPlacedCatalogItem } from '../src/screens/project-hub/sketchCatalog'

const room = {
  cellFt: 1,
  contours: [
    {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 8, y: 6 },
        { x: 0, y: 6 },
      ],
    },
  ],
}

function floorItem(patch: Partial<SketchPlacedCatalogItem>): SketchPlacedCatalogItem {
  return {
    id: patch.id ?? 'item',
    catalogItemId: patch.catalogItemId ?? patch.id ?? 'catalog',
    xFt: patch.xFt ?? 0,
    yFt: patch.yFt ?? 1,
    zFt: patch.zFt ?? 0,
    rotationY: patch.rotationY ?? 0,
    surface: 'floor',
    category: patch.category ?? 'other',
    name: patch.name,
    model: patch.model,
    kind: patch.kind,
    widthIn: patch.widthIn ?? 12,
    depthIn: patch.depthIn ?? 12,
    heightIn: patch.heightIn ?? 30,
  }
}

describe('project hub sketch code clearances', () => {
  it('keeps version-1 sketches without placed items valid', () => {
    expect(checkCodeClearances({ ...room, openings: [] })).toEqual([])
  })

  it('flags toilet centerline clearance under 15 inches to a vanity', () => {
    const toilet = floorItem({
      id: 'toilet-1',
      catalogItemId: 'builtin-toilet',
      kind: 'TOILET',
      model: 'TOILET',
      xFt: 2,
      zFt: 2,
      widthIn: 15,
      depthIn: 28,
      heightIn: 30,
    })
    const vanity = floorItem({
      id: 'vanity-1',
      category: 'vanity',
      xFt: 4,
      zFt: 2,
      widthIn: 24,
      depthIn: 20,
      heightIn: 34,
    })

    const violations = checkCodeClearances({ ...room, placedItems: [toilet, vanity], openings: [] })
    const side = violations.find((check) => check.type === 'toilet-side' && check.target.id === 'vanity-1')

    expect(side).toBeTruthy()
    expect(side?.actualIn).toBeCloseTo(12)
    expect(side?.requiredIn).toBe(CODE_CLEARANCE_MINIMUMS_IN.toiletSideCenterline)
  })

  it('allows toilet centerline clearance at exactly 15 inches', () => {
    const toilet = floorItem({
      id: 'toilet-1',
      catalogItemId: 'builtin-toilet',
      kind: 'TOILET',
      model: 'TOILET',
      xFt: 2,
      zFt: 2,
      widthIn: 15,
      depthIn: 28,
      heightIn: 30,
    })
    const vanity = floorItem({
      id: 'vanity-1',
      category: 'vanity',
      xFt: 4.25,
      zFt: 2,
      widthIn: 24,
      depthIn: 20,
      heightIn: 34,
    })

    const checks = getCodeClearanceChecks({ ...room, placedItems: [toilet, vanity], openings: [] })
    const side = checks.find((check) => check.type === 'toilet-side' && check.target.id === 'vanity-1')

    expect(side?.actualIn).toBeCloseTo(15)
    expect(side?.ok).toBe(true)
  })

  it('flags toilet front clearance under 21 inches to the opposite wall', () => {
    const toilet = floorItem({
      id: 'toilet-1',
      catalogItemId: 'builtin-toilet',
      kind: 'TOILET',
      model: 'TOILET',
      xFt: 4,
      zFt: 3.1,
      widthIn: 15,
      depthIn: 28,
      heightIn: 30,
    })

    const violations = checkCodeClearances({ ...room, placedItems: [toilet], openings: [] })
    const front = violations.find((check) => check.type === 'toilet-front')

    expect(front).toBeTruthy()
    expect(front?.actualIn).toBeCloseTo(20.8)
    expect(front?.requiredIn).toBe(CODE_CLEARANCE_MINIMUMS_IN.toiletFrontClear)
  })

  it('flags vanity centerline clearance under 15 inches to a side wall', () => {
    const vanity = floorItem({
      id: 'vanity-1',
      category: 'vanity',
      xFt: 1,
      zFt: 2,
      widthIn: 24,
      depthIn: 20,
      heightIn: 34,
    })

    const violations = checkCodeClearances({ ...room, placedItems: [vanity], openings: [] })
    const side = violations.find((check) => check.type === 'vanity-side')

    expect(side).toBeTruthy()
    expect(side?.actualIn).toBeCloseTo(12)
    expect(side?.requiredIn).toBe(CODE_CLEARANCE_MINIMUMS_IN.vanitySideCenterline)
  })

  it('flags shower interior dimensions below 30 by 30 inches', () => {
    const shower = floorItem({
      id: 'shower-1',
      category: 'shower',
      xFt: 5,
      zFt: 3,
      widthIn: 28,
      depthIn: 30,
      heightIn: 4,
    })

    const violations = checkCodeClearances({ ...room, placedItems: [shower], openings: [] })

    expect(violations).toHaveLength(1)
    expect(violations[0].type).toBe('shower-size')
    expect(violations[0].direction).toBe('width')
    expect(violations[0].actualIn).toBe(28)
  })

  it('flags a door swing arc that overlaps a placed item', () => {
    const vanity = floorItem({
      id: 'vanity-1',
      category: 'vanity',
      xFt: 1.8,
      zFt: 1.2,
      widthIn: 18,
      depthIn: 18,
      heightIn: 34,
    })

    const violations = checkCodeClearances({
      ...room,
      openings: [{ kind: 'door', c: 0, s: 0, t: 0.25, w: 3 }],
      placedItems: [vanity],
    })

    expect(violations.some((check) => check.type === 'door-swing' && check.target.id === 'vanity-1')).toBe(true)
  })
})
