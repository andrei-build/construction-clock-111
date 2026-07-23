import { describe, expect, it } from 'vitest'
import { buildSketchMaterialSpec } from '../src/screens/project-hub/SketchPrintPackage'
import {
  CABINET_MATERIAL_SECTION,
  ELECTRICAL_MATERIAL_SECTION,
  TRIM_MATERIAL_SECTION,
  WALL_MATERIAL_SECTION,
} from '../src/screens/project-hub/sketchMaterials'
import { TILE_MATERIAL_SECTION } from '../src/screens/project-hub/tileCalc'
import {
  BUILTIN_OUTLET_CATALOG_ID,
  SKETCH_CATALOG_KIND_OUTLET,
  type SketchPlacedCatalogItem,
} from '../src/screens/project-hub/sketchCatalog'

const rectangleModel = {
  version: 1 as const,
  cellFt: 1,
  height: 8,
  contours: [
    {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
    },
  ],
  openings: [{ kind: 'door' as const, c: 0, s: 0, t: 0.5, w: 3, h: 7 }],
}

function cabinet(id: string, code: string): SketchPlacedCatalogItem {
  return {
    id,
    catalogItemId: `builtin-cabinet:${code}`,
    category: 'cabinet',
    code,
    model: code,
    name: code,
    xFt: 1,
    yFt: 1.4375,
    zFt: 1,
    rotationY: 0,
    surface: 'floor',
    widthIn: 36,
    heightIn: 34.5,
    depthIn: 24,
  }
}

const outlet: SketchPlacedCatalogItem = {
  id: 'o1',
  catalogItemId: BUILTIN_OUTLET_CATALOG_ID,
  kind: SKETCH_CATALOG_KIND_OUTLET,
  category: 'other',
  name: 'Outlet',
  model: SKETCH_CATALOG_KIND_OUTLET,
  xFt: 1,
  yFt: 1.5,
  zFt: 0,
  rotationY: 0,
  surface: 'wall',
  c: 0,
  s: 0,
  t: 0.2,
}

describe('buildSketchMaterialSpec', () => {
  it('collects tile, paint, cabinets, electrical and trim rows from the sketch model alone', () => {
    const spec = buildSketchMaterialSpec(
      {
        ...rectangleModel,
        finishes: {
          walls: { kind: 'paint', color: '#ffffff' },
          wallFinishes: {
            '0:0': { kind: 'tile', tileWIn: 12, tileHIn: 24, groutIn: 0.125 },
          },
        },
        placedItems: [cabinet('c1', 'B36'), cabinet('c2', 'B36'), outlet],
      },
      { paintName: 'Wall paint', outletName: 'Outlet' },
    )

    const sections = new Set(spec.map((row) => row.section))
    expect(sections.has(TILE_MATERIAL_SECTION)).toBe(true)
    expect(sections.has(WALL_MATERIAL_SECTION)).toBe(true)
    expect(sections.has(CABINET_MATERIAL_SECTION)).toBe(true)
    expect(sections.has(ELECTRICAL_MATERIAL_SECTION)).toBe(true)
    expect(sections.has(TRIM_MATERIAL_SECTION)).toBe(true)

    // Кабинеты сгруппированы по коду с количеством и размерами в примечании.
    const cab = spec.find((row) => row.section === CABINET_MATERIAL_SECTION && row.name === 'B36')
    expect(cab?.qty).toBe(2)
    expect(cab?.note).toContain('36"')

    // Плитка идёт площадью (ft²) с размером плитки в примечании.
    const tile = spec.find((row) => row.section === TILE_MATERIAL_SECTION)
    expect(tile?.unit).toBe('ft²')
    expect((tile?.qty ?? 0) > 0).toBe(true)
    expect(tile?.note).toContain('×')

    // Краска — из непокрытой плиткой площади стен.
    const paint = spec.find((row) => row.section === WALL_MATERIAL_SECTION)
    expect(paint?.name).toBe('Wall paint')
    expect((paint?.qty ?? 0) > 0).toBe(true)

    // Розетка посчитана как электрика.
    expect(spec.some((row) => row.section === ELECTRICAL_MATERIAL_SECTION && row.name === 'Outlet')).toBe(true)
  })

  it('returns an empty spec for a model with no walls, finishes or items', () => {
    expect(
      buildSketchMaterialSpec({
        cellFt: 1,
        contours: [{ closed: false, points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] }],
      }),
    ).toEqual([])
  })
})
