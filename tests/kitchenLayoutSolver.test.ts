import { describe, expect, it } from 'vitest'
import {
  CORNER_FILLER_IN,
  DISHWASHER_MAX_FROM_SINK_IN,
  DISHWASHER_MIN_FROM_CORNER_IN,
  RANGE_LANDING_LARGE_IN,
  RANGE_LANDING_SMALL_IN,
  REFRIGERATOR_LANDING_IN,
  SINK_CENTER_TOLERANCE_IN,
  WALL_CABINET_ABOVE_COUNTER_IN,
  checkKitchenWall,
  solveKitchenLayout,
  type KitchenWallScene,
} from '../src/screens/project-hub/kitchenLayoutSolver'
import { layoutCabinetRunOnWall } from '../src/screens/project-hub/cabinetCodes'

// AI-LAYOUT-30: детерминированный солвер раскладки кухни + реестр правил NKBA/NEC/IRC.
// Числа-нормы фиксируем тестами: мойка по центру окна; ПММ ≤36"/≥21"; площадки плиты 12"/15" и
// плита НЕ под окном; холодильник в конце ряда с 15"; филлеры 3"; навесные 18"; детерминизм; и что
// раскладка реально проходит через существующий layoutCabinetRunOnWall (переиспользование модели ряда).

const WALL_IN = 180 // 15 ft — вмещает мойку+ПММ+плиту+холодильник с полными нормами на одной стене
// Окно по центру стены (t = 0.5) шириной 36".
const centeredWindow = { kind: 'window' as const, startIn: WALL_IN / 2 - 18, endIn: WALL_IN / 2 + 18 }

function baseInput() {
  return {
    wallLengthIn: WALL_IN,
    windows: [centeredWindow],
    appliances: { dishwasher: true, range: true, refrigerator: true, hood: true },
  }
}

describe('kitchen layout solver — anchor sequence', () => {
  it('places the sink centered on the window', () => {
    const [variant] = solveKitchenLayout(baseInput())
    expect(Math.abs(variant.metrics.sinkCenterIn - WALL_IN / 2)).toBeLessThanOrEqual(SINK_CENTER_TOLERANCE_IN)
    // ровно по центру (окно симметрично)
    expect(variant.metrics.sinkCenterIn).toBeCloseTo(WALL_IN / 2, 3)
  })

  it('places the dishwasher within 36in of the sink and at least 21in from a corner', () => {
    for (const variant of solveKitchenLayout(baseInput())) {
      expect(variant.metrics.dwToSinkIn).not.toBeNull()
      expect(variant.metrics.dwToSinkIn as number).toBeLessThanOrEqual(DISHWASHER_MAX_FROM_SINK_IN)
      expect(variant.metrics.dwToCornerIn as number).toBeGreaterThanOrEqual(DISHWASHER_MIN_FROM_CORNER_IN)
    }
  })

  it('gives the range 12in and 15in landings and never under a window', () => {
    for (const variant of solveKitchenLayout(baseInput())) {
      const left = variant.metrics.rangeLeftLandingIn as number
      const right = variant.metrics.rangeRightLandingIn as number
      expect(Math.min(left, right)).toBeGreaterThanOrEqual(RANGE_LANDING_SMALL_IN)
      expect(Math.max(left, right)).toBeGreaterThanOrEqual(RANGE_LANDING_LARGE_IN)
      expect(variant.metrics.rangeUnderWindow).toBe(false)
    }
  })

  it('places the refrigerator at the end of the run with a 15in landing', () => {
    for (const variant of solveKitchenLayout(baseInput())) {
      expect(variant.metrics.fridgeAtEnd).toBe(true)
      expect(variant.metrics.fridgeLandingIn as number).toBeGreaterThanOrEqual(REFRIGERATOR_LANDING_IN)
    }
  })

  it('puts a 3in filler at the wall corner', () => {
    const [variant] = solveKitchenLayout(baseInput())
    expect(variant.metrics.cornerFillerIn).toBe(CORNER_FILLER_IN)
    const firstBase = variant.baseSlots[0]
    expect(firstBase.role).toBe('filler')
    expect(firstBase.startIn).toBe(0)
    expect(firstBase.widthIn).toBe(3)
  })

  it('hangs wall cabinets 18in above the counter and a hood over the range', () => {
    const [variant] = solveKitchenLayout(baseInput())
    expect(variant.metrics.wallGapIn).toBe(WALL_CABINET_ABOVE_COUNTER_IN)
    expect(WALL_CABINET_ABOVE_COUNTER_IN).toBe(18)
    expect(variant.wallSlots.some((s) => s.role === 'hood')).toBe(true)
  })
})

describe('kitchen layout solver — recommended layouts are compliant', () => {
  it('produces no ergonomic warnings for its own variants', () => {
    for (const variant of solveKitchenLayout(baseInput())) {
      const blocking = variant.issues.filter((i) => i.severity !== 'info')
      expect(blocking).toEqual([])
    }
  })
})

describe('kitchen layout solver — determinism', () => {
  it('same input yields identical output (no Math.random)', () => {
    const a = solveKitchenLayout(baseInput())
    const b = solveKitchenLayout(baseInput())
    expect(a.map((v) => v.code)).toEqual(b.map((v) => v.code))
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
  })

  it('returns up to three distinct variants', () => {
    const variants = solveKitchenLayout(baseInput())
    expect(variants.length).toBe(3)
    const codes = new Set(variants.map((v) => v.code))
    expect(codes.size).toBeGreaterThan(1)
  })
})

