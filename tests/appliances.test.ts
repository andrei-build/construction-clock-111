import { describe, expect, it } from 'vitest'
import {
  APPLIANCE_PRESETS,
  applianceCabinetCode,
  applianceDefaultWidthIn,
  applianceDims,
  applianceTypeFromCabinetPrefix,
  furnitureDims,
  isBuiltInApplianceType,
  isRoundFurnitureType,
} from '../src/screens/project-hub/appliances'
import { layoutCabinetRunOnWall, parseCabinetCode } from '../src/screens/project-hub/cabinetCodes'
import { sanitizePlacedCatalogItems } from '../src/screens/project-hub/sketchCatalog'

// APPLIANCES-28: техника/мебель как параметрические объекты. Проверяем пресеты, тегирование ряда
// (kind=APPLIANCE), обрезку остатка стены техникой (переиспользует layoutCabinetRunOnWall) и
// round-trip новых полей через sanitize (version:1 цел, allowlist).

const tenFootWallModel = {
  version: 1 as const,
  cellFt: 1,
  height: 8,
  contours: [
    {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ],
    },
  ],
  openings: [],
}
const firstWall = { c: 0, s: 0, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }

describe('appliance presets', () => {
  it('dishwasher default width is 24 inches', () => {
    expect(applianceDefaultWidthIn('dishwasher')).toBe(24)
    expect(applianceDims('dishwasher').widthIn).toBe(24)
  })

  it('range presets are 30/36 (default 30), cooktop 30/36', () => {
    expect(applianceDefaultWidthIn('range')).toBe(30)
    expect(APPLIANCE_PRESETS.range.widthsIn).toContain(36)
    expect(APPLIANCE_PRESETS.cooktop.widthsIn).toEqual([30, 36])
  })

  it('refrigerator has its own 33/36 footprint (default 33)', () => {
    expect(applianceDefaultWidthIn('refrigerator')).toBe(33)
    expect(APPLIANCE_PRESETS.refrigerator.widthsIn).toContain(36)
    expect(applianceDims('refrigerator').heightIn).toBeGreaterThan(applianceDims('dishwasher').heightIn)
  })

  it('oven and microwave are built-in (integrated in tall cabinet), others are not', () => {
    expect(isBuiltInApplianceType('oven')).toBe(true)
    expect(isBuiltInApplianceType('microwave')).toBe(true)
    expect(isBuiltInApplianceType('range')).toBe(false)
    expect(isBuiltInApplianceType('dishwasher')).toBe(false)
    // встроенные — не опоры ряда (нет кабинетного префикса)
    expect(applianceCabinetCode('oven')).toBeNull()
    expect(applianceCabinetCode('microwave')).toBeNull()
  })

  it('row appliances map to cabinet code prefixes both directions', () => {
    expect(applianceTypeFromCabinetPrefix('DW')).toBe('dishwasher')
    expect(applianceTypeFromCabinetPrefix('RANGE')).toBe('range')
    expect(applianceTypeFromCabinetPrefix('COOK')).toBe('cooktop')
    expect(applianceTypeFromCabinetPrefix('REF')).toBe('refrigerator')
    expect(applianceTypeFromCabinetPrefix('HOOD')).toBe('hood')
    expect(applianceTypeFromCabinetPrefix('B')).toBeNull()
    expect(applianceCabinetCode('dishwasher')).toBe('DW24')
    expect(applianceCabinetCode('refrigerator', 36)).toBe('REF36')
  })
})

describe('furniture presets', () => {
  it('round table is round, rect table and chair are not', () => {
    expect(isRoundFurnitureType('table-round')).toBe(true)
    expect(isRoundFurnitureType('table-rect')).toBe(false)
    expect(isRoundFurnitureType('chair')).toBe(false)
  })

  it('exposes positive dims per furniture type', () => {
    expect(furnitureDims('table-rect').widthIn).toBeGreaterThan(furnitureDims('chair').widthIn)
    expect(furnitureDims('table-round').heightIn).toBeGreaterThan(0)
  })
})

describe('cooktop cabinet code parses (COOK, base layer)', () => {
  it('COOK30 parses as a 30in base appliance', () => {
    const parsed = parseCabinetCode('COOK30')
    expect(parsed).not.toBeNull()
    expect(parsed!.prefix).toBe('COOK')
    expect(parsed!.widthIn).toBe(30)
    expect(parsed!.layer).toBe('base')
  })
})

