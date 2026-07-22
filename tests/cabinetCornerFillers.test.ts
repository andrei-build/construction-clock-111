import { describe, expect, it } from 'vitest'
import {
  CABINET_CORNER_MAGNET_IN,
  clampCabinetCenterTAlongWall,
  layoutCabinetRunOnWall,
} from '../src/screens/project-hub/cabinetCodes'
import { sanitizePlacedCatalogItems } from '../src/screens/project-hub/sketchCatalog'

// CABINETS-CORNER-FILLERS-24: шкаф flush+магнит к углу, ручные филлеры (round-trip через sanitize),
// авто-филлер ≤3" НЕ помечается ручным. Один источник правды флаша/магнита — clampCabinetCenterTAlongWall.

const sixFootWallModel = {
  version: 1 as const,
  cellFt: 1,
  height: 8,
  contours: [
    {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 6, y: 0 },
        { x: 6, y: 5 },
        { x: 0, y: 5 },
      ],
    },
  ],
  openings: [],
}
const firstWall = { c: 0, s: 0, a: { x: 0, y: 0 }, b: { x: 6, y: 0 } }
const WALL_IN = 72 // 6 ft

describe('cabinet flush-to-corner layout + drag magnet', () => {
  it('places the first cabinet flush to the wall corner (left edge at 0)', () => {
    const layout = layoutCabinetRunOnWall(sixFootWallModel, firstWall, 'B24', 'test-run')
    const base = layout.items.filter((item) => item.layer === 'base')
    expect(base).toHaveLength(1)
    // центр = ширина/2 = 12", t = 12/72 ⇒ левый край шкафа ровно в углу (0)
    expect(base[0].t ?? 0).toBeCloseTo(12 / WALL_IN, 5)
  })

  it('magnet pulls a near-corner drag exactly flush to the corner (gap 0)', () => {
    const dragged = { id: 'd', widthIn: 24, wallId: 'w', layer: 'base' as const, t: undefined }
    const halfFrac = 12 / WALL_IN
    // тащим почти в угол (в пределах магнита 3") → прилипает точно к углу
    expect(clampCabinetCenterTAlongWall([], dragged, WALL_IN, 'w', 0.02)).toBeCloseTo(halfFrac, 5)
    const within = halfFrac + (CABINET_CORNER_MAGNET_IN - 0.5) / WALL_IN
    expect(clampCabinetCenterTAlongWall([], dragged, WALL_IN, 'w', within)).toBeCloseTo(halfFrac, 5)
  })

  it('leaves a far drag free (no magnet) and clamps flush against a neighbour', () => {
    const dragged = { id: 'd', widthIn: 24, wallId: 'w', layer: 'base' as const, t: undefined }
    // далеко от углов/соседей — не притягивает
    expect(clampCabinetCenterTAlongWall([], dragged, WALL_IN, 'w', 0.5)).toBeCloseTo(0.5, 5)
    // сосед 24" в углу (центр t=1/6) — второй 24" прилипает флаш справа (центр 36" ⇒ t=0.5)
    const neighbor = { id: 'n', catalogItemId: 'builtin-cabinet:B24', code: 'B24', category: 'cabinet' as const, layer: 'base' as const, wallId: 'w', widthIn: 24, t: 12 / WALL_IN, xFt: 0, yFt: 0, zFt: 0, rotationY: 0, surface: 'floor' as const }
    expect(clampCabinetCenterTAlongWall([neighbor], dragged, WALL_IN, 'w', 0.5)).toBeCloseTo(0.5, 5)
  })
})

describe('manual vs auto fillers', () => {
  it('explicit BF code becomes a manual filler (survives run rebuild)', () => {
    const layout = layoutCabinetRunOnWall(sixFootWallModel, firstWall, 'B24 BF6', 'test-run')
    const filler = layout.items.find((item) => item.filler)
    expect(filler).toBeDefined()
    expect(filler?.manualFiller).toBe(true)
    expect(filler?.widthIn).toBe(6)
    const cabinet = layout.items.find((item) => !item.filler)
    expect(cabinet?.manualFiller).toBeUndefined()
  })

  it('auto filler (<=3" gap) is NOT marked manual', () => {
    const layout = layoutCabinetRunOnWall(sixFootWallModel, firstWall, 'B69', 'test-run')
    const filler = layout.items.find((item) => item.filler)
    expect(filler).toBeDefined()
    expect(filler?.widthIn).toBe(3)
    expect(filler?.manualFiller).toBeUndefined()
  })
})

describe('sanitizePlacedCatalogItems preserves manual filler round-trip', () => {
  const filler = {
    id: 'f1',
    catalogItemId: 'builtin-cabinet:BF3',
    xFt: 1,
    yFt: 1,
    zFt: 1,
    rotationY: 0,
    surface: 'floor',
    category: 'cabinet',
    code: 'BF3',
    layer: 'base',
    filler: true,
    manualFiller: true,
    widthIn: 3,
    depthIn: 24,
    heightIn: 34.5,
  }

  it('keeps manualFiller + width through save/reload', () => {
    const [placed] = sanitizePlacedCatalogItems([filler])
    expect(placed.manualFiller).toBe(true)
    expect(placed.filler).toBe(true)
    expect(placed.widthIn).toBe(3)
    const [reloaded] = sanitizePlacedCatalogItems([placed])
    expect(reloaded.manualFiller).toBe(true)
    expect(reloaded.widthIn).toBe(3)
  })

  it('clamps filler width to 0..48"', () => {
    const [huge] = sanitizePlacedCatalogItems([{ ...filler, widthIn: 500 }])
    expect(huge.widthIn).toBe(48)
  })

  it('old sketches (no manualFiller / no fillers) load without the field', () => {
    const cabinet = { ...filler, id: 'b1', code: 'B30', filler: undefined, manualFiller: undefined, widthIn: 30 }
    const [placed] = sanitizePlacedCatalogItems([cabinet])
    expect(placed.manualFiller).toBeUndefined()
    expect(placed.filler).toBeUndefined()
    expect(placed.widthIn).toBe(30)
  })
})