describe('kitchen layout solver — reuses the cabinet-run model', () => {
  const model = {
    version: 1 as const,
    cellFt: 1,
    height: 8,
    contours: [
      { closed: true, points: [{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 6 }, { x: 0, y: 6 }] },
    ],
    openings: [],
  }
  const wall = { c: 0, s: 0, a: { x: 0, y: 0 }, b: { x: 15, y: 0 } }

  it('applying a variant through layoutCabinetRunOnWall keeps the sink centered on the window', () => {
    const [variant] = solveKitchenLayout(baseInput())
    const result = layoutCabinetRunOnWall(model, wall, variant.code)
    const sink = result.items.find((item) => item.cabinetPrefix === 'SB')
    expect(sink).toBeTruthy()
    const centerIn = (sink?.t ?? 0) * result.wallLengthIn
    expect(Math.abs(centerIn - result.wallLengthIn / 2)).toBeLessThanOrEqual(SINK_CENTER_TOLERANCE_IN)
    // техника вышла тегированной (kind=APPLIANCE) через существующий механизм
    expect(result.items.some((item) => item.applianceType === 'refrigerator')).toBe(true)
    expect(result.items.some((item) => item.applianceType === 'dishwasher')).toBe(true)
    expect(result.items.some((item) => item.applianceType === 'hood')).toBe(true)
    expect(result.overflow).toBe(false)
  })

  it('applied wall cabinets sit 18in above the 36in counter (bottom at 54in)', () => {
    const [variant] = solveKitchenLayout(baseInput())
    const result = layoutCabinetRunOnWall(model, wall, variant.code)
    const wallCab = result.items.find((item) => item.layer === 'wall' && item.cabinetPrefix === 'W')
    expect(wallCab).toBeTruthy()
    const bottomIn = (wallCab?.yFt ?? 0) * 12 - (wallCab?.heightIn ?? 0) / 2
    expect(bottomIn).toBeCloseTo(54, 1)
  })
})

describe('kitchen code rule registry — violations', () => {
  function scene(partial: Partial<KitchenWallScene>): KitchenWallScene {
    return {
      wallLengthIn: 120,
      base: [],
      wall: [],
      windows: [],
      waterCentersIn: [],
      outletsIn: [],
      ...partial,
    }
  }

  it('flags a range under a window as an IRC error (red)', () => {
    const issues = checkKitchenWall(scene({
      base: [{ id: 'r', role: 'range', startIn: 40, endIn: 70, layer: 'base' }],
      windows: [{ kind: 'window', startIn: 45, endIn: 81 }],
    }))
    const hit = issues.find((i) => i.ruleId === 'range-under-window')
    expect(hit).toBeTruthy()
    expect(hit?.severity).toBe('error')
  })

  it('flags a countertop with no receptacle as a NEC error (red)', () => {
    const issues = checkKitchenWall(scene({
      base: [{ id: 'b', role: 'base', startIn: 0, endIn: 48, layer: 'base' }],
      outletsIn: [],
    }))
    const hit = issues.find((i) => i.ruleId === 'nec-countertop-receptacle')
    expect(hit).toBeTruthy()
    expect(hit?.severity).toBe('error')
    // с розеткой нарушения нет
    const withOutlet = checkKitchenWall(scene({
      base: [{ id: 'b', role: 'base', startIn: 0, endIn: 48, layer: 'base' }],
      outletsIn: [24],
    }))
    expect(withOutlet.find((i) => i.ruleId === 'nec-countertop-receptacle')).toBeFalsy()
  })

  it('flags a sink far off the window center as an NKBA warning (yellow)', () => {
    const issues = checkKitchenWall(scene({
      base: [{ id: 's', role: 'sink', startIn: 0, endIn: 33, layer: 'base' }],
      windows: [{ kind: 'window', startIn: 80, endIn: 116 }],
    }))
    const hit = issues.find((i) => i.ruleId === 'sink-window-center')
    expect(hit).toBeTruthy()
    expect(hit?.severity).toBe('warning')
  })

  it('flags a dishwasher too far from the sink as an NKBA warning', () => {
    const issues = checkKitchenWall(scene({
      base: [
        { id: 's', role: 'sink', startIn: 0, endIn: 33, layer: 'base' },
        { id: 'd', role: 'dishwasher', startIn: 90, endIn: 114, layer: 'base' },
      ],
    }))
    const hit = issues.find((i) => i.ruleId === 'dishwasher-near-sink')
    expect(hit?.severity).toBe('warning')
  })

  it('flags a dishwasher jammed in a corner as an NKBA warning', () => {
    const issues = checkKitchenWall(scene({
      base: [
        { id: 'd', role: 'dishwasher', startIn: 0, endIn: 24, layer: 'base' },
        { id: 's', role: 'sink', startIn: 24, endIn: 57, layer: 'base' },
      ],
    }))
    const hit = issues.find((i) => i.ruleId === 'dishwasher-corner')
    expect(hit?.severity).toBe('warning')
  })
})