describe('appliances stand in the cabinet row (reuse layoutCabinetRunOnWall)', () => {
  it('a dishwasher occupies 24in in the run and is tagged kind=APPLIANCE', () => {
    const layout = layoutCabinetRunOnWall(tenFootWallModel, firstWall, 'B24 DW24 B24')
    const dw = layout.items.find((item) => item.applianceType === 'dishwasher')
    expect(dw).toBeTruthy()
    expect(dw!.kind).toBe('APPLIANCE')
    expect(dw!.widthIn).toBe(24)
    expect(dw!.category).toBe('cabinet') // остаётся кабинетным элементом ряда
  })

  it('an appliance reduces the wall remainder exactly by its width', () => {
    // стена 120". Ряд B24 REF36 DW24 = 84" → остаток 36".
    const layout = layoutCabinetRunOnWall(tenFootWallModel, firstWall, 'B24 REF36 DW24')
    const baseSummary = layout.summaries.find((s) => s.layer === 'base')
    expect(layout.wallLengthIn).toBeCloseTo(120, 2)
    expect(baseSummary!.totalWidthIn).toBeCloseTo(84, 2)
    expect(baseSummary!.remainderIn).toBeCloseTo(36, 2)
    // холодильник и посудомойка помечены техникой
    expect(layout.items.some((i) => i.applianceType === 'refrigerator')).toBe(true)
    expect(layout.items.some((i) => i.applianceType === 'dishwasher')).toBe(true)
  })
})

describe('sanitizePlacedCatalogItems: appliance/furniture round-trip (version:1 allowlist)', () => {
  it('keeps built-in appliance marker (oven) through save/reload', () => {
    const [placed] = sanitizePlacedCatalogItems([{
      id: 'ov1', catalogItemId: 'builtin-appliance', kind: 'APPLIANCE', applianceType: 'oven', builtIn: true,
      widthIn: 30, depthIn: 24, heightIn: 29, xFt: 2, yFt: 2.5, zFt: 0, rotationY: 0, surface: 'wall', c: 0, s: 0, t: 0.4,
    }])
    expect(placed.kind).toBe('APPLIANCE')
    expect(placed.applianceType).toBe('oven')
    expect(placed.builtIn).toBe(true)
    const [reloaded] = sanitizePlacedCatalogItems([placed])
    expect(reloaded.applianceType).toBe('oven')
    expect(reloaded.builtIn).toBe(true)
    expect(reloaded.widthIn).toBe(30)
  })

  it('keeps furniture type (round table) through save/reload', () => {
    const [placed] = sanitizePlacedCatalogItems([{
      id: 'tb1', catalogItemId: 'builtin-furniture', kind: 'FURNITURE', furnitureType: 'table-round',
      widthIn: 42, depthIn: 42, heightIn: 30, xFt: 5, yFt: 1.25, zFt: 4, rotationY: 0, surface: 'floor',
    }])
    expect(placed.kind).toBe('FURNITURE')
    expect(placed.furnitureType).toBe('table-round')
    expect(sanitizePlacedCatalogItems([placed])[0].furnitureType).toBe('table-round')
  })

  it('rejects invalid appliance/furniture type but keeps the item + kind', () => {
    const [placed] = sanitizePlacedCatalogItems([{
      id: 'x', catalogItemId: 'builtin-appliance', kind: 'APPLIANCE', applianceType: 'toaster', furnitureType: 'sofa',
      widthIn: 30, depthIn: 24, heightIn: 29, xFt: 1, yFt: 1, zFt: 1, rotationY: 0, surface: 'wall',
    }])
    expect(placed.kind).toBe('APPLIANCE')
    expect(placed.applianceType).toBeUndefined()
    expect(placed.furnitureType).toBeUndefined()
  })

  it('old sketches without appliance/furniture fields still load', () => {
    const [placed] = sanitizePlacedCatalogItems([{ id: 'c', catalogItemId: 'builtin-cabinet:B24', category: 'cabinet', widthIn: 24, depthIn: 24, heightIn: 34.5, xFt: 1, yFt: 1.4, zFt: 0, rotationY: 0, surface: 'floor' }])
    expect(placed.applianceType).toBeUndefined()
    expect(placed.furnitureType).toBeUndefined()
    expect(placed.builtIn).toBeUndefined()
  })
})
